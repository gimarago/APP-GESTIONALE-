import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve,join,sep,basename } from 'node:path';
import { launchLocal,localConfiguration } from './local.mjs';

test('local startup chooses loopback and a data directory separate from production',()=>{
  const config=localConfiguration({LOCALAPPDATA:resolve('work','local-profile'),DATA_DIR:'do-not-use',NODE_ENV:'production'});
  assert.equal(config.origin,'http://127.0.0.1:8080');
  assert.equal(config.dataDir,resolve('work','local-profile','OfficinaGestionale','data'));
  assert.throws(()=>localConfiguration({OFFICINA_LOCAL_PORT:'80'}));
  assert.throws(()=>localConfiguration({OFFICINA_LOCAL_PORT:'bad'}));
});

test('local first run creates a chosen account; restart preserves it and the data',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'officina-local-test-'));
  const env={OFFICINA_LOCAL_DATA_DIR:directory,OFFICINA_LOCAL_PORT:'18129',OFFICINA_NO_BROWSER:'1'};
  const answers=['locale-prova','chosen-local-password','different-confirmation','locale-prova','chosen-local-password','chosen-local-password'];
  const messages=[];let app;
  t.after(async()=>{await app?.close();const checked=resolve(directory);assert.ok(checked.startsWith(resolve(tmpdir())+sep)&&basename(checked).startsWith('officina-local-test-'));rmSync(checked,{recursive:true,force:true});});
  app=await launchLocal({env,prompt:async()=>{assert.ok(answers.length);return answers.shift();},openBrowser:false,log:value=>messages.push(value)});
  assert.equal(app.server.address().address,'127.0.0.1');
  assert.ok(messages.some(value=>value.includes('non coincidono')));
  assert.ok(!messages.join('').includes('chosen-local-password'));
  const login=await fetch(app.settings.origin+'/api/login',{method:'POST',headers:{Origin:app.settings.origin,'Content-Type':'application/json'},body:JSON.stringify({username:'locale-prova',password:'chosen-local-password'})});
  assert.equal(login.status,200);assert.equal((await login.json()).user.role,'admin');
  app.db.prepare('UPDATE state SET revision=9 WHERE id=1').run();
  await app.close();app=null;
  app=await launchLocal({env,prompt:async()=>{throw Error('Account setup must not repeat');},openBrowser:false,log:()=>{}});
  assert.equal(app.db.prepare('SELECT revision FROM state').get().revision,9);
  assert.equal(app.db.prepare('SELECT username FROM users').get().username,'locale-prova');
  assert.equal((await fetch(app.settings.origin+'/api/health')).status,200);
});
