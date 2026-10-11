'use strict';
// Every operation uses its own temporary database. No local or VPS archive is touched.
const {selectAgenda} = require('./navigation-helpers.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {pathToFileURL} = require('node:url');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const root=path.resolve(__dirname,'..'), dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'officina-stock-seasons-'));
  const {createApplication}=await import(pathToFileURL(path.join(root,'server/server.mjs')));
  const {addUser}=await import(pathToFileURL(path.join(root,'server/database.mjs')));
  const app=await createApplication({root,dataDir,origin:'http://127.0.0.1:8157',env:{NODE_ENV:'test'}});
  await addUser(app.db,'season-test','test-password-1234','admin');
  await new Promise(resolve=>app.server.listen(8157,'127.0.0.1',resolve));
  const browser=await chromium.launch({...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}),headless:true});
  const page=await browser.newPage(), errors=[];
  page.on('pageerror',error=>errors.push(error.stack)); page.on('dialog',dialog=>dialog.accept());
  const ready=()=>page.waitForFunction(()=>document.querySelector('iframe')?.contentWindow?.WorkshopCloud?.initializing===false);
  const frame=()=>page.frames().find(item=>item.url().includes('/legacy'));
  const sync=()=>page.evaluate(()=>WorkshopCloudHost.flush());
  const state=()=>app.db.prepare('SELECT revision,payload FROM state WHERE id=1').get();
  let f, counter=0;
  const tyre='155/65/14 75T FALKEN';
  const categories=['Pneumatici estivi','Pneumatici invernali','Pneumatici quattro stagioni'];
  const agenda=name=>f.locator('#agendaRows tr:not(.agenda-empty)').filter({hasText:name});
  const parking=name=>f.locator('#agenda .parking-row').filter({hasText:name});
  const quantities=()=>f.evaluate(({tyre,categories})=>categories.map(category=>{
    const row=[...document.querySelectorAll('#stockRows tr')].find(row=>row.cells[0]?.textContent.trim()===tyre&&row.cells[1]?.textContent.trim()===category);
    return row?Number(row.dataset.quantity):null;
  }),{tyre,categories});
  const productQuantity=product=>f.evaluate(product=>{
    const row=[...document.querySelectorAll('#stockRows tr')].find(row=>row.cells[0]?.textContent.trim()===product);
    return row?Number(row.dataset.quantity):null;
  },product);
  const productReserved=product=>f.evaluate(product=>{
    const row=[...document.querySelectorAll('#stockRows tr')].find(row=>row.cells[0]?.textContent.trim()===product);
    return row?.querySelector('.stock-reserved')?.textContent.trim()||null;
  },product);
  const expectQuantities=async expected=>{
    await f.waitForFunction(({tyre,categories,expected})=>categories.every((category,index)=>{
      const row=[...document.querySelectorAll('#stockRows tr')].find(row=>row.cells[0]?.textContent.trim()===tyre&&row.cells[1]?.textContent.trim()===category);
      return (row?Number(row.dataset.quantity):null)===expected[index];
    }),{tyre,categories,expected});
    assert.deepEqual(await quantities(),expected);
  };
  async function addStock(category,product=tyre,profit=7) {
    await f.locator('.nav [data-view="magazzino"]').click();
    await f.locator('#magazzino [data-cloud-open="stockModal"]').click();
    await f.locator('#stockProduct').fill(product); await f.locator('#stockCategory').selectOption(category);
    await f.locator('#stockQuantity').fill('20'); await f.locator('#stockPrice').fill('60');
    await f.locator('#stockUnitProfit').fill(String(profit));
    await f.locator('#stockForm button[type="submit"]').click(); await sync();
  }
  async function addAgenda(name,description) {
    await selectAgenda(f); await f.evaluate(()=>openNewAcceptance());
    await f.locator('#appTime').fill('10:'+String(counter++).padStart(2,'0'));
    await f.locator('#appCustomer').fill(name); await f.locator('#appPlate').fill('ST'+String(counter).padStart(3,'0')+'AA');
    await f.locator('#appVehicle').fill('Auto test');
    await f.locator('#appointmentWorkLines [data-description]').fill(description);
    await f.locator('#appointmentWorkLines [data-amount]').fill('240');
    await f.locator('#appointmentForm button[type="submit"]').click(); await sync();
    await agenda(name).waitFor();
  }
  async function addParking(name,description) {
    await selectAgenda(f,'parking'); await f.locator('.parking-head [data-cloud-open="parkingModal"]').click();
    await f.locator('#parkCustomer').fill(name); await f.locator('#parkPlate').fill('ST999AA');
    await f.locator('#parkVehicle').fill('Auto test'); await f.locator('#parkWork').fill(description);
    await f.locator('#parkWorkAmount').fill('120'); await f.locator('#parkStatus').selectOption('IN LAVORAZIONE');
    await f.locator('#parkingForm button[type="submit"]').click(); await sync();
  }
  const receipts=row=>row.evaluate(element=>JSON.parse(element.dataset[element.tagName==='TR'?'agendaTyreDeductions':'parkingTyreDeductions']||'[]'));
  async function assertReload(expected) {
    await sync(); const before=state(); await page.reload(); await ready(); f=frame();
    await expectQuantities(expected); await page.waitForTimeout(1800);
    assert.equal(state().revision,before.revision,'hydration must not rewrite saved stock receipts');
    assert.deepEqual(errors,[]);
  }
  try {
    await page.goto('http://127.0.0.1:8157'); await page.locator('#username').fill('season-test');
    await page.locator('#password').fill('test-password-1234'); await page.locator('#loginForm button[type="submit"]').click();
    await ready(); f=frame();
    await addStock(categories[0]);
    await addAgenda('Legacy receipt','1 '+tyre);
    await agenda('Legacy receipt').locator('.status-select').selectOption('COMPLETATO'); await sync();
    const legacyId=(await receipts(agenda('Legacy receipt')))[0].stockId;
    // Simulate the exact receipt shape of an archive from the previous release.
    await agenda('Legacy receipt').evaluate(row=>row.dataset.agendaTyreDeductions=JSON.stringify(JSON.parse(row.dataset.agendaTyreDeductions).map(({requestSignature,...entry})=>entry)));
    await sync(); await addStock(categories[1],tyre,11); await addStock(categories[2],tyre,15);
    await expectQuantities([19,20,20]); await assertReload([19,20,20]);
    assert.equal((await receipts(agenda('Legacy receipt')))[0].stockId,legacyId);
    console.log('PASS legacy receipt preserves its actual stock ID after new seasonal variants and reload');

    const allWork='montaggio 4 gomme AS 155/65/14 75T FALKEN';
    await addAgenda('All season job',allWork);
    assert.equal(await f.evaluate(text=>getStockLineProfit(text),allWork),60,'profit uses all-season markup');
    await f.waitForFunction(()=>[...document.querySelectorAll('#stockRows tr')].find(row=>row.cells[1]?.textContent==='Pneumatici quattro stagioni')?.querySelector('.stock-reserved')?.textContent.trim()==='4 pz');
    assert.equal(await f.evaluate(text=>suggestWorkLineProfit(text,240)?.profit,allWork),60);
    await agenda('All season job').locator('.status-select').selectOption('COMPLETATO'); await sync();
    await expectQuantities([19,20,16]);
    const allId=(await receipts(agenda('All season job')))[0].stockId;
    await addParking('Winter parked','2 '+tyre+' invernale');
    await parking('Winter parked').locator('.parking-status').selectOption('COMPLETATO'); await sync();
    await expectQuantities([19,18,16]);
    assert.equal((await receipts(parking('Winter parked')))[0].unitProfit,11);
    await addAgenda('Summer job','3 '+tyre+' estivo');
    await agenda('Summer job').locator('.status-select').selectOption('COMPLETATO'); await sync();
    await expectQuantities([16,18,16]); await assertReload([16,18,16]);
    assert.equal((await receipts(agenda('All season job')))[0].stockId,allId);
    console.log('PASS agenda and parking deduct only the declared season; reservations and profit use the same variant');

    await selectAgenda(f); await agenda('All season job').locator('.status-select').selectOption('IN LAVORAZIONE'); await sync();
    await expectQuantities([16,18,20]);
    await selectAgenda(f,'parking'); await parking('Winter parked').locator('.parking-status').selectOption('IN LAVORAZIONE'); await sync();
    await expectQuantities([16,20,20]);
    await parking('Winter parked').locator('.parking-status').selectOption('COMPLETATO'); await sync();
    await selectAgenda(f); await agenda('All season job').locator('.status-select').selectOption('COMPLETATO'); await sync();
    await expectQuantities([16,18,16]);
    // Changing a completed description restores the old exact ID before deducting the new one.
    await agenda('All season job').evaluate(row=>openAcceptanceEditorForRow(row));
    await f.locator('.acceptance-description').first().fill('4 '+tyre+' invernali');
    await f.locator('#acceptanceForm button[type="submit"]').click(); await sync();
    await expectQuantities([16,14,20]); await assertReload([16,14,20]);
    console.log('PASS reopening restores each saved variant exactly once; edited season moves the debit safely');

    await addAgenda('Implicit summer job','1 '+tyre);
    assert.equal(await f.evaluate(text=>getStockLineProfit(text),'1 '+tyre),7);
    assert.equal(await f.evaluate(text=>suggestWorkLineProfit(text,60)?.profit,'1 '+tyre),7);
    assert.deepEqual(await f.evaluate(tyre=>[...document.querySelectorAll('#stockRows tr')].filter(row=>row.cells[0]?.textContent.trim()===tyre).map(row=>row.querySelector('.stock-reserved')?.textContent.trim()),tyre),['1 pz','0 pz','0 pz'],'omitted season reserves summer only');
    await addParking('Implicit summer parked','2 '+tyre);
    await f.waitForFunction(tyre=>[...document.querySelectorAll('#stockRows tr')].find(row=>row.cells[0]?.textContent.trim()===tyre&&row.cells[1]?.textContent==='Pneumatici estivi')?.querySelector('.stock-reserved')?.textContent.trim()==='3 pz',tyre);
    await selectAgenda(f); await agenda('Implicit summer job').locator('.status-select').selectOption('COMPLETATO'); await sync();
    await expectQuantities([15,14,20]);
    await selectAgenda(f,'parking'); await parking('Implicit summer parked').locator('.parking-status').selectOption('COMPLETATO'); await sync();
    await expectQuantities([13,14,20]);
    assert.equal((await receipts(agenda('Implicit summer job')))[0].stockId,legacyId);
    assert.equal((await receipts(parking('Implicit summer parked')))[0].stockId,legacyId);
    assert.equal((await receipts(parking('Implicit summer parked')))[0].unitProfit,7);
    assert.doesNotMatch(await f.locator('.agenda-stock-warning').innerText(),/Implicit summer (?:job|parked)/);
    await assertReload([13,14,20]);
    await selectAgenda(f); await agenda('Implicit summer job').locator('.status-select').selectOption('IN LAVORAZIONE'); await sync();
    await expectQuantities([14,14,20]);
    await selectAgenda(f,'parking'); await parking('Implicit summer parked').locator('.parking-status').selectOption('IN LAVORAZIONE'); await sync();
    await expectQuantities([16,14,20]);
    await parking('Implicit summer parked').locator('.parking-status').selectOption('COMPLETATO'); await sync();
    await selectAgenda(f); await agenda('Implicit summer job').locator('.status-select').selectOption('COMPLETATO'); await sync();
    await expectQuantities([13,14,20]);
    console.log('PASS omitted season uses summer for reservations, profit, agenda and parking; reopening restores only summer');

    await addStock(categories[1],'195/65/15 91T Michelin');
    await addAgenda('Missing implicit summer job','1 195/65/15 91T Michelin');
    assert.equal(await f.evaluate(()=>getStockLineProfit('1 195/65/15 91T Michelin')),0);
    assert.match(await f.locator('.agenda-stock-warning').innerText(),/Missing implicit summer job[^|]*nessuna scorta di pneumatici estivi corrispondente/);
    await agenda('Missing implicit summer job').locator('.status-select').selectOption('COMPLETATO'); await sync();
    assert.equal((await receipts(agenda('Missing implicit summer job'))).length,0);
    await addParking('Missing implicit summer parked','1 195/65/15 91T Michelin');
    assert.match(await f.locator('.agenda-stock-warning').innerText(),/Missing implicit summer parked[^|]*nessuna scorta di pneumatici estivi corrispondente/);
    await parking('Missing implicit summer parked').locator('.parking-status').selectOption('COMPLETATO'); await sync();
    assert.equal((await receipts(parking('Missing implicit summer parked'))).length,0);
    assert.equal(await f.evaluate(()=>Number([...document.querySelectorAll('#stockRows tr')].find(row=>row.cells[0]?.textContent==='195/65/15 91T Michelin').dataset.quantity)),20,'missing summer must not deduct winter');
    await addStock(categories[0],'165/65/14 79T Michelin');
    await addAgenda('Missing season job','2 165/65/14 79T Michelin all-season');
    assert.equal(await f.evaluate(()=>[...document.querySelectorAll('#stockRows tr')].find(row=>row.cells[0]?.textContent==='165/65/14 79T Michelin').querySelector('.stock-reserved').textContent.trim()),'0 pz','generic name match must not reserve summer for all-season work');
    await agenda('Missing season job').locator('.status-select').selectOption('COMPLETATO'); await sync();
    assert.equal((await receipts(agenda('Missing season job'))).length,0);
    assert.equal(await f.evaluate(()=>Number([...document.querySelectorAll('#stockRows tr')].find(row=>row.cells[0]?.textContent==='165/65/14 79T Michelin').dataset.quantity)),20);
    assert.match(await f.locator('.agenda-stock-warning').innerText(),/nessuna scorta di pneumatici 4 stagioni corrispondente/);
    await addAgenda('Absent all season job','2 175/65/14 82T FALKEN 4S');
    let warning=await f.locator('.agenda-stock-warning').innerText();
    assert.match(warning,/Absent all season job[^|]*nessuna scorta di pneumatici 4 stagioni corrispondente/,'warn before completion even with no technical match in any season');
    await agenda('Absent all season job').locator('.status-select').selectOption('COMPLETATO'); await sync();
    assert.equal((await receipts(agenda('Absent all season job'))).length,0);
    assert.match(await f.locator('.agenda-stock-warning').innerText(),/Absent all season job[^|]*nessuna scorta di pneumatici 4 stagioni corrispondente/);
    await addAgenda('No quantity tyre','175/65/14 82T FALKEN quattro st.');
    assert.match(await f.locator('.agenda-stock-warning').innerText(),/No quantity tyre[^|]*verifica quantità, misura, indici, marca e stagione/,'slash tyre sizes warn when quantity cannot be parsed');
    await addParking('Absent parked all season','2 185/65/14 86T FALKEN quattro st.');
    assert.match(await f.locator('.agenda-stock-warning').innerText(),/Absent parked all season[^|]*nessuna scorta di pneumatici 4 stagioni corrispondente/,'parking warns for missing abbreviated all-season tyres');
    await parking('Absent parked all season').locator('.parking-status').selectOption('COMPLETATO'); await sync();
    assert.equal((await receipts(parking('Absent parked all season'))).length,0);
    assert.match(await f.locator('.agenda-stock-warning').innerText(),/Absent parked all season[^|]*nessuna scorta di pneumatici 4 stagioni corrispondente/);
    await addAgenda('Wrong index job','2 155/65/14 82T FALKEN estivi');
    await agenda('Wrong index job').locator('.status-select').selectOption('COMPLETATO'); await sync();
    await expectQuantities([13,14,20]); assert.equal((await receipts(agenda('Wrong index job'))).length,0);
    await addParking('M plus S parked','2 '+tyre+' M+S 4 st.');
    await parking('M plus S parked').locator('.parking-status').selectOption('COMPLETATO'); await sync();
    await expectQuantities([13,14,18]); await assertReload([13,14,18]);
    console.log('PASS unavailable season and wrong technical index do not debit another tyre; M+S preserves explicit season');

    // Model a completed receipt saved before the new default: it used winter
    // even though its description did not declare a season. The actual receipt
    // remains authoritative until the user reopens or edits that work.
    const winterId=(await receipts(parking('Winter parked')))[0].stockId;
    await parking('Winter parked').evaluate((row,description)=>{
      const lines=JSON.parse(row.dataset.workLines); lines[0].description=description;
      row.dataset.workLines=JSON.stringify(lines);
      row.children[3].querySelector('b').textContent=description;
      const signature=tyreWorkSignature(row,'parkingTyreDeductions');
      row.dataset.parkingTyreDeductions=JSON.stringify(JSON.parse(row.dataset.parkingTyreDeductions).map(entry=>({...entry,requestSignature:signature})));
    },'2 '+tyre);
    await assertReload([13,14,18]);
    assert.equal((await receipts(parking('Winter parked')))[0].stockId,winterId);
    assert.doesNotMatch(await f.locator('.agenda-stock-warning').innerText(),/Winter parked[^|]*scarico non completato/);
    await selectAgenda(f,'parking'); await parking('Winter parked').locator('.parking-status').selectOption('IN LAVORAZIONE'); await sync();
    await expectQuantities([13,16,18]);
    await parking('Winter parked').locator('.parking-status').selectOption('COMPLETATO'); await sync();
    await expectQuantities([11,16,18]);
    assert.equal((await receipts(parking('Winter parked')))[0].stockId,legacyId);
    await assertReload([11,16,18]);
    const model210='AS210 155/65/14 75T FALKEN',model220='155/65/14 75T FALKEN AS220';
    await addStock(categories[0],model210); await addStock(categories[0],model220);
    await addAgenda('Exact model before measure','2 AS210 155/65/14 75T FALKEN');
    await f.waitForFunction(model210=>[...document.querySelectorAll('#stockRows tr')].find(row=>row.cells[0]?.textContent.trim()===model210)?.querySelector('.stock-reserved')?.textContent.trim()==='2 pz',model210);
    assert.equal(await productReserved(model220),'0 pz','AS210 does not reserve the AS220 stock');
    await agenda('Exact model before measure').locator('.status-select').selectOption('COMPLETATO'); await sync();
    assert.equal(await productQuantity(model210),18,'the matching model is deducted');
    assert.equal(await productQuantity(model220),20,'a similar but different model is untouched');
    await assertReload([11,16,18]);
    const ziex310='195/50/15 82V FALKEN Ziex 310',ziex320='195/50/15 82V FALKEN Ziex 320';
    await addStock(categories[0],ziex310); await addStock(categories[0],ziex320);
    await addAgenda('Exact model number','1 195/50/15 82V FALKEN ziex 320');
    await f.waitForFunction(ziex320=>[...document.querySelectorAll('#stockRows tr')].find(row=>row.cells[0]?.textContent.trim()===ziex320)?.querySelector('.stock-reserved')?.textContent.trim()==='1 pz',ziex320);
    assert.equal(await productReserved(ziex310),'0 pz','ZIEX 320 does not reserve ZIEX 310');
    await agenda('Exact model number').locator('.status-select').selectOption('COMPLETATO'); await sync();
    assert.equal(await productQuantity(ziex320),19,'the exact ZIEX 320 model is deducted');
    assert.equal(await productQuantity(ziex310),20,'the ZIEX 310 variant remains untouched');
    await assertReload([11,16,18]);
    console.log('PASS full model text chooses AS210 over AS220 and ZIEX 320 over ZIEX 310');
    assert.deepEqual(errors,[]);
    console.log('PASS historical implicit winter receipt is preserved on load; reopening and recompleting uses the new summer default');
  } finally {await browser.close();await app.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
