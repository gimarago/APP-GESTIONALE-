const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {pathToFileURL} = require('node:url');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const assert = require('node:assert/strict');

(async () => {
  const root = path.resolve(__dirname, '..');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'officina-tyre-sales-'));
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const {createApplication} = await import(pathToFileURL(path.join(root, 'server/server.mjs')));
  const {addUser} = await import(pathToFileURL(path.join(root, 'server/database.mjs')));
  const app = await createApplication({root, dataDir, origin, env:{NODE_ENV:'test'}});
  await addUser(app.db, 'tyre-admin', 'test-password-1234', 'admin');
  await addUser(app.db, 'tyre-viewer', 'test-password-1234', 'viewer');
  await new Promise(resolve => app.server.listen(port, '127.0.0.1', resolve));
  const browser = await chromium.launch({...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}), headless:true});
  const page = await browser.newPage({viewport:{width:1278, height:1252}}), errors = [];
  page.on('pageerror', error => errors.push(error.stack));
  const frame = p => p.frames().find(item => item.url().endsWith('/legacy'));
  async function login(p, name) {
    await p.goto(origin);
    await p.locator('#username').fill(name);
    await p.locator('#password').fill('test-password-1234');
    await p.locator('#loginForm button[type="submit"]').click();
    await p.waitForFunction(() => document.querySelector('iframe')?.contentWindow?.WorkshopCloud?.initializing === false);
  }
  try {
    await login(page, 'tyre-admin');
    let f = frame(page);
    await f.evaluate(() => {
      function appointment(status, quantity) {
        const lines = status === 'COMPLETATO' ? [
          {description:'2 pneumatici 205/55 R16 91V Falken', amount:200},
          {description:'1 pneumatico 175/65 R15 84T Michelin', amount:80}
        ] : [{description:quantity+' pneumatici 205/55 R16 91V Falken', amount:100}];
        const row = document.getElementById('agendaRows').insertRow();
        row.dataset.date = '2024-01-31'; row.dataset.acceptanceLines = JSON.stringify(lines);
        row.insertCell().textContent = '09:00'; row.insertCell().textContent = 'Cliente calendario'; row.insertCell().textContent = 'AA111BB';
        const work = document.createElement('input'); work.className='work-input'; work.value=lines.map(line=>line.description).join(' · '); row.insertCell().append(work);
        const amount = document.createElement('input'); amount.className='amount-input'; amount.value='280'; row.insertCell().append(amount);
        const select = document.createElement('select'); select.className='status-select'; select.add(new Option(status,status)); row.insertCell().append(select);
      }
      appointment('COMPLETATO'); appointment('IN LAVORAZIONE', 10);
      const row = document.createElement('div'); row.className='parking-row';
      window.renderParkingRow(row, {customer:'Cliente parcheggio',plate:'CC222DD',vehicle:'Fiat 500',entry:'2024-02-01',exit:'2024-02-02',completedDate:'2024-02-02',status:'COMPLETATO',work:'4 pneumatici 205/55 R16 91V Falken',workLines:[{description:'4 pneumatici 205/55 R16 91V Falken',amount:400}]});
      document.querySelector('#agenda .parking-section .card').append(row);
      const history = [
        {customer:'Cliente calendario',plate:'AA111BB',date:'2024-01-31',work:'2 pneumatici 205/55 R16 91V Falken',amount:200},
        {customer:'Storico dicembre',plate:'EE333FF',date:'2023-12-31',work:'1 pneumatico 205/55 R16',amount:100},
        {customer:'Storico febbraio',plate:'GG444HH',date:'2024-02-28',work:'2 pneumatici 205/55 R16',amount:200},
        {customer:'Storico marzo',plate:'II555JJ',date:'2024-03-31',work:'3 pneumatici 205/55 R16',amount:300}
      ];
      localStorage.setItem('officina-table-import-v1',JSON.stringify({history,stocks:null}));
    });
    await page.evaluate(() => WorkshopCloudHost.flush());
    await f.locator('#tyreSalesSummary').click();
    const total = async count => assert.match(await f.locator('#salesDayTotal').innerText(), new RegExp('^'+count+' pneumatici'));
    await f.locator('#salesRange').selectOption('day');
    await f.locator('#salesDate').fill('2024-01-31'); await total(3);
    await f.locator('#salesRange').selectOption('month'); await total(3);
    assert.equal(await f.locator('#salesMonth').inputValue(), '1');
    assert.match(await f.locator('#salesPeriodLabel').innerText(), /gennaio 2024/);
    await f.locator('#salesNextDay').click(); await total(6);
    assert.equal(await f.locator('#salesMonth').inputValue(), '2');
    await f.locator('#salesNextDay').click(); await total(3);
    await f.locator('#salesMonth').selectOption('1'); await total(3);
    await f.locator('#salesPreviousDay').click(); await total(1);
    assert.equal(await f.locator('#salesYear').inputValue(), '2023');
    assert.equal(await f.locator('#salesMonth').inputValue(), '12');
    await f.locator('#salesRange').selectOption('year'); await total(1);
    await f.locator('#salesNextDay').click(); await total(12);
    await f.locator('#salesYear').fill('2023'); await f.locator('#salesYear').press('Tab'); await total(1);
    console.log('PASS day, month and year show completed and imported sales, with period navigation and no duplicates');

    await f.locator('#salesRange').selectOption('week');
    await f.locator('#salesDate').fill('2024-01-31'); await total(7);
    assert.match(await f.locator('#salesPeriodLabel').innerText(), /29\/01\/2024.*04\/02\/2024/);
    await f.locator('#salesNextDay').click(); await total(0);
    await f.locator('#salesPreviousDay').click(); await total(7);
    await f.locator('#salesRange').selectOption('custom');
    await f.locator('#salesStartDate').fill('2024-01-31'); await f.locator('#salesEndDate').fill('2024-02-28'); await total(9);
    assert.equal(await f.locator('#salesPeriodNavigation').isVisible(), false);
    await f.locator('#salesStartDate').fill('2024-03-01');
    assert.match(await f.locator('#salesPeriodLabel').innerText(), /intervallo valido/);
    await f.locator('#salesStartDate').fill('2024-01-31'); await total(9);
    console.log('PASS week navigation spans months and custom ranges use both dates inclusively');

    for (const width of [1278, 390]) {
      await page.setViewportSize({width,height:width===390?844:1252});
      for (const mode of ['month','year','custom']) {
        await f.locator('#salesRange').selectOption(mode);
        const geometry = await f.locator('#tyreSalesModal .modal-card').evaluate(card => {
          const bounds=card.getBoundingClientRect();
          return {overflow:card.scrollWidth-card.clientWidth,left:bounds.left,right:bounds.right,viewport:innerWidth,controls:[...card.querySelectorAll('input,select,button')].filter(el=>el.getClientRects().length).map(el=>{const r=el.getBoundingClientRect();return {id:el.id,left:r.left,right:r.right};})};
        });
        assert.ok(geometry.overflow<=1 && geometry.left>=0 && geometry.right<=geometry.viewport+1, JSON.stringify(geometry));
        assert.ok(geometry.controls.every(control=>control.left>=geometry.left && control.right<=geometry.right+1), JSON.stringify(geometry));
      }
      if(process.env.TYRE_SALES_SCREENSHOT_DIR) await f.locator('#tyreSalesModal .modal-card').screenshot({path:path.join(process.env.TYRE_SALES_SCREENSHOT_DIR,'tyre-sales-'+width+'.png')});
    }
    await f.locator('#tyreSalesModal [data-cloud-close]').click();
    await page.reload(); await page.waitForFunction(() => document.querySelector('iframe')?.contentWindow?.WorkshopCloud?.initializing === false); f=frame(page);
    await f.locator('#tyreSalesSummary').click(); await f.locator('#salesRange').selectOption('month');
    await f.locator('#salesMonth').selectOption('2'); await f.locator('#salesYear').fill('2024'); await f.locator('#salesYear').press('Tab'); await total(6);
    const viewer = await (await browser.newContext()).newPage(); viewer.on('pageerror', error=>errors.push(error.stack));
    await login(viewer,'tyre-viewer'); const v=frame(viewer);
    await v.locator('#tyreSalesSummary').click(); await v.locator('#salesRange').selectOption('month');
    await v.locator('#salesMonth').selectOption('2'); await v.locator('#salesYear').fill('2024'); await v.locator('#salesYear').press('Tab');
    assert.match(await v.locator('#salesDayTotal').innerText(), /^6 pneumatici/);
    assert.deepEqual(errors, []);
    console.log('PASS desktop/mobile controls fit the modal, results survive reload and viewer accounts can choose periods');

    const interrupted = await (await browser.newContext({storageState:await page.context().storageState()})).newPage();
    const storedBeforeFailure = app.db.prepare('SELECT payload, revision FROM state').get();
    await interrupted.route('**/tyre-sales-periods.js', route => route.fulfill({status:404, body:'Missing asset'}));
    await interrupted.goto(origin);
    await interrupted.waitForFunction(() => document.querySelector('iframe')?.contentWindow?.WorkshopCloud?.initializing === false);
    assert.notEqual(await interrupted.locator('#mode').innerText(), 'Modifiche sospese');
    console.log('PASS embedded calendar starts even when the running server cannot serve the new standalone files');
    await interrupted.route('**/legacy', async route => {
      const response = await route.fetch();
      const html = (await response.text()).replace(/(<!-- BEGIN tyre-sales-periods\.js -->\s*<script[^>]*>)[\s\S]*?(<\/script>\s*<!-- END tyre-sales-periods\.js -->)/, '$1$2');
      await route.fulfill({response, body:html});
    });
    await interrupted.reload();
    await interrupted.waitForFunction(() => document.getElementById('mode').textContent === 'Modifiche sospese');
    await interrupted.waitForTimeout(1200);
    assert.match(await interrupted.locator('#status').innerText(), /WorkshopTyreSalesPeriods is not defined/);
    assert.doesNotMatch(await interrupted.locator('#status').innerText(), /workshopToday/);
    assert.equal(await interrupted.locator('#reload').isEnabled(), true);
    const download = interrupted.waitForEvent('download');
    await interrupted.locator('#recover').click();
    const draft = JSON.parse(fs.readFileSync(await (await download).path(), 'utf8'));
    assert.equal(draft.format, 'officina-cloud-drafts');
    assert.ok(JSON.stringify(draft).includes('Storico febbraio'));
    assert.deepEqual(app.db.prepare('SELECT payload, revision FROM state').get(), storedBeforeFailure);
    await interrupted.unroute('**/tyre-sales-periods.js');
    await interrupted.unroute('**/legacy');
    interrupted.once('dialog', dialog => dialog.accept());
    await interrupted.locator('#reload').click();
    await interrupted.waitForFunction(() => document.querySelector('iframe')?.contentWindow?.WorkshopCloud?.initializing === false);
    assert.notEqual(await interrupted.locator('#mode').innerText(), 'Modifiche sospese');
    assert.deepEqual(app.db.prepare('SELECT payload, revision FROM state').get(), storedBeforeFailure);
    await interrupted.close();
    console.log('PASS interrupted startup preserves the original error and data, allows draft export and recovers using server reload');
  } finally { await browser.close(); await app.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
