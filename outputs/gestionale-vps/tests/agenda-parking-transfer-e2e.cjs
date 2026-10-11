const {selectAgenda}=require('./navigation-helpers.cjs');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {pathToFileURL} = require('node:url');
const path = require('node:path'), fs = require('node:fs'), os = require('node:os'), net = require('node:net'), assert = require('node:assert/strict');
async function availablePort() {
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); return port;
}
(async () => {
  const root = path.resolve(__dirname, '..'), dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'officina-agenda-parking-'));
  const port = await availablePort(), origin = `http://127.0.0.1:${port}`;
  const {createApplication} = await import(pathToFileURL(path.join(root, 'server/server.mjs')));
  const {addUser} = await import(pathToFileURL(path.join(root, 'server/database.mjs')));
  const app = await createApplication({root, dataDir, origin, env:{NODE_ENV:'test'}});
  await addUser(app.db, 'transfer-test', 'test-password-1234', 'admin');
  await addUser(app.db, 'transfer-viewer', 'test-password-1234', 'viewer');
  await new Promise(resolve => app.server.listen(port, '127.0.0.1', resolve));
  const browser = await chromium.launch({headless:true, ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {})});
  const page = await browser.newPage({viewport:{width:1569,height:1252}}), errors = [], batches = [];
  page.on('pageerror', error => errors.push(error.stack)); page.on('dialog', dialog => dialog.accept());
  page.on('request', request => { if (request.url().endsWith('/api/changes') && request.method() === 'PUT') batches.push(request.postDataJSON()); });
  const frame = p => (p || page).frames().find(item => item.url().includes('/legacy'));
  const ready = p => (p || page).waitForFunction(() => document.querySelector('iframe')?.contentWindow?.WorkshopCloud?.initializing === false);
  const flush = () => page.evaluate(() => WorkshopCloudHost.flush());
  const payload = () => JSON.parse(app.db.prepare('SELECT payload FROM state').get().payload);
  const book = () => JSON.parse(payload().storage['ma-gomme-cashbook-v1']);
  let f;
  const row = name => f.locator('#agendaRows tr:not(.agenda-empty)').filter({has:f.locator('td:nth-child(2)', {hasText:name})});
  const parked = name => f.locator('.parking-row').filter({has:f.locator('div:first-child b', {hasText:name})});
  const balances = name => f.evaluate(name => {
    const entry = WorkshopLedgerCash.snapshot().entries.find(item => item.customer === name);
    return entry && {id:entry.cashId, source:entry.source, date:entry.date, amount:entry.amount, inCash:entry.state.inCash, outside:entry.state.outside};
  }, name);
  const quantities = () => f.evaluate(() => [...document.querySelectorAll('#stockRows tr:not(.empty-filter)')].map(row => Number(row.dataset.quantity)));
  const savedParking = name => payload().dom['#agenda .parking-section .card'].find(item => JSON.stringify(item.c?.[0]).includes(name));
  async function login(p, name) { await p.goto(origin); await p.locator('#username').fill(name); await p.locator('#password').fill('test-password-1234'); await p.locator('#loginForm button[type=submit]').click(); await ready(p); }
  async function stock(product, category, unit) {
    await f.locator('.nav [data-view="magazzino"]').click(); await f.locator('#magazzino [data-cloud-open="stockModal"]').click();
    await f.locator('#stockProduct').fill(product); await f.locator('#stockCategory').selectOption(category);
    await f.locator('#stockUnit').selectOption(unit); await f.locator('#stockQuantity').fill('10');
    await f.locator('#stockForm button[type=submit]').click(); await flush();
  }
  async function appointment(name, works, outside = true) {
    await selectAgenda(f);
    await f.locator('#agenda').waitFor({state:'visible'});
    await f.evaluate(() => {openModal('appointmentModal'); document.getElementById('appDate').value = localCreationDate();});
    await f.locator('#appCustomer').fill(name); await f.locator('#appPlate').fill(name === 'Cliente da spostare' ? 'TP123AA' : name === 'Cliente saldato' ? 'TP456AA' : name === 'Cliente anticipo' ? 'TP789AA' : 'TP321AA');
    await f.locator('#appVehicle').fill('Fiat Panda'); await f.locator('#appKm').fill('123456');
    await f.locator('#appPhone').fill('3331234567'); await f.locator('#appEmail').fill('transfer@example.test');
    await f.locator('#appointmentNotes').fill('Nota da conservare'); await f.locator('#appTime').fill('09:30');
    for (let index = 0; index < works.length; index++) {
      if (index) await f.locator('#appointmentForm button', {hasText:'+ Aggiungi lavorazione'}).click();
      const fields = f.locator('#appointmentWorkLines .appointment-work-line').nth(index);
      await fields.locator('[data-description]').fill(works[index][0]); await fields.locator('[data-amount]').fill(String(works[index][1]));
    }
    if (outside) await f.locator('#appCashDestination').uncheck();
    await f.locator('#appointmentForm button[type=submit]').click();
    try { await row(name).waitFor({state:'attached',timeout:5000}); }
    catch(error) { console.error('CREATE DIAGNOSTIC',{name,errors,host:await page.locator('#status').innerText(),form:await f.evaluate(()=>[...document.querySelectorAll('#appointmentForm input,#appointmentForm select')].map(input=>({id:input.id,value:input.value,valid:input.checkValidity(),message:input.validationMessage}))),agenda:await f.locator('#agendaRows').innerHTML()}); throw error; }
    await flush(); return row(name);
  }
  async function transfer(name, repeat = false) {
    const original = row(name), id = await original.getAttribute('data-cloud-id');
    if (repeat) {
      await original.evaluate(element => { const button = element.querySelector('.agenda-parking-transfer'); button.click(); button.click(); });
    } else await original.locator('.agenda-parking-transfer').click();
    await f.waitForFunction(()=>document.getElementById('agendaParkingTransferStatus')?.textContent==='Veicolo spostato nel parcheggio.');
    await selectAgenda(f,'parking');
    assert.equal(await row(name).count(), 0); assert.equal(await parked(name).count(), 1);
    const server = savedParking(name); assert.ok(server); assert.equal(server.a['data-agenda-origin-id'], id);
    assert.ok(!payload().dom['#agendaRows'].some(item => item.a?.['data-cloud-id'] === id));
    assert.ok(batches.some(batch => (batch.changes || []).some(change => change.key === JSON.stringify(['row','#agendaRows',id]) && change.value === null) && (batch.changes || []).some(change => change.key === JSON.stringify(['row','#agenda .parking-section .card',server.a['data-cloud-id']]) && change.value)), 'source deletion and destination creation are one request');
    return parked(name);
  }
  try {
    await login(page, 'transfer-test'); f = frame();
    assert.equal(await f.evaluate(() => typeof WorkshopLedgerCash.transferRow), 'function');
    const tyre = '205/55 R16 91V Michelin', oil = 'Castrol EDGE 5W-30 C3';
    await stock(tyre, 'Pneumatici estivi', 'pz'); await stock(oil, 'Lubrificanti', 'lt');
    let source = await appointment('Cliente da spostare', [['Diagnosi',10.25],['Lavoro aggiuntivo',20.5]]);
    await source.evaluate(element => { const lines = JSON.parse(element.dataset.acceptanceLines); lines[0].done = true; lines[0].profit = 5.25; lines[0].profitMode = 'manual'; element.dataset.acceptanceLines = JSON.stringify(lines); element.querySelector('.status-select').value='ACCETTATO'; element.querySelector('.status-select').dispatchEvent(new Event('change',{bubbles:true})); });
    await flush(); const originalLines = await source.getAttribute('data-acceptance-lines');
    let target = await transfer('Cliente da spostare', true);
    assert.equal(await target.locator('.parking-status').inputValue(), 'ACCETTATO');
    for (const [attr,value] of [['data-km','123456'],['data-vehicle','Fiat Panda'],['data-work-notes','Nota da conservare'],['data-phone','3331234567'],['data-email','transfer@example.test'],['data-agenda-time','09:30'],['data-cash-destination','outside'],['data-work-lines',originalLines]]) assert.equal(await target.getAttribute(attr), value);
    assert.match(await target.locator('.parking-total strong').innerText(), /30,75/);
    assert.equal(await target.locator('.parking-line-done').first().isChecked(), true);
    assert.equal(await balances('Cliente da spostare'), undefined); assert.deepEqual(await quantities(), [10,10]);
    console.log('PASS unfinished appointment moves once with contacts, mileage, original date/time, work amounts/checks, notes and cash choice');

    source = await appointment('Cliente saldato', [[`2 ${tyre}`,120],[`2 lt olio ${oil}`,40]]);
    await source.locator('.status-select').selectOption('COMPLETATO'); await flush();
    assert.deepEqual(await quantities(), [8,8]);
    const before = await balances('Cliente saldato'); assert.equal(before.outside,160);
    await f.evaluate(id => WorkshopLedgerCash.settle(id, localCreationDate()), before.id); await flush();
    const originalPayment = structuredClone(book().payments.find(payment => payment.accountId === before.id));
    const tyreDeductions = await source.getAttribute('data-agenda-tyre-deductions'), oilDeductions = await source.getAttribute('data-agenda-consumable-deductions');
    target = await transfer('Cliente saldato');
    assert.equal(await target.getAttribute('data-cash-account-id'), before.id);
    assert.equal(await target.getAttribute('data-parking-tyre-deductions'), tyreDeductions);
    assert.equal(await target.getAttribute('data-parking-consumable-deductions'), oilDeductions);
    assert.deepEqual(await quantities(), [8,8]);
    assert.deepEqual(await balances('Cliente saldato'), {...before, source:'parking', outside:0});
    assert.equal(book().accounts.filter(account => account.meta.customer === 'Cliente saldato').length,1);
    assert.equal(book().payments.filter(payment => payment.accountId === before.id).length,1);
    const afterPayment = book().payments.find(payment => payment.accountId === before.id);
    assert.equal(afterPayment.id, originalPayment.id); assert.equal(afterPayment.cents, originalPayment.cents); assert.equal(afterPayment.date, originalPayment.date);
    console.log('PASS completed transfer retains its account, settlement and stock deductions without duplicate ledger or stock effects');

    await page.reload(); await ready(); f = frame(); await selectAgenda(f,'parking');
    assert.equal(await row('Cliente saldato').count(),0); assert.equal(await parked('Cliente saldato').count(),1);
    assert.deepEqual(await quantities(),[8,8]); assert.equal((await balances('Cliente saldato')).id,before.id);
    target = parked('Cliente saldato');
    await target.locator('.parking-status').selectOption('IN LAVORAZIONE'); await flush(); assert.deepEqual(await quantities(),[10,10]);
    await page.reload(); await ready(); f = frame(); await selectAgenda(f,'parking');
    assert.deepEqual(await quantities(),[10,10]);
    await parked('Cliente saldato').locator('.parking-status').selectOption('COMPLETATO'); await flush(); assert.deepEqual(await quantities(),[8,8]);
    assert.equal(book().accounts.filter(account => account.id === before.id).length,1); assert.equal(book().payments.filter(payment => payment.accountId === before.id).length,1);
    console.log('PASS transferred work survives reload, and reopen/recomplete restores and deducts both stock types exactly once');

    source = await appointment('Cliente anticipo', [['Diagnosi',100]]);
    await source.locator('[data-register-deposit]').click(); await f.locator('#depositValue').fill('30');
    await f.locator('#confirmDeposit').click(); await f.locator('#depositDialog').waitFor({state:'hidden'}); await flush();
    const advance = structuredClone(book().payments.find(payment => payment.kind === 'deposit'));
    target = await transfer('Cliente anticipo');
    assert.equal(await target.getAttribute('data-cash-account-id'), advance.accountId);
    assert.equal(book().payments.filter(payment => payment.id === advance.id).length, 1);
    await target.locator('.parking-status').selectOption('COMPLETATO'); await flush();
    assert.equal((await balances('Cliente anticipo')).outside, 70);
    assert.equal((await balances('Cliente anticipo')).inCash, 0);
    assert.deepEqual(book().payments.find(payment => payment.id === advance.id), advance);
    console.log('PASS transferring an advance keeps one original receipt and books only the remaining balance');
    const fresh = await appointment('Cliente icona', [['Controllo',10]], false);
    await page.screenshot({path:path.resolve(root,'../../work/agenda-parking-transfer-desktop.png')});
    const viewer = await browser.newPage(); await login(viewer,'transfer-viewer'); const vf = frame(viewer);
    await selectAgenda(vf); assert.equal(await vf.locator('.agenda-parking-transfer').isDisabled(),true);
    await vf.evaluate(() => WorkshopAgendaParkingTransfer.transfer(document.querySelector('#agendaRows tr:not(.agenda-empty)')));
    assert.equal(await vf.locator('.parking-row').count(),3);
    assert.equal(await vf.locator('#agendaRows [data-register-deposit]').isDisabled(),true);
    assert.deepEqual(errors,[]); await viewer.close();
    console.log('PASS parking icon remains available for new rows and consultation users cannot move records');
  } finally { await browser.close(); await app.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
