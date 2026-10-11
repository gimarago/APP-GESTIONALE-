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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'officina-forms-archive-'));
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const {createApplication} = await import(pathToFileURL(path.join(root, 'server/server.mjs')));
  const {addUser} = await import(pathToFileURL(path.join(root, 'server/database.mjs')));
  const app = await createApplication({root, dataDir, origin, env:{NODE_ENV:'test'}});
  await addUser(app.db, 'archive-test', 'test-password-1234', 'operator');
  await addUser(app.db, 'archive-viewer', 'test-password-1234', 'viewer');
  await new Promise(resolve => app.server.listen(port, '127.0.0.1', resolve));
  const browser = await chromium.launch({...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}), headless:true});
  const errors = [];
  const records = [
    {id:'module-alice-older', type:'refusal', Customer:'Alice Rossi', Date:'2026-09-01', Plate:'AA123BB'},
    {id:'module-bruno', type:'privacy', Customer:'Bruno Verdi', Date:'2026-10-01', Plate:'BB456CC'},
    {id:'module-alice-newer', type:'parts', Customer:'ALICE ROSSI', Date:'2026-10-01', Plate:'AA123BB'}
  ];
  try {
    const page = await browser.newPage({viewport:{width:1278,height:1050}});
    page.on('pageerror', error => errors.push(error.message));
    const ready = () => page.waitForFunction(() => document.querySelector('iframe')?.contentWindow?.WorkshopCloud?.initializing === false);
    const frame = () => page.frames().find(item => item.url().includes('/legacy'));
    await page.goto(origin);
    await page.locator('#username').fill('archive-test');
    await page.locator('#password').fill('test-password-1234');
    await page.locator('#loginForm button[type="submit"]').click();
    await ready();
    let f = frame();
    await f.evaluate(value => localStorage.setItem('officina-moduli-v1', JSON.stringify(value)), records);
    await page.evaluate(() => WorkshopCloudHost.flush());
    assert.equal(JSON.parse(JSON.parse(app.db.prepare('SELECT payload FROM state WHERE id=1').get().payload).storage['officina-moduli-v1']).length, 3);
    await page.reload();
    await ready();
    f = frame();
    await f.locator('.nav [data-view="moduli"]').click();
    assert.equal(await f.locator('#moduli #formsArchive').count(), 0, 'old flat list is replaced by the archive button');
    await f.locator('#openFormsArchive').click();
    assert.equal(await f.locator('#moduliArchivio').isVisible(), true);
    const customers = f.locator('#formsArchive .archive-customer-toggle');
    assert.deepEqual((await customers.allInnerTexts()).map(text => text.split('\n')[0].trim()), ['Alice Rossi', 'Bruno Verdi']);
    assert.match(await customers.first().innerText(), /2 moduli/);
    assert.equal(await f.locator('#formsArchive .archive-documents:not([hidden])').count(), 0);
    await customers.first().click();
    const visible = f.locator('#formsArchive .archive-documents:not([hidden]) .archive-document');
    assert.equal(await visible.count(), 2);
    assert.match(await visible.first().innerText(), /Fornitura propria di ricambi/);
    assert.match(await visible.last().innerText(), /Rifiuto di interventi raccomandati/);
    if (process.env.FORMS_ARCHIVE_SCREENSHOT_DESKTOP) await page.screenshot({path:process.env.FORMS_ARCHIVE_SCREENSHOT_DESKTOP});
    await visible.last().locator('[data-record]').click();
    assert.equal(await f.locator('#moduleCustomer').inputValue(), 'Alice Rossi');
    await f.locator('#moduleClose').click();
    await page.setViewportSize({width:390,height:844});
    const toggleBox = await customers.first().boundingBox();
    assert.ok(toggleBox && toggleBox.x >= 0 && toggleBox.x + toggleBox.width <= 390);
    if (process.env.FORMS_ARCHIVE_SCREENSHOT_MOBILE) await page.screenshot({path:process.env.FORMS_ARCHIVE_SCREENSHOT_MOBILE});
    await f.locator('#backToModules').click();
    assert.equal(await f.locator('#moduli').isVisible(), true);
    await f.locator('#openFormsArchive').click();
    assert.equal(await visible.count(), 2, 'expanded customer stays open when returning to archive');

    const viewer = await browser.newPage();
    viewer.on('pageerror', error => errors.push(error.message));
    await viewer.goto(origin);
    await viewer.locator('#username').fill('archive-viewer');
    await viewer.locator('#password').fill('test-password-1234');
    await viewer.locator('#loginForm button[type="submit"]').click();
    await viewer.waitForFunction(() => document.querySelector('iframe')?.contentWindow?.WorkshopCloud?.initializing === false);
    const vf = viewer.frames().find(item => item.url().includes('/legacy'));
    await vf.locator('.nav [data-view="moduli"]').click();
    await vf.locator('#openFormsArchive').click();
    await vf.locator('#formsArchive .archive-customer-toggle').first().click();
    await vf.locator('#formsArchive .archive-documents:not([hidden]) [data-record]').first().click();
    assert.equal(await vf.locator('#workshopFormDialog').evaluate(dialog => dialog.open), true);
    assert.deepEqual(errors, []);
    console.log('PASS module archive groups customers alphabetically, opens every saved module, survives reload and works in consultation mode');
  } finally {
    await browser.close();
    await app.close();
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
