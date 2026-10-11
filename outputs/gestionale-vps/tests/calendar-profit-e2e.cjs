const {selectAgenda}=require('./navigation-helpers.cjs');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
const fs=require('node:fs');
const os=require('node:os');
const assert=require('node:assert/strict');

(async()=>{
  const root=path.resolve(__dirname,'..');
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'officina-calendar-profit-'));
  const {createApplication}=await import(pathToFileURL(path.join(root,'server/server.mjs')));
  const {addUser}=await import(pathToFileURL(path.join(root,'server/database.mjs')));
  const app=await createApplication({root,dataDir,origin:'http://127.0.0.1:8137',env:{NODE_ENV:'test'}});
  await addUser(app.db,'calendar-profit-test','test-password-1234','admin');
  await new Promise(resolve=>app.server.listen(8137,'127.0.0.1',resolve));
  const browser=await chromium.launch({...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}),headless:true});
  const page=await browser.newPage();
  const errors=[];
  page.on('pageerror',error=>errors.push(error.stack));
  page.on('dialog',dialog=>dialog.accept());
  const frame=()=>page.frames().find(item=>item.url().includes('/legacy'));
  const ready=()=>page.waitForFunction(()=>document.querySelector('iframe')?.contentWindow?.WorkshopCloud&&!document.querySelector('iframe').contentWindow.WorkshopCloud.initializing);
  const sync=()=>page.evaluate(()=>WorkshopCloudHost.flush());
  const payload=()=>JSON.parse(app.db.prepare('SELECT payload FROM state').get().payload);
  const appointmentLines=()=>JSON.parse(payload().dom['#agendaRows'][0].a['data-acceptance-lines']);
  const parkingLines=()=>JSON.parse(payload().dom['#agenda .parking-section .card'].find(node=>node.t==='div'&&node.a?.class?.includes('parking-row')).a['data-work-lines']);
  const moneyValue=value=>Number(String(value).trim().replace(',','.'));
  const ledgerEntry=(f,customer)=>f.locator('#ledgerRows tr[data-ledger-entry]').filter({has:f.locator('td:nth-child(2)',{hasText:customer})});
  const addStock=async(f,{name,price,markup})=>{
    await f.locator('#magazzino [data-cloud-open="stockModal"]').click();
    await f.locator('#stockProduct').fill(name);
    await f.locator('#stockCategory').selectOption('Pneumatici estivi');
    await f.locator('#stockQuantity').fill('8');
    await f.locator('#stockPrice').fill(String(price));
    await f.locator('#stockUnitProfit').fill(String(markup));
    await f.locator('#stockForm button[type="submit"]').click();
    await f.waitForFunction(({name,price,markup})=>[...document.querySelectorAll('#stockRows tr')].some(row=>row.cells[0]?.textContent.trim()===name&&window.stockInventoryApi.numberFrom(row.cells[3]?.textContent)===price&&Number(row.dataset.unitProfit||0)===markup),{name,price,markup});
    await sync();
  };
  try{
    await page.goto('http://127.0.0.1:8137');
    await page.locator('#username').fill('calendar-profit-test');
    await page.locator('#password').fill('test-password-1234');
    await page.locator('#loginForm button[type="submit"]').click();
    await ready();
    let f=frame();
    await f.locator('.nav [data-view="magazzino"]').click();
    await addStock(f,{name:'205/55 R16 91V Michelin',price:30,markup:0});
    await addStock(f,{name:'225/45 R17 91W Pirelli',price:50,markup:12});

    await selectAgenda(f);
    await f.locator('#agenda').waitFor({state:'visible'}); await f.evaluate(() => { document.getElementById('appDate').value = localCreationDate(); openModal('appointmentModal'); });
    await f.locator('#appCustomer').fill('Cliente calendario profitto');
    await f.locator('#appPlate').fill('CP123AA');
    await f.locator('#appointmentWorkLines [data-description]').fill('2 205/55 R16 91V Michelin');
    await f.locator('#appointmentWorkLines [data-amount]').fill('100');
    await f.locator('#appointmentForm button[type="submit"]').click();
    await sync();
    await f.evaluate(()=>openAcceptanceEditorForRow(document.querySelector('#agendaRows tr:not(.agenda-empty)')));
    const acceptance=f.locator('#acceptanceLines .acceptance-line');
    await acceptance.first().locator('.acceptance-amount').press('Tab');
    assert.equal(moneyValue(await acceptance.first().locator('.acceptance-profit').inputValue()),40,'senza ricarico: importo 100 meno 2 scorte da 30');

    await f.locator('#addAcceptanceLine').click();
    await acceptance.nth(1).locator('.acceptance-description').fill('2 225/45 R17 91W Pirelli');
    await acceptance.nth(1).locator('.acceptance-amount').fill('160');
    await acceptance.nth(1).locator('.acceptance-amount').press('Tab');
    assert.equal(moneyValue(await acceptance.nth(1).locator('.acceptance-profit').inputValue()),24,'con ricarico: 2 × 12');

    await f.locator('#addAcceptanceLine').click();
    await acceptance.nth(2).locator('.acceptance-description').fill('Diagnosi centralina');
    await acceptance.nth(2).locator('.acceptance-amount').fill('50');
    await acceptance.nth(2).locator('.acceptance-profit').fill('35');

    await f.locator('#addAcceptanceLine').click();
    await acceptance.nth(3).locator('.acceptance-description').fill('Lavaggio vano motore');
    await acceptance.nth(3).locator('.acceptance-amount').fill('25');
    assert.equal(await acceptance.nth(3).locator('.acceptance-profit').inputValue(),'','lavorazione senza costo riconoscibile rimane vuota');
    await f.locator('#addAcceptanceLine').click();
    await acceptance.nth(4).locator('.acceptance-description').fill('Controllo omaggio');
    await acceptance.nth(4).locator('.acceptance-amount').fill('0');
    await acceptance.nth(4).locator('.acceptance-profit').fill('0');
    await page.setViewportSize({width:390,height:844});
    const mobile=await f.evaluate(()=>{
      const form=document.getElementById('acceptanceForm');
      const lines=document.getElementById('acceptanceLines');
      const formRect=form.getBoundingClientRect();
      return {
        width:innerWidth,
        formOverflow:form.scrollWidth-form.clientWidth,
        linesOverflow:lines.scrollWidth-lines.clientWidth,
        rowOverflow:[...lines.children].map(row=>row.scrollWidth-row.clientWidth),
        profits:[...lines.querySelectorAll('.acceptance-profit')].map(input=>{
          const rect=input.getBoundingClientRect();
          return {left:rect.left,right:rect.right,width:rect.width,visible:rect.width>0&&rect.height>0};
        }),
        formLeft:formRect.left,
        formRight:formRect.right
      };
    });
    assert.equal(mobile.width,390);
    assert.ok(mobile.formOverflow<=1&&mobile.linesOverflow<=1&&mobile.rowOverflow.every(value=>value<=1),'le righe non generano scorrimento orizzontale su telefono');
    assert.ok(mobile.profits.length===5&&mobile.profits.every(rect=>rect.visible&&rect.width>=40&&rect.left>=mobile.formLeft-1&&rect.right<=mobile.formRight+1),'tutti i campi profitto restano visibili nel modulo mobile');
    await page.setViewportSize({width:1280,height:720});
    await f.locator('#acceptanceForm button[type="submit"]').click();
    await sync();
    assert.deepEqual(appointmentLines().map(line=>line.profit),[40,24,35,null,0],'profitti, zero esplicito e campo mancante salvati sul server');
    assert.equal(await f.evaluate(()=>WorkshopLedgerCash.snapshot().entries.filter(entry=>entry.source==='agenda').length),0,'il calendario non contabilizza lavori incompleti');
    console.log('PASS calendar profit suggestions and manual value save without accounting before completion');

    await page.reload();await ready();f=frame();
    await selectAgenda(f);
    await f.evaluate(()=>openAcceptanceEditorForRow(document.querySelector('#agendaRows tr:not(.agenda-empty)')));
    assert.deepEqual(await f.locator('#acceptanceLines .acceptance-profit').evaluateAll(inputs=>inputs.map(input=>input.value===''?null:Number(input.value.replace(',','.')))),[40,24,35,null,0]);
    await f.locator('#acceptanceForm [data-cloud-close="acceptanceModal"]').click();
    await f.locator('#agendaRows .status-select').first().selectOption('COMPLETATO');
    await sync();
    assert.equal(await f.evaluate(()=>WorkshopLedgerCash.snapshot().entries.find(entry=>entry.source==='agenda')?.state.profit),99,'solo profitti presenti sommati nel libro contabile');
    const date=await f.evaluate(()=>document.querySelector('#agendaRows tr:not(.agenda-empty)').dataset.date);
    await f.locator('.nav [data-view="libroContabile"]').click();
    await f.locator('#ledgerDatePicker').fill(date);
    await f.locator('#ledgerDatePicker').dispatchEvent('change');
    const calendarLedger=ledgerEntry(f,'Cliente calendario profitto');
    assert.equal(await calendarLedger.count(),1);
    assert.equal(await calendarLedger.locator('td:nth-child(2) .ledger-profit-warning').count(),1,'triangolo vicino al cliente quando manca un profitto');
    const warningStyle=await calendarLedger.locator('.ledger-profit-warning').evaluate(element=>({text:element.textContent.trim(),color:getComputedStyle(element).color,size:parseFloat(getComputedStyle(element).fontSize)}));
    const colorChannels=warningStyle.color.match(/\d+(?:\.\d+)?/g).map(Number);
    assert.equal(warningStyle.text,'▲');
    assert.ok(colorChannels[0]>colorChannels[1]*1.4&&colorChannels[0]>colorChannels[2]*1.3&&warningStyle.size<=14,'triangolo piccolo e rosso');
    assert.match(await calendarLedger.locator('.ledger-profit-trigger').innerText(),/99,00/);
    console.log('PASS completed calendar work reaches cashbook and flags missing profit');

    await calendarLedger.locator('.ledger-profit-trigger').click();
    await f.locator('#ledgerProfitLines [data-profit-line]').nth(3).fill('15');
    await f.locator('#ledgerProfitForm button[type="submit"]').click();
    await sync();
    assert.deepEqual(appointmentLines().map(line=>line.profit),[40,24,35,15,0],'inserimento da libro contabile aggiornato nella scheda');
    assert.equal(await calendarLedger.locator('.ledger-profit-warning').count(),0,'triangolo rimosso: zero inserito è un profitto valido');
    assert.equal(await f.evaluate(()=>WorkshopLedgerCash.snapshot().entries.find(entry=>entry.source==='agenda')?.state.profit),114);
    await page.reload();await ready();f=frame();
    await f.locator('.nav [data-view="libroContabile"]').click();
    await f.locator('#ledgerDatePicker').fill(date);
    await f.locator('#ledgerDatePicker').dispatchEvent('change');
    assert.equal(await ledgerEntry(f,'Cliente calendario profitto').locator('.ledger-profit-warning').count(),0,'avviso assente anche dopo ricarica');
    assert.deepEqual(appointmentLines().map(line=>line.profit),[40,24,35,15,0],'profitto modificato dal libro contabile persiste sul server');
    await selectAgenda(f);
    await f.evaluate(()=>openAcceptanceEditorForRow(document.querySelector('#agendaRows tr:not(.agenda-empty)')));
    await f.locator('#acceptanceLines .acceptance-profit').first().fill('45');
    await f.locator('#acceptanceForm button[type="submit"]').click();
    await sync();
    assert.equal(appointmentLines()[0].profit,45,'la scheda accettazione resta modificabile dopo il completamento');
    assert.equal(await f.evaluate(()=>WorkshopLedgerCash.snapshot().entries.find(entry=>entry.source==='agenda')?.state.profit),119,'la modifica dalla scheda aggiorna il libro contabile');
    await f.locator('.nav [data-view="libroContabile"]').click();
    await f.locator('#ledgerDatePicker').fill(date);
    await f.locator('#ledgerDatePicker').dispatchEvent('change');
    assert.equal(await ledgerEntry(f,'Cliente calendario profitto').locator('.ledger-profit-warning').count(),0);
    console.log('PASS cashbook and acceptance-sheet profit edits synchronize both ways');

    await selectAgenda(f,'parking');
    await f.locator('.parking-head [data-cloud-open="parkingModal"]').click();
    await f.locator('#parkCustomer').fill('Cliente parcheggio profitto');
    await f.locator('#parkPlate').fill('PP123AA');
    await f.locator('#parkVehicle').fill('Fiat Panda');
    await f.locator('#parkWork').fill('Diagnosi elettrica');
    await f.locator('#parkWorkAmount').fill('60');
    assert.equal(await f.locator('#parkWorkProfit').inputValue(),'');
    await f.locator('#parkingForm button[type="submit"]').click();
    await f.locator('.parking-row .parking-status').first().selectOption('COMPLETATO');
    await sync();
    const parkingDate=await f.evaluate(()=>document.querySelector('.parking-row').dataset.completedDate);
    await f.locator('.nav [data-view="libroContabile"]').click();
    await f.locator('#ledgerDatePicker').fill(parkingDate);
    await f.locator('#ledgerDatePicker').dispatchEvent('change');
    const parkingLedger=ledgerEntry(f,'Cliente parcheggio profitto');
    assert.equal(await parkingLedger.locator('td:nth-child(2) .ledger-profit-warning').count(),1,'triangolo anche per veicolo in parcheggio');
    await selectAgenda(f,'parking');
    await f.locator('.parking-row > div:first-child').first().click();
    await f.locator('#parkWorkProfit').fill('17');
    await f.locator('#parkingForm button[type="submit"]').click();
    await sync();
    assert.equal(parkingLines()[0].profit,17);
    await f.locator('.nav [data-view="libroContabile"]').click();
    await f.locator('#ledgerDatePicker').fill(parkingDate);
    await f.locator('#ledgerDatePicker').dispatchEvent('change');
    assert.equal(await ledgerEntry(f,'Cliente parcheggio profitto').locator('.ledger-profit-warning').count(),0,'triangolo parcheggio sparisce dopo profitto manuale');
    assert.deepEqual(errors,[]);
    console.log('PASS parking warning clears when manual profit is entered without browser errors');
  }finally{
    await browser.close();
    await new Promise(resolve=>app.server.close(resolve));
    app.db.close();
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
