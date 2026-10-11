'use strict';
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {pathToFileURL}=require('node:url');
const path=require('node:path'),fs=require('node:fs'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict');

async function availablePort(){const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));return port;}
(async()=>{
  const root=path.resolve(__dirname,'..'),dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'officina-storage-hooks-')),port=await availablePort(),origin=`http://127.0.0.1:${port}`;
  const {createApplication}=await import(pathToFileURL(path.join(root,'server/server.mjs'))),{addUser}=await import(pathToFileURL(path.join(root,'server/database.mjs')));
  const app=await createApplication({root,dataDir,origin,env:{NODE_ENV:'test'}});
  await addUser(app.db,'hooks-test','test-password-1234','admin');
  await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));
  const browser=await chromium.launch({...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}),headless:true}),errors=[];
  try{
    const page=await browser.newPage({viewport:{width:1280,height:960}});page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
    await page.goto(origin);await page.locator('#username').fill('hooks-test');await page.locator('#password').fill('test-password-1234');await page.locator('#loginForm button[type="submit"]').click();
    await page.waitForFunction(()=>document.querySelector('iframe')?.contentWindow?.WorkshopCloud?.initializing===false);
    await page.evaluate(()=>WorkshopCloudHost.flush());
    const f=page.frames().find(frame=>frame.url().includes('/legacy'));
    const result=await f.evaluate(async()=>{
      const quote={id:'quote-from-peer',customer:'Cliente remoto',vehicle:'AA123BB',date:'2026-10-05',status:'Bozza',lines:[{description:'Lavoro remoto',quantity:1,price:40}]};
      const invoice={id:'invoice-from-peer',type:'TD01',status:'draft',date:'2026-10-05',customer:{name:'Cliente remoto'},lines:[{description:'Lavoro remoto',quantity:1,price:40/1.22,grossPrice:40,discount:0,vat:22}],notes:''};
      const storage={
        'officina-quotes-v1':JSON.stringify([quote]),
        'officina-moduli-v1':JSON.stringify([{id:'form-from-peer',type:'privacy',Customer:'Cliente remoto',Date:'2026-10-05'}]),
        'officina.customerFiscal.v1':JSON.stringify({'cliente remoto':{name:'Cliente remoto',cf:'RSSMRA80A01H501U'}}),
        'officina.invoices.v1':JSON.stringify({version:1,seller:{name:'Officina remota'},documents:[invoice],numbering:{2026:18}}),
        'officina-postit':JSON.stringify([{id:'note-from-peer',text:'Appunto remoto',date:'2026-10-05T10:00:00Z',done:false}]),
        'officina-work-notes':JSON.stringify({'2026-10-05|Cliente remoto|AA123BB':'Nota vecchia eliminata sul dispositivo remoto'}),
        'officina-email-settings-v1':JSON.stringify({provider:'outlook',email:'remote@example.test'}),
        'officina.revisionReminders.v1':JSON.stringify({enabled:false,days:60,secondEnabled:false,secondAfter:10,dates:{}}),
        'officina-table-import-v1':JSON.stringify({history:[{customer:'Cliente remoto',plate:'AA123BB',date:'2026-10-05',work:'Controllo remoto'}],stocks:null}),
        'officina.deliveryLoads.v1':JSON.stringify({journal:[{identity:'peer|5|2026-10-05',supplier:'Fornitore remoto',number:'5',date:'2026-10-05',lines:[]}],stock:[]})
      };
      WorkshopCloud.mode(false);
      const previous=WorkshopCloud.capture(),incoming=structuredClone(previous);Object.assign(incoming.storage,storage);
      const stock=document.createElement('tr');stock.dataset.cloudId=crypto.randomUUID();stock.innerHTML='<td>Ricambio remoto</td><td>Materiali di consumo</td><td>3 pz</td><td>€ 10,00</td><td>—</td><td>DISPONIBILE</td>';
      incoming.dom['#stockRows']=[WorkshopCloud.serialize(stock)];
      const customer=document.createElement('tr');customer.dataset.cloudId=crypto.randomUUID();customer.innerHTML='<td>Cliente remoto</td><td>3331112222</td><td>remote@example.test</td><td>Fiat Panda</td><td>AA123BB</td><td>—</td>';
      incoming.dom['#customerRows']=[WorkshopCloud.serialize(customer)];
      const agenda=document.createElement('tr');agenda.dataset.cloudId=crypto.randomUUID();agenda.dataset.date='2026-10-05';agenda.innerHTML='<td>08:00</td><td>Cliente remoto</td><td>AA123BB</td><td><input class="work-input" value="Controllo remoto"></td><td><input class="amount-input" value="0"></td><td><select class="status-select"><option selected>IN ATTESA</option><option>IN LAVORAZIONE</option><option>COMPLETATO</option></select></td>';
      incoming.dom['#agendaRows']=[WorkshopCloud.serialize(agenda)];
      const writes=[];const original=localStorage.setItem;localStorage.setItem=function(...args){writes.push({key:args[0],stack:new Error().stack});return original.apply(this,args);};
      await WorkshopCloud.apply(incoming,previous);
      const legacyId=crypto.randomUUID(),legacy=document.createElement('tr');legacy.dataset.cloudId=legacyId;legacy.dataset.date='2026-10-05';legacy.dataset.cashDestination='outside';legacy.dataset.acceptanceLines=JSON.stringify([{description:'Diagnosi storica',amount:100,profit:20,profitMode:'manual'},{description:'Manodopera storica',amount:200,profit:50,profitMode:'manual'}]);
      legacy.innerHTML='<td>09:00</td><td>Cliente storico senza conto</td><td>AA456CC</td><td><input class="work-input" value="Diagnosi storica · Manodopera storica"></td><td><input class="amount-input" value="300"></td><td><select class="status-select"><option selected>COMPLETATO</option></select></td>';
      const legacyBefore=WorkshopCloud.capture(),legacyIncoming=structuredClone(legacyBefore);legacyIncoming.dom['#agendaRows'].push(WorkshopCloud.serialize(legacy));
      await WorkshopCloud.apply(legacyIncoming,legacyBefore);
      const receivedLegacy=document.querySelector('#agendaRows [data-cloud-id="'+legacyId+'"]'),legacyState=getLedgerEntryState('agenda:2026-10-05:'+legacyId);
      await new Promise(resolve=>setTimeout(resolve,500));
      localStorage.setItem=original;
      const data={writes,legacy:{id:receivedLegacy.dataset.cashAccountId,expectedId:'cash-'+legacyId,profit:legacyState.profit,lineProfits:Object.values(legacyState.lineProfits||{})},quotes:document.getElementById('quotesList').textContent,forms:document.getElementById('formsArchive').textContent,fiscal:WorkshopCustomerFiscal.get('Cliente remoto'),invoices:WorkshopInvoices.documents(),postits:document.getElementById('postitList').textContent,theme:document.body.dataset.appearance,email:await WorkshopEmail.send({to:'cliente@example.test',subject:'Test servizio email',body:'Verifica del servizio email',requestId:crypto.randomUUID(),attachment:{name:'Preventivo-2026-10-05-AB12CD34.pdf',base64:'JVBERi0xLjQK'}}),reminders:[...document.querySelectorAll('#impostazioni .detail-row')].find(row=>row.querySelector('b')?.textContent==='Notifiche promemoria').querySelector('span').textContent,numbering:document.getElementById('invNumberStart').value,workNotes:document.querySelector('#agendaRows tr:not(.agenda-empty)').getAttribute('data-work-notes')};
      WorkshopCloud.mode(true);return data;
    });
    assert.deepEqual(result.writes,[],'cache hydration and archive rendering must not save any business data');
    assert.equal(result.legacy.id,result.legacy.expectedId);assert.equal(result.legacy.profit,70);assert.deepEqual(result.legacy.lineProfits,[20,50]);
    assert.match(result.quotes,/Cliente remoto/);assert.match(result.forms,/Cliente remoto/);assert.equal(result.fiscal.cf,'RSSMRA80A01H501U');assert.equal(result.invoices[0].id,'invoice-from-peer');assert.match(result.postits,/Appunto remoto/);assert.equal(result.theme,'graphite','personal appearance must stay unchanged');assert.deepEqual(result.email,{manual:true,provider:'outlook',email:'remote@example.test'});assert.equal(result.numbering,'18');
    assert.match(result.reminders,/disattivati/);
    assert.equal(result.workNotes,null,'a remotely cleared row note must not be restored from the old compatibility cache');
    await f.evaluate(()=>showPage('postit'));
    await f.locator('#postitText').fill('Appunto locale successivo');await f.locator('#postitForm button[type="submit"]').click();
    assert.deepEqual(await f.evaluate(()=>JSON.parse(localStorage.getItem('officina-postit')).map(note=>note.text)),['Appunto locale successivo','Appunto remoto']);
    await f.evaluate(()=>{showPage('quotes');document.getElementById('newQuote').click();});
    await f.locator('#quoteCustomer').fill('Cliente locale');await f.locator('#quoteDate').fill('2026-10-05');await f.locator('[data-q="description"]').fill('Lavoro locale');await f.locator('[data-q="price"]').fill('25');await f.locator('#quoteForm button[type="submit"]').click();
    assert.deepEqual(await f.evaluate(()=>JSON.parse(localStorage.getItem('officina-quotes-v1')).map(quote=>quote.customer)),['Cliente locale','Cliente remoto']);
    await f.evaluate(()=>{showPage('preventivi');document.getElementById('invSellerName').value='Officina locale';document.getElementById('invSaveSeller').click();});
    assert.equal(await f.evaluate(()=>JSON.parse(localStorage.getItem('officina.invoices.v1')).documents[0].id),'invoice-from-peer','invoice saves must retain the newly loaded remote archive and saved revision');
    await f.evaluate(()=>{showPage('magazzino');[...document.querySelectorAll('#magazzino button')].find(button=>button.textContent==='Importa bolla di consegna').click();});
    assert.match(await f.locator('#ddtHistory').textContent(),/Fornitore remoto/);await f.locator('#ddtCancel').click();
    await page.evaluate(()=>WorkshopCloudHost.flush());
    assert.deepEqual(errors,[]);
    console.log('PASS cloud storage caches refresh without writes, remote archives render in place and later local saves retain peer records');
  }finally{await browser.close();await app.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
