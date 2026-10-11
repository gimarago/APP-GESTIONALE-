const {selectAgenda}=require('./navigation-helpers.cjs');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {pathToFileURL}=require('node:url');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const assert=require('node:assert/strict');

(async()=>{
  const root=path.resolve(__dirname,'..'),dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'officina-analysis-money-'));
  const {createApplication}=await import(pathToFileURL(path.join(root,'server/server.mjs')));
  const {addUser}=await import(pathToFileURL(path.join(root,'server/database.mjs')));
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const origin='http://127.0.0.1:'+port;
  const app=await createApplication({root,dataDir,origin,env:{NODE_ENV:'test'}});
  await addUser(app.db,'analysis-money-test','test-password-1234','admin');
  await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const page=await browser.newPage({viewport:{width:1400,height:1100}}),errors=[];
  page.on('pageerror',error=>errors.push(error.stack));page.on('dialog',dialog=>dialog.accept());
  const frame=()=>page.frames().find(item=>item.url().endsWith('/legacy'));
  const ready=()=>page.waitForFunction(()=>document.querySelector('iframe')?.contentWindow?.WorkshopCloud?.initializing===false);
  const flush=()=>page.evaluate(()=>WorkshopCloudHost.flush());
  let f;
  const pie=id=>f.locator('#'+id+' .analysis-pie-total').textContent();
  const department=label=>f.locator('#analysisPieLegend .analysis-legend-row').filter({hasText:label}).innerText();
  try{
    await page.goto(origin);await page.locator('#username').fill('analysis-money-test');await page.locator('#password').fill('test-password-1234');
    await page.locator('#loginForm button[type="submit"]').click();await ready();f=frame();
    const today=await f.evaluate(()=>workshopToday),previous=(Number(today.slice(0,4))-1)+today.slice(4);
    let sequence=0;
    async function completedWork(description,amount,profit,date=today){
      await selectAgenda(f);await f.evaluate(()=>openModal('appointmentModal'));
      const customer='Test importi '+(++sequence);
      await f.locator('#appDate').fill(date);await f.locator('#appTime').fill('10:04');await f.locator('#appCustomer').fill(customer);await f.locator('#appPlate').fill('TEST'+sequence);
      await f.locator('#appCashDestination').uncheck();
      await f.locator('#appointmentWorkLines [data-description]').fill(description);await f.locator('#appointmentWorkLines [data-amount]').fill(String(amount));
      await f.locator('#appointmentForm button[type="submit"]').click();
      const row=f.locator('#agendaRows tr:not(.agenda-empty)').filter({hasText:customer});
      await row.evaluate(element=>window.openAcceptanceEditorForRow(element));
      await f.locator('.acceptance-amount').first().fill(String(amount));await f.locator('.acceptance-profit').first().fill(String(profit));
      await f.locator('#acceptanceForm button[type="submit"]').click();
      assert.equal(await row.evaluate(element=>JSON.parse(element.dataset.acceptanceLines)[0].amount),amount,'the saved line retains cents');
      await row.locator('.status-select').selectOption('COMPLETATO');await flush();
      const snapshot=await f.evaluate(customer=>{const e=WorkshopLedgerCash.snapshot().entries.find(e=>e.customer===customer);return {amount:e.amount,profit:e.state.profit};},customer);
      assert.equal(snapshot.amount,amount);assert.equal(snapshot.profit,profit);
    }
    async function analysis(){await f.locator('.nav [data-view="analysis"]').click();await f.evaluate(()=>{showPage('analysis');renderDataAnalysis();});}
    await completedWork('coppa olio',100.75,10.25);
    await completedWork('Diagnosi storica',50.25,5.15,previous);
    await analysis();
    assert.equal(await pie('analysisPie'),'€ 100,75','the reported 100.75 case is not multiplied by 100');
    assert.equal(await pie('analysisComparePie'),'€ 50,25','the comparison also keeps its cents');
    assert.match(await department('Interventi meccanica'),/€ 100,75/);
    assert.match(await department('Tagliandi'),/€ 0,00/,'coppa olio is mechanical');
    await f.locator('#analysisChartToggle').click();assert.equal(await pie('analysisPie'),'€ 10,25');assert.equal(await pie('analysisComparePie'),'€ 5,15');
    await f.locator('#analysisChartToggle').click();
    await completedWork('filtro abitacolo',25.5,2.5);
    await completedWork('4,5 litri olio 5W30',70.25,7.25);
    await completedWork('pompa olio',30.1,-1.35);
    await completedWork('4L 5-30 LL',60.5,6.25);
    await analysis();
    assert.equal(await pie('analysisPie'),'€ 287,10');
    assert.match(await department('Interventi meccanica'),/€ 130,85/);assert.match(await department('Tagliandi'),/€ 156,25/);
    await f.locator('#analysisTrendPeriod').selectOption('year');
    const monthTotal=await f.locator('#analysisTrendContent .analysis-period-bar').evaluateAll(rows=>rows.reduce((sum,row)=>sum+Number(row.dataset.amount),0));
    assert.equal(Math.round(monthTotal*100),28710,'monthly rankings use the same decimal total');
    await f.locator('#analysisChartToggle').click();assert.equal(await pie('analysisPie'),'€ 24,90','signed decimal profits are aggregated correctly');
    await flush();await page.reload();await ready();f=frame();await analysis();
    assert.equal(await pie('analysisPie'),'€ 287,10');assert.match(await department('Tagliandi'),/€ 156,25/);
    assert.equal(await f.locator('.cash-cycle').evaluate(element=>!element.closest('.cash-summary')&&element===document.querySelector('#analysis .analysis-dashboard').lastElementChild),true,'CCC stays separate at the bottom');
    assert.deepEqual(errors,[]);
    console.log('PASS decimal work values, comparison, profits and monthly totals survive saving/reload; oil parts and servicing use their proper departments');
  }finally{await browser.close();await app.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
