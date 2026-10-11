'use strict';
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {pathToFileURL}=require('node:url');
const path=require('node:path'),fs=require('node:fs'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict');

(async()=>{
  const root=path.resolve(__dirname,'..'),dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'officina-dashboard-recalls-'));
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const origin=`http://127.0.0.1:${port}`;
  const {createApplication}=await import(pathToFileURL(path.join(root,'server/server.mjs'))),{addUser}=await import(pathToFileURL(path.join(root,'server/database.mjs')));
  const app=await createApplication({root,dataDir,origin,env:{NODE_ENV:'test'}});
  await addUser(app.db,'dashboard-recalls','test-password-1234','admin');await addUser(app.db,'dashboard-viewer','test-password-1234','viewer');
  await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})}),errors=[];
  const frame=page=>page.frames().find(item=>item.url().includes('/legacy'));
  const ready=page=>page.waitForFunction(()=>document.querySelector('iframe')?.contentWindow?.WorkshopCloud?.initializing===false&&!WorkshopCloudHost.synchronizing());
  const sync=page=>page.evaluate(()=>WorkshopCloudHost.flush());
  const state=()=>app.db.prepare('SELECT revision,payload FROM state WHERE id=1').get();
  const dashboard=f=>f.locator('#dashboard .bottom .card:not(.revenue) .agenda-list');
  async function login(username){const page=await browser.newPage();page.on('pageerror',error=>errors.push(error.stack));await page.goto(origin);await page.locator('#username').fill(username);await page.locator('#password').fill('test-password-1234');await page.locator('#loginForm button[type="submit"]').click();await ready(page);return page;}
  try{
    const page=await login('dashboard-recalls');let f=frame(page);
    assert.match(await dashboard(f).innerText(),/Nessun richiamo registrato/);
    await f.evaluate(()=>{
      const customers=document.getElementById('customerRows');
      for(const [name,plate,category]of [['Cliente manuale','MA123AA',''],['Cliente revisione','RE456BB','annual']]){
        const row=customers.insertRow();if(category)row.dataset.revisionCategory=category;
        for(const value of [name,'3331112222','test@example.test','Fiat Panda',plate,'—'])row.insertCell().textContent=value;
      }
      const now=new Date(),oldDate=`${now.getFullYear()-2}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
      localStorage.setItem('officina-table-import-v1',JSON.stringify({history:[{customer:'Cliente revisione',plate:'RE456BB',vehicle:'Fiat Panda',date:oldDate,work:'Revisione periodica',amount:79}]}));
      document.dispatchEvent(new CustomEvent('workshop:history-imported'));
    });
    await sync(page);await dashboard(f).locator('[data-revision-auto]').waitFor();
    await f.evaluate(()=>showPage('richiami'));await f.locator('#richiami .page-head .btn').click();await f.locator('#recallCustomer').selectOption({label:'Cliente manuale'});
    const reason='Controllo pressione <img src=x onerror="window.recallInjected=true">';
    await f.locator('#recallReason').fill(reason);await f.locator('#recallDate').fill('2030-01-15');await f.locator('#recallForm [type="submit"]').click();await sync(page);
    await f.locator('.nav [data-view="dashboard"]').click();
    const manual=dashboard(f).locator('.agenda-row:not([data-revision-auto])');assert.equal(await manual.count(),1);assert.match(await manual.innerText(),/Cliente manuale/);assert.match(await manual.innerText(),/MA123AA · 15\/01\/2030/);assert.ok((await manual.innerText()).includes(reason));
    assert.equal(await manual.locator('img').count(),0);assert.equal(await manual.getAttribute('data-cloud-id'),null,'dashboard preview has no authoritative row identity');
    assert.equal(await dashboard(f).locator('[data-revision-auto]').count(),1,'automatic reminders remain visible alongside manual recalls');
    const baseline=state();
    await f.evaluate(()=>{for(let index=0;index<10;index++)WorkshopRevisionReminders.refresh();});await sync(page);
    assert.deepEqual(state(),baseline,'redrawing the dashboard must not save or duplicate recalls');
    const saved=JSON.parse(baseline.payload);assert.equal(saved.dom['#richiami .agenda-list'].length,1,'only the manual archive record is saved; computed revisions are not');assert.equal(Object.keys(saved.dom).some(key=>key.includes('#dashboard')),false);
    await page.reload();await ready(page);f=frame(page);assert.equal(await dashboard(f).locator('.agenda-row').count(),2,'both kinds of recalls survive server reload');await sync(page);assert.deepEqual(state(),baseline,'startup rendering makes no phantom save');
    const applied=await f.evaluate(async()=>{
      WorkshopCloud.mode(false);
      const previous=WorkshopCloud.capture(),incoming=structuredClone(previous),selector='#richiami .agenda-list';
      const source=document.querySelector(selector+' .agenda-row:not([data-revision-auto])').cloneNode(true);source.querySelectorAll('a.whatsapp-reminder').forEach(link=>link.remove());source.querySelector('b').textContent='Cliente remoto';source.querySelector('.agenda-text span').textContent='Richiamo remoto · MA123AA · 20/01/2030';
      incoming.dom[selector]=[WorkshopCloud.serialize(source)];
      const writes=[],native=localStorage.setItem;localStorage.setItem=function(...args){writes.push(args[0]);return native.apply(this,args);};
      await WorkshopCloud.apply(incoming,previous);await new Promise(resolve=>setTimeout(resolve,300));
      const list=document.querySelector('#dashboard .bottom .card:not(.revenue) .agenda-list');
      const first={text:list.textContent,manual:list.querySelectorAll('.agenda-row:not([data-revision-auto])').length,automatic:list.querySelectorAll('[data-revision-auto]').length};
      const beforeEmpty=WorkshopCloud.capture(),empty=structuredClone(beforeEmpty);empty.dom[selector]=[];await WorkshopCloud.apply(empty,beforeEmpty);await new Promise(resolve=>setTimeout(resolve,300));
      const afterEmpty={text:list.textContent,manual:list.querySelectorAll('.agenda-row:not([data-revision-auto])').length,automatic:list.querySelectorAll('[data-revision-auto]').length};
      const beforeDisable=WorkshopCloud.capture(),disabled=structuredClone(beforeDisable);disabled.storage['officina.revisionReminders.v1']=JSON.stringify({enabled:false,days:30,secondEnabled:true,secondAfter:15,dates:{}});await WorkshopCloud.apply(disabled,beforeDisable);await new Promise(resolve=>setTimeout(resolve,300));
      localStorage.setItem=native;
      return {first,afterEmpty,emptyText:list.textContent,writes};
    });
    assert.match(applied.first.text,/Cliente remoto/);assert.doesNotMatch(applied.first.text,/Cliente manuale/);assert.equal(applied.first.manual,1);assert.equal(applied.first.automatic,1);
    assert.equal(applied.afterEmpty.manual,0,'a remotely deleted recall disappears from the dashboard');assert.equal(applied.afterEmpty.automatic,1);assert.match(applied.emptyText,/Nessun richiamo registrato/);assert.deepEqual(applied.writes,[],'selective hydration and rendering do not write storage');assert.deepEqual(state(),baseline);
    const viewer=await login('dashboard-viewer'),vf=frame(viewer);assert.equal(await dashboard(vf).locator('.agenda-row').count(),2,'read-only users see saved manual and automatic recalls');await sync(viewer);assert.deepEqual(state(),baseline);
    assert.deepEqual(errors,[]);console.log('PASS manual and automatic dashboard recalls, safe text, reload, selective hydration/deletion, viewer and no phantom saves');
  }finally{await browser.close();await app.close();const absolute=path.resolve(dataDir);assert.ok(absolute.startsWith(path.resolve(os.tmpdir())+path.sep+'officina-dashboard-recalls-'));fs.rmSync(absolute,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
