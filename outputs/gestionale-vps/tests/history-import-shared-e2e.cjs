const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');

async function availablePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

const frame = page => page.frames().find(candidate => candidate.url().endsWith('/legacy'));
const ready = page => page.waitForFunction(() =>
  document.querySelector('iframe')?.contentWindow?.WorkshopCloud?.initializing === false);
const money = value => Number(String(value || '0').replaceAll('.', '').replace(',', '.').replace(/[^0-9.-]/g, '')) || 0;
const pieTotal = async page => {
  const label = frame(page).locator('#analysisPie .analysis-pie-total');
  return await label.count() ? money(await label.textContent()) : 0;
};

async function login(page, origin, username) {
  await page.goto(origin);
  await page.locator('#username').fill(username);
  await page.locator('#password').fill('test-password-1234');
  await page.locator('#loginForm button[type="submit"]').click();
  await ready(page);
}

(async () => {
  const root = path.resolve(__dirname, '..');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'officina-import-shared-'));
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const { createApplication } = await import(pathToFileURL(path.join(root, 'server/server.mjs')));
  const { addUser } = await import(pathToFileURL(path.join(root, 'server/database.mjs')));
  const app = await createApplication({ root, dataDir, origin, env:{ NODE_ENV:'test' } });
  await addUser(app.db, 'import-admin', 'test-password-1234', 'admin');
  await addUser(app.db, 'import-operator', 'test-password-1234', 'operator');
  await new Promise(resolve => app.server.listen(port, '127.0.0.1', resolve));
  const browser = await chromium.launch({
    ...(process.env.CHROME_PATH ? { executablePath:process.env.CHROME_PATH } : {}), headless:true
  });
  const pageA = await (await browser.newContext()).newPage();
  const pageB = await (await browser.newContext()).newPage();
  const errors = [];
  for (const page of [pageA, pageB]) page.on('pageerror', error => errors.push(error.stack));
  try {
    await login(pageA, origin, 'import-admin');
    await login(pageB, origin, 'import-operator');

    await frame(pageB).locator('.nav [data-view="analysis"]').click();
    await frame(pageB).locator('#analysisMetricsPeriod').selectOption('all');
    const before = {
      total:await pieTotal(pageB),
      tyres:Number(await frame(pageB).locator('#analysisTyreCount').innerText()),
      revisions:Number(await frame(pageB).locator('#analysisRevisionCount').innerText())
    };
    await frame(pageB).locator('.nav [data-view="clienti"]').click();

    const todayRome = new Intl.DateTimeFormat('sv-SE', {timeZone:'Europe/Rome', year:'numeric', month:'2-digit', day:'2-digit'}).format(new Date());
    const currentYear = Number(todayRome.slice(0, 4));
    const previousDate = `${currentYear - 1}-06-15`;
    const currentDate = `${todayRome.slice(0, 7)}-01`;
    const pasted = [
      'Cliente\tTarga\tVeicolo\tTelefono\tEmail\tData intervento\tLavorazione\tImporto\tNote\tKm',
      `Cliente Importato\tAA111BB\tFiat Panda\t3330000000\tcliente@example.invalid\t${previousDate}\t4 pneumatici 205/55 R16 91V\t400,00\tVendita gomme\t20000`,
      `Cliente Importato\tAA111BB\tFiat Panda\t3330000000\tcliente@example.invalid\t${currentDate}\t2 pneumatici 205/55 R16 91V\t200,00\tVendita gomme\t26000`,
      `Cliente Importato\tCC222DD\tFiat 500\t3330000000\tcliente@example.invalid\t${currentDate}\tRevisione\t80,00\tRevisione periodica\t10000`
    ].join('\n');

    async function openImport(page) {
      const current = frame(page);
      await current.locator('.nav [data-view="impostazioni"]').click();
      await current.locator('[data-import="clients"]').click();
      await current.locator('#tableImportText').fill(pasted);
      await current.locator('#tableImportRead').click();
      return current;
    }
    const importer = await openImport(pageA);
    assert.equal(await importer.locator('#tableImportHeader').isChecked(), true);
    assert.match(await importer.locator('#tableImportStatus').innerText(), /3 righe nuove/);
    await importer.locator('#tableImportApply').click();
    assert.match(await importer.locator('#tableImportStatus').innerText(), /3 righe importate/);
    await importer.locator('#tableImportClose').click();
    await pageA.evaluate(() => WorkshopCloudHost.flush());

    const saved = JSON.parse(app.db.prepare('SELECT payload FROM state WHERE id=1').get().payload);
    const imported = JSON.parse(saved.storage['officina-table-import-v1']);
    assert.equal(imported.history.length, 3, 'all historical jobs are persisted on the server');
    assert.equal(saved.dom['#customerRows'].length, 2, 'both vehicle records are persisted on the server');

    await pageB.waitForFunction(() => {
      const window = document.querySelector('iframe')?.contentWindow;
      if (!window?.WorkshopCloud || window.WorkshopCloud.initializing) return false;
      try { return JSON.parse(window.localStorage.getItem('officina-table-import-v1') || '{}').history?.length === 3; }
      catch { return false; }
    }, null, {timeout:15000});
    const second = frame(pageB);
    assert.equal(await second.locator('#customerRows tr').count(), 2, 'second user sees both vehicles');
    assert.deepEqual((await second.locator('#customerRows tr td:nth-child(5)').allTextContents()).sort(), ['AA111BB', 'CC222DD']);
    await second.locator('.nav [data-view="clienti"]').click();
    await second.locator('#customerGroups .customer-group-history').click();
    assert.match(await second.locator('#historyContent').innerText(), /4 pneumatici 205\/55 R16 91V/);
    assert.match(await second.locator('#historyContent').innerText(), /Revisione/);
    await second.locator('#historyModal [data-cloud-close]').click();
    console.log('PASS server stores imported jobs and a second account sees both vehicles and their history');

    await second.locator('.nav [data-view="magazzino"]').click();
    await second.locator('#magazzino [data-cloud-open="stockModal"]').click();
    await second.locator('#stockProduct').fill('Scorta aggiunta dal secondo account');
    await second.locator('#stockCategory').selectOption({index:1});
    await second.locator('#stockQuantity').fill('3');
    await second.locator('#stockForm button[type="submit"]').click();
    await pageB.evaluate(() => WorkshopCloudHost.flush());
    const afterStock = JSON.parse(app.db.prepare('SELECT payload FROM state WHERE id=1').get().payload);
    assert.equal(JSON.parse(afterStock.storage['officina-table-import-v1']).history.length, 3,
      'stock changes from a second account retain the imported history');
    assert.equal(afterStock.dom['#stockRows'].length, 1);
    console.log('PASS independent stock change cannot erase another account’s imported history');

    await second.locator('.nav [data-view="dashboard"]').click();
    assert.match(await second.locator('.revenue .amount').innerText(), /280/,
      'current-month dashboard includes the current historical jobs');
    assert.match(await second.locator('#tyreSalesAmount').innerText(), /2 pneumatici/,
      'current-month tyre summary includes the imported sale');
    await second.locator('#tyreSalesSummary').click();
    await second.locator('#salesRange').selectOption('custom');
    await second.locator('#salesStartDate').fill(previousDate);
    await second.locator('#salesEndDate').fill(previousDate);
    assert.match(await second.locator('#salesDayTotal').innerText(), /4 pneumatici/);
    assert.match(await second.locator('#salesList').innerText(), /Storico importato/);
    await second.locator('#salesRange').selectOption('year');
    assert.match(await second.locator('#salesDayTotal').innerText(), /2 pneumatici/,
      'current-year tyre sales exclude the prior-year imported job');
    await second.locator('#tyreSalesModal [data-cloud-close]').click();

    await second.locator('.nav [data-view="analysis"]').click();
    await second.locator('#analysisMetricsPeriod').selectOption('all');
    assert.equal(Number(await second.locator('#analysisTyreCount').innerText()), before.tyres + 6);
    assert.equal(Number(await second.locator('#analysisRevisionCount').innerText()), before.revisions + 1);
    assert.equal(await pieTotal(pageB), before.total + 680);
    assert.match(await second.locator('#analysisTyreMeasures').innerText(), /205\/55 R16/);
    await second.locator('#analysisIncomePeriod').selectOption('year');
    assert.equal(await pieTotal(pageB), 280, 'current-year filter excludes last year’s tyre sale');
    await second.locator('#analysisIncomePeriod').selectOption('all');
    assert.equal(await pieTotal(pageB), before.total + 680);
    assert.equal(await second.evaluate(() => WorkshopLedgerCash.snapshot().entries.length), 0,
      'historical import does not invent settled cash movements');
    console.log('PASS imported work updates shared metrics and dated revenue without creating cash movements');

    await pageA.reload();
    await ready(pageA);
    await frame(pageA).locator('.nav [data-view="analysis"]').click();
    await frame(pageA).locator('#analysisMetricsPeriod').selectOption('all');
    assert.equal(await pieTotal(pageA), before.total + 680);
    assert.equal(Number(await frame(pageA).locator('#analysisTyreCount').innerText()), before.tyres + 6);
    const importerAgain = await openImport(pageA);
    assert.match(await importerAgain.locator('#tableImportStatus').innerText(), /0 righe nuove/);
    assert.equal(await importerAgain.locator('#tableImportApply').isDisabled(), true,
      'importing the same file again cannot double-count its jobs');
    await importerAgain.locator('#tableImportClose').click();
    assert.deepEqual(errors, []);
    console.log('PASS imported history survives reload and repeat import is idempotent');
  } finally {
    await browser.close();
    await app.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
