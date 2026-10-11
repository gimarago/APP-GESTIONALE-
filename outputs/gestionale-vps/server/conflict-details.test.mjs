import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createApplication } from './server.mjs';
import { addUser } from './database.mjs';

const R=createRequire(import.meta.url)('../cloud-records.js');
const D=createRequire(import.meta.url)('../cloud-conflict-details.js');
const origin='http://localhost:8080',password='a long isolated testing password';
const cash='ma-gomme-cashbook-v1',accountId='cash-00000000-0000-4000-8000-000000000001';
const td=value=>({t:'td',a:{},c:[value]});
const stock=(id='tyre',quantity=10)=>({t:'tr',a:{'data-cloud-id':id,'data-quantity':String(quantity),'data-unit':'pz'},c:[td('155/65/14 75T FALKEN'),td('Pneumatici estivi'),td(String(quantity)),td('€ 50,00'),td('A1'),td('DISPONIBILE'),td('0 pz')]});
const job=status=>({t:'tr',a:{'data-cloud-id':'job','data-date':'2026-10-05'},c:[td('09:30'),td('Cliente Test'),td('AB123CD'),td('Diagnosi'),td('€ 100,00'),td(status)]});
const copy=(base,edit)=>{const state=structuredClone(base.state||R.empty());edit(state);return state;};
const setQuantity=(state,quantity,index=0)=>{state.dom['#stockRows'][index].a['data-quantity']=String(quantity);state.dom['#stockRows'][index].c[2]=td(String(quantity));};

test('inventory count conflicts name the draft or the exact counted product',()=>{
 const item={cloudId:'stock-1',product:'195/75/16 110/108 FALKEN',category:'Pneumatici quattro stagioni',unit:'pz',expectedQuantity:2,countedQuantity:4,counted:true,countInput:'4'};
 const detail=D.describe(R.key('inventory-count-item','draft-1','stock-1'),{item,index:0,baseStockVersion:4});
 assert.equal(detail.title,'Conteggio inventario · 195/75/16 110/108 FALKEN');
 assert.ok(detail.fields.some(field=>field.label==='Quantità contata'&&field.value==='4'));
 const delta=D.difference(R.key('inventory-count-item','draft-1','stock-1'),{item:{...item,countedQuantity:3,countInput:'3'},index:0,baseStockVersion:4},{item,index:0,baseStockVersion:4});
 assert.ok(delta.some(change=>change.label==='Quantità contata'&&change.before==='3'&&change.after==='4'));
 const draft=D.describe(R.key('inventory-draft'),{metadata:{id:'draft-1',status:'counting',startedAt:'2026-10-05T21:57:16.919Z'},hasBaseStockVersions:true});
 assert.equal(draft.title,'Conteggio inventario');assert.ok(draft.fields.some(field=>field.label==='Stato conteggio'&&field.value==='In corso'));
});

async function fixture(t){
 const directory=mkdtempSync(join(tmpdir(),'officina-conflict-test-'));
 const app=await createApplication({dataDir:directory,origin,env:{NODE_ENV:'test'}});
 await addUser(app.db,'Alessio',password,'admin');await addUser(app.db,'Pina',password,'operator');
 await new Promise(ok=>app.server.listen(0,'127.0.0.1',ok));const base=`http://127.0.0.1:${app.server.address().port}`;
 t.after(async()=>{await app.close();const absolute=resolve(directory);assert.ok(absolute.startsWith(resolve(tmpdir())+sep)&&basename(absolute).startsWith('officina-conflict-test-'));rmSync(absolute,{recursive:true,force:true});});
 async function request(user,path,method='GET',data){
  const response=await fetch(base+path,{method,headers:{...(user?.cookie?{cookie:user.cookie}:{}),...(method!=='GET'?{origin,'x-csrf-token':user?.csrf||'','content-type':'application/json'}:{})},...(data===undefined?{}:{body:JSON.stringify(data)})});
  return {status:response.status,body:await response.json(),headers:response.headers};
 }
 async function login(username){const user={clientId:randomUUID()};const result=await request(user,'/api/login','POST',{username,password});assert.equal(result.status,200);user.cookie=result.headers.get('set-cookie').split(';')[0];user.csrf=result.body.csrf;return user;}
 const a=await login('Alessio'),b=await login('Pina');
 const snapshot=async()=>(await request(a,'/api/state')).body;
 const operation=(user,base,state)=>({protocol:2,clientId:user.clientId,mutationId:randomUUID(),versions:base.versions,changes:R.diff(base.state,state,base.versions)});
 const submit=(user,base,edit)=>request(user,'/api/changes','PUT',operation(user,base,copy(base,edit)));
 const counts=()=>({audit:app.db.prepare('SELECT count(*) AS n FROM audit').get().n,receipts:app.db.prepare('SELECT count(*) AS n FROM receipts').get().n});
 return {app,a,b,request,snapshot,operation,submit,counts};
}
const quantity=detail=>detail.changes.find(c=>/quant|disponib|scort/i.test(c.key+' '+c.label));
const assertActor=detail=>{assert.equal(detail.updatedBy,'Pina');assert.ok(Number.isSafeInteger(detail.updatedAt)&&detail.updatedAt>0);};

test('two authenticated users get the committed stock quantity, author and time without applying the losing batch',async t=>{
 const f=await fixture(t);assert.equal((await f.submit(f.a,await f.snapshot(),s=>s.dom['#stockRows'].push(stock()))).status,200);
 const base=await f.snapshot();const winning=f.operation(f.b,base,copy(base,s=>setQuantity(s,7)));
 assert.equal((await f.request(f.b,'/api/changes','PUT',winning)).status,200);
 const saved=await f.snapshot(),counts=f.counts();
 const result=await f.submit(f.a,base,s=>{setQuantity(s,8);s.fields.shopPhone='LOCAL UNSAVED VALUE';});
 assert.equal(result.status,409);assert.equal(result.body.error.code,'RECORD_CONFLICT');
 const conflict=result.body.conflicts[0];assert.equal(conflict.key,R.key('row','#stockRows','tyre'));assert.match(conflict.detail.title,/FALKEN/i);assertActor(conflict.detail);
 const changed=quantity(conflict.detail);assert.ok(changed);assert.equal(changed.before,'10');assert.equal(changed.after,'7');
 assert.deepEqual(await f.snapshot(),saved);assert.deepEqual(f.counts(),counts);
 const body=JSON.stringify(result.body);assert.doesNotMatch(body,/LOCAL UNSAVED VALUE|"t":"|csrf|sessionId|password/);
 assert.equal((await f.request(f.b,'/api/changes','PUT',winning)).body.replayed,true);assert.deepEqual(f.counts(),counts);
 const audit=JSON.parse(f.app.db.prepare("SELECT details FROM audit WHERE action='records-saved' ORDER BY id DESC LIMIT 1").get().details);
 assert.ok(audit.summaries.some(s=>s.key===conflict.key&&quantity(s).after==='7'));assert.doesNotMatch(JSON.stringify(audit.summaries),/"t":"|data-cloud-id/);
});

test('deleted records and an ABA recreation explain the latest actual committed change',async t=>{
 const f=await fixture(t);await f.submit(f.a,await f.snapshot(),s=>s.dom['#stockRows'].push(stock()));const base=await f.snapshot();
 await f.submit(f.b,base,s=>s.dom['#stockRows']=[]);
 const deleted=await f.submit(f.a,base,s=>setQuantity(s,8));assert.equal(deleted.status,409);const first=deleted.body.conflicts[0].detail;assertActor(first);assert.match(first.title,/FALKEN/i);assert.ok(first.currentFields.some(c=>/eliminat|non presente/i.test(c.value)));assert.ok(first.changes.length);
 await f.submit(f.b,await f.snapshot(),s=>s.dom['#stockRows'].push(stock()));const saved=await f.snapshot(),counts=f.counts();
 const recreated=await f.submit(f.a,base,s=>setQuantity(s,8));assert.equal(recreated.status,409);const second=recreated.body.conflicts[0].detail;assertActor(second);assert.ok(second.changes.length);assert.equal(quantity(second).after,'10');assert.ok(second.currentFields.some(c=>c.value==='10'));
 assert.deepEqual(await f.snapshot(),saved);assert.deepEqual(f.counts(),counts);
});

test('legacy keys-only audit gives honest author and current values, and missing attribution remains unknown',async t=>{
 const f=await fixture(t);await f.submit(f.a,await f.snapshot(),s=>s.dom['#stockRows'].push(stock()));const base=await f.snapshot();await f.submit(f.b,base,s=>setQuantity(s,7));
 const record=f.app.db.prepare("SELECT id,details FROM audit WHERE action='records-saved' ORDER BY id DESC LIMIT 1").get(),old=JSON.parse(record.details);
 f.app.db.prepare('UPDATE audit SET details=? WHERE id=?').run(JSON.stringify({keys:old.keys}),record.id);
 const legacy=await f.submit(f.a,base,s=>setQuantity(s,8));assert.equal(legacy.status,409);const detail=legacy.body.conflicts[0].detail;assertActor(detail);assert.deepEqual(detail.changes,[]);assert.ok(detail.currentFields.some(c=>c.value==='7'));
 f.app.db.prepare('DELETE FROM audit WHERE id=?').run(record.id);
 const unknown=await f.submit(f.a,base,s=>setQuantity(s,8));assert.equal(unknown.status,409);assert.equal(unknown.body.conflicts[0].detail.updatedBy,null);assert.equal(unknown.body.conflicts[0].detail.updatedAt,null);assert.deepEqual(unknown.body.conflicts[0].detail.changes,[]);
});

test('inventory read dependency identifies the relevant changed article instead of returning a whole stock archive',async t=>{
 const f=await fixture(t);await f.submit(f.a,await f.snapshot(),s=>{s.dom['#stockRows'].push(stock());s.dom['#agendaRows'].push(job('IN LAVORAZIONE'));});const base=await f.snapshot();
 await f.submit(f.b,base,s=>setQuantity(s,7));const saved=await f.snapshot(),counts=f.counts();
 const result=await f.submit(f.a,base,s=>s.dom['#agendaRows'][0]=job('COMPLETATO'));
 assert.equal(result.status,409);assert.equal(result.body.error.code,'DEPENDENCY_CONFLICT');const conflict=result.body.conflicts.find(c=>c.key==='domain:inventory');assertActor(conflict.detail);assert.equal(conflict.detail.related.length,1);
 const related=conflict.detail.related[0];assert.equal(related.key,R.key('row','#stockRows','tyre'));assertActor(related.detail);assert.equal(quantity(related.detail).before,'10');assert.equal(quantity(related.detail).after,'7');
 assert.deepEqual(await f.snapshot(),saved);assert.deepEqual(f.counts(),counts);assert.doesNotMatch(JSON.stringify(result.body),/"dom"|"storage"|"t":"/);
});

test('an unchanged account fenced by a payment identifies that payment without inventing an account edit',async t=>{
 const f=await fixture(t);await f.submit(f.a,await f.snapshot(),s=>s.storage[cash]=JSON.stringify({version:1,nextId:1,accounts:[{id:accountId,meta:{customer:'Cliente Test',vehicle:'AB123CD',amount:100},state:{inCash:100,outside:0,profit:0}}],payments:[]}));const base=await f.snapshot();
 const pay=(state,id,cents)=>{const data=JSON.parse(state.storage[cash]);data.payments.push({id,accountId,kind:'deposit',date:'2026-10-05',time:'09:00',cents,meta:{customer:'Cliente Test',vehicle:'AB123CD'}});state.storage[cash]=JSON.stringify(data);};
 await f.submit(f.b,base,s=>pay(s,'payment-pina',2000));const saved=await f.snapshot(),counts=f.counts();
 const result=await f.submit(f.a,base,s=>pay(s,'payment-alessio',3000));assert.equal(result.status,409);assert.equal(result.body.error.code,'DEPENDENCY_CONFLICT');const conflict=result.body.conflicts[0];assert.equal(conflict.key,R.key('cash','accounts',accountId));assertActor(conflict.detail);assert.deepEqual(conflict.detail.changes,[]);
 assert.equal(conflict.detail.related.length,1);const payment=conflict.detail.related[0];assert.equal(payment.key,R.key('cash','payments','payment-pina'));assertActor(payment.detail);assert.ok(payment.detail.changes.some(c=>/20/.test(c.after)));
 assert.deepEqual(await f.snapshot(),saved);assert.deepEqual(f.counts(),counts);
});

test('large conflict lists and inventory summaries are bounded and report omitted entries',async t=>{
 const f=await fixture(t);await f.submit(f.a,await f.snapshot(),s=>{s.dom['#stockRows']=Array.from({length:35},(_,i)=>stock('tyre-'+i));s.dom['#agendaRows'].push(job('IN LAVORAZIONE'));});const base=await f.snapshot();
 await f.submit(f.b,base,s=>s.dom['#stockRows'].forEach((_,i)=>setQuantity(s,7,i)));const saved=await f.snapshot(),counts=f.counts();
 const many=await f.submit(f.a,base,s=>s.dom['#stockRows'].forEach((_,i)=>setQuantity(s,8,i)));assert.equal(many.status,409);assert.equal(many.body.conflicts.length,30);assert.equal(many.body.omittedConflicts,5);
 const dependency=await f.submit(f.a,base,s=>s.dom['#agendaRows'][0]=job('COMPLETATO'));assert.equal(dependency.status,409);const summary=dependency.body.conflicts[0].detail;assert.equal(summary.related.length,20);assert.equal(summary.omittedRelated,15);assert.ok(Buffer.byteLength(JSON.stringify(dependency.body))<60*1024);
 assert.deepEqual(await f.snapshot(),saved);assert.deepEqual(f.counts(),counts);
});

test('conflict descriptions and new audit summaries never copy legacy credential fields',async t=>{
 const f=await fixture(t),key='officina-email-settings-v1';
 await f.submit(f.a,await f.snapshot(),s=>s.storage[key]=JSON.stringify({provider:'gmail',email:'before@example.test',accessToken:'SECRET_TOKEN_BEFORE',password:'SECRET_PASSWORD_BEFORE'}));const base=await f.snapshot();
 await f.submit(f.b,base,s=>s.storage[key]=JSON.stringify({provider:'gmail',email:'after@example.test',accessToken:'SECRET_TOKEN_AFTER',password:'SECRET_PASSWORD_AFTER'}));
 const rejected=await f.submit(f.a,base,s=>s.storage[key]=JSON.stringify({provider:'outlook',email:'local@example.test'}));assert.equal(rejected.status,409);assertActor(rejected.body.conflicts[0].detail);assert.ok(rejected.body.conflicts[0].detail.changes.some(c=>c.key==='email'&&c.after==='after@example.test'));
 assert.doesNotMatch(JSON.stringify(rejected.body),/SECRET_|accessToken|password/);
 for(const entry of f.app.db.prepare("SELECT details FROM audit WHERE action='records-saved'").all())assert.doesNotMatch(entry.details,/SECRET_|accessToken|password/);
});
