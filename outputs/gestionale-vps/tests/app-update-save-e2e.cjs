'use strict';
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {pathToFileURL}=require('node:url');
const path=require('node:path'),fs=require('node:fs'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict');

(async()=>{
  const root=path.resolve(__dirname,'..'),dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'officina-app-update-save-'));
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const origin=`http://127.0.0.1:${port}`;
  const {createApplication}=await import(pathToFileURL(path.join(root,'server/server.mjs'))),{addUser}=await import(pathToFileURL(path.join(root,'server/database.mjs')));
  const app=await createApplication({root,dataDir,origin,env:{NODE_ENV:'test'}});
  for(const [name,role]of [['update-admin','admin'],['update-viewer','viewer']])await addUser(app.db,name,'test-password-1234',role);
  await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})}),errors=[];
  const frame=page=>page.frames().find(item=>item.url().includes('/legacy'));
  const ready=page=>page.waitForFunction(()=>document.querySelector('iframe')?.contentWindow?.WorkshopCloud?.initializing===false&&!WorkshopCloudHost.synchronizing());
  const state=()=>app.db.prepare('SELECT revision,payload FROM state WHERE id=1').get();
  const flush=page=>page.evaluate(()=>WorkshopCloudHost.flush({navigation:true}));
  const prepare=page=>page.evaluate(async()=>{try{return {allowed:await WorkshopCloudHost.prepareToLeave({reason:'update'})};}catch(error){return {error:error.message};}});
  const cancel=page=>page.evaluate(()=>WorkshopCloudHost.cancelLeaving());
  const startPrepare=page=>page.evaluate(()=>{window.updatePrepareResult=null;WorkshopCloudHost.prepareToLeave({reason:'update'}).then(allowed=>window.updatePrepareResult={allowed},error=>window.updatePrepareResult={error:error.message});});
  async function finishPrepare(page){await page.waitForFunction(()=>window.updatePrepareResult!==null);return page.evaluate(()=>window.updatePrepareResult);}
  async function client(username){const context=await browser.newContext(),page=await context.newPage();page.on('pageerror',error=>errors.push(error.stack));page.on('dialog',dialog=>dialog.accept());await page.goto(origin);await page.waitForFunction(()=>window.WorkshopCloudHost);if(username){await page.locator('#username').fill(username);await page.locator('#password').fill('test-password-1234');await page.locator('#loginForm button[type=submit]').click();await ready(page);}return {context,page};}
  async function settings(page){await frame(page).locator('.nav [data-view=impostazioni]').click();await ready(page);}
  async function heldRequest(page,pattern,method){let release,started,finished;const gate=new Promise(resolve=>release=resolve),began=new Promise(resolve=>started=resolve),completed=new Promise(resolve=>finished=resolve);let held=false;const handler=async route=>{const selected=route.request().method()===method&&!held;if(selected){held=true;started();await gate;}await route.continue();if(selected)finished();};await page.route(pattern,handler);return {began,release,remove:async()=>{await completed;await page.unroute(pattern,handler);}};}
  try{
    const login=await client();assert.deepEqual(await prepare(login.page),{allowed:true});assert.equal(await login.page.locator('#loginPanel').evaluate(el=>el.inert),true);assert.equal(await cancel(login.page),true);assert.equal(await login.page.locator('#loginPanel').evaluate(el=>el.inert),false);await login.context.close();
    const admin=await client('update-admin'),page=admin.page;await settings(page);let f=frame(page);
    const unchanged=state();assert.deepEqual(await prepare(page),{allowed:true});assert.equal(await page.locator('iframe').evaluate(el=>el.inert),true);assert.equal(await page.evaluate(()=>WorkshopCloudHost.canWrite()),false);assert.equal(await page.locator('#logout').isDisabled(),true);
    await f.evaluate(()=>parent.WorkshopCloudHost.logout(window));assert.equal(await page.locator('#loginPanel').isHidden(),true,'prepared state cannot race a logout');assert.deepEqual(state(),unchanged,'clean preparation does not save');assert.equal(await cancel(page),true);assert.equal(await page.evaluate(()=>WorkshopCloudHost.canWrite()),true);

    // Any open business form is protected, including an unchanged form.
    await f.evaluate(()=>openNewAcceptance());assert.match((await prepare(page)).error,/modulo aperto/);assert.equal(await f.locator('#appointmentModal').evaluate(el=>el.classList.contains('open')),true);
    await f.locator('#appCustomer').fill('Cliente ancora da salvare');assert.match((await prepare(page)).error,/modulo aperto/);assert.equal(await f.locator('#appCustomer').inputValue(),'Cliente ancora da salvare');assert.equal(await page.locator('iframe').evaluate(el=>el.inert),false);await f.evaluate(()=>closeModal('appointmentModal'));await flush(page);assert.deepEqual(state(),unchanged,'incomplete forms are never submitted by preparation');

    // Do not trust parseable JSON alone: a damaged recovery file still belongs
    // to the user and must not disappear when the native process exits.
    await page.evaluate(()=>sessionStorage.setItem('officina.cloud.archived-draft.test','not-json'));assert.match((await prepare(page)).error,/bozze da recuperare/);assert.equal(await page.evaluate(()=>sessionStorage.getItem('officina.cloud.archived-draft.test')),'not-json');await page.evaluate(()=>sessionStorage.removeItem('officina.cloud.archived-draft.test'));

    const business=await heldRequest(page,'**/api/changes','PUT');await f.locator('#shopPhone').fill('06 1122334455');await startPrepare(page);await business.began;
    assert.equal(await page.locator('iframe').evaluate(el=>el.inert),true);assert.equal(await page.evaluate(()=>window.updatePrepareResult),null,'installer waits for the real server acknowledgement');assert.notEqual(JSON.parse(state().payload)?.fields.shopPhone,'06 1122334455');
    business.release();assert.deepEqual(await finishPrepare(page),{allowed:true});await business.remove();assert.equal(JSON.parse(state().payload).fields.shopPhone,'06 1122334455');assert.equal(await page.locator('iframe').evaluate(el=>el.inert),true,'flush finally cannot unlock the prepared workspace');assert.equal(await page.evaluate(()=>sessionStorage.getItem('officina.cloud.draft.v1')),null);await cancel(page);
    await f.locator('#shopPhone').fill('06 9988776655');await flush(page);assert.equal(JSON.parse(state().payload).fields.shopPhone,'06 9988776655','failed native install can resume normal editing');
    const cancelledSave=await heldRequest(page,'**/api/changes','PUT');await f.locator('#shopPhone').fill('06 6677889900');await startPrepare(page);await cancelledSave.began;assert.equal(await cancel(page),true);assert.equal(await page.locator('iframe').evaluate(el=>el.inert),false);await f.locator('#shopPhone').fill('06 6677889901');cancelledSave.release();assert.deepEqual(await finishPrepare(page),{allowed:false},'closing updater during its save must cancel installation');await cancelledSave.remove();await flush(page);assert.equal(JSON.parse(state().payload).fields.shopPhone,'06 6677889901','continued editing during cancellation retains the final value');

    const viewer=await client('update-viewer');await settings(viewer.page);const vf=frame(viewer.page),baseline=state(),appearanceHold=await heldRequest(viewer.page,'**/api/appearance','PUT');
    await vf.locator('#chooseTheme').click();await vf.locator('[data-theme-choice=aurora]').click();await appearanceHold.began;await vf.locator('#closeThemePicker').click();await startPrepare(viewer.page);
    await viewer.page.waitForFunction(()=>document.querySelector('iframe').inert);assert.equal(await viewer.page.evaluate(()=>window.updatePrepareResult),null,'read-only account also waits for its personal theme');appearanceHold.release();assert.deepEqual(await finishPrepare(viewer.page),{allowed:true});await appearanceHold.remove();assert.equal((await (await viewer.context.request.get(origin+'/api/appearance')).json()).theme,'aurora');assert.deepEqual(state(),baseline,'viewer preparation never mutates workshop records');await cancel(viewer.page);

    const failAppearance=async route=>route.request().method()==='PUT'?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'Tema non confermato dal server.'}})}):route.continue();
    await page.route('**/api/appearance',failAppearance);await f.locator('#chooseTheme').click();await f.locator('[data-theme-choice=classic]').click();await f.locator('#themePickerRetry').waitFor({state:'visible'});await f.locator('#closeThemePicker').click();assert.match((await prepare(page)).error,/Tema non confermato/);assert.equal(await page.locator('iframe').evaluate(el=>el.inert),false);assert.equal(await page.evaluate(()=>WorkshopCloudHost.canWrite()),true,'appearance failure releases update locks');assert.equal(await f.locator('body').getAttribute('data-appearance'),'classic');await page.unroute('**/api/appearance',failAppearance);await f.locator('#themeRetrySave').click();await page.waitForFunction(()=>document.querySelector('iframe').contentWindow.WorkshopCloud.appearancePending===false);

    const failSave=async route=>route.request().method()==='PUT'?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'Salvataggio non disponibile.'}})}):route.continue();await page.route('**/api/changes',failSave);const savedBeforeFailure=state();await f.locator('#shopPhone').fill('06 5555555555');assert.match((await prepare(page)).error,/non confermato|non confermata|Salvataggio sospeso/);assert.equal(await page.locator('iframe').evaluate(el=>el.inert),false);assert.equal(await f.locator('#shopPhone').inputValue(),'06 5555555555');assert.ok(await page.evaluate(()=>sessionStorage.getItem('officina.cloud.draft.v1')),'unacknowledged business data remains recoverable');assert.deepEqual(state(),savedBeforeFailure);assert.equal(await page.locator('#reload').isDisabled(),false,'recovery remains usable after a failed preparation');await page.unroute('**/api/changes',failSave);
    await page.locator('#reload').click();await ready(page);f=frame(page);assert.match((await prepare(page)).error,/bozze da recuperare/,'manual recovery keeps the old draft rather than losing it on native restart');await settings(page);await f.locator('#settingsManagement').click();await page.locator('#clearDrafts').click();

    const syncHold=await heldRequest(page,'**/api/state','GET');await f.locator('.nav [data-view=dashboard]').click();await syncHold.began;assert.match((await prepare(page)).error,/sincronizzazione/);syncHold.release();await syncHold.remove();await ready(page);
    await viewer.context.setOffline(true);assert.match((await prepare(viewer.page)).error,/connessione/);assert.equal(await viewer.page.locator('iframe').evaluate(el=>el.inert),false);await viewer.context.setOffline(false);
    assert.deepEqual(errors,[]);console.log('PASS updater preflight: confirmed business/theme saves, persistent install lock, safe cancellation, open/recovery drafts, failed saves, synchronization and offline guards, login and viewer');
  }finally{await browser.close();await app.close();const absolute=path.resolve(dataDir);assert.ok(absolute.startsWith(path.resolve(os.tmpdir())+path.sep+'officina-app-update-save-'));fs.rmSync(absolute,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
