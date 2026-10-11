const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { pathToFileURL } = require('node:url');
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'officina-supplier-e2e-'));
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const { createApplication } = await import(pathToFileURL(path.join(root, 'server/server.mjs')));
  const { addUser, openDatabase } = await import(pathToFileURL(path.join(root, 'server/database.mjs')));
  const { importPecInvoice } = await import(pathToFileURL(path.join(root, 'server/supplier-invoices.mjs')));
  const { XmlGenerator } = await import(pathToFileURL(path.join(root, 'backend/src/fatture/xml-generator.js')));
  const { sampleInvoice } = await import(pathToFileURL(path.join(root, 'backend/fixtures/invoice.js')));
  const app = await createApplication({root, dataDir, origin, env:{NODE_ENV:'test'}});
  await addUser(app.db, 'admin-test', 'test-password-1234', 'admin');
  await addUser(app.db, 'operator-test', 'test-password-1234', 'operator');
  await addUser(app.db, 'viewer-test', 'test-password-1234', 'viewer');
  const issueDate = new Date().toISOString().slice(0,10);
  const dueDate = new Date(Date.now() + 30 * 86400000).toISOString().slice(0,10);
  const pecOriginal = Buffer.from(await new XmlGenerator().generate(sampleInvoice()));
  importPecInvoice(app.db, {
    sourceKey:'pec-ui-test-1', supplierName:'Fornitore PEC', supplierTaxId:'12345678901',
    number:'PEC-22', issueDate, dueDate, totalCents:null, documentType:'TD01',
    filename:'fattura-pec.xml', originalBytes:pecOriginal
  });
  await new Promise(resolve => app.server.listen(port, '127.0.0.1', resolve));
  const browser = await chromium.launch({...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}), headless:true});
  const errors = [];
  async function login(username, viewport) {
    const context = await browser.newContext(viewport ? {viewport, acceptDownloads:true} : {acceptDownloads:true});
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.locator('#username').fill(username);
    await page.locator('#password').fill('test-password-1234');
    await page.locator('#loginForm button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector('iframe')?.contentWindow?.WorkshopCloud?.initializing === false);
    return {page, context, frame:page.frames().find(frame => frame.url().includes('/legacy'))};
  }
  const shown = (frame, text) => frame.locator('#supplierInvoiceList .supplier-list-row').filter({hasText:text});
  try {
    const admin = await login('admin-test');
    const menu = admin.frame.locator('#documentsMenuToggle');
    assert.equal(await menu.getAttribute('aria-expanded'), 'false');
    assert.equal(await admin.frame.locator('#documentsSubmenu').isVisible(), false);
    await menu.click();
    assert.equal(await menu.getAttribute('aria-expanded'), 'true');
    assert.deepEqual((await admin.frame.locator('#documentsSubmenu button').allTextContents()).map(text => text.trim()), [
      'Preventivi', 'Fatture emesse', 'Fatture fornitori'
    ]);
    await admin.frame.locator('.nav [data-view="quotes"]').click();
    await admin.frame.waitForFunction(() => WorkshopCloud.view() === 'quotes');
    assert.equal(await admin.frame.locator('#title').innerText(), 'Preventivi');
    assert.equal(await admin.frame.locator('#quotes').isVisible(), true);
    assert.equal(await menu.getAttribute('aria-expanded'), 'false');
    await menu.click();
    await admin.frame.locator('.nav [data-view="preventivi"]').click();
    await admin.frame.waitForFunction(() => WorkshopCloud.view() === 'preventivi');
    assert.equal(await admin.frame.locator('#title').innerText(), 'Fatture emesse');
    assert.equal(await admin.frame.locator('#invoiceApp').isVisible(), true);
    await menu.click();
    await admin.frame.locator('.nav [data-view="supplierInvoices"]').click();
    await admin.frame.waitForFunction(() => WorkshopCloud.view() === 'supplierInvoices');
    assert.equal(await admin.frame.locator('#title').innerText(), 'Fatture fornitori');
    await shown(admin.frame, 'PEC-22').waitFor();
    assert.match(await admin.frame.locator('#supplierSyncStatus').innerText(), /non ancora configurata/i);
    assert.match(await admin.frame.locator('#supplierPendingReviewCount').innerText(), /^1$/);
    assert.match(await admin.frame.locator('#supplierToPay').innerText(), /0,00/);

    await admin.frame.locator('#supplierInvoiceNew').click();
    await admin.frame.locator('#supplierFormName').fill('Fornitore manuale');
    await admin.frame.locator('#supplierFormTaxId').fill('98765432109');
    await admin.frame.locator('#supplierFormNumber').fill('F-001');
    await admin.frame.locator('#supplierFormIssueDate').fill(issueDate);
    await admin.frame.locator('#supplierFormDueDate').fill(dueDate);
    await admin.frame.locator('#supplierFormTotal').fill('120,00');
    await admin.frame.locator('#supplierFormSubmit').click();
    await shown(admin.frame, 'F-001').waitFor();
    await admin.frame.waitForFunction(() => document.querySelector('#supplierToPay').textContent.includes('120,00'));

    await shown(admin.frame, 'F-001').click();
    await admin.frame.locator('#supplierInvoiceDetail').getByText('Registra pagamento').click();
    await admin.frame.locator('#supplierPaymentAmount').fill('50,00');
    await admin.frame.locator('#supplierPaymentConfirmed').check();
    await admin.frame.locator('#supplierPaymentSubmit').click();
    await admin.frame.waitForFunction(() => document.querySelector('#supplierToPay').textContent.includes('70,00'));
    await admin.frame.waitForFunction(() => document.querySelector('#supplierInvoiceDetail').textContent.includes('50,00'));
    assert.match(await admin.frame.locator('#supplierInvoiceDetail').innerText(), /50,00/);

    await shown(admin.frame, 'PEC-22').click();
    await admin.frame.locator('#supplierInvoiceDetail a[href$="/original"]').waitFor();
    const original = await admin.frame.evaluate(async () => {
      const response = await fetch(document.querySelector('#supplierInvoiceDetail a[href$="/original"]').href);
      return {status:response.status, text:await response.text()};
    });
    assert.equal(original.status, 200);
    assert.match(original.text, /FatturaElettronica/);
    await admin.frame.locator('#supplierInvoiceDetail').getByText('Visualizza fattura').click();
    await admin.frame.locator('.supplier-xml-preview').getByText('Manodopera & prova <XML>').waitFor();
    await admin.frame.locator('#supplierInvoiceDetail').getByText('Verifica / modifica').click();
    assert.equal(await admin.frame.locator('#supplierFormTotal').inputValue(), '');
    await admin.frame.locator('#supplierFormTotal').fill('98,25');
    await admin.frame.locator('#supplierFormVerified').check();
    await admin.frame.locator('#supplierFormSubmit').click();
    await admin.frame.waitForFunction(() => document.querySelector('#supplierToPay').textContent.includes('168,25'));
    assert.match(await admin.frame.locator('#supplierPendingReviewCount').innerText(), /^0$/);

    const viewer = await login('viewer-test', {width:390, height:844});
    await viewer.frame.locator('#documentsMenuToggle').click();
    assert.equal(await viewer.frame.locator('#documentsSubmenu').isVisible(), true);
    const mobileMenu = await viewer.frame.locator('#documentsSubmenu').boundingBox();
    assert.ok(mobileMenu && mobileMenu.x >= 0 && mobileMenu.x + mobileMenu.width <= 390);
    await viewer.frame.locator('.nav [data-view="supplierInvoices"]').click();
    await viewer.frame.waitForFunction(() => WorkshopCloud.view() === 'supplierInvoices');
    await shown(viewer.frame, 'F-001').waitFor();
    assert.equal(await viewer.frame.locator('#supplierInvoiceNew').isVisible(), false);
    await shown(viewer.frame, 'PEC-22').click();
    await viewer.frame.locator('#supplierInvoiceDetail a[href$="/original"]').waitFor();
    assert.equal(await viewer.frame.locator('#supplierInvoiceDetail').getByText('Registra pagamento').count(), 0);
    await viewer.frame.locator('#supplierInvoiceDetail').getByText('Visualizza fattura').click();
    await viewer.frame.locator('.supplier-xml-preview').getByText('Manodopera & prova <XML>').waitFor();
    const [xmlDownload] = await Promise.all([
      viewer.page.waitForEvent('download'),
      viewer.frame.locator('#supplierInvoiceDetail a[href$="/original"]').click()
    ]);
    assert.match(xmlDownload.suggestedFilename(), /\.xml$/i);
    const [csvDownload] = await Promise.all([
      viewer.page.waitForEvent('download'),
      viewer.frame.locator('#supplierExportCsv').click()
    ]);
    const csv = fs.readFileSync(await csvDownload.path(), 'utf8');
    assert.match(csv, /Fornitore PEC/);
    assert.doesNotMatch(csv, /<FatturaElettronica/);
    const width = await viewer.frame.evaluate(() => ({scroll:document.querySelector('#supplierInvoices').scrollWidth, client:document.querySelector('#supplierInvoices').clientWidth}));
    assert.ok(width.scroll <= width.client + 3, JSON.stringify(width));

    // The PEC service has its own SQLite connection/process. Both users see an
    // imported document in the section they are already viewing.
    for (const client of [viewer, admin]) await client.frame.evaluate(() => window.supplierInvoiceLiveFrame = crypto.randomUUID());
    const frameMarks = await Promise.all([viewer, admin].map(client => client.frame.evaluate(() => window.supplierInvoiceLiveFrame)));
    const previewCounts = await Promise.all([viewer, admin].map(client => client.frame.locator('.supplier-xml-preview').count()));
    assert.equal(previewCounts[0], 1);
    const workerDb = openDatabase(dataDir);
    try {
      importPecInvoice(workerDb, {sourceKey:'pec-ui-test-live', supplierName:'Nuovo fornitore PEC',
        supplierTaxId:'IT55555555555', number:'PEC-LIVE', issueDate, dueDate, totalCents:1000,
        documentType:'TD01', filename:'nuova-fattura.xml', originalBytes:pecOriginal});
    } finally { workerDb.close(); }
    for (const [index, client] of [viewer, admin].entries()) {
      await shown(client.frame, 'PEC-LIVE').waitFor({timeout:15000});
      assert.equal(await client.frame.evaluate(() => window.supplierInvoiceLiveFrame), frameMarks[index]);
      assert.equal(await client.frame.evaluate(() => WorkshopCloud.view()), 'supplierInvoices');
      assert.equal(await client.frame.locator('.supplier-xml-preview').count(), previewCounts[index], 'an unrelated invoice update retains the open XML preview');
    }

    await shown(admin.frame, 'F-001').click();
    await admin.frame.locator('#supplierInvoiceDetail').getByText('Modifica dati').waitFor();
    let heldStarted, releaseHeld;
    const heldRequest = new Promise(resolve => {heldStarted = resolve;});
    const gate = new Promise(resolve => {releaseHeld = resolve;});
    let held = false;
    await admin.page.route('**/api/supplier-invoices', async route => {
      if (route.request().method() !== 'GET' || held) return route.continue();
      held = true;
      const response = await route.fetch();
      heldStarted();
      await gate;
      await route.fulfill({response});
    });
    const operator = await login('operator-test');
    await operator.frame.locator('#documentsMenuToggle').click();
    await operator.frame.locator('.nav [data-view="supplierInvoices"]').click();
    await operator.frame.waitForFunction(() => WorkshopCloud.view() === 'supplierInvoices');
    await shown(operator.frame, 'F-001').click();
    await operator.frame.locator('#supplierInvoiceDetail').getByText('Modifica dati').click();
    await operator.frame.locator('#supplierFormName').fill('Fornitore aggiornato');
    await operator.frame.locator('#supplierFormSubmit').click();
    await operator.frame.waitForFunction(() => document.querySelector('#supplierInvoiceModal').classList.contains('open') === false);
    await heldRequest;
    await admin.frame.locator('#supplierInvoiceDetail').getByText('Modifica dati').click();
    await admin.frame.locator('#supplierFormNotes').fill('Bozza in conflitto');
    releaseHeld();
    await admin.page.waitForTimeout(1300);
    await admin.page.unroute('**/api/supplier-invoices');
    assert.equal(await admin.frame.locator('#supplierFormName').inputValue(), 'Fornitore manuale');
    assert.equal(await admin.frame.locator('#supplierFormNotes').inputValue(), 'Bozza in conflitto');
    assert.ok(await admin.frame.locator('#supplierInvoiceModal').evaluate(element => element.classList.contains('open')));
    await admin.frame.locator('#supplierFormSubmit').click();
    await admin.frame.locator('#supplierFormError').getByText(/modificata da un altro operatore/i).waitFor();
    const saved = app.db.prepare('SELECT supplier_name,notes FROM supplier_invoices WHERE number=?').get('F-001');
    assert.equal(saved.supplier_name, 'Fornitore aggiornato');
    assert.notEqual(saved.notes, 'Bozza in conflitto');
    assert.deepEqual(errors, []);
    console.log('PASS supplier invoices E2E: manual payment, PEC review/XML, two-device live import without reload, mobile viewer/CSV, a form opened during GET keeps its draft and stale edit is rejected');
  } finally {
    await browser.close();
    await app.close();
    const absolute = path.resolve(dataDir);
    if (!absolute.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(absolute).startsWith('officina-supplier-e2e-')) {
      throw new Error('Unsafe test cleanup');
    }
    fs.rmSync(absolute, {recursive:true, force:true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
