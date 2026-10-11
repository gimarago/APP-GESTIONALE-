const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {pathToFileURL} = require('node:url');
const {randomUUID} = require('node:crypto');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const assert = require('node:assert/strict');

(async () => {
  const root = path.resolve(__dirname, '..');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'officina-expenses-'));
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const origin = 'http://127.0.0.1:' + port;
  const {createApplication} = await import(pathToFileURL(path.join(root, 'server/server.mjs')));
  const {addUser} = await import(pathToFileURL(path.join(root, 'server/database.mjs')));
  const {importPecInvoice} = await import(pathToFileURL(path.join(root, 'server/supplier-invoices.mjs')));
  const app = await createApplication({root, dataDir, origin, env:{NODE_ENV:'test'}});
  await addUser(app.db, 'expenses-operator', 'test-password-1234', 'operator');
  await addUser(app.db, 'expenses-viewer', 'test-password-1234', 'viewer');
  await new Promise(resolve => app.server.listen(port, '127.0.0.1', resolve));
  const currentDate = new Intl.DateTimeFormat('sv-SE', {timeZone:'Europe/Rome', year:'numeric', month:'2-digit', day:'2-digit'}).format(new Date());
  const year = Number(currentDate.slice(0,4));
  const login = await fetch(origin + '/api/login', {method:'POST', headers:{origin, 'Content-Type':'application/json'}, body:JSON.stringify({username:'expenses-operator', password:'test-password-1234'})});
  const session = await login.json(), cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal(login.status, 200);
  async function mutate(route, data) {
    const response = await fetch(origin + '/api/supplier-invoices' + route, {method:'POST', headers:{origin, cookie, 'X-CSRF-Token':session.csrf, 'Content-Type':'application/json'}, body:JSON.stringify(data)});
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result.item;
  }
  const create = (number, date, totalCents, supplierName = 'Ricambi test') => mutate('', {mutationId:randomUUID(), supplierName, number, issueDate:date, totalCents});
  const current = await create('OGGI-100', currentDate, 10000);
  await create('ANNO-200', (year - 1) + '-07-15', 20000);
  await create('VECCHIA-300', (year - 6) + '-07-15', 30000);
  await mutate('/' + current.id + '/payments', {mutationId:randomUUID(), amountCents:4000, paidAt:currentDate});
  for (const [sourceKey, number, documentType] of [['pending-test', 'DA-VERIFICARE', 'TD01'], ['credit-test', 'NOTA-CREDITO', 'TD04']]) {
    importPecInvoice(app.db, {sourceKey, supplierName:'PEC test', number, issueDate:currentDate, totalCents:90000, documentType, filename:'fattura.xml', originalBytes:Buffer.from('<FatturaElettronica/>')});
  }
  const browser = await chromium.launch({...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}), headless:true});
  const page = await browser.newPage({viewport:{width:1452, height:1278}}), errors = [];
  page.on('pageerror', error => errors.push(error.stack));
  const frame = () => page.frames().find(item => item.url().endsWith('/legacy'));
  const ready = () => page.waitForFunction(() => document.querySelector('iframe')?.contentWindow?.WorkshopCloud?.initializing === false);
  let f;
  const checkTotals = async (total, paid, outstanding) => {
    const text = cents => (cents / 100).toLocaleString('it-IT', {minimumFractionDigits:2, maximumFractionDigits:2});
    await f.waitForFunction(expected => document.getElementById('cashExpensesTotal').textContent.includes(expected), text(total));
    for (const prefix of ['cashExpenses', 'analysisExpenses']) {
      assert.ok((await f.locator('#' + prefix + 'Total').innerText()).includes(text(total)));
      assert.ok((await f.locator('#' + prefix + 'Paid').innerText()).includes(text(paid)));
      assert.ok((await f.locator('#' + prefix + 'Outstanding').innerText()).includes(text(outstanding)));
    }
  };
  try {
    await page.goto(origin);
    await page.locator('#username').fill('expenses-viewer');
    await page.locator('#password').fill('test-password-1234');
    await page.locator('#loginForm button[type="submit"]').click();
    await ready(); f = frame();
    await f.locator('.nav [data-view="analysis"]').click();
    assert.equal(await f.locator('#analysisIncomePeriod').inputValue(), 'year', 'work value filter defaults to this year');
    await checkTotals(10000, 4000, 6000);
    await f.waitForFunction(() => document.getElementById('cashCycleDpo')?.textContent === '0 giorni');
    assert.equal(await f.locator('#cashCycleTotal').innerText(), 'Non calcolabile', 'CCC does not invent a result when the inventory-history DIO is missing');
    assert.match(await f.locator('#cashCycleNote').innerText(), /DIO non disponibile/);
    assert.equal(await f.locator('#cashCycleDpoDetail').innerText(), '1 pagamento registrato.');
    await f.locator('#analysisIncomePeriod').selectOption('all');
    await checkTotals(60000, 4000, 56000);
    assert.equal(await f.locator('#cashReturnedTotal').count(), 0);
    assert.equal(await f.locator('#analysisExpensesRows tr').count(), 3);
    assert.match(await f.locator('#analysisExpensesNote').innerText(), /^2 documenti/);
    await f.locator('#analysisIncomePeriod').selectOption('year');
    await checkTotals(10000, 4000, 6000);
    await f.locator('#analysisIncomePeriod').selectOption('fiveYears');
    await checkTotals(30000, 4000, 26000);
    await f.locator('#analysisIncomePeriod').selectOption('custom');
    await f.locator('#analysisIncomeStart').fill(currentDate);
    await f.locator('#analysisIncomeEnd').fill(currentDate);
    await checkTotals(10000, 4000, 6000);
    await f.locator('#analysisIncomeStart').fill((year + 1) + '-01-01');
    assert.equal(await f.locator('#cashExpensesTotal').innerText(), '—');
    await f.locator('#analysisIncomeEnd').fill((year + 1) + '-01-31');
    await checkTotals(0, 0, 0);
    await f.locator('#analysisIncomeStart').fill(currentDate);
    await f.locator('#analysisIncomeEnd').fill(currentDate);
    await checkTotals(10000, 4000, 6000);
    console.log('PASS supplier expenses and paid/outstanding subtotals follow all income date filters and exclude unverified documents');

    let backgroundReloads = 0;
    const countReload = request => {
      if (new URL(request.url()).pathname === '/api/supplier-invoices') backgroundReloads++;
    };
    page.on('request', countReload);
    await f.evaluate(() => window.supplierExpensesLiveFrame = crypto.randomUUID());
    const frameMark = await f.evaluate(() => window.supplierExpensesLiveFrame);
    const remote = await create('REMOTA-50', currentDate, 5000, 'Fornitore <test>');
    await mutate('/' + remote.id + '/payments', {mutationId:randomUUID(), amountCents:2500, paidAt:currentDate});
    await f.waitForFunction(() => document.getElementById('analysisExpensesPaid').textContent.includes('65,00'));
    await checkTotals(15000, 6500, 8500);
    assert.ok(backgroundReloads > 0, 'remote invoices and payments update the active analysis');
    assert.equal(await f.evaluate(() => window.supplierExpensesLiveFrame), frameMark, 'expense updates preserve the loaded document');
    assert.equal(await f.locator('#analysisIncomePeriod').inputValue(), 'custom');
    assert.equal(await f.locator('#analysisIncomeEnd').inputValue(), currentDate);
    assert.equal(await f.evaluate(() => document.activeElement.id), 'analysisIncomeEnd', 'readonly date filter focus does not defer live expenses');
    const settledReloads = backgroundReloads;
    await page.waitForTimeout(1300);
    assert.equal(backgroundReloads, settledReloads, 'the supplier refresh settles without a request loop');
    page.off('request', countReload);
    assert.ok((await f.locator('#analysisExpensesRows').textContent()).includes('Fornitore <test>'));
    assert.equal(await f.locator('#analysisExpensesRows test').count(), 0, 'supplier names are rendered as text');
    await page.reload(); await ready(); f = frame();
    await f.locator('.nav [data-view="analysis"]').click();
    assert.equal(await f.locator('#analysisIncomePeriod').inputValue(), 'year', 'this year remains the default after reload');
    await checkTotals(15000, 6500, 8500);
    await f.locator('#analysisIncomePeriod').selectOption('all');
    await checkTotals(65000, 6500, 58500);
    console.log('PASS remote invoices and payments update the active analysis in place, retain focused date filters and settle without extra requests');

    await f.locator('#analysisExpenses details').evaluate(element => {element.open = true;});
    if (process.env.EXPENSE_SCREENSHOT_DIR) await f.locator('#analysisExpenses').screenshot({path:path.join(process.env.EXPENSE_SCREENSHOT_DIR, 'expenses-desktop.png')});
    await page.setViewportSize({width:390, height:844});
    const overflow = await f.locator('#analysisExpenses').evaluate(element => element.scrollWidth - element.clientWidth);
    assert.ok(overflow <= 1, 'expenses card fits mobile; only its table scrolls');
    const cycleOverflow = await f.locator('.cash-cycle').evaluate(element => element.scrollWidth - element.clientWidth);
    assert.ok(cycleOverflow <= 1, 'cash conversion cycle fits mobile');
    if (process.env.EXPENSE_SCREENSHOT_DIR) await f.locator('#analysisExpenses').screenshot({path:path.join(process.env.EXPENSE_SCREENSHOT_DIR, 'expenses-mobile.png')});
    let failedRequests = 0;
    await page.route('**/api/supplier-invoices', route => {
      failedRequests++;
      return route.fulfill({status:503, contentType:'application/json', body:JSON.stringify({error:{message:'Servizio temporaneamente non disponibile.'}})});
    });
    await f.locator('.nav [data-view="clienti"]').click();
    await f.waitForFunction(() => WorkshopCloud.view() === 'clienti');
    await f.locator('.nav [data-view="analysis"]').click();
    await f.locator('#analysisExpensesError').waitFor({state:'visible'});
    await checkTotals(65000, 6500, 58500);
    assert.match(await f.locator('#analysisExpensesError').innerText(), /ultimi dati disponibili/);
    const failedRemote = page.waitForResponse(response => new URL(response.url()).pathname === '/api/supplier-invoices' && response.status() === 503);
    await create('RECOVERY-20', currentDate, 2000);
    await failedRemote;
    const errorRequestCount = failedRequests;
    await page.waitForTimeout(850);
    assert.equal(failedRequests, errorRequestCount, 'failed live GETs use a backoff rather than the deferred-form retry');
    await page.unroute('**/api/supplier-invoices');
    await checkTotals(67000, 6500, 60500);
    assert.equal(await f.locator('#analysisExpensesError').isVisible(), false);
    assert.deepEqual(errors, []);
    console.log('PASS mobile layout, last known amounts on refresh failure, and automatic recovery with request backoff');
  } finally {
    await browser.close();
    await app.close();
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
