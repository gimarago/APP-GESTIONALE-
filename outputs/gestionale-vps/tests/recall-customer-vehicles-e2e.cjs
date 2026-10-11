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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'officina-recall-customers-'));
  const port = await availablePort(), origin = `http://127.0.0.1:${port}`;
  const {createApplication} = await import(pathToFileURL(path.join(root, 'server/server.mjs')));
  const {addUser} = await import(pathToFileURL(path.join(root, 'server/database.mjs')));
  const app = await createApplication({root, dataDir, origin, env:{NODE_ENV:'test'}});
  await addUser(app.db, 'recall-test', 'test-password-1234', 'admin');
  await new Promise(resolve => app.server.listen(port, '127.0.0.1', resolve));
  const browser = await chromium.launch({...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}), headless:true});
  const errors = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.locator('#username').fill('recall-test');
    await page.locator('#password').fill('test-password-1234');
    await page.locator('#loginForm button[type="submit"]').click();
    const ready = () => page.waitForFunction(() => document.querySelector('iframe')?.contentWindow?.WorkshopCloud?.initializing === false);
    await ready();
    let frame = page.frames().find(item => item.url().includes('/legacy'));
    const open = async () => {
      await frame.evaluate(() => showPage('richiami'));
      await frame.locator('#richiami .page-head .btn').click();
    };
    await open();
    assert.equal(await frame.locator('#recallForm [type="submit"]').isDisabled(), true, 'empty archive cannot save a recall');
    await frame.locator('#recallModal [data-cloud-close]').click();
    await frame.evaluate(() => {
      const source = document.getElementById('customerRows');
      for (const record of [
        ['BLEMAR', 'Fiat Panda', 'AA123BB'],
        ['BLEMAR', 'Fiat 500', 'CC456DD'],
        ['blemar', 'Fiat 500', 'CC 456 DD'],
        ['Rossi & Figli', 'Ford Fiesta', 'EE789FF'],
        ['Senza veicolo', '—', '—']
      ]) {
        const row = source.insertRow();
        for (const value of [record[0], '—', '—', record[1], record[2], '—']) row.insertCell().textContent = value;
      }
    });
    await page.evaluate(() => WorkshopCloudHost.flush());
    await open();
    assert.deepEqual(await frame.locator('#recallCustomer option').allTextContents(),
      ['Seleziona un cliente', 'BLEMAR', 'Rossi & Figli', 'Senza veicolo'], 'names appear only once with safe text labels');
    assert.equal(await frame.locator('#recallVehicle').isVisible(), false, 'vehicle list waits for the customer selection');
    await frame.locator('#recallCustomer').selectOption({label:'BLEMAR'});
    assert.equal(await frame.locator('#recallVehicle').isVisible(), true);
    assert.deepEqual(await frame.locator('#recallVehicle option').allTextContents(),
      ['Seleziona un veicolo', 'Fiat Panda · AA123BB', 'Fiat 500 · CC456DD'], 'one option per vehicle, including duplicate plate spacing');
    const reason = 'Tagliando <img src=x onerror="window.recallInjected=true">';
    await frame.locator('#recallReason').fill(reason);
    await frame.locator('#recallForm [type="submit"]').click();
    assert.equal(await frame.locator('#recallModal').evaluate(element => element.classList.contains('open')), true, 'multi-vehicle recall cannot save without a selected vehicle');
    assert.equal(await frame.locator('#richiami .agenda-row:not([data-revision-auto])').count(), 0);
    await frame.locator('#recallVehicle').selectOption({label:'Fiat 500 · CC456DD'});
    await frame.locator('#recallDate').fill('2026-10-08');
    await frame.locator('#recallForm [type="submit"]').click();
    const first = frame.locator('#richiami .agenda-row:not([data-revision-auto])').first();
    assert.equal(await first.locator('b').innerText(), 'BLEMAR');
    assert.match(await first.locator('span').innerText(), /Fiat 500 · CC456DD · 08\/10\/2026/);
    assert.equal(await first.getAttribute('data-plate'), 'CC456DD');
    assert.equal(await first.getAttribute('data-vehicle'), 'Fiat 500');
    assert.equal(await first.locator('img').count(), 0, 'recall reason remains text');
    assert.equal(await frame.evaluate(() => !!window.recallInjected), false);
    await page.evaluate(() => WorkshopCloudHost.flush());
    console.log('PASS unique recall customers, deduplicated vehicles, required multi-vehicle selection and safe saved text');

    await open();
    await frame.locator('#recallCustomer').selectOption({label:'BLEMAR'});
    await frame.locator('#recallVehicle').selectOption({label:'Fiat Panda · AA123BB'});
    await frame.locator('#recallCustomer').selectOption({label:'Rossi & Figli'});
    assert.equal(await frame.locator('#recallVehicle').isVisible(), false);
    assert.equal(await frame.locator('#recallVehicle').inputValue(), 'ee789ff', 'switching customer clears the previous vehicle');
    await frame.locator('#recallReason').fill('Controllo pressione');
    await frame.locator('#recallForm [type="submit"]').click();
    const second = frame.locator('#richiami .agenda-row:not([data-revision-auto])').nth(1);
    assert.equal(await second.locator('b').innerText(), 'Rossi & Figli');
    assert.equal(await second.getAttribute('data-plate'), 'EE789FF', 'single vehicle is automatically linked');
    await page.evaluate(() => WorkshopCloudHost.flush());

    await open();
    await frame.locator('#recallCustomer').selectOption({label:'Senza veicolo'});
    assert.equal(await frame.locator('#recallVehicle').isVisible(), false);
    await frame.locator('#recallReason').fill('Contatto cliente');
    await frame.locator('#recallForm [type="submit"]').click();
    await page.evaluate(() => WorkshopCloudHost.flush());
    await page.reload();
    await ready();
    frame = page.frames().find(item => item.url().includes('/legacy'));
    await frame.evaluate(() => showPage('richiami'));
    const saved = frame.locator('#richiami .agenda-row:not([data-revision-auto])');
    assert.equal(await saved.count(), 3, 'manual recalls survive a confirmed server reload');
    assert.equal(await saved.first().getAttribute('data-plate'), 'CC456DD');
    assert.equal(await saved.nth(1).getAttribute('data-plate'), 'EE789FF');
    assert.equal(await saved.nth(2).getAttribute('data-plate'), null, 'customer without a vehicle still supports a generic recall');
    assert.equal(await saved.first().locator('span').textContent(), `${reason} · Fiat 500 · CC456DD · 08/10/2026`);
    await page.setViewportSize({width:390, height:844});
    await open();
    await frame.locator('#recallCustomer').selectOption({label:'BLEMAR'});
    assert.equal(await frame.locator('#recallVehicle').isVisible(), true, 'vehicle selector remains available on mobile');
    const bounds = await frame.locator('#recallVehicle').boundingBox();
    assert.ok(bounds.width <= 390 && bounds.x >= 0);
    assert.deepEqual(errors, []);
    console.log('PASS customer switching, single/zero vehicle recalls, persisted vehicle association and mobile selector');
  } finally {
    await browser.close();
    await app.close();
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
