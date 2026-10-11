import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
const checks = [['Node',process.execPath,['--version']], ['Rust','rustc',['--version']],['Cargo','cargo',['--version']]];
for(const [name,command,args] of checks){const result=spawnSync(command,args,{encoding:'utf8'});console.log(`${result.status===0?'OK':'MANCANTE'} ${name}: ${(result.stdout||result.stderr||'installare i prerequisiti').trim()}`);}
if(process.platform==='win32')console.log('Windows: servono Visual Studio Build Tools con C++ e Windows SDK; WebView2 viene incluso come prerequisito nell’installer.');
for(const name of ['JAVA_HOME','ANDROID_HOME','NDK_HOME'])console.log(`${process.env[name]&&existsSync(process.env[name])?'OK':'DA CONFIGURARE'} ${name}`);
console.log(process.platform==='darwin'?'iOS: verificare Xcode, CocoaPods e Team Apple Developer.':'iOS: compilazione e firma richiedono macOS con Xcode.');
console.log(existsSync(join('src-tauri','gen','android'))?'Progetto Android inizializzato.':'Android: eseguire npm run android:init dopo aver installato i prerequisiti.');
console.log('Server: https://api.magomme.it/ — nessun database o credenziale viene incluso nel pacchetto.');
