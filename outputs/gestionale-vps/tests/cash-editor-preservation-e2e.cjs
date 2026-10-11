const {selectAgenda} = require('./navigation-helpers.cjs');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {pathToFileURL} = require('node:url');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const assert = require('node:assert/strict');

async function freePort() {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

(async () => {
  const root = path.resolve(__dirname, '..');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'officina-cash-editor-'));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const {createApplication} = await import(pathToFileURL(path.join(root, 'server/server.mjs')));
  const {addUser} = await import(pathToFileURL(path.join(root, 'server/database.mjs')));
  const app = await createApplication({root, dataDir, origin, env:{NODE_ENV:'test'}});
  await addUser(app.db, 'cash-editor-test', 'test-password-1234', 'admin');
  await new Promise(resolve => app.server.listen(port, '127.0.0.1', resolve));
  const browser = await chromium.launch({headless:true, ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {})});
  const page = await browser.newPage();
  const errors = [];
  const dialogs = [];
  page.on('pageerror', error => errors.push(error.stack));
  page.on('dialog', dialog => {if (dialog.type() !== 'beforeunload') dialogs.push(dialog.message()); dialog.accept();});
  let f;
  const ready = () => page.waitForFunction(() => document.querySelector('iframe')?.contentWindow?.WorkshopCloud?.initializing === false);
  const getFrame = () => page.frames().find(frame => frame.url().includes('/legacy'));
  const sync = () => page.evaluate(() => WorkshopCloudHost.flush());
  const book = () => JSON.parse(JSON.parse(app.db.prepare('SELECT payload FROM state').get().payload).storage['ma-gomme-cashbook-v1']);
  const row = (name, source) => source === 'parking'
    ? f.locator('.parking-row').filter({has:f.locator('div:first-child > b', {hasText:name})})
    : f.locator('#agendaRows tr:not(.agenda-empty)').filter({has:f.locator('td:nth-child(2)', {hasText:name})});
  const financial = name => {
    const data = book();
    const account = data.accounts.find(account => account.meta.customer === name);
    assert.ok(account, 'cash account exists for ' + name);
    return {id:account.id, outside:account.state.outside, inCash:account.state.inCash, lastEdited:account.state.lastEdited,
      amount:account.meta.amount, status:account.status,
      payments:data.payments.filter(payment => payment.accountId === account.id)};
  };
  const afterReset = () => f.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  let vehicleSerial = 0;
  async function create(name, source, allocation) {
    const plate = (source === 'parking' ? 'PE' : 'AE') + String(++vehicleSerial).padStart(3, '0') + 'AA';
    f = await selectAgenda(f, source === 'parking' ? 'parking' : 'agenda');
    if (source === 'parking') {
      await f.locator('.parking-head [data-cloud-open="parkingModal"]').click();
      await f.locator('#parkCustomer').fill(name);
      await f.locator('#parkPlate').fill(plate);
      await f.locator('#parkVehicle').fill('Fiat Panda');
      await f.locator('#parkWork').fill('Diagnosi centralina');
      await f.locator('#parkWorkAmount').fill('100.15');
      await f.locator('#parkWorkProfit').fill('12');
      await f.locator('#parkStatus').selectOption('IN LAVORAZIONE');
      if (allocation === 'outside') await f.locator('#parkCashDestination').uncheck();
      await f.locator('#parkingForm button[type="submit"]').click();
      await row(name, source).locator('.parking-status').selectOption('COMPLETATO');
    } else {
      await f.evaluate(() => {openModal('appointmentModal'); document.getElementById('appDate').value = localCreationDate();});
      await f.locator('#appCustomer').fill(name);
      await f.locator('#appPlate').fill(plate);
      await f.locator('#appTime').fill('10:00');
      await f.locator('#appointmentWorkLines [data-description]').fill('Diagnosi centralina');
      await f.locator('#appointmentWorkLines [data-amount]').fill('100.15');
      if (allocation === 'outside') await f.locator('#appCashDestination').uncheck();
      const invalid = await f.evaluate(() => [...document.querySelectorAll('#appointmentForm :invalid')].map(field => ({id:field.id,value:field.value,message:field.validationMessage})));
      assert.deepEqual(invalid, [], 'appointment form validation: ' + JSON.stringify(invalid));
      await f.locator('#appointmentForm button[type="submit"]').click();
      await sync();
      const customers = await f.locator('#agendaRows tr td:nth-child(2)').allTextContents();
      assert.ok(customers.includes(name), JSON.stringify({name,customers,form:await f.locator('#appointmentModal').innerText()}));
      await row(name, source).locator('.status-select').selectOption('COMPLETATO');
    }
    await sync();
    if (allocation === 'split') {
      await f.locator('.nav [data-view="libroContabile"]').click();
      const ledger = f.locator('#ledgerRows tr').filter({has:f.locator('td:nth-child(2)', {hasText:name})});
      await ledger.locator('[data-ledger-field="inCash"]').fill('30,05');
      await ledger.locator('[data-ledger-field="inCash"]').press('Tab');
      await sync();
      f = await selectAgenda(f, source === 'parking' ? 'parking' : 'agenda');
    }
  }
  async function open(name, source) {
    await row(name, source).evaluate((element, source) => {
      if (source === 'parking') openParkingEditor(element); else openAcceptanceEditorForRow(element);
    }, source);
    await afterReset();
  }
  async function preserves(name, source, allocation) {
    const before = financial(name);
    const rawBefore = JSON.stringify(book());
    await open(name, source);
    if (source === 'parking') {
      assert.equal(await f.locator('#parkCashDestination').isChecked(), allocation !== 'outside', 'opening loads the actual destination after form reset');
      assert.equal(await f.locator('#parkingForm .cash-destination-label').innerText(), allocation === 'split' ? 'Ripartito' : allocation === 'outside' ? 'Fuori cassa' : 'In cassa');
      assert.equal(await f.locator('#parkCashDestination').isDisabled(), before.status === 'COMPLETATO');
    }
    await sync();
    assert.equal(JSON.stringify(book()), rawBefore, 'opening the editor does not write to the cash journal');
    assert.deepEqual(financial(name), before);
    await f.locator(`#${source === 'parking' ? 'parkingForm' : 'acceptanceForm'} [data-cloud-close]`).click();
    await sync();
    assert.deepEqual(financial(name), before, 'cancelling preserves the cash allocation');
    await open(name, source);
    await f.locator(`#${source === 'parking' ? 'parkingForm' : 'acceptanceForm'} button[type="submit"]`).click();
    await sync();
    assert.deepEqual(financial(name), before, 'unchanged save preserves cash allocation and payments');
    return before;
  }
  try {
    await page.goto(origin);
    await page.locator('#username').fill('cash-editor-test');
    await page.locator('#password').fill('test-password-1234');
    await page.locator('#loginForm button[type="submit"]').click();
    await ready();
    f = getFrame();
    for (const source of ['parking', 'agenda']) {
      for (const allocation of ['outside', 'split', 'inCash']) {
        const name = `Editor ${source} ${allocation}`;
        await create(name, source, allocation);
        await preserves(name, source, allocation);
      }
    }
    console.log('PASS opening, cancelling and unchanged saves preserve completed Outside, split and full cash allocations in parking and acceptance sheets');

    f = await selectAgenda(f, 'parking');
    for (const allocation of ['outside', 'split', 'inCash']) {
      const name = `Editor parking ${allocation}`;
      await row(name, 'parking').locator('.parking-status').selectOption('IN LAVORAZIONE');
      await sync();
      await preserves(name, 'parking', allocation);
    }
    const outsideName = 'Editor parking outside';
    await row(outsideName, 'parking').locator('[data-register-deposit]').click();
    await f.locator('#depositValue').fill('20,10');
    await f.locator('#confirmDeposit').click();
    await f.locator('#depositDialog').waitFor({state:'hidden'});
    await sync();
    await preserves(outsideName, 'parking', 'outside');
    console.log('PASS untouched edits preserve pending split and cash destinations, including an existing advance receipt');

    // An update made in the ledger after opening wins over an untouched form.
    await open(outsideName, 'parking');
    await row(outsideName, 'parking').evaluate(element => WorkshopLedgerCash.setDestination(element, 'inCash'));
    await sync();
    const changedWhileOpen = financial(outsideName);
    assert.equal(await f.locator('#parkCashDestination').isChecked(), false, 'the form still has its initial display');
    await f.locator('#parkingForm button[type="submit"]').click();
    await sync();
    assert.deepEqual(financial(outsideName), changedWhileOpen, 'untouched save respects the current ledger allocation');
    await row(outsideName, 'parking').evaluate(element => WorkshopLedgerCash.setDestination(element, 'outside'));
    await sync();
    console.log('PASS unchanged save keeps a newer cash allocation made while the sheet is open');

    // An explicit route change still applies to the unpaid residual.
    await open(outsideName, 'parking');
    await f.locator('#parkCashDestination').check();
    await f.locator('#parkingForm button[type="submit"]').click();
    await sync();
    assert.equal(financial(outsideName).inCash, 80.05);
    assert.equal(financial(outsideName).outside, 0);
    assert.equal(financial(outsideName).payments[0].cents, 2010);
    const beforeReload = book().accounts.map(account => [account.id, account.state.outside, account.state.inCash, account.status]);
    await page.reload();
    await ready();
    f = getFrame();
    assert.deepEqual(book().accounts.map(account => [account.id, account.state.outside, account.state.inCash, account.status]), beforeReload);
    assert.deepEqual(errors, []);
    assert.deepEqual(dialogs, []);
    console.log('PASS explicit destination edits affect only the residual; saved allocations and original receipts survive reload');
  } finally {
    await browser.close();
    await app.close();
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
