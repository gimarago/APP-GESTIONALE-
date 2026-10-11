const {selectAgenda}=require('./navigation-helpers.cjs');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {pathToFileURL} = require('node:url');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const assert = require('node:assert/strict');

async function freePort() {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}
const shift = (value, days) => { const date = new Date(value + 'T12:00:00Z'); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0,10); };

(async () => {
  const root = path.resolve(__dirname, '..'), dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'officina-week-grid-'));
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  const {createApplication} = await import(pathToFileURL(path.join(root, 'server/server.mjs')));
  const {addUser} = await import(pathToFileURL(path.join(root, 'server/database.mjs')));
  const app = await createApplication({root,dataDir,origin,env:{NODE_ENV:'test'}});
  await addUser(app.db, 'week-test', 'week-password-1234', 'admin');
  await new Promise(resolve => app.server.listen(port,'127.0.0.1',resolve));
  const browser = await chromium.launch({...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}),headless:true});
  const page = await browser.newPage({viewport:{width:1440,height:1000}}), errors = [];
  page.on('pageerror', error => errors.push(error.stack));
  const ready = () => page.waitForFunction(() => document.querySelector('iframe')?.contentWindow?.WorkshopCloud?.initializing === false);
  const frame = () => page.frames().find(item => item.url().includes('/legacy'));
  const sync = () => page.evaluate(() => WorkshopCloudHost.flush());
  const revision = () => app.db.prepare('SELECT revision FROM state').get().revision;
  let f;
  async function fill(work, date, hour) {
    await f.locator('#appDate').fill(date); await f.locator('#appTime').fill(hour);
    await f.locator('#appCustomer').fill('Cliente calendario'); await f.locator('#appPlate').fill('WK123AA');
    await f.locator('#appointmentWorkLines [data-description]').fill(work); await f.locator('#appointmentWorkLines [data-amount]').fill('25');
    await f.locator('#appointmentForm button[type=submit]').click(); await sync();
  }
  try {
    await page.goto(origin);
    await page.locator('#username').fill('week-test'); await page.locator('#password').fill('week-password-1234');
    await page.locator('#loginForm button[type=submit]').click(); await ready(); f = frame();
    await selectAgenda(f);
    const date = await f.locator('#agendaDatePicker').inputValue();
    const day = new Date(date + 'T12:00:00Z').getUTCDay(), start = shift(date,-((day+6)%7)), nextWeek = shift(start,7);
    for (const [work,dateValue,hour] of [['Lavoro esistente',start,'09:15'],['Orario serale',shift(start,1),'22:15'],['Settimana dopo',nextWeek,'11:30']]) {
      await f.evaluate(() => window.openModal('appointmentModal')); await fill(work,dateValue,hour);
    }
    await f.locator('#agendaDatePicker').fill(start); await f.locator('#agendaDatePicker').dispatchEvent('change'); await sync();
    const before = revision();
    await f.locator('#agenda [data-cloud-new-appointment]').click();
    await f.locator('#appointmentCalendarModal.open').waitFor();
    assert.equal(await f.locator('#appointmentModal.open').count(),0);
    assert.equal(await f.locator('.appointment-calendar-table thead th').count(),8);
    assert.equal(await f.locator('.appointment-calendar-table tbody tr').count(),28);
    assert.equal(await f.locator('.appointment-calendar-event').count(),1);
    assert.match(await f.locator('.appointment-calendar-event').innerText(),/09:15.*Cliente calendario[\s\S]*Lavoro esistente/);
    assert.match(await f.locator('.appointment-calendar-full-day').innerText(),/1 fuori fascia/);
    await f.locator('#appointmentCalendarFullDay').check();
    assert.equal(await f.locator('.appointment-calendar-table tbody tr').count(),48);
    assert.equal(await f.locator('.appointment-calendar-event').count(),2);
    await f.locator('#appointmentCalendarNext').click();
    assert.equal(await f.locator('.appointment-calendar-event').count(),1);
    assert.match(await f.locator('.appointment-calendar-event').innerText(),/Settimana dopo/);
    await f.locator('#appointmentCalendarPrevious').click();
    await f.locator('#appointmentCalendarDate').fill(shift(start,2)); await f.locator('#appointmentCalendarDate').dispatchEvent('change');
    await f.locator('#appointmentCalendarFullDay').uncheck();
    const slot = f.locator(`.appointment-calendar-slot[data-date="${shift(start,2)}"][data-minute="600"]`);
    await slot.click(); await sync();
    assert.equal(revision(),before,'browsing and selecting a time do not modify shared workshop data');
    await page.screenshot({path:path.join(root,'../../work/appointment-calendar-desktop.png')});
    await slot.dblclick();
    assert.equal(await f.locator('#appDate').inputValue(),shift(start,2));
    assert.equal(await f.locator('#appTime').inputValue(),'10:00');
    assert.equal(await f.locator('#appStatus').inputValue(),'PROGRAMMATO');
    assert.equal(await f.locator('#appointmentCalendarModal.open').count(),0);
    await fill('Da doppio clic',shift(start,2),'10:00');
    console.log('PASS week navigation, exact existing appointment times, full-day access and non-mutating calendar selection');

    await f.locator('#agenda [data-cloud-new-appointment]').click();
    const existing = f.locator('.appointment-calendar-event',{hasText:'Lavoro esistente'}); await existing.click();
    await f.locator('#acceptanceModal.open').waitFor();
    assert.match(await f.locator('#acceptanceMeta').innerText(),/Cliente calendario/);
    assert.equal(await f.locator('#acceptanceLines .acceptance-description').inputValue(),'Lavoro esistente');
    await f.locator('#acceptanceModal [data-cloud-close]').click();
    await f.locator('#agenda [data-cloud-new-appointment]').click();
    const keyboardSlot = f.locator(`.appointment-calendar-slot[data-date="${shift(start,2)}"][data-minute="660"]`);
    await keyboardSlot.click(); await keyboardSlot.press('ArrowRight');
    await f.locator('.appointment-calendar-slot[aria-pressed=true]').press('ArrowDown');
    await f.locator('.appointment-calendar-slot[aria-pressed=true]').press('Enter');
    assert.equal(await f.locator('#appDate').inputValue(),shift(start,3)); assert.equal(await f.locator('#appTime').inputValue(),'11:30');
    await f.locator('#appointmentModal [data-cloud-close]').click();
    console.log('PASS existing appointments open their acceptance sheet; arrow keys and Enter create a preset slot');

    await page.setViewportSize({width:390,height:844});
    await f.locator('#agenda [data-cloud-new-appointment]').click();
    const mobileSlot = f.locator(`.appointment-calendar-slot[data-date="${shift(start,4)}"][data-minute="870"]`); await mobileSlot.click();
    assert.equal(await mobileSlot.getAttribute('aria-pressed'),'true');
    assert.notEqual(await mobileSlot.evaluate(element => getComputedStyle(element).boxShadow),'none','selected phone slot has a visible highlight');
    assert.equal(await f.evaluate(() => {
      const card=document.querySelector('#appointmentCalendarModal .modal-card').getBoundingClientRect(); return card.width<=innerWidth && card.bottom<=innerHeight;
    }),true,'mobile modal stays inside viewport');
    assert.equal(await f.evaluate(() => {const scroll=document.querySelector('#appointmentCalendarScroll'); return scroll.scrollWidth>scroll.clientWidth;}),true,'week scrolls horizontally on phone');
    await page.screenshot({path:path.join(root,'../../work/appointment-calendar-mobile.png')});
    await f.locator('#appointmentCalendarBook').click();
    assert.equal(await f.locator('#appDate').inputValue(),shift(start,4)); assert.equal(await f.locator('#appTime').inputValue(),'14:30');
    await fill('Da telefono',shift(start,4),'14:30');
    await page.reload(); await ready(); f = frame(); await selectAgenda(f);
    await f.locator('#agendaDatePicker').fill(shift(start,4)); await f.locator('#agendaDatePicker').dispatchEvent('change');
    assert.equal(await f.locator('#agendaRows tr[data-acceptance-lines*="Da telefono"]').getAttribute('data-date'),shift(start,4));
    assert.match(await f.locator('#agendaRows tr[data-acceptance-lines*="Da telefono"] td:first-child').innerText(),/14:30/);
    assert.deepEqual(errors,[]);
    console.log('PASS phone tap and explicit booking action, responsive containment and shared-state reload');
  } finally {
    await browser.close(); await new Promise(resolve => app.server.close(resolve)); app.db.close();
  }
})().catch(error => {console.error(error);process.exitCode=1;});
