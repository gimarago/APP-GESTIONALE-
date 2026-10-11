'use strict';
// Real work completion/reversal while a shared physical-count draft exists.
// Uses an isolated server, synthetic stock and separate desktop/mobile logins.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {pathToFileURL}=require('node:url');
const path=require('node:path'),fs=require('node:fs'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict');

(async()=>{
  const root=path.resolve(__dirname,'..'),dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'officina-inventory-sales-'));
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));const origin=`http://127.0.0.1:${port}`;
  const {createApplication}=await import(pathToFileURL(path.join(root,'server/server.mjs'))),{addUser}=await import(pathToFileURL(path.join(root,'server/database.mjs')));
  const app=await createApplication({root,dataDir,origin,env:{NODE_ENV:'test'}});await addUser(app.db,'inventory-sales','test-password-1234','admin');await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})}),errors=[];
  const product='205/55 R16 91V Michelin',other='Ricambio indipendente dal conteggio';
  const frame=page=>page.frames().find(item=>item.url().includes('/legacy'));
  const ready=page=>page.waitForFunction(()=>{const cloud=document.querySelector('iframe')?.contentWindow?.WorkshopCloud;return cloud&&!cloud.initializing&&!WorkshopCloudHost.synchronizing();},null,{timeout:15000});
  const flush=page=>page.evaluate(()=>WorkshopCloudHost.flush());
  const state=()=>JSON.parse(app.db.prepare('SELECT payload FROM state WHERE id=1').get().payload);
  const draft=()=>JSON.parse(state().storage['officina.inventory.v1']||'{}').countDraft;
  const text=node=>typeof node==='string'?node:(node.c||[]).map(text).join('');
  const stock=()=>state().dom['#stockRows'].find(row=>text(row.c[0]).trim()===product);
  const quantity=()=>Number(stock().a['data-quantity']);
  const counted=()=>draft().items.find(item=>item.product===product);
  const navigate=async(page,view)=>{await frame(page).locator(`.nav [data-view="${view}"]`).click();await ready(page);};
  const countInput=(page,name)=>frame(page).locator('.inventory-count-row').filter({hasText:name}).locator('[data-count-quantity]');
  async function login(mobile=false){const context=await browser.newContext(mobile?{viewport:{width:390,height:844},isMobile:true,hasTouch:true}:{viewport:{width:1366,height:900}}),page=await context.newPage();page.on('pageerror',error=>errors.push(error.stack));page.on('dialog',dialog=>dialog.accept());await page.goto(origin);await page.locator('#username').fill('inventory-sales');await page.locator('#password').fill('test-password-1234');await page.locator('#loginForm button[type="submit"]').click();await ready(page);return page;}
  async function addStock(page,name,count){await navigate(page,'magazzino');const f=frame(page);await f.locator('#magazzino [data-cloud-open="stockModal"]').click();await f.locator('#stockProduct').fill(name);await f.locator('#stockCategory').selectOption(name===product?'Pneumatici estivi':'Ricambi meccanica');await f.locator('#stockQuantity').fill(String(count));await f.locator('#stockPrice').fill('50');await f.locator('#stockForm button[type="submit"]').click();await flush(page);}
  async function sell(page,customer){await navigate(page,'parking');const f=frame(page);await f.locator('.parking-head [data-cloud-open="parkingModal"]').click();await f.locator('#parkCustomer').fill(customer);await f.locator('#parkPlate').fill('IV123AA');await f.locator('#parkVehicle').fill('Auto di prova');await f.locator('#parkWork').fill('2 '+product);await f.locator('#parkWorkAmount').fill('150');await f.locator('#parkStatus').selectOption('IN LAVORAZIONE');await f.locator('#parkingForm button[type="submit"]').click();await flush(page);await f.locator('.parking-row').filter({hasText:customer}).locator('.parking-status').selectOption('COMPLETATO');await flush(page);}
  async function localCount(page,expected){await frame(page).waitForFunction(({product,expected})=>WorkshopInventoryCount.draft()?.items.find(item=>item.product===product)?.countedQuantity===expected,{product,expected},{timeout:15000});await ready(page);assert.equal(await page.locator('#mode').innerText(),'Modifica condivisa');}
  try{
    const counter=await login();await addStock(counter,product,12);await addStock(counter,other,5);
    const seller=await login(true);await navigate(counter,'magazzino');await frame(counter).locator('#inventoryCountStart').click();await countInput(counter,product).fill('10');await countInput(counter,other).fill('4');await flush(counter);assert.equal(counted().countedQuantity,10);
    await sell(seller,'Prima vendita dopo la conta');assert.equal(quantity(),10);assert.equal(counted().countedQuantity,8);assert.equal(counted().expectedQuantity,10);assert.ok(!counted().needsRecount);
    await localCount(seller,8);await localCount(counter,8);assert.equal(await countInput(counter,product).inputValue(),'8');assert.equal(draft().items.find(item=>item.product===other).countedQuantity,4);
    console.log('PASS sale updates both open inventory count and selling mobile device exactly once, preserving the physical discrepancy and other counts');

    await frame(counter).locator('#inventoryCountClose').click();await sell(seller,'Seconda vendita con bozza chiusa');assert.equal(quantity(),8);assert.equal(counted().countedQuantity,6);await localCount(counter,6);await localCount(seller,6);
    await frame(counter).locator('#inventoryCountStart').click();assert.equal(await countInput(counter,product).inputValue(),'6');assert.ok(!counted().needsRecount);await frame(counter).locator('#inventoryCountClose').click();
    console.log('PASS a closed draft receives a second sale and resumes with the adjusted quantity');

    // The same device that owns the inventory performs the reversal. Its own
    // acknowledgement must fetch generated count changes without a peer edit.
    await navigate(counter,'parking');await frame(counter).locator('.parking-row').filter({hasText:'Prima vendita dopo la conta'}).locator('.parking-status').selectOption('IN LAVORAZIONE');await flush(counter);
    assert.equal(quantity(),10);assert.equal(counted().countedQuantity,8);await localCount(counter,8);await localCount(seller,8);
    await counter.reload();await ready(counter);await navigate(counter,'magazzino');await frame(counter).locator('#inventoryCountStart').click();assert.equal(await countInput(counter,product).inputValue(),'8');
    console.log('PASS reversal restores the counted quantity on its originating device and survives reload');

    await frame(counter).locator('#inventoryCountReview').click();await frame(counter).locator('#inventoryCountApply').waitFor();await frame(counter).locator('#inventoryCountApply').click();await frame(counter).waitForFunction(()=>document.getElementById('inventoryCountStatus')?.textContent==='Inventario applicato e salvato sul server.');assert.equal(quantity(),8);assert.equal(draft().status,'applied');
    assert.equal(Number(state().dom['#stockRows'].find(row=>text(row.c[0]).trim()===other).a['data-quantity']),4);
    assert.deepEqual(errors,[]);console.log('PASS final inventory uses the adjusted count without restoring sold stock; no browser errors');
  }catch(error){console.error('INVENTORY SALES DIAGNOSTIC',JSON.stringify({quantity:quantity(),draft:draft(),pages:await Promise.all(browser.contexts().map(context=>context.pages()[0]?.evaluate(()=>({mode:document.getElementById('mode')?.textContent,notice:document.getElementById('notice')?.textContent,inventoryError:document.querySelector('iframe')?.contentDocument?.getElementById('inventoryCountError')?.textContent}))))}));throw error;}
  finally{await browser.close();await app.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
