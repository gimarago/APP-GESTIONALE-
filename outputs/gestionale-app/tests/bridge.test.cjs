'use strict';
const {test, before, after} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync, existsSync} = require('node:fs');
const path = require('node:path');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const bridge = readFileSync(path.join(__dirname, '../src-tauri/bridge.js'), 'utf8');
let browser;
before(async () => { browser = await chromium.launch({headless:true, ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {})}); });
after(async () => { await browser?.close(); });
async function fixture({injectChildren = true, url = 'https://api.magomme.it/', android = false, legacyApp = false} = {}) {
  const context = await browser.newContext();
  await context.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.pathname === '/api/doc') return route.fulfill({status:200, headers:{'content-type':'application/xml','content-disposition':'attachment; filename="fattura.xml"'},body:'<fattura/>'});
    if (legacyApp && u.origin === 'https://api.magomme.it') {
      const root = path.resolve(__dirname, '../../gestionale-vps');
      if (u.pathname === '/legacy') {
        // Use the real forms, acceptance reader and print-sheets.js. Only cloud
        // transport is omitted so this native integration fixture stays local.
        const html = readFileSync(path.join(root, 'officina-fatturazione.html'), 'utf8')
          .replace(/<script src="cloud-(?:sync|ready)\.js"><\/script>/g, '');
        return route.fulfill({contentType:'text/html', body:html});
      }
      const file = path.resolve(root, '.' + decodeURIComponent(u.pathname));
      if (file.startsWith(root + path.sep) && existsSync(file)) {
        const contentType = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
        return route.fulfill({contentType, body:readFileSync(file)});
      }
    }
    return route.fulfill({contentType:'text/html', body:'<!doctype html><html><body><form id="loginForm"></form><div id="frameHost"></div></body></html>'});
  });
  await context.addInitScript(android => {
    window.calls = [];
    window.__OFFICINA_PLATFORM__ = android ? 'android' : 'desktop';
    window.__TAURI__ = {
      core:{invoke:async(command,args) => {window.calls.push({command,args});return {status:'saved'};}},
      app:{onBackButtonPress:async handler => {window.backHandler=handler;return () => {};}}
    };
  }, android);
  if (legacyApp) await context.addInitScript(()=>{
    window.WorkshopCloudBoot={user:{username:'print-test',role:'admin'},state:null,features:{}};
    window.WorkshopCloudHost={canWrite:()=>true,changed(){},failed(){},denied(){}};
  });
  if (injectChildren) await context.addInitScript(bridge);
  const page = await context.newPage(); await page.goto(url);
  if (!injectChildren) await page.evaluate(bridge);
  return {context, page};
}

test('PDF generated in a detached anchor reaches native export without navigating or opening another page', async () => {
  const {context, page} = await fixture();
  try {
    await page.evaluate(() => { const a = document.createElement('a'); a.href=URL.createObjectURL(new Blob(['%PDF-test'],{type:'application/pdf'})); a.download='Preventivo.pdf'; a.click(); });
    await page.waitForFunction(() => calls.some(c=>c.command.endsWith('|export_document')));
    const call = (await page.evaluate(() => calls)).find(c=>c.command.endsWith('|export_document'));
    assert.equal(call.args.name, 'Preventivo.pdf');
    assert.equal(call.args.mime, 'application/pdf');
    assert.equal(Buffer.from(call.args.base64,'base64').toString(), '%PDF-test');
    assert.equal(page.url(), 'https://api.magomme.it/');
    assert.equal(context.pages().length,1);
  } finally { await context.close(); }
});

test('server attachment name and content are retained for authenticated downloads', async () => {
  const {context,page} = await fixture();
  try {
    await page.evaluate(() => {const a=document.createElement('a');a.href='/api/doc';a.download='';document.body.append(a);a.click();});
    await page.waitForFunction(() => calls.some(c=>c.command.endsWith('|export_document')));
    const call=(await page.evaluate(()=>calls)).find(c=>c.command.endsWith('|export_document'));
    assert.equal(call.args.name,'fattura.xml');
    assert.equal(Buffer.from(call.args.base64,'base64').toString(),'<fattura/>');
  } finally {await context.close();}
});

test('external links use the URL prepared by onclick and respect validation cancellation', async () => {
  const {context,page}=await fixture();
  try {
    await page.evaluate(() => {
      const a=document.createElement('a');a.id='whatsapp';a.href='#';a.target='_blank';a.textContent='Apri WhatsApp';
      a.onclick=e=>{e.currentTarget.href='https://wa.me/390000000000?text=Preventivo';};
      document.body.append(a);
    });
    await page.locator('#whatsapp').click();
    await page.evaluate(() => document.getElementById('whatsapp').click());
    await page.evaluate(() => {
      const a=document.createElement('a');a.href='#';a.target='_blank';
      a.onclick=e=>{e.currentTarget.href='https://wa.me/390000000000?text=Detached';};a.click();
      const connected=document.getElementById('whatsapp');
      connected.onclick=e=>e.preventDefault();connected.click();
      a.onclick=e=>e.preventDefault();a.click();
    });
    assert.deepEqual((await page.evaluate(()=>calls)).filter(c=>c.command==='open_external').map(c=>c.args.url),[
      'https://wa.me/390000000000?text=Preventivo',
      'https://wa.me/390000000000?text=Preventivo',
      'https://wa.me/390000000000?text=Detached'
    ]);
    assert.equal(page.url(),'https://api.magomme.it/');
    assert.equal(context.pages().length,1);
  } finally {await context.close();}
});

test('old Android main-frame-only injection still installs hooks in dynamically created legacy iframe', async () => {
  const {context,page}=await fixture({injectChildren:false});
  try {
    await page.evaluate(()=>{const f=document.createElement('iframe');f.src='/legacy';document.getElementById('frameHost').append(f);});
    await page.waitForFunction(()=>document.querySelector('iframe')?.contentWindow?.WorkshopNative);
    await page.frames().find(f=>f.url().endsWith('/legacy')).evaluate(async()=>{await WorkshopNative.exportBlob(new Blob(['{}'],{type:'application/json'}),'backup.json');});
    assert.equal((await page.evaluate(()=>calls)).filter(c=>c.command.endsWith('|export_document')).length,1);
  } finally {await context.close();}
});

test('Android Back closes document views first, returns to dashboard, then awaits the VPS save before closing', async () => {
  const {context,page}=await fixture({android:true});
  try {
    await page.evaluate(()=>{const f=document.createElement('iframe');f.src='/legacy';document.getElementById('frameHost').append(f);});
    await page.waitForFunction(()=>window.backHandler && document.querySelector('iframe')?.contentWindow?.WorkshopNative);
    const frame=page.frames().find(f=>f.url().endsWith('/legacy'));
    await frame.evaluate(()=>{
      document.body.innerHTML='<button id="workshopPrintClose">Chiudi anteprima</button><dialog open>Preventivo</dialog><div id="historyModal" class="form-modal open">Storico</div><nav class="nav"><button data-view="dashboard">Cruscotto</button><button data-view="clienti" class="active">Clienti</button></nav>';
      document.getElementById('workshopPrintClose').onclick=e=>e.currentTarget.remove();
      window.closeModal=id=>document.getElementById(id).classList.remove('open');
      document.querySelector('[data-view="dashboard"]').onclick=e=>{document.querySelector('.active').classList.remove('active');e.currentTarget.classList.add('active');};
      window.WorkshopCloud={};
    });
    await page.evaluate(()=>window.backHandler());
    assert.equal(await frame.locator('#workshopPrintClose').count(),0);
    assert.equal(await frame.locator('dialog[open]').count(),1);
    await page.evaluate(()=>window.backHandler());
    assert.equal(await frame.locator('dialog[open]').count(),0);
    await page.evaluate(()=>window.backHandler());
    assert.equal(await frame.locator('.form-modal.open').count(),0);
    await page.evaluate(()=>window.backHandler());
    assert.equal(await frame.locator('.nav .active').getAttribute('data-view'),'dashboard');
    assert.equal((await page.evaluate(()=>calls)).filter(c=>c.command==='close_client').length,0);
    await page.evaluate(()=>{
      window.WorkshopCloudHost={flush:()=>new Promise(resolve=>{window.finishSave=resolve;})};
      window.closingApp=window.backHandler();
    });
    await page.evaluate(()=>window.backHandler());
    assert.equal((await page.evaluate(()=>calls)).filter(c=>c.command==='close_client').length,0);
    await page.evaluate(async()=>{window.finishSave();await window.closingApp;});
    assert.equal((await page.evaluate(()=>calls)).filter(c=>c.command==='close_client').length,1);
  } finally {await context.close();}
});

test('Android Back keeps the app open when the VPS cannot confirm pending changes', async () => {
  const {context,page}=await fixture({android:true,injectChildren:false});
  try {
    await page.evaluate(()=>{const f=document.createElement('iframe');f.src='/legacy';document.getElementById('frameHost').append(f);});
    await page.waitForFunction(()=>window.backHandler && document.querySelector('iframe')?.contentWindow?.WorkshopNative);
    await page.frames().find(f=>f.url().endsWith('/legacy')).evaluate(()=>{window.WorkshopCloud={};});
    await page.evaluate(async()=>{
      window.WorkshopCloudHost={flush:async()=>{throw new Error('Salvataggio non confermato dal VPS');}};
      await window.backHandler();
    });
    assert.equal((await page.evaluate(()=>calls)).filter(c=>c.command==='close_client').length,0);
    assert.match(await page.locator('#officinaNativeNotice').textContent(),/Salvataggio non confermato/);
  } finally {await context.close();}
});

test('print popup sends the full document and email popup opens externally', async () => {
  const {context,page}=await fixture();
  try {
    await page.evaluate(()=>{const w=window.open('','_blank');w.document.write('<html><body><h1>Privacy</h1><p>Firma cliente</p></body></html>');w.document.close();const mail=window.open('about:blank','email');mail.location.href='https://mail.google.com/mail/?view=cm';});
    const calls=await page.evaluate(()=>window.calls);
    assert.ok(calls.find(c=>c.command.endsWith('|print_document')).args.html.includes('Firma cliente'));
    assert.equal(calls.find(c=>c.command==='open_external').args.url,'https://mail.google.com/mail/?view=cm');
    assert.equal(context.pages().length,1);
  } finally {await context.close();}
});

test('thermal printing passes physical dimensions and only the document content', async () => {
  const {context,page}=await fixture();
  try {
    await page.evaluate(()=>{const p=document.createElement('div');p.id='workshopLabelPaper';p.style.width='80mm';p.style.height='90mm';p.innerHTML='<b>TARGA</b>';document.body.append(p);window.print();});
    const args=(await page.evaluate(()=>calls)).find(c=>c.command.endsWith('|print_document')).args;
    assert.equal(args.labelWidthMm,80);assert.equal(args.labelHeightMm,90);
    assert.ok(!args.html.includes('loginForm'));
  } finally {await context.close();}
});

test('real acceptance preview prints its unsaved snapshot with decimal amounts and no application controls', async () => {
  const {context,page}=await fixture({legacyApp:true});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  try {
    await page.setViewportSize({width:1400,height:1100});
    await page.evaluate(()=>{
      const frame=document.createElement('iframe');frame.src='/legacy';
      frame.style.cssText='width:1100px;height:950px;border:0';
      document.getElementById('frameHost').append(frame);
    });
    try {
      await page.waitForFunction(()=>document.querySelector('iframe')?.contentWindow?.readAcceptancePrintData &&
        [...document.querySelector('iframe').contentDocument.querySelectorAll('#acceptanceForm button')].some(button=>button.textContent==='Stampa scheda'),null,{timeout:15000});
    } catch(error) { throw new Error(error.message+'; application errors: '+JSON.stringify(errors)); }
    const frame=page.frames().find(item=>item.url().endsWith('/legacy'));
    await frame.evaluate(()=>{
      document.querySelector('.brand-name').textContent='Officina stampa test';
      document.getElementById('customerRows').innerHTML='<tr><td><b>Cliente anteprima</b></td><td>3201234567</td><td>cliente@example.test</td><td>Fiat Panda</td><td>AB123CD</td><td>—</td></tr>';
      const row=document.createElement('tr');
      row.dataset.date='2026-10-08';row.dataset.vehicle='Fiat Panda';row.dataset.km='1000';
      row.innerHTML='<td>10:04</td><td>Cliente anteprima</td><td>AB123CD</td><td><input class="work-input" value="Diagnosi salvata"></td><td><input class="amount-input" value="10"></td><td><select class="status-select"><option>PROGRAMMATO</option></select></td><td></td>';
      document.getElementById('agendaRows').replaceChildren(row);
      window.openAcceptanceEditorForRow(row);
    });
    await frame.locator('#acceptanceKm').fill('120001');
    await frame.locator('.acceptance-description').fill('Coppa olio da sostituire');
    await frame.locator('.acceptance-amount').fill('100.75');
    await frame.locator('#acceptanceNotes').fill('Note ancora da salvare');
    await frame.locator('#acceptanceForm button').filter({hasText:/^Stampa scheda$/}).click();
    assert.equal((await page.evaluate(()=>calls)).filter(call=>call.command.endsWith('|print_document')).length,0,'opening the preview does not print yet');
    const paperText=await frame.locator('#workshopPrintPaper').innerText();
    assert.match(paperText,/Cliente anteprima/);assert.match(paperText,/AB123CD/);assert.match(paperText,/120001/);
    assert.match(paperText,/Coppa olio da sostituire/);assert.match(paperText,/100,75/);assert.match(paperText,/Note ancora da salvare/);
    // The print preview must keep its snapshot even if the underlying unsaved
    // acceptance form changes before the user opens the system print dialog.
    await frame.evaluate(()=>{
      document.querySelector('.acceptance-description').value='MODIFICA SUCCESSIVA';
      document.querySelector('.acceptance-amount').value='999.99';
      document.getElementById('acceptanceKm').value='999999';
      document.getElementById('acceptanceNotes').value='NOTE SUCCESSIVE';
    });
    await frame.locator('#workshopPrintToolbar button').filter({hasText:/^Stampa$/}).click();
    await page.waitForFunction(()=>calls.some(call=>call.command.endsWith('|print_document')));
    const prints=(await page.evaluate(()=>calls)).filter(call=>call.command.endsWith('|print_document'));
    assert.equal(prints.length,1);
    const {html,labelWidthMm,labelHeightMm}=prints[0].args;
    assert.match(html,/<html[\s>]/);assert.match(html,/workshopPrintPaper/);
    assert.match(html,/Officina stampa test/);assert.match(html,/Scheda di accettazione/);
    assert.match(html,/Cliente anteprima/);assert.match(html,/AB123CD/);assert.match(html,/Fiat Panda/);
    assert.match(html,/120001/);assert.match(html,/3201234567/);assert.match(html,/cliente@example\.test/);
    assert.match(html,/08\/10\/2026/);assert.match(html,/10:04/);assert.match(html,/Coppa olio da sostituire/);
    assert.match(html,/100,75/);assert.match(html,/Totale lavori indicati/);assert.match(html,/Note ancora da salvare/);
    assert.doesNotMatch(html,/MODIFICA SUCCESSIVA|999[,.]99|999999|NOTE SUCCESSIVE/);
    assert.doesNotMatch(html,/acceptanceForm|acceptanceLines|workshopPrintToolbar|frameHost|loginForm/);
    assert.doesNotMatch(html,/<(?:button|input|select|textarea|script)\b/i);
    assert.equal(labelWidthMm,null);assert.equal(labelHeightMm,null);
    assert.equal(context.pages().length,1);
    assert.deepEqual(errors,[]);
  } finally {await context.close();}
});

test('foreign origins, executable exports and external downloads never reach document native commands', async () => {
  const foreign=await fixture({url:'https://evil.example/'});
  try { assert.equal(await foreign.page.evaluate(()=>typeof WorkshopNative),'undefined'); } finally {await foreign.context.close();}
  const {context,page}=await fixture();
  try {
    assert.match(await page.evaluate(async()=>{try{await WorkshopNative.exportBlob(new Blob(['x']),'x.exe');}catch(e){return e.message;}}),/Formato/);
    await page.evaluate(()=>{const a=document.createElement('a');a.href='https://evil.example/x.pdf';a.download='x.pdf';a.click();});
    await page.waitForFunction(()=>document.getElementById('officinaNativeNotice')?.textContent.includes('non autorizzato'));
    assert.equal((await page.evaluate(()=>calls)).filter(c=>c.command.endsWith('|export_document')).length,0);
  } finally {await context.close();}
});

test('local launch failure offers a retry instead of an endless loading message', async () => {
  const context=await browser.newContext();
  try {
    const page=await context.newPage();
    await page.route('http://localhost/**',r=>{const name=new URL(r.request().url()).pathname;const file=name==='/'?'index.html':name.slice(1);r.fulfill({body:readFileSync(path.join(__dirname,'../launcher',file)),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.png')?'image/png':'text/html'});});
    await page.addInitScript(()=>{window.__TAURI__={core:{invoke:async()=>{throw 'VPS non raggiungibile';}}};});
    await page.goto('http://localhost/');
    await page.waitForFunction(()=>!document.getElementById('retry').hidden);
    assert.equal(await page.locator('#status').textContent(),'VPS non raggiungibile');
    await page.locator('#retry').click();
    await page.waitForFunction(()=>!document.getElementById('retry').hidden);
  } finally {await context.close();}
});
