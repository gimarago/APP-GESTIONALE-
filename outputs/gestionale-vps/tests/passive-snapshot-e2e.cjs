const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {pathToFileURL}=require('node:url');
const path=require('node:path'),fs=require('node:fs'),os=require('node:os'),net=require('node:net');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const R=require('../cloud-records.js');

// A legacy snapshot can contain the same business values without today's
// rendered controls. Receiving it must not turn a read-only client into a writer.
(async()=>{
  const root=path.resolve(__dirname,'..'),dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'officina-passive-snapshot-'));
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const origin=`http://127.0.0.1:${port}`;
  const {createApplication}=await import(pathToFileURL(path.join(root,'server/server.mjs')));
  const {addUser}=await import(pathToFileURL(path.join(root,'server/database.mjs')));
  const app=await createApplication({root,dataDir,origin,env:{NODE_ENV:'test'}});
  await addUser(app.db,'passive-admin','test-password-1234','admin');
  await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));
  let browser;
  try{
    const response=await fetch(origin+'/api/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({username:'passive-admin',password:'test-password-1234'})});
    assert.equal(response.status,200);
    const session=await response.json(),cookie=response.headers.get('set-cookie').split(';')[0];
    const headers={origin,cookie,'content-type':'application/json','x-csrf-token':session.csrf};
    const read=async()=>{const result=await fetch(origin+'/api/state',{headers:{cookie}});assert.equal(result.status,200);return result.json();};
    const node=(t,c,a={})=>({t,a,c}),stockId=randomUUID(),seed=R.empty();
    seed.dom['#stockRows']=[node('tr',[
      node('td',['Articolo passivo']),node('td',['Materiali di consumo']),node('td',['12 pz']),
      node('td',['€ 15,00']),node('td',['—']),node('td',['DISPONIBILE'])
    ],{'data-cloud-id':stockId})];
    const imported=await fetch(origin+'/api/import',{method:'POST',headers,body:JSON.stringify({baseRevision:0,clientId:randomUUID(),mutationId:randomUUID(),state:seed})});
    assert.equal(imported.status,200,await imported.text());
    async function remoteEdit(edit){
      const before=await read(),next=structuredClone(before.state);edit(next);
      const result=await fetch(origin+'/api/changes',{method:'PUT',headers,body:JSON.stringify({protocol:2,clientId:randomUUID(),mutationId:randomUUID(),versions:before.versions,changes:R.diff(before.state,next,before.versions)})});
      assert.equal(result.status,200,await result.text());
      return read();
    }
    browser=await chromium.launch({...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}),headless:true});
    const page=await browser.newPage({viewport:{width:390,height:844}}),writes=[],errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    page.on('request',request=>{if(request.url()===origin+'/api/changes'&&request.method()==='PUT')writes.push(JSON.parse(request.postData()));});
    await page.goto(origin);await page.locator('#username').fill('passive-admin');await page.locator('#password').fill('test-password-1234');await page.locator('#loginForm button[type="submit"]').click();
    await page.waitForFunction(()=>document.querySelector('iframe')?.contentWindow?.WorkshopCloud?.initializing===false);
    await page.waitForTimeout(1100);
    assert.equal(writes.length,0,'logging in only normalizes the local display');
    const first=await remoteEdit(state=>{state.fields.shopName='Officina remota';});
    await page.waitForFunction(()=>document.querySelector('iframe')?.contentWindow?.document.getElementById('shopName')?.value==='Officina remota');
    await page.waitForTimeout(1600);
    assert.equal(writes.length,0,'a passive snapshot must not echo stock decorators or default empty fields');
    assert.equal((await read()).revision,first.revision);
    assert.equal(await page.locator('#mode').textContent(),'Modifica condivisa');
    console.log('PASS passive phone receives legacy stock and missing default fields without any write');

    // Keep a real local field edit while applying an unrelated peer record.
    // Host notification avoids the input settling window to exercise merge
    // while dirty, before the 650 ms save timer has fired.
    await page.evaluate(()=>{const source=document.querySelector('iframe').contentWindow;source.document.getElementById('shopPhone').value='3331234567';WorkshopCloudHost.changed(source);});
    const second=await remoteEdit(state=>{state.fields.shopName='Officina remota aggiornata';});
    await page.waitForFunction(()=>document.querySelector('iframe')?.contentWindow?.document.getElementById('shopName')?.value==='Officina remota aggiornata');
    await page.waitForTimeout(1700);
    const saved=await read();
    assert.equal(saved.state.fields.shopPhone,'3331234567','a local field absent from the raw server snapshot must remain pending');
    assert.equal(saved.state.fields.shopName,'Officina remota aggiornata');
    assert.equal(saved.revision,second.revision+1);
    assert.equal(writes.length,1);
    assert.deepEqual(writes[0].changes.map(change=>change.key),[R.key('field','shopPhone')]);
    assert.equal(writes[0].changes[0].expectedVersion,0);
    assert.equal(await page.locator('#mode').textContent(),'Modifica condivisa');
    console.log('PASS real unsaved local field survives normalization and is the only record committed');

    await page.evaluate(()=>{const source=document.querySelector('iframe').contentWindow;source.document.getElementById('shopPhone').value='3332222222';WorkshopCloudHost.changed(source);});
    const competing=await remoteEdit(state=>{state.fields.shopPhone='3339999999';});
    await page.waitForFunction(()=>document.getElementById('mode').textContent==='Modifiche sospese');
    assert.equal((await read()).revision,competing.revision,'a retained stale edit must not overwrite the winner');
    assert.equal((await read()).state.fields.shopPhone,'3339999999');
    assert.equal(await page.evaluate(()=>document.querySelector('iframe').contentWindow.document.getElementById('shopPhone').value),'3332222222');
    assert.equal(writes.length,2);
    assert.equal(writes[1].changes[0].expectedVersion,saved.versions[R.key('field','shopPhone')]);
    assert.deepEqual(writes[1].changes.map(change=>change.key),[R.key('field','shopPhone')]);
    assert.match(await page.locator('#notice').textContent(),/Conflitto di modifica/);
    assert.deepEqual(errors,[]);
    console.log('PASS a real same-record local edit retains its old version and conflicts without losing the draft');
  }finally{await browser?.close();await app.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
