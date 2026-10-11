'use strict';
// Print the real HTML templates at a loopback HTTP URL, with Chromium's
// automatic headers/footers enabled. A negative control proves that this
// setting would expose the server address with the old page margin.
const path=require('node:path'),fs=require('node:fs'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process'),{pathToFileURL}=require('node:url');
const localPlaywright=path.resolve(__dirname,'../../gestionale-app/node_modules/playwright');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||(fs.existsSync(localPlaywright)?localPlaywright:'playwright'));
const sheets=require('../print-sheets.js'),reports=require('../work-reports.js');

const extractScript=String.raw`
import json,sys,pdfplumber
result=[]
for filename in sys.argv[1:]:
    with pdfplumber.open(filename) as document:
        pages=[]
        for page in document.pages:
            words=page.extract_words()
            pages.append(dict(width=page.width,height=page.height,text=page.extract_text() or '',bounds=None if not words else dict(left=min(w['x0'] for w in words),right=max(w['x1'] for w in words),top=min(w['top'] for w in words),bottom=max(w['bottom'] for w in words))))
        result.append(pages)
print(json.dumps(result,ensure_ascii=False))
`;

(async()=>{
  const root=path.resolve(__dirname,'..'),dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'officina-print-no-address-'));
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const origin=`http://127.0.0.1:${port}`;
  const {createApplication}=await import(pathToFileURL(path.join(root,'server/server.mjs'))),{addUser}=await import(pathToFileURL(path.join(root,'server/database.mjs')));
  const app=await createApplication({root,dataDir,origin,env:{NODE_ENV:'test'}});await addUser(app.db,'print-test','test-password-1234','admin');
  await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage(),errors=[],documents=new Map(),outputs=[];
  page.on('pageerror',error=>errors.push(error.stack));
  await context.route(origin+'/print-no-address/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:documents.get(new URL(route.request().url()).pathname)||'Missing synthetic print document'}));
  async function print(name,html,options={}){
    const url='/print-no-address/'+name;documents.set(url,html);const target=await context.newPage();await target.goto(options.url||origin+url);await target.evaluate(()=>document.fonts.ready);
    const filename=path.join(dataDir,name+'.pdf');await target.pdf({path:filename,displayHeaderFooter:true,preferCSSPageSize:true,printBackground:true});await target.close();outputs.push({name,filename,...options});
  }
  async function snapshot(f){return f.evaluate(()=>{const clone=document.documentElement.cloneNode(true);clone.querySelectorAll('script').forEach(script=>script.remove());const base=document.createElement('base');base.href=location.origin+'/legacy';clone.querySelector('head').prepend(base);return '<!doctype html>'+clone.outerHTML;});}
  const lines=Array.from({length:80},(_,index)=>({description:'RIGA-SCHEDA-'+String(index+1).padStart(3,'0')+' verifica sintetica veicolo',amount:12.50}));
  const seller={name:'Officina stampa sintetica',address:'Via Prova 15, Roma',vat:'12345678901'};
  try{
    await page.goto(origin);await page.locator('#username').fill('print-test');await page.locator('#password').fill('test-password-1234');await page.locator('#loginForm button[type="submit"]').click();await page.waitForFunction(()=>document.querySelector('iframe')?.contentWindow?.WorkshopCloud?.initializing===false);
    const f=page.frames().find(item=>item.url().includes('/legacy'));
    const sheet=sheets.buildSheet({shop:seller.name,title:'Scheda di accettazione',fields:{Cliente:'Cliente stampa',Targa:'AA123BB',Veicolo:'Fiat Panda'},lines});
    await print('sheet-builder',sheet,{margin:15,end:'RIGA-SCHEDA-080',tail:'Firma del cliente al ritiro',multipage:true});
    const negative=sheet.replace(/@page\{[^}]*\}/,'@page{size:A4;margin:15mm;padding:0}');
    await print('negative-old-margin',negative,{negative:true});
    await f.evaluate(lines=>{openNewAcceptance();document.getElementById('appCustomer').value='Cliente stampa';document.getElementById('appPlate').value='AA123BB';WorkshopAppointmentLines.set(lines);},lines);
    await f.locator('#appointmentForm button',{hasText:'Stampa scheda'}).click();await f.locator('#workshopPrintPreview').waitFor();
    await print('sheet-preview',await snapshot(f),{margin:15,end:'RIGA-SCHEDA-080',tail:'Firma del cliente al ritiro',multipage:true});
    await f.locator('#workshopPrintClose').click();
    await f.evaluate(()=>WorkshopAppointmentLines.set([{description:'FINE-ETICHETTA chiavi veicolo',amount:0}]));
    await f.locator('#appointmentForm button',{hasText:'Stampa scheda'}).click();await f.locator('#workshopPrintToolbar button',{hasText:'Stampa etichetta'}).click();await f.locator('#workshopLabelPreview').waitFor();
    const labelHeight=await f.evaluate(()=>{const match=document.getElementById('workshopLabelStyle').textContent.match(/@page\{size:80mm (\d+)mm/);return Number(match[1]);});
    await print('thermal-label',await snapshot(f),{labelHeight,end:'FINE-ETICHETTA'});await f.locator('#workshopLabelClose').click();await f.locator('#appointmentModal [data-cloud-close]').click();
    await f.evaluate(()=>{showPage('quotes');document.getElementById('newQuote').click();document.getElementById('quoteCustomer').value='Cliente stampa';document.getElementById('quoteVehicle').value='AA123BB';document.getElementById('quoteDate').value='2026-10-11';document.getElementById('quoteNotes').value='FINE-PREVENTIVO';for(let index=1;index<=80;index++){if(index>1)document.getElementById('quoteAdd').click();const row=document.getElementById('quoteLines').lastElementChild;row.querySelector('[data-q="description"]').value='RIGA-PREVENTIVO-'+String(index).padStart(3,'0')+' lavorazione sintetica';row.querySelector('[data-q="price"]').value='10';}});
    await f.locator('#quotePrint').click();await f.waitForFunction(()=>!document.getElementById('quotePrintNow')?.disabled);await print('quote',await f.locator('#quotePrintFrame').getAttribute('srcdoc'),{margin:15,end:'RIGA-PREVENTIVO-080',tail:'FINE-PREVENTIVO',multipage:true});await f.locator('#quotePrintClose').click();await f.locator('#quoteCancel').click();
    const work={id:'cash-synthetic',cashId:'cash-synthetic',source:'agenda',date:'2026-10-11',customer:'Cliente stampa',plate:'AA123BB',vehicle:'Fiat Panda',km:'120000',notes:'FINE-INTERVENTO',amount:1000,lines};
    await print('single-work',reports.singleWorkHTML(work,seller),{margin:12,end:'RIGA-SCHEDA-080',tail:'FINE-INTERVENTO',multipage:true});
    const works=Array.from({length:60},(_,index)=>({...work,id:'cash-'+index,cashId:'cash-'+index,notes:'',amount:10,lines:[{description:'RIGA-RAPPORTO-'+String(index+1).padStart(3,'0'),amount:10}]}));
    const report={id:'report-synthetic',date:'2026-10-11',customer:'Cliente stampa',customerKey:reports.customerKey('Cliente stampa'),period:{start:'2026-10-01',end:'2026-10-31'},works,total:600};
    await print('work-report',reports.printHTML(report,seller),{margin:12,end:'RIGA-RAPPORTO-060',tail:'Documento riepilogativo non fiscale',multipage:true});
    await f.evaluate(()=>{showPage('moduli');document.querySelector('[data-template="refusal"]').click();document.getElementById('moduleCustomer').value='Cliente stampa';document.getElementById('modulePlate').value='AA123BB';document.getElementById('moduleDetails').value=Array.from({length:100},(_,index)=>'RIGA-MODULO-'+String(index+1).padStart(3,'0')+' verifica e raccomandazione sintetica.').join('\n');document.getElementById('moduleRisks').value='Rischi sintetici comunicati';document.getElementById('moduleOutcome').value='FINE-MODULO';});
    const popupPromise=page.waitForEvent('popup');await f.locator('#modulePrint').click();const popup=await popupPromise;await popup.waitForLoadState('domcontentloaded');const moduleHTML=await popup.content();await popup.close();await print('customer-module',moduleHTML,{margin:15,end:'RIGA-MODULO-100',tail:'Firma del cliente',multipage:true});await f.locator('#moduleClose').click();
    // Optional real native-protocol response; the VPS suite has no dependency
    // on the desktop source tree or its build artifacts.
    if(process.env.NATIVE_PRINT_FIXTURE){const nativeHTML=fs.readFileSync(process.env.NATIVE_PRINT_FIXTURE,'utf8');await context.route('http://officina-print.localhost/7/document.html',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:nativeHTML}));await print('native-response',nativeHTML,{url:'http://officina-print.localhost/7/document.html',margin:15,end:'Coppa olio'});}
    const python=process.env.PYTHON_PATH||process.env.PYTHON_COMMAND||'python';let extracted;
    try{extracted=JSON.parse(execFileSync(python,['-c',extractScript,...outputs.map(item=>item.filename)],{encoding:'utf8',maxBuffer:16*1024*1024}));}catch(error){throw new Error('PDF text verification needs Python with pdfplumber. Set PYTHON_PATH or PYTHON_COMMAND to its executable. '+error.message);}
    for(const [index,output]of outputs.entries()){
      const pages=extracted[index],text=pages.map(page=>page.text).join('\n');
      if(output.negative){assert.match(text,/127\.0\.0\.1/,'old page margins must expose Chromium’s automatic URL footer in the negative control');continue;}
      assert.doesNotMatch(text,/127\.0\.0\.1|officina-print\.localhost|print-no-address/,'automatic browser address/footer absent from '+output.name);assert.ok(text.includes(output.end),output.name+' retains its last content marker');if(output.tail)assert.ok(pages.at(-1).text.includes(output.tail),output.name+' keeps the final document content on its last page');
      if(output.labelHeight){assert.equal(pages.length,1,'thermal label remains one page');assert.ok(Math.abs(pages[0].width-80*72/25.4)<1);assert.ok(Math.abs(pages[0].height-output.labelHeight*72/25.4)<1);continue;}
      if(output.multipage)assert.ok(pages.length>=2,output.name+' really spans several printed pages');
      const inset=output.margin*72/25.4;
      for(const [pageIndex,printed]of pages.entries()){
        assert.ok(Math.abs(printed.width-210*72/25.4)<1&&Math.abs(printed.height-297*72/25.4)<1,output.name+' prints A4');
        assert.ok(printed.bounds,output.name+' has no empty page');const b=printed.bounds,tolerance=3;
        assert.ok(b.left>=inset-tolerance&&b.right<=printed.width-inset+tolerance&&b.top>=inset-tolerance&&b.bottom<=printed.height-inset+tolerance,`${output.name} page ${pageIndex+1} retains all ${output.margin} mm margins: ${JSON.stringify(b)}`);
      }
    }
    await page.evaluate(()=>WorkshopCloudHost.flush());assert.equal(app.db.prepare('SELECT revision FROM state').get().revision,0,'print previews do not save synthetic documents');assert.deepEqual(errors,[]);
    console.log('PASS actual Chromium headers/footers: no server address, 6 complete multipage A4 documents with repeated margins, one thermal label, negative URL-footer control'+(process.env.NATIVE_PRINT_FIXTURE?', native protocol response':''));
  }finally{await context.close();await browser.close();await app.close();const absolute=path.resolve(dataDir);assert.ok(absolute.startsWith(path.resolve(os.tmpdir())+path.sep+'officina-print-no-address-'));fs.rmSync(absolute,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
