const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
const fs=require('node:fs');
const os=require('node:os');
const net=require('node:net');
const assert=require('node:assert/strict');

async function availablePort(){const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));return port;}
(async()=>{
 const root=path.resolve(__dirname,'..'),dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'officina-manual-module-')),port=await availablePort(),origin=`http://127.0.0.1:${port}`;
 const {createApplication}=await import(pathToFileURL(path.join(root,'server/server.mjs')));
 const {addUser}=await import(pathToFileURL(path.join(root,'server/database.mjs')));
 const app=await createApplication({root,dataDir,origin,env:{NODE_ENV:'test'}});
 await addUser(app.db,'module-operator','test-password-1234','operator');await addUser(app.db,'module-viewer','test-password-1234','viewer');
 await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));
 const browser=await chromium.launch({...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}),headless:true}),errors=[];
 const ready=page=>page.waitForFunction(()=>document.querySelector('iframe')?.contentWindow?.WorkshopCloud?.initializing===false);
 const frame=page=>page.frames().find(item=>item.url().includes('/legacy'));
 const login=async(username='module-operator',viewport={width:1278,height:1050})=>{const page=await browser.newPage({viewport});page.on('pageerror',error=>errors.push(error.message));await page.goto(origin);await page.locator('#username').fill(username);await page.locator('#password').fill('test-password-1234');await page.locator('#loginForm button[type=submit]').click();await ready(page);return page;};
 const pdf=Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n');
 const recordState=()=>JSON.parse(app.db.prepare('SELECT payload FROM state WHERE id=1').get().payload);
 const savedModules=()=>JSON.parse(recordState().storage['officina-moduli-v1']||'[]');
 const openUpload=async f=>{await f.locator('.nav [data-view=moduli]').click();await f.locator('#insertManualModule').click();assert.equal(await f.locator('#manualModuleDialog').evaluate(node=>node.open),true);};
 const nextToFile=async(f,type='privacy',customer='Alice Rossi')=>{await f.locator('#manualModuleType').selectOption(type);await f.locator('#manualModuleNext').click();await f.locator('#manualModuleCustomer').selectOption({label:customer});await f.locator('#manualModuleNext').click();};
 try{
  const page=await login();let f=frame(page);
  await f.evaluate(()=>{const rows=document.getElementById('customerRows');for(const [name,plate] of [['Bruno Verdi','BB123CC'],['Alice Rossi','AA123BB'],['ALICE ROSSI','AA456CC']]){const row=document.createElement('tr');for(const value of [name,'123','','Veicolo',plate,'2026-10-05']){const cell=row.insertCell();cell.textContent=value;}rows.append(row);}});
  await page.evaluate(()=>WorkshopCloudHost.flush());
  await openUpload(f);await f.locator('#manualModuleNext').click();assert.equal(await f.locator('#manualModuleProgress').innerText(),'Passaggio 1 di 3');
  assert.deepEqual(await f.locator('#manualModuleType option').allTextContents(),['Seleziona un modulo','Informativa privacy','Rifiuto di interventi raccomandati','Fornitura propria di ricambi']);
  await f.locator('#manualModuleType').selectOption('privacy');await f.locator('#manualModuleNext').click();
  assert.deepEqual(await f.locator('#manualModuleCustomer option').allTextContents(),['Seleziona un cliente','Alice Rossi','Bruno Verdi']);
  await f.locator('#manualModuleNext').click();assert.equal(await f.locator('#manualModuleProgress').innerText(),'Passaggio 2 di 3');
  await f.locator('#manualModuleCustomer').selectOption({label:'Alice Rossi'});await f.locator('#manualModuleNext').click();
  await f.locator('#manualModuleFile').setInputFiles({name:'non-un-modulo.txt',mimeType:'text/plain',buffer:Buffer.from('text')});await f.locator('#manualModuleUpload').click();await f.locator('#manualModuleStatus').filter({hasText:'Scegli un file PDF'}).waitFor();assert.equal(savedModules().length,0);
  await f.locator('#manualModuleFile').setInputFiles({name:'troppo-grande.pdf',mimeType:'application/pdf',buffer:Buffer.alloc(10*1024*1024+1)});await f.locator('#manualModuleUpload').click();await f.locator('#manualModuleStatus').filter({hasText:'non superare 10 MB'}).waitFor();assert.equal(savedModules().length,0);
  console.log('PASS staged module/client/file selection deduplicates customers and rejects unsupported or oversized files');
  await f.locator('#manualModuleFile').setInputFiles({name:'privacy-firmata.pdf',mimeType:'application/pdf',buffer:pdf});await f.locator('#manualModuleUpload').click();await f.locator('#manualModuleDialog').waitFor({state:'hidden'});await f.locator('#formsArchive a.module-original').waitFor();
  const saved=savedModules();assert.equal(saved.length,1);assert.equal(saved[0].Customer,'Alice Rossi');assert.equal(saved[0].type,'privacy');assert.equal(saved[0].Signature,undefined);assert.equal(saved[0].Attachment.filename,'privacy-firmata.pdf');assert.equal(saved[0].Attachment.data,undefined);
  const href=await f.locator('#formsArchive a.module-original').getAttribute('href');assert.match(href,/^\/api\/module-files\/[a-z0-9-]+\/original$/i);const original=await page.request.get(origin+href);assert.equal(original.status(),200);assert.deepEqual(await original.body(),pdf);
  assert.equal(await f.locator('#workshopFormDialog').evaluate(node=>node.open),false);
  await page.reload();await ready(page);f=frame(page);await f.locator('.nav [data-view=moduli]').click();await f.locator('#openFormsArchive').click();await f.locator('#formsArchive .archive-customer-toggle').click();assert.equal(await f.locator('#formsArchive a.module-original').getAttribute('href'),href);
  console.log('PASS uploaded original is linked in its customer archive after central acknowledgement and reload, without changing existing signature records');
  const viewer=await login('module-viewer');const vf=frame(viewer);await vf.locator('.nav [data-view=moduli]').click();assert.equal(await vf.locator('#insertManualModule').isVisible(),false);await vf.locator('#openFormsArchive').click();await vf.locator('#formsArchive .archive-customer-toggle').click();const viewerFile=await viewer.request.get(origin+await vf.locator('a.module-original').getAttribute('href'));assert.equal(viewerFile.status(),200);assert.deepEqual(await viewerFile.body(),pdf);
  await openUpload(f);await nextToFile(f,'parts','Bruno Verdi');await f.locator('#manualModuleFile').setInputFiles({name:'ricambi.jpg',mimeType:'image/jpeg',buffer:Buffer.from([0xff,0xd8,0xff,0xe0,0,0,0xff,0xd9])});await f.locator('#manualModuleUpload').click();await f.locator('#manualModuleDialog').waitFor({state:'hidden'});
  await vf.waitForFunction(()=>document.querySelectorAll('#formsArchive .archive-customer-toggle').length===2);assert.deepEqual((await vf.locator('#formsArchive .archive-customer-toggle').allInnerTexts()).map(text=>text.split('\n')[0].trim()),['Alice Rossi','Bruno Verdi']);
  console.log('PASS second device receives uploaded module automatically and consultation account can open originals but cannot upload');
  let abortOnce=true,uploadedId;await page.route('**/api/module-files',async route=>{if(route.request().method()!=='POST'||!abortOnce){await route.continue();return;}abortOnce=false;uploadedId=route.request().postDataJSON().id;const response=await route.fetch();assert.equal(response.ok(),true);await route.abort('failed');});
  await openUpload(f);await nextToFile(f,'refusal');await f.locator('#manualModuleFile').setInputFiles({name:'rifiuto.pdf',mimeType:'application/pdf',buffer:pdf});await f.locator('#manualModuleUpload').click();await f.locator('#manualModuleUpload').waitFor({state:'visible'});await f.waitForFunction(()=>!document.getElementById('manualModuleUpload').disabled);
  assert.equal(await f.locator('#manualModuleDialog').evaluate(node=>node.open),true);assert.equal(savedModules().length,2);await f.locator('#manualModuleUpload').click();await f.locator('#manualModuleDialog').waitFor({state:'hidden'});assert.equal(savedModules().length,3);assert.equal(savedModules().filter(item=>item.id===uploadedId).length,1);
  console.log('PASS lost upload response is retried with the same identifier and creates one archive entry');
  await page.setViewportSize({width:390,height:844});await openUpload(f);await nextToFile(f);const box=await f.locator('#manualModuleDialog').boundingBox();assert.ok(box&&box.x>=0&&box.x+box.width<=390);assert.equal(await f.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await f.locator('#manualModuleCancel').click();
  assert.deepEqual(errors,[]);console.log('PASS manual upload remains usable on mobile without overflow or runtime errors');
 }finally{await browser.close();await app.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
