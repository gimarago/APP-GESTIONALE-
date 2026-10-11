import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { createApplication } from './server.mjs';
import { addUser } from './database.mjs';

export function localConfiguration(env = process.env) {
  const port = Number(env.OFFICINA_LOCAL_PORT || 8080);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Porta locale non valida (1024-65535).');
  const base = env.LOCALAPPDATA || join(homedir(), '.local', 'share');
  return {port, origin:`http://127.0.0.1:${port}`, dataDir:resolve(env.OFFICINA_LOCAL_DATA_DIR || join(base, 'OfficinaGestionale', 'data'))};
}

function ask(label, hidden = false) {
  process.stdout.write(label);
  const output = hidden ? new Writable({write(_data, _encoding, done){done();}}) : process.stdout;
  const prompt = createInterface({input:process.stdin, output, terminal:!!process.stdin.isTTY});
  return new Promise((resolveAnswer,reject) => {
    prompt.once('line', answer=>{prompt.close();if(hidden)process.stdout.write('\n');resolveAnswer(answer);});
    prompt.once('SIGINT',()=>{prompt.close();reject(new Error('Configurazione annullata.'));});
  });
}

export async function launchLocal({env=process.env, prompt=ask, openBrowser=true, log=console.log}={}) {
  const settings=localConfiguration(env);
  const app=await createApplication({root:resolve(dirname(fileURLToPath(import.meta.url)),'..'),dataDir:settings.dataDir,origin:settings.origin,env:{NODE_ENV:'development'}});
  try {
    if(app.db.prepare("SELECT count(*) AS n FROM users WHERE role='admin' AND disabled=0").get().n===0){
      if(prompt===ask&&!process.stdin.isTTY)throw new Error('Primo avvio: apri il file BAT in una finestra interattiva per creare il tuo account.');
      log('\nPRIMO AVVIO - crea il tuo account locale.\n');
      let created=false;
      while(!created){
        const name=(await prompt('Nome utente [amministratore]: ')).trim()||'amministratore';
        const password=await prompt('Scegli una password di almeno 12 caratteri (nascosta): ',true);
        const confirmation=await prompt('Ripeti la password: ',true);
        if(password!==confirmation){log('Le password non coincidono. Riprova.');continue;}
        try{await addUser(app.db,name,password,'admin');created=true;log('Account creato. Usa queste credenziali nella pagina di accesso.');}catch(error){log(error.message);}
      }
    }
    await new Promise((done,reject)=>{app.server.once('error',reject);app.server.listen(settings.port,'127.0.0.1',done);});
    log(`\nGESTIONALE AVVIATO SUL PC\n\nApri: ${settings.origin}\nDati locali: ${settings.dataDir}\n\nLascia aperta questa finestra mentre lavori.\nPer fermare il gestionale premi Ctrl+C.\nQuesti dati restano sul PC: il collegamento al VPS non e ancora attivo.\n`);
    if(openBrowser&&env.OFFICINA_NO_BROWSER!=='1'&&process.platform==='win32'){
      const browser=spawn('rundll32.exe',['url.dll,FileProtocolHandler',settings.origin],{windowsHide:true,stdio:'ignore'});
      browser.on('error',()=>log('Apri manualmente nel browser: '+settings.origin));browser.unref();
    }
    return {...app,settings};
  }catch(error){await app.close();if(error.code==='EADDRINUSE')throw new Error(`La porta ${settings.port} e gia occupata. Se il gestionale e gia aperto, usa ${settings.origin}; altrimenti chiudi il servizio che occupa la porta.`);throw error;}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  let app;
  try{
    app=await launchLocal();let stopping=false;
    const stop=async()=>{if(stopping)return;stopping=true;await app.close();};
    process.on('SIGINT',stop);process.on('SIGTERM',stop);
  }catch(error){console.error('\n'+error.message);process.exitCode=1;}
}
