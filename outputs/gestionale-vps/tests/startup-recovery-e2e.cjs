const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {pathToFileURL} = require('node:url');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const assert = require('node:assert/strict');

(async () => {
  const root = path.resolve(__dirname, '..');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'officina-startup-'));
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const {createApplication} = await import(pathToFileURL(path.join(root, 'server/server.mjs')));
  const {addUser} = await import(pathToFileURL(path.join(root, 'server/database.mjs')));
  const app = await createApplication({root, dataDir, origin, env:{NODE_ENV:'test'}});
  await addUser(app.db, 'startup-admin', 'test-password-1234', 'admin');
  await new Promise(resolve => app.server.listen(port, '127.0.0.1', resolve));
  const browser = await chromium.launch({...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}), headless:true});
  const errors = [];
  const context = await browser.newContext({viewport:{width:390, height:844}});
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  const ready = () => page.waitForFunction(() => document.querySelector('iframe')?.contentWindow?.WorkshopCloud?.initializing === false && document.getElementById('mode').textContent === 'Modifica condivisa');
  async function login() {
    await page.locator('#username').fill('startup-admin');
    await page.locator('#password').fill('test-password-1234');
    await page.locator('#loginForm button[type="submit"]').click();
  }
  // A reverse proxy may return HTML rather than API JSON when it is unavailable.
  const jsonUnavailable = route => route.fulfill({status:503, contentType:'application/json', body:JSON.stringify({error:{message:'VPS temporaneamente non disponibile.'}})});
  try {
    const stored = app.db.prepare('SELECT payload,revision FROM state').get();
    await page.route('**/api/state', jsonUnavailable);
    await page.goto(origin);
    await login();
    await page.waitForFunction(() => !document.getElementById('notice').hidden && document.getElementById('notice').textContent.includes('VPS temporaneamente non disponibile.'), null, {timeout:5000});
    assert.equal(await page.locator('#workspace').isVisible(), true);
    assert.equal(await page.locator('#reload').isEnabled(), true);
    assert.equal(await page.locator('#recover').isHidden(), true);
    assert.doesNotMatch(await page.locator('#frameHost').innerText(), /Caricamento archivio/);
    assert.deepEqual(app.db.prepare('SELECT payload,revision FROM state').get(), stored);
    if (process.env.STARTUP_SCREENSHOT) await page.screenshot({path:process.env.STARTUP_SCREENSHOT, fullPage:true});
    await page.unroute('**/api/state', jsonUnavailable);
    await page.locator('#reload').click();
    await ready();
    assert.deepEqual(app.db.prepare('SELECT payload,revision FROM state').get(), stored);
    console.log('PASS state failure after login is visible and retry loads the same data without another login');

    await page.route('**/api/state', route => route.fulfill({status:502, contentType:'text/html', body:'<h1>Bad Gateway</h1>'}));
    await page.reload();
    await page.waitForFunction(() => !document.getElementById('notice').hidden && document.getElementById('mode').textContent !== 'Connessione…');
    assert.match(await page.locator('#notice').innerText(), /risposta.*(?:valida|leggibile)|502/i);
    assert.equal(await page.locator('#reload').isEnabled(), true);
    await page.unroute('**/api/state');
    await page.locator('#reload').click();
    await ready();
    console.log('PASS an existing session shows proxy errors and can reconnect');

    // A fetch that never responds must stop waiting, including on browsers that
    // lack AbortSignal.timeout. The retry uses the existing authenticated session.
    await page.addInitScript(() => { Object.defineProperty(AbortSignal, 'timeout', {value:undefined, configurable:true}); });
    let stalledState;
    await page.route('**/api/state', route => { stalledState = route; });
    await page.reload();
    await page.waitForFunction(() => document.getElementById('notice').textContent.includes('entro 8 secondi'), null, {timeout:12000});
    assert.equal(await page.locator('#reload').isEnabled(), true);
    assert.equal(await page.locator('#recover').isHidden(), true);
    await page.unroute('**/api/state');
    await stalledState.abort().catch(() => {});
    await page.locator('#reload').click();
    await ready();
    assert.deepEqual(app.db.prepare('SELECT payload,revision FROM state').get(), stored);
    console.log('PASS a stalled request times out and recovers without AbortSignal.timeout');

    await page.route('**/legacy', route => route.fulfill({status:503, contentType:'text/html', body:'<h1>App unavailable</h1>'}));
    await page.reload();
    await page.waitForFunction(() => document.getElementById('mode').textContent === 'Modifiche sospese', null, {timeout:5000});
    assert.equal(await page.locator('#reload').isEnabled(), true);
    assert.match(await page.locator('#status').innerText(), /avvio|pagina/i);
    await page.unroute('**/legacy');
    await page.locator('#reload').click();
    await ready();
    assert.deepEqual(app.db.prepare('SELECT payload,revision FROM state').get(), stored);
    console.log('PASS an unavailable application frame stops loading and can be retried');

    // Hold the last startup script. A delayed successful response after the
    // deadline must not silently re-enable a frame already marked as failed.
    let delayedReady;
    await page.route('**/cloud-ready.js', route => { delayedReady = route; });
    await page.reload({waitUntil:'domcontentloaded'});
    await page.waitForFunction(() => document.getElementById('mode').textContent === 'Modifiche sospese', null, {timeout:35000});
    assert.match(await page.locator('#status').innerText(), /non ha completato l’avvio/);
    assert.equal(await page.locator('#reload').isEnabled(), true);
    await delayedReady.continue();
    await page.waitForFunction(() => document.querySelector('iframe')?.contentWindow?.WorkshopCloud?.initializing === false);
    assert.equal(await page.locator('#mode').innerText(), 'Modifiche sospese');
    assert.equal(await page.evaluate(() => WorkshopCloudHost.canWrite()), false);
    assert.deepEqual(app.db.prepare('SELECT payload,revision FROM state').get(), stored);
    await page.unroute('**/cloud-ready.js');
    await page.locator('#reload').click();
    await ready();
    console.log('PASS delayed startup is bounded and a late response cannot silently resume editing');

    // A failed archive read must retain previously saved recovery drafts, never
    // import them over the authoritative server state.
    await page.evaluate(() => sessionStorage.setItem('officina.cloud.draft.v1', JSON.stringify({protocol:2, state:document.querySelector('iframe').contentWindow.WorkshopCloud.capture(), forms:{customerName:'Bozza cliente da recuperare'}})));
    await page.route('**/api/state', jsonUnavailable);
    await page.reload();
    await page.waitForFunction(() => document.getElementById('mode').textContent === 'Connessione non completata');
    assert.equal(await page.locator('#recover').isVisible(), true);
    const downloadEvent = page.waitForEvent('download');
    await page.locator('#recover').click();
    const download = await downloadEvent;
    const draft = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
    assert.equal(draft.format, 'officina-cloud-drafts');
    assert.match(JSON.stringify(draft), /Bozza cliente da recuperare/);
    await page.unroute('**/api/state');
    await page.locator('#reload').click();
    await ready();
    const recoveredFrame = page.frames().find(frame => frame.url().includes('/legacy'));
    await recoveredFrame.locator('.nav [data-view="impostazioni"]').click();
    await recoveredFrame.locator('#settingsManagement').click();
    assert.equal(await page.locator('#cloudBar').isHidden(), true);
    assert.equal(await page.locator('#managementRecover').isVisible(), true);
    assert.deepEqual(app.db.prepare('SELECT payload,revision FROM state').get(), stored);
    console.log('PASS connection failure and retry preserve recovery drafts without changing server data');

    const expired = route => route.fulfill({status:401, contentType:'application/json', body:JSON.stringify({error:{code:'UNAUTHENTICATED', message:'Accedere per continuare.'}})});
    await page.route('**/api/state', expired);
    await page.reload();
    await page.waitForFunction(() => document.getElementById('loginError').textContent.includes('sessione è scaduta'));
    assert.equal(await page.locator('#loginPanel').isVisible(), true);
    await page.unroute('**/api/state');
    await login();
    await ready();
    console.log('PASS a session expiring during startup returns to a visible login');

    await page.route('**/api/state', jsonUnavailable);
    await page.reload();
    await page.waitForFunction(() => document.getElementById('mode').textContent === 'Connessione non completata');
    await page.unroute('**/api/state');
    await page.route('**/api/state', expired);
    await page.locator('#reload').click();
    await page.waitForFunction(() => document.getElementById('loginError').textContent.includes('sessione è scaduta'));
    assert.equal(await page.locator('#loginPanel').isVisible(), true);
    await page.unroute('**/api/state');
    await login();
    await ready();
    console.log('PASS a session expiring during retry also allows logging in again');

    assert.deepEqual(errors, []);
    assert.deepEqual(app.db.prepare('SELECT payload,revision FROM state').get(), stored);
    console.log('PASS startup works without AbortSignal.timeout and never changes the database');
  } finally { await browser.close(); await app.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
