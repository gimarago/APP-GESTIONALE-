const {selectAgenda}=require('./navigation-helpers.cjs');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {pathToFileURL} = require('node:url');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const root = path.resolve(__dirname, '..');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'officina-stock-variants-'));
  const {createApplication} = await import(pathToFileURL(path.join(root, 'server/server.mjs')));
  const {addUser} = await import(pathToFileURL(path.join(root, 'server/database.mjs')));
  const app = await createApplication({root, dataDir, origin:'http://127.0.0.1:8147', env:{NODE_ENV:'test'}});
  await addUser(app.db, 'stock-variants-test', 'test-password-1234', 'admin');
  await new Promise(resolve => app.server.listen(8147, '127.0.0.1', resolve));
  const browser = await chromium.launch({
    ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}), headless:true
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.stack));
  page.on('dialog', dialog => dialog.accept());
  const frame = () => page.frames().find(item => item.url().includes('/legacy'));
  const ready = async () => {
    try { await page.waitForFunction(() => document.querySelector('iframe')?.contentWindow?.WorkshopCloud && !document.querySelector('iframe').contentWindow.WorkshopCloud.initializing, null, {timeout:12000}); }
    catch (error) {
      console.error('READY DIAGNOSTIC', {url:page.url(), frames:page.frames().map(frame => frame.url()), errors,
        host:await page.locator('body').innerText().catch(() => 'unavailable'),
        child:await frame()?.locator('body').innerText().catch(() => 'unavailable')});
      throw error;
    }
  };
  const flush = () => page.evaluate(() => WorkshopCloudHost.flush());
  const payload = () => { const row=app.db.prepare('SELECT payload FROM state').get(); return row ? JSON.parse(row.payload) : null; };
  const stockRecord = name => payload()?.dom?.['#stockRows']?.find(row => JSON.stringify(row.c?.[0] || '').includes(name));
  const serverQuantity = name => Number(stockRecord(name)?.a?.['data-quantity']);
  const uiQuantity = (f, name) => f.evaluate(name => {
    const row = [...document.querySelectorAll('#stockRows tr')].find(item => item.cells[0]?.textContent.trim() === name);
    return row ? {stored:Number(row.dataset.quantity), visible:Number(row.cells[2]?.querySelector('.qty-adjust b')?.textContent)} : null;
  }, name);
  const assertStock = async (f, name, expected, label) => {
    await f.waitForFunction(({name, expected}) => [...document.querySelectorAll('#stockRows tr')].some(row => row.cells[0]?.textContent.trim() === name && Number(row.dataset.quantity) === expected), {name, expected}, {timeout:5000});
    const started = Date.now();
    while (serverQuantity(name) !== expected && Date.now() - started < 8000) await new Promise(resolve => setTimeout(resolve, 100));
    await new Promise(resolve => setTimeout(resolve, 550));
    assert.deepEqual(await uiQuantity(f, name), {stored:expected, visible:expected}, `${label}: browser`);
    assert.equal(serverQuantity(name), expected, `${label}: server`);
    const row = payload().dom['#agenda .parking-section .card'].find(node => node.t === 'div' && node.a?.class?.includes('parking-row') && JSON.stringify(node).includes('Stock Alfa'));
    console.log(JSON.stringify({label, stock:serverQuantity(name), status:await page.locator('#status').textContent(), deductions:row && {tyre:row.a['data-parking-tyre-deductions'], consumable:row.a['data-parking-consumable-deductions']}}));
  };
  const reload = async () => { await page.reload(); await ready(); return frame(); };
  const addStock = async (f, name, quantity, category='Pneumatici estivi', unit='pz') => {
    await f.locator('.nav [data-view="magazzino"]').click();
    await f.locator('#magazzino [data-cloud-open="stockModal"]').click();
    await f.locator('#stockProduct').fill(name);
    await f.locator('#stockCategory').selectOption(category);
    await f.locator('#stockQuantity').fill(String(quantity));
    await f.locator('#stockUnit').selectOption(unit);
    await f.locator('#stockForm button[type="submit"]').click();
    await assertStock(f, name, quantity, `created ${name}`);
  };
  const addParking = async (f, customer, plate, firstWork, otherWork=[], status='IN LAVORAZIONE') => {
    await selectAgenda(f,'parking');
    await f.locator('.parking-head [data-cloud-open="parkingModal"]').click();
    await f.locator('#parkCustomer').fill(customer);
    await f.locator('#parkPlate').fill(plate);
    await f.locator('#parkVehicle').fill('Fiat Panda');
    await f.locator('#parkWork').fill(firstWork);
    await f.locator('#parkWorkAmount').fill('100');
    for (const work of otherWork) {
      await f.locator('#addParkingWork').click();
      const extra = f.locator('#extraParkingWorks .extra-parking-work').last();
      await extra.locator('.parking-work-description').fill(work);
      await extra.locator('.parking-work-amount').fill('50');
    }
    await f.locator('#parkStatus').selectOption(status);
    await f.locator('#parkingForm button[type="submit"]').click();
    await new Promise(resolve => setTimeout(resolve, 800));
  };
  const parking = (f, customer) => f.locator('.parking-row').filter({has:f.locator('div:first-child b', {hasText:customer})});
  const status = (f, customer) => parking(f, customer).locator('.parking-status');
  const assertReload = async (name, expected, label) => {
    const f = await reload();
    await assertStock(f, name, expected, label);
    await selectAgenda(f,'parking');
    return f;
  };
  try {
    await page.goto('http://127.0.0.1:8147');
    await page.locator('#username').fill('stock-variants-test');
    await page.locator('#password').fill('test-password-1234');
    await page.locator('#loginForm button[type="submit"]').click();
    await ready();
    let f = frame();
    const tyre = '205/55/16 91v falken';
    const oil = 'Castrol EDGE 5W-30 C3';
    await addStock(f, tyre, 28);
    await addStock(f, oil, 10, 'Lubrificanti', 'lt');

    await addParking(f, 'Stock Alfa', 'SV101AA', `4 ${tyre}`, [`2 lt olio ${oil}`]);
    await addParking(f, 'Stock Beta', 'SV102AA', `3 ${tyre}`);
    await parking(f, 'Stock Alfa').locator(':scope > div').first().click();
    await f.locator('#parkStatus').selectOption('COMPLETATO');
    await f.locator('#parkingForm button[type="submit"]').click();
    await assertStock(f, tyre, 24, 'Alfa completed via editor');
    await assertStock(f, oil, 8, 'Alfa oil completed via editor');
    f = await assertReload(tyre, 24, 'Alfa after reload');
    await assertStock(f, oil, 8, 'Alfa oil after reload');
    console.log('PASS modal completion with nested tyre and consumable after reload');

    await status(f, 'Stock Beta').selectOption('COMPLETATO');
    await assertStock(f, tyre, 21, 'Beta completed using same tyre');
    f = await assertReload(tyre, 21, 'both completed after reload');
    await status(f, 'Stock Alfa').selectOption('IN LAVORAZIONE');
    await assertStock(f, tyre, 25, 'Alfa reversal with Beta still completed');
    await assertStock(f, oil, 10, 'Alfa oil reversal');
    f = await assertReload(tyre, 25, 'Alfa reversal after reload');
    await assertStock(f, oil, 10, 'Alfa oil reversal after reload');
    console.log('PASS two jobs share same tyre without duplicate restoration');

    await parking(f, 'Stock Beta').locator(':scope > div').first().click();
    await f.locator('#parkWork').fill(`1 ${tyre}`);
    await f.locator('#parkingForm button[type="submit"]').click();
    await assertStock(f, tyre, 27, 'completed work quantity edit');
    f = await assertReload(tyre, 27, 'completed work quantity edit after reload');
    await status(f, 'Stock Beta').selectOption('PRONTO AL RITIRO');
    await assertStock(f, tyre, 28, 'completed to ready restores once');
    f = await assertReload(tyre, 28, 'ready after first reload');
    f = await assertReload(tyre, 28, 'ready after second reload');
    console.log('PASS completed work edit and PRONTO AL RITIRO do not duplicate stock');

    await f.locator('.nav [data-view="magazzino"]').click();
    await f.locator('#stockRows tr').filter({hasText:tyre}).locator('[data-stock-quantity-action="increase"]').click();
    const restock=f.locator('#stockRestockModal');await restock.waitFor({state:'visible'});
    const price=await f.evaluate(name=>{const row=[...document.querySelectorAll('#stockRows tr')].find(item=>item.cells[0]?.textContent.trim()===name),value=row?.cells[3]?.textContent||'';return /\d/.test(value)?stockInventoryApi.numberFrom(value):0;},tyre);
    await f.locator('#stockRestockUnitPrice').fill(String(price));const priorCost=f.locator('#stockRestockPriorCost');if(await priorCost.isVisible())await priorCost.fill(String(price));
    await f.locator('#stockRestockForm button[type="submit"]').click();await restock.waitFor({state:'hidden'});
    await assertStock(f, tyre, 29, 'manual restock');
    await selectAgenda(f,'parking');
    await status(f, 'Stock Beta').selectOption('COMPLETATO');
    await assertStock(f, tyre, 28, 'recompletion after restock');
    f = await assertReload(tyre, 28, 'recompletion after restock reload');
    await status(f, 'Stock Beta').selectOption('IN LAVORAZIONE');
    await assertStock(f, tyre, 29, 'restored after manual restock');
    f = await assertReload(tyre, 29, 'restored after manual restock reload');
    assert.deepEqual(errors, [], 'browser exceptions');
    console.log('PASS manual restock interleaved with completion and reversal');
  } finally {
    await browser.close();
    await new Promise(resolve => app.server.close(resolve));
    app.db.close();
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
