'use strict';
const {selectAgenda} = require('./navigation-helpers.cjs');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {pathToFileURL} = require('node:url');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const assert = require('node:assert/strict');

(async () => {
  const root = path.resolve(__dirname, '..'), dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'officina-plate-formats-'));
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const {createApplication} = await import(pathToFileURL(path.join(root, 'server/server.mjs')));
  const {addUser} = await import(pathToFileURL(path.join(root, 'server/database.mjs')));
  const app = await createApplication({root, dataDir, origin, env:{NODE_ENV:'test'}});
  await addUser(app.db, 'plate-formats-test', 'test-password-1234', 'admin');
  await new Promise(resolve => app.server.listen(port, '127.0.0.1', resolve));
  const browser = await chromium.launch({headless:true, ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {})});
  const page = await browser.newPage({viewport:{width:1302,height:1050}}), errors = [];
  page.on('pageerror', error => errors.push(error.stack)); page.on('dialog', dialog => dialog.accept());
  const frame = () => page.frames().find(item => item.url().includes('/legacy'));
  const ready = () => page.waitForFunction(() => {const c=document.querySelector('iframe')?.contentWindow?.WorkshopCloud;return c&&!c.initializing&&!WorkshopCloudHost.synchronizing();});
  const flush = async () => {await ready();await page.evaluate(() => WorkshopCloudHost.flush());};
  const state = () => JSON.parse(app.db.prepare('SELECT payload FROM state WHERE id=1').get().payload);
  const row = customer => frame().locator('.parking-row').filter({has:frame().getByText(customer, {exact:true})});
  const identity = customer => row(customer).evaluate(element => parkingDataFromRow(element));
  async function open(customer) {await row(customer).evaluate(element => openParkingEditor(element));await frame().locator('#parkingModal.open').waitFor();}
  const formats = ['ab 12345', 'b-ab 1234', 'ab12 cde', '1234 abc', 'zh 123456', '1-abc-123', '123456'];
  try {
    await page.goto(origin); await page.locator('#username').fill('plate-formats-test'); await page.locator('#password').fill('test-password-1234');
    await page.locator('#loginForm button[type="submit"]').click(); await ready();
    const stockBefore = await frame().evaluate(() => JSON.stringify(WorkshopCloud.capture().dom['#stockRows']));
    for (let index=0; index<formats.length; index++) {
      const plate = formats[index], customer = 'Cliente targa test '+index, vehicle = 'Veicolo test '+index;
      const f = await selectAgenda(frame(), 'parking'); await f.locator('.parking-head [data-cloud-open="parkingModal"]').click();
      await f.locator('#parkCustomer').fill(customer); await f.locator('#parkPlate').fill(plate); await f.locator('#parkVehicle').fill(vehicle);
      await f.locator('#parkKm').fill('50000'); await f.locator('#parkWork').fill('Diagnosi motore'); await f.locator('#parkWorkAmount').fill('100.75');
      await f.locator('#parkStatus').selectOption('IN LAVORAZIONE'); await f.locator('#parkingForm button[type="submit"]').click(); await flush();
      assert.equal((await identity(customer)).plate, plate.toUpperCase());
      assert.equal((await identity(customer)).vehicle, vehicle);
      // Exercise legacy archived rows that predate the dedicated data-plate field.
      await row(customer).evaluate(element => {delete element.dataset.plate; WorkshopCloud.changed(true);}); await flush();
      await open(customer); assert.equal(await f.locator('#parkPlate').inputValue(), plate.toUpperCase()); assert.equal(await f.locator('#parkVehicle').inputValue(), vehicle);
      await f.locator('#parkingNotes').fill('Modifica con targa conservata'); await f.locator('#parkingForm button[type="submit"]').click(); await flush();
      assert.equal(await row(customer).getAttribute('data-plate'), plate.toUpperCase());
    }
    await page.reload(); await ready(); await selectAgenda(frame(), 'parking');
    for (let index=0; index<formats.length; index++) {
      const customer = 'Cliente targa test '+index;
      assert.equal((await identity(customer)).plate, formats[index].toUpperCase());
      assert.equal((await identity(customer)).vehicle, 'Veicolo test '+index);
      await open(customer); assert.equal(await frame().locator('#parkPlate').inputValue(), formats[index].toUpperCase());
      assert.equal(await frame().locator('#parkWorkAmount').inputValue(), '100.75');
      await frame().locator('#parkingModal [data-cloud-close]').click();
    }
    await frame().evaluate(() => openNewAcceptance());
    await frame().locator('#appPlate').fill('B AB-1234');
    assert.equal(await frame().locator('#appCustomer').inputValue(), 'Cliente targa test 1');
    assert.equal(await frame().locator('#appVehicle').inputValue(), 'Veicolo test 1');
    await frame().locator('#appointmentModal [data-cloud-close]').click();
    await flush();
    assert.equal(JSON.stringify(state().dom['#stockRows']), stockBefore, 'plate handling cannot deduct or rewrite stock');
    assert.deepEqual(errors, []);
    console.log('PASS motorcycle and foreign/numeric plates survive legacy recovery, edit, cloud save/reload and separator-insensitive customer lookup; cents and stock remain intact');
  } catch (error) {console.error('Browser errors:', errors); throw error;}
  finally {await browser.close();await app.close();}
})().catch(error => {console.error(error);process.exitCode=1;});
