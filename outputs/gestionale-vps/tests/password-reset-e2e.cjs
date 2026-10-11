const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const oldPassword = 'old-password-12345';
const newPassword = 'new-password-67890';
const email = 'ios-test@example.com';

function unusedPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function removeTestData(directory) {
  const absolute = path.resolve(directory);
  const tempRoot = path.resolve(os.tmpdir()) + path.sep;
  if (!absolute.startsWith(tempRoot) || !path.basename(absolute).startsWith('officina-password-reset-e2e-')) {
    throw new Error('Rifiutata eliminazione di una cartella fuori dall’area temporanea del test.');
  }
  fs.rmSync(absolute, { recursive: true, force: true });
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'officina-password-reset-e2e-'));
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  const { createApplication } = await import(pathToFileURL(path.join(root, 'server', 'server.mjs')));
  const { addUser } = await import(pathToFileURL(path.join(root, 'server', 'database.mjs')));
  const sent = [];
  let mailArrived;
  const mail = new Promise(resolve => { mailArrived = resolve; });
  let app, browser;
  try {
    app = await createApplication({
      root, dataDir, origin, env: { NODE_ENV: 'test' },
      sendPasswordResetEmail(message) { sent.push(message); mailArrived(message); }
    });
    await addUser(app.db, 'ios-test', oldPassword, 'operator', email);
    await new Promise((resolve, reject) => app.server.listen(port, '127.0.0.1', error => error ? reject(error) : resolve()));

    // Keep a session from before the reset to verify that changing the password
    // invalidates existing devices as well as the one-time link.
    const oldLogin = await fetch(origin + '/api/login', {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'ios-test', password: oldPassword })
    });
    assert.equal(oldLogin.status, 200);
    const oldCookie = oldLogin.headers.get('set-cookie').split(';')[0];

    browser = await chromium.launch({
      headless: true,
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {})
    });
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 3,
      isMobile: true, hasTouch: true
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(origin);
    assert.equal(await page.locator('#loginForm').isVisible(), true);
    await page.getByRole('button', { name: 'Password dimenticata?' }).click();
    await page.getByLabel('Indirizzo email').fill(email);
    await page.getByRole('button', { name: 'Invia link di recupero' }).click();
    await page.getByText('Se l’indirizzo è associato a un account').waitFor();
    let mailTimeout;
    const message = await Promise.race([
      mail,
      new Promise((_, reject) => { mailTimeout = setTimeout(() => reject(new Error('Email di recupero non generata.')), 5000); })
    ]);
    clearTimeout(mailTimeout);
    assert.equal(message.to, email);
    assert.ok(message.resetUrl.startsWith(origin + '/reset-password?token='));
    const token = new URL(message.resetUrl).searchParams.get('token');
    assert.equal(sent.length, 1);

    await page.goto(message.resetUrl);
    assert.equal(page.url(), origin + '/reset-password');
    assert.equal(await page.getByRole('heading', { name: 'Scegli una nuova password' }).isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.evaluate(secret => Object.keys(localStorage).concat(Object.keys(sessionStorage)).some(key => String(localStorage.getItem(key) || sessionStorage.getItem(key)).includes(secret)), token), false);
    await page.getByLabel('Nuova password', { exact: true }).fill(newPassword);
    await page.getByLabel('Conferma nuova password').fill('other-password-123');
    await page.getByRole('button', { name: 'Cambia password' }).click();
    await page.getByText('Le password non corrispondono.').waitFor();
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM password_reset_tokens').get().n, 1);

    await page.getByLabel('Conferma nuova password').fill(newPassword);
    await page.getByRole('button', { name: 'Cambia password' }).click();
    await page.getByText('Password cambiata.').waitFor();
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM password_reset_tokens').get().n, 0);
    const oldSession = await fetch(origin + '/api/session', { headers: { Cookie: oldCookie } });
    assert.equal((await oldSession.json()).user, null);

    await page.getByRole('button', { name: "Torna all'accesso" }).click();
    await page.getByLabel('Nome utente').fill('ios-test');
    await page.getByLabel('Password', { exact: true }).fill(newPassword);
    await page.getByRole('button', { name: 'Accedi', exact: true }).click();
    await page.locator('#workspace').waitFor({ state: 'visible' });
    assert.match(await page.locator('#identity').innerText(), /ios-test/);

    await page.goto(message.resetUrl);
    await page.getByLabel('Nuova password', { exact: true }).fill('another-password-123');
    await page.getByLabel('Conferma nuova password').fill('another-password-123');
    await page.getByRole('button', { name: 'Cambia password' }).click();
    await page.getByText('Link non valido o scaduto.').waitFor();
    assert.deepEqual(pageErrors, []);
    console.log('PASS recupero password su viewport iPhone: email, link monouso, URL ripulita, sessioni invalidate e nuovo accesso');
    await context.close();
  } finally {
    if (browser) await browser.close();
    if (app) await app.close();
    removeTestData(dataDir);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
