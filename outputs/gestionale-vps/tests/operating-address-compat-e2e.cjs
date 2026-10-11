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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'officina-old-schema-'));
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const {createApplication} = await import(pathToFileURL(path.join(root, 'server/server.mjs')));
  const {addUser} = await import(pathToFileURL(path.join(root, 'server/database.mjs')));
  const currentSchema = require(path.join(root, 'cloud-schema.js'));
  const olderSchema = {...currentSchema, fields:currentSchema.fields.filter(field => field !== 'shopOperatingAddress')};
  const app = await createApplication({root, dataDir, origin, env:{NODE_ENV:'test'}, schema:olderSchema});
  await addUser(app.db, 'old-schema-test', 'test-password-1234', 'operator');
  await new Promise(resolve => app.server.listen(port, '127.0.0.1', resolve));
  const browser = await chromium.launch({...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}), headless:true});
  const errors = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.locator('#username').fill('old-schema-test');
    await page.locator('#password').fill('test-password-1234');
    await page.locator('#loginForm button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector('iframe')?.contentWindow?.WorkshopCloud?.initializing === false);
    const frame = page.frames().find(item => item.url().includes('/legacy'));
    await frame.locator('.nav [data-view="impostazioni"]').click();
    assert.equal(await frame.locator('#shopOperatingAddress').isVisible(), true);
    assert.equal(await frame.locator('#shopOperatingAddress').isDisabled(), true);
    assert.match(await frame.locator('#shopOperatingAddress').locator('..').innerText(), /Riavvia il gestionale/);
    await frame.locator('#shopPhone').fill('06 12345678');
    await page.evaluate(() => WorkshopCloudHost.flush());
    const state = JSON.parse(app.db.prepare('SELECT payload FROM state WHERE id=1').get().payload);
    assert.equal(state.fields.shopPhone, '06 12345678');
    assert.equal(Object.hasOwn(state.fields, 'shopOperatingAddress'), false);
    assert.equal(await page.locator('#mode').innerText(), 'Modifica condivisa');
    assert.deepEqual(errors, []);
    console.log('PASS new frontend continues saving with a running server that does not support the new address field');
  } finally {
    await browser.close();
    await app.close();
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
