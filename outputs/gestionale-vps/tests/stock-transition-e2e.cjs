const {selectAgenda}=require('./navigation-helpers.cjs');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {pathToFileURL} = require('node:url');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const root = path.resolve(__dirname, '..');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'officina-stock-transition-'));
  const {createApplication} = await import(pathToFileURL(path.join(root, 'server/server.mjs')));
  const {addUser} = await import(pathToFileURL(path.join(root, 'server/database.mjs')));
  const app = await createApplication({root, dataDir, origin:'http://127.0.0.1:8141', env:{NODE_ENV:'test'}});
  await addUser(app.db, 'stock-transition-test', 'test-password-1234', 'admin');
  await new Promise(resolve => app.server.listen(8141, '127.0.0.1', resolve));
  const browser = await chromium.launch({
    ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}), headless:true
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.stack));
  page.on('dialog', dialog => dialog.accept());
  const frame = () => page.frames().find(item => item.url().includes('/legacy'));
  const ready = () => page.waitForFunction(() => document.querySelector('iframe')?.contentWindow?.WorkshopCloud && !document.querySelector('iframe').contentWindow.WorkshopCloud.initializing);
  const flush = () => page.evaluate(() => WorkshopCloudHost.flush());
  const payload = () => JSON.parse(app.db.prepare('SELECT payload FROM state').get().payload);
  const serverStock = name => {
    const stock = payload().dom['#stockRows'].find(row => row.c?.[0]?.c?.[0]?.v === name || JSON.stringify(row.c?.[0] || '').includes(name));
    assert.ok(stock, `stock ${name} exists in server state`);
    return Number(stock.a['data-quantity']);
  };
  const serverWork = (source, customer, deductionsKey, expectedStatus, expectedDeduction) => {
    const state = payload();
    const rows = source === 'parking'
      ? state.dom['#agenda .parking-section .card'].filter(node => node.t === 'div' && node.a?.class?.includes('parking-row'))
      : state.dom['#agendaRows'].filter(node => node.t === 'tr' && !node.a?.class?.includes('agenda-empty'));
    const row = rows.find(node => JSON.stringify(node).includes(customer));
    assert.ok(row, `${source}: ${customer} exists in server state`);
    const findStatus = node => {
      if (typeof node === 'string') return null;
      if (node.t === 'select' && node.a?.class?.includes(source === 'parking' ? 'parking-status' : 'status-select')) {
        return node.c.find(option => option.t === 'option' && Object.hasOwn(option.a || {}, 'selected'))?.c?.join('') || '';
      }
      for (const child of node.c || []) {const found = findStatus(child); if (found !== null) return found;}
      return null;
    };
    assert.equal(findStatus(row), expectedStatus, `${source} persisted status for ${customer}`);
    const deductions = JSON.parse(row.a[deductionsKey] || '[]');
    assert.equal(deductions.reduce((sum, item) => sum + Number(item.quantity || 0), 0), expectedDeduction, `${source} persisted deduction for ${customer}`);
  };
  const uiStock = (f, name) => f.locator('#stockRows tr').filter({has:f.locator('td:first-child', {hasText:name})});
  const assertStock = async (f, name, expected, label) => {
    await f.waitForFunction(({name, expected}) => [...document.querySelectorAll('#stockRows tr')].some(row => row.cells[0]?.textContent.trim() === name && Number(row.dataset.quantity) === expected), {name, expected}, {timeout:4000});
    await flush();
    assert.equal(Number(await uiStock(f, name).getAttribute('data-quantity')), expected, `${label}: browser quantity`);
    const displayed = await uiStock(f, name).locator('td').nth(2).innerText();
    assert.equal(Number(displayed.match(/\d+(?:[.,]\d+)?/)?.[0]?.replace(',', '.')), expected, `${label}: displayed availability`);
    assert.equal(serverStock(name), expected, `${label}: server quantity`);
  };
  const addStock = async (f, name, category='Pneumatici estivi', unit='pz') => {
    await f.locator('.nav [data-view="magazzino"]').click();
    await f.locator('#magazzino [data-cloud-open="stockModal"]').click();
    await f.locator('#stockProduct').fill(name);
    await f.locator('#stockCategory').selectOption(category);
    await f.locator('#stockQuantity').fill('10');
    await f.locator('#stockUnit').selectOption(unit);
    await f.locator('#stockForm button[type="submit"]').click();
    await assertStock(f, name, 10, `initial ${name}`);
  };
  const reload = async () => {await page.reload(); await ready(); return frame();};
  const checkReload = async (name, expected, label, view='parking') => {
    const f = await reload();
    await assertStock(f, name, expected, label);
    await selectAgenda(f,view);
    return f;
  };
  try {
    await page.goto('http://127.0.0.1:8141');
    await page.locator('#username').fill('stock-transition-test');
    await page.locator('#password').fill('test-password-1234');
    await page.locator('#loginForm button[type="submit"]').click();
    await ready();
    let f = frame();

    const parkingTyre = '205/55 R16 91V Michelin';
    const agendaTyre = '225/45 R17 91W Pirelli';
    await addStock(f, parkingTyre);
    await addStock(f, agendaTyre);
    const direct = await f.evaluate(name => {
      const row = [...document.querySelectorAll('#stockRows tr')].find(item => item.cells[0]?.textContent.trim() === name);
      setStockQuantity(row, 9);
      const result = {display:Number(row.cells[2].querySelector('.qty-adjust b')?.textContent), quantity:Number(row.dataset.quantity)};
      setStockQuantity(row, 10);
      return result;
    }, parkingTyre);
    assert.deepEqual(direct, {display:9, quantity:9}, 'synchronous stock change updates both display and persisted quantity before any observer runs');
    await assertStock(f, parkingTyre, 10, 'stock restored after direct helper check');
    await selectAgenda(f,'parking');
    await f.locator('.parking-head [data-cloud-open="parkingModal"]').click();
    await f.locator('#parkCustomer').fill('Cliente stock parcheggio');
    await f.locator('#parkPlate').fill('ST123AA');
    await f.locator('#parkVehicle').fill('Fiat Panda');
    await f.locator('#parkWork').fill(`2 ${parkingTyre}`);
    await f.locator('#parkWorkAmount').fill('100');
    await f.locator('#parkStatus').selectOption('IN LAVORAZIONE');
    await f.locator('#parkingForm button[type="submit"]').click();
    await assertStock(f, parkingTyre, 10, 'parking before completion');
    await f.locator('.parking-row .parking-status').first().selectOption('COMPLETATO');
    await assertStock(f, parkingTyre, 8, 'parking after completion');
    serverWork('parking', 'Cliente stock parcheggio', 'data-parking-tyre-deductions', 'COMPLETATO', 2);
    f = await checkReload(parkingTyre, 8, 'parking completed after first reload');
    serverWork('parking', 'Cliente stock parcheggio', 'data-parking-tyre-deductions', 'COMPLETATO', 2);
    await f.locator('.parking-row .parking-status').first().selectOption('IN LAVORAZIONE');
    await assertStock(f, parkingTyre, 10, 'parking restored once');
    serverWork('parking', 'Cliente stock parcheggio', 'data-parking-tyre-deductions', 'IN LAVORAZIONE', 0);
    f = await checkReload(parkingTyre, 10, 'parking restored after first reload');
    f = await checkReload(parkingTyre, 10, 'parking restored after second reload');
    await f.locator('.parking-row .parking-status').first().selectOption('COMPLETATO');
    await assertStock(f, parkingTyre, 8, 'parking completed again');
    serverWork('parking', 'Cliente stock parcheggio', 'data-parking-tyre-deductions', 'COMPLETATO', 2);
    f = await checkReload(parkingTyre, 8, 'parking completed again after reload');
    await f.locator('.parking-row > div:first-child').first().click();
    await f.locator('#parkStatus').selectOption('IN LAVORAZIONE');
    await f.locator('#parkingForm button[type="submit"]').click();
    await assertStock(f, parkingTyre, 10, 'parking reopened from editor');
    serverWork('parking', 'Cliente stock parcheggio', 'data-parking-tyre-deductions', 'IN LAVORAZIONE', 0);
    f = await checkReload(parkingTyre, 10, 'parking editor reversal after reload');
    console.log('PASS parking completion and reversal adjust stock exactly once across reloads');

    await selectAgenda(f);
    await f.locator('#agenda').waitFor({state:'visible'}); await f.evaluate(() => { document.getElementById('appDate').value = localCreationDate(); openModal('appointmentModal'); });
    await f.locator('#appCustomer').fill('Cliente stock agenda');
    await f.locator('#appPlate').fill('ST456AA');
    await f.locator('#appointmentWorkLines [data-description]').fill(`2 ${agendaTyre}`);
    await f.locator('#appointmentWorkLines [data-amount]').fill('100');
    await f.locator('#appointmentForm button[type="submit"]').click();
    await assertStock(f, agendaTyre, 10, 'agenda before completion');
    const agendaStatus = () => f.locator('#agendaRows tr:not(.agenda-empty) .status-select').filter({visible:true}).last();
    await agendaStatus().selectOption('COMPLETATO');
    await assertStock(f, agendaTyre, 8, 'agenda after completion');
    serverWork('agenda', 'Cliente stock agenda', 'data-agenda-tyre-deductions', 'COMPLETATO', 2);
    f = await checkReload(agendaTyre, 8, 'agenda completed after first reload', 'agenda');
    await agendaStatus().selectOption('IN LAVORAZIONE');
    await assertStock(f, agendaTyre, 10, 'agenda restored once');
    serverWork('agenda', 'Cliente stock agenda', 'data-agenda-tyre-deductions', 'IN LAVORAZIONE', 0);
    f = await checkReload(agendaTyre, 10, 'agenda restored after first reload', 'agenda');
    f = await checkReload(agendaTyre, 10, 'agenda restored after second reload', 'agenda');
    console.log('PASS appointment completion and reversal adjust stock exactly once across reloads');

    const oil = 'Castrol EDGE 5W-30 C3';
    await addStock(f, oil, 'Lubrificanti', 'lt');
    await selectAgenda(f,'parking');
    await f.locator('.parking-head [data-cloud-open="parkingModal"]').click();
    await f.locator('#parkCustomer').fill('Cliente stock olio');
    await f.locator('#parkPlate').fill('ST789AA');
    await f.locator('#parkVehicle').fill('Fiat 500');
    await f.locator('#parkWork').fill(`2 lt olio ${oil}`);
    await f.locator('#parkWorkAmount').fill('80');
    await f.locator('#parkStatus').selectOption('IN LAVORAZIONE');
    await f.locator('#parkingForm button[type="submit"]').click();
    const productRequests = await f.evaluate(description => window.workshopProductRequests(description).map(item => item.quantity), `2 lt olio ${oil}`);
    assert.deepEqual(productRequests, [2], 'oil work identifies one matching stock request');
    await assertStock(f, oil, 10, 'consumable before completion');
    await f.locator('.parking-row .parking-status').last().selectOption('COMPLETATO');
    await assertStock(f, oil, 8, 'consumable after completion');
    serverWork('parking', 'Cliente stock olio', 'data-parking-consumable-deductions', 'COMPLETATO', 2);
    f = await checkReload(oil, 8, 'consumable completed after reload');
    await f.locator('.parking-row .parking-status').last().selectOption('IN LAVORAZIONE');
    await assertStock(f, oil, 10, 'consumable restored once');
    serverWork('parking', 'Cliente stock olio', 'data-parking-consumable-deductions', 'IN LAVORAZIONE', 0);
    f = await checkReload(oil, 10, 'consumable restored after first reload');
    f = await checkReload(oil, 10, 'consumable restored after second reload');
    assert.deepEqual(errors, [], 'no browser exceptions');
    console.log('PASS consumable completion and reversal adjust stock exactly once across reloads');
  } finally {
    await browser.close();
    await new Promise(resolve => app.server.close(resolve));
    app.db.close();
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
