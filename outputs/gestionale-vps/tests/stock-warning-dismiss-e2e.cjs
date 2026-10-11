'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {pathToFileURL}=require('node:url');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');

// Use an isolated archive and ephemeral port; never connect to the user's preview.
(async()=>{
  const root=path.resolve(__dirname,'..'),dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'officina-dismiss-warnings-'));
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const origin=`http://127.0.0.1:${port}`;
  const {createApplication}=await import(pathToFileURL(path.join(root,'server/server.mjs')));
  const {addUser}=await import(pathToFileURL(path.join(root,'server/database.mjs')));
  const app=await createApplication({root,dataDir,origin,env:{NODE_ENV:'test'}});
  await addUser(app.db,'warning-admin','test-password-1234','admin');await addUser(app.db,'warning-viewer','test-password-1234','viewer');
  await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));
  const browser=await chromium.launch({...process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{},headless:true});
  const errors=[];
  const ready=page=>page.waitForFunction(()=>document.querySelector('iframe')?.contentWindow?.WorkshopCloud?.initializing===false&&!WorkshopCloudHost.synchronizing());
  const frame=page=>page.frames().find(item=>item.url().includes('/legacy'));
  const saved=()=>app.db.prepare('SELECT revision,payload FROM state WHERE id=1').get();
  async function login(name,viewport={width:1280,height:760}){
    const context=await browser.newContext({viewport}),page=await context.newPage();
    page.on('pageerror',error=>errors.push(error.stack));page.on('dialog',dialog=>dialog.accept());
    await page.goto(origin);await page.locator('#username').fill(name);await page.locator('#password').fill('test-password-1234');await page.locator('#loginForm button[type="submit"]').click();await ready(page);return page;
  }
  async function navigate(page,view){await frame(page).locator(`.nav [data-view="${view}"]`).click();await ready(page);}
  let counter=0;
  async function addWork(page,customer,work,parking=false){
    const f=frame(page);await navigate(page,parking?'parking':'agenda');
    if(parking){await f.locator('.parking-head [data-cloud-open="parkingModal"]').click();await f.locator('#parkCustomer').fill(customer);await f.locator('#parkPlate').fill('WA999AA');await f.locator('#parkVehicle').fill('Auto prova');await f.locator('#parkWork').fill(work);await f.locator('#parkWorkAmount').fill('50');await f.locator('#parkingForm button[type="submit"]').click();}
    else{await f.evaluate(()=>openNewAcceptance());await f.locator('#appTime').fill('10:'+String(counter++).padStart(2,'0'));await f.locator('#appCustomer').fill(customer);await f.locator('#appPlate').fill('WA'+String(counter).padStart(3,'0')+'AA');await f.locator('#appVehicle').fill('Auto prova');await f.locator('#appointmentWorkLines [data-description]').fill(work);await f.locator('#appointmentWorkLines [data-amount]').fill('50');await f.locator('#appointmentForm button[type="submit"]').click();}
    await page.evaluate(()=>WorkshopCloudHost.flush());await ready(page);
  }
  try{
    const page=await login('warning-admin');
    await addWork(page,'Cliente uno','2 155/65/14 75T FALKEN AS');await addWork(page,'Cliente due','2 175/65/14 82T FALKEN 4S');
    let f=frame(page),items=f.locator('.stock-warning-item');assert.equal(await items.count(),2);
    const before=saved(),capture=await f.evaluate(()=>WorkshopCloud.capture());
    await items.filter({hasText:'Cliente uno'}).locator('button').click();assert.equal(await items.count(),1);assert.match(await items.innerText(),/Cliente due/);
    await f.evaluate(()=>{updateStockWarnings();updateStockWarnings();});assert.equal(await items.count(),1);
    assert.deepEqual(await f.evaluate(()=>WorkshopCloud.capture()),capture,'dismissal does not change stock, work or finance records');
    await page.waitForTimeout(1400);assert.deepEqual(saved(),before,'dismissal does not cause any server mutation');
    await navigate(page,'parking');await navigate(page,'agenda');assert.equal(await frame(page).locator('.stock-warning-item').count(),1);
    await page.reload();await ready(page);await navigate(page,'agenda');f=frame(page);assert.equal(await f.locator('.stock-warning-item').count(),1);
    console.log('PASS individual warnings stay dismissed through rerender, navigation and reload, without shared mutations');

    const row=f.locator('#agendaRows tr:not(.agenda-empty)').filter({hasText:'Cliente uno'});
    await row.evaluate(element=>openAcceptanceEditorForRow(element));await f.locator('.acceptance-description').first().fill('2 155/65/14 75T FALKEN invernali');await f.locator('#acceptanceForm button[type="submit"]').click();await page.evaluate(()=>WorkshopCloudHost.flush());
    assert.equal(await f.locator('.stock-warning-item').count(),2);assert.match(await f.locator('.stock-warning-item').filter({hasText:'Cliente uno'}).innerText(),/invernali/);
    await addWork(page,'Cliente parcheggio','2 185/65/14 86T FALKEN AS',true);f=frame(page);assert.equal(await f.locator('.stock-warning-item').count(),1);
    await f.locator('.stock-warning-dismiss').click();assert.equal(await f.locator('.agenda-stock-warning').isVisible(),false);
    await f.evaluate(()=>updateStockWarnings());assert.equal(await f.locator('.agenda-stock-warning').isVisible(),false);
    await navigate(page,'agenda');assert.equal(await f.locator('.stock-warning-item').count(),2);
    console.log('PASS changed warnings reappear and parking warnings can be dismissed separately');

    const viewer=await login('warning-viewer',{width:390,height:844});await navigate(viewer,'agenda');const vf=frame(viewer);assert.equal(await vf.locator('.stock-warning-item').count(),2,'dismissal is per account/tab');
    const mobileButton=vf.locator('.stock-warning-dismiss').first(),box=await mobileButton.boundingBox();assert.ok(box.width>=32&&box.height>=32);
    const warningBox=await vf.locator('.agenda-stock-warning').boundingBox();assert.ok(box.x+box.width<=warningBox.x+warningBox.width+1,'close control remains inside its warning on mobile');
    const readerBefore=saved();await mobileButton.press('Enter');assert.equal(await vf.locator('.stock-warning-item').count(),1);await viewer.waitForTimeout(1000);assert.deepEqual(saved(),readerBefore);
    assert.match(await vf.locator('.stock-warning-dismiss').getAttribute('aria-label'),/^Nascondi avviso:/);
    assert.deepEqual(errors,[]);console.log('PASS mobile and read-only users dismiss safely with keyboard and accessible labels');
  }finally{await browser.close();await app.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
