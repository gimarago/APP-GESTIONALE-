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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'officina-customer-groups-'));
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const {createApplication} = await import(pathToFileURL(path.join(root, 'server/server.mjs')));
  const {addUser} = await import(pathToFileURL(path.join(root, 'server/database.mjs')));
  const app = await createApplication({root, dataDir, origin, env:{NODE_ENV:'test'}});
  await addUser(app.db, 'customer-groups-test', 'test-password-1234', 'admin');
  await new Promise(resolve => app.server.listen(port, '127.0.0.1', resolve));
  const browser = await chromium.launch({...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}), headless:true});
  const errors = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.locator('#username').fill('customer-groups-test');
    await page.locator('#password').fill('test-password-1234');
    await page.locator('#loginForm button[type="submit"]').click();
    const ready = () => page.waitForFunction(() => document.querySelector('iframe')?.contentWindow?.WorkshopCloud?.initializing === false);
    await ready();
    let frame = page.frames().find(item => item.url().includes('/legacy'));
    await frame.locator('.nav [data-view="clienti"]').click();
    await frame.locator('#clienti [data-cloud-open="customerModal"]').click();
    await frame.locator('#customerName').fill('Mario Rossi');
    await frame.locator('#customerPhone').fill('3331234567');
    await frame.locator('#customerVehicle').fill('Fiat Panda');
    await frame.locator('#customerPlate').fill('AA123BB');
    await frame.locator('#customerForm button[type="submit"]').click();
    await frame.locator('#customerGroups .customer-group-history').click();
    await frame.locator('#historyModal .add-vehicle').click();
    await frame.locator('#customerVehicle').fill('Fiat 500');
    await frame.locator('#customerPlate').fill('CC456DD');
    await frame.locator('#customerForm button[type="submit"]').click();

    assert.equal(await frame.locator('#customerRows tr').count(), 2, 'two authoritative vehicle rows remain');
    assert.equal(await frame.locator('#customerGroups .customer-group-row').count(), 1, 'one visible customer row');
    assert.equal(await frame.locator('#customerGroups .customer-vehicle-row').count(), 0, 'vehicles start collapsed');
    assert.match(await frame.locator('#customerGroups .customer-group-row').innerText(), /2 veicoli/);
    await frame.locator('#customerGroups .customer-group-toggle').click();
    assert.deepEqual(await frame.locator('#customerGroups .customer-vehicle-row .plate').allTextContents(), ['AA123BB', 'CC456DD']);
    await frame.locator('#customerGroups .customer-group-toggle').click();
    assert.equal(await frame.locator('#customerGroups .customer-vehicle-row').count(), 0);

    await frame.locator('#search').fill('cc 456 dd');
    await frame.locator('#customerGroups .customer-vehicle-row').waitFor();
    assert.equal(await frame.locator('#customerGroups .customer-group-row').count(), 1);
    assert.deepEqual(await frame.locator('#customerGroups .customer-vehicle-row .plate').allTextContents(), ['CC456DD'], 'plate search opens matching customer and only matching vehicle');
    await frame.locator('#customerGroups .customer-vehicle-history').click();
    assert.match(await frame.locator('#historyTitle').innerText(), /Mario Rossi/);
    await frame.locator('#historyModal [data-cloud-close]').click();
    await frame.locator('#search').fill('XX999XX');
    await frame.waitForFunction(() => !document.querySelector('#customerGroups .customer-group-row'));
    assert.equal(await frame.locator('#customerGroups .customer-group-row').count(), 0);
    assert.equal(await frame.locator('#clienti .customer-group-empty').isVisible(), true);
    await frame.locator('#search').fill('');
    await page.evaluate(() => WorkshopCloudHost.flush());

    await page.reload();
    await ready();
    frame = page.frames().find(item => item.url().includes('/legacy'));
    await frame.locator('.nav [data-view="clienti"]').click();
    assert.equal(await frame.locator('#customerRows tr').count(), 2, 'vehicle records survive server reload');
    assert.equal(await frame.locator('#customerGroups .customer-group-row').count(), 1, 'group rebuilds after reload');
    await frame.locator('#search').fill('AA123BB');
    assert.deepEqual(await frame.locator('#customerGroups .customer-vehicle-row .plate').allTextContents(), ['AA123BB']);
    await page.setViewportSize({width:390,height:844});
    assert.equal(await frame.locator('#customerGroupMobileSearch').isVisible(),true,'plate search remains visible on phones');
    await frame.locator('#customerGroupMobileSearch').fill('CC456DD');
    await frame.waitForFunction(() => document.querySelector('#customerGroups .customer-vehicle-row .plate')?.textContent === 'CC456DD');
    assert.deepEqual(await frame.locator('#customerGroups .customer-vehicle-row .plate').allTextContents(),['CC456DD']);
    assert.deepEqual(errors, []);
    console.log('PASS customers grouped without changing saved vehicle rows; expansion, plate search and reload work');
  } finally {
    await browser.close();
    await app.close();
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
