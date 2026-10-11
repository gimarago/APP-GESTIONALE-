const {selectAgenda}=require('./navigation-helpers.cjs');
// Reproduces a saved stock debit being hydrated into a new browser document.
// This test uses a temporary server/database and never touches production data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {pathToFileURL} = require('node:url');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'officina-hydration-race-'));
  const {createApplication} = await import(pathToFileURL(path.join(root, 'server/server.mjs')));
  const {addUser} = await import(pathToFileURL(path.join(root, 'server/database.mjs')));
  const app = await createApplication({root, dataDir, origin:'http://127.0.0.1:8143', env:{NODE_ENV:'test'}});
  await addUser(app.db, 'hydration-test', 'test-password-1234', 'admin');
  await new Promise(resolve => app.server.listen(8143, '127.0.0.1', resolve));
  const browser = await chromium.launch({
    ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}), headless:true
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.stack));
  page.on('dialog', dialog => dialog.accept());
  const tyre = '205/55/16 91v falken';
  const frame = () => page.frames().find(item => item.url().endsWith('/legacy'));
  const ready = () => page.waitForFunction(() => {
    const cloud = document.querySelector('iframe')?.contentWindow?.WorkshopCloud;
    return cloud && !cloud.initializing;
  });
  const state = () => {
    const row = app.db.prepare('SELECT revision,payload FROM state WHERE id=1').get();
    return {revision:row.revision, payload:JSON.parse(row.payload)};
  };
  const stock = current => current.payload?.dom['#stockRows'].find(node => JSON.stringify(node.c?.[0]).includes(tyre));
  const workRows = (current, source) => source === 'agenda'
    ? current.payload.dom['#agendaRows'].filter(node => node.t === 'tr' && !node.a?.class?.includes('agenda-empty'))
    : current.payload.dom['#agenda .parking-section .card'].filter(node => node.t === 'div' && node.a?.class?.includes('parking-row'));
  const persisted = () => {
    const current = state(), row = stock(current);
    if (!row) return null;
    const agenda = workRows(current, 'agenda').find(node => JSON.stringify(node).includes('Cliente test agenda'));
    const parking = workRows(current, 'parking').find(node => JSON.stringify(node).includes('Cliente test parcheggio'));
    if (!agenda || !parking) return null;
    const quantity = Number(row.a['data-quantity']);
    const displayed = Number(row.c?.[2]?.c?.[0]?.c?.find(node => node?.t === 'b')?.c?.join(''));
    const deductions = [agenda.a['data-agenda-tyre-deductions'], parking.a['data-parking-tyre-deductions']]
      .map(raw => JSON.parse(raw || '[]').reduce((sum, item) => sum + Number(item.quantity || 0), 0));
    return {revision:current.revision, quantity, displayed, deductions};
  };
  const waitPersisted = async (quantity, deductions) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const result = persisted();
      if (result && result.quantity === quantity && result.displayed === quantity &&
          JSON.stringify(result.deductions) === JSON.stringify(deductions)) return result;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error(`Server did not persist quantity ${quantity} and deductions ${JSON.stringify(deductions)}; got ${JSON.stringify(persisted())}`);
  };
  const waitSaved = () => page.waitForFunction(() => document.querySelector('#status')?.textContent.startsWith('Salvato sul VPS'));
  const seedOldUnlinkedCashAccounts = () => {
    const current = state();
    const book = JSON.parse(current.payload.storage['ma-gomme-cashbook-v1']);
    const text = node => typeof node === 'string' ? node : (node?.c || []).map(text).join('');
    const touched = [];
    for (const source of ['agenda', 'parking']) {
      const row = workRows(current, source).find(node => JSON.stringify(node).includes(source === 'agenda' ? 'Cliente test agenda' : 'Cliente test parcheggio'));
      assert(row, `${source} work row exists`);
      const meta = source === 'agenda'
        ? {source, date:row.a['data-date'], time:text(row.c[0]), customer:text(row.c[1]), vehicle:text(row.c[2]), work:'4 205/55/16 91v falken', amount:400, lines:[]}
        : {source, date:row.a['data-entry'], time:'', customer:text(row.c[0].c.find(node => node.t === 'b')), vehicle:text(row.c[0].c.find(node => node.t === 'small')), work:'4 205/55/16 91v falken', amount:400, lines:[]};
      const linkedId = 'cash-' + randomUUID();
      row.a['data-cash-account-id'] = linkedId;
      book.accounts.push({id:linkedId, reference:'linked-' + source, status:'COMPLETATO', meta, state:{inCash:0, outside:0, lastEdited:'inCash'}});
      book.accounts.push({id:'cash-' + randomUUID(), reference:'stale-' + source, status:'IN LAVORAZIONE', meta, state:{inCash:0, outside:0, lastEdited:'inCash'}});
      touched.push([source === 'agenda' ? '#agendaRows' : '#agenda .parking-section .card', row.a['data-cloud-id']]);
    }
    current.payload.storage['ma-gomme-cashbook-v1'] = JSON.stringify(book);
    const revision = current.revision + 1;
    app.db.prepare('UPDATE state SET revision=?,payload=? WHERE id=1').run(revision, JSON.stringify(current.payload));
    const put = app.db.prepare('INSERT INTO record_versions(key,revision) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET revision=excluded.revision');
    const R = require(path.join(root, 'cloud-records.js'));
    for (const account of book.accounts.slice(-4)) put.run(R.key('cash', 'accounts', account.id), revision);
    for (const [selector, id] of touched) put.run(R.key('row', selector, id), revision);
  };
  const browserStock = async expected => {
    const result = await frame().evaluate(name => {
      const row = [...document.querySelectorAll('#stockRows tr')].find(item => item.cells[0]?.textContent.trim() === name);
      return row ? {quantity:Number(row.dataset.quantity), displayed:Number(row.cells[2]?.querySelector('.qty-adjust b')?.textContent)} : null;
    }, tyre);
    assert.deepEqual(result, {quantity:expected, displayed:expected});
  };
  const assertHydrationStable = async (expected, deductions, repeats) => {
    for (let i = 0; i < repeats; i++) {
      const before = await waitPersisted(expected, deductions);
      await page.reload();
      await ready();
      await browserStock(expected);
      // Startup observers and the 400+650 ms auto-save timers must have settled.
      await new Promise(resolve => setTimeout(resolve, 1800));
      await browserStock(expected);
      const after = persisted();
      assert.deepEqual(after, before, `reload ${i + 1} must not create a stock mutation`);
    }
  };
  try {
    await page.goto('http://127.0.0.1:8143');
    await page.locator('#username').fill('hydration-test');
    await page.locator('#password').fill('test-password-1234');
    await page.locator('#loginForm button[type="submit"]').click();
    await ready();
    let f = frame();
    await f.locator('.nav [data-view="magazzino"]').click();
    await f.locator('#magazzino [data-cloud-open="stockModal"]').click();
    await f.locator('#stockProduct').fill(tyre);
    await f.locator('#stockCategory').selectOption('Pneumatici estivi');
    await f.locator('#stockQuantity').fill('30');
    await f.locator('#stockForm button[type="submit"]').click();
    await selectAgenda(f,'parking');
    await f.locator('.parking-head [data-cloud-open="parkingModal"]').click();
    await f.locator('#parkCustomer').fill('Cliente test parcheggio');
    await f.locator('#parkPlate').fill('TT123AA');
    await f.locator('#parkVehicle').fill('Auto test');
    await f.locator('#parkWork').fill(`4 ${tyre}`);
    await f.locator('#parkWorkAmount').fill('400');
    await f.locator('#parkStatus').selectOption('IN LAVORAZIONE');
    await f.locator('#parkingForm button[type="submit"]').click();
    await selectAgenda(f);await f.locator('#agenda').waitFor({state:'visible'}); await f.evaluate(() => { document.getElementById('appDate').value = localCreationDate(); openModal('appointmentModal'); });
    await f.locator('#appCustomer').fill('Cliente test agenda');
    await f.locator('#appPlate').fill('TT456AA');
    await f.locator('#appointmentWorkLines [data-description]').fill(`4 ${tyre}`);
    await f.locator('#appointmentWorkLines [data-amount]').fill('400');
    await f.locator('#appointmentForm button[type="submit"]').click();
    await selectAgenda(f,'parking');
    await f.locator('.parking-row').filter({hasText:'Cliente test parcheggio'}).locator('.parking-status').selectOption('COMPLETATO');
    await selectAgenda(f);await f.locator('#agendaRows tr:not(.agenda-empty)').filter({hasText:'Cliente test agenda'}).locator('.status-select').selectOption('COMPLETATO');
    await waitPersisted(22, [4, 4]);
    await waitSaved();
    // Older archives can contain an unlinked cash entry with the same vehicle,
    // customer and date. It must not reopen an already-linked completed job.
    seedOldUnlinkedCashAccounts();
    await assertHydrationStable(22, [4, 4], 3);
    f = frame();
    await selectAgenda(f,'parking');
    await f.locator('.parking-row').filter({hasText:'Cliente test parcheggio'}).locator('.parking-status').selectOption('IN LAVORAZIONE');
    await selectAgenda(f);await f.locator('#agendaRows tr:not(.agenda-empty)').filter({hasText:'Cliente test agenda'}).locator('.status-select').selectOption('IN LAVORAZIONE');
    await waitPersisted(30, [0, 0]);
    await waitSaved();
    await assertHydrationStable(30, [0, 0], 3);
    assert.deepEqual(errors, [], 'browser startup produced no errors');
    console.log('PASS completed and reopened tyre jobs survive repeated hydration and automatic saves without inventory drift');
  } finally {
    await browser.close();
    await new Promise(resolve => app.server.close(resolve));
    app.db.close();
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
