'use strict';
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {pathToFileURL}=require('node:url');
const path=require('node:path'),fs=require('node:fs'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict');
(async()=>{
 const root=path.resolve(__dirname,'..'),dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'officina-account-controls-'));
 const probe=net.createServer();await new Promise(ok=>probe.listen(0,'127.0.0.1',ok));const port=probe.address().port;await new Promise(ok=>probe.close(ok));
 const origin=`http://127.0.0.1:${port}`;
 const {createApplication}=await import(pathToFileURL(path.join(root,'server/server.mjs'))),{addUser}=await import(pathToFileURL(path.join(root,'server/database.mjs')));
 const app=await createApplication({root,dataDir,origin,env:{NODE_ENV:'test'}});
 for(const [name,role] of [['account-admin','admin'],['account-viewer','viewer']])await addUser(app.db,name,'test-password-1234',role);
 await new Promise(ok=>app.server.listen(port,'127.0.0.1',ok));
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
 const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 const frame=()=>page.frames().find(f=>f.url().includes('/legacy'));
 const ready=()=>page.waitForFunction(()=>document.getElementById('cloudBar').hidden&&document.querySelector('iframe')?.contentWindow?.WorkshopCloud?.initializing===false&&!WorkshopCloudHost.synchronizing());
 async function login(name){await page.locator('#username').fill(name);await page.locator('#password').fill('test-password-1234');await page.locator('#loginForm button[type=submit]').click();await ready();}
 async function settings(){await frame().locator('.nav [data-view=impostazioni]').click();await ready();await frame().locator('#settingsLogout').waitFor({state:'visible'});}
 const saved=()=>JSON.parse(app.db.prepare('SELECT payload FROM state WHERE id=1').get().payload);
 try{
  await page.goto(origin);await login('account-admin');
  assert.ok(await page.locator('#cloudBar').isHidden());
  assert.equal(await page.locator('#frameHost').evaluate(el=>Math.round(el.getBoundingClientRect().height)),844);
  await settings();
  for(const id of ['settingsLogout','settingsManagement']){assert.ok(await frame().locator('#'+id).isVisible());assert.ok(await frame().locator('#'+id).evaluate(el=>el.getBoundingClientRect().right<=innerWidth));}
  await frame().locator('#settingsManagement').click();assert.ok(await page.locator('#management').isVisible());assert.ok(await page.locator('#cloudBar').isHidden());
  const exported=page.waitForEvent('download');await page.locator('#export').click();const output=await exported;assert.equal(JSON.parse(fs.readFileSync(await output.path(),'utf8')).format,'officina-cloud-export');
  console.log('PASS healthy toolbar stays hidden with a full-height app and mobile Settings retain account and export actions');
  await frame().locator('#settingsManagement').click();
  await frame().locator('#shopPhone').fill('06 9876 5432');
  await frame().locator('#settingsLogout').click();await page.locator('#loginPanel').waitFor({state:'visible'});
  assert.equal(saved().fields.shopPhone,'06 9876 5432');assert.equal((await (await context.request.get(origin+'/api/session')).json()).user,null);
  assert.equal(await page.locator('iframe').count(),0);
  console.log('PASS Settings logout saves the last local edit before revoking the session');
  await login('account-admin');
  await settings();
  let releaseSave,receivedSave;const saveGate=new Promise(ok=>releaseSave=ok),saveStarted=new Promise(ok=>receivedSave=ok);
  const heldSave=async route=>{if(route.request().method()==='PUT'){receivedSave();await saveGate;}await route.continue();};
  await page.route('**/api/changes',heldSave);await frame().locator('#shopPhone').fill('06 5555 4321');await saveStarted;
  await frame().locator('#settingsLogout').click();assert.ok(await page.locator('#loginPanel').isHidden());releaseSave();
  await page.locator('#loginPanel').waitFor({state:'visible'});await page.unroute('**/api/changes',heldSave);assert.equal(saved().fields.shopPhone,'06 5555 4321');
  console.log('PASS logout waits for an in-flight save before ending the account session');
  await login('account-admin');
  await page.evaluate(()=>sessionStorage.setItem('officina.cloud.draft.v1',JSON.stringify({state:document.querySelector('iframe').contentWindow.WorkshopCloud.capture(),forms:{customerName:'Bozza da conservare'}})));
  const before=saved();await page.reload();await ready();await settings();await frame().locator('#settingsManagement').click();
  assert.ok(await page.locator('#cloudBar').isHidden());assert.ok(await page.locator('#managementRecover').isVisible());
  const recovery=page.waitForEvent('download');await page.locator('#managementRecover').click();assert.match(fs.readFileSync(await (await recovery).path(),'utf8'),/Bozza da conservare/);assert.deepEqual(saved(),before);
  console.log('PASS retained drafts are downloadable from Settings without displaying the healthy toolbar');
  await context.setOffline(true);await page.locator('#cloudBar').waitFor({state:'visible'});assert.ok(await page.locator('#reload').isVisible());assert.ok(await page.locator('#recover').isVisible());
  await context.setOffline(false);await page.locator('#reload').click();await ready();assert.ok(await page.locator('#cloudBar').isHidden());
  console.log('PASS offline recovery shows the toolbar, and a successful reload hides it again');
  await settings();await frame().locator('#settingsLogout').click();await page.locator('#loginPanel').waitFor({state:'visible'});await login('account-viewer');
  await settings();assert.ok(await page.locator('#cloudBar').isHidden());
  await context.setOffline(true);await page.locator('#cloudBar').waitFor({state:'visible'});assert.ok(await page.locator('#reload').isVisible());
  await context.setOffline(false);await page.locator('#reload').click();await ready();await settings();
  await frame().locator('#settingsLogout').click();await page.locator('#loginPanel').waitFor({state:'visible'});assert.equal((await (await context.request.get(origin+'/api/session')).json()).user,null);
  console.log('PASS read-only accounts can recover their connection and exit from Settings');
  assert.deepEqual(errors,[]);console.log('PASS no browser runtime errors');
 }finally{await browser.close();await app.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
