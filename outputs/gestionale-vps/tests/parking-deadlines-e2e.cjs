'use strict';
const {selectAgenda}=require('./navigation-helpers.cjs');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {pathToFileURL}=require('node:url');
const path=require('node:path'),fs=require('node:fs'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict');
const shift=(value,days)=>{const date=new Date(value+'T12:00:00Z');date.setUTCDate(date.getUTCDate()+days);return date.toISOString().slice(0,10);};

(async()=>{
  const root=path.resolve(__dirname,'..'),dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'officina-parking-deadlines-'));
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const origin=`http://127.0.0.1:${port}`;
  const {createApplication}=await import(pathToFileURL(path.join(root,'server/server.mjs')));
  const {addUser}=await import(pathToFileURL(path.join(root,'server/database.mjs')));
  const app=await createApplication({root,dataDir,origin,env:{NODE_ENV:'test'}});
  await addUser(app.db,'deadline-test','test-password-1234','admin');await addUser(app.db,'deadline-viewer','test-password-1234','viewer');
  await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const errors=[],contexts=[];
  const frame=page=>page.frames().find(item=>item.url().includes('/legacy'));
  const ready=page=>page.waitForFunction(()=>document.querySelector('iframe')?.contentWindow?.WorkshopCloud?.initializing===false);
  const sync=page=>page.evaluate(()=>WorkshopCloudHost.flush());
  const revision=()=>app.db.prepare('SELECT revision FROM state').get().revision;
  const payload=()=>JSON.parse(app.db.prepare('SELECT payload FROM state').get().payload);
  const savedAgenda=()=>JSON.stringify(payload().dom['#agendaRows']);
  const savedCash=()=>JSON.stringify(payload().storage['ma-gomme-cashbook-v1']);
  const savedStock=()=>JSON.stringify(payload().dom['#stockRows']);
  async function login(username='deadline-test'){
    const context=await browser.newContext({viewport:{width:1440,height:1000}});contexts.push(context);const page=await context.newPage();page.on('pageerror',error=>errors.push(error.stack));page.on('dialog',dialog=>dialog.accept());
    await page.goto(origin);await page.locator('#username').fill(username);await page.locator('#password').fill('test-password-1234');await page.locator('#loginForm button[type=submit]').click();await ready(page);return page;
  }
  async function add(page,{customer,plate,end,status='IN LAVORAZIONE'}){
    const f=await selectAgenda(frame(page),'parking');await f.locator('.parking-head [data-cloud-open="parkingModal"]').click();
    await f.locator('#parkCustomer').fill(customer);await f.locator('#parkPlate').fill(plate);await f.locator('#parkVehicle').fill('Fiat Panda');
    await f.locator('#parkWork').fill('Diagnosi motore');await f.locator('#parkWorkAmount').fill('0');await f.locator('#parkStatus').selectOption(status);await f.locator('#parkEnd').fill(end||'');
    await f.locator('#parkingForm button[type=submit]').click();await sync(page);
  }
  async function open(page,date){
    const f=await selectAgenda(frame(page));await f.locator('#agendaDatePicker').fill(date);await f.locator('#agendaDatePicker').dispatchEvent('change');await sync(page);
    await f.locator('#agenda [data-cloud-new-appointment]').click();await f.locator('#appointmentCalendarModal.open').waitFor();return f;
  }
  try{
    const a=await login();let f=frame(a);const date=await f.locator('#agendaDatePicker').inputValue();const start=shift(date,-((new Date(date+'T12:00:00Z').getUTCDay()+6)%7));
    await add(a,{customer:'Scadenza Alfa',plate:'DA123AA',end:shift(start,2)});
    await add(a,{customer:'Scadenza Beta',plate:'DB123BB',end:shift(start,4)});
    await frame(a).evaluate(date=>{const row=[...document.querySelectorAll('.parking-row')].find(item=>item.children[0].textContent.includes('Scadenza Beta'));row.dataset.end=date.split('-').reverse().join('/');WorkshopCloud.changed(true);},shift(start,4));await sync(a);
    await add(a,{customer:'Senza data',plate:'DC123CC',end:''});
    await add(a,{customer:'Pronto al ritiro',plate:'DD123DD',end:shift(start,2),status:'PRONTO AL RITIRO'});
    const before=revision(),beforeAgenda=savedAgenda(),beforeCash=savedCash(),beforeStock=savedStock();
    f=await open(a,start);
    assert.equal(await f.locator('.appointment-calendar-deadline').count(),2);
    assert.equal(await f.locator('.appointment-calendar-deadlines th').innerText(),'Da finire entro');
    assert.equal(await f.locator('.appointment-calendar-event').count(),0,'parking deadlines are separate from scheduled appointments');
    const alfa=f.locator('.appointment-calendar-deadline',{hasText:'Scadenza Alfa'});
    assert.equal(await alfa.getAttribute('data-date'),shift(start,2));assert.match(await alfa.innerText(),/DA123AA.*Fiat Panda[\s\S]*Diagnosi motore/);
    assert.equal(await f.locator('.appointment-calendar-deadline',{hasText:'Scadenza Beta'}).getAttribute('data-date'),shift(start,4),'legacy Italian dates are normalized to the correct calendar column');
    assert.equal(await alfa.evaluate(el=>getComputedStyle(el).borderLeftColor),'rgb(199, 78, 78)','deadline has a red frame');
    await f.locator('#appointmentCalendarNext').click();assert.equal(await f.locator('.appointment-calendar-deadline').count(),0);await f.locator('#appointmentCalendarPrevious').click();
    await sync(a);assert.equal(revision(),before);assert.equal(savedAgenda(),beforeAgenda);assert.equal(savedCash(),beforeCash);assert.equal(savedStock(),beforeStock);
    console.log('PASS red dated deadline cards, week filters and no spontaneous agenda, cash or stock mutations');
    await alfa.click();await f.locator('#parkingModal.open').waitFor();
    assert.equal(await f.locator('#appointmentCalendarModal.open').count(),0);assert.equal(await f.locator('#parkCustomer').inputValue(),'Scadenza Alfa');assert.equal(await f.locator('#parkEnd').inputValue(),shift(start,2));
    assert.equal(await f.locator('#parkWork').inputValue(),'Diagnosi motore');assert.equal(await f.locator('label[for=parkEnd]').innerText(),'Da finire entro');
    await f.locator('#parkEnd').fill(shift(start,3));await f.locator('#parkingForm button[type=submit]').click();await sync(a);
    await a.reload();await ready(a);f=await open(a,start);assert.equal(await f.locator('.appointment-calendar-deadline',{hasText:'Scadenza Alfa'}).getAttribute('data-date'),shift(start,3));assert.equal(await f.locator('.appointment-calendar-deadline').count(),2);
    console.log('PASS exact parking editor opens, editing the deadline and reload move one card without duplication');

    await f.locator('#appointmentCalendarClose').click();f=await selectAgenda(frame(a),'parking');
    f=await open(a,start);await f.locator('.appointment-calendar-deadline',{hasText:'Scadenza Beta'}).click();assert.equal(await f.locator('#parkEnd').inputValue(),shift(start,4),'the legacy date is prefilled in the existing editor');await f.locator('#parkingModal [data-cloud-close]').click();f=await selectAgenda(frame(a),'parking');
    await f.locator('.parking-row',{hasText:'Scadenza Alfa'}).locator('.parking-status').selectOption('COMPLETATO');await sync(a);
    f=await open(a,start);assert.equal(await f.locator('.appointment-calendar-deadline').count(),1);assert.match(await f.locator('.appointment-calendar-deadline').innerText(),/Scadenza Beta/);
    await f.locator('#appointmentCalendarClose').click();f=await selectAgenda(frame(a),'parking');await f.locator('.parking-row',{hasText:'Scadenza Beta'}).locator('[data-remove-parking]').click();await sync(a);
    f=await open(a,start);assert.equal(await f.locator('.appointment-calendar-deadline').count(),0);
    console.log('PASS completed, ready, removed and dateless parking vehicles do not show an active deadline');

    const b=await login();await add(b,{customer:'Scadenza remota',plate:'DE123EE',end:shift(start,1)});
    // The open weekly picker is a browsing surface, so shared parking rows can be refreshed safely.
    await f.locator('.appointment-calendar-deadline',{hasText:'Scadenza remota'}).waitFor({timeout:12000});
    assert.equal(await f.locator('.appointment-calendar-deadline').count(),1);assert.equal(await f.locator('#appointmentCalendarModal.open').count(),1);
    const bFrame=await selectAgenda(frame(b),'parking');await bFrame.locator('.parking-row',{hasText:'Scadenza remota'}).locator(':scope > div:first-child').click();await bFrame.locator('#parkEnd').fill(shift(start,5));await bFrame.locator('#parkingForm button[type=submit]').click();await sync(b);
    await f.waitForFunction(date=>document.querySelector('.appointment-calendar-deadline')?.dataset.date===date,shift(start,5));assert.equal(await f.locator('.appointment-calendar-deadline').count(),1);
    console.log('PASS remote add and deadline edit update the open calendar without reload or duplicate cards');

    await a.setViewportSize({width:390,height:844});const mobileBefore=revision();
    assert.equal(await f.evaluate(()=>{const card=document.querySelector('#appointmentCalendarModal .modal-card').getBoundingClientRect();return card.width<=innerWidth&&card.bottom<=innerHeight;}),true);
    const mobile=f.locator('.appointment-calendar-deadline');await mobile.scrollIntoViewIfNeeded();await mobile.click();assert.equal(await f.locator('#parkCustomer').inputValue(),'Scadenza remota');await f.locator('#parkingModal [data-cloud-close]').click();await sync(a);assert.equal(revision(),mobileBefore);
    const viewer=await login('deadline-viewer');const vf=frame(viewer);const viewerBefore=revision();
    assert.equal(await vf.evaluate(()=>WorkshopAppointmentCalendar.open()),false,'read-only users cannot open writable appointment or parking editors');
    await vf.evaluate(()=>WorkshopAppointmentCalendar.refresh());assert.equal(await vf.locator('.appointment-calendar-deadline').count(),1);assert.equal(await vf.locator('.appointment-calendar-deadline').isDisabled(),true);await sync(viewer);assert.equal(revision(),viewerBefore);
    assert.deepEqual(errors,[]);console.log('PASS phone containment and deadline tap; read-only controls cannot mutate parking, agenda, stock or cash');
  }catch(error){console.error('Browser errors:',errors);for(const context of contexts){for(const page of context.pages()){console.error(await page.locator('body').innerText());}}throw error;
  }finally{for(const context of contexts)await context.close();await browser.close();await app.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
