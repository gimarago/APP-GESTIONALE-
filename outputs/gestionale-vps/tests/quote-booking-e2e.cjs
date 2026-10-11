'use strict';
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {pathToFileURL}=require('node:url');
const path=require('node:path'),fs=require('node:fs'),os=require('node:os'),assert=require('node:assert/strict');
const {selectAgenda}=require('./navigation-helpers.cjs');
(async()=>{
 const root=path.resolve(__dirname,'..'),dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'officina-quote-booking-'));
 const {createApplication}=await import(pathToFileURL(path.join(root,'server/server.mjs'))),{addUser}=await import(pathToFileURL(path.join(root,'server/database.mjs')));
 const app=await createApplication({root,dataDir,origin:'http://127.0.0.1:8146',env:{NODE_ENV:'test'}});
 for(const [name,role] of [['booking-a','admin'],['booking-b','operator'],['booking-viewer','viewer']])await addUser(app.db,name,'booking-test-password',role);
 await new Promise(resolve=>app.server.listen(8146,'127.0.0.1',resolve));
 const browser=await chromium.launch({...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}),headless:true});
 const errors=[],pages=[];
 const payload=()=>JSON.parse(app.db.prepare('SELECT payload FROM state').get().payload);
 const quotes=()=>JSON.parse(payload().storage['officina-quotes-v1']||'[]');
 const rows=()=>payload().dom['#agendaRows'];
 const sync=page=>page.evaluate(()=>WorkshopCloudHost.flush());
 const frame=page=>page.frames().find(item=>item.url().includes('/legacy'));
 async function login(name){
   const context=await browser.newContext({viewport:{width:1360,height:960}}),page=await context.newPage();pages.push(page);page.on('pageerror',error=>errors.push(error.stack));
   await page.goto('http://127.0.0.1:8146');await page.locator('#username').fill(name);await page.locator('#password').fill('booking-test-password');await page.locator('#loginForm button[type="submit"]').click();
   await page.waitForFunction(()=>document.querySelector('iframe')?.contentWindow?.WorkshopCloud&&!document.querySelector('iframe').contentWindow.WorkshopCloud.initializing);
   return page;
 }
 async function archive(page){let f=frame(page);if(await f.locator('#documentsMenuToggle').getAttribute('aria-expanded')!=='true')await f.locator('#documentsMenuToggle').click();await f.locator('.nav [data-view="quotes"]').click();await page.waitForFunction(()=>document.querySelector('iframe')?.contentWindow?.WorkshopCloud?.view()==='quotes');return frame(page);}
 async function addQuote(page,customer,vehicle,lines,notes=''){
   const f=await archive(page);await f.locator('#newQuote').click();await f.locator('#quoteCustomer').fill(customer);await f.locator('#quoteVehicle').fill(vehicle);await f.locator('#quoteNotes').fill(notes);
   for(let index=0;index<lines.length;index++){
     if(index)await f.locator('#quoteAdd').click();const row=f.locator('.quote-line').nth(index);
     await row.locator('[data-q="description"]').fill(lines[index].description);await row.locator('[data-q="quantity"]').fill(String(lines[index].quantity));await row.locator('[data-q="price"]').fill(String(lines[index].price));
   }
   await f.locator('#quoteForm button[type="submit"]').click();await sync(page);return quotes().find(item=>item.customer===customer).id;
 }
 async function chooseSlot(page,id,date='2026-10-08',minute=600,mobile=false){
   const f=frame(page);await f.locator(`[data-quote-appointment="${id}"]`).click();await f.locator('#appointmentCalendarModal').waitFor({state:'visible'});
   await f.locator('#appointmentCalendarDate').fill(date);await f.locator('#appointmentCalendarDate').dispatchEvent('change');const slot=f.locator(`.appointment-calendar-slot[data-date="${date}"][data-minute="${minute}"]`);if(mobile){await slot.click();await f.locator('#appointmentCalendarBook').click();}else await slot.dblclick();
   await f.locator('#appointmentModal').waitFor({state:'visible'});await f.page().waitForTimeout(120);return f;
 }
 try{
   const a=await login('booking-a');let f=frame(a);
   await f.evaluate(()=>{document.getElementById('customerRows').innerHTML='<tr><td>Cliente due veicoli</td><td>3331112222</td><td>cliente@example.test</td><td>Fiat Panda</td><td><span class="plate">AA123BB</span></td><td>—</td></tr><tr><td>Cliente due veicoli</td><td>3331112222</td><td>cliente@example.test</td><td>Fiat 500</td><td><span class="plate">DL643HB</span></td><td>—</td></tr>';});await sync(a);
   const id=await addQuote(a,'Cliente due veicoli','DL643HB',[{description:'4 pneumatici 205/55 R16 91V Michelin',quantity:4,price:145},{description:'Allineamento ruote',quantity:1,price:20}],'Controllare la ruota anteriore.');f=frame(a);
   await f.locator(`[data-quote-appointment="${id}"]`).click();await f.locator('#appointmentCalendarClose').click();await sync(a);assert.equal(rows().length,0);assert.equal(quotes()[0].status,'Bozza');
   f=await chooseSlot(a,id);assert.equal(await f.locator('#appCustomer').inputValue(),'Cliente due veicoli');assert.equal(await f.locator('#appPlate').inputValue(),'DL643HB');assert.equal(await f.locator('#appVehicle').inputValue(),'Fiat 500');assert.equal(await f.locator('#appPhone').inputValue(),'3331112222');assert.equal(await f.locator('#appEmail').inputValue(),'cliente@example.test');assert.equal(await f.locator('#appointmentNotes').inputValue(),'Controllare la ruota anteriore.');assert.equal(await f.locator('#appAmount').inputValue(),'600.00');assert.equal(await f.locator('#appointmentWorkLines [data-description]').first().inputValue(),'4 pneumatici 205/55 R16 91V Michelin');
   await f.locator('#appCustomer').dispatchEvent('change');assert.equal(await f.locator('#appPlate').inputValue(),'DL643HB');await f.locator('#appointmentForm [data-cloud-close="appointmentModal"]').click();await sync(a);assert.equal(rows().length,0);assert.equal(quotes()[0].status,'Bozza');console.log('PASS picker and form cancellation leave quote and agenda unchanged; multiple vehicles and deferred reset preserve prefill');
   f=await chooseSlot(a,id);await f.locator('#appDate').fill('2026-10-09');await f.locator('#appTime').fill('11:15');await f.locator('#appointmentForm button[type="submit"]').click();await sync(a);
   let q=quotes().find(item=>item.id===id),row=rows().find(item=>item.a['data-quote-id']===id);assert.ok(row,JSON.stringify({q,rows:rows().map(row=>row.a)}));assert.equal(q.status,'Accettato');assert.equal(q.appointmentId,row.a['data-cloud-id']);assert.equal(q.appointmentDate,'2026-10-09');assert.equal(q.appointmentTime,'11:15');assert.equal(row.a['data-date'],'2026-10-09');assert.equal(row.a['data-work-notes'],'Controllare la ruota anteriore.');assert.deepEqual(JSON.parse(row.a['data-acceptance-lines']).map(line=>line.amount),[580,20]);assert.equal(await f.evaluate(()=>WorkshopLedgerCash.snapshot().payments.length),0);assert.equal(rows().length,1);console.log('PASS save atomically accepts quote and links exact row, final edited slot and complete work amounts');
   f=await archive(a);await f.locator(`[data-quote-appointment="${id}"]`).click();await f.locator('#acceptanceModal').waitFor({state:'visible'});assert.equal(await f.locator('#appointmentModal').isVisible(),false);await f.locator('#acceptanceForm [data-cloud-close="acceptanceModal"]').click();assert.equal(rows().length,1);
   await f.locator(`[data-quote="${id}"]`).click();await f.locator('#quoteNotes').fill('Note modificate');await f.locator('#quoteForm button[type="submit"]').click();await sync(a);assert.equal(quotes().find(item=>item.id===id).appointmentId,q.appointmentId);console.log('PASS existing appointment opens without duplicates and quote edits preserve linkage');
   f=await selectAgenda(f);await f.locator('#agendaDatePicker').fill('2026-10-09');await f.locator('#agendaDatePicker').dispatchEvent('change');await f.evaluate(()=>WorkshopAgendaParkingTransfer.transfer(document.querySelector('#agendaRows tr:not(.agenda-empty)')));await sync(a);assert.equal(rows().length,0);assert.equal(payload().dom['#agenda .parking-section .card'].filter(item=>item.a?.['data-quote-id']===id).length,1);f=await archive(a);await f.locator(`[data-quote-appointment="${id}"]`).click();await f.locator('#parkingModal').waitFor({state:'visible'});await f.locator('#parkingForm [data-cloud-close="parkingModal"]').click();assert.equal(rows().length,0);console.log('PASS quote follows linked vehicle after transfer to parking');
   const fractional=await addQuote(a,'Cliente frazioni','CC789DD',[{description:'Fluido A',quantity:0.333,price:1},{description:'Fluido B',quantity:0.333,price:1}]);await a.setViewportSize({width:390,height:844});const mobileButton=frame(a).locator(`[data-quote-appointment="${fractional}"]`);await mobileButton.scrollIntoViewIfNeeded();const mobileBounds=await mobileButton.boundingBox();assert.ok(mobileBounds.x>=0&&mobileBounds.x+mobileBounds.width<=390,'mobile booking action is reachable within viewport');f=await chooseSlot(a,fractional,'2026-10-08',600,true);assert.equal(await f.locator('#appAmount').inputValue(),'0.67');assert.deepEqual(await f.locator('#appointmentWorkLines [data-amount]').evaluateAll(inputs=>inputs.map(input=>input.value)),['0.33','0.34']);await f.locator('#appointmentForm [data-cloud-close="appointmentModal"]').click();await sync(a);await a.setViewportSize({width:1360,height:960});console.log('PASS mobile booking and cancellation, fractional quantities keep exact displayed quote total');
   f=await selectAgenda(frame(a));await f.locator('#agenda .page-head [data-cloud-new-appointment]').click();await f.locator('#appointmentCalendarBook').click();await f.locator('#appCustomer').fill('Intervento ordinario');await f.locator('#appPlate').fill('GG456HH');await f.evaluate(()=>WorkshopAppointmentLines.set([{description:'Controllo ordinario',amount:30}]));await f.locator('#appointmentForm button[type="submit"]').click();await sync(a);assert.ok(rows().some(row=>!row.a['data-quote-id']));assert.equal(quotes().find(item=>item.id===fractional).status,'Bozza');console.log('PASS canceled quote context cannot link a later ordinary calendar appointment');
   const concurrent=await addQuote(a,'Cliente concorrenza','EE123FF',[{description:'Controllo freni',quantity:1,price:70}]);const b=await login('booking-b');await archive(b);await chooseSlot(a,concurrent);await chooseSlot(b,concurrent,'2026-10-10',660);
   await frame(a).locator('#appointmentForm button[type="submit"]').click();await sync(a);await frame(b).locator('#appointmentForm button[type="submit"]').click();await assert.rejects(()=>sync(b));assert.equal(rows().filter(item=>item.a['data-quote-id']===concurrent).length,1);assert.equal(quotes().find(item=>item.id===concurrent).appointmentDate,'2026-10-08');console.log('PASS stale simultaneous booking conflicts atomically, producing one appointment');
   f=await archive(a);const screenshotDir=path.resolve(root,'..','..','work');await a.screenshot({path:path.join(screenshotDir,'quote-booking-desktop.png'),fullPage:true});await a.setViewportSize({width:390,height:844});await a.screenshot({path:path.join(screenshotDir,'quote-booking-mobile.png'),fullPage:true});
   const viewer=await login('booking-viewer'),vf=await archive(viewer);assert.equal(await vf.locator('.quote-book:visible').count(),0);assert.deepEqual(errors,[]);console.log('PASS viewer cannot book appointments; no browser runtime errors');
 }finally{await browser.close();await app.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
