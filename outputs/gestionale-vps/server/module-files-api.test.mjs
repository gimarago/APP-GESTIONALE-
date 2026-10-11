import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {createApplication} from './server.mjs';
import {addUser} from './database.mjs';
const R=createRequire(import.meta.url)('../cloud-records.js');
async function fixture(t){
 const dataDir=mkdtempSync(join(tmpdir(),'officina-module-api-')),origin='http://officina.test';
 const app=await createApplication({dataDir,origin,env:{NODE_ENV:'test'}});
 for(const [username,role] of [['files-admin','admin'],['files-operator','operator'],['files-viewer','viewer']])await addUser(app.db,username,'test-password-1234',role);
 await new Promise(ok=>app.server.listen(0,'127.0.0.1',ok));t.after(()=>app.close());
 const url='http://127.0.0.1:'+app.server.address().port;
 async function request(user,path,method='GET',value,headers={}){
  return fetch(url+path,{method,headers:{cookie:user?.cookie||'',...(method!=='GET'?{origin,'x-csrf-token':user?.csrf||'','content-type':'application/json'}:{}),...headers},...(value===undefined?{}:{body:JSON.stringify(value)})});
 }
 async function login(username){const result=await request(null,'/api/login','POST',{username,password:'test-password-1234'});assert.equal(result.status,200);const session=await result.json();return {cookie:result.headers.get('set-cookie').split(';')[0],csrf:session.csrf,session};}
 async function link(user,Attachment,type='privacy'){
  const current=await (await request(user,'/api/state')).json(),state=structuredClone(current.state||R.empty());
  const list=JSON.parse(state.storage['officina-moduli-v1']||'[]');list.push({id:randomUUID(),type,Customer:'Cliente file',Date:'2026-10-05',Attachment});state.storage['officina-moduli-v1']=JSON.stringify(list);
  return request(user,'/api/changes','PUT',{protocol:2,clientId:randomUUID(),mutationId:randomUUID(),versions:current.versions,changes:R.diff(current.state,state,current.versions)});
 }
 return {app,request,login,link};
}
const file=()=>({id:randomUUID(),filename:"Privacy firmata di è' cliente.pdf",contentType:'application/pdf',data:Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF').toString('base64')});
test('module HTTP upload requires login, writer role, same origin and CSRF without changing the shared revision',async t=>{
 const f=await fixture(t),admin=await f.login('files-admin'),viewer=await f.login('files-viewer'),body=file();
 assert.equal((await f.request(null,'/api/module-files','POST',body)).status,401);
 assert.equal((await f.request(viewer,'/api/module-files','POST',body)).status,403);
 assert.equal((await f.request(admin,'/api/module-files','POST',body,{'x-csrf-token':'wrong'})).status,403);
 assert.equal((await f.request(admin,'/api/module-files','POST',body,{origin:'http://other.test'})).status,403);
 const first=await f.request(admin,'/api/module-files','POST',body);assert.equal(first.status,200);const metadata=await first.json();assert.ok(!Object.hasOwn(metadata,'data'));
 assert.deepEqual(await (await f.request(admin,'/api/module-files','POST',body)).json(),metadata);
 assert.equal((await f.request(admin,'/api/module-files','POST',{...body,filename:'Other.pdf'})).status,409);
 assert.equal((await (await f.request(admin,'/api/state')).json()).revision,0);
 assert.equal((await f.request(viewer,`/api/module-files/${metadata.id}/original`)).status,404);
});
test('uploaded originals download only after the shared module link commits and invalid metadata cannot enter the archive',async t=>{
 const f=await fixture(t),operator=await f.login('files-operator'),viewer=await f.login('files-viewer'),body=file();
 const metadata=await (await f.request(operator,'/api/module-files','POST',body)).json();
 assert.equal((await f.link(operator,{...metadata,id:randomUUID()})).status,400);
 assert.equal((await f.link(operator,{...metadata,filename:'forged.pdf'})).status,400);
 assert.equal((await f.link(operator,metadata,'tyres')).status,400);
 assert.equal((await f.link(operator,metadata)).status,200);
 assert.equal((await f.request(null,`/api/module-files/${metadata.id}/original`)).status,401);
 const download=await f.request(viewer,`/api/module-files/${metadata.id}/original`);assert.equal(download.status,200);
 assert.equal(download.headers.get('content-type'),'application/pdf');assert.match(download.headers.get('content-disposition'),/attachment;.*filename\*=UTF-8''.*%C3%A8%27/);
 assert.deepEqual(Buffer.from(await download.arrayBuffer()),Buffer.from(body.data,'base64'));
 const shared=await (await f.request(viewer,'/api/state')).json();assert.ok(JSON.stringify(shared).includes(metadata.id));assert.ok(!JSON.stringify(shared).includes(body.data));
 const current=shared,state=structuredClone(current.state);state.fields.shopPhone='06 5555 0000';
 assert.equal((await f.request(operator,'/api/changes','PUT',{protocol:2,clientId:randomUUID(),mutationId:randomUUID(),versions:current.versions,changes:R.diff(current.state,state,current.versions)})).status,200);
});
test('appearance HTTP is personal to each authenticated user, including viewers, and never writes shared business state',async t=>{
 const f=await fixture(t),admin=await f.login('files-admin'),viewer=await f.login('files-viewer');
 const choice={theme:'aurora',primary:'#123abc',accent:'#abcdef'};
 assert.equal((await f.request(null,'/api/appearance')).status,401);
 assert.equal((await f.request(viewer,'/api/appearance','PUT',choice,{'x-csrf-token':'bad'})).status,403);
 assert.equal((await f.request(viewer,'/api/appearance','PUT',choice,{origin:'http://other.test'})).status,403);
 assert.equal((await f.request(viewer,'/api/appearance','PUT',{...choice,otherUser:admin.session.user.id})).status,400);
 assert.deepEqual(await (await f.request(viewer,'/api/appearance','PUT',choice)).json(),choice);
 assert.deepEqual((await (await f.request(viewer,'/api/session')).json()).appearance,choice);
 assert.equal((await (await f.request(admin,'/api/appearance')).json()).theme,'graphite');
 assert.equal((await (await f.request(admin,'/api/state')).json()).revision,0);
});
