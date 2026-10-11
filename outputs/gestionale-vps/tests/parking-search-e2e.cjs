const {selectAgenda}=require('./navigation-helpers.cjs');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {pathToFileURL} = require('node:url');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');

(async () => {
  const root = path.resolve(__dirname, '..');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'officina-parking-search-'));
  const {createApplication} = await import(pathToFileURL(path.join(root, 'server/server.mjs')));
  const {addUser} = await import(pathToFileURL(path.join(root, 'server/database.mjs')));
  const app = await createApplication({root, dataDir, origin: 'http://127.0.0.1:8134', env: {NODE_ENV: 'test'}});
  await addUser(app.db, 'parking-search-test', 'test-password-1234', 'admin');
  await new Promise(resolve => app.server.listen(8134, '127.0.0.1', resolve));
  const browser = await chromium.launch({
    ...(process.env.CHROME_PATH ? {executablePath: process.env.CHROME_PATH} : {}),
    headless: true
  });
  const page = await browser.newPage({viewport: {width: 1280, height: 900}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  const frame = () => page.frames().find(item => item.url().includes('/legacy'));
  const ready = () => page.waitForFunction(() => {
    const legacy = document.querySelector('iframe')?.contentWindow;
    return legacy?.WorkshopCloud && !legacy.WorkshopCloud.initializing;
  });
  const sync = () => page.evaluate(() => WorkshopCloudHost.flush());
  const rows = () => frame().locator('#agenda .parking-section .parking-row');
  const visibleRows = () => frame().locator('#agenda .parking-section .parking-row:visible');

  async function addVehicle(customer, plate, vehicle) {
    const legacy = frame();
    await legacy.locator('.parking-head [data-cloud-open="parkingModal"]').click();
    await legacy.locator('#parkCustomer').fill(customer);
    await legacy.locator('#parkPlate').fill(plate);
    await legacy.locator('#parkVehicle').fill(vehicle);
    await legacy.locator('#parkWork').fill('Controllo');
    await legacy.locator('#parkingForm button[type="submit"]').click();
    await sync();
  }

  try {
    await page.goto('http://127.0.0.1:8134');
    await page.locator('#username').fill('parking-search-test');
    await page.locator('#password').fill('test-password-1234');
    await page.locator('#loginForm button[type="submit"]').click();
    await ready();
    let legacy = frame();
    await selectAgenda(legacy,'parking');
    assert.match(await legacy.locator('#parkingVehicleCount').innerText(), /0 veicoli/);

    await addVehicle('Alfa Cliente', 'AB123CD', 'Fiat Panda');
    await addVehicle('Beta Cliente', 'EF456GH', 'Ford Fiesta');
    await legacy.waitForFunction(() => document.querySelector('#parkingVehicleCount')?.textContent === '2 veicoli');
    assert.equal(await rows().count(), 2);

    const search = legacy.locator('#parkingVehicleSearch');
    await search.fill('ef456gh');
    assert.equal(await visibleRows().count(), 1, 'plate search ignores spaces');
    assert.match(await legacy.locator('#parkingSearchResults').innerText(), /1 risultato su 2/);
    assert.match(await legacy.locator('#parkingVehicleCount').innerText(), /2 veicoli/);
    await search.fill('Alfa Cliente');
    assert.equal(await visibleRows().count(), 1, 'customer name is searchable');
    await search.fill('Panda');
    assert.equal(await visibleRows().count(), 1, 'vehicle model is searchable');
    await search.fill('Cliente inesistente');
    assert.equal(await visibleRows().count(), 0);
    assert.equal(await legacy.locator('.parking-search-empty').isVisible(), true);
    await search.fill('');
    assert.equal(await visibleRows().count(), 2);

    const stored = JSON.parse(app.db.prepare('SELECT payload FROM state').get().payload);
    const parked = stored.dom['#agenda .parking-section .card'].filter(item => item.t === 'div' && item.a?.class?.includes('parking-row'));
    assert.equal(parked.length, 2, 'filter does not remove shared vehicles');
    assert.ok(parked.every(item => !('hidden' in item.a) && !('style' in item.a)), 'filter does not save local visibility');
    console.log('PASS parking count and customer/plate/model search keep VPS rows intact');

    await rows().first().locator('[data-remove-parking]').click();
    await sync();
    await legacy.waitForFunction(() => document.querySelector('#parkingVehicleCount')?.textContent === '1 veicolo');
    await page.reload();
    await ready();
    legacy = frame();
    await selectAgenda(legacy,'parking');
    assert.match(await legacy.locator('#parkingVehicleCount').innerText(), /1 veicolo/);
    assert.equal(await legacy.locator('#parkingVehicleSearch').inputValue(), '');
    await page.setViewportSize({width: 390, height: 844});
    await legacy.locator('#parkingVehicleSearch').fill('Fiesta');
    assert.equal(await visibleRows().count(), 1);
    assert.equal(await legacy.locator('#parkingVehicleSearch').isVisible(), true);
    console.log('PASS count updates after removal/reload and search works on mobile');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise(resolve => app.server.close(resolve));
    app.db.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
