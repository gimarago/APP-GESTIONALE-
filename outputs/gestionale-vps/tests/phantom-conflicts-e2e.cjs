'use strict';
// Isolated two-device regression: consultation and notes must not become stock
// transactions, while an actual stale quantity write still loses atomically.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {pathToFileURL}=require('node:url');
const path=require('node:path'),fs=require('node:fs'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict');

(async()=>{
  const root=path.resolve(__dirname,'..'),dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'officina-phantom-conflicts-'));
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const origin=`http://127.0.0.1:${port}`;
  const {createApplication}=await import(pathToFileURL(path.join(root,'server/server.mjs'))),{addUser}=await import(pathToFileURL(path.join(root,'server/database.mjs')));
  const app=await createApplication({root,dataDir,origin,env:{NODE_ENV:'test'}});
  await addUser(app.db,'same-account','test-password-1234','admin');await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const errors=[],product='205/55 R16 91V Michelin',customer='Cliente consultazione senza modifiche';
  const frame=page=>page.frames().find(item=>item.url().includes('/legacy'));
  const state=()=>JSON.parse(app.db.prepare('SELECT payload FROM state WHERE id=1').get().payload);
  const revision=()=>app.db.prepare('SELECT revision FROM state WHERE id=1').get().revision;
  const text=node=>typeof node==='string'?node:(node.c||[]).map(text).join('');
  const stock=()=>state().dom['#stockRows'].find(row=>text(row.c[0]).trim()===product);
  const quantity=()=>Number(stock().a['data-quantity']);
  const ready=page=>page.waitForFunction(()=>{const cloud=document.querySelector('iframe')?.contentWindow?.WorkshopCloud;return cloud&&!cloud.initializing&&!WorkshopCloudHost.synchronizing();},null,{timeout:15000});
  const flush=page=>page.evaluate(()=>WorkshopCloudHost.flush());
  const navigate=async(page,view)=>{await frame(page).locator(`.nav [data-view="${view}"]`).click();await ready(page);};
  async function login(mobile=false){
    const context=await browser.newContext(mobile?{viewport:{width:390,height:844},isMobile:true,hasTouch:true}:{viewport:{width:1302,height:900}}),page=await context.newPage();
    page.on('pageerror',error=>errors.push(error.stack));page.on('dialog',dialog=>dialog.accept());
    await page.addInitScript(()=>{if(window!==top)return;window.testWrites=[];const nativeFetch=fetch.bind(window);window.fetch=async(input,options)=>{if(new URL(typeof input==='string'?input:input.url,location.href).pathname!=='/api/changes'||options?.method!=='PUT')return nativeFetch(input,options);const body=JSON.parse(options.body),entry={keys:body.changes.map(change=>change.key)};window.testWrites.push(entry);const result=await nativeFetch(input,options);entry.status=result.status;return result;};});
    await page.goto(origin);await page.locator('#username').fill('same-account');await page.locator('#password').fill('test-password-1234');await page.locator('#loginForm button[type="submit"]').click();await ready(page);return page;
  }
  async function openWork(page){await frame(page).locator('#agendaRows tr').filter({hasText:customer}).locator('td').nth(3).click();await frame(page).locator('#acceptanceModal.open').waitFor();}
  async function decrease(page){await frame(page).locator('#stockRows tr').filter({hasText:product}).locator('[data-stock-quantity-action="decrease"]').click();await flush(page);}
  async function settled(page){await ready(page);await page.waitForTimeout(1800);await ready(page);}
  try{
    const desktop=await login();await navigate(desktop,'magazzino');let f=frame(desktop);
    await f.locator('#magazzino [data-cloud-open="stockModal"]').click();await f.locator('#stockProduct').fill(product);await f.locator('#stockCategory').selectOption('Pneumatici estivi');await f.locator('#stockQuantity').fill('12');await f.locator('#stockPrice').fill('50');await f.locator('#stockForm button[type="submit"]').click();await flush(desktop);
    await navigate(desktop,'agenda');f=frame(desktop);await f.evaluate(()=>openNewAcceptance());await f.locator('#appTime').fill('10:00');await f.locator('#appCustomer').fill(customer);await f.locator('#appPlate').fill('PC123AA');await f.locator('#appointmentWorkLines [data-description]').fill('2 '+product);await f.locator('#appointmentWorkLines [data-amount]').fill('150');await f.locator('#appointmentForm button[type="submit"]').click();await flush(desktop);
    await f.locator('#agendaRows tr').filter({hasText:customer}).locator('.status-select').selectOption('COMPLETATO');await flush(desktop);assert.equal(quantity(),10);
    const phone=await login(true);await navigate(phone,'agenda');await settled(phone);
    const phoneBefore=await phone.evaluate(()=>window.testWrites.length),before=revision();
    await openWork(phone);await phone.waitForTimeout(2000);
    assert.equal(await phone.evaluate(()=>window.testWrites.length),phoneBefore,'opening a stock-linked work does not send a save');assert.equal(revision(),before);
    await navigate(desktop,'magazzino');await decrease(desktop);assert.equal(quantity(),9);
    await phone.waitForTimeout(3500);assert.equal(await phone.locator('#mode').innerText(),'Modifica condivisa');assert.equal(await phone.evaluate(()=>window.testWrites.length),phoneBefore,'an idle open work must not submit hidden changes');
    await frame(phone).locator('#acceptanceModal [data-cloud-close]').click();await frame(phone).evaluate(()=>document.activeElement?.blur());await settled(phone);
    assert.equal(await phone.evaluate(()=>window.testWrites.length),phoneBefore,'closing a consultation and applying peer stock changes remains read-only');assert.equal(quantity(),9);
    console.log('PASS same-account mobile consultation survives remote stock changes without phantom writes');

    // A note is independent of stock. Holding the work modal intentionally keeps
    // its stock snapshot old while the other device changes the inventory.
    await openWork(phone);await decrease(desktop);assert.equal(quantity(),8);await phone.waitForTimeout(1200);
    await frame(phone).locator('#acceptanceNotes').fill('Solo nota, nessuna variazione delle scorte');await frame(phone).locator('#acceptanceForm button[type="submit"]').click();await flush(phone);await settled(phone);
    assert.equal(await phone.locator('#mode').innerText(),'Modifica condivisa');assert.equal(quantity(),8);assert.match(JSON.stringify(state().dom['#agendaRows']),/Solo nota, nessuna variazione delle scorte/);
    console.log('PASS completed-work note saves with an older unrelated inventory version and preserves consumption');

    await navigate(phone,'magazzino');await settled(phone);
    let release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);let held=false;
    await phone.route('**/api/changes',async route=>{if(route.request().method()==='PUT'&&!held){held=true;entered();await gate;}await route.continue();});
    await frame(phone).locator('#stockRows tr').filter({hasText:product}).locator('[data-stock-quantity-action="decrease"]').click();await started;await decrease(desktop);const winner=revision();release();
    await phone.waitForFunction(()=>document.getElementById('mode').textContent==='Modifiche sospese');assert.match(await phone.locator('#notice').innerText(),/Conflitto di modifica/);assert.equal(quantity(),7);assert.equal(revision(),winner);assert.ok((await phone.evaluate(()=>window.testWrites)).some(write=>write.status===409));
    console.log('PASS genuine concurrent stock deductions still conflict without overwriting the winner');
    assert.deepEqual(errors,[]);console.log(JSON.stringify({tests:3,revision:revision()}));
  }catch(error){console.error('PHANTOM CONFLICT DIAGNOSTIC',await Promise.all(browser.contexts().map(context=>context.pages()[0]?.evaluate(()=>({mode:document.getElementById('mode')?.textContent,notice:document.getElementById('notice')?.textContent,writes:window.testWrites})))));throw error;}
  finally{await browser.close();await app.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
