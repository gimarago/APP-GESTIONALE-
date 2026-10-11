const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {pathToFileURL} = require('node:url');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');

(async () => {
  const root = path.resolve(__dirname, '..'), dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'officina-inventory-count-'));
  const {createApplication} = await import(pathToFileURL(path.join(root, 'server/server.mjs')));
  const {addUser} = await import(pathToFileURL(path.join(root, 'server/database.mjs')));
  const origin = 'http://127.0.0.1:8148';
  const app = await createApplication({root, dataDir, origin, env:{NODE_ENV:'test'}});
  await addUser(app.db, 'count-admin', 'test-password-1234', 'admin');
  await addUser(app.db, 'count-viewer', 'test-password-1234', 'viewer');
  await new Promise(resolve => app.server.listen(8148, '127.0.0.1', resolve));
  const browser = await chromium.launch({...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}), headless:true});
  const errors = [], screenshotDir = path.resolve(root, '..', '..', 'work');
  fs.mkdirSync(screenshotDir, {recursive:true});
  const ready = page => page.waitForFunction(() => document.querySelector('iframe')?.contentWindow?.WorkshopCloud?.initializing === false);
  const frame = page => page.frames().find(item => item.url().includes('/legacy'));
  const sync = async page => {
    // A section is displayed before its background drain completes. The test
    // calls the API directly, so wait for that drain as a real UI control does.
    for (let attempt = 0; attempt < 20; attempt++) {
      try { return await page.evaluate(() => WorkshopCloudHost.flush()); }
      catch (failure) { if (!failure.message.includes('Attendi il salvataggio in corso.') || attempt === 19) throw failure; await new Promise(resolve => setTimeout(resolve, 100)); }
    }
  };
  const payload = () => JSON.parse(app.db.prepare('SELECT payload FROM state').get().payload);
  const draft = () => JSON.parse(payload().storage['officina.inventory.v1'] || '{}').countDraft;
  const stocks = () => Object.fromEntries(payload().dom['#stockRows'].filter(item => item.a?.['data-cloud-id']).map(item => [item.a['data-cloud-id'], item]));
  const stockQuantities = () => Object.values(stocks()).map(item => Number(item.a['data-quantity']));
  const login = async (username = 'count-admin', legacyServer = false) => {
    const page = await (await browser.newContext({viewport:{width:1280,height:900}})).newPage();
    if (legacyServer) await page.route(/\/api\/(?:session|login)$/, async route => {
      const response = await route.fetch(), result = await response.json(); delete result.features.inventoryCount;
      await route.fulfill({response, body:JSON.stringify(result)});
    });
    page.on('pageerror', error => errors.push(error.stack)); page.on('dialog', dialog => dialog.accept());
    await page.goto(origin); await page.locator('#username').fill(username); await page.locator('#password').fill('test-password-1234'); await page.locator('#loginForm button[type=submit]').click(); await ready(page); return page;
  };
  const navigate = async (page, view) => { await frame(page).locator('.nav [data-view="' + view + '"]').click(); await ready(page); await frame(page).waitForFunction(view => WorkshopCloud.view() === view && (WorkshopCloud.boot.user.role === 'viewer' || window.parent.WorkshopCloudHost.canWrite()), view); return frame(page); };
  const add = async (page, product, category, unit, quantity, price, profit) => {
    const f = frame(page); await f.locator('#magazzino [data-cloud-open="stockModal"]').click(); await f.locator('#stockProduct').fill(product); await f.locator('#stockCategory').selectOption(category); await f.locator('#stockUnit').selectOption(unit); await f.locator('#stockQuantity').fill(String(quantity)); await f.locator('#stockPrice').fill(String(price)); await f.locator('#stockUnitProfit').fill(String(profit)); await f.locator('#stockForm button[type=submit]').click(); await sync(page);
  };
  const waitCount = async page => frame(page).waitForFunction(() => document.querySelector('#inventoryCountModal.open') && document.querySelector('#inventoryCountList') && document.querySelector('#inventoryCountModal').getAttribute('aria-busy') === 'false');
  const waitIdle = async page => frame(page).waitForFunction(() => document.querySelector('#inventoryCountModal').getAttribute('aria-busy') === 'false');
  const countInput = (f, product) => f.locator('#inventoryCountList .inventory-count-row').filter({hasText:product}).locator('[data-count-quantity]');
  const changeStock = async (page, product, value, delta = false) => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const changed = await frame(page).evaluate(({product,value,delta}) => {
        if (WorkshopCloud.initializing || !window.parent.WorkshopCloudHost.canWrite()) return false;
        // Direct test API edits need the same settling window as clicking a
        // stock control, otherwise a pending live snapshot can win the race.
        WorkshopCloud.changed();
        const row = stockInventoryApi.rows().find(item => stockInventoryApi.productName(item) === product);
        stockInventoryApi.setQuantity(row, delta ? stockInventoryApi.quantityFor(row) + value : value); return true;
      }, {product,value,delta});
      if (changed) return; await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error('The concurrent stock editor did not become writable.');
  };
  let page, second;
  try {
    page = await login(); let f = await navigate(page, 'magazzino');
    const tyre = '205/55 R16 91V Michelin', oil = 'Olio motore 5W-30', part = 'Pastiglie freno anteriori';
    await add(page, tyre, 'Pneumatici estivi', 'pz', 1008, 65, 12);
    await add(page, oil, 'Lubrificanti', 'lt', 1015.5, 10, 3);
    await add(page, part, 'Ricambi meccanica', 'pz', 4, 30, 8);
    f = await navigate(page, 'agenda');
    await f.locator('#agenda').waitFor({state:'visible'}); await f.evaluate(() => { document.getElementById('appDate').value = localCreationDate(); openModal('appointmentModal'); }); await f.locator('#appCustomer').fill('Cliente inventario'); await f.locator('#appPlate').fill('IV123AA'); await f.locator('#appointmentWorkLines [data-description]').fill('2 ' + tyre); await f.locator('#appointmentWorkLines [data-amount]').fill('130'); await f.locator('#appointmentForm button[type=submit]').click(); await sync(page);
    f = await navigate(page, 'magazzino');
    const reservedBefore = await f.locator('#stockRows tr').filter({hasText:tyre}).locator('.stock-reserved').innerText();
    const before = stocks(), quantities = stockQuantities();
    assert.deepEqual(quantities, [1008,1015.5,4], 'thousands grouping preserves integer pieces and decimal fluids');
    await f.locator('#inventoryCountStart').click(); await waitCount(page);
    assert.deepEqual(draft().items.map(item => item.countedQuantity), [0,0,0]); assert.deepEqual(stockQuantities(), quantities);
    await countInput(f, tyre).fill('7'); await f.locator('#inventoryCountDiscard').click(); await f.locator('#inventoryCountKeep').click();
    assert.equal(await countInput(f, tyre).inputValue(), '7');
    await f.locator('#inventoryCountDiscard').click(); await f.locator('#inventoryCountConfirmDiscard').click(); await f.locator('#inventoryCountModal').waitFor({state:'hidden'});
    assert.equal(draft(), undefined); assert.deepEqual(stockQuantities(), quantities);
    console.log('PASS initial temporary stock is zero and discarding never changes live quantities');

    await f.locator('#inventoryCountStart').click(); await waitCount(page);
    await countInput(f, tyre).fill('3.5'); await f.locator('#inventoryCountReview').click(); assert.match(await f.locator('#inventoryCountError').innerText(), /intera/);
    await countInput(f, tyre).fill('6'); await countInput(f, oil).fill('12,5');
    await page.screenshot({path:path.join(screenshotDir, 'inventory-count-desktop.png')});
    await page.setViewportSize({width:390,height:844});
    const mobileCount = await f.locator('#inventoryCountModal .modal-card').evaluate(element => ({overflow:element.scrollWidth-element.clientWidth, left:element.getBoundingClientRect().left, right:element.getBoundingClientRect().right, width:innerWidth}));
    assert.ok(mobileCount.overflow <= 1 && mobileCount.left >= 0 && mobileCount.right <= mobileCount.width + 1);
    await page.screenshot({path:path.join(screenshotDir, 'inventory-count-mobile.png')}); await page.setViewportSize({width:1280,height:900});
    await f.locator('#inventoryCountClose').click(); await f.locator('#inventoryCountModal').waitFor({state:'hidden'});
    await page.reload(); await ready(page); f = await navigate(page, 'magazzino');
    assert.equal(await f.locator('#inventoryCountStart').innerText(), 'Riprendi inventario'); await f.locator('#inventoryCountStart').click(); await waitCount(page);
    assert.equal(await countInput(f, tyre).inputValue(), '6'); assert.equal(await countInput(f, oil).inputValue(), '12,5'); assert.equal(await countInput(f, part).inputValue(), '0'); assert.deepEqual(stockQuantities(), quantities);
    await f.locator('#inventoryCountReview').click(); await waitIdle(page); assert.match(await f.locator('#inventoryCountUnentered').innerText(), /1 prodotto.*0/);
    assert.equal(await f.locator('#inventoryCountReport .inventory-count-row').count(), 3);
    assert.match(await f.locator('#inventoryCountReport').innerText(), /12,5 lt/);
    await page.screenshot({path:path.join(screenshotDir, 'inventory-count-review-desktop.png')});
    await page.setViewportSize({width:390,height:844}); await page.screenshot({path:path.join(screenshotDir, 'inventory-count-review-mobile.png')});
    assert.ok(await f.locator('#inventoryCountModal .modal-card').evaluate(element => element.scrollWidth-element.clientWidth <= 1)); await page.setViewportSize({width:1280,height:900});
    await f.locator('#inventoryCountApply').click(); await waitIdle(page); assert.equal(draft().status, 'applied'); await sync(page);
    const after = stocks();
    assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
    assert.deepEqual(stockQuantities(), [6,12.5,0]);
    for (const [id, stock] of Object.entries(after)) {
      assert.equal(stock.a['data-unit'], before[id].a['data-unit']); assert.equal(stock.a['data-unit-profit'], before[id].a['data-unit-profit']); assert.deepEqual(stock.c[0], before[id].c[0]); assert.deepEqual(stock.c[1], before[id].c[1]); assert.deepEqual(stock.c[3], before[id].c[3]); assert.equal(stock.a['data-tyre-stock-id'], before[id].a['data-tyre-stock-id']);
    }
    assert.equal(await f.locator('#stockRows tr').filter({hasText:tyre}).locator('.stock-reserved').innerText(), reservedBefore);
    assert.ok(JSON.parse(payload().storage['officina.inventory.v1']).history.length);
    await f.locator('#inventoryCountDone').click();
    console.log('PASS reload resumes counts; report preserves decimals; apply replaces unseen stock with zero and keeps IDs, product metadata and reservations');

    second = await login(); let other = await navigate(second, 'magazzino');
    await f.locator('#inventoryCountStart').click(); await waitCount(page); await countInput(f, tyre).fill('5');
    await f.locator('#inventoryCountSearch').focus(); await sync(page);
    const oilId = await f.locator('#stockRows tr').filter({hasText:oil}).getAttribute('data-cloud-id');
    await changeStock(second, oil, 1, true); await sync(second);
    try { await f.waitForFunction(id => {
      const row = [...document.querySelectorAll('#inventoryCountList [data-count-stock-id]')].find(item => item.dataset.countStockId === id);
      return row?.querySelector('.inventory-count-product small')?.textContent.includes('In magazzino: 13,5 lt');
    }, oilId, {timeout:8000}); } catch (failure) {
      console.error('Live stock update diagnosis:', await f.evaluate(id => ({liveBusy:WorkshopCloud.liveBusy(),settle:WorkshopCloud.settleDelay(),busy:WorkshopCloud.busy(),stock:stockInventoryApi.rows().map(row=>[row.dataset.cloudId,stockInventoryApi.productName(row),stockInventoryApi.quantityFor(row)]),draft:WorkshopInventoryCount.draft(),countRow:[...document.querySelectorAll('#inventoryCountList [data-count-stock-id]')].find(row=>row.dataset.countStockId===id)?.innerText,hostVersions:window.parent.WorkshopCloudHost.recordVersions(window)}),oilId));
      console.error('Server quantities at timeout:', stockQuantities()); throw failure;
    }
    assert.equal(await countInput(f, tyre).inputValue(), '5', 'an unrelated live stock update preserves the quantity already counted');
    await sync(page);
    await countInput(f, oil).fill('14'); await sync(page); await f.locator('#inventoryCountReview').click(); await waitIdle(page);
    await f.locator('#inventoryCountApply').click(); await waitIdle(page); assert.equal(draft().status, 'applied'); assert.deepEqual(stockQuantities(), [5,14,0]);
    await f.locator('#inventoryCountDone').click(); await f.locator('#inventoryCountModal').waitFor({state:'hidden'});
    console.log('PASS another operator changes a different stock live during an open count; entered values are retained and the inventory applies');

    await second.reload(); await ready(second); other = await navigate(second, 'magazzino');
    await f.locator('#inventoryCountStart').click(); await waitCount(page); await countInput(f, tyre).fill('8'); await sync(page);
    await second.waitForFunction(() => WorkshopCloudHost.canWrite(), null, {timeout:10000});
    await other.waitForFunction(() => document.querySelector('#inventoryCountStart')?.innerText === 'Riprendi inventario', null, {timeout:8000});
    await other.locator('#inventoryCountStart').click(); await waitCount(second); await countInput(other, oil).fill('13'); await sync(second);
    await f.waitForFunction(({oil}) => {
      const row = [...document.querySelectorAll('#inventoryCountList .inventory-count-row')].find(item => item.innerText.includes(oil));
      return row?.querySelector('[data-count-quantity]')?.value === '13';
    }, {oil}, {timeout:10000});
    assert.equal(await countInput(f, tyre).inputValue(), '8', 'live updates to another count row keep the local focused value');
    assert.deepEqual(draft().items.map(item => item.countedQuantity), [8,13,0]);
    await f.locator('#inventoryCountReview').click(); await waitIdle(page); await f.locator('#inventoryCountApply').click(); await waitIdle(page);
    assert.equal(draft().status, 'applied'); assert.deepEqual(stockQuantities(), [8,13,0]);
    await f.locator('#inventoryCountDone').click(); await f.locator('#inventoryCountModal').waitFor({state:'hidden'});
    await other.locator('#inventoryCountClose').click(); await other.locator('#inventoryCountModal').waitFor({state:'hidden'});
    console.log('PASS two operators count different products concurrently without overlapping-data conflicts; the other row appears live');

    await page.evaluate(() => Object.defineProperty(document, 'hidden', {configurable:true, value:true}));
    await changeStock(second, tyre, 10); await sync(second);
    assert.equal(await f.evaluate(name => stockInventoryApi.quantityFor(stockInventoryApi.rows().find(row => stockInventoryApi.productName(row) === name)), tyre), 8, 'the hidden first tab keeps its stale stock until explicitly refreshed');
    await f.locator('#inventoryCountStart').click(); await waitCount(page);
    assert.equal(draft().items.find(item => item.product === tyre).expectedQuantity, 10, 'starting an inventory refreshes stale stock from the server before making the draft');
    await f.locator('#inventoryCountDiscard').click(); await f.locator('#inventoryCountConfirmDiscard').click(); await f.locator('#inventoryCountModal').waitFor({state:'hidden'});
    await page.evaluate(() => { delete document.hidden; });
    console.log('PASS starting a count force-synchronizes stock after a missed live update instead of leaving a stale-data error');

    await page.reload(); await ready(page); f = await navigate(page, 'magazzino');
    const representationBaseline = stockQuantities();
    await f.locator('#inventoryCountStart').click(); await waitCount(page);
    for (const item of draft().items) await countInput(f, item.product).fill(String(item.expectedQuantity));
    await f.locator('#inventoryCountReview').click(); await waitIdle(page);
    let representationIntercepted = false;
    await page.route('**/api/state', async route => {
      if (route.request().headers()['if-none-match']) return route.continue();
      const response = await route.fetch(), body = await response.json();
      for (const row of body.state?.dom?.['#stockRows'] || []) for (const key of ['data-quantity','data-initial-quantity']) delete row.a?.[key];
      representationIntercepted = true; await route.fulfill({response,body:JSON.stringify(body)});
    });
    await f.locator('#inventoryCountApply').click(); await waitIdle(page); await page.unroute('**/api/state');
    assert.equal(representationIntercepted, true); assert.equal(draft().status, 'applied'); assert.deepEqual(stockQuantities(), representationBaseline);
    await f.locator('#inventoryCountDone').click(); await f.locator('#inventoryCountModal').waitFor({state:'hidden'});
    console.log('PASS legacy server rows without client-normalized quantity attributes still match the current stock and apply correctly');

    await page.reload(); await ready(page); f = await navigate(page, 'magazzino');
    await f.locator('#inventoryCountStart').click(); await waitCount(page); await countInput(f, tyre).fill('5'); await f.locator('#inventoryCountReview').click(); await waitIdle(page);
    const staleId = draft().id;
    await changeStock(second, tyre, 9); await sync(second);
    await f.locator('#inventoryCountApply').click(); await waitIdle(page); assert.match(await f.locator('#inventoryCountError').innerText(), /cambiata durante il conteggio/); assert.equal(draft().id, staleId); assert.equal(draft().status, 'review'); assert.equal(stockQuantities()[0], 9);
    assert.equal(await f.locator('#inventoryCountModal').isVisible(), true); await f.locator('#inventoryCountClose').click(); await f.locator('#inventoryCountModal').waitFor({state:'hidden'});
    await page.reload(); await ready(page); f = await navigate(page, 'magazzino'); await f.locator('#inventoryCountStart').click(); await waitIdle(page); assert.equal(draft().id, staleId); assert.equal(draft().items[0].countedQuantity, 5);
    await f.locator('#inventoryCountDiscard').click(); await f.locator('#inventoryCountConfirmDiscard').click(); await f.locator('#inventoryCountModal').waitFor({state:'hidden'}); assert.equal(stockQuantities()[0], 9);
    console.log('PASS concurrent stock changes block replacement and the resoconto remains resumable with entered counts');

    await f.locator('#inventoryCountStart').click(); await waitCount(page); await countInput(f, tyre).fill('1'); await f.locator('#inventoryCountReview').click(); await waitIdle(page);
    await second.reload(); await ready(second); other = await navigate(second, 'magazzino');
    let intercepted = false;
    await page.route('**/api/changes', async route => {
      const body = route.request().postDataJSON();
      const applying = body?.changes?.some(change => change.key === '["inventory-draft"]' && change.value?.metadata?.status === 'applied');
      if (applying && !intercepted) { intercepted = true; await changeStock(second, oil, 1, true); await sync(second); }
      await route.continue();
    });
    await f.locator('#inventoryCountApply').click(); await waitIdle(page); assert.equal(intercepted, true); assert.equal(draft().status, 'review'); assert.deepEqual(stockQuantities(), [9,14,0]); assert.equal(await f.locator('#inventoryCountModal').isVisible(), true); assert.match(await f.locator('#inventoryCountError').innerText(), /conservata/);
    assert.equal(await f.locator('#inventoryCountReport').isVisible(), true);
    if (await page.locator('#conflictDialog').isVisible()) await page.locator('#conflictDialog button').filter({hasText:'Chiudi'}).click();
    await f.locator('#inventoryCountClose').click(); await f.locator('#inventoryCountModal').waitFor({state:'hidden'}); await page.unroute('**/api/changes');
    console.log('PASS a stock write racing after preflight rejects the entire replacement and retains the draft');

    const viewer = await login('count-viewer'); const vf = await navigate(viewer, 'magazzino'); assert.equal(await vf.locator('#inventoryCountStart').isVisible(), false); assert.equal(await vf.evaluate(() => WorkshopInventoryCount.open().then(() => document.querySelector('#inventoryCountModal').classList.contains('open'))), false);
    const legacy = await login('count-admin', true), lf = await navigate(legacy, 'magazzino');
    const unchanged = draft(); await lf.locator('#inventoryCountStart').click();
    assert.match(await lf.locator('#inventoryCountError').innerText(), /versione precedente.*riavvia/s);
    assert.equal(await lf.locator('#inventoryCountApply').isDisabled(), true);
    await lf.locator('#inventoryCountClose').click(); await lf.locator('#inventoryCountModal').waitFor({state:'hidden'}); await sync(legacy);
    assert.deepEqual(draft(), unchanged);
    console.log('PASS old backend capability is detected before another count save and retains the saved draft');
    assert.deepEqual(errors, []); console.log('PASS viewer cannot count/apply; no browser runtime errors; desktop and mobile screenshots saved');
  } catch (failure) {
    if (page && !page.isClosed()) {
      console.error('Inventory UI diagnostic:', await frame(page)?.evaluate(() => ({error:document.querySelector('#inventoryCountError')?.textContent, status:document.querySelector('#inventoryCountStatus')?.textContent, draft:WorkshopInventoryCount.draft(), modal:document.querySelector('#inventoryCountModal')?.className})));
      console.error('Host diagnostic:', await page.locator('body').innerText());
      await page.screenshot({path:path.join(screenshotDir, 'inventory-count-failure.png')});
    }
    throw failure;
  } finally { await browser.close(); await new Promise(resolve => app.server.close(resolve)); app.db.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
