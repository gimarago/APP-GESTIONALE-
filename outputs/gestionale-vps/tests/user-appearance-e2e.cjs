'use strict';
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {pathToFileURL}=require('node:url');
const path=require('node:path'),fs=require('node:fs'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict');
const R=require('../cloud-records.js');
(async()=>{
 const root=path.resolve(__dirname,'..'),dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'officina-appearance-browser-'));
 const probe=net.createServer();await new Promise(ok=>probe.listen(0,'127.0.0.1',ok));const port=probe.address().port;await new Promise(ok=>probe.close(ok));
 const origin=`http://127.0.0.1:${port}`;
 const {createApplication}=await import(pathToFileURL(path.join(root,'server/server.mjs'))),{addUser}=await import(pathToFileURL(path.join(root,'server/database.mjs')));
 const app=await createApplication({root,dataDir,origin,env:{NODE_ENV:'test'}});
 for(const [name,role] of [['theme-admin','admin'],['theme-viewer','viewer']])await addUser(app.db,name,'test-password-1234',role);
 await new Promise(ok=>app.server.listen(port,'127.0.0.1',ok));
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
 const errors=[];
 const frame=page=>page.frames().find(f=>f.url().includes('/legacy'));
 const ready=page=>page.waitForFunction(()=>document.querySelector('iframe')?.contentWindow?.WorkshopCloud?.initializing===false&&!WorkshopCloudHost.synchronizing());
 const saved=page=>page.waitForFunction(()=>document.querySelector('iframe')?.contentWindow?.WorkshopCloud?.appearancePending===false);
 const appearance=async context=>(await context.request.get(origin+'/api/appearance')).json();
 async function client(name,viewport={width:1280,height:900}){
   const context=await browser.newContext({viewport}),page=await context.newPage();
   page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
   await page.goto(origin);await login(page,name);return {context,page};
 }
 async function login(page,name){await page.locator('#username').fill(name);await page.locator('#password').fill('test-password-1234');await page.locator('#loginForm button[type=submit]').click();await ready(page);}
 async function settings(page){await frame(page).locator('.nav [data-view=impostazioni]').click();await ready(page);}
 async function choose(page,theme){await frame(page).locator('#chooseTheme').click();await frame(page).locator(`[data-theme-choice=${theme}]`).click();await saved(page);await frame(page).locator('#closeThemePicker').click();}
 async function logout(page){await frame(page).locator('#settingsLogout').click();await page.locator('#loginPanel').waitFor({state:'visible'});}
 function revision(){return app.db.prepare('SELECT revision FROM state WHERE id=1').get().revision;}
 try{
   const a=await client('theme-admin');await settings(a.page);
   const baseline=revision();await choose(a.page,'aurora');
   await frame(a.page).locator('#primaryColor').evaluate(input=>{input.value='#445566';input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));});
   await frame(a.page).locator('#accentColor').evaluate(input=>{input.value='#abcdef';input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));});
   await saved(a.page);assert.deepEqual(await appearance(a.context),{theme:'aurora',primary:'#445566',accent:'#abcdef'});assert.equal(revision(),baseline);
   await a.page.reload();await ready(a.page);await settings(a.page);
   assert.equal(await frame(a.page).locator('body').getAttribute('data-appearance'),'aurora');assert.equal(await frame(a.page).locator('#primaryColor').inputValue(),'#445566');
   assert.match(await frame(a.page).locator('#currentThemeLabel').textContent(),/Aurora.*personalizzati/);
   console.log('PASS manually chosen theme and customized colors survive reload without shared record writes');

   await logout(a.page);await login(a.page,'theme-viewer');await settings(a.page);
   assert.equal(await frame(a.page).locator('body').getAttribute('data-appearance'),'graphite');
   await choose(a.page,'classic');assert.equal(revision(),baseline);assert.equal((await appearance(a.context)).theme,'classic');
   await a.page.reload();await ready(a.page);await settings(a.page);assert.equal(await frame(a.page).locator('body').getAttribute('data-appearance'),'classic');
   await logout(a.page);await login(a.page,'theme-admin');await settings(a.page);assert.equal(await frame(a.page).locator('body').getAttribute('data-appearance'),'aurora');
   console.log('PASS accounts on the same browser retain separate themes, including read-only accounts');

   const b=await client('theme-admin',{width:390,height:844});await settings(b.page);
   assert.equal(await frame(b.page).locator('body').getAttribute('data-appearance'),'aurora');assert.equal(await frame(b.page).locator('#accentColor').inputValue(),'#abcdef');
   await choose(b.page,'classic');
   const session=await (await b.context.request.get(origin+'/api/session')).json();
   const snapshot=await (await b.context.request.get(origin+'/api/state')).json(),next=structuredClone(snapshot.state||R.empty());next.fields.shopPhone='06 123456789';
   const response=await b.context.request.put(origin+'/api/changes',{headers:{Origin:origin,'X-CSRF-Token':session.csrf},data:{protocol:2,clientId:crypto.randomUUID(),mutationId:crypto.randomUUID(),versions:snapshot.versions,changes:R.diff(snapshot.state,next,snapshot.versions)}});assert.equal(response.status(),200);
   await frame(a.page).locator('#shopPhone').waitFor();await a.page.waitForFunction(()=>document.querySelector('iframe').contentDocument.getElementById('shopPhone').value==='06 123456789');
   assert.equal(await frame(a.page).locator('body').getAttribute('data-appearance'),'aurora');assert.equal(await frame(a.page).locator('#primaryColor').inputValue(),'#445566');
   console.log('PASS account appearance follows to another device and live business updates never override the open theme');

   let release,started;const gate=new Promise(ok=>release=ok),began=new Promise(ok=>started=ok);let held=false;
   const hold=async route=>{if(route.request().method()==='PUT'&&!held){held=true;started();await gate;}await route.continue();};
   await a.page.route('**/api/appearance',hold);await frame(a.page).locator('#chooseTheme').click();await frame(a.page).locator('[data-theme-choice=graphite]').click();await began;
   await frame(a.page).locator('[data-theme-choice=classic]').click();assert.equal(await frame(a.page).locator('body').getAttribute('data-appearance'),'classic');release();await saved(a.page);await a.page.unroute('**/api/appearance',hold);
   assert.equal((await appearance(a.context)).theme,'classic');assert.equal(await frame(a.page).locator('body').getAttribute('data-appearance'),'classic');await frame(a.page).locator('#closeThemePicker').click();
   console.log('PASS rapid theme choices serialize and the final selection wins over delayed responses');

   const failing=async route=>route.request().method()==='PUT'?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'Connessione temporaneamente non disponibile.'}})}):route.continue();
   await a.page.route('**/api/appearance',failing);await frame(a.page).locator('#chooseTheme').click();await frame(a.page).locator('[data-theme-choice=aurora]').click();
   await frame(a.page).locator('#themePickerRetry').waitFor({state:'visible'});assert.match(await frame(a.page).locator('#themePickerStatus').textContent(),/non salvato/);
   assert.equal(await frame(a.page).locator('body').getAttribute('data-appearance'),'aurora');assert.equal((await appearance(a.context)).theme,'classic');
   await a.page.unroute('**/api/appearance',failing);await frame(a.page).locator('#themePickerRetry').click();await saved(a.page);assert.equal((await appearance(a.context)).theme,'aurora');await frame(a.page).locator('#closeThemePicker').click();
   console.log('PASS failed persistence keeps the selected theme with an explicit retry that saves it');

   let releaseReload,startedReload;const reloadGate=new Promise(ok=>releaseReload=ok),reloadBegan=new Promise(ok=>startedReload=ok);
   const holdReload=async route=>{if(route.request().method()==='PUT'){startedReload();await reloadGate;}await route.continue();};
   await a.page.route('**/api/appearance',holdReload);await frame(a.page).locator('#chooseTheme').click();await frame(a.page).locator('[data-theme-choice=graphite]').click();await reloadBegan;
   await frame(a.page).locator('#closeThemePicker').click();const previousFrame=await a.page.locator('iframe').elementHandle();
   // Expose the recovery controls while keeping the held request reachable.
   // This models the offline event arriving during a pending theme write.
   await a.page.evaluate(()=>window.dispatchEvent(new Event('offline')));await a.page.locator('#reload').click();
   assert.ok(await previousFrame.evaluate(element=>element.isConnected));releaseReload();
   await a.page.waitForFunction(element=>!element.isConnected,previousFrame);await ready(a.page);await a.page.unroute('**/api/appearance',holdReload);await settings(a.page);
   assert.equal(await frame(a.page).locator('body').getAttribute('data-appearance'),'graphite');assert.equal((await appearance(a.context)).theme,'graphite');
   console.log('PASS manual server recovery waits for a pending theme save before rebuilding the iframe');

   let releaseLogout,startedLogout;const logoutGate=new Promise(ok=>releaseLogout=ok),logoutBegan=new Promise(ok=>startedLogout=ok);
   const holdLogout=async route=>{if(route.request().method()==='PUT'){startedLogout();await logoutGate;}await route.continue();};
   await a.page.route('**/api/appearance',holdLogout);await frame(a.page).locator('#chooseTheme').click();await frame(a.page).locator('[data-theme-choice=classic]').click();await logoutBegan;
   await frame(a.page).locator('#closeThemePicker').click();await frame(a.page).locator('#settingsLogout').click();assert.ok(await a.page.locator('#loginPanel').isHidden());
   assert.ok(await a.page.locator('iframe').evaluate(element=>element.inert));assert.equal(await a.page.evaluate(()=>WorkshopCloudHost.canWrite()),false);
   releaseLogout();await a.page.locator('#loginPanel').waitFor({state:'visible'});await a.page.unroute('**/api/appearance',holdLogout);
   await login(a.page,'theme-admin');await settings(a.page);assert.equal(await frame(a.page).locator('body').getAttribute('data-appearance'),'classic');
   console.log('PASS logout locks business editing while waiting for a pending personal theme save before ending the session');
   assert.deepEqual(errors,[]);console.log('PASS no browser runtime errors');
 }finally{await browser.close();await app.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
