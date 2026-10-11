const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const R = require('../cloud-records.js');
const {selectAgenda} = require('./navigation-helpers.cjs');

(async () => {
  const root = path.resolve(__dirname, '..');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'officina-navigation-sync-'));
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const { createApplication } = await import(pathToFileURL(path.join(root, 'server/server.mjs')));
  const { addUser } = await import(pathToFileURL(path.join(root, 'server/database.mjs')));
  const app = await createApplication({ root, dataDir, origin, env: { NODE_ENV: 'test' } });
  await addUser(app.db, 'sync-admin', 'test-password-1234', 'admin');
  await addUser(app.db, 'sync-operator', 'test-password-1234', 'operator');
  await new Promise(resolve => app.server.listen(port, '127.0.0.1', resolve));
  const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), headless: true });
  const errors = [];
  const frame = page => page.frames().find(item => item.url().includes('/legacy'));
  async function ready(page, view) {
    try {
      await page.waitForFunction(view => {
        const cloud = document.querySelector('iframe')?.contentWindow?.WorkshopCloud;
        return cloud && !cloud.initializing && !WorkshopCloudHost.synchronizing() && (!view || cloud.view() === view);
      }, view);
    } catch (error) {
      console.error('SYNC READINESS', JSON.stringify(await page.evaluate(() => {
        const cloud = document.querySelector('iframe')?.contentWindow?.WorkshopCloud;
        return {view: cloud?.view(), initializing: cloud?.initializing, applying: cloud?.applying,
          synchronizing: WorkshopCloudHost.synchronizing(), mode: document.getElementById('mode').textContent,
          notice: document.getElementById('notice').textContent, status: document.getElementById('status').textContent,
          requests: window.navigationSyncTestRequests};
      })), errors);
      throw error;
    }
    return frame(page);
  }
  async function navigate(page, view) {
    await frame(page).locator(`.nav [data-view="${view}"]`).click();
    return ready(page, view);
  }
  async function measuredNavigate(page, view) {
    const started = Date.now();
    // Both timestamps use the host browser's clock. Playwright dispatch and
    // response latency are excluded from the check for a forced quiet delay.
    await page.evaluate(view => {
      const requests = window.navigationSyncTestRequests;
      window.navigationSyncTestSwitch = { clickAt: performance.now(), requestIndex: requests.length };
      document.querySelector('iframe').contentDocument.querySelector(`.nav [data-view="${view}"]`).click();
    }, view);
    await ready(page, view);
    await page.waitForFunction(() => {
      const request = window.navigationSyncTestRequests[window.navigationSyncTestSwitch.requestIndex];
      return request && request.status !== null;
    });
    const result = await page.evaluate(() => {
      const navigation = window.navigationSyncTestSwitch;
      const request = window.navigationSyncTestRequests[navigation.requestIndex];
      return {
        clickToRequestMs: request.startedAt - navigation.clickAt,
        status: request.status,
        ifNoneMatch: request.ifNoneMatch,
        etag: request.etag
      };
    });
    result.elapsedMs = Date.now() - started;
    console.log('NAVIGATION', JSON.stringify({ view, ...result }));
    return result;
  }
  async function session(username) {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.navigationSyncLegacyLoads = 0;
    page.on('framenavigated', item => {
      if (item.url().includes('/legacy')) page.navigationSyncLegacyLoads++;
    });
    await page.addInitScript(() => {
      if (window !== window.top) return;
      const nativeFetch = window.fetch.bind(window);
      window.navigationSyncTestRequests = [];
      window.navigationSyncTestWrites = [];
      window.fetch = async (input, options) => {
        const url = new URL(typeof input === 'string' ? input : input.url, location.href);
        const method = options?.method || input.method || 'GET';
        if (url.pathname === '/api/changes' && method === 'PUT') {
          const data = JSON.parse(options.body);
          const write = {startedAt:performance.now(), keys:data.changes.map(change => change.key)};
          window.navigationSyncTestWrites.push(write);
          const response = await nativeFetch(input, options);
          write.status = response.status;
          return response;
        }
        if (url.pathname !== '/api/state' || method !== 'GET') return nativeFetch(input, options);
        const request = {
          startedAt: performance.now(),
          ifNoneMatch: new Headers(options?.headers || input.headers).get('If-None-Match'),
          status: null,
          etag: null
        };
        window.navigationSyncTestRequests.push(request);
        const response = await nativeFetch(input, options);
        request.status = response.status;
        request.etag = response.headers.get('ETag');
        return response;
      };
    });
    page.on('pageerror', error => errors.push(error.stack));
    page.on('dialog', dialog => dialog.accept());
    await page.goto(origin);
    await page.locator('#username').fill(username);
    await page.locator('#password').fill('test-password-1234');
    await page.locator('#loginForm button[type="submit"]').click();
    await ready(page);
    return { context, page };
  }
  const product = '205/55 R16 91V Michelin sincronizzazione';
  const untouchedProduct = 'Prodotto invariato durante sincronizzazione';
  const stockRow = page => frame(page).locator('#stockRows tr').filter({ hasText: product });
  const quantity = page => stockRow(page).locator('.qty-adjust b').innerText().then(Number);
  async function waitQuantity(page, expected) {
    await page.waitForFunction(({product, expected}) => {
      const client = document.querySelector('iframe')?.contentWindow;
      const rows = [...client.document.querySelectorAll('#stockRows tr')];
      const row = rows.find(item => item.cells[0]?.textContent.trim() === product);
      return row && Number(row.querySelector('.qty-adjust b')?.textContent) === expected &&
        !client.WorkshopCloud.initializing && !WorkshopCloudHost.synchronizing();
    }, {product, expected});
  }
  async function waitWorkStatus(page, customer, status) {
    await page.waitForFunction(({customer, status}) => {
      const client = document.querySelector('iframe')?.contentWindow;
      const rows = [...client.document.querySelectorAll('#agendaRows tr')];
      const row = rows.find(item => item.cells[1]?.textContent.trim() === customer);
      return (status === null ? !row : row?.querySelector('.status-select')?.value === status) &&
        !client.WorkshopCloud.initializing && !WorkshopCloudHost.synchronizing();
    }, {customer, status});
  }
  async function changeQuantity(page, direction) {
    const target=stockRow(page),f=frame(page);
    await target.locator(`[data-stock-quantity-action="${direction}"]`).click();
    if(direction==='increase'){
      const cost=await f.evaluate(product=>{const row=[...document.querySelectorAll('#stockRows tr')].find(item=>item.cells[0]?.textContent.trim()===product),text=row?.cells[3]?.textContent||'';return /\d/.test(text)?stockInventoryApi.numberFrom(text):0;},product);
      await f.locator('#stockRestockModal').waitFor({state:'visible'});await f.locator('#stockRestockUnitPrice').fill(String(cost));
      const prior=f.locator('#stockRestockPriorCost');if(await prior.isVisible())await prior.fill(String(cost));
      await f.locator('#stockRestockForm button[type="submit"]').click();await f.locator('#stockRestockModal').waitFor({state:'hidden'});
    }
    await page.evaluate(() => WorkshopCloudHost.flush());
  }
  async function markFrame(page) {
    return frame(page).evaluate(() => window.navigationSyncTestFrame = crypto.randomUUID());
  }
  const frameMark = page => frame(page).evaluate(() => window.navigationSyncTestFrame);
  async function markNodes(page) {
    await frame(page).evaluate(({product, untouchedProduct}) => {
      const rows = [...document.querySelectorAll('#stockRows tr')];
      window.navigationSyncTestNodes = {
        main: document.querySelector('main'),
        root: document.getElementById('stockRows'),
        row: rows.find(row => row.cells[0]?.textContent.trim() === product),
        untouched: rows.find(row => row.cells[0]?.textContent.trim() === untouchedProduct),
        field: document.getElementById('stockSearch'),
        setting: document.getElementById('shopHours'),
        inputEvents: 0
      };
      const refs = window.navigationSyncTestNodes;
      refs.field.addEventListener('input', () => refs.inputEvents++);
    }, {product, untouchedProduct});
  }
  async function assertNodes(page, search) {
    const refs = await frame(page).evaluate(({product, untouchedProduct}) => {
      const refs = window.navigationSyncTestNodes;
      const rows = [...document.querySelectorAll('#stockRows tr')];
      return {
        main: refs.main === document.querySelector('main'),
        root: refs.root === document.getElementById('stockRows'),
        row: refs.row === rows.find(row => row.cells[0]?.textContent.trim() === product),
        untouched: refs.untouched === rows.find(row => row.cells[0]?.textContent.trim() === untouchedProduct),
        field: refs.field === document.getElementById('stockSearch'),
        setting: refs.setting === document.getElementById('shopHours'),
        search: refs.field.value,
        events: refs.inputEvents
      };
    }, {product, untouchedProduct});
    assert.deepEqual({...refs, search: undefined, events: undefined}, {
      main: true, root: true, row: true, untouched: true, field: true, setting: true,
      search: undefined, events: undefined
    });
    assert.equal(refs.search, search);
    assert.ok(refs.events > 0, 'the original filter listener remains attached');
  }
  const snapshot = () => JSON.parse(app.db.prepare('SELECT payload FROM state').get().payload);
  function nodeText(node) {
    return typeof node === 'string' ? node : (node.c || []).map(nodeText).join('');
  }
  function stateQuantity(state) {
    const record = state.dom['#stockRows'].find(row => nodeText(row).includes(product));
    return Number(nodeText(record.c[2]).match(/[\d.]+/)[0]);
  }
  const storedQuantity = () => stateQuantity(snapshot());
  async function assertRevision(expected, message, before) {
    const actual = app.db.prepare('SELECT revision FROM state').get().revision;
    if (actual !== expected) {
      console.error('UNEXPECTED REVISION', JSON.stringify({expected, actual, message,
        changes:before && R.diff(before, snapshot()).map(change => ({key:change.key, before:R.flatten(before).get(change.key), value:change.value})),
        writes:await Promise.all(browser.contexts().map(context => context.pages()[0]?.evaluate(() => window.navigationSyncTestWrites)))}));
    }
    assert.equal(actual, expected, message);
  }
  async function remoteStateChange(change, unchangedCash = false) {
    const login = await fetch(origin + '/api/login', {method:'POST', headers:{origin, 'content-type':'application/json'},
      body:JSON.stringify({username:'sync-admin', password:'test-password-1234'})});
    assert.equal(login.status, 200);
    const session = await login.json(), cookie = login.headers.get('set-cookie').split(';')[0];
    const response = await fetch(origin + '/api/state', {headers:{cookie}});
    const current = await response.json(), next = structuredClone(current.state);
    change(next);
    const result = await fetch(origin + '/api/changes', {method:'PUT', headers:{origin, cookie,
      'content-type':'application/json', 'x-csrf-token':session.csrf}, body:JSON.stringify({protocol:2,
        clientId:randomUUID(), mutationId:randomUUID(), versions:current.versions,
        changes:R.diff(current.state, next, current.versions)})});
    assert.equal(result.status, 200, await result.text());
    if (unchangedCash) assert.equal(snapshot().storage['ma-gomme-cashbook-v1'], current.state.storage['ma-gomme-cashbook-v1']);
    return app.db.prepare('SELECT revision FROM state').get().revision;
  }
  // A valid remote record update can arrive without a cash-journal change.
  // Use the public transaction API to exercise this state independently of
  // the local status handler, which may itself persist the cash journal.
  async function remoteWorkChange(customer, status) {
    return remoteStateChange(next => {
    const index = next.dom['#agendaRows'].findIndex(row => nodeText(row.c[1]) === customer);
    assert.ok(index >= 0, 'the remote job exists before its transaction');
    if (status === null) next.dom['#agendaRows'].splice(index, 1);
    else {
      const visit = node => {
        if (typeof node === 'string') return;
        if (node.t === 'select' && node.a?.class?.includes('status-select')) {
          for (const option of node.c) {
            if (typeof option === 'string') continue;
            if ((option.a.value || nodeText(option).trim()) === status) option.a.selected = '';
            else delete option.a.selected;
          }
        }
        for (const child of node.c || []) visit(child);
      };
      visit(next.dom['#agendaRows'][index]);
    }
    }, true);
  }
  let tests = 0;
  const pass = message => { tests++; console.log('PASS', message); };
  let releaseSave, releaseState;
  try {
    const a = await session('sync-admin');
    const b = await session('sync-operator');
    const cleanFrame = await markFrame(a.page);
    await a.page.waitForTimeout(800);
    const idleNavigation = await measuredNavigate(a.page, 'magazzino');
    assert.ok(idleNavigation.clickToRequestMs < 400, `idle section switch delayed ${idleNavigation.clickToRequestMs.toFixed(1)} ms before GET /api/state`);
    pass('a clean idle section switch starts its state request without a fixed 650 ms wait');
    assert.equal(idleNavigation.status, 304);
    assert.ok(idleNavigation.ifNoneMatch);
    assert.equal(idleNavigation.etag, idleNavigation.ifNoneMatch);
    assert.equal(await frameMark(a.page), cleanFrame);
    pass('an unchanged section switch sends If-None-Match, receives 304 and keeps the iframe');
    for (const view of ['clienti', 'magazzino']) {
      const navigation = await measuredNavigate(a.page, view);
      assert.ok(navigation.clickToRequestMs < 400, `repeated section switch delayed ${navigation.clickToRequestMs.toFixed(1)} ms before GET /api/state`);
      assert.equal(navigation.status, 304);
      assert.equal(await frameMark(a.page), cleanFrame);
    }
    pass('repeated clean section switches do not restart an edit quiet window');
    let current = frame(a.page);
    const ownFrame = await markFrame(a.page);
    await current.locator('#magazzino [data-cloud-open="stockModal"]').click();
    await current.locator('#stockProduct').fill(product);
    await current.locator('#stockCategory').selectOption({ index: 1 });
    await current.locator('#stockQuantity').fill('12');
    await current.locator('#stockForm button[type="submit"]').click();
    await a.page.evaluate(() => WorkshopCloudHost.flush());
    await a.page.waitForTimeout(3300);
    assert.equal(await frameMark(a.page), ownFrame);
    assert.equal(await quantity(a.page), 12);
    pass('a confirmed local save keeps the current iframe and displayed stock');

    await current.locator('#magazzino [data-cloud-open="stockModal"]').click();
    await current.locator('#stockProduct').fill(untouchedProduct);
    await current.locator('#stockCategory').selectOption({ index: 1 });
    await current.locator('#stockQuantity').fill('3');
    await current.locator('#stockForm button[type="submit"]').click();
    await a.page.evaluate(() => WorkshopCloudHost.flush());

    await navigate(b.page, 'magazzino');
    assert.equal(await quantity(b.page), 12);
    const oldFrame = await markFrame(b.page);
    const initialLegacyLoads = b.page.navigationSyncLegacyLoads;
    await markNodes(b.page);
    await frame(b.page).locator('#stockSearch').fill('205/55');
    const nextRevision = app.db.prepare('SELECT revision FROM state').get().revision + 1;
    const backgroundState = b.page.waitForResponse(response => new URL(response.url()).pathname === '/api/state' &&
      response.request().method() === 'GET' && response.status() === 200 && response.headers().etag === `"officina-state-${nextRevision}"`);
    await changeQuantity(a.page, 'increase');
    const backgroundResponse = await backgroundState;
    const prefetchedSnapshot = await backgroundResponse.json();
    assert.equal(prefetchedSnapshot.revision, nextRevision);
    assert.equal(stateQuantity(prefetchedSnapshot.state), 13);
    assert.ok(Object.keys(prefetchedSnapshot.versions).length);
    await waitQuantity(b.page, 13);
    assert.equal(await frameMark(b.page), oldFrame);
    assert.equal(await quantity(b.page), 13);
    assert.equal(await frame(b.page).evaluate(() => WorkshopCloud.view()), 'magazzino');
    assert.equal(await frame(b.page).locator('#stockSearch').evaluate(field => document.activeElement === field), true,
      'read-only search focus is preserved during the incoming update');
    await assertNodes(b.page, '205/55');
    assert.equal(storedQuantity(), 13);
    pass('another device changing stock updates the current warehouse without section navigation or an iframe load');

    await frame(b.page).locator('.nav [data-view="magazzino"]').click();
    await b.page.waitForTimeout(250);
    assert.equal(await frameMark(b.page), oldFrame);
    assert.equal(await quantity(b.page), 13);
    pass('clicking the current section preserves the already synchronized stock and iframe');

    const cachedNavigation = await measuredNavigate(b.page, 'clienti');
    assert.ok(cachedNavigation.clickToRequestMs < 400, `clean cached section switch delayed ${cachedNavigation.clickToRequestMs.toFixed(1)} ms before GET /api/state`);
    assert.equal(cachedNavigation.status, 304);
    assert.equal(cachedNavigation.ifNoneMatch, backgroundResponse.headers().etag);
    assert.equal(await frameMark(b.page), oldFrame);
    assert.equal(b.page.navigationSyncLegacyLoads, initialLegacyLoads);
    await assertNodes(b.page, '205/55');
    await navigate(b.page, 'magazzino');
    assert.equal(await quantity(b.page), 13);
    pass('live synchronization adopts the remote snapshot and its versions before the next conditional section switch');
    pass('changing section and returning preserves stock already updated in the current section');
    await frame(b.page).locator('#stockSearch').fill('Michelin');
    await assertNodes(b.page, 'Michelin');
    assert.equal(await frame(b.page).locator('#stockRows tr').filter({hasText: untouchedProduct}).isVisible(), false);
    pass('remote updates keep the iframe, changed and untouched row objects, filters and listeners');

    const savedFrame = await markFrame(b.page);
    await changeQuantity(b.page, 'increase');
    await b.page.waitForTimeout(3300);
    assert.equal(await frameMark(b.page), savedFrame);
    assert.equal(await quantity(b.page), 14);
    pass('the updated remote stock control remains editable and a self-save keeps the iframe in place');

    // A slow network request must not delay displaying the chosen clean view.
    // Change the destination again while the same request is held: the latest
    // choice must win without making another iframe or erasing the filter.
    let stateStarted;
    const delayedStateStarted = new Promise(resolve => { stateStarted = resolve; });
    const stateGate = new Promise(resolve => { releaseState = resolve; });
    let heldState = false;
    await b.page.route('**/api/state', async route => {
      if (route.request().method() === 'GET' && !heldState) {
        heldState = true;
        stateStarted();
        await stateGate;
      }
      await route.continue();
    });
    await b.page.evaluate(() => {
      window.navigationSyncTestSlowClick = performance.now();
      document.querySelector('iframe').contentDocument.querySelector('.nav [data-view="clienti"]').click();
    });
    await delayedStateStarted;
    await b.page.waitForFunction(() => document.querySelector('iframe').contentWindow.WorkshopCloud.view() === 'clienti');
    const immediateViewMs = await b.page.evaluate(() => performance.now() - window.navigationSyncTestSlowClick);
    assert.ok(immediateViewMs < 400, `clean section visibility waited ${immediateViewMs.toFixed(1)} ms for a held network request`);
    assert.ok(await frame(b.page).locator('#clienti').isVisible());
    assert.equal(await b.page.evaluate(() => WorkshopCloudHost.synchronizing()), true);
    await frame(b.page).locator('.nav [data-view="postit"]').click();
    await b.page.waitForFunction(() => document.querySelector('iframe').contentWindow.WorkshopCloud.view() === 'postit');
    assert.ok(await frame(b.page).locator('#postit').isVisible());
    assert.equal(await frameMark(b.page), savedFrame);
    releaseState();
    await ready(b.page, 'postit');
    await b.page.unroute('**/api/state');
    await navigate(b.page, 'magazzino');
    await assertNodes(b.page, 'Michelin');
    assert.equal(b.page.navigationSyncLegacyLoads, initialLegacyLoads);
    pass('slow GET requests and rapid clean switches display the latest section immediately without blanking or reloading the iframe');

    const populatedFrame = await markFrame(b.page);
    await frame(b.page).locator('.nav [data-view="magazzino"]').click();
    for (const view of ['clienti', 'magazzino', 'postit', 'magazzino']) {
      const navigation = await measuredNavigate(b.page, view);
      assert.ok(navigation.clickToRequestMs < 400, `clean populated section switch delayed ${navigation.clickToRequestMs.toFixed(1)} ms before GET /api/state`);
      assert.equal(navigation.status, 304);
      assert.equal(await frameMark(b.page), populatedFrame);
    }
    assert.equal(await quantity(b.page), 14);
    pass('active-section clicks and rapid switches over populated stock do not start an edit quiet window');

    // Legacy handlers may finish an edit shortly after its writable click.
    // Start navigation before this timer fires: draining must capture the
    // follow-up field value rather than conclude that the screen was clean.
    const delayedValue = 'Promemoria completato dal gestore ritardato';
    await frame(b.page).evaluate(value => {
      const trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.textContent = 'Modifica locale ritardata';
      trigger.addEventListener('click', () => setTimeout(() => {
        const field = document.getElementById('shopHours');
        field.value = value;
        field.dispatchEvent(new Event('input', { bubbles: true }));
      }, 150));
      document.body.append(trigger);
      trigger.click();
      trigger.remove();
      document.querySelector('.nav [data-view="clienti"]').click();
    }, delayedValue);
    await ready(b.page, 'clienti');
    assert.equal(snapshot().fields.shopHours, delayedValue);
    assert.equal(await frame(b.page).locator('#shopHours').inputValue(), delayedValue);
    pass('section navigation preserves a local field edit completed 150 ms after its writable click');

    // Hold the operator's independent write before it reaches the server.
    // Navigation must drain this write before applying the administrator's stock edit.
    await navigate(a.page, 'clienti');
    await navigate(a.page, 'magazzino');
    assert.equal(await frame(a.page).locator('#shopHours').inputValue(), delayedValue);
    pass('remote workshop settings update in the existing field and synchronized snapshot');
    await navigate(b.page, 'postit');
    let saveStarted;
    const started = new Promise(resolve => { saveStarted = resolve; });
    const gate = new Promise(resolve => { releaseSave = resolve; });
    let held = false;
    await b.page.route('**/api/changes', async route => {
      if (route.request().method() === 'PUT' && !held) {
        held = true;
        saveStarted();
        await gate;
      }
      await route.continue();
    });
    await frame(b.page).locator('#postitText').fill('Nota indipendente prima del cambio sezione');
    await frame(b.page).locator('#postitForm button[type="submit"]').click();
    await started;
    await changeQuantity(a.page, 'increase');
    const pendingFrame = await markFrame(b.page);
    await frame(b.page).locator('.nav [data-view="clienti"]').click();
    await b.page.waitForTimeout(200);
    assert.equal(await frameMark(b.page), pendingFrame);
    assert.equal(await frame(b.page).evaluate(() => WorkshopCloud.view()), 'postit');
    releaseSave();
    await ready(b.page, 'clienti');
    await b.page.unroute('**/api/changes');
    assert.match(JSON.stringify(snapshot()), /Nota indipendente prima del cambio sezione/);
    assert.equal(storedQuantity(), 15);
    await navigate(b.page, 'magazzino');
    assert.equal(await quantity(b.page), 15);
    pass('section navigation drains pending local writes and merges independent remote edits');

    await navigate(b.page, 'clienti');
    current = frame(b.page);
    await current.locator('#clienti [data-cloud-open="customerModal"]').first().click();
    await current.locator('#customerName').fill('Cliente ancora in compilazione');
    await current.locator('#customerPlate').fill('ZZ999ZZ');
    const draftFrame = await markFrame(b.page);
    await changeQuantity(a.page, 'increase');
    await b.page.waitForTimeout(3300);
    assert.equal(await frameMark(b.page), draftFrame);
    // The modal overlay already blocks pointer navigation. Exercise the
    // confirmation path with a dispatched sidebar click and first cancel it.
    b.page.removeAllListeners('dialog');
    let canceledConfirmation='';
    b.page.once('dialog', async dialog => { canceledConfirmation=dialog.message(); await dialog.dismiss(); });
    await current.locator('.nav [data-view="postit"]').dispatchEvent('click');
    await b.page.waitForTimeout(200);
    assert.equal(await frameMark(b.page), draftFrame);
    assert.equal(await frame(b.page).evaluate(() => WorkshopCloud.view()), 'clienti');
    assert.equal(await frame(b.page).locator('#customerName').inputValue(), 'Cliente ancora in compilazione');
    assert.equal(await frame(b.page).locator('#customerPlate').inputValue(), 'ZZ999ZZ');
    assert.ok(await frame(b.page).locator('#customerModal').evaluate(node => node.classList.contains('open')));
    assert.match(canceledConfirmation, /cambiare sezione/i);
    assert.match(await b.page.locator('#notice').innerText(), /annullato/i);
    b.page.once('dialog', async dialog => { assert.match(dialog.message(), /senza salvare/i); await dialog.accept(); });
    await current.locator('.nav [data-view="postit"]').dispatchEvent('click');
    await b.page.waitForFunction(() => document.querySelector('iframe')?.contentWindow?.WorkshopCloud?.view() === 'postit');
    assert.ok(!(await frame(b.page).locator('#customerModal').evaluate(node => node.classList.contains('open'))));
    assert.equal(await frame(b.page).locator('#customerName').inputValue(), '');
    assert.equal(await frame(b.page).locator('#customerPlate').inputValue(), '');
    assert.equal(await frame(b.page).locator('#customerRows').getByText('Cliente ancora in compilazione').count(), 0);
    await navigate(b.page, 'magazzino');
    assert.equal(await quantity(b.page), 16);
    pass('section change asks before discarding an open form; cancel preserves it and acceptance closes it before navigating');

    // A remotely completed tyre job arrives with its stock receipt and cash
    // account in one snapshot. Applying and redrawing it must not repeat any
    // of those business effects or send an unintended save back to the server.
    const completedCustomer = 'Lavoro completato altro dispositivo';
    await selectAgenda(frame(a.page));
    await ready(a.page, 'agenda');
    current = frame(a.page);
    await current.evaluate(() => openNewAcceptance());
    await current.locator('#appTime').fill('09:30');
    await current.locator('#appCustomer').fill(completedCustomer);
    await current.locator('#appPlate').fill('NS123AA');
    await current.locator('#appVehicle').fill('Auto sincronizzazione');
    await current.locator('#appointmentWorkLines [data-description]').fill('2 205/55 R16 91V Michelin');
    await current.locator('#appointmentWorkLines [data-amount]').fill('120');
    await current.locator('#appointmentForm button[type="submit"]').click();
    await a.page.evaluate(() => WorkshopCloudHost.flush());
    const completedRow = current.locator('#agendaRows tr:not(.agenda-empty)').filter({hasText: completedCustomer});
    await completedRow.evaluate(row => {
      const lines = JSON.parse(row.dataset.acceptanceLines);
      lines[0].profit = 45; lines[0].profitMode = 'manual';
      row.dataset.acceptanceLines = JSON.stringify(lines);
    });
    await completedRow.locator('.status-select').selectOption('COMPLETATO');
    // Persist the prepared journal as well as its live source row so the next
    // device must refresh the cash model it created at startup.
    await current.evaluate(() => WorkshopLedgerCash.save());
    await a.page.evaluate(() => WorkshopCloudHost.flush());
    assert.equal(await quantity(a.page), 14);
    const completedSnapshot = snapshot();
    const completedCash = JSON.parse(completedSnapshot.storage['ma-gomme-cashbook-v1']);
    const remoteAccount = completedCash.accounts.find(account => account.meta.customer === completedCustomer);
    assert.ok(remoteAccount);
    const completedRevision = app.db.prepare('SELECT revision FROM state').get().revision;
    const completedFrame = await frameMark(b.page);
    await waitQuantity(b.page, 14);
    assert.equal(await frame(b.page).evaluate(() => WorkshopCloud.view()), 'magazzino');
    assert.equal(await frame(b.page).evaluate(customer => {
      const row = [...document.querySelectorAll('#agendaRows tr')].find(row => row.cells[1]?.textContent === customer);
      return getLedgerEntryState(`agenda:${row.dataset.date}:${row.dataset.ledgerKey || row.dataset.cloudId}`).profit;
    }, completedCustomer), 45, 'incoming persisted profit is cached before a normal ledger read');
    await navigate(b.page, 'magazzino');
    assert.equal(await quantity(b.page), 14);
    assert.equal(await frameMark(b.page), completedFrame);
    const details = await frame(b.page).evaluate(customer => {
      const row = [...document.querySelectorAll('#agendaRows tr')].find(row => row.cells[1]?.textContent === customer);
      const entry = WorkshopLedgerCash.snapshot().entries.find(entry => entry.customer === customer);
      return {
        status: row.querySelector('.status-select').value,
        deductions: JSON.parse(row.dataset.agendaTyreDeductions),
        cash: {id: entry.cashId, amount: entry.amount, inCash: entry.state.inCash, outside: entry.state.outside, profit:entry.state.profit}
      };
    }, completedCustomer);
    assert.equal(details.status, 'COMPLETATO');
    assert.equal(details.deductions.length, 1);
    assert.equal(details.deductions[0].quantity, 2);
    assert.deepEqual(details.cash, {id: remoteAccount.id, amount: 120, inCash: 120, outside: 0, profit:45});
    await navigate(b.page, 'postit');
    await navigate(b.page, 'magazzino');
    await b.page.waitForTimeout(1800);
    assert.equal(await quantity(b.page), 14);
    assert.equal(app.db.prepare('SELECT revision FROM state').get().revision, completedRevision,
      'applying a remote completion must not write duplicate cash or stock effects');
    const repeatedCash = JSON.parse(snapshot().storage['ma-gomme-cashbook-v1']);
    assert.equal(repeatedCash.accounts.filter(account => account.meta.customer === completedCustomer).length, 1);
    assert.deepEqual(repeatedCash, completedCash);
    assert.equal(b.page.navigationSyncLegacyLoads, initialLegacyLoads);
    pass('remote completed work applies stock and cash exactly once in the current section without a frame load or unintended save');

    // A legacy imported row may retain its cash ID while its cash record is
    // absent. First ensure a new local completion persists correctly; then
    // remove only the account through the public remote transaction API to
    // prepare the legacy case. Receiving it must remain a read-only derivation.
    const unpersistedCustomer = 'Incasso remoto senza journal persistito';
    await current.evaluate(() => openNewAcceptance());
    await current.locator('#appTime').fill('10:00');
    await current.locator('#appCustomer').fill(unpersistedCustomer);
    await current.locator('#appPlate').fill('NS124AA');
    await current.locator('#appVehicle').fill('Auto registro sincronizzazione');
    await current.locator('#appointmentWorkLines [data-description]').fill('Servizio registro sincronizzazione');
    await current.locator('#appointmentWorkLines [data-amount]').fill('35');
    await current.locator('#appointmentForm button[type="submit"]').click();
    await a.page.evaluate(() => WorkshopCloudHost.flush());
    const unpersistedRow = current.locator('#agendaRows tr:not(.agenda-empty)').filter({hasText: unpersistedCustomer});
    await unpersistedRow.evaluate(row => {
      const lines = JSON.parse(row.dataset.acceptanceLines);
      lines[0].profit = 25; lines[0].profitMode = 'manual';
      row.dataset.acceptanceLines = JSON.stringify(lines);
    });
    await unpersistedRow.locator('.status-select').selectOption('COMPLETATO');
    await a.page.evaluate(() => WorkshopCloudHost.flush());
    const unpersistedCashId = await unpersistedRow.getAttribute('data-cash-account-id');
    assert.match(unpersistedCashId, /^cash-/);
    assert.equal(JSON.parse(snapshot().storage['ma-gomme-cashbook-v1']).accounts.some(account => account.id === unpersistedCashId), true,
      'the local first completion persists its own cash account');
    await remoteStateChange(next => {
      const cash = JSON.parse(next.storage['ma-gomme-cashbook-v1']);
      assert.equal(cash.payments.some(payment => payment.accountId === unpersistedCashId), false);
      cash.accounts = cash.accounts.filter(account => account.id !== unpersistedCashId);
      next.storage['ma-gomme-cashbook-v1'] = JSON.stringify(cash);
    });
    let rawCashWithoutJob = snapshot().storage['ma-gomme-cashbook-v1'];
    assert.equal(JSON.parse(rawCashWithoutJob).accounts.some(account => account.id === unpersistedCashId), false);
    const unpersistedRevision = app.db.prepare('SELECT revision FROM state').get().revision;
    const unpersistedSnapshot = snapshot();
    await navigate(b.page, 'clienti');
    assert.deepEqual(await frame(b.page).evaluate(customer => {
      const row = [...document.querySelectorAll('#agendaRows tr')].find(row => row.cells[1]?.textContent === customer);
      const state = getLedgerEntryState(`agenda:${row.dataset.date}:${row.dataset.ledgerKey || row.dataset.cloudId}`);
      return {inCash:state.inCash, outside:state.outside, profit:state.profit};
    }, unpersistedCustomer), {inCash:35, outside:0, profit:25}, 'structured profit is cached during apply before a normal ledger read');
    await navigate(b.page, 'libroContabile');
    const unpersistedDetails = await frame(b.page).evaluate(customer => {
      const row = [...document.querySelectorAll('#agendaRows tr')].find(row => row.cells[1]?.textContent === customer);
      const entry = WorkshopLedgerCash.snapshot().entries.find(entry => entry.customer === customer);
      return {id:row.dataset.cashAccountId, status:row.querySelector('.status-select').value,
        cash:{id:entry.cashId, amount:entry.amount, inCash:entry.state.inCash, outside:entry.state.outside, profit:entry.state.profit}};
    }, unpersistedCustomer);
    assert.deepEqual(unpersistedDetails, {id:unpersistedCashId, status:'COMPLETATO',
      cash:{id:unpersistedCashId, amount:35, inCash:35, outside:0, profit:25}});
    await navigate(b.page, 'postit');
    await navigate(b.page, 'libroContabile');
    await b.page.waitForTimeout(1800);
    assert.equal(await frame(b.page).locator('#agendaRows tr').filter({hasText: unpersistedCustomer}).getAttribute('data-cash-account-id'), unpersistedCashId);
    assert.equal(snapshot().storage['ma-gomme-cashbook-v1'], rawCashWithoutJob);
    await assertRevision(unpersistedRevision, 'an unpersisted remote cash entry must remain a read-only derivation', unpersistedSnapshot);
    pass('remote completion with an unpersisted journal keeps its cash ID and ledger amount without an unintended save');

    // Saving a real receipt on another unfinished job must not turn a
    // consultation-only account into a shared financial record.
    const waitingCustomer = 'Acconto su lavoro indipendente in attesa';
    await selectAgenda(frame(b.page));
    const receivingFrame = frame(b.page);
    await receivingFrame.evaluate(() => openNewAcceptance());
    await receivingFrame.locator('#appTime').fill('11:00');
    await receivingFrame.locator('#appCustomer').fill(waitingCustomer);
    await receivingFrame.locator('#appPlate').fill('NS125AA');
    await receivingFrame.locator('#appVehicle').fill('Auto lavoro indipendente');
    await receivingFrame.locator('#appointmentWorkLines [data-description]').fill('Servizio indipendente da contabilizzare');
    await receivingFrame.locator('#appointmentWorkLines [data-amount]').fill('60');
    await receivingFrame.locator('#appointmentForm button[type="submit"]').click();
    await b.page.evaluate(() => WorkshopCloudHost.flush());
    assert.equal(JSON.parse(snapshot().storage['ma-gomme-cashbook-v1']).accounts.some(account => account.id === unpersistedCashId), false);
    const waitingRow = receivingFrame.locator('#agendaRows tr:not(.agenda-empty)').filter({hasText:waitingCustomer});
    await waitingRow.evaluate(row => WorkshopLedgerCash.recordDeposit(row, '10', crypto.randomUUID()));
    await b.page.evaluate(() => WorkshopCloudHost.flush());
    await waitingRow.locator('.status-select').selectOption('IN LAVORAZIONE');
    await b.page.evaluate(() => WorkshopCloudHost.flush());
    rawCashWithoutJob = snapshot().storage['ma-gomme-cashbook-v1'];
    const independentCash = JSON.parse(rawCashWithoutJob);
    assert.equal(independentCash.accounts.some(account => account.id === unpersistedCashId), false);
    const waitingAccount = independentCash.accounts.find(account => account.meta.customer === waitingCustomer);
    assert.ok(waitingAccount);
    assert.equal(waitingAccount.status, 'IN LAVORAZIONE');
    assert.equal(independentCash.payments.filter(payment => payment.accountId === waitingAccount.id && payment.kind === 'deposit').length, 1);
    assert.equal(independentCash.payments.find(payment => payment.accountId === waitingAccount.id).cents, 1000);
    const independentRevision = app.db.prepare('SELECT revision FROM state').get().revision;
    await navigate(b.page, 'clienti');
    await navigate(b.page, 'libroContabile');
    await b.page.waitForTimeout(1800);
    assert.equal(snapshot().storage['ma-gomme-cashbook-v1'], rawCashWithoutJob);
    await assertRevision(independentRevision, 'an unrelated waiting job must not persist a consultation-only remote account');
    pass('saving another waiting job and its deposit never persists the omitted remote cash account');

    const hasUnpersistedEntry = () => frame(b.page).evaluate(customer =>
      WorkshopLedgerCash.snapshot().entries.some(entry => entry.customer === customer), unpersistedCustomer);
    const reopenedRevision = await remoteWorkChange(unpersistedCustomer, 'IN LAVORAZIONE');
    const reopenedSnapshot = snapshot();
    await waitWorkStatus(b.page, unpersistedCustomer, 'IN LAVORAZIONE');
    assert.equal(await frame(b.page).evaluate(() => WorkshopCloud.view()), 'libroContabile');
    assert.equal(await hasUnpersistedEntry(), false);
    const reopenedRow = frame(b.page).locator('#agendaRows tr').filter({hasText: unpersistedCustomer});
    assert.equal(await reopenedRow.locator('.status-select').inputValue(), 'IN LAVORAZIONE');
    assert.equal(await reopenedRow.locator('.cash-destination-input').isDisabled(), false,
      'the cash destination control follows the received work status');
    assert.equal(await reopenedRow.locator('[data-register-deposit]').isDisabled(), false,
      'the deposit control follows the received work status');
    await b.page.waitForTimeout(1800);
    assert.equal(snapshot().storage['ma-gomme-cashbook-v1'], rawCashWithoutJob);
    await assertRevision(reopenedRevision, 'remote reopen with unchanged raw cash storage must not trigger a client write', reopenedSnapshot);
    pass('remote reopen with unchanged raw cash storage clears the stale completed ledger entry in the current section');

    await remoteWorkChange(unpersistedCustomer, 'COMPLETATO');
    await waitWorkStatus(b.page, unpersistedCustomer, 'COMPLETATO');
    assert.equal(await hasUnpersistedEntry(), true);
    const deletedRevision = await remoteWorkChange(unpersistedCustomer, null);
    await waitWorkStatus(b.page, unpersistedCustomer, null);
    assert.equal(await frame(b.page).evaluate(() => WorkshopCloud.view()), 'libroContabile');
    assert.equal(await hasUnpersistedEntry(), false);
    await b.page.waitForTimeout(1800);
    assert.equal(snapshot().storage['ma-gomme-cashbook-v1'], rawCashWithoutJob);
    assert.equal(app.db.prepare('SELECT revision FROM state').get().revision, deletedRevision);
    assert.equal(b.page.navigationSyncLegacyLoads, initialLegacyLoads);
    pass('remote deletion with unchanged raw cash storage leaves no phantom archived receipt in the current section');

    await navigate(a.page, 'clienti');
    await navigate(a.page, 'magazzino');
    await navigate(b.page, 'magazzino');

    // Hold B's write before it reaches the server, then let A update the same
    // record. Live synchronization must not replace B's pending draft or adopt
    // the newer stock version before B's stale write is rejected.
    const conflictBase = storedQuantity();
    let conflictSaveStarted;
    const conflictStarted = new Promise(resolve => { conflictSaveStarted = resolve; });
    const conflictGate = new Promise(resolve => { releaseSave = resolve; });
    let conflictHeld = false;
    await b.page.route('**/api/changes', async route => {
      if (route.request().method() === 'PUT' && !conflictHeld) {
        conflictHeld = true;
        conflictSaveStarted();
        await conflictGate;
      }
      await route.continue();
    });
    await stockRow(b.page).locator('[data-stock-quantity-action="decrease"]').click();
    await conflictStarted;
    await changeQuantity(a.page, 'increase');
    await b.page.waitForTimeout(3300);
    assert.equal(await quantity(b.page), conflictBase - 1);
    assert.equal(storedQuantity(), conflictBase + 1);
    releaseSave();
    await assert.rejects(() => b.page.evaluate(() => WorkshopCloudHost.flush()));
    await b.page.unroute('**/api/changes');
    assert.equal(await b.page.locator('#mode').innerText(), 'Modifiche sospese');
    assert.match(await b.page.locator('#notice').innerText(), /Conflitto di modifica/);
    assert.ok(await b.page.locator('#recover').isVisible());
    assert.equal(await quantity(b.page), conflictBase - 1);
    assert.equal(storedQuantity(), conflictBase + 1);
    pass('concurrent stale stock edits remain fenced and preserve the losing draft');

    assert.deepEqual(errors, []);
    pass('no browser runtime errors');
    console.log(JSON.stringify({ dataDir, revision: app.db.prepare('SELECT revision FROM state').get().revision, tests }));
  } finally {
    releaseSave?.();
    releaseState?.();
    await browser.close();
    await app.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
