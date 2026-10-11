const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {pathToFileURL} = require('node:url');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const assert = require('node:assert/strict');
const {selectAgenda} = require('./navigation-helpers.cjs');

async function port() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}

(async () => {
  const root = path.resolve(__dirname, '..');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'officina-revision-categories-'));
  const origin = 'http://127.0.0.1:' + await port();
  const {createApplication} = await import(pathToFileURL(path.join(root, 'server/server.mjs')));
  const {addUser} = await import(pathToFileURL(path.join(root, 'server/database.mjs')));
  const app = await createApplication({root, dataDir, origin, env:{NODE_ENV:'test'}});
  await addUser(app.db, 'revision-admin', 'test-password-1234', 'admin');
  await addUser(app.db, 'revision-viewer', 'test-password-1234', 'viewer');
  await new Promise(resolve => app.server.listen(Number(new URL(origin).port), '127.0.0.1', resolve));
  const browser = await chromium.launch({...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}), headless:true});
  const errors = [];
  const page = await browser.newPage({viewport:{width:1200,height:1000}});
  page.on('pageerror', error => errors.push(error.stack));
  const frame = target => target.frames().find(item => item.url().includes('/legacy'));
  const ready = target => target.waitForFunction(() => document.querySelector('iframe')?.contentWindow?.WorkshopCloud?.initializing === false);
  const flush = target => target.evaluate(() => WorkshopCloudHost.flush());
  const payload = () => JSON.parse(app.db.prepare('SELECT payload FROM state').get().payload);
  const customerRows = () => payload().dom['#customerRows'];
  async function login(target, username) {
    await target.goto(origin);
    await target.locator('#username').fill(username);
    await target.locator('#password').fill('test-password-1234');
    await target.locator('#loginForm button[type="submit"]').click();
    await ready(target);
  }
  let f;
  const schedule = () => f.evaluate(() => WorkshopRevisionReminders.automaticDates());
  async function customer(plate, category = 'ordinary', additional = false) {
    await f.locator('.nav [data-view="clienti"]').click();
    if (additional) await f.evaluate(() => openAdditionalVehicle('Cliente flotta'));
    else {
      await f.locator('#clienti [data-cloud-open="customerModal"]').click();
      await f.locator('#customerName').fill('Cliente flotta');
    }
    await f.locator('#customerVehicle').fill('Fiat Panda');
    await f.locator('#customerPlate').fill(plate);
    assert.equal(await f.locator('#customerRevisionCategory').inputValue(), '', 'each new vehicle starts with an empty revision interval');
    await f.locator('#customerRevisionCategory').selectOption(category);
    await f.locator('#customerForm button[type="submit"]').click();
    await flush(page);
  }
  async function revision(plate, date, work = 'Revisione periodica') {
    await selectAgenda(f);
    await f.evaluate(() => openNewAcceptance());
    await f.locator('#appPlate').fill(plate);
    await f.locator('#appDate').fill(date);
    await f.locator('#appTime').fill('09:30');
    await f.locator('#appKm').fill('150000');
    await f.locator('#appointmentWorkLines [data-description]').fill(work);
    await f.locator('#appointmentWorkLines [data-amount]').fill('79');
    await f.locator('#appointmentForm button[type="submit"]').click();
    await flush(page);
    const row = f.locator('#agendaRows tr').filter({has:f.locator('.work-input')}).filter({hasText:plate});
    const selected = await f.evaluate(({plate,work}) => {
      const row = [...document.querySelectorAll('#agendaRows tr')].find(row => row.cells[2]?.textContent.includes(plate) && row.cells[3]?.querySelector('.work-input')?.value === work);
      return row?.dataset.cloudId;
    }, {plate,work});
    assert.ok(selected);
    await f.locator('#agendaDatePicker').fill(date);
    await f.locator('#agendaDatePicker').dispatchEvent('change');
    await f.locator(`#agendaRows [data-cloud-id="${selected}"] .status-select`).selectOption('COMPLETATO');
    await flush(page);
    return selected;
  }
  async function categories(plate = '') {
    await f.locator('.nav [data-view="clienti"]').click();
    await f.evaluate(plate => openCustomerHistory('Cliente flotta', 'Fiat Panda', plate), plate);
    await f.locator('#openVehicleRevisions').click();
  }
  async function appointment(plate, work, name = 'Cliente flotta') {
    f = await selectAgenda(f);
    await f.evaluate(() => openNewAcceptance());
    await f.locator('#appCustomer').fill(name);
    if (await f.locator('#vehicleSelectionModal').isVisible()) await f.locator('#vehicleSelectionList .vehicle-choice').filter({hasText:plate}).click();
    await f.locator('#appPlate').fill(plate);
    await f.locator('#appDate').fill(await f.evaluate(() => localCreationDate()));
    await f.locator('#appTime').fill('10:30');
    await f.locator('#appointmentWorkLines [data-description]').fill(work);
    await f.locator('#appointmentWorkLines [data-amount]').fill('79');
  }
  async function savedAppointment(plate, work, name = 'Cliente flotta') {
    await appointment(plate, work, name);
    await f.locator('#appointmentForm button[type="submit"]').click();
    await flush(page);
    return f.evaluate(({plate,work}) => [...document.querySelectorAll('#agendaRows tr')].find(row => row.cells[2]?.textContent.includes(plate) && row.cells[3]?.querySelector('.work-input')?.value === work)?.dataset.cloudId, {plate,work});
  }
  async function prompt(plate) {
    await f.locator('#vehicleRevisionModal').waitFor({state:'visible'});
    assert.equal(await f.locator('#vehicleRevisionCategory-' + plate).inputValue(), '');
    assert.equal(await f.locator('#appointmentModal').isVisible(), false, 'the revision dialog opens after saving instead of interrupting the work form');
    assert.equal(await f.locator('#acceptanceModal').isVisible(), false);
    assert.equal(await f.locator('#parkingModal').isVisible(), false);
  }
  async function noPrompt() {
    await flush(page);
    await page.waitForTimeout(450);
    assert.equal(await f.locator('#vehicleRevisionModal').isVisible(), false);
  }
  async function closePrompt() {
    await f.locator('#vehicleRevisionClose').click();
    assert.equal(await f.locator('#historyModal').isVisible(), false, 'automatic prompt closing returns to work rather than customer history');
  }
  async function savePrompt(plate, category) {
    await f.locator('#vehicleRevisionCategory-' + plate).selectOption(category);
    await f.locator('#vehicleRevisionSave').click();
    await f.locator('#vehicleRevisionModal').waitFor({state:'hidden'});
    await flush(page);
    assert.equal(await f.locator('#historyModal').isVisible(), false);
    assert.equal(customerRows().find(row => JSON.stringify(row.c).includes(plate)).a['data-revision-category'], category);
  }
  async function parking(plate, work) {
    f = await selectAgenda(f, 'parking');
    await f.locator('.parking-head [data-cloud-open="parkingModal"]').click();
    await f.locator('#parkCustomer').fill('Cliente flotta');
    if (await f.locator('#vehicleSelectionModal').isVisible()) await f.locator('#vehicleSelectionList .vehicle-choice').filter({hasText:plate}).click();
    await f.locator('#parkPlate').fill(plate);
    await f.locator('#parkVehicle').fill('Fiat Panda');
    await f.locator('#parkEntry').fill(await f.evaluate(() => localCreationDate()));
    await f.locator('#parkWork').fill(work);
    await f.locator('#parkWorkAmount').fill('79');
  }
  try {
    await login(page, 'revision-admin');
    f = frame(page);
    await f.waitForFunction(() => !!window.WorkshopVehicleRevisions);
    await customer('AA101AA');
    await customer('BB202BB', 'taxi', true);
    await customer('CC303CC', 'ncc', true);
    await customer('DD404DD', 'annual', true);
    assert.equal(customerRows().find(row => JSON.stringify(row.c).includes('AA101AA')).a['data-revision-category'], 'ordinary', 'ordinary interval is explicitly persisted instead of inferred from a missing attribute');
    assert.equal(customerRows().find(row => JSON.stringify(row.c).includes('BB202BB')).a['data-revision-category'], 'taxi');
    assert.equal(customerRows().find(row => JSON.stringify(row.c).includes('CC303CC')).a['data-revision-category'], 'ncc');
    const oldDate = '2025-10-04';
    const ordinaryRevision = await revision('AA101AA', oldDate);
    await revision('BB202BB', oldDate);
    await revision('CC303CC', oldDate);
    let dates = await schedule();
    assert.equal(dates.dates.AA101AA, '2027-10-31');
    assert.equal(dates.dates.BB202BB, '2026-10-31');
    assert.equal(dates.dates.CC303CC, '2026-10-31');
    assert.equal(dates.dates.DD404DD, undefined, 'a category alone does not fabricate an inspection');
    console.log('PASS ordinary, Taxi and NCC vehicle categories persist on distinct plates and mileage does not contaminate matching');

    await categories();
    assert.equal(await f.locator('#vehicleRevisionRows select').count(), 4);
    if (process.env.REVISION_SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.REVISION_SCREENSHOT_DIR, {recursive:true});
      await page.screenshot({path:path.join(process.env.REVISION_SCREENSHOT_DIR, 'revision-categories-desktop.png')});
    }
    await f.locator('#vehicleRevisionCategory-AA101AA').selectOption('annual');
    assert.match(await f.locator('.vehicle-revision-item').filter({hasText:'AA101AA'}).innerText(), /31\/10\/2026/);
    assert.equal((await schedule()).dates.AA101AA, '2027-10-31', 'unsaved selections do not change authoritative reminders');
    await f.locator('#vehicleRevisionClose').click();
    await f.locator('#historyModal [data-cloud-close]').click();
    await categories('AA101AA');
    assert.equal(await f.locator('#vehicleRevisionRows select').count(), 1);
    await f.locator('#vehicleRevisionCategory-AA101AA').selectOption('taxi');
    await f.locator('#vehicleRevisionSave').click();
    await f.locator('#vehicleRevisionModal').waitFor({state:'hidden'});
    await f.locator('#historyModal [data-cloud-close]').click();
    assert.equal((await schedule()).dates.AA101AA, '2026-10-31');
    assert.equal((await schedule()).dates.BB202BB, '2026-10-31');
    assert.equal(customerRows().find(row => JSON.stringify(row.c).includes('AA101AA')).a['data-revision-category'], 'taxi');
    console.log('PASS existing vehicles edit independently; cancellation leaves categories unchanged; preview uses end-of-month dates');

    await f.evaluate(() => {
      localStorage.setItem('officina-table-import-v1', JSON.stringify({history:[
        {customer:'Cliente flotta',plate:'DD404DD',vehicle:'Fiat Panda',date:'2024-02-29',work:'rev.',amount:79},
        {customer:'Cliente flotta',plate:'DD404DD',vehicle:'Fiat Panda',date:'2025-02-29',work:'Revisione',amount:79},
        {customer:'Cliente flotta',plate:'EE505EE',date:'2025-01-01',work:'Tagliando',amount:120}
      ]}));
      document.dispatchEvent(new CustomEvent('workshop:history-imported'));
    });
    await flush(page);
    assert.equal((await schedule()).dates.DD404DD, '2025-02-28', 'valid imported revision contributes, invalid dates do not');
    const original = payload().storage['officina.revisionReminders.v1'];
    await categories();
    await f.locator('#vehicleRevisionClose').click();
    await f.locator('#historyModal [data-cloud-close]').click();
    await flush(page);
    assert.equal(payload().storage['officina.revisionReminders.v1'], original, 'category viewing preserves existing recall config');
    await page.reload();
    await ready(page);
    f = frame(page);
    assert.equal((await schedule()).dates.AA101AA, '2026-10-31');
    assert.equal((await schedule()).dates.DD404DD, '2025-02-28');
    console.log('PASS imported history, strict date validation and categories survive server reload without rewriting reminder settings');

    // Archive metadata remains a revision source when its completed source row
    // is removed; a live reopened job takes precedence over archived metadata.
    await f.evaluate(id => document.querySelector(`#agendaRows [data-cloud-id="${id}"]`).remove(), ordinaryRevision);
    await flush(page);
    assert.equal((await schedule()).latest.AA101AA, oldDate);
    const current = await f.evaluate(() => localCreationDate());
    const renewed = await revision('BB202BB', current, 'Nuova revisione periodica');
    const expected = await f.evaluate(date => WorkshopRevisionSchedule.deadline(date, 'taxi'), current);
    assert.equal((await schedule()).dates.BB202BB, expected);
    await f.locator(`#agendaRows [data-cloud-id="${renewed}"] .status-select`).selectOption('IN LAVORAZIONE');
    await flush(page);
    assert.equal((await schedule()).latest.BB202BB, oldDate, 'reopened latest revision no longer extends the deadline');
    console.log('PASS archived completed revisions remain available; completing and reopening a newer revision adjusts the correct plate');

    const second = await browser.newPage();
    second.on('pageerror', error => errors.push(error.stack));
    await login(second, 'revision-admin');
    await categories('CC303CC');
    await f.locator('#vehicleRevisionCategory-CC303CC').selectOption('ordinary');
    await f.locator('#vehicleRevisionSave').click();
    await f.locator('#vehicleRevisionModal').waitFor({state:'hidden'});
    await f.locator('#historyModal [data-cloud-close]').click();
    const secondInitial = await frame(second).evaluate(() => WorkshopRevisionReminders.automaticDates().dates.CC303CC);
    assert.equal(secondInitial, '2026-10-31', 'another user is not automatically refreshed while on the same page');
    await frame(second).locator('.nav [data-view="clienti"]').click();
    await second.waitForFunction(() => document.querySelector('iframe')?.contentWindow?.WorkshopRevisionReminders?.automaticDates().dates.CC303CC === '2027-10-31');
    await second.close();
    console.log('PASS categories synchronize to another user on section change without automatic page refresh');

    await page.setViewportSize({width:390,height:844});
    await categories('DD404DD');
    assert.equal(await f.locator('#vehicleRevisionModal .modal-card').evaluate(element => element.scrollWidth <= element.clientWidth), true);
    if (process.env.REVISION_SCREENSHOT_DIR) await page.screenshot({path:path.join(process.env.REVISION_SCREENSHOT_DIR, 'revision-categories-mobile.png')});
    await f.locator('#vehicleRevisionClose').click();
    await f.locator('#historyModal [data-cloud-close]').click();

    await page.setViewportSize({width:1200,height:1000});
    await customer('EE606EE', '', true);
    assert.equal(customerRows().find(row => JSON.stringify(row.c).includes('EE606EE')).a['data-revision-category'], undefined);
    assert.equal((await schedule()).dates.EE606EE, undefined);
    await categories('EE606EE');
    assert.equal(await f.locator('#vehicleRevisionCategory-EE606EE').inputValue(), '');
    await f.locator('#vehicleRevisionClose').click();
    await f.locator('#historyModal [data-cloud-close]').click();
    await appointment('EE606EE', 'rev. ministeriale');
    assert.equal(await f.locator('#vehicleRevisionModal').isVisible(), false, 'typing a revision does not interrupt an unsaved appointment');
    await f.locator('#appointmentForm [data-cloud-close="appointmentModal"]').click();
    await noPrompt();
    const blankRevision = await savedAppointment('EE606EE', 'Rev. ministeriale');
    assert.ok(blankRevision);
    await prompt('EE606EE');
    if (process.env.REVISION_SCREENSHOT_DIR) await page.screenshot({path:path.join(process.env.REVISION_SCREENSHOT_DIR, 'revision-blank-prompt-desktop.png')});
    assert.equal((await schedule()).dates.EE606EE, undefined, 'saving uncompleted work does not invent an inspection deadline');
    await closePrompt();
    assert.equal(customerRows().find(row => JSON.stringify(row.c).includes('EE606EE')).a['data-revision-category'], undefined, 'closing the prompt leaves the interval unconfigured');
    await f.evaluate(id => openAcceptanceEditorForRow(document.querySelector(`#agendaRows [data-cloud-id="${id}"]`)), blankRevision);
    await f.locator('#acceptanceForm button[type="submit"]').click();
    await flush(page);
    await prompt('EE606EE');
    await closePrompt();
    await page.reload();
    await ready(page);
    f = frame(page);
    await noPrompt();
    f = await selectAgenda(f);
    await f.evaluate(id => openAcceptanceEditorForRow(document.querySelector(`#agendaRows [data-cloud-id="${id}"]`)), blankRevision);
    await f.locator('.acceptance-description').first().fill('REVIS. periodica');
    assert.equal(await f.locator('#vehicleRevisionModal').isVisible(), false);
    await f.locator('#acceptanceForm button[type="submit"]').click();
    await flush(page);
    await prompt('EE606EE');
    await savePrompt('EE606EE', 'ordinary');
    await savedAppointment('EE606EE', 'Revisione successiva');
    await noPrompt();
    await f.locator(`#agendaRows [data-cloud-id="${blankRevision}"] .status-select`).selectOption('COMPLETATO');
    await noPrompt();
    const currentDate = await f.evaluate(() => localCreationDate());
    assert.equal((await schedule()).dates.EE606EE, await f.evaluate(date => WorkshopRevisionSchedule.deadline(date, 'ordinary'), currentDate));
    console.log('PASS blank intervals, appointment save and edit abbreviation prompts, cancellation, ordinary persistence and configured suppression');

    await customer('FF707FF', '', true);
    await page.setViewportSize({width:390,height:844});
    await parking('FF707FF', 'Revis. periodica');
    assert.equal(await f.locator('#vehicleRevisionModal').isVisible(), false);
    await f.locator('#parkingForm button[type="submit"]').click();
    await flush(page);
    await prompt('FF707FF');
    assert.equal(await f.locator('#vehicleRevisionModal .modal-card').evaluate(element => element.scrollWidth <= element.clientWidth), true);
    if (process.env.REVISION_SCREENSHOT_DIR) await page.screenshot({path:path.join(process.env.REVISION_SCREENSHOT_DIR, 'revision-blank-prompt-mobile.png')});
    await closePrompt();
    await page.setViewportSize({width:1200,height:1000});
    assert.equal(await f.locator('#agenda').getAttribute('data-agenda-view'), 'parking');
    await f.evaluate(() => openParkingEditor([...document.querySelectorAll('.parking-row')].find(row => parkingDataFromRow(row).plate === 'FF707FF')));
    await f.locator('#parkingForm button[type="submit"]').click();
    await flush(page);
    await prompt('FF707FF');
    await closePrompt();
    await f.evaluate(() => openParkingEditor([...document.querySelectorAll('.parking-row')].find(row => parkingDataFromRow(row).plate === 'FF707FF')));
    await f.locator('#parkWork').fill('REV. periodica');
    await f.locator('#parkingForm button[type="submit"]').click();
    await flush(page);
    await prompt('FF707FF');
    await savePrompt('FF707FF', 'annual');
    const parkingRow = f.locator('.parking-row').filter({hasText:'FF707FF'});
    await parkingRow.locator('.parking-status').selectOption('COMPLETATO');
    await noPrompt();
    assert.equal((await schedule()).dates.FF707FF, await f.evaluate(date => WorkshopRevisionSchedule.deadline(date, 'annual'), currentDate));
    console.log('PASS parking create and edit trigger the interval dialog after successful revision saves and respect saved annual intervals');

    await customer('GG808GG', '', true);
    const unrelated = await savedAppointment('GG808GG', 'Preventivo per parte reversibile e controllo revisore');
    await noPrompt();
    await f.evaluate(id => openAcceptanceEditorForRow(document.querySelector(`#agendaRows [data-cloud-id="${id}"]`)), unrelated);
    await f.locator('.acceptance-description').first().fill('Revisione periodica');
    await f.locator('#acceptanceForm [data-cloud-close="acceptanceModal"]').click();
    await noPrompt();
    await categories('GG808GG');
    await f.locator('#vehicleRevisionCategory-GG808GG').selectOption('ordinary');
    await f.locator('#vehicleRevisionSave').click();
    await f.locator('#vehicleRevisionModal').waitFor({state:'hidden'});
    await f.locator('#historyModal [data-cloud-close]').click();
    await flush(page);
    assert.equal(customerRows().find(row => JSON.stringify(row.c).includes('GG808GG')).a['data-revision-category'], 'ordinary');
    assert.equal((await schedule()).dates.GG808GG, undefined);
    await customer('HH909HH', '', true);
    await parking('HH909HH', 'rev.');
    await f.locator('#parkingForm [data-cloud-close="parkingModal"]').click();
    await noPrompt();
    const unconfiguredCompleted = await savedAppointment('HH909HH', 'Revisione periodica');
    await prompt('HH909HH');
    await closePrompt();
    await f.locator(`#agendaRows [data-cloud-id="${unconfiguredCompleted}"] .status-select`).selectOption('COMPLETATO');
    await flush(page);
    await prompt('HH909HH');
    assert.equal((await schedule()).latest.HH909HH, currentDate);
    assert.equal((await schedule()).dates.HH909HH, undefined, 'a completed revision remains without a deadline until its interval is selected');
    await closePrompt();
    await page.reload();
    await ready(page);
    f = frame(page);
    await noPrompt();
    assert.equal(customerRows().find(row => JSON.stringify(row.c).includes('EE606EE')).a['data-revision-category'], 'ordinary');
    assert.equal(customerRows().find(row => JSON.stringify(row.c).includes('HH909HH')).a['data-revision-category'], undefined);
    console.log('PASS unrelated words, canceled work edits and parking forms do not prompt; manual selection and blank intervals survive reload without hydration dialogs');

    assert.equal(customerRows().some(row => JSON.stringify(row.c).includes('II101II')), false);
    const newlyCreated = await savedAppointment('II101II', 'rev. periodica', 'Nuovo cliente revisione');
    assert.ok(newlyCreated);
    await prompt('II101II');
    const createdVehicle = customerRows().find(row => JSON.stringify(row.c).includes('II101II'));
    assert.ok(createdVehicle, 'saving the work creates the missing vehicle before the prompt');
    assert.equal(createdVehicle.a['data-revision-category'], undefined);
    await closePrompt();
    console.log('PASS new vehicles created from the appointment are initially blank and receive the revision interval prompt after creation');

    const viewer = await browser.newPage({viewport:{width:390,height:844}});
    viewer.on('pageerror', error => errors.push(error.stack));
    await login(viewer, 'revision-viewer');
    const vf = frame(viewer);
    assert.equal(await vf.locator('#vehicleRevisionModal').isVisible(), false, 'read-only hydration does not trigger the interval prompt');
    await vf.locator('.nav [data-view="clienti"]').click();
    await vf.evaluate(() => openCustomerHistory('Cliente flotta', 'Fiat Panda', 'DD404DD'));
    await vf.locator('#openVehicleRevisions').click();
    assert.equal(await vf.locator('#vehicleRevisionCategory-DD404DD').isDisabled(), true);
    assert.equal(await vf.locator('#vehicleRevisionSave').isVisible(), false);
    await vf.locator('#vehicleRevisionClose').click();
    await vf.locator('#historyModal [data-cloud-close]').click();
    await vf.evaluate(() => openCustomerHistory('Cliente flotta', 'Fiat Panda', 'HH909HH'));
    await vf.locator('#openVehicleRevisions').click();
    assert.equal(await vf.locator('#vehicleRevisionCategory-HH909HH').inputValue(), '');
    assert.equal(await vf.locator('#vehicleRevisionCategory-HH909HH').isDisabled(), true);
    await vf.locator('#vehicleRevisionClose').click();
    await vf.locator('#historyModal [data-cloud-close]').click();
    await viewer.close();
    assert.deepEqual(errors, []);
    console.log('PASS mobile layout and viewer access expose read-only vehicle deadlines without authorizing edits');
  } catch (error) {
    console.error({errors:errors.slice(0,5), errorCount:errors.length, status:await page.locator('#status').textContent().catch(() => ''), categoryError:await f?.locator('#vehicleRevisionError').textContent().catch(() => '')});
    throw error;
  } finally {
    await browser.close();
    await app.close();
    fs.rmSync(dataDir, {recursive:true, force:true});
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
