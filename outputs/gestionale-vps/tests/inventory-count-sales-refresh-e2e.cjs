'use strict';
// A pre-sale GET finishing after our own acknowledgement cannot satisfy the
// authoritative refresh of server-adjusted counts, including review drafts.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {pathToFileURL}=require('node:url');
const path=require('node:path'),fs=require('node:fs'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict');

(async()=>{
  const root=path.resolve(__dirname,'..'),dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'officina-inventory-sales-refresh-'));
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));const origin=`http://127.0.0.1:${port}`;
  const {createApplication}=await import(pathToFileURL(path.join(root,'server/server.mjs'))),{addUser}=await import(pathToFileURL(path.join(root,'server/database.mjs')));
  const app=await createApplication({root,dataDir,origin,env:{NODE_ENV:'test'}});await addUser(app.db,'inventory-sales-refresh','test-password-1234','admin');await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[],product='205/55 R16 91V Michelin';
  page.on('pageerror',error=>errors.push(error.stack));page.on('dialog',dialog=>dialog.accept());
  const frame=()=>page.frames().find(item=>item.url().includes('/legacy'));
  const ready=()=>page.waitForFunction(()=>{const cloud=document.querySelector('iframe')?.contentWindow?.WorkshopCloud;return cloud&&!cloud.initializing&&!WorkshopCloudHost.synchronizing();},null,{timeout:15000});
  const flush=async()=>{for(let attempt=0;attempt<30;attempt++){try{return await page.evaluate(()=>WorkshopCloudHost.flush());}catch(error){if(!error.message.includes('Attendi il salvataggio in corso.')||attempt===29)throw error;await new Promise(resolve=>setTimeout(resolve,100));}}};
  const state=()=>JSON.parse(app.db.prepare('SELECT payload FROM state WHERE id=1').get().payload);
  const draft=()=>JSON.parse(state().storage['officina.inventory.v1']||'{}').countDraft;
  const text=node=>typeof node==='string'?node:(node.c||[]).map(text).join('');
  const quantity=()=>Number(state().dom['#stockRows'].find(row=>text(row.c[0]).trim()===product).a['data-quantity']);
  const counted=()=>draft().items.find(item=>item.product===product);
  const navigate=async view=>{await frame().locator(`.nav [data-view="${view}"]`).click();await ready();};
  let releaseOldGet,releaseMiddleGet,freshStockDiagnosis;
  try{
    await page.goto(origin);await page.locator('#username').fill('inventory-sales-refresh');await page.locator('#password').fill('test-password-1234');await page.locator('#loginForm button[type="submit"]').click();await ready();
    await navigate('magazzino');let f=frame();await f.locator('#magazzino [data-cloud-open="stockModal"]').click();await f.locator('#stockProduct').fill(product);await f.locator('#stockCategory').selectOption('Pneumatici estivi');await f.locator('#stockQuantity').fill('12');await f.locator('#stockPrice').fill('50');await f.locator('#stockForm button[type="submit"]').click();await flush();
    await navigate('parking');f=frame();await f.locator('.parking-head [data-cloud-open="parkingModal"]').click();await f.locator('#parkCustomer').fill('Vendita durante resoconto');await f.locator('#parkPlate').fill('RI123AA');await f.locator('#parkVehicle').fill('Auto di prova');await f.locator('#parkWork').fill('2 '+product);await f.locator('#parkWorkAmount').fill('150');await f.locator('#parkStatus').selectOption('IN LAVORAZIONE');await f.locator('#parkingForm button[type="submit"]').click();await flush();await ready();
    await navigate('magazzino');f=frame();await f.locator('#inventoryCountStart').click();await f.locator('#inventoryCountList [data-count-quantity]').fill('10');await flush();await f.locator('#inventoryCountReview').click();await f.locator('#inventoryCountApply').waitFor();await flush();assert.equal(draft().status,'review');await f.locator('#inventoryCountClose').click();await navigate('parking');f=frame();

    let announceOldGet,announceMiddleGet,oldRevision,middleRevision,acknowledgedRevision,ordinaryAcknowledgedRevision,generatedAcknowledgement=false,freshResponses=0,held=false,middleHeld=false;
    const noteKey='inventory-refresh-confirmed-note',noteText='Nota confermata dopo la vendita';
    const capturedOldGet=new Promise(resolve=>{announceOldGet=resolve;});
    const oldGetGate=new Promise(resolve=>{releaseOldGet=resolve;});
    const capturedMiddleGet=new Promise(resolve=>{announceMiddleGet=resolve;});
    const middleGetGate=new Promise(resolve=>{releaseMiddleGet=resolve;});
    await page.route('**/api/state',async route=>{
      if(!held){
        held=true;const headers={...route.request().headers()};delete headers['if-none-match'];const response=await route.fetch({headers}),body=await response.json();oldRevision=body.revision;announceOldGet();
        await oldGetGate;await route.fulfill({response,status:200,body:JSON.stringify(body)});return;
      }
      const response=await route.fetch();if(generatedAcknowledgement&&response.status()===200){const body=await response.json();
        if(!middleHeld){middleHeld=true;middleRevision=body.revision;announceMiddleGet();await middleGetGate;await route.fulfill({response,body:JSON.stringify(body)});return;}
        if(body.revision>=ordinaryAcknowledgedRevision)freshResponses++;
      }await route.fulfill({response});
    });
    await page.route('**/api/changes',async route=>{
      const response=await route.fetch(),body=await response.json();
      if(body.serverGeneratedChanges===true){generatedAcknowledgement=true;acknowledgedRevision=body.revision;}
      else if(route.request().postDataJSON().changes.some(change=>change.key===JSON.stringify(['entry','officina-work-notes',noteKey])))ordinaryAcknowledgedRevision=body.revision;
      await route.fulfill({response,body:JSON.stringify(body)});
    });
    await page.evaluate(()=>{document.dispatchEvent(new Event('visibilitychange'));});await capturedOldGet;
    await page.evaluate(()=>{
      window.__salesRefreshStatus=[];window.__salesRefreshObserver=new MutationObserver(()=>window.__salesRefreshStatus.push(document.getElementById('status').textContent));
      window.__salesRefreshObserver.observe(document.getElementById('status'),{childList:true,subtree:true,characterData:true});
    });
    await f.locator('.parking-row').filter({hasText:'Vendita durante resoconto'}).locator('.parking-status').selectOption('COMPLETATO');await flush();
    assert.equal(generatedAcknowledgement,true,'the originating sale acknowledges server-derived inventory changes');assert.ok(acknowledgedRevision>oldRevision,'the held GET predates the committed sale');assert.equal(quantity(),10);assert.equal(counted().countedQuantity,8);assert.equal(draft().status,'review');
    releaseOldGet();releaseOldGet=null;
    await capturedMiddleGet;assert.equal(middleRevision,acknowledgedRevision,'the next held snapshot includes the sale but predates the following ordinary edit');
    await f.evaluate(({noteKey,noteText})=>{
      window.__salesRefreshNotes=[];window.addEventListener('workshop-cloud-snapshot-applied',event=>window.__salesRefreshNotes.push({revision:event.detail.revision,note:JSON.parse(localStorage.getItem('officina-work-notes')||'{}')[noteKey]??null}));
      const notes=JSON.parse(localStorage.getItem('officina-work-notes')||'{}');notes[noteKey]=noteText;localStorage.setItem('officina-work-notes',JSON.stringify(notes));
    },{noteKey,noteText});await flush();
    assert.ok(ordinaryAcknowledgedRevision>middleRevision);assert.equal(JSON.parse(state().storage['officina-work-notes'])[noteKey],noteText);
    releaseMiddleGet();releaseMiddleGet=null;
    await f.waitForFunction(({product})=>WorkshopInventoryCount.draft()?.items.find(item=>item.product===product)?.countedQuantity===8,{product},{timeout:15000});await ready();
    assert.ok(freshResponses>0,'the originating device fetches the acknowledged revision after discarding the delayed old GET');
    const snapshotNotes=await f.evaluate(()=>window.__salesRefreshNotes);assert.ok(snapshotNotes.length>0);assert.ok(snapshotNotes.every(snapshot=>snapshot.revision>=ordinaryAcknowledgedRevision&&snapshot.note===noteText),'a pre-note snapshot cannot temporarily remove a successfully acknowledged ordinary edit');
    assert.equal(await f.evaluate(noteKey=>JSON.parse(localStorage.getItem('officina-work-notes')||'{}')[noteKey],noteKey),noteText);
    const statuses=await page.evaluate(()=>{window.__salesRefreshObserver.disconnect();return window.__salesRefreshStatus;});
    assert.ok(!statuses.some(value=>value.includes(`Revisione ${oldRevision} ·`)),'an obsolete snapshot cannot be reported as the completed authoritative refresh');assert.equal(await page.locator('#mode').innerText(),'Modifica condivisa');
    await page.unroute('**/api/state');await page.unroute('**/api/changes');
    console.log('PASS delayed old GETs crossing own-sale and ordinary-note acknowledgements are rejected; adjusted count and confirmed note stay visible');

    await navigate('magazzino');f=frame();await f.locator('#inventoryCountStart').click();await f.locator('#inventoryCountApply').waitFor();
    assert.equal(await f.locator('#inventoryCountTitle').innerText(),'Resoconto inventario');assert.equal(counted().countInput,'8');assert.equal(counted().expectedQuantity,10);assert.ok(!counted().needsRecount);assert.match(await f.locator('#inventoryCountReport').innerText(),/8 pz/);
    await f.locator('#inventoryCountApply').click();await f.waitForFunction(()=>WorkshopInventoryCount.draft()?.status==='applied');await flush();assert.equal(quantity(),8);assert.equal(draft().status,'applied');assert.deepEqual(errors,[]);
    console.log('PASS a sale adjusts a review draft and its final application preserves the remaining physical count; no browser errors');

    // New stock may acquire its tyre identity only when its first work is
    // entered, after the physical count was already saved. That read-only
    // identity upgrade must not prevent the subsequent actual sale adjustment.
    await f.locator('#inventoryCountDone').click();const freshProduct='225/45 R17 91W Pirelli';
    await f.locator('#magazzino [data-cloud-open="stockModal"]').click();await f.locator('#stockProduct').fill(freshProduct);await f.locator('#stockCategory').selectOption('Pneumatici estivi');await f.locator('#stockQuantity').fill('12');await f.locator('#stockPrice').fill('70');await f.locator('#stockForm button[type="submit"]').click();await flush();
    const freshRow=()=>state().dom['#stockRows'].find(row=>text(row.c[0]).trim()===freshProduct);
    const freshItem=()=>draft().items.find(item=>item.product===freshProduct);
    const freshKey=JSON.stringify(['row','#stockRows',freshRow().a['data-cloud-id']]);
    const stockVersion=()=>app.db.prepare('SELECT revision FROM record_versions WHERE key=?').get(freshKey)?.revision||0;
    await f.locator('#inventoryCountStart').click();await f.locator('.inventory-count-row').filter({hasText:freshProduct}).locator('[data-count-quantity]').fill('10');await flush();await f.locator('#inventoryCountReview').click();await f.locator('#inventoryCountApply').waitFor();await flush();await f.locator('#inventoryCountClose').click();await navigate('parking');f=frame();
    const beforeWork=structuredClone(freshRow()),beforeWorkVersion=stockVersion(),beforeWorkBase=draft().baseStockVersions[freshKey],requests=[];
    await page.route('**/api/changes',async route=>{const request=route.request().postDataJSON(),response=await route.fetch(),body=await response.json();requests.push({keys:request.changes.map(change=>change.key),result:body});await route.fulfill({response,body:JSON.stringify(body)});});
    await f.locator('.parking-head [data-cloud-open="parkingModal"]').click();await f.locator('#parkCustomer').fill('Prima vendita dopo inventario nuovo articolo');await f.locator('#parkPlate').fill('RI124AA');await f.locator('#parkVehicle').fill('Auto di prova');await f.locator('#parkWork').fill('2 '+freshProduct);await f.locator('#parkWorkAmount').fill('200');await f.locator('#parkStatus').selectOption('IN LAVORAZIONE');await f.locator('#parkingForm button[type="submit"]').click();await flush();await ready();
    const afterWork=structuredClone(freshRow());freshStockDiagnosis={beforeWorkVersion,afterWorkVersion:stockVersion(),beforeWorkBase,afterWorkBase:draft().baseStockVersions[freshKey],attrs:Object.fromEntries([...new Set([...Object.keys(beforeWork.a),...Object.keys(afterWork.a)])].filter(key=>beforeWork.a[key]!==afterWork.a[key]).map(key=>[key,{before:beforeWork.a[key]??null,after:afterWork.a[key]??null}])),cells:beforeWork.c.map((cell,index)=>JSON.stringify(cell)!==JSON.stringify(afterWork.c[index])?{index,before:cell,after:afterWork.c[index]}:null).filter(Boolean),creationRequestKeys:requests.map(request=>request.keys)};
    assert.deepEqual(Object.keys(freshStockDiagnosis.attrs),['data-tyre-stock-id']);assert.deepEqual(freshStockDiagnosis.cells,[]);assert.equal(beforeWorkBase,beforeWorkVersion);assert.equal(freshStockDiagnosis.afterWorkBase,freshStockDiagnosis.afterWorkVersion,'the harmless lookup identity assignment updates only the draft baseline');assert.equal(freshItem().countedQuantity,10);
    const beforeSaleRequests=requests.length;await f.locator('.parking-row').filter({hasText:'Prima vendita dopo inventario nuovo articolo'}).locator('.parking-status').selectOption('COMPLETATO');await flush();
    freshStockDiagnosis.saleRequests=requests.slice(beforeSaleRequests);freshStockDiagnosis.savedDraftItem=freshItem();
    assert.ok(requests.slice(beforeSaleRequests).some(request=>request.result.serverGeneratedChanges===true),'the first sale after a new article was counted acknowledges its derived count adjustment');
    assert.equal(Number(freshRow().a['data-quantity']),10);assert.equal(freshItem().countedQuantity,8);assert.equal(freshItem().expectedQuantity,10);assert.ok(!freshItem().needsRecount);
    await f.waitForFunction(({freshProduct})=>WorkshopInventoryCount.draft()?.items.find(item=>item.product===freshProduct)?.countedQuantity===8,{freshProduct},{timeout:15000});await page.unroute('**/api/changes');assert.deepEqual(errors,[]);
    console.log('PASS first work entered after counting a fresh tyre still deducts its first sale from the draft');
  }catch(error){console.error('INVENTORY SALES REFRESH DIAGNOSTIC',JSON.stringify({freshStockDiagnosis,mode:await page.locator('#mode').textContent(),status:await page.locator('#status').textContent(),notice:await page.locator('#notice').textContent()}));throw error;}
  finally{releaseOldGet?.();releaseMiddleGet?.();await browser.close();await app.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
