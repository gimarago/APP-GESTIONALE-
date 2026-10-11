import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, sep, basename } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createApplication } from './server.mjs';
import { addUser, hash } from './database.mjs';
import { createSdiStore } from './sdi-store.mjs';
import { checkedInvoice } from './sdi-api.mjs';

const require=createRequire(import.meta.url),R=require('../cloud-records.js'),I=require('../fatturazione.js');
const ORIGIN='http://localhost:8080',KEY='officina.invoices.v1',PASSWORD='synthetic-password-1234';
const seller={name:'Officina test',vat:'01114601006',address:'Via Roma 1',zip:'00100',city:'Roma',province:'RM'};
function archive(){const doc=I.prepare({id:randomUUID(),status:'draft',type:'TD01',date:'2026-09-28',payment:'MP05',customer:{...seller,code:'0000000'},lines:[{description:'Lavoro sintetico',quantity:1,price:100,vat:22}]},{seller,documents:[]});return {version:1,seller,documents:[doc]};}
function stateFor(a){const s=R.empty();s.storage[KEY]=JSON.stringify(a);return s;}

async function fixture(t,{realDisabled=false}={}){
  const dir=mkdtempSync(join(tmpdir(),'officina-sdi-api-test-'));
  let store,delay=async()=>{};
  const app=await createApplication({dataDir:dir,origin:ORIGIN,env:{NODE_ENV:'test',SHOP_VAT:seller.vat},...(!realDisabled?{createSdiRuntime:({db})=>{
    store=createSdiStore(db,{environment:'test'});
    return {store,status:()=>({enabled:true,ready:true,environment:'test',issues:[]}),start(){},async stop(){},async callback(req,res){res.writeHead(403).end();return true;},
      async enqueue(data,auth){await delay();data.beforeEnqueue();return store.enqueue({...data,digest:hash(data.xml)},auth);}};
  }}:{})});
  if(realDisabled)store=app.sdi.store;
  await addUser(app.db,'operator',PASSWORD,'operator');await addUser(app.db,'viewer',PASSWORD,'viewer');
  await new Promise(ok=>app.server.listen(0,'127.0.0.1',ok));const base='http://127.0.0.1:'+app.server.address().port;
  t.after(async()=>{await app.close();const path=resolve(dir);assert.ok(path.startsWith(resolve(tmpdir())+sep)&&basename(path).startsWith('officina-sdi-api-test-'));rmSync(path,{recursive:true,force:true});});
  async function call(user,path,method='GET',data,headers={}){const r=await fetch(base+path,{method,headers:{cookie:user?.cookie||'',...(method!=='GET'?{origin:ORIGIN,'x-csrf-token':user?.csrf||'','content-type':'application/json'}:{}),...headers},...(data?{body:JSON.stringify(data)}:{})});const raw=await r.text();let value;try{value=JSON.parse(raw);}catch{value=raw;}return {status:r.status,value,headers:r.headers};}
  async function login(username='operator'){const r=await call(null,'/api/login','POST',{username,password:PASSWORD});assert.equal(r.status,200);return {cookie:r.headers.get('set-cookie').split(';')[0],csrf:r.value.csrf,clientId:randomUUID()};}
  async function save(u,mutate){const snap=(await call(u,'/api/state')).value;const state=structuredClone(snap.state||R.empty());mutate(state);return call(u,'/api/changes','PUT',{protocol:2,clientId:u.clientId,mutationId:randomUUID(),versions:snap.versions,changes:R.diff(snap.state,state,snap.versions)});}
  return {app,store,base,dir,call,login,save,setDelay:fn=>{delay=fn;}};
}
const submission=doc=>({documentId:doc.id,expectedDigest:hash(doc.xml),environment:'test',confirmed:true});

test('only the canonical saved invoice can be sent; browser XML cannot override it',()=>{
  const a=archive(),d=a.documents[0],state=stateFor(a);
  assert.equal(checkedInvoice(state,d.id,hash(d.xml),'IT'+seller.vat).xml,d.xml);
  assert.throws(()=>checkedInvoice(state,d.id,'a'.repeat(64),seller.vat),{code:'SDI_STALE'});
  a.documents[0].lines[0].price=900;
  assert.throws(()=>checkedInvoice(stateFor(a),d.id,hash(d.xml),seller.vat),{code:'SDI_XML_MISMATCH'});
});

test('auth, role, CSRF, environment and explicit confirmation protect channel routes',async t=>{
  const f=await fixture(t),u=await f.login(),v=await f.login('viewer'),a=archive(),d=a.documents[0];
  assert.equal((await f.save(u,s=>s.storage[KEY]=JSON.stringify(a))).status,200);
  assert.equal((await f.call(null,'/api/sdi/status')).status,401);
  assert.equal((await f.call(v,'/api/sdi/status')).status,200);
  assert.equal((await f.call(v,'/api/sdi/submissions','POST',submission(d))).status,403);
  assert.equal((await f.call(u,'/api/sdi/submissions','POST',submission(d),{'x-csrf-token':'wrong'})).status,403);
  for(const extra of [{confirmed:false},{environment:'production'}])assert.equal((await f.call(u,'/api/sdi/submissions','POST',{...submission(d),...extra})).status,400);
  const response=await f.call(u,'/api/sdi/submissions','POST',{...submission(d),xml:'attacker-controlled'});
  assert.equal(response.status,202);assert.equal(f.store.original('outgoing',response.value.id).bytes.toString(),d.xml);
  assert.equal((await f.call(null,'/sdi/invoices','POST',{})).status,403);
});

test('concurrent submissions deduplicate; submitted documents cannot be deleted or rewritten, but payments save',async t=>{
  const f=await fixture(t),u=await f.login(),a=archive(),d=a.documents[0];
  await f.save(u,s=>s.storage[KEY]=JSON.stringify(a));
  const results=await Promise.all([1,2].map(()=>f.call(u,'/api/sdi/submissions','POST',submission(d))));
  assert.deepEqual(results.map(r=>r.status),[202,202]);assert.equal(results[0].value.id,results[1].value.id);assert.equal(f.store.list().length,1);
  const mutate=fn=>f.save(u,s=>{const a=JSON.parse(s.storage[KEY]);fn(a);s.storage[KEY]=JSON.stringify(a);});
  assert.equal((await mutate(a=>a.documents=[])).value.error.code,'SDI_DOCUMENT_LOCKED');
  assert.equal((await mutate(a=>{const d=a.documents[0];d.lines[0].price=200;d.xml=I.xml(d,d.seller);})).value.error.code,'SDI_DOCUMENT_LOCKED');
  assert.equal((await mutate(a=>{a.documents[0].paid=true;a.documents[0].paidDate='2026-09-28';})).status,200);
  assert.equal((await f.call(u,'/api/sdi/submissions/'+results[0].value.id+'/original')).value,d.xml);
});

test('an edit during async preflight prevents an obsolete invoice from entering the queue',async t=>{
  const f=await fixture(t),u=await f.login(),a=archive(),d=a.documents[0];await f.save(u,s=>s.storage[KEY]=JSON.stringify(a));
  let entered,release;const begun=new Promise(ok=>entered=ok),gate=new Promise(ok=>release=ok);
  f.setDelay(async()=>{entered();await gate;});const pending=f.call(u,'/api/sdi/submissions','POST',submission(d));await begun;
  const changed=await f.save(u,s=>{const a=JSON.parse(s.storage[KEY]);a.documents[0].lines[0].price=200;a.documents[0].xml=I.xml(a.documents[0],a.documents[0].seller);s.storage[KEY]=JSON.stringify(a);});
  assert.equal(changed.status,200);release();assert.equal((await pending).value.error.code,'SDI_STALE');assert.equal(f.store.list().length,0);
});

test('default installation remains usable and refuses transmissions without accreditation',async t=>{
  const f=await fixture(t,{realDisabled:true}),u=await f.login(),a=archive();await f.save(u,s=>s.storage[KEY]=JSON.stringify(a));
  const status=(await f.call(u,'/api/sdi/status')).value;assert.equal(status.enabled,false);assert.equal(status.ready,false);
  const result=await f.call(u,'/api/sdi/submissions','POST',{...submission(a.documents[0]),environment:status.environment});
  assert.equal(result.status,503);assert.equal(f.store.list().length,0);
  assert.equal((await f.call(null,'/sdi/invoices','POST',{})).status,503);
});

test('CLI backup preserves SdI originals and restore fences even apparently unsent queued invoices',async t=>{
  const f=await fixture(t),u=await f.login(),a=archive(),d=a.documents[0];await f.save(u,s=>s.storage[KEY]=JSON.stringify(a));
  const queued=(await f.call(u,'/api/sdi/submissions','POST',submission(d))).value;
  async function cli(...args){return new Promise((ok,bad)=>{const child=spawn(process.execPath,[fileURLToPath(new URL('./cli.mjs',import.meta.url)),...args],{env:{...process.env,DATA_DIR:f.dir},windowsHide:true});let output='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);child.on('error',bad);child.on('exit',code=>code===0?ok(output):bad(Error(output)));});}
  const backup=join(f.dir,'sdi-test-backup.sqlite');await cli('backup',backup);
  const claim=f.store.claim();f.store.finish(claim.id,{state:'SDI_RECEIVED',sdiId:'123456',claimToken:claim.claimToken});
  await f.app.close();await cli('restore',backup);
  const db=new DatabaseSync(join(f.dir,'officina.sqlite'));
  try{const restored=createSdiStore(db,{environment:'test'});assert.equal(restored.detail(queued.id).state,'UNKNOWN');assert.equal(restored.claim(),null);assert.equal(restored.original('outgoing',queued.id).bytes.toString(),d.xml);}finally{db.close();}
});
