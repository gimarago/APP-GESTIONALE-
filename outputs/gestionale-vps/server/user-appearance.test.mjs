import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import { openDatabase } from './database.mjs';
import { appearanceStore } from './user-appearance.mjs';
import { createApplication } from './server.mjs';
import { addUser } from './database.mjs';

const defaults={theme:'graphite',primary:'#285462',accent:'#64d8ef'};
const aurora={theme:'aurora',primary:'#693589',accent:'#c8adff'};
const classic={theme:'classic',primary:'#143d32',accent:'#d9fc52'};
function cleanup(directory){const absolute=resolve(directory);assert.ok(absolute.startsWith(resolve(tmpdir())+sep)&&basename(absolute).startsWith('officina-appearance-'));rmSync(absolute,{recursive:true,force:true});}
function fixture(t){
  const directory=mkdtempSync(join(tmpdir(),'officina-appearance-'));
  let db=openDatabase(directory),store=appearanceStore(db,()=>123456789);
  const users=['admin','operator','viewer'].map((role,index)=>{
    const id=index+1;db.prepare('INSERT INTO users(id,username,password_hash,role,created_at) VALUES(?,?,?,?,?)').run(id,role,'test',role,1);return {id,role};
  });
  t.after(()=>{db.close();cleanup(directory);});
  return {get db(){return db;},get store(){return store;},users,restart(){db.close();db=openDatabase(directory);store=appearanceStore(db);}};
}
test('appearance is isolated per account and never mutates workshop data or revisions',t=>{
  const f=fixture(t),before=f.db.prepare('SELECT * FROM state').get();
  for(const user of f.users)assert.deepEqual(f.store.read(user),defaults);
  f.store.save(f.users[0],aurora);f.store.save(f.users[1],classic);
  assert.deepEqual(f.store.read(f.users[0]),aurora);assert.deepEqual(f.store.read(f.users[1]),classic);assert.deepEqual(f.store.read(f.users[2]),defaults);
  assert.deepEqual(f.db.prepare('SELECT * FROM state').get(),before);assert.equal(f.db.prepare('SELECT count(*) AS count FROM record_versions').get().count,0);
});
test('themes and customized colors survive database reopen for all roles',t=>{
  const f=fixture(t),custom={theme:'classic',primary:'#AABBCC',accent:'#123ABC'};
  f.store.save(f.users[2],custom);f.restart();
  assert.deepEqual(f.store.read(f.users[2]),{theme:'classic',primary:'#aabbcc',accent:'#123abc'});
  assert.deepEqual(f.store.read(f.users[0]),defaults);
});
test('appearance saves validate allowed themes, exact colors and user identity',t=>{
  const f=fixture(t),auth=f.users[0];
  for(const value of [null,[],{}, {...aurora,theme:'other'},{...aurora,primary:'red'},{...aurora,primary:'#fff'},{...aurora,accent:'url(https://bad.test)'},{...aurora,user_id:2}]){
    assert.throws(()=>f.store.save(auth,value),error=>error.status===400&&error.code==='INVALID_APPEARANCE');
  }
  assert.throws(()=>f.store.save(null,aurora),error=>error.status===401);
  assert.throws(()=>f.store.read({id:'1'}),error=>error.status===401);
  assert.equal(f.db.prepare('SELECT count(*) AS count FROM user_appearance').get().count,0);
});
test('removing an account also removes its appearance',t=>{
  const f=fixture(t);f.store.save(f.users[0],aurora);f.db.prepare('DELETE FROM users WHERE id=?').run(f.users[0].id);
  assert.equal(f.db.prepare('SELECT count(*) AS count FROM user_appearance').get().count,0);
});

test('authenticated appearance API supports viewers, enforces CSRF and returns preferences at login',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'officina-appearance-')),origin='http://appearance.example.test';
  const app=await createApplication({dataDir:directory,origin,env:{NODE_ENV:'test'}});
  for(const role of ['admin','viewer'])await addUser(app.db,role,'test-password-1234',role);
  await new Promise(ok=>app.server.listen(0,'127.0.0.1',ok));
  const base='http://127.0.0.1:'+app.server.address().port;
  t.after(async()=>{await app.close();cleanup(directory);});
  async function request(path,method='GET',payload,session,extra={}){
    const response=await fetch(base+path,{method,headers:{...(session?.cookie?{cookie:session.cookie}:{}),...(method==='GET'?{}:{origin,'content-type':'application/json','x-csrf-token':session?.csrf||''}),...extra},...(payload?{body:JSON.stringify(payload)}:{})});
    return {status:response.status,body:await response.json(),headers:response.headers};
  }
  async function login(username){const result=await request('/api/login','POST',{username,password:'test-password-1234'});assert.equal(result.status,200);return {cookie:result.headers.get('set-cookie').split(';')[0],csrf:result.body.csrf,result:result.body};}
  assert.equal((await request('/api/appearance')).status,401);
  const viewer=await login('viewer'),admin=await login('admin');
  assert.deepEqual(viewer.result.appearance,defaults);
  assert.equal((await request('/api/appearance','PUT',aurora,viewer,{'x-csrf-token':'wrong'})).status,403);
  assert.equal((await request('/api/appearance','PUT',aurora,viewer,{origin:'http://attacker.invalid'})).status,403);
  assert.equal((await request('/api/appearance','PUT',{...aurora,accent:'#fff'},viewer)).status,400);
  assert.equal((await request('/api/appearance','PUT',aurora,viewer)).status,200);
  const result=(await request('/api/appearance','GET',null,viewer)).body;assert.deepEqual(result.appearance||result,aurora);
  const other=(await request('/api/appearance','GET',null,admin)).body;assert.deepEqual(other.appearance||other,defaults);
  assert.deepEqual((await request('/api/session','GET',null,viewer)).body.appearance,aurora);
  assert.deepEqual((await login('viewer')).result.appearance,aurora);
  assert.equal(app.db.prepare('SELECT revision FROM state WHERE id=1').get().revision,0);
});
