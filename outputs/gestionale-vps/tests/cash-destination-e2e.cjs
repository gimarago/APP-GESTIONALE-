const {selectAgenda}=require('./navigation-helpers.cjs');
const {pathToFileURL}=require('node:url');
const path=require('node:path'),fs=require('node:fs'),os=require('node:os'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
  const root=path.resolve(__dirname,'..'),dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'officina-cash-destination-'));
  const {createApplication}=await import(pathToFileURL(path.join(root,'server/server.mjs')));
  const {addUser}=await import(pathToFileURL(path.join(root,'server/database.mjs')));
  const origin='http://127.0.0.1:8171';
  const app=await createApplication({root,dataDir,origin,env:{NODE_ENV:'test'}});
  await addUser(app.db,'cash-test','test-password-1234','admin');
  await new Promise(resolve=>app.server.listen(8171,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.stack));page.on('dialog',dialog=>dialog.accept());
  const frame=()=>page.frames().find(f=>f.url().includes('/legacy'));
  const ready=()=>page.waitForFunction(()=>document.querySelector('iframe')?.contentWindow?.WorkshopCloud&&!document.querySelector('iframe').contentWindow.WorkshopCloud.initializing);
  const sync=()=>page.evaluate(()=>WorkshopCloudHost.flush());
  const balances=async(name)=>frame().evaluate(name=>{const e=WorkshopLedgerCash.snapshot().entries.find(e=>e.customer===name);return e&&{id:e.cashId,amount:e.amount,inCash:e.state.inCash,outside:e.state.outside};},name);
  const accounts=()=>JSON.parse(JSON.parse(app.db.prepare('SELECT payload FROM state').get().payload).storage['ma-gomme-cashbook-v1']);
  const row= (f,name)=>f.locator('#agendaRows tr:not(.agenda-empty)').filter({has:f.locator('td:nth-child(2)',{hasText:name})});
  async function appointment(name,amount,outside=false){
    const f=frame();await selectAgenda(f);
    await f.locator('#agenda').waitFor({state:'visible'});
    await f.evaluate(()=>{openModal('appointmentModal');document.getElementById('appDate').value=new Date().toLocaleDateString('en-CA');});
    await f.locator('#appCustomer').fill(name);await f.locator('#appPlate').fill(name==='Cliente fuori'?'FC123AA':'IC123AA');
    await f.locator('#appointmentWorkLines [data-description]').fill('Diagnosi');await f.locator('#appointmentWorkLines [data-amount]').fill(String(amount));
    await f.locator('#appTime').fill('10:00');
    if(outside) await f.locator('#appCashDestination').uncheck();
    await f.locator('#appointmentForm button[type="submit"]').click();
    await sync();return row(f,name);
  }
  async function parked(name,amount,outside=false,status='IN LAVORAZIONE'){
    const f=frame();await selectAgenda(f,'parking');await f.locator('.parking-head [data-cloud-open="parkingModal"]').click();
    await f.locator('#parkCustomer').fill(name);await f.locator('#parkPlate').fill(name==='Parcheggio fuori'?'PF123AA':'PI123AA');
    await f.locator('#parkVehicle').fill('Fiat Panda');await f.locator('#parkWork').fill('Diagnosi centralina');
    await f.locator('#parkWorkAmount').fill(String(amount));await f.locator('#parkWorkProfit').fill('5');
    if(outside)await f.locator('#parkCashDestination').uncheck();await f.locator('#parkStatus').selectOption(status);
    await f.locator('#parkingForm button[type="submit"]').click();await sync();
    return f.locator('.parking-row').filter({has:f.locator('div:first-child b',{hasText:name})});
  }
  try{
    await page.goto(origin);await page.locator('#username').fill('cash-test');await page.locator('#password').fill('test-password-1234');
    await page.locator('#loginForm button[type="submit"]').click();await ready();let f=frame();
    await selectAgenda(f);
    let outside=await appointment('Cliente fuori',100.75,true);
    assert.equal(await outside.locator('.cash-destination-input').isChecked(),false);
    assert.equal(await balances('Cliente fuori'),undefined,'scheduled job has no cash entry');
    assert.deepEqual(await f.locator('#agendaRows').evaluate(el=>[...el.closest('table').querySelectorAll('thead th')].slice(4,8).map(th=>th.textContent.trim().toUpperCase())),['IMPORTO','ACCONTO','CASSA','STATO']);
    await outside.locator('.status-select').selectOption('COMPLETATO');await sync();
    const outsideBalance=await balances('Cliente fuori');assert.deepEqual({...outsideBalance,id:undefined},{id:undefined,amount:100.75,inCash:0,outside:100.75});
    assert.equal(await outside.locator('.cash-destination-input').isDisabled(),true);
    assert.match(await outside.locator('.cash-destination-reason').innerText(),/libro contabile/);
    await outside.locator('.status-select').selectOption('IN LAVORAZIONE');await sync();assert.equal(await balances('Cliente fuori'),undefined);
    assert.equal(await outside.locator('.cash-destination-input').isDisabled(),false,'reopening unlocks the residual destination');
    await outside.locator('.status-select').selectOption('COMPLETATO');await sync();assert.deepEqual(await balances('Cliente fuori'),outsideBalance);
    assert.equal(accounts().accounts.filter(a=>a.meta.customer==='Cliente fuori').length,1);
    console.log('PASS outside appointment is booked once and reopening preserves allocation');

    let inside=await appointment('Cliente cassa',20.25);
    await inside.locator('.status-select').selectOption('COMPLETATO');await sync();
    const initial=await balances('Cliente cassa');assert.equal(initial.inCash,20.25);assert.equal(initial.outside,0);
    await f.locator('.nav [data-view="libroContabile"]').click();
    const split=f.locator('#ledgerRows tr').filter({has:f.locator('td:nth-child(2)',{hasText:'Cliente cassa'})});
    await split.locator('[data-ledger-field="inCash"]').fill('7,15');await split.locator('[data-ledger-field="inCash"]').press('Tab');await sync();
    assert.deepEqual(await balances('Cliente cassa'),{id:initial.id,amount:20.25,inCash:7.15,outside:13.1});
    await selectAgenda(f);inside=row(f,'Cliente cassa');
    await f.waitForFunction(()=>[...document.querySelectorAll('#agendaRows tr')].find(r=>r.cells[1]?.textContent==='Cliente cassa')?.querySelector('.cash-destination-label')?.textContent==='Ripartito');
    assert.equal(await inside.locator('.cash-destination-input').isDisabled(),true);
    await inside.locator('.status-select').selectOption('IN LAVORAZIONE');await inside.locator('.status-select').selectOption('COMPLETATO');await sync();
    assert.deepEqual(await balances('Cliente cassa'),{id:initial.id,amount:20.25,inCash:7.15,outside:13.1});
    await f.evaluate(id=>WorkshopLedgerCash.settle(id,new Date().toLocaleDateString('en-CA')),initial.id);await sync();
    const payment=accounts().payments.find(p=>p.accountId===initial.id);assert.equal(payment.cents,1310);
    await inside.locator('.status-select').selectOption('IN LAVORAZIONE');await sync();
    await inside.locator('.status-select').selectOption('COMPLETATO');await sync();
    assert.equal(accounts().payments.filter(p=>p.accountId===initial.id).length,1);assert.equal(accounts().payments.find(p=>p.accountId===initial.id).cents,1310);
    assert.equal((await balances('Cliente cassa')).inCash,7.15);assert.equal((await balances('Cliente cassa')).outside,0);
    console.log('PASS existing decimal split and later payment survive reopening without duplicate payments');

    let pOutside=await parked('Parcheggio fuori',50.35,true,'COMPLETATO');
    assert.deepEqual({...await balances('Parcheggio fuori'),id:undefined},{id:undefined,amount:50.35,inCash:0,outside:50.35});
    assert.equal(await pOutside.locator('.cash-destination-input').isDisabled(),true);
    let pInside=await parked('Parcheggio cassa',12.45);
    await pInside.locator('.cash-destination-input').uncheck();await sync();
    await pInside.locator('.cash-destination-input').check();await pInside.locator('.parking-status').selectOption('COMPLETATO');await sync();
    assert.equal((await balances('Parcheggio cassa')).inCash,12.45);assert.equal((await balances('Parcheggio cassa')).outside,0);
    await pOutside.locator('.parking-status').selectOption('IN LAVORAZIONE');await sync();await pOutside.locator('.parking-status').selectOption('COMPLETATO');await sync();
    assert.equal(accounts().accounts.filter(a=>a.meta.customer==='Parcheggio fuori').length,1);
    assert.equal((await balances('Parcheggio fuori')).outside,50.35);
    console.log('PASS both parking destinations, immediate completion and reopening preserve existing records');

    await page.reload();await ready();f=frame();await selectAgenda(f);
    outside=row(f,'Cliente fuori');inside=row(f,'Cliente cassa');
    assert.equal(await outside.locator('.cash-destination-input').isChecked(),false);assert.equal(await outside.locator('.cash-destination-input').isDisabled(),true);
    assert.equal(await outside.locator('.cash-destination-cell').count(),1);
    assert.equal((await balances('Cliente fuori')).outside,100.75);
    assert.equal((await balances('Cliente cassa')).inCash,7.15);assert.equal((await balances('Cliente cassa')).outside,0);
    assert.equal((await balances('Parcheggio fuori')).outside,50.35);assert.equal((await balances('Parcheggio cassa')).inCash,12.45);
    assert.equal(accounts().accounts.length,4);assert.equal(accounts().payments.length,1);assert.deepEqual(errors,[]);
    console.log('PASS cash destinations, bookings, original payments and one column per row survive server reload');
    const screenshots=path.resolve(root,'../../work');fs.mkdirSync(screenshots,{recursive:true});
    await page.setViewportSize({width:1569,height:1252});await page.screenshot({path:path.join(screenshots,'cash-destination-desktop.png')});
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(screenshots,'cash-destination-mobile.png')});
  }finally{await browser.close();await new Promise(resolve=>app.server.close(resolve));app.db.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
