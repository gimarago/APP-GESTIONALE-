'use strict';
// Exercise the snapshot race before the local save request exists. Equal stock
// values represent distinct operations and must retain their original fence.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {pathToFileURL}=require('node:url');
const path=require('node:path'),fs=require('node:fs'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto'),R=require('../cloud-records.js');

(async()=>{
  const root=path.resolve(__dirname,'..'),dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'officina-presend-stock-'));
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const origin=`http://127.0.0.1:${port}`;
  const {createApplication}=await import(pathToFileURL(path.join(root,'server/server.mjs'))),{addUser}=await import(pathToFileURL(path.join(root,'server/database.mjs')));
  const app=await createApplication({root,dataDir,origin,env:{NODE_ENV:'test'}});await addUser(app.db,'presend-admin','test-password-1234','admin');await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));
  let browser;
  try{
    const response=await fetch(origin+'/api/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({username:'presend-admin',password:'test-password-1234'})});assert.equal(response.status,200);
    const session=await response.json(),cookie=response.headers.get('set-cookie').split(';')[0],headers={origin,cookie,'content-type':'application/json','x-csrf-token':session.csrf};
    const read=async()=>{const response=await fetch(origin+'/api/state',{headers:{cookie}});assert.equal(response.status,200);return response.json();};
    const node=(t,c,a={})=>({t,a,c}),stockId=randomUUID(),seed=R.empty();
    seed.dom['#stockRows']=[node('tr',[node('td',['Articolo concorrente']),node('td',['Materiali di consumo']),node('td',['12 pz']),node('td',['€ 15,00']),node('td',['—']),node('td',['DISPONIBILE'])],{'data-cloud-id':stockId})];
    const imported=await fetch(origin+'/api/import',{method:'POST',headers,body:JSON.stringify({baseRevision:0,clientId:randomUUID(),mutationId:randomUUID(),state:seed})});assert.equal(imported.status,200,await imported.text());
    async function commit(base,changes){const response=await fetch(origin+'/api/changes',{method:'PUT',headers,body:JSON.stringify({protocol:2,clientId:randomUUID(),mutationId:randomUUID(),versions:base.versions,changes})});assert.equal(response.status,200,await response.text());return read();}
    browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
    const page=await browser.newPage({viewport:{width:1302,height:900}}),writes=[],errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    page.on('response',async response=>{if(response.url()===origin+'/api/changes'&&response.request().method()==='PUT')writes.push({request:JSON.parse(response.request().postData()),status:response.status(),body:await response.json()});});
    await page.goto(origin);await page.locator('#username').fill('presend-admin');await page.locator('#password').fill('test-password-1234');await page.locator('#loginForm button[type="submit"]').click();
    const ready=()=>page.waitForFunction(()=>document.querySelector('iframe')?.contentWindow?.WorkshopCloud?.initializing===false&&!WorkshopCloudHost.synchronizing());await ready();await page.waitForTimeout(1100);
    const stockKey=R.key('row','#stockRows',stockId),before=await read(),firstWrite=writes.length;
    // Host.changed schedules a save in 650 ms without an input settling window.
    // The peer change is committed first, so its SSE snapshot arrives pre-send.
    const local=await page.evaluate(stockId=>{const source=document.querySelector('iframe').contentWindow,row=source.document.querySelector('#stockRows [data-cloud-id="'+stockId+'"]');source.setStockQuantity(row,11,{kind:'adjustment'});WorkshopCloudHost.changed(source);return source.WorkshopCloud.capture();},stockId);
    const record=R.flatten(local).get(stockKey),winner=await commit(before,[{key:stockKey,expectedVersion:before.versions[stockKey],value:record}]);
    await page.waitForFunction(()=>document.getElementById('mode').textContent==='Modifiche sospese');await page.waitForTimeout(100);
    assert.equal(writes.length,firstWrite+1);assert.equal(writes.at(-1).status,409);assert.equal(writes.at(-1).request.changes.find(change=>change.key===stockKey).expectedVersion,before.versions[stockKey]);
    assert.equal((await read()).revision,winner.revision);assert.equal(R.flatten((await read()).state).get(stockKey).a['data-quantity'],'11');
    console.log('PASS independent equal stock deductions conflict before send instead of silently merging');

    // A work status/deduction change depends on the whole inventory even when
    // that work does not currently change a particular stock row.
    await page.reload();await ready();await page.waitForTimeout(1100);
    let frame=page.frames().find(frame=>frame.url().includes('/legacy'));
    await frame.evaluate(()=>openNewAcceptance());await frame.locator('#appTime').fill('10:00');await frame.locator('#appCustomer').fill('Lavoro con dipendenza magazzino');await frame.locator('#appPlate').fill('TEST111');await frame.locator('#appointmentWorkLines [data-description]').fill('Verifica materiale');await frame.locator('#appointmentWorkLines [data-amount]').fill('100');await frame.locator('#appointmentForm button[type="submit"]').click();await page.evaluate(()=>WorkshopCloudHost.flush());
    const workBefore=await read(),startWrites=writes.length;
    const pending=await page.evaluate(()=>{const source=document.querySelector('iframe').contentWindow,row=[...source.document.querySelectorAll('#agendaRows tr')].find(row=>row.textContent.includes('Lavoro con dipendenza magazzino'));row.querySelector('.status-select').value='COMPLETATO';WorkshopCloudHost.changed(source);return source.WorkshopCloud.capture();});
    const workChanges=R.diff(workBefore.state,pending,workBefore.versions);assert.equal(R.needsInventoryGuard(workChanges,R.flatten(workBefore.state)),true);
    const next=structuredClone(workBefore.state),peerStock=next.dom['#stockRows'].find(row=>row.a['data-cloud-id']===stockId);peerStock.a['data-quantity']='13';
    const peer=await commit(workBefore,[{key:stockKey,expectedVersion:workBefore.versions[stockKey],value:peerStock}]);
    await page.waitForFunction(()=>document.getElementById('mode').textContent==='Modifiche sospese');await page.waitForTimeout(100);
    assert.equal(writes.length,startWrites+1);assert.equal(writes.at(-1).status,409);assert.equal(writes.at(-1).request.versions['domain:inventory'],workBefore.versions['domain:inventory']);assert.equal((await read()).revision,peer.revision);assert.equal(writes.at(-1).body.error.code,'DEPENDENCY_CONFLICT');
    console.log('PASS a local work operation retains its pre-send inventory dependency version');assert.deepEqual(errors,[]);
  }finally{await browser?.close();await app.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
