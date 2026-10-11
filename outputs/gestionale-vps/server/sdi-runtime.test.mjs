import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openDatabase, hash } from './database.mjs';
import { createSdiStore } from './sdi-store.mjs';
import { readSdiConfig, authenticateSdiGateway } from './sdi-config.mjs';
import { createSdiRuntime } from './sdi-runtime.mjs';

const gatewayToken = 'G'.repeat(64), peerFingerprint = 'a'.repeat(64);
const env = (extra = {}) => ({ SDI_ENABLED:'true', SDI_ENVIRONMENT:'test', SDI_ACCREDITATION_REFERENCE:'TEST-AGREEMENT',
  SHOP_VAT:'01234567890', SDI_DOMAIN:'sdi.example.com', OFFICINA_DOMAIN:'app.example.com',
  SDI_ENDPOINT:'https://testservizi.fatturapa.it/ricevi', SDI_ENDPOINT_HOST:'testservizi.fatturapa.it',
  SDI_GATEWAY_TOKEN:gatewayToken, SDI_PEER_FINGERPRINTS:peerFingerprint,
  SDI_CLIENT_CERT_PATH:'client-cert.pem', SDI_CLIENT_KEY_PATH:'client-key.pem', SDI_REMOTE_CA_PATH:'remote-ca.pem', ...extra });
const invoice = (extra = {}) => ({ documentId:'doc-1', fiscalKey:'IT01234567890|TD01|2026|1',
  xml:'<invoice/>', filename:'IT01234567890_2026000001.xml', metadata:{number:'1/2026'}, ...extra });
const incoming = (extra = {}) => ({ kind:'invoices', identifier:'123', filename:'IT01234567890_abcde.xml',
  payloadBase64:Buffer.from('<received-invoice/>').toString('base64'), response:{status:200,contentType:'text/xml',body:'<accepted/>'}, ...extra });
const supplier = { bodyIndex:0, supplierName:'Fornitore test',supplierTaxId:'IT09876543210',number:'1/A',issueDate:'2026-09-29',
  dueDate:'2026-10-29',totalCents:12300,documentType:'TD01' };
const protocol = (extra={}) => ({
  prepareOutgoing:async ({ filename, xml }) => ({ xml:`<send filename="${filename}">${xml}</send>`,action:'send',invoice:{seller:{country:'IT',vat:'01234567890'}} }),
  parseOutgoingResponse:async () => ({kind:'SDI_RECEIVED',identifier:'77'}),
  parseCallback:async () => incoming(), inspectIncoming:async () => [supplier], ...extra });
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(),'officina-sdi-runtime-test-')), db = openDatabase(dir);
  const runtimes = [];
  t.after(async () => {
    for (const runtime of runtimes) await runtime.stop();
    db.close();
    const path = resolve(dir);
    assert.ok(path.startsWith(resolve(tmpdir())+sep) && basename(path).startsWith('officina-sdi-runtime-test-'));
    rmSync(path,{recursive:true,force:true});
  });
  return { db, runtime: (options={}) => { const runtime=createSdiRuntime({db,env:env(),credentialsLoader:()=>({}),protocolApi:protocol(),
    transport:async ()=>({body:Buffer.from('<received/>'),status:200,contentType:'text/xml'}),...options}); runtimes.push(runtime); return runtime; } };
}
async function until(fn) { for (let n=0;n<100;n++) { if(fn()) return; await delay(20); } assert.fail('Timed out waiting for SdI worker'); }
async function callbackServer(t, runtime) {
  const server = http.createServer(async (req,res) => { if(!await runtime.callback(req,res)){res.writeHead(404);res.end();} });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
const headers = extra => ({'content-type':'text/xml','x-sdi-gateway-token':gatewayToken,'x-sdi-peer-fingerprint':peerFingerprint,
  'x-sdi-gateway-host':'sdi.example.com',soapaction:'action',...extra});

test('configuration fails closed on incomplete setup, wrong environment and untrusted endpoints', () => {
  assert.deepEqual(readSdiConfig({}),{enabled:false,environment:null});
  assert.equal(readSdiConfig(env()).environment,'test');
  for (const extra of [{SDI_ENABLED:'1'},{SDI_ACCREDITATION_REFERENCE:''},{SDI_DOMAIN:'app.example.com'},
    {SDI_GATEWAY_TOKEN:'weak'},{SDI_PEER_FINGERPRINTS:'bad'},{SDI_ENDPOINT:'http://testservizi.fatturapa.it/ricevi'},
    {SDI_ENDPOINT:'https://testservizi.fatturapa.it.evil.example/ricevi',SDI_ENDPOINT_HOST:'testservizi.fatturapa.it.evil.example'},
    {SDI_ENDPOINT:'https://testservizi.fatturapa.it:8443/ricevi'}, {SDI_ENDPOINT:'https://testservizi.fatturapa.it/ricevi?x=1'},
    {SDI_ENVIRONMENT:'production'}, {SDI_ENVIRONMENT:'production',SDI_PRODUCTION_APPROVED:'true'}, {SDI_TIMEOUT_MS:'0'}]) {
    assert.throws(()=>readSdiConfig(env(extra)),{code:'SDI_CONFIGURATION'});
  }
});
test('gateway authentication requires token, certificate fingerprint and expected host', () => {
  const config=readSdiConfig(env());
  assert.equal(authenticateSdiGateway({headers:headers()},config),true);
  for(const extra of [{'x-sdi-gateway-token':'B'.repeat(64)},{'x-sdi-peer-fingerprint':'b'.repeat(64)},
    {'x-sdi-gateway-host':'app.example.com'},{'x-sdi-gateway-token':[gatewayToken]},{'x-sdi-peer-fingerprint':undefined}]) {
    assert.equal(authenticateSdiGateway({headers:headers(extra)},config),false);
  }
  assert.equal(authenticateSdiGateway({headers:headers()},{enabled:false}),false);
});
test('disabled channel retains production archive visibility but cannot send', async t => {
  const f=fixture(t), store=createSdiStore(f.db,{environment:'production'}), data=invoice();
  store.enqueue({...data,digest:hash(data.xml)});
  const runtime=f.runtime({env:{SDI_ENABLED:'false',SDI_ENVIRONMENT:'test'}});
  assert.equal(runtime.status().environment,'production');
  assert.equal(runtime.store.list().length,1);
  await assert.rejects(runtime.enqueue(data),{code:'SDI_NOT_READY'});
});
test('preflight runs before guard and enqueue; worker sends the persisted five-character filename once', async t => {
  const f=fixture(t), names=[], sent=[];
  let guarded=false;
  const runtime=f.runtime({protocolApi:protocol({prepareOutgoing:async data => {names.push(data.filename);return protocol().prepareOutgoing(data);}}),
    transport:async (_,__,request) => {sent.push(request.xml);return {body:Buffer.from('ok'),status:200,contentType:'text/xml'};}});
  const item=await runtime.enqueue(invoice({beforeEnqueue:()=>{guarded=true;assert.equal(names.length,1);}}));
  assert.equal(guarded,true); assert.match(names[0],/_00000\.xml$/);
  assert.equal(item.metadata.number,'1/2026');
  runtime.start(); await until(()=>runtime.store.list()[0].state==='SDI_RECEIVED'); await runtime.stop();
  assert.equal(names[1],item.filename); assert.ok(sent[0].includes(item.filename));
  assert.equal((await runtime.enqueue(invoice())).duplicate,true);
  runtime.start(); await delay(40); await runtime.stop();
  assert.equal(sent.length,1);
});
test('stale invoice guard, seller mismatch and missing credentials prevent durable enqueue', async t => {
  const f=fixture(t), runtime=f.runtime();
  await assert.rejects(runtime.enqueue(invoice({beforeEnqueue:()=>{throw Error('changed');}})),/changed/);
  assert.equal(runtime.store.list().length,0);
  const wrong=f.runtime({protocolApi:protocol({prepareOutgoing:async()=>({invoice:{seller:{country:'IT',vat:'99999999999'}}})})});
  await assert.rejects(wrong.enqueue(invoice()),{code:'SDI_SELLER_MISMATCH'});
  const missing=f.runtime({credentialsLoader:()=>{throw Error('missing certificate');}});
  assert.equal(missing.status().ready,false);
  await assert.rejects(missing.enqueue(invoice()),{code:'SDI_NOT_READY'});
  assert.equal(runtime.store.list().length,0);
});
test('lost response becomes UNKNOWN, with no automatic retry after restart or repeated clicks', async t => {
  const f=fixture(t); let sends=0;
  const runtime=f.runtime({transport:async()=>{sends++;throw Error('timeout after send');}});
  await runtime.enqueue(invoice()); runtime.start();
  await until(()=>runtime.store.list()[0].state==='UNKNOWN'); await runtime.stop();
  assert.equal((await runtime.enqueue(invoice())).duplicate,true);
  runtime.start(); await delay(40); await runtime.stop();
  assert.equal(sends,1); assert.equal(runtime.store.list()[0].attempts,1);
});
test('failed result persistence halts sends until a new runtime recovers the interrupted attempt', async t => {
  const f=fixture(t), store=createSdiStore(f.db,{environment:'test'}), sent=[];
  let interruptedId;
  const runtime=f.runtime({store:{...store,finish:id=>{interruptedId=id;throw Error('SQLite write failed');}},
    transport:async (_,__,request)=>{sent.push(request.xml);return {body:Buffer.from('ok'),status:200,contentType:'text/xml'};}});
  await runtime.enqueue(invoice());
  await runtime.enqueue(invoice({documentId:'doc-2',fiscalKey:'IT01234567890|TD01|2026|2',
    filename:'IT01234567890_2026000002.xml',xml:'<second-invoice/>'}));
  runtime.start(); await until(()=>!runtime.status().ready);
  const issue=runtime.status().issues[0], pending=store.list().find(item=>item.id!==interruptedId);
  assert.match(issue,/riavviare il server/);
  assert.equal(store.detail(interruptedId).state,'IN_FLIGHT');
  assert.equal(pending.state,'READY'); assert.equal(sent.length,1);
  await assert.rejects(runtime.enqueue(invoice({documentId:'doc-3',fiscalKey:'IT01234567890|TD01|2026|3'})),{code:'SDI_NOT_READY'});

  // Credential rechecks and callbacks must not clear or bypass the fatal halt.
  const base=await callbackServer(t,runtime);
  const response=await fetch(base+'/sdi/invoices',{method:'POST',headers:headers(),body:'SOAP while halted'});
  assert.equal(response.status,200); assert.equal(store.listIncoming().length,1);
  await delay(3100);
  assert.equal(runtime.status().ready,false); assert.equal(runtime.status().issues[0],issue);
  assert.equal(sent.length,1); assert.equal(store.detail(pending.id).state,'READY');
  await runtime.stop(); runtime.start(); await delay(40); await runtime.stop();
  assert.equal(runtime.status().ready,false); assert.equal(runtime.status().issues[0],issue);
  assert.equal(store.detail(interruptedId).state,'IN_FLIGHT'); assert.equal(sent.length,1);

  const restarted=f.runtime({transport:async (_,__,request)=>{sent.push(request.xml);return {body:Buffer.from('ok'),status:200,contentType:'text/xml'};}});
  restarted.start();
  assert.equal(store.detail(interruptedId).state,'UNKNOWN');
  assert.equal(store.detail(interruptedId).errorCode,'INTERRUPTED');
  await until(()=>store.detail(pending.id).state==='SDI_RECEIVED'); await restarted.stop();
  assert.equal(restarted.status().ready,true); assert.equal(sent.length,2);
  assert.ok(sent[1].includes(pending.filename)); assert.equal(store.detail(interruptedId).attempts,1);
});
test('transient credential failure can recover without restarting the runtime', async t => {
  const f=fixture(t); let credentialsAvailable=true, sends=0;
  const runtime=f.runtime({credentialsLoader:()=>{if(!credentialsAvailable) throw Error('missing certificate');return {};},
    transport:async()=>{sends++;return {body:Buffer.from('ok'),status:200,contentType:'text/xml'};}});
  await runtime.enqueue(invoice()); credentialsAvailable=false; runtime.start();
  await until(()=>runtime.status().issues.filter(issue=>issue==='missing certificate').length===2);
  assert.equal(sends,0); credentialsAvailable=true;
  await runtime.stop(); runtime.start();
  await until(()=>runtime.store.list()[0].state==='SDI_RECEIVED'); await runtime.stop();
  assert.equal(runtime.status().ready,true); assert.equal(sends,1);
});
test('unauthenticated callback is rejected before parsing and authenticated receipt is durable before ACK', async t => {
  const f=fixture(t); let parses=0;
  const runtime=f.runtime({protocolApi:protocol({parseCallback:async()=>{parses++;return incoming();}})});
  const base=await callbackServer(t,runtime);
  let reply=await fetch(base+'/sdi/invoices',{method:'POST',headers:headers({'x-sdi-gateway-token':'bad'}),body:'raw SOAP'});
  assert.equal(reply.status,403); assert.equal(parses,0); assert.equal(runtime.store.listIncoming().length,0);
  reply=await fetch(base+'/sdi/invoices',{method:'POST',headers:headers(),body:'raw SOAP'});
  assert.equal(reply.status,200); assert.equal(await reply.text(),'<accepted/>');
  const item=runtime.store.listIncoming()[0];
  assert.equal(runtime.store.original('incoming-raw',item.id).bytes.toString(),'raw SOAP');
  await fetch(base+'/sdi/invoices',{method:'POST',headers:headers(),body:'raw SOAP duplicate delivery'});
  assert.equal(runtime.store.listIncoming().length,1);
});
test('failed durable callback storage never returns success ACK', async t => {
  const f=fixture(t), store=createSdiStore(f.db,{environment:'test'});
  const runtime=f.runtime({store:{...store,acceptInvoice:()=>{throw Error('disk full');}}});
  const base=await callbackServer(t,runtime), reply=await fetch(base+'/sdi/invoices',{method:'POST',headers:headers(),body:'raw'});
  assert.equal(reply.status,500); assert.equal(store.listIncoming().length,0);
});
test('invoice endpoint dispatches notification operations to receipt archive', async t => {
  const f=fixture(t), parsed=incoming({kind:'notifications',filename:'IT01234567890_abcde_DT_001.xml',
    payloadBase64:Buffer.from('<receipt/>').toString('base64'),notification:{identifier:'123',invoiceFilename:'IT01234567890_abcde.xml',outcome:'DECORRENZA_TERMINI'}});
  const runtime=f.runtime({protocolApi:protocol({parseCallback:async()=>parsed})});
  const base=await callbackServer(t,runtime);
  const response=await fetch(base+'/sdi/invoices',{method:'POST',headers:headers(),body:'notification raw'});
  assert.equal(response.status,200); assert.equal(runtime.store.listNotifications().length,1); assert.equal(runtime.store.listIncoming().length,0);
});
test('production incoming bodies import atomically from archived bytes and test invoices never enter accounting', async t => {
  const f=fixture(t); let inspected=null;
  const runtime=f.runtime({env:env({SDI_ENVIRONMENT:'production',SDI_PRODUCTION_APPROVED:'true',
    SDI_ENDPOINT:'https://servizi.fatturapa.it/ricevi',SDI_ENDPOINT_HOST:'servizi.fatturapa.it'}),
    protocolApi:protocol({inspectIncoming:async data=>{inspected=data;return [supplier,{...supplier,bodyIndex:1,number:'2/A',totalCents:4000}];}})});
  runtime.store.acceptInvoice(incoming(),Buffer.from('SOAP'));
  runtime.start(); await until(()=>runtime.store.listIncoming()[0].state==='IMPORTED'); await runtime.stop();
  assert.equal(Buffer.from(inspected.base64,'base64').toString(),'<received-invoice/>');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM supplier_invoices').get().count,2);
});
test('collaudo and unsupported incoming payloads stay reviewable without supplier totals', async t => {
  const f=fixture(t), runtime=f.runtime();
  runtime.store.acceptInvoice(incoming(),Buffer.from('SOAP'));
  runtime.start(); await until(()=>runtime.store.listIncoming()[0].state==='REVIEW'); await runtime.stop();
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM supplier_invoices').get().count,0);
  assert.match(runtime.store.listIncoming()[0].reason,/collaudo/);
  const unsupported=f.runtime({protocolApi:protocol({inspectIncoming:async()=>({quarantineReason:'Formato firmato da verificare'})})});
  unsupported.store.acceptInvoice(incoming({identifier:'456',filename:'IT01234567890_fghij.xml.p7m'}),Buffer.from('SOAP2'));
  unsupported.start(); await until(()=>unsupported.store.listIncoming().every(item=>item.state==='REVIEW')); await unsupported.stop();
  assert.match(unsupported.store.listIncoming()[0].reason,/firmato/);
});
