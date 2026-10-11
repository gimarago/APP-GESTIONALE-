const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {pathToFileURL} = require('node:url');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const R = require('../cloud-records.js');

// All writes use a new temporary database and an ephemeral port. This test
// never opens the user's preview server or desktop data directory.
(async () => {
  const root = path.resolve(__dirname, '..');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'officina-live-sync-'));
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const {createApplication} = await import(pathToFileURL(path.join(root, 'server/server.mjs')));
  const {addUser} = await import(pathToFileURL(path.join(root, 'server/database.mjs')));
  const app = await createApplication({root, dataDir, origin, env:{NODE_ENV:'test'}});
  for (const [name, role] of [['live-admin', 'admin'], ['live-operator', 'operator'], ['live-viewer', 'viewer']]) {
    await addUser(app.db, name, 'test-password-1234', role);
  }
  await new Promise(resolve => app.server.listen(port, '127.0.0.1', resolve));
  const browser = await chromium.launch({...process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}, headless:true});
  const errors = [], releases = new Set();
  let tests = 0;
  const pass = message => {tests++; console.log('PASS', message);};
  const frame = page => page.frames().find(item => item.url().includes('/legacy'));
  const product = '205/55 R16 91V Michelin live';
  const untouched = 'Prodotto invariato durante aggiornamento live';
  const stockRow = page => frame(page).locator('#stockRows tr').filter({hasText:product});
  const quantity = page => stockRow(page).locator('.qty-adjust b').innerText().then(Number);
  const snapshot = () => JSON.parse(app.db.prepare('SELECT payload FROM state').get().payload);
  const revision = () => app.db.prepare('SELECT revision FROM state').get().revision;
  const nodeText = node => typeof node === 'string' ? node : (node.c || []).map(nodeText).join('');
  async function ready(page, view) {
    await page.waitForFunction(view => {
      const cloud = document.querySelector('iframe')?.contentWindow?.WorkshopCloud;
      return cloud && !cloud.initializing && !WorkshopCloudHost.synchronizing() && (!view || cloud.view() === view);
    }, view, {timeout:15000});
    return frame(page);
  }
  async function navigate(page, view) {
    await frame(page).locator(`.nav [data-view="${view}"]`).click();
    return ready(page, view);
  }
  async function session(username) {
    const context = await browser.newContext({viewport:{width:1280, height:600}});
    const page = await context.newPage();
    page.legacyLoads = 0;
    page.on('framenavigated', item => {if(item.url().includes('/legacy'))page.legacyLoads++;});
    page.on('pageerror', error => errors.push(error.stack));
    page.on('dialog', dialog => dialog.accept());
    await page.addInitScript(() => {
      if(window !== window.top)return;
      window.liveWrites = [];
      const nativeFetch = window.fetch.bind(window);
      window.fetch = async (input, options) => {
        const url = new URL(typeof input === 'string' ? input : input.url, location.href);
        if(url.pathname !== '/api/changes' || options?.method !== 'PUT')return nativeFetch(input, options);
        const write = {keys:JSON.parse(options.body).changes.map(change => change.key)};
        window.liveWrites.push(write);
        const response = await nativeFetch(input, options);
        write.status = response.status;
        return response;
      };
    });
    await page.goto(origin);
    await page.locator('#username').fill(username);
    await page.locator('#password').fill('test-password-1234');
    await page.locator('#loginForm button[type="submit"]').click();
    await ready(page);
    return {context, page};
  }
  async function remoteChange(change) {
    const login = await fetch(origin + '/api/login', {method:'POST', headers:{origin,'content-type':'application/json'},
      body:JSON.stringify({username:'live-admin',password:'test-password-1234'})});
    assert.equal(login.status, 200);
    const session = await login.json(), cookie = login.headers.get('set-cookie').split(';')[0];
    const response = await fetch(origin + '/api/state', {headers:{cookie}});
    const current = await response.json(), next = structuredClone(current.state);
    change(next);
    const result = await fetch(origin + '/api/changes', {method:'PUT', headers:{origin,cookie,
      'content-type':'application/json','x-csrf-token':session.csrf}, body:JSON.stringify({protocol:2,
        clientId:randomUUID(),mutationId:randomUUID(),versions:current.versions,
        changes:R.diff(current.state,next,current.versions)})});
    assert.equal(result.status,200,await result.text());
    return revision();
  }
  async function remoteQuantity(count) {
    return remoteChange(next => {
      const row = next.dom['#stockRows'].find(row => nodeText(row.c[0]).trim() === product);
      assert.ok(row);
      row.a['data-quantity'] = String(count);
      const visit = node => {
        if(typeof node === 'string')return;
        if(node.t === 'b')node.c = [String(count)];
        else for(const child of node.c || [])visit(child);
      };
      visit(row.c[2]);
    });
  }
  async function waitQuantity(page, expected) {
    await frame(page).waitForFunction(({product, expected}) => {
      const row = [...document.querySelectorAll('#stockRows tr')].find(row => row.cells[0]?.textContent.trim() === product);
      return Number(row?.querySelector('.qty-adjust b')?.textContent) === expected && !WorkshopCloud.initializing;
    }, {product,expected}, {timeout:15000});
    await ready(page);
  }
  async function mark(page) {
    return frame(page).evaluate(({product,untouched}) => {
      const rows = [...document.querySelectorAll('#stockRows tr')];
      window.liveIdentity = {token:crypto.randomUUID(),main:document.querySelector('main'),root:document.getElementById('stockRows'),
        row:rows.find(row => row.cells[0]?.textContent.trim() === product),
        untouched:rows.find(row => row.cells[0]?.textContent.trim() === untouched),field:document.getElementById('stockSearch'),
        inputEvents:0};
      const refs = window.liveIdentity;
      refs.field.addEventListener('input',()=>refs.inputEvents++);
      return refs.token;
    },{product,untouched});
  }
  async function assertIdentity(page, token, view) {
    assert.deepEqual(await frame(page).evaluate(({product,untouched}) => {
      const refs = window.liveIdentity, rows = [...document.querySelectorAll('#stockRows tr')];
      return {token:refs.token,main:refs.main===document.querySelector('main'),root:refs.root===document.getElementById('stockRows'),
        row:refs.row===rows.find(row=>row.cells[0]?.textContent.trim()===product),
        untouched:refs.untouched===rows.find(row=>row.cells[0]?.textContent.trim()===untouched),
        field:refs.field===document.getElementById('stockSearch'),view:WorkshopCloud.view()};
    },{product,untouched}),{token,main:true,root:true,row:true,untouched:true,field:true,view});
  }
  async function holdNext(page, endpoint) {
    let release, announce, held = false;
    const started = new Promise(resolve => {announce=resolve;});
    const gate = new Promise(resolve => {release=resolve;});
    const finish = () => {releases.delete(finish);release();};
    releases.add(finish);
    const pattern = `**/api/${endpoint}`;
    await page.route(pattern, async route => {
      const method = endpoint==='state' ? 'GET' : 'PUT';
      if(route.request().method()===method && !held){held=true;announce();await gate;}
      await route.continue();
    });
    return {started,release:finish,remove:()=>page.unroute(pattern)};
  }
  const blur = page => frame(page).evaluate(()=>document.activeElement?.blur());
  try {
    const a = await session('live-admin');
    await navigate(a.page,'magazzino');
    for(const [name,count] of [[product,12],[untouched,3]]) {
      const current = frame(a.page);
      await current.locator('#magazzino [data-cloud-open="stockModal"]').click();
      await current.locator('#stockProduct').fill(name);
      await current.locator('#stockCategory').selectOption({index:1});
      await current.locator('#stockQuantity').fill(String(count));
      await current.locator('#stockForm button[type="submit"]').click();
      await a.page.evaluate(()=>WorkshopCloudHost.flush());
    }
    const b = await session('live-operator');
    const viewer = await session('live-viewer');
    await navigate(b.page,'magazzino');
    await navigate(viewer.page,'magazzino');
    const token = await mark(b.page), initialLoads=b.page.legacyLoads, viewerLoads=viewer.page.legacyLoads;
    await frame(b.page).locator('#stockSearch').fill('Michelin');
    await frame(b.page).evaluate(()=>window.scrollTo(0,180));
    const scroll = await frame(b.page).evaluate(()=>scrollY);
    const changedAt = Date.now();
    await remoteQuantity(13);
    await waitQuantity(b.page,13);
    await waitQuantity(viewer.page,13);
    console.log('LIVE STOCK LATENCY', Date.now()-changedAt);
    assert.equal(await frame(b.page).locator('#stockSearch').inputValue(),'Michelin');
    assert.equal(await frame(b.page).evaluate(()=>scrollY),scroll);
    assert.equal(await frame(b.page).locator('#stockRows tr').filter({hasText:untouched}).isVisible(),false);
    await assertIdentity(b.page,token,'magazzino');
    assert.equal(b.page.legacyLoads,initialLoads);
    assert.equal(viewer.page.legacyLoads,viewerLoads);
    pass('another user changes the visible stock in place without navigation, including a viewer, while preserving rows, filter, scroll and iframe');

    await remoteQuantity(14);
    await remoteQuantity(15);
    await remoteQuantity(16);
    await waitQuantity(b.page,16);
    await waitQuantity(viewer.page,16);
    assert.equal(await frame(b.page).locator('#stockSearch').inputValue(),'Michelin');
    await frame(b.page).locator('#stockSearch').fill('205/55');
    assert.ok(await frame(b.page).evaluate(()=>window.liveIdentity.inputEvents>=2));
    pass('successive remote stock transactions converge on the latest value and existing filter listeners remain usable');

    // Editing can start after the snapshot request starts. The response must
    // recheck the form guard rather than rely on its pre-request clean state.
    let held = await holdNext(b.page,'state');
    await remoteQuantity(17);
    await held.started;
    await frame(b.page).locator('#magazzino [data-cloud-open="stockModal"]').click();
    await frame(b.page).locator('#stockProduct').fill('Scorta locale ancora in compilazione');
    await frame(b.page).locator('#stockQuantity').fill('7');
    held.release();
    await b.page.waitForTimeout(1200);
    assert.equal(await quantity(b.page),16);
    assert.equal(await frame(b.page).locator('#stockProduct').inputValue(),'Scorta locale ancora in compilazione');
    assert.equal(await frame(b.page).locator('#stockQuantity').inputValue(),'7');
    assert.ok(await frame(b.page).locator('#stockModal').evaluate(node=>node.classList.contains('open')));
    await held.remove();
    await frame(b.page).locator('#stockForm [data-cloud-close="stockModal"]').click();
    await waitQuantity(b.page,17);
    await assertIdentity(b.page,token,'magazzino');
    pass('a draft opened during a slow GET survives its response and updates apply automatically after the form closes');

    await navigate(b.page,'postit');
    await frame(b.page).locator('#postitText').fill('Bozza del post-it non ancora salvata');
    await blur(b.page);
    await remoteQuantity(18);
    await b.page.waitForTimeout(3500);
    assert.equal(await quantity(b.page),17);
    assert.equal(await frame(b.page).locator('#postitText').inputValue(),'Bozza del post-it non ancora salvata');
    await frame(b.page).locator('#postitText').fill('');
    await blur(b.page);
    await waitQuantity(b.page,18);
    assert.equal(await frame(b.page).evaluate(()=>WorkshopCloud.view()),'postit');
    pass('an unfinished non-persisted post-it protects its text and queued updates resume without a section change when the draft clears');

    await navigate(b.page,'impostazioni');
    held=await holdNext(b.page,'state');
    await remoteQuantity(19);
    await held.started;
    await frame(b.page).locator('#shopHours').fill('08:00 - 19:00, modificato durante GET');
    held.release();
    await b.page.waitForTimeout(1600);
    assert.equal(await quantity(b.page),18);
    assert.equal(await frame(b.page).locator('#shopHours').evaluate(node=>document.activeElement===node),true);
    assert.equal(await frame(b.page).locator('#shopHours').inputValue(),'08:00 - 19:00, modificato durante GET');
    assert.equal(snapshot().fields.shopHours,'08:00 - 19:00, modificato durante GET');
    await held.remove();
    await blur(b.page);
    await waitQuantity(b.page,19);
    pass('a setting edited during a slow GET is saved and keeps focus; focus exit resumes the pending live synchronization');

    await navigate(b.page,'postit');
    held=await holdNext(b.page,'changes');
    await frame(b.page).locator('#postitText').fill('Nota indipendente salvata prima del prossimo aggiornamento');
    await frame(b.page).locator('#postitForm button[type="submit"]').click();
    await blur(b.page);
    await held.started;
    await remoteQuantity(20);
    assert.equal(await quantity(b.page),19);
    held.release();
    await waitQuantity(b.page,20);
    await held.remove();
    assert.match(JSON.stringify(snapshot()),/Nota indipendente salvata prima del prossimo aggiornamento/);
    assert.equal(await b.page.locator('#mode').innerText(),'Modifica condivisa');
    pass('an in-flight own save finishes before applying independent peer edits, then catches them without navigation');

    await navigate(a.page,'agenda');
    const current = frame(a.page), customer='Lavoro remoto completato in tempo reale';
    await current.evaluate(()=>openNewAcceptance());
    await current.locator('#appTime').fill('09:30');
    await current.locator('#appCustomer').fill(customer);
    await current.locator('#appPlate').fill('LS123AA');
    await current.locator('#appVehicle').fill('Auto aggiornamenti live');
    await current.locator('#appointmentWorkLines [data-description]').fill('2 205/55 R16 91V Michelin');
    await current.locator('#appointmentWorkLines [data-amount]').fill('120');
    await current.locator('#appointmentForm button[type="submit"]').click();
    await a.page.evaluate(()=>WorkshopCloudHost.flush());
    const completed = current.locator('#agendaRows tr:not(.agenda-empty)').filter({hasText:customer});
    await completed.locator('.status-select').selectOption('COMPLETATO');
    await a.page.evaluate(()=>WorkshopCloudHost.flush());
    await waitQuantity(b.page,18);
    await waitQuantity(viewer.page,18);
    const finalSnapshot=snapshot(), finalRevision=revision(), cash=JSON.parse(finalSnapshot.storage['ma-gomme-cashbook-v1']);
    assert.equal(cash.accounts.filter(account=>account.meta.customer===customer).length,1);
    assert.deepEqual(await frame(b.page).evaluate(customer=>{
      const row=[...document.querySelectorAll('#agendaRows tr')].find(row=>row.cells[1]?.textContent===customer);
      const entry=WorkshopLedgerCash.snapshot().entries.find(entry=>entry.customer===customer);
      return {status:row?.querySelector('.status-select').value,deductions:JSON.parse(row.dataset.agendaTyreDeductions)[0].quantity,
        amount:entry?.amount,inCash:entry?.state.inCash};
    },customer),{status:'COMPLETATO',deductions:2,amount:120,inCash:120});
    await b.page.waitForTimeout(3500);
    assert.equal(revision(),finalRevision,'live apply must not replay a completed work transaction');
    assert.equal(snapshot().storage['ma-gomme-cashbook-v1'],finalSnapshot.storage['ma-gomme-cashbook-v1']);
    assert.equal(b.page.legacyLoads,initialLoads);
    assert.equal(viewer.page.legacyLoads,viewerLoads);
    pass('remote completion updates stock and cash exactly once, with no iframe reload or unintended write');

    await navigate(viewer.page,'clienti');
    await frame(viewer.page).locator('#customerGroups .customer-group-row').filter({hasText:customer}).locator('.customer-group-history').click();
    const history=await frame(viewer.page).locator('#historyContent').innerText();
    await remoteQuantity(19);
    await waitQuantity(b.page,19);
    await viewer.page.waitForTimeout(3500);
    assert.equal(await quantity(viewer.page),18);
    assert.equal(await frame(viewer.page).locator('#historyContent').innerText(),history);
    assert.ok(await frame(viewer.page).locator('#historyModal').evaluate(node=>node.classList.contains('open')));
    await frame(viewer.page).locator('#historyModal [data-cloud-close="historyModal"]').click();
    await waitQuantity(viewer.page,19);
    assert.equal(await frame(viewer.page).evaluate(()=>WorkshopCloud.view()),'clienti');
    pass('a viewer consultation modal is preserved during peer edits and its queued data update resumes after closing it');

    // Force a genuine stale mutation: B's PUT is in transit while A wins.
    // This must still stop and preserve B's proposal instead of live merging it.
    await navigate(b.page,'magazzino');
    const conflictBase=await quantity(b.page);
    held=await holdNext(b.page,'changes');
    await stockRow(b.page).locator('[data-stock-quantity-action="decrease"]').click();
    await held.started;
    await remoteQuantity(conflictBase+1);
    held.release();
    await b.page.waitForFunction(()=>document.getElementById('mode').textContent==='Modifiche sospese');
    await held.remove();
    assert.equal(await quantity(b.page),conflictBase-1);
    assert.equal(await b.page.locator('#recover').isVisible(),true);
    assert.match(await b.page.locator('#notice').innerText(),/Conflitto di modifica/);
    await remoteQuantity(conflictBase+2);
    await b.page.waitForTimeout(3500);
    assert.equal(await quantity(b.page),conflictBase-1);
    assert.equal(await b.page.locator('#mode').innerText(),'Modifiche sospese');
    assert.equal(Number(nodeText(snapshot().dom['#stockRows'].find(row=>nodeText(row.c[0]).trim()===product).c[2]).match(/[\d.]+/)[0]),conflictBase+2);
    pass('a stale stock conflict preserves the losing draft and later live events cannot overwrite it');

    assert.deepEqual(errors,[]);
    pass('no browser runtime errors');
    console.log(JSON.stringify({dataDir,revision:revision(),tests}));
  } catch(error) {
    console.error('LIVE SYNC DIAGNOSTIC',await Promise.all(browser.contexts().map(context=>context.pages()[0]?.evaluate(()=>({
      mode:document.getElementById('mode')?.textContent,status:document.getElementById('status')?.textContent,
      notice:document.getElementById('notice')?.textContent,writes:window.liveWrites,
      view:document.querySelector('iframe')?.contentWindow?.WorkshopCloud?.view()})))));
    throw error;
  } finally {
    for(const release of releases)release();
    await browser.close();
    await app.close();
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
