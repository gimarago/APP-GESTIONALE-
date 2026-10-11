const {selectAgenda}=require('./navigation-helpers.cjs');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {pathToFileURL}=require('node:url');
const path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict');

(async()=>{
  const root=path.resolve(__dirname,'..'),dataDir=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'officina-rename-'));
  const {createApplication}=await import(pathToFileURL(path.join(root,'server/server.mjs')));
  const {addUser}=await import(pathToFileURL(path.join(root,'server/database.mjs')));
  const app=await createApplication({root,dataDir,origin:'http://127.0.0.1:8134',env:{NODE_ENV:'test'}});
  await addUser(app.db,'rename-test','test-password-1234','admin');
  await new Promise(resolve=>app.server.listen(8134,'127.0.0.1',resolve));
  const browser=await chromium.launch({...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}),headless:true});
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.stack));
  page.on('dialog',dialog=>dialog.accept());
  const frame=()=>page.frames().find(item=>item.url().includes('/legacy'));
  const ready=()=>page.waitForFunction(()=>document.querySelector('iframe')?.contentWindow?.WorkshopCloud&&!document.querySelector('iframe').contentWindow.WorkshopCloud.initializing);
  const sync=()=>page.evaluate(()=>WorkshopCloudHost.flush());
  try{
    await page.goto('http://127.0.0.1:8134');
    await page.locator('#username').fill('rename-test');
    await page.locator('#password').fill('test-password-1234');
    await page.locator('#loginForm button[type="submit"]').click();
    await ready();
    let f=frame();
    await f.locator('.nav [data-view="clienti"]').click();
    await f.locator('#clienti [data-cloud-open="customerModal"]').click();
    await f.locator('#customerName').fill('Mario Vecchio');
    await f.locator('#customerPhone').fill('3331234567');
    await f.locator('#customerVehicle').fill('Fiat Panda');
    await f.locator('#customerPlate').fill('AA123BB');
    await f.locator('#customerForm button[type="submit"]').click();
    await f.locator('#customerGroups .customer-group-history').first().click();
    await f.locator('#historyModal .add-vehicle').click();
    await f.locator('#customerVehicle').fill('Fiat 500');
    await f.locator('#customerPlate').fill('CC456DD');
    await f.locator('#customerForm button[type="submit"]').click();
    assert.equal(await f.locator('#customerRows tr').count(),2);

    await selectAgenda(f);
    await f.locator('#agenda').waitFor({state:'visible'}); await f.evaluate(() => { document.getElementById('appDate').value = localCreationDate(); openModal('appointmentModal'); });
    await f.locator('#appCustomer').fill('Mario Vecchio');
    if(await f.locator('#vehicleSelectionModal').isVisible())await f.locator('#vehicleSelectionList .vehicle-choice', {hasText:'AA123BB'}).click();
    await f.locator('#appPlate').fill('AA123BB');
    if(await f.locator('#vehicleSelectionModal').isVisible())await f.locator('#vehicleSelectionList .vehicle-choice', {hasText:'AA123BB'}).click();
    await f.locator('#appointmentWorkLines [data-description]').fill('Cambio gomme');
    await f.locator('#appointmentWorkLines [data-amount]').fill('50');
    await f.locator('#appointmentForm button[type="submit"]').click();
    await f.locator('#agendaRows .status-select').selectOption('COMPLETATO');
    await f.locator('.nav [data-view="libroContabile"]').click();
    const outside=f.locator('#ledgerRows .ledger-edit[data-ledger-field="outside"]').first();
    await outside.fill('20');
    await outside.press('Tab');
    const cashId=await f.evaluate(()=>WorkshopLedgerCash.savedAccounts().find(account=>account.meta.customer==='Mario Vecchio')?.id);
    assert.ok(cashId,'completed work has a cash account');
    await f.evaluate(id=>WorkshopLedgerCash.settle(id,new Date().toISOString().slice(0,10)),cashId);
    await sync();
    await selectAgenda(f,'parking');
    await f.locator('.parking-head [data-cloud-open="parkingModal"]').click();
    await f.locator('#parkCustomer').fill('Mario Vecchio');
    if(await f.locator('#vehicleSelectionModal').isVisible())await f.locator('#vehicleSelectionList .vehicle-choice', {hasText:'CC456DD'}).click();
    await f.locator('#parkPlate').fill('CC456DD');
    if(await f.locator('#vehicleSelectionModal').isVisible())await f.locator('#vehicleSelectionList .vehicle-choice', {hasText:'CC456DD'}).click();
    await f.locator('#parkVehicle').fill('Fiat 500');
    await f.locator('#parkWork').fill('Controllo freni');
    await f.locator('#parkingForm button[type="submit"]').click();
    await f.evaluate(()=>{
      localStorage.setItem('officina-table-import-v1',JSON.stringify({history:[{customer:'Mario Vecchio',plate:'AA123BB',vehicle:'Fiat Panda',work:'Tagliando',date:'2025-01-01',amount:100}],stocks:null}));
      localStorage.setItem('officina-quotes-v1',JSON.stringify([{id:'quote-rename',customer:'Mario Vecchio',vehicle:'AA123BB',date:'2026-09-23',status:'Bozza',vat:22,lines:[{description:'Freni',quantity:1,price:30}]}]));
      localStorage.setItem('officina.invoices.v1',JSON.stringify({version:1,seller:{},documents:[{id:'invoice-unchanged',status:'prepared',customer:{name:'Mario Vecchio'}}]}));
    });
    await sync();

    await f.locator('.nav [data-view="clienti"]').click();
    await f.locator('#customerGroups .customer-group-history').first().click();
    await f.locator('#historyModal .modal-actions button', {hasText:'Modifica dati cliente'}).click();
    assert.equal(await f.locator('#fiscalCustomerName').inputValue(),'Mario Vecchio');
    await f.locator('#fiscalCustomerName').fill('Mario Rossi');
    await f.locator('#fiscalEditForm button[type="submit"]').click();
    assert.equal(await f.locator('#fiscalEditModal').isVisible(),false);
    assert.deepEqual(await f.locator('#customerRows tr td:first-child').allTextContents(),['Mario Rossi','Mario Rossi']);
    assert.match(await f.locator('#agendaRows').innerText(),/Mario Rossi/);
    assert.match(await f.locator('.parking-section .parking-row').last().innerText(),/Mario Rossi/);
    const renamed=await f.evaluate(()=>({
      fiscal:JSON.parse(localStorage.getItem('officina.customerFiscal.v1')),
      imported:JSON.parse(localStorage.getItem('officina-table-import-v1')),
      quotes:JSON.parse(localStorage.getItem('officina-quotes-v1')),
      invoices:JSON.parse(localStorage.getItem('officina.invoices.v1'))
    }));
    assert.ok(renamed.fiscal['mario rossi']);
    assert.equal(renamed.fiscal['mario vecchio'],undefined);
    assert.equal(renamed.imported.history[0].customer,'Mario Rossi');
    assert.equal(renamed.quotes[0].customer,'Mario Rossi');
    assert.equal(renamed.invoices.documents[0].customer.name,'Mario Vecchio');
    const renamedCash=await f.evaluate(()=>JSON.parse(localStorage.getItem('ma-gomme-cashbook-v1')));
    assert.equal(renamedCash.accounts.find(account=>account.id===cashId).meta.customer,'Mario Rossi');
    assert.equal(renamedCash.payments.find(payment=>payment.accountId===cashId).meta.customer,'Mario Rossi');
    await f.locator('#customerGroups .customer-group-history').first().click();
    assert.match(await f.locator('#historyTitle').innerText(),/Mario Rossi/);
    await sync();
    console.log('PASS customer rename updates vehicles, appointments, parking, fiscal profile, quotes and imported history while preserving issued invoices');

    await page.reload();await ready();f=frame();
    await f.locator('.nav [data-view="clienti"]').click();
    assert.deepEqual(await f.locator('#customerRows tr td:first-child').allTextContents(),['Mario Rossi','Mario Rossi']);
    await f.locator('#customerGroups .customer-group-history').first().click();
    assert.match(await f.locator('#historyTitle').innerText(),/Mario Rossi/);
    const reloadedCash=await f.evaluate(()=>JSON.parse(localStorage.getItem('ma-gomme-cashbook-v1')));
    assert.equal(reloadedCash.accounts.find(account=>account.id===cashId).meta.customer,'Mario Rossi');
    assert.equal(reloadedCash.payments.find(payment=>payment.accountId===cashId).meta.customer,'Mario Rossi');
    await f.locator('#historyModal .modal-actions button', {hasText:'Chiudi'}).click();
    await f.locator('#clienti [data-cloud-open="customerModal"]').click();
    await f.locator('#customerName').fill('Altro Cliente');
    await f.locator('#customerVehicle').fill('Ford Fiesta');
    await f.locator('#customerPlate').fill('EE789FF');
    await f.locator('#customerForm button[type="submit"]').click();
    await f.locator('#customerGroups .customer-group-history').first().click();
    await f.locator('#historyModal .modal-actions button', {hasText:'Modifica dati cliente'}).click();
    await f.locator('#fiscalCustomerName').fill('Altro Cliente');
    await f.locator('#fiscalEditForm button[type="submit"]').click();
    assert.equal(await f.locator('#fiscalEditModal').isVisible(),true);
    assert.equal(await f.locator('#customerRows tr').first().locator('button').innerText(),'Mario Rossi');
    await f.locator('#fiscalCancel').click();
    assert.deepEqual(errors,[]);
    console.log('PASS customer and cash payment survive reload; duplicate names are rejected');
  }finally{
    await browser.close();
    await app.close();
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
