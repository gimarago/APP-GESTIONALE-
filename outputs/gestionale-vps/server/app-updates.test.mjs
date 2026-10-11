import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, unlinkSync, truncateSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, sep, basename } from 'node:path';
import { createAppUpdateHandler, validUpdateSignature, APP_UPDATE_PATH, APP_UPDATE_UNAVAILABLE, MAX_UPDATE_ARTIFACT_BYTES, MAX_UPDATE_MANIFEST_BYTES } from './app-updates.mjs';
import { createApplication } from './server.mjs';

const ORIGIN = 'https://api.magomme.it';
const NAME = 'Officina-Windows-1.0.3-setup.exe';
const ARTIFACT = Buffer.from('MZ synthetic signed installer bytes - no executable test payload');
const signatureText = () => {
  const local = Buffer.alloc(74);local.write('ED');local.writeBigUInt64LE(42n,2);
  return 'untrusted comment: signature from tauri secret key\n'+local.toString('base64')+'\ntrusted comment: timestamp:1760133600 file:'+NAME+'\n'+Buffer.alloc(64,7).toString('base64')+'\n';
};
const SIGNATURE = Buffer.from(signatureText()).toString('base64');
const manifest = (patch = {}) => ({version:'1.0.3',notes:'Aggiornamento dell’app\nFirma verificata dal launcher.',pub_date:'2026-10-11T12:00:00Z',platforms:{'windows-x86_64':{url:ORIGIN+APP_UPDATE_PATH+NAME,signature:SIGNATURE}},...patch});

function removeTemporary(directory) {
  const absolute = resolve(directory);
  if (!absolute.startsWith(resolve(tmpdir())+sep) || !basename(absolute).startsWith('officina-update-test-')) throw Error('Refusing unsafe test cleanup');
  rmSync(absolute,{recursive:true,force:true});
}
async function fixture(t, {publish = true, origin = ORIGIN, allowHttp = false} = {}) {
  const directory = mkdtempSync(join(tmpdir(),'officina-update-test-')),releaseDir = join(directory,'releases');
  mkdirSync(releaseDir);
  const latest = value => writeFileSync(join(releaseDir,'latest.json'),JSON.stringify(value));
  const put = (name,value) => writeFileSync(join(releaseDir,name),value);
  if (publish) {put(NAME,ARTIFACT);latest(manifest());}
  const handler = createAppUpdateHandler({releaseDir,origin,allowHttp});
  const server = http.createServer(async (req,res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url,origin).pathname);
      if (!await handler(req,res,pathname)) res.writeHead(404).end();
    } catch {res.writeHead(400).end();}
  });
  await new Promise(done => server.listen(0,'127.0.0.1',done));
  t.after(async () => {await new Promise(done => server.close(done));removeTemporary(directory);});
  async function request(path = APP_UPDATE_PATH+'latest.json', {method = 'GET',headers = {}} = {}) {
    // Keep the raw path intact so dot/encoded traversal tests reach the server.
    return new Promise((done,reject) => {
      const req = http.request({hostname:'127.0.0.1',port:server.address().port,path,method,headers}, res => {
        const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>done({status:res.statusCode,headers:res.headers,bytes:Buffer.concat(chunks)}));
      });req.on('error',reject);req.end();
    });
  }
  return {directory,releaseDir,latest,put,request};
}

test('Tauri signature metadata uses the canonical base64 encoded minisign text', () => {
  assert.equal(validUpdateSignature(SIGNATURE),true);
  assert.equal(validUpdateSignature(Buffer.from(signatureText().replaceAll('\n','\r\n')).toString('base64')),true);
  for (const value of ['',signatureText(),'not-base64',Buffer.from('untrusted comment: no signature').toString('base64'),SIGNATURE+'=',Buffer.from(signatureText().replace('trusted comment: timestamp','broken comment: timestamp')).toString('base64')]) assert.equal(validUpdateSignature(value),false);
});

test('unpublished or incomplete releases return 503 and never pretend there is no update', async t => {
  const f = await fixture(t,{publish:false});
  for (const path of [APP_UPDATE_PATH+'latest.json',APP_UPDATE_PATH+NAME]) {
    const response = await f.request(path);assert.equal(response.status,503);assert.equal(response.headers['cache-control'],'no-store');
    assert.equal(JSON.parse(response.bytes).error.message,APP_UPDATE_UNAVAILABLE);
  }
  f.latest(manifest());assert.equal((await f.request()).status,503);
  f.put(NAME,'not an executable');assert.equal((await f.request()).status,503);
  f.put(NAME,ARTIFACT);assert.equal((await f.request()).status,200);
  unlinkSync(join(f.releaseDir,'latest.json'));assert.equal((await f.request()).status,503);
});

test('manifest GET and HEAD are public, use no-store, and reread atomic publications', async t => {
  const f = await fixture(t),response = await f.request();
  assert.equal(response.status,200);assert.deepEqual(JSON.parse(response.bytes),manifest());
  assert.equal(response.headers['content-type'],'application/json; charset=utf-8');assert.equal(response.headers['cache-control'],'no-store');
  const head = await f.request(undefined,{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.bytes.length,0);assert.equal(Number(head.headers['content-length']),response.bytes.length);
  const conditional = await f.request(undefined,{headers:{'if-none-match':'*'}});assert.equal(conditional.status,200);
  f.put('latest.json.tmp',JSON.stringify(manifest({version:'1.0.4',notes:'Nuova release'})));renameSync(join(f.releaseDir,'latest.json.tmp'),join(f.releaseDir,'latest.json'));
  assert.equal(JSON.parse((await f.request()).bytes).version,'1.0.4');
});

test('installer streams the active artifact with HEAD, conditional ETag and ranges', async t => {
  const f = await fixture(t),path = APP_UPDATE_PATH+NAME,response = await f.request(path);
  assert.equal(response.status,200);assert.deepEqual(response.bytes,ARTIFACT);assert.equal(Number(response.headers['content-length']),ARTIFACT.length);
  assert.equal(response.headers['content-type'],'application/octet-stream');assert.match(response.headers['content-disposition'],/Officina-Windows-1\.0\.3-setup\.exe/);
  assert.equal(response.headers['x-content-type-options'],'nosniff');assert.equal(response.headers['cache-control'],'public, max-age=31536000, immutable');
  const head = await f.request(path,{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.bytes.length,0);assert.equal(head.headers.etag,response.headers.etag);
  const unchanged = await f.request(path,{headers:{'if-none-match':'W/'+response.headers.etag}});assert.equal(unchanged.status,304);assert.equal(unchanged.bytes.length,0);
  const range = await f.request(path,{headers:{range:'bytes=2-10'}});assert.equal(range.status,206);assert.deepEqual(range.bytes,ARTIFACT.subarray(2,11));assert.equal(range.headers['content-range'],`bytes 2-10/${ARTIFACT.length}`);
  const suffix = await f.request(path,{headers:{range:'bytes=-4'}});assert.equal(suffix.status,206);assert.deepEqual(suffix.bytes,ARTIFACT.subarray(-4));
  const openEnded = await f.request(path,{headers:{range:'bytes=10-'}});assert.equal(openEnded.status,206);assert.deepEqual(openEnded.bytes,ARTIFACT.subarray(10));
  for (const value of ['bytes=999-','bytes=10-2','bytes=-0','bytes=0-1,4-5','bytes=','items=0-5']) {
    const invalid = await f.request(path,{headers:{range:value}});assert.equal(invalid.status,416,value);assert.equal(invalid.headers['content-range'],`bytes */${ARTIFACT.length}`);
  }
  const changed = await f.request(path,{headers:{range:'bytes=2-10','if-range':'"another release"'}});assert.equal(changed.status,200);assert.deepEqual(changed.bytes,ARTIFACT);
});

test('only the exact active installer is served; traversal, metadata and other methods are refused', async t => {
  const f = await fixture(t);f.put('private.key','must not be served');f.put('other.exe',ARTIFACT);f.put(NAME+'.sig',SIGNATURE);
  for (const path of [APP_UPDATE_PATH,APP_UPDATE_PATH+'private.key',APP_UPDATE_PATH+NAME+'.sig',APP_UPDATE_PATH+'other.exe',APP_UPDATE_PATH+'nested/'+NAME,APP_UPDATE_PATH+'../private.key',APP_UPDATE_PATH+'%2e%2e/private.key',APP_UPDATE_PATH+'..%2Fprivate.key',APP_UPDATE_PATH+'..%5cprivate.key',APP_UPDATE_PATH+'%00'+NAME,'/app-updates/other/latest.json']) {
    assert.equal((await f.request(path)).status,404,path);
  }
  for (const method of ['POST','PUT','DELETE']) {const response=await f.request(undefined,{method});assert.equal(response.status,405);assert.equal(response.headers.allow,'GET, HEAD');}
});

test('malformed release metadata, unsafe URL origins and excessive files remain unavailable', async t => {
  const f = await fixture(t),target = manifest().platforms['windows-x86_64'];
  const patches = [{version:'01.0.3'},{version:'1.0'},{version:'1.0.3-01'},{version:'1.0.3<script>'},{notes:null},{notes:'a'.repeat(32*1024+1)},{pub_date:'2026-02-31T12:00:00Z'},{pub_date:'yesterday'},{pub_date:'2026-10-11T25:00:00Z'},{platforms:{}},{platforms:{'windows-x86_64':{...target,signature:'invalid'}}}];
  for (const url of ['https://evil.invalid'+APP_UPDATE_PATH+NAME,'http://api.magomme.it'+APP_UPDATE_PATH+NAME,ORIGIN+'/other/'+NAME,ORIGIN+APP_UPDATE_PATH+'../'+NAME,ORIGIN+APP_UPDATE_PATH+NAME+'?token=secret',ORIGIN+APP_UPDATE_PATH+NAME+'#fragment','https://user:password@api.magomme.it'+APP_UPDATE_PATH+NAME,ORIGIN+APP_UPDATE_PATH+'private.key']) patches.push({platforms:{'windows-x86_64':{...target,url}}});
  for (const patch of patches) {f.latest(manifest(patch));const response=await f.request();assert.equal(response.status,503,JSON.stringify(patch));assert.equal(JSON.parse(response.bytes).error.message,APP_UPDATE_UNAVAILABLE);}
  f.latest(manifest({version:'1.0.3-beta.1+build.7'}));assert.equal((await f.request()).status,200);
  f.put('latest.json',' '.repeat(MAX_UPDATE_MANIFEST_BYTES+1));assert.equal((await f.request()).status,503);
  f.latest(manifest());truncateSync(join(f.releaseDir,NAME),MAX_UPDATE_ARTIFACT_BYTES+1);assert.equal((await f.request()).status,503);
});

test('test HTTP origin is permitted only by an explicit handler option', async t => {
  const origin = 'http://localhost:8080';
  const rejected = await fixture(t,{origin});rejected.latest(manifest({platforms:{'windows-x86_64':{url:origin+APP_UPDATE_PATH+NAME,signature:SIGNATURE}}}));assert.equal((await rejected.request()).status,503);
  const allowed = await fixture(t,{origin,allowHttp:true});allowed.latest(manifest({platforms:{'windows-x86_64':{url:origin+APP_UPDATE_PATH+NAME,signature:SIGNATURE}}}));assert.equal((await allowed.request()).status,200);
});

test('symlink artifacts and manifests cannot expose files outside the release directory', async t => {
  const f = await fixture(t),outside = join(f.directory,'outside.exe');writeFileSync(outside,ARTIFACT);unlinkSync(join(f.releaseDir,NAME));
  try {symlinkSync(outside,join(f.releaseDir,NAME),'file');} catch (error) {if (['EPERM','EACCES','ENOTSUP'].includes(error.code)) {t.skip('Creating symlinks is unavailable in this environment');return;}throw error;}
  assert.equal((await f.request()).status,503);assert.equal((await f.request(APP_UPDATE_PATH+NAME)).status,503);
  unlinkSync(join(f.releaseDir,NAME));f.put(NAME,ARTIFACT);const metadata = join(f.directory,'outside.json');writeFileSync(metadata,JSON.stringify(manifest()));unlinkSync(join(f.releaseDir,'latest.json'));symlinkSync(metadata,join(f.releaseDir,'latest.json'),'file');assert.equal((await f.request()).status,503);
});

test('application routes are available before login and use the configured release directory', async t => {
  const directory = mkdtempSync(join(tmpdir(),'officina-update-test-')),releaseDir = join(directory,'publication');mkdirSync(releaseDir);
  writeFileSync(join(releaseDir,NAME),ARTIFACT);writeFileSync(join(releaseDir,'latest.json'),JSON.stringify(manifest()));
  const app = await createApplication({dataDir:join(directory,'data'),origin:ORIGIN,env:{NODE_ENV:'test',OFFICINA_APP_UPDATES_DIR:releaseDir}});
  await new Promise(done=>app.server.listen(0,'127.0.0.1',done));t.after(async()=>{await app.close();removeTemporary(directory);});
  const base='http://127.0.0.1:'+app.server.address().port;
  const metadata=await fetch(base+APP_UPDATE_PATH+'latest.json');assert.equal(metadata.status,200);assert.deepEqual(await metadata.json(),manifest());assert.equal(metadata.headers.get('cache-control'),'no-store');assert.equal(metadata.headers.get('x-content-type-options'),'nosniff');
  assert.equal((await fetch(base+APP_UPDATE_PATH+NAME,{method:'HEAD'})).status,200);
  assert.equal((await fetch(base+APP_UPDATE_PATH+'latest.json',{method:'POST'})).status,405);
  assert.equal((await fetch(base+'/api/state')).status,401,'ordinary private APIs still require authentication');
  const badPath=await new Promise((done,reject)=>{const req=http.request({hostname:'127.0.0.1',port:app.server.address().port,path:APP_UPDATE_PATH+'%zz'},res=>{res.resume();res.on('end',()=>done(res.statusCode));});req.on('error',reject);req.end();});assert.equal(badPath,400);
});
