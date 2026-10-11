const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {pathToFileURL} = require('node:url');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const assert = require('node:assert/strict');

(async () => {
  const root = path.resolve(__dirname, '..');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'officina-customer-delete-'));
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const {createApplication} = await import(pathToFileURL(path.join(root, 'server/server.mjs')));
  const {addUser} = await import(pathToFileURL(path.join(root, 'server/database.mjs')));
  const app = await createApplication({root, dataDir, origin, env:{NODE_ENV:'test'}});
  await addUser(app.db, 'delete-admin', 'test-password-1234', 'admin');
  await addUser(app.db, 'delete-viewer', 'test-password-1234', 'viewer');
  await new Promise(resolve => app.server.listen(port, '127.0.0.1', resolve));
  const browser = await chromium.launch({...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}), headless:true});
  const errors = [];
  const frame = page => page.frames().find(item => item.url().includes('/legacy'));
  const ready = page => page.waitForFunction(() => {
    const cloud = document.querySelector('iframe')?.contentWindow?.WorkshopCloud;
    return cloud && !cloud.initializing && !WorkshopCloudHost.synchronizing();
  },undefined,{timeout:15000}).catch(async error => {
    console.error('Browser diagnostics', errors, await page.locator('body').innerText());
    throw error;
  });
  const snapshot = () => JSON.parse(app.db.prepare('SELECT payload FROM state').get().payload);
  async function login(username) {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.stack));
    await page.goto(origin);
    await page.locator('#username').fill(username);
    await page.locator('#password').fill('test-password-1234');
    await page.locator('#loginForm button[type="submit"]').click();
    await ready(page);
    return page;
  }
  async function clients(page, name) {
    const f = frame(page);
    await f.locator('.nav [data-view="clienti"]').click();
    await ready(page);
    await f.locator('#search').fill(name);
    await f.waitForFunction(name => {
      const rows = document.querySelectorAll('#customerGroups .customer-group-row');
      return rows.length === 1 && rows[0].querySelector('.customer-group-toggle').textContent === name;
    }, name);
    return f;
  }
  async function remove(page, plate, accept = true) {
    const f = frame(page), row = f.locator('.customer-vehicle-row').filter({hasText:plate});
    const result = new Promise(resolve => page.once('dialog', async dialog => {
      assert.match(dialog.message(), new RegExp(plate));
      if (accept) await dialog.accept(); else await dialog.dismiss();
      resolve();
    }));
    await row.locator('.customer-vehicle-delete').click();
    await result;
    if (accept) await f.locator('#customerVehicleDeleteStatus').filter({hasText:'Veicolo eliminato dall’anagrafica.'}).waitFor();
  }
  try {
    const page = await login('delete-admin');
    await frame(page).evaluate(() => {
      const source = document.getElementById('customerRows');
      function customer(name, vehicle, plate, revision) {
        const row = source.insertRow();
        row.dataset.cloudId = crypto.randomUUID();
        row.dataset.revisionCategory = revision;
        for (const text of [name, '3331234567', 'cliente@example.it', vehicle, plate, '04/10/2026']) row.insertCell().textContent = text;
      }
      customer('Mario Rossi', 'Fiat Panda', 'AA123BB', 'ordinary');
      customer('Mario Rossi', 'Fiat 500', 'CC456DD', 'taxi');
      customer('Lucia Verdi', 'Renault Clio', 'ZZ987XX', 'taxi');
      const parking = document.querySelector('#agenda .parking-section .card');
      for (const [name, plate] of [['Mario Rossi','AA123BB'],['Lucia Verdi','ZZ987XX']]) {
        const row = document.createElement('div');
        row.className = 'parking-row';
        row.dataset.cloudId = crypto.randomUUID();
        renderParkingRow(row, {customer:name, vehicle:'Veicolo storico', plate, phone:'3331234567', email:'cliente@example.it', km:'12345', entry:'2026-10-04', end:'', exit:'', work:'Lavoro storico da conservare', workLines:[{description:'Lavoro storico da conservare',amount:50,done:false}], notes:'Storico intatto', status:'IN LAVORAZIONE', cashDestination:'inCash'});
        parking.append(row);
      }
      localStorage.setItem('officina-quotes-v1', JSON.stringify([{id:'quote-history', customer:'Mario Rossi', vehicle:'AA123BB', date:'2026-10-04', lines:[{description:'Storico preventivo',quantity:1,price:50}],status:'Bozza',vat:22}]));
      localStorage.setItem('officina-moduli-v1', JSON.stringify([{id:'module-history', type:'privacy', Customer:'Mario Rossi', Date:'2026-10-04'}]));
      localStorage.setItem('officina.customerFiscal.v1', JSON.stringify({'mario rossi':{name:'Mario Rossi',vat:'12345678901'},'lucia verdi':{name:'Lucia Verdi',cf:'VRDLCU90A01H501X'}}));
      localStorage.setItem('officina-table-import-v1', JSON.stringify({history:[{customer:'Mario Rossi',plate:'AA123BB',vehicle:'Panda storica',date:'2026-09-01',work:'Storico importato Mario',amount:50},{customer:'Lucia Verdi',plate:'ZZ987XX',vehicle:'Clio storica',date:'2026-09-01',work:'Storico importato Lucia',amount:70}]}));
      WorkshopCloud.changed();
    });
    await page.evaluate(() => WorkshopCloudHost.flush());
    const original = snapshot();
    const protectedState = state => ({parking:state.dom['#agenda .parking-section .card'],agenda:state.dom['#agendaRows'],quotes:state.storage['officina-quotes-v1'],forms:state.storage['officina-moduli-v1'],fiscal:state.storage['officina.customerFiscal.v1'],cash:state.storage['ma-gomme-cashbook-v1'],imported:state.storage['officina-table-import-v1']});
    await clients(page, 'Mario Rossi');
    assert.equal(await frame(page).locator('.customer-vehicle-row').count(),2);
    await remove(page, 'AA123BB', false);
    assert.equal(await frame(page).locator('#customerRows tr').count(),3,'cancel keeps all vehicles');
    await remove(page, 'AA123BB');
    assert.equal(await frame(page).locator('#customerRows tr').count(),2,'only selected vehicle removed');
    assert.equal(await frame(page).locator('.customer-vehicle-row').count(),1);
    assert.match(await frame(page).locator('.customer-vehicle-row').innerText(), /CC456DD/);
    assert.deepEqual(protectedState(snapshot()), protectedState(original),'work records, finance and documents are unchanged');
    assert.equal(await frame(page).evaluate(() => [...document.querySelectorAll('#customerRows tr')].find(row=>row.cells[4].textContent==='CC456DD').dataset.revisionCategory),'taxi','other vehicle category unchanged');
    console.log('PASS precise vehicle deletion and cancel preserve customer, other vehicle metadata, work history, finance and documents');

    await clients(page, 'Lucia Verdi');
    await remove(page, 'ZZ987XX');
    assert.equal(await frame(page).locator('.customer-vehicle-row').count(),0,'last vehicle becomes customer without vehicle');
    assert.match(await frame(page).locator('.customer-group-row').innerText(), /0 veicoli/);
    assert.equal(await frame(page).evaluate(() => [...document.querySelectorAll('#customerRows tr')].find(row=>row.cells[0].textContent==='Lucia Verdi').dataset.revisionCategory),undefined,'deleted vehicle category cleared');
    await page.reload();
    await ready(page);
    await clients(page, 'Lucia Verdi');
    assert.equal(await frame(page).locator('.customer-vehicle-row').count(),0,'old parking work does not resurrect last removed vehicle');
    assert.equal(await frame(page).locator('#customerRows tr').count(),2,'customer-only row survives reload');
    await frame(page).locator('.customer-group-history').click();
    assert.match(await frame(page).locator('#historyTitle').innerText(), /Lucia Verdi/);
    assert.match(await frame(page).locator('#historyContent').innerText(), /Storico importato Lucia/,'deleted plate history remains readable from customer without vehicles');
    await frame(page).locator('#historyModal [data-cloud-close]').click();
    await clients(page, 'Mario Rossi');
    assert.deepEqual(await frame(page).locator('.customer-vehicle-row .plate').allTextContents(), ['CC456DD'],'removed sibling does not return at reload');
    console.log('PASS removing last vehicle preserves client and suppresses resurrection from existing work after reload');

    const viewer = await login('delete-viewer');
    await clients(viewer, 'Mario Rossi');
    assert.equal(await frame(viewer).locator('.customer-vehicle-delete').isVisible(),false,'delete hidden for read-only account');
    const revision = app.db.prepare('SELECT revision FROM state').get().revision;
    await frame(viewer).evaluate(() => document.querySelector('.customer-vehicle-delete').dispatchEvent(new MouseEvent('click',{bubbles:true})));
    assert.equal(app.db.prepare('SELECT revision FROM state').get().revision,revision,'synthetic click cannot bypass read-only guard');
    console.log('PASS read-only account cannot delete vehicle');

    await clients(page, 'Lucia Verdi');
    await frame(page).locator('.customer-group-history').click();
    await frame(page).locator('#historyModal .add-vehicle').click();
    await frame(page).locator('#customerVehicle').fill('Clio reinserita');
    await frame(page).locator('#customerPlate').fill('ZZ987XX');
    await frame(page).locator('#customerForm button[type="submit"]').click();
    await page.evaluate(() => WorkshopCloudHost.flush());
    await clients(page, 'Lucia Verdi');
    assert.equal(await frame(page).locator('.customer-vehicle-row').count(),1);
    assert.equal(await frame(page).evaluate(() => WorkshopCustomerArchive.isVehicleRemoved('Lucia Verdi','ZZ987XX')),false,'explicit manual re-add clears tombstone');
    assert.equal(await frame(page).evaluate(() => [...document.querySelectorAll('#customerRows tr')].filter(row=>row.cells[0].textContent==='Lucia Verdi').length),1,'placeholder replaced by manually re-associated vehicle');
    await page.reload();
    await ready(page);
    await clients(page, 'Lucia Verdi');
    assert.deepEqual(await frame(page).locator('.customer-vehicle-row .plate').allTextContents(),['ZZ987XX']);
    console.log('PASS vehicle can be explicitly re-associated and persists');

    // Simulate a remote patch while the preliminary flush is still pending.
    await clients(page, 'Mario Rossi');
    await frame(page).evaluate(() => {
      const original = WorkshopCloud.flush;
      WorkshopCloud.flush = async () => {
        WorkshopCloud.flush = original;
        const row = [...document.querySelectorAll('#customerRows tr')].find(item=>item.cells[4].textContent==='CC456DD');
        row.cells[3].textContent = 'Veicolo appena corretto da altro operatore';
      };
    });
    const accepted = new Promise(resolve => page.once('dialog',async dialog=>{await dialog.accept();resolve();}));
    await frame(page).locator('.customer-vehicle-delete').click();
    await accepted;
    await frame(page).locator('#customerVehicleDeleteStatus').filter({hasText:'I dati di questo cliente sono cambiati.'}).waitFor();
    assert.equal(await frame(page).locator('.customer-vehicle-row').count(),1,'stale confirmation does not delete patched vehicle');
    await page.evaluate(() => WorkshopCloudHost.flush());
    assert.deepEqual(errors,[]);
    console.log('PASS stale confirmation is fenced before deletion; no browser errors');
  } finally {
    await browser.close();
    await app.close();
  }
})().catch(error => {console.error(error);process.exitCode=1;});
