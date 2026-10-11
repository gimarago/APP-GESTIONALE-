'use strict';
// Isolated archive: these checks never open the user's workshop database.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {pathToFileURL} = require('node:url');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {selectAgenda} = require('./navigation-helpers.cjs');
(async () => {
  const root = path.resolve(__dirname, '..');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'officina-dual-load-'));
  const {createApplication} = await import(pathToFileURL(path.join(root, 'server/server.mjs')));
  const {addUser} = await import(pathToFileURL(path.join(root, 'server/database.mjs')));
  const app = await createApplication({root, dataDir, origin:'http://127.0.0.1:8169', env:{NODE_ENV:'test'}});
  await addUser(app.db, 'tyres', 'test-password-1234', 'admin');
  await new Promise(resolve => app.server.listen(8169, '127.0.0.1', resolve));
  const browser = await chromium.launch({headless:true, ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {})});
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.stack)); page.on('dialog', dialog => dialog.accept());
  let f, count = 0;
  const ready = () => page.waitForFunction(() => document.querySelector('iframe')?.contentWindow?.WorkshopCloud?.initializing === false);
  const sync = () => page.evaluate(() => WorkshopCloudHost.flush());
  const stocks = [
    ['vann11 195/75/16 110/108 FALKEN', 'Pneumatici quattro stagioni', 9],
    ['195/75/16 110/107R FALKEN', 'Pneumatici quattro stagioni', 5],
    ['195/75/16 110/108T FALKEN', 'Pneumatici estivi', 7],
    ['195/75/16 107/105T sumitomo', 'Pneumatici estivi', 6]
  ];
  const quantities = () => f.evaluate(stocks => stocks.map(([product, category]) => Number([...document.querySelectorAll('#stockRows tr')].find(r => r.cells[0]?.textContent.trim() === product && r.cells[1]?.textContent.trim() === category)?.dataset.quantity)), stocks);
  const job = name => f.locator('#agendaRows tr').filter({hasText:name});
  const parked = name => f.locator('#agenda .parking-row').filter({hasText:name});
  async function stock(product, category, profit) {
    await f.locator('.nav [data-view="magazzino"]').click();
    await f.locator('#magazzino [data-cloud-open="stockModal"]').click();
    await f.locator('#stockProduct').fill(product); await f.locator('#stockCategory').selectOption(category);
    await f.locator('#stockQuantity').fill('20'); await f.locator('#stockPrice').fill('60');
    await f.locator('#stockUnitProfit').fill(String(profit));
    await f.locator('#stockForm button[type="submit"]').click(); await sync();
  }
  async function appointment(name, description) {
    await selectAgenda(f); await f.evaluate(() => openNewAcceptance());
    await f.locator('#appTime').fill('10:' + String(count++).padStart(2,'0'));
    await f.locator('#appCustomer').fill(name); await f.locator('#appPlate').fill('DL' + count + 'AA');
    await f.locator('#appVehicle').fill('Furgone');
    await f.locator('#appointmentWorkLines [data-description]').fill(description);
    await f.locator('#appointmentWorkLines [data-amount]').fill('240');
    await f.locator('#appointmentForm button[type="submit"]').click(); await sync();
  }
  const receipts = row => row.evaluate(r => JSON.parse(r.dataset[r.tagName === 'TR' ? 'agendaTyreDeductions' : 'parkingTyreDeductions'] || '[]'));
  async function reload(expected) {
    await sync(); const revision = app.db.prepare('SELECT revision FROM state WHERE id=1').get().revision;
    await page.reload(); await ready(); f = page.frames().find(frame => frame.url().includes('/legacy'));
    await page.waitForTimeout(1600);
    assert.deepEqual(await quantities(), expected);
    assert.equal(app.db.prepare('SELECT revision FROM state WHERE id=1').get().revision, revision, 'reload does not repeat a deduction');
  }
  try {
    await page.goto('http://127.0.0.1:8169'); await page.locator('#username').fill('tyres');
    await page.locator('#password').fill('test-password-1234'); await page.locator('#loginForm button[type="submit"]').click();
    await ready(); f = page.frames().find(frame => frame.url().includes('/legacy'));
    for (const data of stocks) await stock(...data);
    const description = '4 195/75/16 110/108 FALKEN AS';
    await appointment('Cargo AS', description);
    assert.equal(await f.evaluate(text => getStockLineProfit(text), description), 36);
    assert.equal(await f.evaluate(() => [...document.querySelectorAll('#stockRows tr')].find(r => r.cells[0]?.textContent.includes('vann11')).querySelector('.stock-reserved').textContent.trim()), '4 pz');
    await job('Cargo AS').locator('.status-select').selectOption('COMPLETATO'); await sync();
    assert.deepEqual(await quantities(), [16,20,20,20]);
    const receipt = (await receipts(job('Cargo AS')))[0];
    assert.equal(receipt.quantity, 4); assert.equal(receipt.unitProfit, 9);
    await reload([16,20,20,20]);
    assert.equal((await receipts(job('Cargo AS')))[0].stockId, receipt.stockId);
    await selectAgenda(f); await job('Cargo AS').locator('.status-select').selectOption('IN LAVORAZIONE'); await sync();
    assert.deepEqual(await quantities(), [20,20,20,20]);
    await job('Cargo AS').locator('.status-select').selectOption('COMPLETATO'); await sync();
    assert.deepEqual(await quantities(), [16,20,20,20]);
    console.log('PASS dual index without speed: season, reservation, profit, debit, reload and reopening');

    await appointment('Cargo summer', '2 195/75R16C 110/108T FALKEN');
    await job('Cargo summer').locator('.status-select').selectOption('COMPLETATO'); await sync();
    assert.deepEqual(await quantities(), [16,20,18,20]);
    await appointment('Wrong pair', '2 195/75/16 110/106T FALKEN');
    await job('Wrong pair').locator('.status-select').selectOption('COMPLETATO'); await sync();
    assert.equal((await receipts(job('Wrong pair'))).length, 0);
    await appointment('Wrong speed', '2 195/75/16 110/108R FALKEN');
    await job('Wrong speed').locator('.status-select').selectOption('COMPLETATO'); await sync();
    assert.equal((await receipts(job('Wrong speed'))).length, 0);
    assert.deepEqual(await quantities(), [16,20,18,20]);
    console.log('PASS commercial C and speed recognized; mismatched full pair or explicit speed cannot debit');

    // The generic name matcher must not rescue malformed tyre dimensions.
    await appointment('Malformed cargo', '4 2195/75/16 110/108T FALKEN');
    await page.waitForTimeout(200); // Allow the debounced reservation renderer to run.
    assert.equal(await f.evaluate(() => [...document.querySelectorAll('#stockRows tr')].find(r => r.cells[0]?.textContent.trim() === '195/75/16 110/108T FALKEN').querySelector('.stock-reserved').textContent.trim()), '0 pz');
    await job('Malformed cargo').locator('.status-select').selectOption('COMPLETATO'); await sync();
    assert.equal((await receipts(job('Malformed cargo'))).length, 0);
    assert.deepEqual(await quantities(), [16,20,18,20]);
    console.log('PASS malformed dimension cannot reserve or debit tyre through generic product fallback');

    await selectAgenda(f,'parking'); await f.locator('.parking-head [data-cloud-open="parkingModal"]').click();
    await f.locator('#parkCustomer').fill('Dual parked'); await f.locator('#parkPlate').fill('DL999AA');
    await f.locator('#parkVehicle').fill('Furgone'); await f.locator('#parkWork').fill('2 195/75/16 107/105T SUMITOMO');
    await f.locator('#parkWorkAmount').fill('120'); await f.locator('#parkStatus').selectOption('IN LAVORAZIONE');
    await f.locator('#parkingForm button[type="submit"]').click(); await sync();
    await parked('Dual parked').locator('.parking-status').selectOption('COMPLETATO'); await sync();
    assert.deepEqual(await quantities(), [16,20,18,18]);
    assert.equal((await receipts(parked('Dual parked')))[0].unitProfit, 6);
    await reload([16,20,18,18]);
    console.log('PASS dual load with speed also debits once in parking');

    await stock('195/75/16 110/108R FALKEN','Pneumatici estivi',8);
    await appointment('Ambiguous cargo', '2 195/75/16 110/108 FALKEN');
    assert.match(await f.locator('.agenda-stock-warning').innerText(), /Ambiguous cargo.*più scorte/s);
    await job('Ambiguous cargo').locator('.status-select').selectOption('COMPLETATO'); await sync();
    assert.equal((await receipts(job('Ambiguous cargo'))).length,0);
    assert.deepEqual(await quantities(), [16,20,18,18]);
    assert.deepEqual(errors, []);
    console.log('PASS missing speed with multiple compatible stocks warns and does not debit');
  } finally { await browser.close(); await app.close(); }
})().catch(error => {console.error(error);process.exitCode=1;});
