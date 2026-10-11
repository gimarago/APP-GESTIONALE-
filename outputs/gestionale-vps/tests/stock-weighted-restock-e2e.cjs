const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {pathToFileURL}=require('node:url');
const path=require('node:path'),fs=require('node:fs'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict');

(async()=>{
 const root=path.resolve(__dirname,'..'),dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'officina-weighted-restock-'));
 const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
 const origin='http://127.0.0.1:'+port;
 const {createApplication}=await import(pathToFileURL(path.join(root,'server/server.mjs')));
 const {addUser}=await import(pathToFileURL(path.join(root,'server/database.mjs')));
 const app=await createApplication({root,dataDir,origin,env:{NODE_ENV:'test'}});await addUser(app.db,'weighted-restock-test','test-password-1234','admin');
 await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',error=>errors.push(error.stack));
 const frame=()=>page.frames().find(item=>item.url().includes('/legacy'));
 const ready=()=>page.waitForFunction(()=>document.querySelector('iframe')?.contentWindow?.WorkshopCloud?.initializing===false);
 const flush=()=>page.evaluate(()=>WorkshopCloudHost.flush());
 const payload=()=>JSON.parse(app.db.prepare('SELECT payload FROM state').get().payload);
 async function addStock(name,quantity,price='',profit=''){
  const f=frame();await f.locator('#magazzino [data-cloud-open="stockModal"]').click();await f.locator('#stockProduct').fill(name);await f.locator('#stockCategory').selectOption({index:1});await f.locator('#stockQuantity').fill(String(quantity));
  if(price!=='')await f.locator('#stockPrice').fill(String(price));if(profit!=='')await f.locator('#stockUnitProfit').fill(String(profit));
  await f.locator('#stockForm button[type="submit"]').click();await flush();await f.locator('#stockRows tr').filter({hasText:name}).waitFor();
 }
 try{
  await page.goto(origin);await page.locator('#username').fill('weighted-restock-test');await page.locator('#password').fill('test-password-1234');await page.locator('#loginForm button[type="submit"]').click();await ready();let f=frame();
  await f.locator('.nav [data-view="magazzino"]').click();
  await addStock('Scorta media ponderata',10,10,2.5);
  let row=f.locator('#stockRows tr').filter({hasText:'Scorta media ponderata'});
  await row.locator('[data-stock-quantity-action="increase"]').click();await f.locator('#stockRestockModal').waitFor({state:'visible'});
  assert.match(await f.locator('#stockRestockProduct').innerText(),/Scorta media ponderata/);assert.match(await f.locator('#stockRestockInventory').innerText(),/10 pz · costo medio attuale € 10,00/);
  assert.equal(await f.locator('#stockRestockPriorCostField').isVisible(),false,'known current unit cost needs no extra field');
  await f.locator('#stockRestockQuantity').fill('5');await f.locator('#stockRestockUnitPrice').fill('20');assert.match(await f.locator('#stockRestockPreview').innerText(),/15 pz · costo medio ponderato € 13,33/);
  await f.locator('#stockRestockForm button[type="submit"]').click();await f.locator('#stockRestockModal').waitFor({state:'hidden'});await flush();
  assert.equal(await row.getAttribute('data-quantity'),'15');assert.equal((await row.locator('td').nth(3).innerText()).trim(),'€ 13,33');assert.equal(await row.getAttribute('data-unit-profit'),'2.5','stock markup stays independent of purchase cost');
  const saved=payload().dom['#stockRows'].find(item=>JSON.stringify(item).includes('Scorta media ponderata'));
  assert.equal(saved.a['data-quantity'],'15');assert.ok(JSON.stringify(saved.c[3]).includes('13,33'),'weighted average is synchronized to the server');
  await row.locator('[data-stock-quantity-action="decrease"]').click();assert.equal(await row.getAttribute('data-quantity'),'14');assert.equal((await row.locator('td').nth(3).innerText()).trim(),'€ 13,33','ordinary quantity reduction preserves the remaining unit cost');

  await addStock('Scorta senza costo noto',2);
  row=f.locator('#stockRows tr').filter({hasText:'Scorta senza costo noto'});await row.locator('[data-stock-quantity-action="increase"]').click();
  assert.equal(await f.locator('#stockRestockPriorCostField').isVisible(),true,'unknown existing cost is requested before calculating an average');
  await f.locator('#stockRestockQuantity').fill('2');await f.locator('#stockRestockUnitPrice').fill('15');await f.locator('#stockRestockPriorCost').fill('5');
  assert.match(await f.locator('#stockRestockPreview').innerText(),/4 pz · costo medio ponderato € 10,00/);
  await f.locator('#stockRestockForm button[type="submit"]').click();await f.locator('#stockRestockModal').waitFor({state:'hidden'});await flush();
  assert.equal(await row.getAttribute('data-quantity'),'4');assert.equal((await row.locator('td').nth(3).innerText()).trim(),'€ 10,00');

  await addStock('Scorta azzerata',1,7);row=f.locator('#stockRows tr').filter({hasText:'Scorta azzerata'});
  await f.evaluate(name=>stockInventoryApi.setQuantity(stockInventoryApi.rows().find(item=>stockInventoryApi.productName(item)===name),0),'Scorta azzerata');await flush();
  await row.locator('[data-stock-quantity-action="increase"]').click();assert.equal(await f.locator('#stockRestockPriorCostField').isVisible(),false,'zero existing quantity does not require an old cost');
  await f.locator('#stockRestockQuantity').fill('2');await f.locator('#stockRestockUnitPrice').fill('12');await f.locator('#stockRestockForm button[type="submit"]').click();await f.locator('#stockRestockModal').waitFor({state:'hidden'});await flush();
  assert.equal(await row.getAttribute('data-quantity'),'2');assert.equal((await row.locator('td').nth(3).innerText()).trim(),'€ 12,00');
  assert.deepEqual(errors,[]);console.log('PASS restock modal computes quantity-weighted purchase cost, asks for an unknown previous cost, and preserves markup');
 }finally{await browser.close();await new Promise(resolve=>app.server.close(resolve));app.db.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
