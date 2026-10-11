import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import https from 'node:https';
import {sampleInvoice} from '../fixtures/invoice.js';
import {XmlGenerator} from '../src/fatture/xml-generator.js';
import {XsdValidator} from '../src/fatture/xml-validator.js';
import {validateFiscalApplication,money} from '../src/fatture/fiscal-rules.js';
import {xmlEngine} from '../src/xml/engine.js';
import {SdiClient} from '../src/sdi/sdi-client.js';
import {FiscalTransmissionService} from '../src/sdi/fiscal-transmission-service.js';
const g=new XmlGenerator(),v=new XsdValidator();
const SOAP='http://schemas.xmlsoap.org/soap/envelope/';
async function response(code) {
  const c=await xmlEngine({mode:'contract'});const ns=c.output.slice(1,c.output.indexOf('}'));const name=c.output.split('}')[1];
  return `<s:Envelope xmlns:s="${SOAP}"><s:Body><t:${name} xmlns:t="${ns}"><IdentificativoSdI>123</IdentificativoSdI><DataOraRicezione>2026-09-11T12:00:00Z</DataOraRicezione>${code?`<Errore>${code}</Errore>`:''}</t:${name}></s:Body></s:Envelope>`;
}
async function server(t,{status=200,body,delay=0}={}) {
  const dir=await mkdtemp(join(tmpdir(),'officina-tls-'));
  await promisify(execFile)(process.env.OFFICINA_PYTHON||'python',[fileURLToPath(new URL('./make-certificates.py',import.meta.url)),dir],{windowsHide:true});
  const requests=[],closers=[];
  const srv=https.createServer({key:await readFile(join(dir,'server.key')),cert:await readFile(join(dir,'server.pem')),ca:await readFile(join(dir,'ca.pem')),requestCert:true,rejectUnauthorized:true},(req,res)=>{
    const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{
      requests.push({headers:req.headers,body:Buffer.concat(chunks).toString(),authorized:req.socket.authorized});
      setTimeout(()=>{res.writeHead(status,{'Content-Type':'text/xml'});res.end(body);},delay);
    });
  });
  await new Promise(r=>srv.listen(0,'127.0.0.1',r));
  t.after(async()=>{for(const close of closers)close();srv.closeAllConnections();await new Promise(r=>srv.close(r));await rm(dir,{recursive:true,force:true});});
  return {dir,requests,closers,config:{environment:'local-contract-test',endpoint:`https://127.0.0.1:${srv.address().port}/contract-test`,certPath:join(dir,'client.pem'),keyPath:join(dir,'client.key'),caPath:join(dir,'ca.pem')}};
}
test('XML TD01, TD04 e TD24 validi contro XSD ufficiale; importi esatti e escaping',async()=>{
  const d=sampleInvoice();let xml=await g.generate(d);assert.equal((await v.validate(xml)).xsdValidated,true);
  assert.match(xml,/<ImportoTotaleDocumento>219.60</);assert.match(xml,/&amp; prova &lt;XML&gt;/);
  d.type='TD04';d.reference={number:'TEST-0',date:'2026-09-01'};assert.equal((await v.validate(await g.generate(d))).xsdValidated,true);
  d.type='TD24';delete d.reference;d.notes='Rif. rapporto RI-12345678901234567 del 2026-09-11';xml=await g.generate(d);assert.equal((await v.validate(xml)).xsdValidated,true);assert.match(xml,/<TipoDocumento>TD24<\/TipoDocumento>/);assert.match(xml,/<Causale>Rif\. rapporto RI-/);
  const withoutDeferredReference={...d};delete withoutDeferredReference.notes;await assert.rejects(g.generate(withoutDeferredReference),/DEFERRED_REFERENCE_REQUIRED/);
  d.lines=[{description:'Arrotondamento',quantity:'1',unitPrice:'0.005',vat:'22'}];
  assert.equal(money(validateFiscalApplication(d).total),'0.01');assert.equal((await v.validate(await g.generate(d))).xsdValidated,true);
});
test('controlli applicativi separati, nessuna numerazione, casi ignoti rifiutati',async()=>{
  for(const mutate of [d=>d.numberSource='automatic',d=>d.seller.regime='RF19',d=>d.lines[0].vat='0',d=>d.lines[0].unitPrice=100,d=>d.lines[0].grossPrice='122',d=>d.date='2026-02-30',d=>d.type='TD29',d=>d.seller.vat='12345678900',d=>d.bollo=true]) {
    const d=sampleInvoice();mutate(d);await assert.rejects(g.generate(d));
  }
});
test('XSD rifiuta campi/namespace invalidi; DTD, entità, profondità e dimensioni bloccati',async()=>{
  const xml=await g.generate(sampleInvoice());
  for(const bad of [xml.replace('RF01','NONVALIDO'),xml.replace('<Numero>TEST-1</Numero>',''),xml.replace('versione="FPR12"','versione="BAD"'),xml.replace('docs/xsd/fatture/v1.2','wrong'),'<a>'+ '<b>'.repeat(70)+'</b>'.repeat(70)+'</a>','<!DOCTYPE x [<!ENTITY z SYSTEM "file:///secret">]><x>&z;</x>']) await assert.rejects(v.validate(bad));
  await assert.rejects(v.validate('x'.repeat(2000001)),/SIZE/);
});
test('richiesta derivata dal WSDL e base64 del documento; parsing esiti e fault',async()=>{
  const xml=await g.generate(sampleInvoice());const c=await xmlEngine({mode:'contract'});
  const req=await xmlEngine({mode:'request',filename:'IT12345678903_TEST1.xml',xml});assert.equal(req.action,c.action);
  assert.ok(req.xml.includes(Buffer.from(xml).toString('base64')));
  assert.equal((await xmlEngine({mode:'response',xml:await response()})).kind,'SDI_RECEIVED');
  for(const code of ['EI01','EI02','EI03']) assert.deepEqual(await xmlEngine({mode:'response',xml:await response(code)}),{kind:'TRANSPORT_REJECTED',code});
  await assert.rejects(xmlEngine({mode:'response',xml:await response('EI99')}),/XSD_INVALID/);
  await assert.rejects(xmlEngine({mode:'response',xml:(await response()).replace('<IdentificativoSdI>123</IdentificativoSdI>','')}),/XSD_INVALID/);
});
test('Web Service HTTPS con autenticazione reciproca, archivio e duplicati',async t=>{
  const s=await server(t,{body:await response()});const db=await FiscalTransmissionService.open(join(s.dir,'fiscal.sqlite'),s.config);s.closers.push(()=>db.close());
  const input={sourceKey:'test1',filename:'IT12345678903_TEST1.xml',invoice:sampleInvoice()};
  const a=await db.submit(input);assert.equal(a.state,'SDI_RECEIVED');assert.equal(s.requests.length,1);assert.equal(s.requests[0].authorized,true);
  assert.equal((await db.submit(input)).id,a.id);assert.equal(s.requests.length,1);
  assert.match(s.requests[0].headers.soapaction,/RiceviFile/);
  await assert.rejects(db.submit({...input,sourceKey:'other'}),/UNIQUE/);assert.equal(s.requests.length,1);
  const changed=sampleInvoice();changed.transmission.progressive='TEST2';
  await assert.rejects(db.submit({...input,sourceKey:'different-file',filename:'IT12345678903_TEST2.xml',invoice:changed}),/UNIQUE/);assert.equal(s.requests.length,1);
  await assert.rejects(db.submit({...input,invoice:{...sampleInvoice(),number:'TEST-2'}}),/IDEMPOTENCY_CONFLICT/);
  const reopened=await FiscalTransmissionService.open(join(s.dir,'fiscal.sqlite'),s.config);
  try {assert.equal(reopened.get(a.id).state,'SDI_RECEIVED');}finally {reopened.close();}
});
test('timeout conservato come UNKNOWN senza retry',async t=>{
  const s=await server(t,{body:await response(),delay:600});s.config.timeoutMs=100;
  const db=await FiscalTransmissionService.open(join(s.dir,'timeout.sqlite'),s.config);s.closers.push(()=>db.close());
  const input={sourceKey:'timeout',filename:'IT12345678903_TEST1.xml',invoice:sampleInvoice()};
  assert.equal((await db.submit(input)).state,'UNKNOWN');await db.submit(input);assert.equal(s.requests.length,1);
});
test('HTTP fault, risposte malformate e certificato non attendibile non diventano ACK',async t=>{
  const xml=await g.generate(sampleInvoice());
  const s=await server(t,{status:500,body:`<s:Envelope xmlns:s="${SOAP}"><s:Body><s:Fault><faultcode>s:Server</faultcode><faultstring>synthetic</faultstring></s:Fault></s:Body></s:Envelope>`});
  assert.equal((await new SdiClient(s.config).send({filename:'IT12345678903_TEST1.xml',xml})).kind,'UNKNOWN');
  assert.equal((await new SdiClient({...s.config,caPath:s.config.certPath}).send({filename:'IT12345678903_TEST2.xml',xml})).kind,'UNKNOWN');
  assert.equal(s.requests.length,1);
});
test('produzione e endpoint impropri bloccati prima della rete',async()=>{
  const xml=await g.generate(sampleInvoice());
  for(const config of [{environment:'production'},{environment:'local-contract-test',endpoint:'https://example.com'},{environment:'sdi-test',endpoint:'https://example.com'}]) await assert.rejects(new SdiClient(config).send({filename:'IT12345678903_TEST1.xml',xml}));
  await assert.rejects(new SdiClient().sendPrepared({xml:'fake',action:'fake'}),/PREFLIGHT_REQUIRED/);
});
