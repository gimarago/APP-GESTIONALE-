const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {pathToFileURL} = require('node:url');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const assert = require('node:assert/strict');

async function availablePort() {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

(async () => {
  const root = path.resolve(__dirname, '..');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'officina-quotes-'));
  const origin = `http://127.0.0.1:${await availablePort()}`;
  const {createApplication} = await import(pathToFileURL(path.join(root, 'server/server.mjs')));
  const {addUser} = await import(pathToFileURL(path.join(root, 'server/database.mjs')));
  const app = await createApplication({root, dataDir, origin, env:{NODE_ENV:'test'}});
  await addUser(app.db, 'quotes-test', 'test-password-1234', 'operator');
  await addUser(app.db, 'quotes-viewer', 'test-password-1234', 'viewer');
  await new Promise(resolve => app.server.listen(Number(new URL(origin).port), '127.0.0.1', resolve));
  const browser = await chromium.launch({...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}), headless:true});
  const errors = [];
  const readState = () => JSON.parse(app.db.prepare('SELECT payload FROM state WHERE id=1').get().payload);
  const savedQuotes = () => JSON.parse(readState().storage['officina-quotes-v1'] || '[]');
  try {
    const page = await browser.newPage({viewport:{width:1278,height:1050}});
    page.on('pageerror', error => errors.push(error.message));
    let acceptRemoval = false;
    let lastConfirmation = '';
    page.on('dialog', dialog => {
      if (dialog.type() === 'confirm') {
        lastConfirmation = dialog.message();
        return acceptRemoval ? dialog.accept() : dialog.dismiss();
      }
      return dialog.accept();
    });
    const ready = () => page.waitForFunction(() => document.querySelector('iframe')?.contentWindow?.WorkshopCloud?.initializing === false);
    const frame = () => page.frames().find(item => item.url().includes('/legacy'));
    const flush = () => page.evaluate(() => WorkshopCloudHost.flush());
    await page.goto(origin);
    await page.locator('#username').fill('quotes-test');
    await page.locator('#password').fill('test-password-1234');
    await page.locator('#loginForm button[type="submit"]').click();
    await ready();
    let f = frame();
    await f.locator('.nav [data-view="impostazioni"]').click();
    await f.locator('#shopName').fill('Officina verifica PDF');
    await f.locator('#shopAddress').fill('Via Legale 10, 00100 Roma (RM)');
    await f.locator('#shopOperatingAddress').fill('Via Officina 20, Zona industriale, 00100 Roma (RM)');
    await f.locator('#settingsForm button[type="submit"]').click();
    await flush();
    assert.equal(readState().fields.shopOperatingAddress, 'Via Officina 20, Zona industriale, 00100 Roma (RM)');

    async function openQuotes() {
      const menu = f.locator('#documentsMenuToggle');
      if (await menu.getAttribute('aria-expanded') !== 'true') await menu.click();
      await f.locator('.nav [data-view="quotes"]').click();
    }
    async function createQuote(customer, description, price) {
      await f.locator('#newQuote').click();
      await f.locator('#quoteCustomer').fill(customer);
      await f.locator('#quoteVehicle').fill('AB123CD');
      await f.locator('#quoteDate').fill('2026-10-01');
      await f.locator('#quoteLines [data-q="description"]').fill(description);
      await f.locator('#quoteLines [data-q="price"]').fill(String(price));
      await f.locator('#quoteForm button[type="submit"]').click();
      await flush();
    }
    await openQuotes();
    await createQuote('Altro cliente', 'Controllo freni', 50);
    await createQuote('Cliente preventivo', 'Sostituzione pneumatici e controllo pressione', 440);
    const originalQuotes = savedQuotes();
    assert.equal(originalQuotes.length, 2);
    const otherQuote = originalQuotes.find(q => q.customer === 'Altro cliente');
    const deletingId = originalQuotes.find(q => q.customer === 'Cliente preventivo').id;

    await page.reload();
    await ready();
    f = frame();
    assert.equal(await f.locator('#shopOperatingAddress').inputValue(), 'Via Officina 20, Zona industriale, 00100 Roma (RM)');
    assert.equal(await f.locator('#shopAddress').inputValue(), 'Via Legale 10, 00100 Roma (RM)');
    await openQuotes();
    const targetRow = () => f.locator('#quotesList tr').filter({hasText:'Cliente preventivo'});
    await targetRow().locator('[data-quote]').click();
    await f.locator('#quoteSend').click();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      f.locator('#quoteDownloadPdf').click()
    ]);
    const pdfPath = process.env.QUOTE_PDF_OUTPUT || path.join(dataDir, 'preventivo.pdf');
    fs.mkdirSync(path.dirname(pdfPath), {recursive:true});
    await download.saveAs(pdfPath);
    assert.ok(fs.readFileSync(pdfPath).subarray(0, 5).equals(Buffer.from('%PDF-')));
    const PDFLib = require(path.join(root, 'vendor/pdf-lib.min.js'));
    assert.ok((await PDFLib.PDFDocument.load(fs.readFileSync(pdfPath))).getPageCount() > 0);
    // Native save/share must finish before an external mail app can obscure it.
    await f.locator('#quoteEmail').fill('cliente@example.test');
    await f.evaluate(() => {
      window.originalQuoteMail = WorkshopEmail.send;
      WorkshopEmail.send = async () => ({manual:true,provider:'gmail',email:'officina@example.test'});
      window.nativeMailOpens = [];
      window.WorkshopNative = {
        exportBlob: (blob,name) => {window.nativeExport={size:blob.size,type:blob.type,name};return new Promise((resolve,reject)=>{window.finishNativeExport=resolve;window.failNativeExport=reject;});},
        openExternal: async url => {window.nativeMailOpens.push(url);}
      };
    });
    await f.locator('#quoteEmailLink').click();
    await f.waitForFunction(() => typeof finishNativeExport === 'function');
    assert.equal(await f.evaluate(() => nativeMailOpens.length),0,'mail waits for the native picker');
    assert.ok(await f.evaluate(() => nativeExport.size>100 && nativeExport.type==='application/pdf'));
    await f.evaluate(() => finishNativeExport({status:'saved'}));
    await f.waitForFunction(() => nativeMailOpens.length===1);
    await f.waitForFunction(() => !document.getElementById('quoteEmailLink').disabled);
    await f.evaluate(() => {window.finishNativeExport=null;});
    await f.locator('#quoteEmailLink').click();
    await f.waitForFunction(() => typeof finishNativeExport === 'function');
    await f.evaluate(() => finishNativeExport({status:'cancelled'}));
    await f.waitForFunction(() => document.getElementById('quoteShareError').textContent.includes('annullati'));
    assert.equal(await f.evaluate(() => nativeMailOpens.length),1,'cancelled export never opens mail');
    await f.evaluate(() => {window.finishNativeExport=null;});
    await f.locator('#quoteEmailLink').click();
    await f.waitForFunction(() => typeof finishNativeExport === 'function');
    await f.evaluate(() => finishNativeExport({status:'shared'}));
    await f.waitForFunction(() => !document.getElementById('quoteOpenDraft').hidden);
    assert.equal(await f.evaluate(() => nativeMailOpens.length),1,'mobile sharing must not open a second mail app automatically');
    await f.locator('#quoteOpenDraft').click();
    await f.waitForFunction(() => nativeMailOpens.length===2);
    await f.evaluate(() => {delete window.WorkshopNative;WorkshopEmail.send=originalQuoteMail;});
    console.log('PASS native quote save waits before email; cancellation and mobile sharing do not open email automatically');
    await f.locator('#quoteShareClose').click();
    await f.locator('#quoteCancel').click();
    await flush();
    console.log('PASS legal and operating addresses persist after reload; actual quote PDF downloads');

    if (process.env.QUOTE_SCREENSHOT_DESKTOP) await page.screenshot({path:process.env.QUOTE_SCREENSHOT_DESKTOP});
    await page.setViewportSize({width:390,height:844});
    const deleteButton = targetRow().locator('[data-quote-delete]');
    await deleteButton.scrollIntoViewIfNeeded();
    const box = await deleteButton.boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 390, 'delete button is accessible on phones');
    if (process.env.QUOTE_SCREENSHOT_MOBILE) await page.screenshot({path:process.env.QUOTE_SCREENSHOT_MOBILE});
    await deleteButton.click();
    assert.match(lastConfirmation, /Cliente preventivo/);
    await flush();
    assert.deepEqual(savedQuotes().find(q => q.id === deletingId), originalQuotes.find(q => q.id === deletingId));
    assert.equal(await targetRow().count(), 1);
    acceptRemoval = true;
    await deleteButton.click();
    await flush();
    assert.equal(savedQuotes().some(q => q.id === deletingId), false);
    assert.deepEqual(savedQuotes(), [otherQuote], 'deleting one quote preserves the other quote');
    await page.reload();
    await ready();
    f = frame();
    await openQuotes();
    assert.equal(await targetRow().count(), 0);
    assert.equal(await f.locator('#quotesList [data-quote-delete]').count(), 1);
    console.log('PASS cancellation preserves quote; confirmed deletion persists without changing other quotes');

    const viewer = await browser.newPage();
    viewer.on('pageerror', error => errors.push(error.message));
    await viewer.goto(origin);
    await viewer.locator('#username').fill('quotes-viewer');
    await viewer.locator('#password').fill('test-password-1234');
    await viewer.locator('#loginForm button[type="submit"]').click();
    await viewer.waitForFunction(() => document.querySelector('iframe')?.contentWindow?.WorkshopCloud?.initializing === false);
    const vf = viewer.frames().find(item => item.url().includes('/legacy'));
    await vf.locator('#documentsMenuToggle').click();
    await vf.locator('.nav [data-view="quotes"]').click();
    assert.equal(await vf.locator('#quotesList [data-quote-delete]').isVisible(), false);
    assert.deepEqual(savedQuotes(), [otherQuote]);
    assert.deepEqual(errors, []);
    console.log('PASS quote deletion is unavailable to viewer; no browser runtime errors');
  } finally {
    await browser.close();
    await app.close();
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
