const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {pathToFileURL} = require('node:url');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const assert = require('node:assert/strict');

(async () => {
  const root = path.resolve(__dirname, '..'), dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'officina-inventory-new-stock-'));
  const reserve = net.createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve)); const origin = 'http://127.0.0.1:' + port;
  const {createApplication} = await import(pathToFileURL(path.join(root, 'server/server.mjs')));
  const {addUser} = await import(pathToFileURL(path.join(root, 'server/database.mjs')));
  const app = await createApplication({root,dataDir,origin,env:{NODE_ENV:'test'}});
  await addUser(app.db,'new-stock-admin','test-password-1234','admin'); await addUser(app.db,'new-stock-viewer','test-password-1234','viewer');
  await new Promise(resolve => app.server.listen(port,'127.0.0.1',resolve));
  const browser = await chromium.launch({...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH}:{}),headless:true});
  const errors = [], screenshots = path.resolve(root,'..','..','work'); fs.mkdirSync(screenshots,{recursive:true});
  const frame = page => page.frames().find(item => item.url().includes('/legacy'));
  const ready = page => page.waitForFunction(() => document.querySelector('iframe')?.contentWindow?.WorkshopCloud?.initializing === false);
  const idle = page => frame(page).waitForFunction(() => document.querySelector('#inventoryCountModal').getAttribute('aria-busy') === 'false');
  const flush = page => page.evaluate(() => WorkshopCloudHost.flush());
  const payload = () => JSON.parse(app.db.prepare('SELECT payload FROM state').get().payload);
  const inventory = () => JSON.parse(payload().storage['officina.inventory.v1'] || '{}');
  const stock = () => payload().dom['#stockRows'].filter(row => row.a?.['data-cloud-id']);
  const login = async (username='new-stock-admin',legacy=false) => {
    const page=await (await browser.newContext({viewport:{width:1280,height:900}})).newPage();
    page.on('pageerror',error=>errors.push(error.stack));page.on('dialog',dialog=>dialog.accept());
    if(legacy)await page.route(/\/api\/(?:session|login)$/,async route=>{const response=await route.fetch(),body=await response.json();delete body.features.inventoryNewStock;await route.fulfill({response,body:JSON.stringify(body)});});
    await page.goto(origin);await page.locator('#username').fill(username);await page.locator('#password').fill('test-password-1234');await page.locator('#loginForm button[type=submit]').click();await ready(page);
    await frame(page).locator('.nav [data-view=magazzino]').click();await frame(page).locator('#magazzino').waitFor({state:'visible'});await frame(page).waitForFunction(()=>WorkshopCloud.boot.user.role==='viewer'||window.parent.WorkshopCloudHost.canWrite());return page;
  };
  const start = async page => {await frame(page).waitForFunction(()=>window.parent.WorkshopCloudHost.canWrite());await frame(page).locator('#inventoryCountStart').click();await idle(page);await frame(page).locator('#inventoryCountList').waitFor({state:'visible'});};
  const count = (f,product) => f.locator('#inventoryCountList .inventory-count-row').filter({hasText:product}).locator('[data-count-quantity]');
  const add = async (page,product) => {
    const f=frame(page);await f.locator('#inventoryCountAddStock').click();await f.locator('#inventoryNewProduct').fill(product);await f.locator('#inventoryNewCategory').selectOption('Lubrificanti');
    await f.locator('#inventoryNewUnit').selectOption('lt');await f.locator('#inventoryNewQuantity').fill('2,5');await f.locator('#inventoryNewPrice').fill('14.25');await f.locator('#inventoryNewUnitProfit').fill('2.5');await f.locator('#inventoryNewLocation').fill('B-2');await f.locator('#inventoryNewMinimum').fill('3');await f.locator('#inventoryNewSave').click();await idle(page);await f.locator('#inventoryCountList').waitFor({state:'visible'});
  };
  const discard = async page => {const f=frame(page);await f.locator('#inventoryCountDiscard').click();await f.locator('#inventoryCountConfirmDiscard').click();await f.locator('#inventoryCountModal').waitFor({state:'hidden'});};
  let page;
  try {
    page=await login();let f=frame(page);
    await start(page);assert.equal(inventory().countDraft.items.length,0,'empty warehouse can be counted and populated');await f.locator('#inventoryCountAddStock').click();
    await page.setViewportSize({width:390,height:844});
    assert.ok(await f.locator('.inventory-count-card').evaluate(el=>el.scrollWidth-el.clientWidth<=1));await page.screenshot({path:path.join(screenshots,'inventory-new-stock-mobile.png')});
    await f.locator('#inventoryNewProduct').fill('Scorta annullata');await f.locator('#inventoryNewCancel').click();assert.equal(inventory().countDraft.items.length,0);await discard(page);assert.equal(stock().length,0);
    console.log('PASS empty inventory and cancelling the new-stock form do not modify operational stock; mobile form has no overflow');

    await f.locator('#magazzino [data-cloud-open=stockModal]').click();await f.locator('#stockProduct').fill('Scorta esistente');await f.locator('#stockCategory').selectOption('Ricambi meccanica');await f.locator('#stockQuantity').fill('4');await f.locator('#stockPrice').fill('10');await f.locator('#stockForm button[type=submit]').click();await flush(page);
    const baseline=structuredClone(stock());await start(page);await count(f,'Scorta esistente').fill('3');await add(page,'Olio trovato nell’inventario');
    const added=inventory().countDraft.items.find(item=>item.isNew);assert.equal(added.expectedQuantity,0);assert.equal(added.countedQuantity,2.5);assert.deepEqual(stock(),baseline);
    await f.locator('#inventoryCountClose').click();await f.locator('#inventoryCountModal').waitFor({state:'hidden'});await page.reload();await ready(page);f=frame(page);await f.locator('.nav [data-view=magazzino]').click();await start(page);
    assert.equal(await count(f,'Olio trovato nell’inventario').inputValue(),'2.5');assert.equal(inventory().countDraft.items.find(item=>item.isNew).cloudId,added.cloudId);assert.deepEqual(stock(),baseline);
    await f.locator('#inventoryCountReview').click();await idle(page);assert.match(await f.locator('#inventoryCountReport').innerText(),/Nuova scorta/);await f.locator('#inventoryCountApply').click();await idle(page);assert.equal(inventory().countDraft.status,'applied');await flush(page);
    assert.deepEqual(stock().map(row=>Number(row.a['data-quantity'])),[3,2.5]);const saved=stock().find(row=>row.a['data-cloud-id']===added.cloudId);
    assert.equal(saved.a['data-unit'],'lt');assert.equal(saved.a['data-unit-profit'],'2.5');assert.equal(saved.a['data-minimum'],'3');assert.equal(saved.c[3].c[0],'€ 14,25');assert.equal(saved.c[4].c[0],'B-2');
    await f.locator('#inventoryCountDone').click();await page.reload();await ready(page);f=frame(page);await f.locator('.nav [data-view=magazzino]').click();
    const row=f.locator('#stockRows tr').filter({hasText:'Olio trovato nell’inventario'});assert.equal(await row.count(),1);assert.match(await row.locator('.qty-adjust').innerText(),/2,5/);assert.match(await row.locator('td').first().getAttribute('title'),/2,50/);
    console.log('PASS new product survives reload in draft and is inserted once with quantity, category, price, margin, location and minimum only on atomic application');

    await start(page);await add(page,'Olio da eliminare');await discard(page);assert.equal(stock().length,2);assert.equal(inventory().countDraft,undefined);
    const legacy=await login('new-stock-admin',true);await start(legacy);await frame(legacy).locator('#inventoryCountAddStock').click();assert.match(await frame(legacy).locator('#inventoryCountError').innerText(),/Aggiorna e riavvia/);assert.equal(await frame(legacy).locator('#inventoryCountNewForm').count(),0);await discard(legacy);await legacy.context().close();await page.reload();await ready(page);f=frame(page);await f.locator('.nav [data-view=magazzino]').click();
    console.log('PASS discarding new count items never inserts stock and older backend capabilities block new-item saving');

    const second=await login();await start(page);await count(f,'Scorta esistente').fill('2');await add(page,'Olio in conflitto');await f.locator('#inventoryCountReview').click();await idle(page);
    let intercepted=false;
    await page.route('**/api/changes',async route=>{const body=route.request().postDataJSON();const applying=body.changes?.some(change=>change.key==='["storage","officina.inventory.v1"]'&&typeof change.value==='string'&&JSON.parse(change.value).countDraft?.status==='applied');if(applying&&!intercepted){intercepted=true;await frame(second).evaluate(()=>{const row=stockInventoryApi.rows().find(row=>stockInventoryApi.productName(row)==='Scorta esistente');stockInventoryApi.setQuantity(row,5);});await flush(second);}await route.continue();});
    await f.locator('#inventoryCountApply').click();await idle(page);assert.equal(intercepted,true);assert.equal(inventory().countDraft.status,'review');assert.equal(stock().length,2);assert.equal(Number(stock()[0].a['data-quantity']),5);
    assert.equal(await f.locator('#stockRows tr').filter({hasText:'Olio in conflitto'}).count(),0,'rejected apply removes its inserted DOM row');assert.equal(inventory().countDraft.items.filter(item=>item.isNew).length,1);assert.match(await f.locator('#inventoryCountError').innerText(),/conservata/);
    const viewer=await login('new-stock-viewer');assert.equal(await frame(viewer).locator('#inventoryCountStart').isVisible(),false);
    assert.deepEqual(errors,[]);console.log('PASS a stock race after preflight rejects the complete insertion, rolls back new DOM rows and preserves the count; viewer cannot write; no runtime errors');
  } catch(error) {if(page&&!page.isClosed())console.error('Inventory diagnostic:',await frame(page)?.evaluate(()=>({error:document.querySelector('#inventoryCountError')?.textContent,status:document.querySelector('#inventoryCountStatus')?.textContent,draft:WorkshopInventoryCount.draft()})));throw error;}
  finally {await browser.close();await new Promise(resolve=>app.server.close(resolve));app.db.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
