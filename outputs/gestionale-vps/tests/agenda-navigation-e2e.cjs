'use strict';
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {pathToFileURL}=require('node:url');
const path=require('node:path'),fs=require('node:fs'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict');
const {selectAgenda}=require('./navigation-helpers.cjs');

(async()=>{
  const root=path.resolve(__dirname,'..'),dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'officina-agenda-navigation-'));
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const origin=`http://127.0.0.1:${port}`;
  const {createApplication}=await import(pathToFileURL(path.join(root,'server/server.mjs')));
  const {addUser}=await import(pathToFileURL(path.join(root,'server/database.mjs')));
  const app=await createApplication({root,dataDir,origin,env:{NODE_ENV:'test'}});
  await addUser(app.db,'navigation-test','test-password-1234','admin');
  await addUser(app.db,'navigation-viewer','test-password-1234','viewer');
  await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const errors=[];
  const frame=page=>page.frames().find(item=>item.url().includes('/legacy'));
  const ready=page=>page.waitForFunction(()=>document.querySelector('iframe')?.contentWindow?.WorkshopCloud?.initializing===false);
  const sync=page=>page.evaluate(()=>WorkshopCloudHost.flush());
  const revision=()=>app.db.prepare('SELECT revision FROM state').get().revision;
  async function login(username,viewport={width:1366,height:900}){
    const context=await browser.newContext({viewport}),page=await context.newPage();page.on('pageerror',error=>errors.push(error.stack));
    await page.goto(origin);await page.locator('#username').fill(username);await page.locator('#password').fill('test-password-1234');await page.locator('#loginForm button[type="submit"]').click();await ready(page);return page;
  }
  async function parked(page,name,plate){
    const f=await selectAgenda(frame(page),'parking');
    await f.locator('.parking-head [data-cloud-open="parkingModal"]').click();
    await f.locator('#parkCustomer').fill(name);await f.locator('#parkPlate').fill(plate);await f.locator('#parkVehicle').fill('Fiat Panda');
    await f.locator('#parkWork').fill('Diagnosi');await f.locator('#parkWorkAmount').fill('35');await f.locator('#parkingForm button[type="submit"]').click();await sync(page);
  }
  try{
    const a=await login('navigation-test'),b=await login('navigation-test');let f=frame(a);
    const initialRevision=revision();
    assert.equal(await f.locator('#agendaMenuToggle, #agendaSubmenu, #agendaNavGroup').count(),0,'calendar and parking no longer have a dropdown');
    assert.equal(await f.locator('.nav > button[data-view="agenda"]').count(),1);
    assert.equal(await f.locator('.nav > button[data-view="parking"]').count(),1);
    assert.equal(await f.locator('.nav [data-view="agenda"] .nav-chevron').count(),0);
    assert.equal(await f.locator('.nav [data-view="agenda"]').getAttribute('aria-label'),'Agenda interventi');
    assert.equal(await f.locator('.nav [data-view="parking"]').getAttribute('aria-label'),'Veicoli in parcheggio');
    f=await selectAgenda(f);assert.equal(await f.locator('#title').textContent(),'Calendario interventi');assert.equal(await f.locator('#agenda .page-head').isVisible(),true);assert.equal(await f.locator('#agenda .parking-section').isVisible(),false);
    f=await selectAgenda(f,'parking');assert.equal(await f.locator('#title').textContent(),'Veicoli in parcheggio');assert.equal(await f.locator('#agenda .page-head').isVisible(),false);assert.equal(await f.locator('#agenda .table-card').isVisible(),false);assert.equal(await f.locator('#agenda .parking-section').isVisible(),true);
    assert.equal(await f.locator('[data-view="parking"]').getAttribute('aria-current'),'page');await sync(a);assert.equal(revision(),initialRevision,'navigation must not change the shared archive');
    await parked(a,'Cliente parcheggio A','PA123AA');
    await a.screenshot({path:path.resolve(root,'../../work/agenda-navigation-desktop.png'),fullPage:true});
    f=await selectAgenda(frame(a));
    const firstFrame=await a.locator('iframe').getAttribute('src');
    await parked(b,'Cliente parcheggio B','PB123BB');
    assert.equal(await frame(a).locator('.parking-row').filter({hasText:'Cliente parcheggio B'}).count(),0,'remote updates do not reload the current page');
    f=await selectAgenda(frame(a),'parking');
    await f.locator('.parking-row').filter({hasText:'Cliente parcheggio B'}).waitFor({state:'visible'});
    assert.equal(await f.evaluate(()=>WorkshopCloud.view()),'parking','remote synchronization keeps the logical parking page');
    assert.equal(await f.locator('#agenda .table-card').isVisible(),false);assert.equal(await f.locator('#agendaRows').count(),1,'calendar authoritative root remains inside the DOM');
    assert.equal(await f.locator('#agenda .parking-section .card').count(),1,'parking authoritative root keeps its schema selector');
    assert.equal(await a.locator('iframe').getAttribute('src'),firstFrame,'remote parking updates preserve the frame');
    const viewer=await login('navigation-viewer');let vf=await selectAgenda(frame(viewer),'parking');
    assert.equal(await vf.evaluate(()=>WorkshopCloud.view()),'parking');assert.equal(await vf.locator('.parking-row').count(),2,'read-only users can navigate both pages');
    const beforeMobile=revision();
    await a.setViewportSize({width:390,height:844});f=frame(a);
    f=await selectAgenda(f);assert.equal(await f.locator('#agenda .parking-section').isVisible(),false);
    f=await selectAgenda(f,'parking');assert.equal(await f.locator('#agenda .parking-section').isVisible(),true);
    assert.equal(await f.locator('#agendaMenuToggle, #agendaSubmenu').count(),0);
    const parkingButton=f.locator('.nav > button[data-view="parking"]');await parkingButton.scrollIntoViewIfNeeded();
    const box=await parkingButton.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=390,'the direct parking button is reachable in the mobile horizontal menu');
    assert.ok(box.height>=38,'the mobile parking control keeps the existing tap target');
    assert.equal(await f.locator('[data-view="parking"]').getAttribute('aria-current'),'page');
    await a.screenshot({path:path.resolve(root,'../../work/agenda-navigation-mobile.png'),fullPage:true});
    await sync(a);assert.equal(revision(),beforeMobile,'mobile navigation does not write business data');
    assert.deepEqual(errors,[]);console.log('PASS direct agenda and parking buttons, distinct views, read-only navigation, mobile layout and remote parking synchronization');
  }finally{await browser.close();await app.close();assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir())+path.sep+'officina-agenda-navigation-'));fs.rmSync(dataDir,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
