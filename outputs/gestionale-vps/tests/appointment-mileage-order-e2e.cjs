const {selectAgenda}=require('./navigation-helpers.cjs');
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'officina-appointment-mileage-'));
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const {createApplication} = await import(pathToFileURL(path.join(root, 'server/server.mjs')));
  const {addUser} = await import(pathToFileURL(path.join(root, 'server/database.mjs')));
  const app = await createApplication({root, dataDir, origin, env:{NODE_ENV:'test'}});
  await addUser(app.db, 'mileage-test', 'test-password-1234', 'admin');
  await new Promise(resolve => app.server.listen(port, '127.0.0.1', resolve));
  const browser = await chromium.launch({...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}), headless:true});
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.stack));
  const ready = () => page.waitForFunction(() => document.querySelector('iframe')?.contentWindow?.WorkshopCloud?.initializing === false);
  const frame = () => page.frames().find(item => item.url().includes('/legacy'));
  const sync = () => page.evaluate(() => WorkshopCloudHost.flush());
  const payload = () => JSON.parse(app.db.prepare('SELECT payload FROM state').get().payload);
  let f;
  const row = work => f.locator(`#agendaRows tr[data-acceptance-lines*="${work}"]`);
  const stockQuantity = () => f.evaluate(() => document.querySelector('#stockRows tr:not(.empty-filter)')?.dataset.quantity);
  const visibleTimes = () => f.locator('#agendaRows tr:not(.agenda-empty):visible td:first-child').allTextContents();
  async function create({time, work, km, amount, date, intervention = false, preview = false}) {
    if (intervention) await f.locator('header [data-cloud-accept]').first().click();
    else { await f.locator('#agenda').waitFor({state:'visible'}); await f.evaluate(() => window.openModal('appointmentModal')); }
    await f.locator('#appDate').fill(date);
    await f.locator('#appTime').fill(time);
    await f.locator('#appCustomer').fill('Cliente chilometri');
    await f.locator('#appPlate').fill('KM123AA');
    await f.locator('#appVehicle').fill('Fiat Panda');
    if (km !== undefined) await f.locator('#appKm').fill(km);
    await f.locator('#appointmentWorkLines [data-description]').fill(work);
    await f.locator('#appointmentWorkLines [data-amount]').fill(String(amount));
    if (preview) {
      await f.locator('#appointmentForm button', {hasText:'Stampa scheda'}).click();
      assert.match(await f.locator('#workshopPrintPaper').innerText(), /Chilometraggio\s+123500/);
      await f.evaluate(() => {
        const generate = window.WorkshopSheetPDF;
        window.WorkshopSheetPDF = (data, declaration) => {
          window.lastPrintedAppointment = data;
          return generate(data, declaration);
        };
      });
      const downloadPromise = page.waitForEvent('download');
      await f.locator('#workshopPrintToolbar button', {hasText:'Scarica PDF'}).click();
      const download = await downloadPromise;
      assert.equal(await download.failure(), null);
      assert.equal(await f.evaluate(() => window.lastPrintedAppointment.fields.Chilometraggio), '123500');
      await f.locator('#workshopPrintClose').click();
    }
    await f.locator('#appointmentForm button[type="submit"]').click();
    try {
      await f.waitForFunction(work => [...document.querySelectorAll('#agendaRows tr')].some(row => JSON.parse(row.dataset.acceptanceLines || '[]').some(line => line.description === work)), work);
    } catch (error) {
      console.error('Appointment capture diagnostic', {work, errors, status:await page.locator('#status').textContent(), agenda:await f.locator('#agendaRows').innerHTML(), form:await f.evaluate(() => [...document.querySelectorAll('#appointmentForm input')].map(input => ({id:input.id,value:input.value,valid:input.checkValidity(),message:input.validationMessage}))) });
      throw error;
    }
    await sync();
  }
  try {
    await page.goto(origin);
    await page.locator('#username').fill('mileage-test');
    await page.locator('#password').fill('test-password-1234');
    await page.locator('#loginForm button[type="submit"]').click();
    await ready();
    f = frame();
    const today = await f.locator('#appDate').inputValue();
    const tomorrow = new Date(today + 'T12:00:00Z');
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const nextDate = tomorrow.toISOString().slice(0,10);
    await f.locator('.nav [data-view="magazzino"]').click();
    await f.locator('#magazzino [data-cloud-open="stockModal"]').click();
    await f.locator('#stockProduct').fill('205/55 R16 91V Michelin');
    await f.locator('#stockCategory').selectOption('Pneumatici estivi');
    await f.locator('#stockQuantity').fill('12');
    await f.locator('#stockForm button[type="submit"]').click();
    await sync();
    await selectAgenda(f);
    await create({time:'14:30', work:'Lavoro tardo', km:'100000', amount:145.70, date:today});
    await create({time:'09:05', work:'2 205/55 R16 91V Michelin', km:'123500', amount:55.25, date:today, intervention:true, preview:true});
    await create({time:'09:05', work:'Lavoro zero', km:'0', amount:75.50, date:today});
    await create({time:'10:00', work:'Lavoro senza chilometri', amount:25, date:today});
    await create({time:'08:00', work:'Lavoro domani', km:'150000', amount:95, date:nextDate});
    await f.locator('#agendaDatePicker').fill(today);
    await f.locator('#agendaDatePicker').dispatchEvent('change');
    assert.deepEqual((await visibleTimes()).map(time => time.trim()), ['09:05', '09:05', '10:00', '14:30']);
    for (const [work, amount, km] of [['Lavoro tardo','145,70','100000'], ['2 205/55 R16 91V Michelin','55,25','123500'], ['Lavoro zero','75,50','0'], ['Lavoro senza chilometri','25,00',''], ['Lavoro domani','95,00','150000']]) {
      assert.match(await row(work).locator('.amount-input').inputValue(), new RegExp(amount));
      assert.equal(await row(work).getAttribute('data-km'), km);
    }
    assert.equal(await row('Lavoro zero').locator('td:nth-child(3)').getAttribute('data-mileage'), '0 km');
    assert.equal(await stockQuantity(), '12', 'new appointments and sorting do not change stock');
    console.log('PASS new interventions and appointments preserve mileage and distinct totals while sorting earlier and same-time rows');

    const tyreRow = row('2 205/55 R16 91V Michelin');
    await tyreRow.locator('.status-select').selectOption('COMPLETATO');
    await row('Lavoro zero').locator('.status-select').selectOption('COMPLETATO');
    await sync();
    const completedQuantity = await stockQuantity();
    assert.equal(completedQuantity, '10');
    await tyreRow.evaluate(element => openAcceptanceEditorForRow(element));
    assert.equal(await f.locator('#acceptanceKm').inputValue(), '123500');
    await f.locator('#acceptanceKm').fill('124000');
    await f.locator('#acceptanceForm button', {hasText:'Stampa scheda'}).click();
    assert.match(await f.locator('#workshopPrintPaper').innerText(), /Chilometraggio\s+124000/);
    await f.locator('#workshopPrintClose').click();
    await f.locator('#acceptanceForm button[type="submit"]').click();
    await sync();
    assert.equal(await stockQuantity(), completedQuantity, 'editing mileage on a completed intervention does not deduct stock twice');
    assert.equal(payload().dom['#agendaRows'].find(node => node.a?.['data-km'] === '124000').a['data-date'], today);
    await row('Lavoro senza chilometri').evaluate(element => openAcceptanceEditorForRow(element));
    assert.equal(await f.locator('#acceptanceKm').inputValue(), '', 'missing mileage remains unknown');
    await f.locator('#acceptanceForm [data-cloud-close]').click();
    await f.locator('.nav [data-view="clienti"]').click();
    await f.locator('#customerGroups .customer-group-history').click();
    assert.match(await f.locator('#historyContent').innerText(), /124\.000 km/);
    assert.match(await f.locator('#historyContent').innerText(), /0 km/);
    await f.locator('#historyModal [data-cloud-close]').click();
    console.log('PASS completed intervention mileage can be edited and appears in print and customer history, with zero and unknown handled separately');

    // Serve an older, unsorted snapshot to exercise actual shared-state hydration.
    let hydratedUnsorted = false;
    await page.route('**/api/state', async route => {
      const response = await route.fetch();
      const snapshot = await response.json();
      snapshot.state.dom['#agendaRows'].reverse();
      hydratedUnsorted = true;
      await route.fulfill({response, json:snapshot});
    }, {times:1});
    await page.reload();
    await ready();
    assert.equal(hydratedUnsorted, true);
    f = frame();
    await selectAgenda(f);
    assert.deepEqual((await visibleTimes()).map(time => time.trim()), ['09:05', '09:05', '10:00', '14:30']);
    assert.equal(await row('2 205/55 R16 91V Michelin').getAttribute('data-km'), '124000');
    assert.equal(await row('Lavoro zero').getAttribute('data-km'), '0');
    assert.equal(await row('Lavoro senza chilometri').getAttribute('data-km'), '');
    assert.equal(await stockQuantity(), completedQuantity);
    await row('2 205/55 R16 91V Michelin').evaluate(element => openAcceptanceEditorForRow(element));
    assert.equal(await f.locator('#acceptanceKm').inputValue(), '124000');
    await f.locator('#acceptanceForm [data-cloud-close]').click();
    await f.locator('#nextAgendaDay').click();
    assert.deepEqual((await visibleTimes()).map(time => time.trim()), ['08:00']);
    assert.equal(await row('Lavoro domani').getAttribute('data-date'), nextDate);
    assert.deepEqual(errors, []);
    console.log('PASS mileage, totals, stock quantities and ascending time order survive shared-state reload and day changes');
  } finally {
    await browser.close();
    await new Promise(resolve => app.server.close(resolve));
    app.db.close();
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
