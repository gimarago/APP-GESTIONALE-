'use strict';
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {pathToFileURL}=require('node:url');
const path=require('node:path'),fs=require('node:fs'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict');

(async()=>{
  const root=path.resolve(__dirname,'..'),dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'officina-conflict-ui-'));
  const probe=net.createServer();await new Promise(ok=>probe.listen(0,'127.0.0.1',ok));const port=probe.address().port;await new Promise(ok=>probe.close(ok));
  const origin=`http://127.0.0.1:${port}`;
  const {createApplication}=await import(pathToFileURL(path.join(root,'server/server.mjs')));
  const {addUser}=await import(pathToFileURL(path.join(root,'server/database.mjs')));
  const app=await createApplication({root,dataDir,origin,env:{NODE_ENV:'test'}});
  await addUser(app.db,'Alessio-Test','test-password-1234','admin');
  await addUser(app.db,'Pina-Test','test-password-1234','operator');
  await new Promise(ok=>app.server.listen(port,'127.0.0.1',ok));
  const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const errors=[],failedAssets=[],contexts=[];
  const frame=page=>page.frames().find(f=>f.url().includes('/legacy'));
  const ready=page=>page.waitForFunction(()=>{
    const cloud=document.querySelector('iframe')?.contentWindow?.WorkshopCloud;
    return cloud&&!cloud.initializing&&!WorkshopCloudHost.synchronizing();
  });
  const flush=page=>page.evaluate(()=>WorkshopCloudHost.flush());
  const saved=()=>app.db.prepare('SELECT revision,payload FROM state WHERE id=1').get();
  const row=(page,name)=>frame(page).locator('#stockRows tr').filter({hasText:name});
  const quantity=(page,name)=>row(page,name).locator('.qty-adjust b').innerText().then(Number);
  async function restockOne(page,name){const f=frame(page);await row(page,name).locator('[data-stock-quantity-action="increase"]').click();await f.locator('#stockRestockModal').waitFor({state:'visible'});const cost=await f.evaluate(name=>{const item=[...document.querySelectorAll('#stockRows tr')].find(row=>row.cells[0]?.textContent.trim()===name),text=item?.cells[3]?.textContent||'';return /\d/.test(text)?stockInventoryApi.numberFrom(text):0;},name);await f.locator('#stockRestockUnitPrice').fill(String(cost));const prior=f.locator('#stockRestockPriorCost');if(await prior.isVisible())await prior.fill(String(cost));await f.locator('#stockRestockForm button[type="submit"]').click();await f.locator('#stockRestockModal').waitFor({state:'hidden'});}
  async function login(username){
    const context=await browser.newContext({viewport:{width:1366,height:900},acceptDownloads:true});contexts.push(context);
    const page=await context.newPage();page.on('pageerror',error=>errors.push(error.stack));
    page.on('response',response=>{if(response.url().includes('cloud-conflict')&&response.status()>=400)failedAssets.push(response.url());});
    await page.goto(origin);await page.locator('#username').fill(username);await page.locator('#password').fill('test-password-1234');
    await page.locator('#loginForm button[type="submit"]').click();await ready(page);
    await frame(page).locator('.nav [data-view="magazzino"]').click();await ready(page);
    return page;
  }
  async function createStock(page,name){
    const f=frame(page);await f.locator('#magazzino [data-cloud-open="stockModal"]').click();
    await f.locator('#stockProduct').fill(name);await f.locator('#stockCategory').selectOption({index:1});
    await f.locator('#stockQuantity').fill('5');await f.locator('#stockForm button[type="submit"]').click();await flush(page);
  }
  async function editStock(page,name,nextName,qty){
    await row(page,name).locator('td').first().click();const f=frame(page);
    await f.locator('#editStockProduct').fill(nextName);await f.locator('#editStockQuantity').fill(String(qty));
    await f.locator('#stockEditForm button[type="submit"]').click();await flush(page);
  }
  async function conflict(page,name){
    const before=saved(),marker=await frame(page).evaluate(()=>window.conflictTestFrame=crypto.randomUUID());
    const f=frame(page);
    if(await f.locator('#stockEditModal.open').count()){
      await f.locator('#editStockQuantity').fill(String((await quantity(page,name))+1));
      await f.locator('#stockEditForm button[type="submit"]').click();
    }else await restockOne(page,name);
    const result=await page.evaluate(async()=>{try{await WorkshopCloudHost.flush();return null;}catch(error){return error.message;}});
    assert.ok(result,'a conflicting save must reject its flush');
    await page.locator('#conflictDialog[open]').waitFor();
    assert.equal(await page.locator('#mode').innerText(),'Modifiche sospese');
    assert.equal(await frame(page).evaluate(()=>window.conflictTestFrame),marker,'the losing draft stays in its original iframe');
    assert.deepEqual(saved(),before,'the losing batch must never overwrite the committed server snapshot');
    const draft=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('officina.cloud.draft.v1')));
    assert.ok(draft.state&&draft.pending,'the complete local draft is retained');
    assert.ok(draft.conflictReport?.cards.length,'the draft carries its concise conflict report');
    return {report:await page.evaluate(()=>WorkshopCloudConflicts.report()),draft};
  }
  async function reload(page,{simulateArchiveFull=false}={}){
    const oldMarker=await frame(page).evaluate(()=>window.conflictTestFrame);
    if(simulateArchiveFull)await page.evaluate(()=>{window.__savedStorageSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(String(key).startsWith('officina.cloud.archived-draft.'))throw new DOMException('Quota exceeded','QuotaExceededError');return window.__savedStorageSetItem.call(this,key,value);};});
    const confirmation=new Promise(resolve=>page.once('dialog',async dialog=>{assert.equal(dialog.type(),'confirm');await dialog.accept();resolve();}));
    await page.locator('#conflictReload').click();await confirmation;
    await page.waitForFunction(()=>document.getElementById('mode').textContent==='Modifica condivisa');await ready(page);
    assert.notEqual(await frame(page).evaluate(()=>window.conflictTestFrame),oldMarker,'only an explicit server reload creates a new frame');
    assert.equal(await page.locator('#conflictDialog').getAttribute('open'),null);
    assert.equal(await page.locator('#conflictDetails').isVisible(),false);
    assert.equal(await page.evaluate(()=>WorkshopCloudConflicts.report()),null,'the obsolete active report is cleared after reload');
    const archived=await page.evaluate(()=>Object.keys(sessionStorage).filter(k=>k.startsWith('officina.cloud.archived-draft.')).map(k=>JSON.parse(sessionStorage.getItem(k))));
    if(simulateArchiveFull){
      assert.match(await page.locator('#notice').innerText(),/Dati del server ricaricati/,'the app reloads even when the archive cannot hold another copy');
      const active=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('officina.cloud.draft.v1')));
      assert.ok(active?.conflictReport?.cards.length&&active.pending&&active.state,'the current tab still holds the conflicted draft');
      assert.equal(await page.locator('#recover').isVisible(),true,'the download action remains available after a full archive');
      const downloadPromise=page.waitForEvent('download');await page.locator('#recover').click();const download=await downloadPromise;
      const file=path.join(dataDir,'recovered-drafts.json');await download.saveAs(file);
      const recovery=JSON.parse(fs.readFileSync(file,'utf8'));
      assert.ok(recovery.drafts.some(draft=>draft.conflictReport?.cards.length&&draft.pending&&draft.state),'the download includes the retained conflict draft');
      assert.match(await page.locator('#notice').innerText(),/Bozza scaricata/);
      await page.evaluate(()=>{Storage.prototype.setItem=window.__savedStorageSetItem;delete window.__savedStorageSetItem;});
    }else assert.ok(archived.some(draft=>draft.conflictReport?.cards.length&&draft.pending&&draft.state),'archiving retains both the draft and its explanation');
    return archived;
  }
  try{
    const a=await login('Alessio-Test');
    const rawName='Batteria confronto',safeName='Batteria <img src=x onerror="window.conflictXss=1">',deleted='Ricambio eliminato da altro utente',legacy='Ricambio senza autore precedente';
    await createStock(a,rawName);await createStock(a,deleted);await createStock(a,legacy);
    // The editor intentionally stores this product as text. The conflict UI
    // must display the same text without interpreting it as active markup.
    await editStock(a,rawName,safeName,5);
    const b=await login('Pina-Test');assert.equal(await quantity(b,safeName),5);
    // Both operators edit the same article. Live synchronization protects the
    // open form, so its original record version must still fence this save.
    await row(b,safeName).locator('td').first().click();
    await editStock(a,safeName,safeName,7);
    assert.equal(await quantity(b,safeName),5,'an open edit keeps its original version for conflict checking');
    const first=await conflict(b,safeName),card=first.report.cards.find(c=>c.title.includes(safeName));
    assert.ok(card);assert.equal(card.updatedBy,'Alessio-Test');assert.ok(card.updatedAt>0);
    assert.deepEqual(card.changes.find(c=>c.key==='quantity'),{key:'quantity',label:'Quantità',before:'5',after:'7'});
    assert.deepEqual(card.comparison.find(c=>c.key==='quantity'),{key:'quantity',label:'Quantità',previous:'5',server:'7',proposed:'6'});
    assert.match(await b.locator('#conflictCards').innerText(),/Alessio-Test ha aggiornato questa voce/);
    assert.equal(await b.locator('#conflictCards img, #conflictCards script').count(),0,'product text cannot add HTML to the report');
    assert.equal(await b.evaluate(()=>window.conflictXss),undefined);
    assert.equal(await frame(b).evaluate(()=>window.conflictXss),undefined);
    assert.equal(await quantity(b,safeName),6,'the local quantity remains available for comparison');
    const downloadPromise=b.waitForEvent('download');await b.locator('#conflictDownload').click();const download=await downloadPromise;
    assert.equal(download.suggestedFilename(),'officina-confronto-modifiche.json');
    const reportFile=path.join(dataDir,'comparison.json');await download.saveAs(reportFile);
    const compactText=fs.readFileSync(reportFile,'utf8'),compact=JSON.parse(compactText);
    assert.equal(compact.format,'officina-conflict-report');assert.deepEqual(compact.cards,first.report.cards);
    assert.ok(Buffer.byteLength(compactText)<100*1024,'a single affected article has a small standalone comparison');
    for(const property of ['state','forms','pending','versions'])assert.equal(Object.hasOwn(compact,property),false,'comparison downloads contain no full archive');
    assert.doesNotMatch(compactText,/"t"\s*:\s*"(?:tr|td)"|"csrf"|"password"/);
    await b.locator('#conflictDialog .conflict-heading button').click();assert.equal(await b.locator('#conflictDialog[open]').count(),0);
    await b.locator('#conflictDetails').click();await b.locator('#conflictDialog[open]').waitFor();
    await b.setViewportSize({width:390,height:844});const bounds=await b.locator('#conflictDialog').boundingBox();
    assert.ok(bounds.x>=0&&bounds.x+bounds.width<=390,'the comparison fits a phone viewport');
    assert.equal(await b.evaluate(()=>document.querySelector('#conflictDialog').scrollWidth<=document.querySelector('#conflictDialog').clientWidth),true);
    assert.equal(await b.locator('#conflictCards td').first().evaluate(node=>getComputedStyle(node).display),'block','phone comparisons use readable stacked values');
    await b.screenshot({path:path.resolve(root,'../../work/conflict-details-mobile.png'),fullPage:true});
    const archives=await reload(b);assert.deepEqual(archives[0].conflictReport,first.report);
    assert.equal(await quantity(b,safeName),7,'explicit reload displays the committed peer quantity');
    console.log('PASS two-device conflict: product, author, time, before/server/proposed values, compact report, saved draft, mobile and escaped text');

    await row(b,safeName).locator('td').first().click();
    await editStock(a,safeName,safeName,9);
    const beforeDelayed=saved(),delayedMarker=await frame(b).evaluate(()=>window.conflictTestFrame=crypto.randomUUID());
    let release409,received409,held409=false;
    const responseGate=new Promise(resolve=>release409=resolve),responseReady=new Promise(resolve=>received409=resolve);
    await b.route('**/api/changes',async route=>{
      if(route.request().method()==='PUT'&&!held409){
        held409=true;const response=await route.fetch();assert.equal(response.status(),409);
        received409();await responseGate;await route.fulfill({response});
      }else await route.continue();
    });
    // A normal autosave leaves editing enabled while its response travels.
    // The report must compare the current local draft, not just that first
    // request's older proposal.
    await frame(b).locator('#editStockQuantity').fill('8');
    await frame(b).locator('#stockEditForm button[type="submit"]').click();
    await responseReady;
    assert.equal(await quantity(b,safeName),8);
    await restockOne(b,safeName);
    await restockOne(b,safeName);
    assert.equal(await quantity(b,safeName),10);release409();
    await b.locator('#conflictDialog[open]').waitFor();await b.unroute('**/api/changes');
    assert.equal(await frame(b).evaluate(()=>window.conflictTestFrame),delayedMarker);
    assert.deepEqual(saved(),beforeDelayed);
    const delayed=await b.evaluate(()=>({report:WorkshopCloudConflicts.report(),draft:JSON.parse(sessionStorage.getItem('officina.cloud.draft.v1'))}));
    const delayedCard=delayed.report.cards.find(c=>c.title.includes(safeName));
    assert.equal(delayedCard.comparison.find(c=>c.key==='quantity').proposed,'10','the explanation follows edits made after submission');
    const pendingRow=delayed.draft.pending.data.changes.find(change=>change.key===delayedCard.key).value;
    assert.equal(pendingRow.a['data-quantity'],'8','the original failed request is still preserved exactly');
    assert.equal(delayed.draft.state.dom['#stockRows'].find(item=>item.a['data-cloud-id']===pendingRow.a['data-cloud-id']).a['data-quantity'],'10');
    await reload(b,{simulateArchiveFull:true});assert.equal(await quantity(b,safeName),9);
    console.log('PASS a delayed conflict response compares later local edits while preserving the original rejected submission');

    // Remove only the isolated test article through the same observed DOM
    // mutation and save path used by record deletions; no external DB changes.
    await row(b,deleted).locator('td').first().click();
    await frame(a).evaluate(name=>{const item=[...document.querySelectorAll('#stockRows tr')].find(r=>r.cells[0]?.textContent.includes(name));item.remove();},deleted);
    await flush(a);assert.equal(await row(b,deleted).count(),1);
    const deletion=await conflict(b,deleted),deletedCard=deletion.report.cards.find(c=>c.title.includes(deleted));
    assert.equal(deletedCard.updatedBy,'Alessio-Test');assert.match(await b.locator('#conflictCards').innerText(),/Eliminata/);
    await reload(b);assert.equal(await row(b,deleted).count(),0);
    console.log('PASS peer deletion explains the removed record without restoring it');

    await row(b,legacy).locator('td').first().click();
    await editStock(a,legacy,legacy,8);
    // Simulate an old deployment with no attribution in the TEMPORARY audit
    // archive. The row version and committed business state remain intact.
    const last=app.db.prepare("SELECT id FROM audit WHERE action='records-saved' ORDER BY id DESC LIMIT 1").get();
    app.db.prepare('DELETE FROM audit WHERE id=?').run(last.id);
    const unknown=await conflict(b,legacy),unknownCard=unknown.report.cards.find(c=>c.title.includes(legacy));
    assert.equal(unknownCard.updatedBy,null);assert.equal(unknownCard.updatedAt,null);assert.deepEqual(unknownCard.changes,[]);
    assert.equal(unknownCard.comparison.find(c=>c.key==='quantity').server,'8');
    assert.match(await b.locator('#conflictCards').innerText(),/Autore non disponibile/);
    assert.match(await b.locator('#conflictCards').innerText(),/dettaglio della modifica precedente non è disponibile/);
    console.log('PASS historical changes without audit show honest unknown attribution and current server values');
    assert.deepEqual(failedAssets,[]);assert.deepEqual(errors,[]);
  }finally{
    await Promise.all(contexts.map(context=>context.close()));await browser.close();await app.close();
    const target=path.resolve(dataDir);assert.ok(target.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(target).startsWith('officina-conflict-ui-'));
    fs.rmSync(target,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
