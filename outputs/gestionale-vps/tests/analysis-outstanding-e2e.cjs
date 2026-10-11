const {selectAgenda}=require('./navigation-helpers.cjs');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {pathToFileURL}=require('node:url');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const assert=require('node:assert/strict');

(async()=>{
  const root=path.resolve(__dirname,'..'),dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'officina-analysis-outstanding-'));
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const origin='http://127.0.0.1:'+port;
  const {createApplication}=await import(pathToFileURL(path.join(root,'server/server.mjs')));
  const {addUser}=await import(pathToFileURL(path.join(root,'server/database.mjs')));
  const app=await createApplication({root,dataDir,origin,env:{NODE_ENV:'test'}});await addUser(app.db,'analysis-debt-test','test-password-1234','admin');
  await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const page=await browser.newPage({viewport:{width:1400,height:1000}}),errors=[];page.on('pageerror',error=>errors.push(error.stack));
  const frame=()=>page.frames().find(item=>item.url().endsWith('/legacy'));
  const ready=()=>page.waitForFunction(()=>document.querySelector('iframe')?.contentWindow?.WorkshopCloud?.initializing===false);
  const flush=()=>page.evaluate(()=>WorkshopCloudHost.flush());
  try {
    await page.goto(origin);await page.locator('#username').fill('analysis-debt-test');await page.locator('#password').fill('test-password-1234');await page.locator('#loginForm button[type="submit"]').click();await ready();let f=frame();
    const dates=await f.evaluate(()=>{const shift=days=>{const date=new Date(workshopToday+'T12:00:00');date.setDate(date.getDate()-days);return [date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-');};return {old:shift(45),payment:shift(35),firstOpen:shift(20),secondOpen:shift(8),today:workshopToday};});
    async function completedWork(customer,plate,date,amount,description){
      await selectAgenda(f);await f.locator('#agenda').waitFor({state:'visible'});await f.evaluate(()=>openModal('appointmentModal'));
      await f.locator('#appDate').fill(date);await f.locator('#appCustomer').fill(customer);await f.locator('#appPlate').fill(plate);await f.locator('#appTime').fill('10:00');
      await f.locator('#appCashDestination').uncheck();await f.locator('#appointmentWorkLines [data-description]').fill(description);await f.locator('#appointmentWorkLines [data-amount]').fill(String(amount));
      await f.locator('#appointmentForm button[type="submit"]').click();await flush();
      const work=f.locator('#agendaRows tr:not(.agenda-empty)').filter({hasText:plate});await work.locator('.status-select').selectOption('COMPLETATO');await flush();
      return f.evaluate(({customer,description})=>WorkshopLedgerCash.snapshot().entries.find(entry=>entry.customer===customer&&entry.work===description)?.cashId,{customer,description});
    }
    const settledId=await completedWork('DELTA','AB123AA',dates.old,40,'Diagnosi storica');
    assert.ok(settledId,'the historical work creates a cash record');
    await f.evaluate(({id,date})=>WorkshopLedgerCash.settle(id,date),{id:settledId,date:dates.payment});await flush();
    await completedWork('DELTA','CD456BB',dates.firstOpen,100,'Pneumatici posteriori');
    await completedWork('DELTA','EF789CC',dates.secondOpen,70,'Tagliando annuale');
    await completedWork('CLIENTE SENZA STORICO','GH012DD',dates.firstOpen,55,'Diagnosi centralina');
    await f.locator('.nav [data-view="analysis"]').click();await f.evaluate(()=>{showPage('analysis');renderDataAnalysis();});

    assert.equal(await f.locator('#cashOutstandingRows > .cash-customer-row').count(),2,'open work is grouped into one row per customer');
    assert.match(await f.locator('#cashOutstandingTotal').innerText(),/225,00/);
    const delta=f.locator('#cashOutstandingRows > .cash-customer-row').filter({hasText:'DELTA'});
    assert.match(await delta.innerText(),/170,00/,'total debt includes all outstanding DELTA work');
    assert.match(await delta.innerText(),/12,7 giorni/,'customer average includes the recorded payment and both open debts');
    assert.match(await delta.innerText(),/2 aperte · 1 saldata/);
    const noHistory=f.locator('#cashOutstandingRows > .cash-customer-row').filter({hasText:'CLIENTE SENZA STORICO'});
    assert.match(await noHistory.innerText(),/20 giorni/,'a customer with no previous returns still shows the age of its open debt');
    assert.match(await noHistory.innerText(),/1 aperta · 0 saldate/);
    assert.equal(await f.locator('#cashMeanDays').innerText(),'14,5 giorni','the overall average includes open and settled work');
    assert.match(await f.locator('#cashMeanDaysDetail').innerText(),/3 debiti aperti · 1 saldo registrato/);
    await f.locator('#cashMeanDays').click();
    assert.equal(await f.locator('#customerAverageDialog').evaluate(dialog=>dialog.open),true);
    assert.match(await f.locator('#customerAverageRows').innerText(),/CLIENTE SENZA STORICO[\s\S]*1[\s\S]*0[\s\S]*20 giorni/,'the average detail includes customers with open debt only');
    await f.locator('#closeCustomerAverage').click();
    const toggle=delta.locator('[data-cash-customer]'),detailId=await toggle.getAttribute('data-cash-customer');
    await toggle.click();const detail=f.locator('[data-cash-detail="'+detailId+'"]');
    assert.equal(await toggle.getAttribute('aria-expanded'),'true');assert.equal(await detail.isVisible(),true);
    assert.match(await detail.innerText(),/Pneumatici posteriori/);assert.match(await detail.innerText(),/Tagliando annuale/);
    assert.equal(await detail.locator('[data-start-return]').count(),2,'both outstanding jobs can be settled separately');
    await detail.locator('[data-start-return]').first().click();assert.equal(await f.locator('#cashReturnDialog').evaluate(dialog=>dialog.open),true);
    assert.match(await f.locator('#cashReturnSelection').innerText(),/CD456BB/);
    await f.locator('#closeCashReturn').click();
    assert.deepEqual(errors,[]);
    console.log('PASS open debts age into customer and overall settlement averages; settled waits stay fixed and work can be expanded');
  }finally{await browser.close();await new Promise(resolve=>app.server.close(resolve));app.db.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
