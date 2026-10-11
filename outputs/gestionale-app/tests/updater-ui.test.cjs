'use strict';
const {test, before, after} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const path = require('node:path');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const source = readFileSync(path.join(__dirname, '../src-tauri/updater-ui.js'), 'utf8');
let browser;
before(async () => {browser = await chromium.launch({headless:true, ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {})});});
after(async () => {await browser?.close();});

async function fixture({url='https://api.magomme.it/', platform='desktop', initial={supported:true,currentVersion:'1.0.2',state:'idle'}, host='clean', iframe=false} = {}) {
  const context = await browser.newContext();
  await context.route('**/*', route => route.fulfill({contentType:'text/html', body:
    new URL(route.request().url()).pathname === '/legacy' ? '<!doctype html><html><body><form id="vehicleEditor"><input value="Bozza da conservare"></form></body></html>' :
    '<!doctype html><html lang="it"><head></head><body><main><h1>Officina</h1><button id="retry">Riprova</button></main><header id="cloudBar" hidden><div class="cloud-actions"><button id="more">Gestione</button></div></header><div id="frameHost">' + (iframe ? '<iframe src="/legacy"></iframe>' : '') + '</div></body></html>'}));
  await context.addInitScript(({platform,initial,host}) => {
    window.__OFFICINA_PLATFORM__ = platform;
    const mock = window.updaterMock = {status:initial, calls:[], errors:{}, handlers:{}, deferred:{}, host, fenced:false};
    window.__TAURI__ = {core:{invoke:async (command,args) => {
      mock.calls.push({command,args});
      if (mock.errors[command]) throw mock.errors[command];
      if (mock.handlers[command]) return mock.handlers[command](args);
      if (command === 'updater_check') mock.status={supported:true,currentVersion:'1.0.2',state:'idle',message:'Questa versione è aggiornata.'};
      if (command === 'updater_download') mock.status={...mock.status,state:'ready',message:undefined,downloaded:2048,total:2048};
      if (command === 'updater_install') mock.status={...mock.status,state:'installing',message:undefined};
      return structuredClone(mock.status);
    }}};
    if (host !== 'missing') window.WorkshopCloudHost = {
      async prepareToLeave(options) {
        mock.calls.push({command:'prepareToLeave',args:options});
        if (mock.host === 'dirty') throw new Error('Salva o chiudi la scheda aperta prima di aggiornare l’app.');
        if (mock.host === 'cancel') return false;
        if (mock.host === 'slow') return new Promise(resolve => {mock.deferred.prepare=()=>{mock.fenced=true;resolve(true);};});
        mock.fenced = true;
        return true;
      },
      cancelLeaving() {mock.calls.push({command:'cancelLeaving'}); mock.fenced=false;}
    };
  }, {platform,initial,host});
  await context.addInitScript(source);
  const page = await context.newPage();
  const errors=[];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  if (url.startsWith('https://api.magomme.it') || url.startsWith('http://tauri.localhost')) {
    if (platform === 'desktop') await page.waitForFunction(() => document.getElementById('officinaUpdaterButton'));
  }
  const calls = command => page.evaluate(command => updaterMock.calls.filter(call => call.command === command), command);
  const open = () => page.locator('#officinaUpdaterButton').click();
  return {context,page,errors,calls,open};
}

test('top-frame entry is always reachable; current version and explicit check without automatic downloads', async () => {
  const f = await fixture();
  try {
    await f.open();
    assert.match(await f.page.locator('#officinaUpdaterCurrent').innerText(), /1\.0\.2/);
    assert.equal((await f.calls('updater_check')).length, 0);
    assert.equal((await f.calls('updater_download')).length, 0);
    assert.equal((await f.calls('updater_install')).length, 0);
    await f.page.locator('#officinaUpdaterCheck').click();
    await f.page.locator('#officinaUpdaterMessage').filter({hasText:'Questa versione è aggiornata.'}).waitFor();
    assert.equal((await f.calls('updater_check')).length, 1);
    await f.page.locator('#officinaUpdaterClose').click();
    assert.equal(await f.page.locator('#officinaUpdaterDialog').isVisible(), false);
    assert.equal(await f.page.locator('#officinaUpdaterButton').evaluate(button => document.activeElement === button), true);
    assert.equal(await f.page.locator('#officinaUpdaterButton').evaluate(button => button.classList.contains('officina-updater-floating')), true);
    await f.page.evaluate(() => {document.getElementById('cloudBar').hidden=false;});
    await f.page.waitForFunction(() => document.querySelector('#cloudBar .cloud-actions #officinaUpdaterButton'));
    await f.page.evaluate(() => {document.getElementById('cloudBar').hidden=true;});
    await f.page.waitForFunction(() => document.getElementById('officinaUpdaterButton').classList.contains('officina-updater-floating'));
    assert.deepEqual(f.errors, []);
  } finally {await f.context.close();}
});

test('availability, bounded progress polls, closed panel and duplicate clicks never start duplicate operations', async () => {
  const f = await fixture();
  try {
    await f.open();
    await f.page.evaluate(() => {
      updaterMock.handlers.updater_check = () => new Promise(resolve => {
        updaterMock.status={supported:true,currentVersion:'1.0.2',state:'checking'};
        updaterMock.deferred.check=()=>{updaterMock.status={supported:true,currentVersion:'1.0.2',state:'available',version:'1.0.3'};resolve(updaterMock.status);};
      });
      document.getElementById('officinaUpdaterCheck').click();document.getElementById('officinaUpdaterCheck').click();
    });
    assert.equal((await f.calls('updater_check')).length, 1);
    assert.equal(await f.page.locator('#officinaUpdaterCheck').isDisabled(), true);
    await f.page.evaluate(() => updaterMock.deferred.check());
    await f.page.locator('#officinaUpdaterDownload').waitFor({state:'visible'});
    assert.match(await f.page.locator('#officinaUpdaterVersion').innerText(), /1\.0\.3/);
    assert.equal((await f.calls('updater_download')).length, 0);
    await f.page.evaluate(() => {
      updaterMock.handlers.updater_download=()=>new Promise(resolve=>{
        updaterMock.status={...updaterMock.status,state:'downloading',downloaded:1024,total:2048};
        updaterMock.deferred.download=()=>{updaterMock.status={...updaterMock.status,state:'ready',downloaded:2048};resolve(updaterMock.status);};
      });
      document.getElementById('officinaUpdaterDownload').click();document.getElementById('officinaUpdaterDownload').click();
    });
    await f.page.waitForFunction(() => document.getElementById('officinaUpdaterProgress').value === 50);
    assert.equal((await f.calls('updater_download')).length, 1);
    await f.page.locator('#officinaUpdaterClose').click();
    const readCount=(await f.calls('updater_status')).length;
    await f.page.waitForTimeout(750);
    assert.equal((await f.calls('updater_status')).length, readCount, 'closing stops progress polling');
    await f.open();
    await f.page.evaluate(() => updaterMock.deferred.download());
    await f.page.locator('#officinaUpdaterInstall').waitFor({state:'visible'});
    assert.equal((await f.calls('updater_install')).length, 0, 'download completion does not install automatically');
    assert.deepEqual(f.errors, []);
  } finally {await f.context.close();}
});

test('network failures can be retried and native messages are displayed as text', async () => {
  const f = await fixture();
  try {
    await f.open();
    await f.page.evaluate(() => {updaterMock.errors.updater_check='Errore di rete. Verifica la connessione.';});
    await f.page.locator('#officinaUpdaterCheck').click();
    await f.page.locator('#officinaUpdaterMessage').filter({hasText:'Errore di rete'}).waitFor();
    assert.equal(await f.page.locator('#officinaUpdaterCheck').isEnabled(), true);
    await f.page.evaluate(() => {
      delete updaterMock.errors.updater_check;
      updaterMock.handlers.updater_check=()=>updaterMock.status={supported:true,currentVersion:'1.0.2',state:'available',version:'1.0.3',message:'<img src=x onerror=alert(1)> Aggiornamento disponibile'};
    });
    await f.page.locator('#officinaUpdaterCheck').click();
    await f.page.locator('#officinaUpdaterDownload').waitFor({state:'visible'});
    assert.equal(await f.page.locator('#officinaUpdaterDialog img').count(), 0);
    await f.page.evaluate(() => {updaterMock.errors.updater_download='Download interrotto. Riprova.';});
    await f.page.locator('#officinaUpdaterDownload').click();
    await f.page.locator('#officinaUpdaterDownload').filter({hasText:'Riprova download'}).waitFor();
    await f.page.evaluate(() => {delete updaterMock.errors.updater_download;});
    await f.page.locator('#officinaUpdaterDownload').click();
    await f.page.locator('#officinaUpdaterInstall').waitFor({state:'visible'});
    assert.equal((await f.calls('updater_download')).length, 2);
    assert.equal((await f.calls('updater_install')).length, 0);
    assert.deepEqual(f.errors, []);
  } finally {await f.context.close();}
});

test('install waits for confirmed preparation, is single-shot and preserves the guard when native installation starts', async () => {
  const f = await fixture({iframe:true,initial:{supported:true,currentVersion:'1.0.2',state:'ready',version:'1.0.3'}});
  try {
    await f.open();
    await f.page.locator('#officinaUpdaterInstall').waitFor({state:'visible'});
    await f.page.evaluate(() => {document.getElementById('officinaUpdaterInstall').click();document.getElementById('officinaUpdaterInstall').click();});
    await f.page.locator('#officinaUpdaterMessage').filter({hasText:'Installazione in corso'}).waitFor();
    const sequence=await f.page.evaluate(() => updaterMock.calls.filter(call => ['prepareToLeave','updater_install','cancelLeaving'].includes(call.command)));
    assert.deepEqual(sequence.map(call => call.command), ['prepareToLeave','updater_install']);
    assert.deepEqual(sequence[0].args, {reason:'update'});
    assert.equal(await f.page.evaluate(() => updaterMock.fenced), true);
    assert.deepEqual(f.errors, []);
  } finally {await f.context.close();}
});

test('unsaved editor and install error retain the page and restore editing before a retry', async () => {
  const f = await fixture({iframe:true,host:'dirty',initial:{supported:true,currentVersion:'1.0.2',state:'ready',version:'1.0.3'}});
  try {
    await f.open();
    await f.page.locator('#officinaUpdaterInstall').click();
    await f.page.locator('#officinaUpdaterMessage').filter({hasText:'Salva o chiudi la scheda aperta'}).waitFor();
    assert.equal((await f.calls('updater_install')).length, 0);
    assert.equal(await f.page.frames().find(frame => frame.url().endsWith('/legacy')).locator('input').inputValue(), 'Bozza da conservare');
    await f.page.evaluate(() => {updaterMock.host='clean';updaterMock.errors.updater_install='Impossibile avviare l’installazione. Riprova.';});
    await f.page.locator('#officinaUpdaterInstall').click();
    await f.page.locator('#officinaUpdaterMessage').filter({hasText:'Impossibile avviare l’installazione'}).waitFor();
    assert.equal(await f.page.evaluate(() => updaterMock.fenced), false);
    assert.equal((await f.calls('cancelLeaving')).length, 2);
    assert.equal(await f.page.locator('#officinaUpdaterInstall').isEnabled(), true);
    assert.equal(f.page.url(), 'https://api.magomme.it/');
    await f.page.evaluate(() => {delete updaterMock.errors.updater_install;});
    await f.page.locator('#officinaUpdaterInstall').click();
    await f.page.locator('#officinaUpdaterMessage').filter({hasText:'Installazione in corso'}).waitFor();
    assert.equal((await f.calls('updater_install')).length, 2);
    assert.deepEqual(f.errors, []);
  } finally {await f.context.close();}
});

test('closing while preparing or returning false cancels installation and releases the guard', async () => {
  const f = await fixture({iframe:true,host:'slow',initial:{supported:true,currentVersion:'1.0.2',state:'ready',version:'1.0.3'}});
  try {
    await f.open();
    await f.page.locator('#officinaUpdaterInstall').click();
    await f.page.waitForFunction(() => updaterMock.deferred.prepare);
    await f.page.locator('#officinaUpdaterClose').click();
    await f.page.evaluate(() => updaterMock.deferred.prepare());
    await f.page.waitForFunction(() => !updaterMock.fenced && updaterMock.calls.some(call => call.command === 'cancelLeaving'));
    assert.equal((await f.calls('updater_install')).length, 0);
    await f.page.evaluate(() => {updaterMock.host='cancel';});
    await f.open();
    await f.page.locator('#officinaUpdaterInstall').click();
    await f.page.locator('#officinaUpdaterMessage').filter({hasText:'Installazione annullata'}).waitFor();
    assert.equal((await f.calls('updater_install')).length, 0);
    assert.deepEqual(f.errors, []);
  } finally {await f.context.close();}
});

test('old VPS missing preparation blocks a loaded workspace; the launcher can install without cloud data', async () => {
  const f = await fixture({iframe:true,host:'missing',initial:{supported:true,currentVersion:'1.0.2',state:'ready',version:'1.0.3'}});
  try {
    await f.open();
    await f.page.locator('#officinaUpdaterInstall').click();
    await f.page.locator('#officinaUpdaterMessage').filter({hasText:'Ricarica il gestionale'}).waitFor();
    assert.equal((await f.calls('updater_install')).length, 0);
  } finally {await f.context.close();}
  const launcher = await fixture({url:'http://tauri.localhost/index.html',host:'missing',initial:{supported:true,currentVersion:'1.0.2',state:'ready',version:'1.0.3'}});
  try {
    assert.equal(await launcher.page.locator('main #officinaUpdaterButton').count(), 1);
    await launcher.open();
    await launcher.page.locator('#officinaUpdaterInstall').click();
    await launcher.page.locator('#officinaUpdaterMessage').filter({hasText:'Installazione in corso'}).waitFor();
    assert.equal((await launcher.calls('updater_install')).length, 1);
    assert.equal((await launcher.calls('prepareToLeave')).length, 0);
    assert.deepEqual(launcher.errors, []);
  } finally {await launcher.context.close();}
});

test('duplicate injection, iframe, Android and other-origin boundaries keep native controls isolated', async () => {
  const f = await fixture({iframe:true});
  try {
    await f.page.evaluate(source);
    assert.equal(await f.page.locator('#officinaUpdaterButton').count(), 1);
    const child=f.page.frames().find(frame=>frame.url().endsWith('/legacy'));
    assert.equal(await child.locator('#officinaUpdaterButton').count(), 0);
    assert.equal(await child.evaluate(() => typeof window.WorkshopUpdater), 'undefined');
    assert.equal(await child.evaluate(() => updaterMock.calls.length), 0);
    await f.open();
    await f.page.locator('#officinaUpdaterCheck').click();
    assert.equal((await f.calls('updater_check')).length, 1);
  } finally {await f.context.close();}
  for (const options of [{platform:'android'}, {url:'https://other.example/'}]) {
    const blocked=await fixture(options);
    try {assert.equal(await blocked.page.locator('#officinaUpdaterButton').count(), 0);assert.equal(await blocked.page.evaluate(() => updaterMock.calls.length), 0);}
    finally {await blocked.context.close();}
  }
});

test('unsupported status disables operations and an older status response cannot overwrite a newer availability result', async () => {
  const unsupported=await fixture({initial:{supported:false,currentVersion:'1.0.2',state:'idle',message:'Aggiornamenti non disponibili in questa versione.'}});
  try {
    await unsupported.open();
    await unsupported.page.locator('#officinaUpdaterMessage').filter({hasText:'Aggiornamenti non disponibili'}).waitFor();
    assert.equal(await unsupported.page.locator('#officinaUpdaterCheck').isDisabled(), true);
    assert.equal(await unsupported.page.locator('#officinaUpdaterDownload').isVisible(), false);
    assert.equal(await unsupported.page.locator('#officinaUpdaterInstall').isVisible(), false);
  } finally {await unsupported.context.close();}
  const f=await fixture();
  try {
    await f.page.waitForFunction(() => document.getElementById('officinaUpdaterCurrent').textContent.includes('1.0.2'));
    await f.page.evaluate(() => {
      updaterMock.handlers.updater_status=()=>new Promise(resolve=>{updaterMock.deferred.status=()=>resolve({supported:true,currentVersion:'1.0.2',state:'idle'});});
      updaterMock.handlers.updater_check=()=>updaterMock.status={supported:true,currentVersion:'1.0.2',state:'available',version:'1.0.3'};
    });
    await f.open();
    await f.page.waitForFunction(() => updaterMock.deferred.status);
    await f.page.locator('#officinaUpdaterCheck').click();
    await f.page.locator('#officinaUpdaterDownload').waitFor({state:'visible'});
    await f.page.evaluate(() => updaterMock.deferred.status());
    assert.equal(await f.page.locator('#officinaUpdaterDownload').isVisible(), true);
    assert.deepEqual(f.errors, []);
  } finally {await f.context.close();}
});

test('native capabilities prevent unverified installs and retain verified installer retry after an error status', async () => {
  const unsigned=await fixture({initial:{supported:true,currentVersion:'1.0.2',state:'error',version:'1.0.3',
    canDownload:true,canInstall:false,message:'Il pacchetto non supera la verifica della firma.'}});
  try {
    await unsigned.open();
    await unsigned.page.locator('#officinaUpdaterMessage').filter({hasText:'verifica della firma'}).waitFor();
    assert.equal(await unsigned.page.locator('#officinaUpdaterInstall').isVisible(), false);
    assert.equal(await unsigned.page.locator('#officinaUpdaterDownload').isVisible(), true);
    await unsigned.page.evaluate(() => document.getElementById('officinaUpdaterInstall').click());
    assert.equal((await unsigned.calls('updater_install')).length, 0);
    await unsigned.page.evaluate(() => {
      updaterMock.status={...updaterMock.status,state:'ready',canDownload:false,canInstall:false};
    });
    await unsigned.page.locator('#officinaUpdaterClose').click();
    await unsigned.open();
    await unsigned.page.waitForFunction(() => document.getElementById('officinaUpdaterDownload').hidden);
    assert.equal(await unsigned.page.locator('#officinaUpdaterInstall').isVisible(), false, 'ready alone does not authorize an install');
    assert.equal(await unsigned.page.locator('#officinaUpdaterDownload').isVisible(), false);
    assert.deepEqual(unsigned.errors, []);
  } finally {await unsigned.context.close();}
  const retry=await fixture({initial:{supported:true,currentVersion:'1.0.2',state:'ready',version:'1.0.3',canDownload:false,canInstall:true}});
  try {
    await retry.open();
    await retry.page.evaluate(() => {
      updaterMock.handlers.updater_install=()=>{
        updaterMock.status={...updaterMock.status,state:'error',canDownload:false,canInstall:true,message:'Installazione non avviata. Riprova.'};
        throw new Error(updaterMock.status.message);
      };
    });
    await retry.page.locator('#officinaUpdaterInstall').click();
    await retry.page.locator('#officinaUpdaterMessage').filter({hasText:'Installazione non avviata'}).waitFor();
    assert.equal(await retry.page.evaluate(() => updaterMock.fenced), false);
    await retry.page.locator('#officinaUpdaterClose').click();
    await retry.open();
    await retry.page.locator('#officinaUpdaterMessage').filter({hasText:'Installazione non avviata'}).waitFor();
    assert.equal(await retry.page.locator('#officinaUpdaterInstall').isVisible(), true);
    assert.equal(await retry.page.locator('#officinaUpdaterDownload').isVisible(), false);
    await retry.page.evaluate(() => {delete updaterMock.handlers.updater_install;});
    await retry.page.locator('#officinaUpdaterInstall').click();
    await retry.page.locator('#officinaUpdaterMessage').filter({hasText:'Installazione in corso'}).waitFor();
    assert.equal((await retry.calls('updater_install')).length, 2);
    assert.equal((await retry.calls('updater_download')).length, 0, 'verified file is reused on install retry');
    assert.deepEqual(retry.errors, []);
  } finally {await retry.context.close();}
});
