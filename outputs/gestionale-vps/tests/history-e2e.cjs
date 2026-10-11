const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {pathToFileURL} = require('node:url');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const assert = require('node:assert/strict');

async function availablePort() {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

(async () => {
  const root = path.resolve(__dirname, '..');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'officina-history-e2e-'));
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const {createApplication} = await import(pathToFileURL(path.join(root, 'server/server.mjs')));
  const {addUser} = await import(pathToFileURL(path.join(root, 'server/database.mjs')));
  const app = await createApplication({root, dataDir, origin, env:{NODE_ENV:'test'}});
  await addUser(app.db, 'history-test', 'test-password-1234', 'admin');
  await new Promise(resolve => app.server.listen(port, '127.0.0.1', resolve));
  const browser = await chromium.launch({...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}), headless:true});
  const errors = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.locator('#username').fill('history-test');
    await page.locator('#password').fill('test-password-1234');
    await page.locator('#loginForm button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector('iframe')?.contentWindow?.WorkshopCloud?.initializing === false);
    const frame = page.frames().find(item => item.url().includes('/legacy'));

    await frame.evaluate(() => {
      const customer = document.getElementById('customerRows').insertRow();
      for (const text of ['Cliente storico', '—', '—', 'Fiat 500', 'AB 123 CD', '—']) customer.insertCell().textContent = text;
      const date = '2026-09-23';
      function appointment(time, work, lines, status = 'COMPLETATO') {
        const row = document.getElementById('agendaRows').insertRow();
        row.dataset.date = date;
        row.dataset.acceptanceLines = JSON.stringify(lines);
        row.insertCell().textContent = time;
        row.insertCell().textContent = 'Cliente storico';
        row.insertCell().textContent = 'AB 123 CD';
        const workCell = row.insertCell();
        const workInput = document.createElement('input');
        workInput.className = 'work-input';
        workInput.value = work;
        workCell.append(workInput);
        const amountCell = row.insertCell();
        const amountInput = document.createElement('input');
        amountInput.className = 'amount-input';
        amountInput.value = String(lines.reduce((sum, line) => sum + line.amount, 0));
        amountCell.append(amountInput);
        const statusCell = row.insertCell();
        const select = document.createElement('select');
        select.className = 'status-select';
        select.add(new Option(status, status));
        statusCell.append(select);
      }
      appointment('09:00', 'Pneumatici · Batteria', [
        {description:'Quattro pneumatici', amount:360},
        {description:'Batteria', amount:80}
      ]);
      appointment('11:00', 'Freni', [{description:'Controllo freni', amount:50}]);
      appointment('12:00', 'Lavoro non svolto', [{description:'Lavoro non svolto', amount:20}], 'IN LAVORAZIONE');
      const parking = document.createElement('div');
      parking.className = 'parking-row';
      window.renderParkingRow(parking, {
        customer:'Cliente storico', plate:'AB 123 CD', vehicle:'Fiat 500',
        entry:date, exit:date, completedDate:date, km:'80000',
        work:'Volano · Frizione', status:'COMPLETATO',
        workLines:[{description:'Volano', amount:400}, {description:'Frizione', amount:300}]
      });
      document.querySelector('#agenda .parking-section .card').append(parking);
    });
    await frame.locator('.nav [data-view="clienti"]').click();
    await frame.locator('#customerGroups .customer-group-history').click();
    const cards = frame.locator('#historyContent .history-job');
    assert.equal(await cards.count(), 3, 'same-day visits stay separate');
    assert.equal(await cards.filter({hasText:'Quattro pneumatici'}).locator('.history-job-line').count(), 2);
    assert.equal(await cards.filter({hasText:'Volano'}).locator('.history-job-line').count(), 2);
    assert.equal(await cards.filter({hasText:'Lavoro non svolto'}).count(), 0);
    assert.match(await cards.filter({hasText:'Volano'}).locator('.history-job-total').innerText(), /700,00/);
    if (process.env.HISTORY_SCREENSHOT_DESKTOP) {
      await frame.locator('#historyModal .modal-card').screenshot({path:process.env.HISTORY_SCREENSHOT_DESKTOP});
    }

    await frame.locator('#historyWorkSearch').fill('volano');
    assert.equal(await cards.count(), 1);
    assert.equal(await cards.first().locator('.history-job-line').count(), 2, 'search keeps the whole intervention visible');
    await frame.locator('#historyWorkSearch').fill('freni');
    assert.equal(await cards.count(), 1);
    assert.match(await cards.first().innerText(), /Controllo freni/);
    await frame.locator('#historyWorkSearch').fill('inesistente');
    assert.equal(await cards.count(), 0);
    assert.match(await frame.locator('#historyContent').innerText(), /Nessun lavoro eseguito/);
    await frame.locator('#historyModal [data-cloud-close]').click();

    await frame.evaluate(() => localStorage.setItem('officina-table-import-v1', JSON.stringify({
      history:[{customer:'Cliente storico', plate:'AB 123 CD', vehicle:'Fiat 500',
        date:'2026-09-23', work:'Tagliando importato', amount:70, km:79000, notes:'Archivio precedente'}]
    })));
    await frame.locator('#customerGroups .customer-group-history').click();
    assert.equal(await cards.count(), 4, 'imported history is included as a separate intervention');
    await frame.locator('#historyWorkSearch').fill('tagliando');
    assert.equal(await cards.count(), 1);
    assert.match(await cards.first().innerText(), /Archivio precedente/);
    await page.setViewportSize({width:390, height:844});
    const searchBox = await frame.locator('#historyWorkSearch').boundingBox();
    assert.ok(searchBox && searchBox.x >= 0 && searchBox.x + searchBox.width <= 390);
    if (process.env.HISTORY_SCREENSHOT_MOBILE) {
      await frame.locator('#historyModal .modal-card').screenshot({path:process.env.HISTORY_SCREENSHOT_MOBILE});
    }
    assert.deepEqual(errors, []);
    console.log('PASS grouped customer history, completed-only entries, imported work, search and mobile layout');
  } finally {
    await browser.close();
    await new Promise(resolve => app.server.close(resolve));
    app.db.close();
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
