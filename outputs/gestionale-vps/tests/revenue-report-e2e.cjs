const {selectAgenda}=require('./navigation-helpers.cjs');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {pathToFileURL} = require('node:url');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const root = path.resolve(__dirname, '..');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'officina-revenue-report-'));
  const {createApplication} = await import(pathToFileURL(path.join(root, 'server/server.mjs')));
  const {addUser} = await import(pathToFileURL(path.join(root, 'server/database.mjs')));
  const app = await createApplication({root, dataDir, origin:'http://127.0.0.1:8151', env:{NODE_ENV:'test'}});
  await addUser(app.db, 'revenue-test', 'test-password-1234', 'admin');
  await new Promise(resolve => app.server.listen(8151, '127.0.0.1', resolve));
  const browser = await chromium.launch({
    ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}), headless:true
  });
  const page = await browser.newPage({viewport:{width:1452, height:1278}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.stack));
  page.on('dialog', dialog => dialog.accept());
  const frame = () => page.frames().find(item => item.url().endsWith('/legacy'));
  const ready = () => page.waitForFunction(() => {
    const cloud = document.querySelector('iframe')?.contentWindow?.WorkshopCloud;
    return cloud && !cloud.initializing;
  });
  const flush = async () => {for(let attempt=0;attempt<30;attempt++){try{return await page.evaluate(() => WorkshopCloudHost.flush());}catch(error){if(!error.message.includes('Attendi il salvataggio in corso.')||attempt===29)throw error;await new Promise(resolve=>setTimeout(resolve,100));}}};
  const money = value => Number(value.replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.'));
  const total = async f => money(await f.locator('#incomeTotal').innerText());
  const checkLayout = async f => {
    const metrics = await f.evaluate(() => {
      const card = document.querySelector('#revenueModal .modal-card');
      const controls = [...document.querySelectorAll('#incomePeriod,.compare-control,.compare-picker,#compareStart,#compareEnd,#compareResult')]
        .filter(element => getComputedStyle(element).display !== 'none')
        .map(element => ({left:element.getBoundingClientRect().left, right:element.getBoundingClientRect().right}));
      const rect = card.getBoundingClientRect();
      return {overflow:card.scrollWidth - card.clientWidth, cardLeft:rect.left, cardRight:rect.right, controls};
    });
    assert.ok(metrics.overflow <= 1, 'the report has no horizontal overflow');
    assert.ok(metrics.controls.every(item => item.left >= metrics.cardLeft - 1 && item.right <= metrics.cardRight + 1), 'all comparison controls remain inside the report');
  };
  try {
    await page.goto('http://127.0.0.1:8151');
    await page.locator('#username').fill('revenue-test');
    await page.locator('#password').fill('test-password-1234');
    await page.locator('#loginForm button[type="submit"]').click();
    await ready();
    let f = frame();
    await selectAgenda(f);
    await f.locator('#agenda').waitFor({state:'visible'}); await f.evaluate(() => { document.getElementById('appDate').value = localCreationDate(); openModal('appointmentModal'); });
    await f.locator('#appCustomer').fill('Cliente riepilogo');
    await f.locator('#appPlate').fill('RR123AA');
    await f.locator('#appointmentWorkLines [data-description]').fill('Diagnosi motore');
    await f.locator('#appointmentWorkLines [data-amount]').fill('640');
    await f.locator('#appointmentForm button[type="submit"]').click();
    await f.locator('#agendaRows tr:not(.agenda-empty) .status-select').first().selectOption('COMPLETATO');
    await flush();
    const dates = await f.evaluate(() => {
      const current = new Date(), older = new Date();
      older.setDate(older.getDate() - 8);
      const iso = date => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
      return {today:iso(current), older:iso(older)};
    });
    await f.locator('#agenda').waitFor({state:'visible'}); await f.evaluate(() => { document.getElementById('appDate').value = localCreationDate(); openModal('appointmentModal'); });
    await f.locator('#appDate').fill(dates.older);
    await f.locator('#appCustomer').fill('Cliente precedente');
    await f.locator('#appPlate').fill('RR456BB');
    await f.locator('#appointmentWorkLines [data-description]').fill('Revisione');
    await f.locator('#appointmentWorkLines [data-amount]').fill('200');
    await f.locator('#appointmentForm button[type="submit"]').click();
    await f.locator('#agendaRows tr:not(.agenda-empty)').filter({hasText:'Cliente precedente'}).locator('.status-select').selectOption('COMPLETATO');
    await flush();
    await f.locator('#vehicleRevisionModal').waitFor({state:'visible'});await f.locator('#vehicleRevisionRows [data-plate="RR456BB"]').selectOption('ordinary');await f.locator('#vehicleRevisionSave').click();await f.locator('#vehicleRevisionModal').waitFor({state:'hidden'});await flush();
    await selectAgenda(f,'parking');await f.locator('.parking-head [data-cloud-open="parkingModal"]').click();
    await f.locator('#parkCustomer').fill('Cliente parcheggio');
    await f.locator('#parkPlate').fill('RR789CC');
    await f.locator('#parkVehicle').fill('Fiat Panda');
    await f.locator('#parkEntry').fill(dates.older);
    await f.locator('#parkWork').fill('Diagnosi centralina');
    await f.locator('#parkWorkAmount').fill('120');
    await f.locator('#parkStatus').selectOption('IN LAVORAZIONE');
    await f.locator('#parkingForm button[type="submit"]').click();
    await f.locator('.parking-row .parking-status').first().selectOption('COMPLETATO');
    await flush();
    await selectAgenda(f);await f.locator('#agenda').waitFor({state:'visible'});await f.evaluate(() => {document.getElementById('appDate').value=localCreationDate();openModal('appointmentModal');});
    await f.locator('#appCustomer').fill('Cliente gomme e servizi');await f.locator('#appPlate').fill('RR321DD');
    const sectorLines=[['2 pneumatici 205/55 R16 91V Michelin','241.50'],['Equilibratura pneumatici','35.25'],['Tagliando','80.75']];
    for(let index=0;index<sectorLines.length;index++){
      if(index)await f.locator('#appointmentForm button',{hasText:'+ Aggiungi lavorazione'}).click();
      const line=f.locator('#appointmentWorkLines .appointment-work-line').nth(index);await line.locator('[data-description]').fill(sectorLines[index][0]);await line.locator('[data-amount]').fill(sectorLines[index][1]);
    }
    await f.locator('#appointmentForm button[type="submit"]').click();await f.locator('#agendaRows tr:not(.agenda-empty)').filter({hasText:'Cliente gomme e servizi'}).locator('.status-select').selectOption('COMPLETATO');await flush();
    await page.reload();
    await ready();
    f = frame();
    const expected = {
      day:1117.5,
      week:1117.5,
      month:1117.5 + (dates.today.slice(0, 7) === dates.older.slice(0, 7) ? 200 : 0),
      year:1117.5 + (dates.today.slice(0, 4) === dates.older.slice(0, 4) ? 200 : 0)
    };
    const computed = await f.evaluate(() => Object.fromEntries(['day','week','month','year'].map(name => [name, WorkshopRevenue.reportFor(name).total])));
    assert.deepEqual(computed, expected, 'periods include only work completed within their dates');
    await f.locator('.nav [data-view="dashboard"]').click();
    await f.locator('.revenue').click();
    for (const name of ['day', 'week', 'month', 'year']) {
      await f.locator('#incomePeriod').selectOption(name);
      assert.equal(await total(f), expected[name], `${name} total is visible with cents`);
      assert.ok(await f.locator('#incomeChart rect').count() > 0, `${name} chart uses recorded work`);
      const sectors=await f.evaluate(()=>WorkshopRevenue.reportFor(document.getElementById('incomePeriod').value).values);
      assert.equal(sectors.pneumatici,276.75,'tyres and their services share the same department');assert.equal(sectors.tagliandi,80.75,'Tagliandi retain their own classifier department');assert.equal(sectors.meccanica,760);assert.equal(sectors.servizi,undefined,'the retired generic service department cannot split the tyre sector');
      const rows=await f.locator('#incomeRows tr').evaluateAll(rows=>rows.map(row=>[row.cells[0].textContent.trim(),row.cells[1].textContent]));
      assert.equal(rows.filter(([label])=>label==='Pneumatici e servizi').length,1);assert.equal(money(rows.find(([label])=>label==='Pneumatici e servizi')[1]),276.75);assert.equal(money(rows.find(([label])=>label==='Tagliandi')[1]),80.75);
      const segments=await f.locator('#incomeChart rect').evaluateAll(rectangles=>rectangles.map(rect=>({department:rect.dataset.department,value:Number(rect.dataset.value),title:rect.querySelector('title').textContent,color:getComputedStyle(rect).fill})));
      assert.equal(segments.reduce((sum,segment)=>sum+segment.value,0),expected[name],`${name} chart segments equal the visible table total`);assert.equal(segments.filter(segment=>segment.department==='pneumatici').reduce((sum,segment)=>sum+segment.value,0),276.75);assert.ok(segments.filter(segment=>segment.department==='pneumatici').every(segment=>segment.title.includes('Pneumatici e servizi')));
      const legend=await f.locator('#revenueModal .income-legend span').evaluateAll(entries=>entries.map(entry=>({label:entry.textContent.trim(),color:getComputedStyle(entry.querySelector('i')).backgroundColor})));
      assert.deepEqual(legend.map(entry=>entry.label),['Interventi meccanica','Pneumatici e servizi','Tagliandi','Revisioni','Car Rent']);assert.ok(segments.filter(segment=>segment.department==='pneumatici').every(segment=>segment.color===legend.find(entry=>entry.label==='Pneumatici e servizi').color),'the unified legend colour matches the tyre-and-services graph segment');
    }
    await f.locator('#comparePeriod').check();
    await f.locator('#compareSelector').selectOption('custom');
    await f.locator('#compareStart').fill(dates.today);
    await f.locator('#compareEnd').fill(dates.today);
    assert.equal(money((await f.locator('#compareResult').innerText()).split('·')[0]),1117.5,'comparison preserves the unified sector totals and cents');
    await checkLayout(f);
    if (process.env.REVENUE_SCREENSHOT_DIR) await f.locator('#revenueModal .modal-card').screenshot({path:path.join(process.env.REVENUE_SCREENSHOT_DIR, 'revenue-desktop.png')});
    await page.setViewportSize({width:390, height:844});
    await checkLayout(f);
    if (process.env.REVENUE_SCREENSHOT_DIR) await f.locator('#revenueModal .modal-card').screenshot({path:path.join(process.env.REVENUE_SCREENSHOT_DIR, 'revenue-mobile.png')});
    console.log('PASS day, week, month, year and comparison show recorded revenue without overflowing');

    await page.setViewportSize({width:1280, height:800});
    await f.locator('#revenueModal [data-cloud-close="revenueModal"]').click();
    await f.locator('.nav [data-view="libroContabile"]').click();
    await f.locator('#ledgerDatePicker').fill(dates.today);
    await f.locator('#ledgerDatePicker').dispatchEvent('change');
    const reopen = f.locator('#ledgerRows tr').filter({hasText:'Cliente riepilogo'}).locator('.ledger-reopen');
    await reopen.click();
    assert.equal(await f.locator('.nav [data-view="libroContabile"]').getAttribute('class').then(value => value.includes('active')), true, 'cashbook stays selected');
    assert.notEqual(await f.locator('#libroContabile').evaluate(element => getComputedStyle(element).display), 'none', 'cashbook remains visible');
    await flush();
    assert.equal(await f.evaluate(() => WorkshopRevenue.reportFor('day').total), 477.5, 'reopened job no longer counts as completed revenue');
    assert.deepEqual(errors, [], 'browser errors');
    console.log('PASS Da svolgere updates the work while keeping the cashbook open');
  } finally {
    await browser.close();
    await new Promise(resolve => app.server.close(resolve));
    app.db.close();
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
