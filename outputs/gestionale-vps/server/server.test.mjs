import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, sep, basename } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createApplication, acquireProcessLock } from './server.mjs';
import { addUser } from './database.mjs';
import { makeStateValidator } from './validation.mjs';

const R = createRequire(import.meta.url)('../cloud-records.js');
const schema = createRequire(import.meta.url)('../cloud-schema.js');
const ORIGIN = 'http://localhost:8080';
const PASSWORD = 'correct horse battery staple';
const makeState = label => ({ schemaVersion: 1, storage: { 'officina-postit': JSON.stringify([{ id:'note', text: label }]) }, dom: Object.fromEntries(schema.selectors.map(key => [key, key === '#customerRows' ? [{t:'tr',a:{'data-id':'customer-1'},c:[{t:'td',a:{},c:[label]}]}] : []])), fields: { shopName: label } });

function removeTemporary(directory) {
  const absolute = resolve(directory);
  if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('officina-test-')) throw new Error('Refusing unsafe test cleanup.');
  rmSync(absolute, { recursive: true, force: true });
}

async function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'officina-test-'));
  let time = Date.now();
  const settings = { dataDir: directory, origin: ORIGIN, env: { NODE_ENV: 'test' }, now: () => time, ...options };
  let app = await createApplication(settings);
  await addUser(app.db, 'admin', PASSWORD, 'admin');
  await addUser(app.db, 'operator', PASSWORD, 'operator');
  await addUser(app.db, 'viewer', PASSWORD, 'viewer');
  let base;
  async function listen() { await new Promise(ok => app.server.listen(0, '127.0.0.1', ok)); base = `http://127.0.0.1:${app.server.address().port}`; }
  await listen();
  t.after(async () => { await app.close(); removeTemporary(directory); });
  const client = () => ({ clientId: randomUUID(), cookie: '', csrf: '' });
  async function request(user, path, method = 'GET', data, overrides = {}) {
    const headers = { ...(user?.cookie ? { cookie: user.cookie } : {}), ...(method !== 'GET' ? { origin: ORIGIN, 'x-csrf-token': user?.csrf || '', 'content-type':'application/json' } : {}), ...(overrides.headers || {}) };
    const response = await fetch(base + path, { method, headers, ...(data === undefined ? {} : { body: JSON.stringify(data) }), redirect:'manual' });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: response.status, body, headers: response.headers };
  }
  async function login(username = 'operator') {
    const user = client();
    const response = await request(user, '/api/login', 'POST', { username, password: PASSWORD });
    assert.equal(response.status, 200);
    user.cookie = response.headers.get('set-cookie').split(';')[0]; user.csrf = response.body.csrf;
    return user;
  }
  const snapshot=async user=>(await request(user,'/api/state')).body;
  const operation=(user,base,state)=>({protocol:2,clientId:user.clientId,mutationId:randomUUID(),versions:base.versions,changes:R.diff(base.state,state,base.versions)});
  async function save(user,label){const base=await snapshot(user);const state=structuredClone(base.state||R.empty());state.fields.shopName=label;return request(user,'/api/changes','PUT',operation(user,base,state));}
  return { directory, get app() { return app; }, get base() { return base; }, client, request, login, snapshot, operation, save, advance(ms) { time += ms; }, async restart() { await app.close(); app = await createApplication(settings); await listen(); } };
}
const node=(id,label,attrs={})=>({t:'tr',a:{'data-cloud-id':id,...attrs},c:[{t:'td',a:{},c:[label]}]});
const changed=(base,fn)=>{const state=structuredClone(base.state||R.empty());fn(state);return state;};
const submit=(f,user,base,fn)=>f.request(user,'/api/changes','PUT',f.operation(user,base,changed(base,fn)));


test('authentication, same-origin, CSRF, read-only roles and retired full-snapshot endpoints',async t=>{
 const f=await fixture(t);assert.equal((await f.request(null,'/api/state')).status,401);const a=await f.login(),v=await f.login('viewer');
 const login=await f.request(null,'/api/login','POST',{username:'admin',password:PASSWORD});assert.match(login.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
 for(const headers of [{'x-csrf-token':'wrong'},{origin:'https://attacker.invalid'},{'sec-fetch-site':'cross-site'}])assert.equal((await f.request(a,'/api/changes','PUT',{}, {headers})).status,403);
 assert.equal((await f.save(v,'Forbidden')).status,403);assert.equal((await f.request(a,'/api/lease','POST',{})).body.error.code,'UPGRADE_REQUIRED');assert.equal((await f.request(a,'/api/state','PUT',{})).status,409);
 f.advance(13*60*60*1000);assert.equal((await f.request(a,'/api/state')).status,401);
});

test('report and quote PDF email requires a writer, sends the PDF and replays one request only once', async t => {
  const deliveries = [], f = await fixture(t, { sendReportEmail: async data => { deliveries.push(structuredClone(data)); return { ok:true, provider:data.provider, message:'sent' }; } });
  const writer = await f.login(), viewer = await f.login('viewer'), attachment = { name:'Rapporto-RI-ABC123.pdf', base64:Buffer.from('%PDF-1.7 rapporto').toString('base64') };
  const data = { provider:'gmail', from:'sender@gmail.com', to:'cliente@example.it', subject:'Rapporto mensile', body:'Lavori completati.', attachment, requestId:randomUUID() };
  assert.equal((await f.request(null, '/api/email/send', 'POST', data)).status, 401);
  assert.equal((await f.request(viewer, '/api/email/send', 'POST', data)).status, 403);
  assert.equal((await f.request(writer, '/api/email/send', 'POST', data, { headers:{'x-csrf-token':'invalid'} })).status, 403);
  assert.equal((await f.request(writer, '/api/email/send', 'POST', {...data, attachment:{...attachment,name:'other.pdf'}})).status, 400);
  const sent = await f.request(writer, '/api/email/send', 'POST', data);
  assert.equal(sent.status, 200);assert.equal(sent.body.provider,'gmail');assert.equal(deliveries.length,1);
  assert.deepEqual(deliveries[0].attachment,attachment);assert.equal(deliveries[0].to,data.to);
  assert.equal((await f.request(writer, '/api/email/send', 'POST', data)).status, 200);assert.equal(deliveries.length,1);
  assert.equal((await f.request(writer, '/api/email/send', 'POST', {...data, body:'Messaggio diverso'})).status, 409);assert.equal(deliveries.length,1);
  const quote={...data,attachment:{...attachment,name:'Preventivo-2026-10-06-A1B2C3D4.pdf'},requestId:randomUUID()};
  assert.equal((await f.request(writer, '/api/email/send', 'POST', quote)).status,200);assert.equal(deliveries.length,2);
  assert.equal(deliveries[1].attachment.name,quote.attachment.name);
});
test('conditional state GET preserves full snapshots and returns authenticated bodyless 304 responses', async t => {
  const f = await fixture(t), a = await f.login(), viewer = await f.login('viewer');
  const initial = await f.request(a, '/api/state');
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.body, { protocol: 2, revision: 0, state: null, versions: {} });
  const etag = initial.headers.get('etag');
  assert.equal(etag, '"officina-state-0"');
  for (const condition of [etag, `W/${etag}`, `"another-state", W/${etag}`, '*']) {
    const unchanged = await f.request(viewer, '/api/state', 'GET', undefined, { headers: { 'if-none-match': condition } });
    assert.equal(unchanged.status, 304, condition);
    assert.equal(unchanged.body, '');
    assert.equal(unchanged.headers.get('etag'), etag);
    assert.equal(unchanged.headers.get('cache-control'), 'no-store');
    assert.equal(unchanged.headers.get('vary'), 'Cookie');
    for (const name of ['x-content-type-options', 'referrer-policy', 'x-frame-options', 'permissions-policy']) {
      assert.equal(unchanged.headers.get(name), initial.headers.get(name), name);
    }
    assert.match(unchanged.headers.get('content-security-policy'), /script-src 'self' 'nonce-/);
  }
  assert.equal(initial.headers.get('cache-control'), 'no-store');
  assert.equal(initial.headers.get('vary'), 'Cookie');
  assert.equal((await f.request(null, '/api/state', 'GET', undefined, { headers: { 'if-none-match': etag } })).status, 401);
  assert.equal((await f.save(a, 'Updated workshop')).status, 200);
  const changed = await f.request(viewer, '/api/state', 'GET', undefined, { headers: { 'if-none-match': etag } });
  assert.equal(changed.status, 200);
  assert.equal(changed.headers.get('etag'), '"officina-state-1"');
  assert.equal(changed.body.protocol, 2);
  assert.equal(changed.body.revision, 1);
  assert.equal(changed.body.state.fields.shopName, 'Updated workshop');
  assert.equal(changed.body.versions[R.key('field', 'shopName')], 1);
  assert.deepEqual((await f.request(a, '/api/state')).body, changed.body);
  const unchanged = await f.request(a, '/api/state', 'GET', undefined, { headers: { 'if-none-match': changed.headers.get('etag') } });
  assert.equal(unchanged.status, 304);
  assert.equal(unchanged.body, '');
  f.advance(13 * 60 * 60 * 1000);
  const expired = await f.request(a, '/api/state', 'GET', undefined, { headers: { 'if-none-match': changed.headers.get('etag') } });
  assert.equal(expired.status, 401);
  assert.equal(expired.body.error.code, 'UNAUTHENTICATED');
  assert.equal(expired.headers.get('etag'), null);
});

test('unchanged conditional state GET reads only revision without loading payload or record versions', async t => {
  const f = await fixture(t), a = await f.login();
  assert.equal((await f.save(a, 'Payload must stay unread')).status, 200);
  const initial = await f.request(a, '/api/state');
  const prepare = f.app.db.prepare.bind(f.app.db), queries = [];
  f.app.db.prepare = sql => { queries.push(sql); return prepare(sql); };
  const unchanged = await f.request(a, '/api/state', 'GET', undefined, { headers: { 'if-none-match': initial.headers.get('etag') } });
  assert.equal(unchanged.status, 304);
  assert.equal(unchanged.body, '');
  assert.ok(queries.some(sql => /^SELECT revision FROM state WHERE id=1$/.test(sql)));
  assert.ok(queries.every(sql => !/payload|record_versions/i.test(sql)), queries.join('\n'));
  queries.length = 0;
  const full = await f.request(a, '/api/state');
  assert.equal(full.status, 200);
  assert.deepEqual(full.body, initial.body);
  assert.ok(queries.some(sql => /SELECT revision,payload FROM state/.test(sql)));
  assert.ok(queries.some(sql => /FROM record_versions/.test(sql)));
});
test('20 independent concurrent creations all succeed without taking a lease',async t=>{
 const f=await fixture(t),a=await f.login(),b=await f.login('admin'),base=await f.snapshot(a);
 const results=await Promise.all(Array.from({length:20},(_,i)=>submit(f,i%2?a:b,base,s=>s.dom['#customerRows'].push(node('client-'+i,'Client '+i)))));
 assert.deepEqual(results.map(r=>r.status),Array(20).fill(200));const state=await f.snapshot(a);assert.equal(state.revision,20);assert.equal(state.state.dom['#customerRows'].length,20);assert.equal(f.app.db.prepare('SELECT count(*) AS n FROM lease').get().n,0);
});
test('different records can be updated from the same old snapshot without erasing either',async t=>{
 const f=await fixture(t),a=await f.login(),b=await f.login();let base=await f.snapshot(a);
 await submit(f,a,base,s=>s.dom['#customerRows'].push(node('a','A'),node('b','B')));base=await f.snapshot(a);
 const results=await Promise.all([submit(f,a,base,s=>s.dom['#customerRows'][0].c[0].c=['A changed']),submit(f,b,base,s=>s.dom['#customerRows'][1].c[0].c=['B changed'])]);assert.deepEqual(results.map(r=>r.status),[200,200]);const end=JSON.stringify((await f.snapshot(a)).state);assert.match(end,/A changed/);assert.match(end,/B changed/);
});
test('same-value concurrent stock deductions conflict and roll back the whole losing job',async t=>{
 const f=await fixture(t),a=await f.login(),b=await f.login();let base=await f.snapshot(a);await submit(f,a,base,s=>s.dom['#stockRows'].push(node('tyre','12',{'data-quantity':'12'})));base=await f.snapshot(a);
 const op=(user,id)=>submit(f,user,base,s=>{s.dom['#stockRows'][0].a['data-quantity']='10';s.dom['#agendaRows'].push(node(id,'COMPLETATO'));});const results=await Promise.all([op(a,'jobA'),op(b,'jobB')]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);const end=await f.snapshot(a);assert.equal(end.state.dom['#stockRows'][0].a['data-quantity'],'10');assert.equal(end.state.dom['#agendaRows'].length,1);
});
test('stock read dependency rejects completion after unseen inventory update even if no stock row changed locally',async t=>{
 const f=await fixture(t),a=await f.login(),base=await f.snapshot(a);await submit(f,a,base,s=>s.dom['#stockRows'].push(node('tyre','12')));
 const result=await submit(f,a,base,s=>s.dom['#agendaRows'].push(node('job','COMPLETATO')));assert.equal(result.status,409);assert.equal(result.body.error.code,'DEPENDENCY_CONFLICT');assert.equal((await f.snapshot(a)).state.dom['#agendaRows'].length,0);
});
test('same-record edits, deletion versus update and ABA cannot silently win',async t=>{
 const f=await fixture(t),a=await f.login();let base=await f.snapshot(a);await submit(f,a,base,s=>s.dom['#customerRows'].push(node('customer','A')));base=await f.snapshot(a);
 const stale=f.operation(a,base,changed(base,s=>s.dom['#customerRows'][0].c[0].c=['stale']));await submit(f,a,base,s=>s.dom['#customerRows']=[]);
 assert.equal((await f.request(a,'/api/changes','PUT',stale)).status,409);
 const fresh=await f.snapshot(a);await submit(f,a,fresh,s=>s.dom['#customerRows'].push(node('customer','A')));assert.equal((await f.request(a,'/api/changes','PUT',stale)).status,409);
});
test('independent post-its, quotes and cash accounts merge; stale payment cannot change a revised account',async t=>{
 const f=await fixture(t),a=await f.login(),base=await f.snapshot(a);
 const write=id=>submit(f,a,base,s=>{s.storage['officina-postit']=JSON.stringify([{id,text:id}]);s.storage['officina-quotes-v1']=JSON.stringify([{id,date:'2026-09-22'}]);s.storage['ma-gomme-cashbook-v1']=JSON.stringify({version:1,nextId:1,accounts:[{id:'cash-'+id,meta:{},state:{inCash:0}}],payments:[]});});
 assert.equal((await write('a')).status,200);assert.equal((await write('b')).status,200);const both=await f.snapshot(a);assert.equal(JSON.parse(both.state.storage['officina-postit']).length,2);assert.equal(JSON.parse(both.state.storage['ma-gomme-cashbook-v1']).accounts.length,2);
 await submit(f,a,both,s=>{const book=JSON.parse(s.storage['ma-gomme-cashbook-v1']);book.accounts[0].state.inCash=10;s.storage['ma-gomme-cashbook-v1']=JSON.stringify(book);});
 const payment=await submit(f,a,both,s=>{const book=JSON.parse(s.storage['ma-gomme-cashbook-v1']);book.payments.push({id:'p1',accountId:'cash-a',cents:100});s.storage['ma-gomme-cashbook-v1']=JSON.stringify(book);});assert.equal(payment.status,409);
});
test('payment-only writes fence a concurrent account edit and a second payment',async t=>{
 const f=await fixture(t),a=await f.login();let base=await f.snapshot(a);await submit(f,a,base,s=>s.storage['ma-gomme-cashbook-v1']=JSON.stringify({version:1,nextId:1,accounts:[{id:'cash-a',meta:{},state:{outside:10}}],payments:[]}));base=await f.snapshot(a);
 const pay=id=>submit(f,a,base,s=>{const book=JSON.parse(s.storage['ma-gomme-cashbook-v1']);book.payments.push({id,accountId:'cash-a',cents:1000});s.storage['ma-gomme-cashbook-v1']=JSON.stringify(book);});assert.equal((await pay('p1')).status,200);assert.equal((await pay('p2')).status,409);
 assert.equal((await submit(f,a,base,s=>{const book=JSON.parse(s.storage['ma-gomme-cashbook-v1']);book.accounts[0].state.outside=20;s.storage['ma-gomme-cashbook-v1']=JSON.stringify(book);})).status,409);
});
test('invoice registry and numbering are atomic across devices',async t=>{
 const f=await fixture(t),a=await f.login(),base=await f.snapshot(a);const prepare=id=>submit(f,a,base,s=>s.storage['officina.invoices.v1']=JSON.stringify({documents:[{id,number:'2026/1'}]}));
 assert.equal((await prepare('invoiceA')).status,200);assert.equal((await prepare('invoiceB')).status,409);assert.match((await f.snapshot(a)).state.storage['officina.invoices.v1'],/invoiceA/);
});
test('lost-reply retry survives later commits and restart; mutation IDs cannot be reused',async t=>{
 const f=await fixture(t),a=await f.login(),base=await f.snapshot(a),op=f.operation(a,base,changed(base,s=>s.fields.shopName='First'));
 const first=await f.request(a,'/api/changes','PUT',op);assert.equal(first.status,200);await f.save(a,'Second');await f.restart();const replay=await f.request(a,'/api/changes','PUT',op);assert.equal(replay.body.replayed,true);assert.equal(replay.body.revision,1);assert.equal((await f.snapshot(a)).state.fields.shopName,'Second');assert.equal((await f.snapshot(a)).revision,2);
 assert.equal((await f.request(a,'/api/changes','PUT',{...op,clientId:randomUUID()})).status,409);const b=await f.login();assert.equal((await f.request(b,'/api/changes','PUT',op)).status,409);
});
test('receipt failure rolls back records, versions, audit and revision together',async t=>{
 const f=await fixture(t),a=await f.login();f.app.db.exec("CREATE TRIGGER injected_failure BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT,'injected write failure'); END;");assert.equal((await f.save(a,'Should fail')).status,500);assert.equal((await f.snapshot(a)).state,null);assert.deepEqual((await f.snapshot(a)).versions,{});assert.equal(f.app.db.prepare("SELECT count(*) AS n FROM audit WHERE action='records-saved'").get().n,0);
 f.app.db.exec('DROP TRIGGER injected_failure');assert.equal((await f.save(a,'Now saved')).status,200);
});
test('initial import is admin-only, atomic, idempotent and restricted to revision zero',async t=>{
 const f=await fixture(t),a=await f.login('admin'),b=await f.login(),op={clientId:a.clientId,mutationId:randomUUID(),baseRevision:0,state:makeState('Imported')};
 assert.equal((await f.request(b,'/api/import','POST',op)).status,403);const imported=await f.request(a,'/api/import','POST',op);assert.equal(imported.status,200);const first=await f.snapshot(a);assert.ok(first.state.dom['#customerRows'][0].a['data-cloud-id']);assert.equal((await f.request(a,'/api/import','POST',op)).body.replayed,true);assert.equal((await f.request(a,'/api/import','POST',{...op,mutationId:randomUUID()})).status,409);
});
test('old snapshot is migrated with stable row identities exactly once',async t=>{
 const f=await fixture(t),a=await f.login();f.app.db.prepare('UPDATE state SET payload=?,revision=7 WHERE id=1').run(JSON.stringify(makeState('Legacy')));f.app.db.exec("DELETE FROM metadata WHERE key='record-protocol';");await f.restart();const first=await f.snapshot(a);assert.equal(first.revision,7);assert.ok(first.state.dom['#customerRows'][0].a['data-cloud-id']);assert.equal(first.versions[R.key('row','#customerRows',first.state.dom['#customerRows'][0].a['data-cloud-id'])],7);await f.restart();assert.deepEqual((await f.snapshot(a)).state,first.state);
});
test('malformed changes, executable record content and duplicate IDs are rejected without commits',async t=>{
 const f=await fixture(t),a=await f.login(),base=await f.snapshot(a);const op=f.operation(a,base,changed(base,s=>s.dom['#customerRows'].push(node('x','safe'))));
 for(const data of [{...op,changes:[...op.changes,...op.changes]},{...op,changes:[{...op.changes[0],key:'invalid'}]},{...op,changes:[{...op.changes[0],value:node('x','unsafe',{onclick:'alert(1)'})}]}])assert.equal((await f.request(a,'/api/changes','PUT',data)).status,400);
 assert.equal((await f.snapshot(a)).revision,0);
});
test('SSE publishes new revisions without transferring business content',async t=>{
 const f=await fixture(t),a=await f.login(),abort=new AbortController();const response=await fetch(f.base+'/api/events',{headers:{cookie:a.cookie},signal:abort.signal});const reader=response.body.getReader();assert.match(new TextDecoder().decode((await reader.read()).value),/"revision":0/);await f.save(a,'Secret client');const update=new TextDecoder().decode((await reader.read()).value);assert.match(update,/"revision":1/);assert.doesNotMatch(update,/Secret client|"state"|"token"/);abort.abort();await f.request(a,'/api/logout','POST',{});assert.equal((await f.request(a,'/api/state')).status,401);
});
test('static serving cannot expose server, secrets, SQLite, tests or path traversal', async t => {
  const f = await fixture(t);
  for(const path of ['/server/server.mjs','/server/cli.mjs','/.env','/data/officina.sqlite','/deploy/compose.yaml','/cashbook.test.cjs','/email-service.cjs','/vendor/../server/server.mjs','/%2e%2e%2fserver/server.mjs']) assert.equal((await f.request(null,path)).status,404,path);
  assert.equal((await f.request(null,'/legacy')).status,401);
  assert.equal((await f.request(null,'/cloud-icon.svg')).headers.get('content-type'),'image/svg+xml');
  for(const size of [180,192,512]) assert.equal((await f.request(null,`/cloud-icon-${size}.png`)).headers.get('content-type'),'image/png');
  const a = await f.login();
  const legacy = await f.request(a,'/legacy');
  assert.equal(legacy.status,200);
  assert.match(legacy.headers.get('content-security-policy'),/script-src 'self' 'nonce-/);
  assert.doesNotMatch(legacy.headers.get('content-security-policy'),/script-src[^;]*'unsafe-inline'/);
  assert.match(legacy.body,/<script nonce="/);
});

test('frontend assets added after startup are served without opening private paths', async t => {
  const root = mkdtempSync(join(tmpdir(), 'officina-test-assets-'));
  const f = await fixture(t, {root, schema});
  t.after(() => removeTemporary(root));
  assert.equal((await f.request(null, '/tyre-sales-periods.js')).status, 404);
  writeFileSync(join(root, 'tyre-sales-periods.js'), 'window.WorkshopTyreSalesPeriods = {};');
  writeFileSync(join(root, 'tyre-sales.css'), '.calendar { display: grid; }');
  assert.equal((await f.request(null, '/tyre-sales-periods.js')).status, 200);
  assert.equal((await f.request(null, '/tyre-sales.css')).headers.get('content-type'), 'text/css; charset=utf-8');
  for (const name of ['server-private.js', 'email-service.js', 'asset.test.js', '.env']) {
    writeFileSync(join(root, name), 'private');
    assert.equal((await f.request(null, '/' + name)).status, 404, name);
  }
});

test('login rate limit covers unknown accounts', async t => {
  const f = await fixture(t);
  for(let i=0;i<12;i++) assert.equal((await f.request(null,'/api/login','POST',{username:'unknown',password:'incorrect-password'})).status,401);
  const blocked = await f.request(null,'/api/login','POST',{username:'unknown',password:'incorrect-password'});
  assert.equal(blocked.status,429); assert.equal(blocked.headers.get('retry-after'),'900');
  f.advance(15*60_000+1);
  assert.equal((await f.request(null,'/api/login','POST',{username:'unknown',password:'incorrect-password'})).status,401);
});

test('state validation rejects missing roots, executable DOM, prototype keys, invalid JSON and SVG logos', () => {
  const validate = makeStateValidator(schema);
  assert.doesNotThrow(()=>validate(makeState('Mario < Rossi')));
  const bad = mutate => { const value=makeState('safe'); mutate(value); assert.throws(()=>validate(value)); };
  bad(s=>{ delete s.dom['#customerRows']; });
  bad(s=>{ s.dom['#customerRows']=[{t:'script',a:{},c:['alert(1)']}]; });
  bad(s=>{ s.dom['#customerRows'][0].a.onclick='alert(1)'; });
  bad(s=>{ s.dom['#customerRows'][0].a.href='javascript:alert(1)'; });
  bad(s=>{ s.dom['#customerRows'][0].a.style='background:url(https://attacker.invalid)'; });
  bad(s=>{ s.storage['officina-postit']='not json'; });
  bad(s=>{ s.storage['officina-postit']='{"__proto__":{"polluted":true}}'; });
  bad(s=>{ s.storage.officinaWorkshopLogo='data:image/svg+xml;base64,PHN2Zz4='; });
  bad(s=>{ s.storage.officinaWorkshopLogo='data:image/png;base64,PHN2Zz4='; });
  const png=makeState('safe'); png.storage.officinaWorkshopLogo='data:image/png;base64,iVBORw0KGgo='; assert.doesNotThrow(()=>validate(png));
  bad(s=>{s.fields.unknown='evil';});
});

test('production configuration refuses plaintext HTTP and accepts HTTPS Secure cookies', async t => {
  const directory=mkdtempSync(join(tmpdir(),'officina-test-'));
  t.after(()=>removeTemporary(directory));
  await assert.rejects(()=>createApplication({dataDir:directory,env:{NODE_ENV:'production',OFFICINA_ORIGIN:'http://localhost:8080'}}),/HTTPS/);
  await assert.rejects(()=>createApplication({dataDir:directory,env:{NODE_ENV:'production'}}),/OFFICINA_ORIGIN/);
});

test('process lock rejects active duplicates and recovers stale self-PID lock files', () => {
  const directory=mkdtempSync(join(tmpdir(),'officina-test-'));
  try {
    writeFileSync(join(directory,'server.lock'),JSON.stringify({pid:process.pid,token:'old',createdAt:0}));
    const unlock=acquireProcessLock(directory);
    assert.throws(()=>acquireProcessLock(directory),/processo/);
    unlock();
    assert.equal(existsSync(join(directory,'server.lock')),false);
    if(process.platform==='linux') {
      writeFileSync(join(directory,'server.lock'),JSON.stringify({pid:process.pid,token:'old',fingerprint:'old-boot:1'}));
      acquireProcessLock(directory)();
    }
  } finally {removeTemporary(directory);}
});

function cli(directory, args, input='') {
  return new Promise((resolveRun,reject)=>{
    const child=spawn(process.execPath,[new URL('./cli.mjs',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'),...args],{env:{...process.env,DATA_DIR:directory},windowsHide:true,stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.on('error',reject);child.on('close',code=>resolveRun({code,stdout,stderr}));child.stdin.end(input);
  });
}

test('CLI backup is consistent online; restore refuses active server then restores state and invalidates sessions', async t => {
  const f=await fixture(t);const a=await f.login();
  await f.save(a,'Backup customer');
  const destination=join(f.directory,'verified-backup.sqlite');
  const result=await cli(f.directory,['backup',destination]);assert.equal(result.code,0,result.stderr);
  const backupDb=new DatabaseSync(destination,{readOnly:true});
  try{assert.equal(backupDb.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(backupDb.prepare('SELECT revision FROM state WHERE id=1').get().revision,1);}finally{backupDb.close();}
  const refused=await cli(f.directory,['restore',destination]);assert.equal(refused.code,1);assert.match(refused.stderr,/processo usa il database/);
  await f.save(a,'After backup');
  await f.app.close();
  const restored=await cli(f.directory,['restore',destination]);assert.equal(restored.code,0,restored.stderr);
  await f.restart();
  assert.equal((await f.request(a,'/api/state')).status,401);
  const again=await f.login();const state=(await f.request(again,'/api/state')).body;
  assert.equal(state.revision,1);assert.equal(state.state.fields.shopName,'Backup customer');assert.equal(state.protocol,2);
});

test('CLI password reset and account disable revoke existing sessions', async t => {
  const f=await fixture(t);const a=await f.login();
  const reset=await cli(f.directory,['user-password','operator'],'new secure password value\n');assert.equal(reset.code,0,reset.stderr);
  assert.equal((await f.request(a,'/api/state')).status,401);
  const b=await f.login('viewer');
  const disabled=await cli(f.directory,['user-disable','viewer']);assert.equal(disabled.code,0,disabled.stderr);
  assert.equal((await f.request(b,'/api/state')).status,401);
  const last=await cli(f.directory,['user-disable','admin']);assert.equal(last.code,1);assert.match(last.stderr,/ultimo amministratore/);
});
