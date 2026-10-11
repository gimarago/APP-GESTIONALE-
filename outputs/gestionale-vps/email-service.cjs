'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const BASE='http://localhost:8772',REDIRECT=BASE+'/oauth/callback';
const providers={gmail:{auth:'https://accounts.google.com/o/oauth2/v2/auth',token:'https://oauth2.googleapis.com/token',scope:'openid email https://www.googleapis.com/auth/gmail.send',profile:'https://openidconnect.googleapis.com/v1/userinfo'},outlook:{auth:'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',token:'https://login.microsoftonline.com/common/oauth2/v2.0/token',scope:'openid email offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.Send',profile:'https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName'}};
const address=s=>typeof s==='string'&&/^[^\s@<>?,;:]+@[^\s@<>?,;:]+\.[^\s@<>?,;:]+$/.test(s);
function payload(config,input){
 if(!address(input.to)||typeof input.subject!=='string'||/[\r\n]/.test(input.subject)||input.subject.length>200||typeof input.body!=='string'||!input.body.trim()||input.body.length>100000)throw Error('Destinatario o messaggio non valido.');
 const attachment=input.attachment;if(attachment&&(!/^[a-zA-Z0-9._-]+\.pdf$/.test(attachment.name)||typeof attachment.base64!=='string'||attachment.base64.length>2800000||!/^[A-Za-z0-9+/]+={0,2}$/.test(attachment.base64)||!Buffer.from(attachment.base64,'base64').subarray(0,5).equals(Buffer.from('%PDF-'))))throw Error('Allegato PDF non valido.');
 if(config.provider==='outlook')return {message:{subject:input.subject,body:{contentType:'Text',content:input.body},toRecipients:[{emailAddress:{address:input.to}}],...(attachment?{attachments:[{'@odata.type':'#microsoft.graph.fileAttachment',name:attachment.name,contentType:'application/pdf',contentBytes:attachment.base64}]}:{})},saveToSentItems:true};
 const subject='=?UTF-8?B?'+Buffer.from(input.subject).toString('base64')+'?=';
 let raw=['From: '+config.email,'To: '+input.to,'Subject: '+subject,'MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',Buffer.from(input.body).toString('base64').match(/.{1,76}/g).join('\r\n')].join('\r\n');
 if(attachment){const boundary='officina-'+crypto.createHash('sha256').update(attachment.base64).digest('hex').slice(0,32);raw=['From: '+config.email,'To: '+input.to,'Subject: '+subject,'MIME-Version: 1.0','Content-Type: multipart/mixed; boundary="'+boundary+'"','','--'+boundary,'Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',Buffer.from(input.body).toString('base64').match(/.{1,76}/g).join('\r\n'),'--'+boundary,'Content-Type: application/pdf; name="'+attachment.name+'"','Content-Disposition: attachment; filename="'+attachment.name+'"','Content-Transfer-Encoding: base64','',attachment.base64.match(/.{1,76}/g).join('\r\n'),'--'+boundary+'--',''].join('\r\n');}
 return {raw:Buffer.from(raw).toString('base64url')};
}
function createService({configFile,fetcher=fetch}={}){
 let config={provider:'gmail',email:'',clientId:''},secret='',session=null,pending=null,active=0;const csrf=crypto.randomBytes(32).toString('hex'),sent=new Map();
 if(configFile&&fs.existsSync(configFile))config=JSON.parse(fs.readFileSync(configFile,'utf8'));
 const origins=new Set([BASE,'http://127.0.0.1:8772','http://127.0.0.1:8770','http://localhost:8770']);
 const status=()=>({...config,connected:!!session,connectedEmail:session?.email||'',csrf,redirect:REDIRECT,hasSecret:!!secret});
 async function remote(url,options){const response=await fetcher(url,{...options,signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error('Il servizio di posta ha rifiutato la richiesta (HTTP '+response.status+'). Controlla configurazione e autorizzazioni.');return response.status===202||response.status===204?{}:response.json();}
 async function token(params){if(secret)params.client_secret=secret;return remote(providers[config.provider].token,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...params,client_id:config.clientId})});}
 async function access(){if(!session)throw Error('Collega prima il tuo account nelle Impostazioni.');if(session.expires<Date.now()+30000){if(!session.refresh)throw Error('Accesso scaduto: ricollega l’account nelle Impostazioni.');const t=await token({grant_type:'refresh_token',refresh_token:session.refresh});session={...session,access:t.access_token,refresh:t.refresh_token||session.refresh,expires:Date.now()+t.expires_in*1000};}return session.access;}
 const server=http.createServer(async(req,res)=>{
  const origin=req.headers.origin;let locked=false;
  const json=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  try{
   if(!['localhost:8772','127.0.0.1:8772'].includes(req.headers.host))return json(403,{error:'Host non autorizzato'});
   if(origin&&!origins.has(origin))return json(403,{error:'Apri l’app da localhost:8770 oppure localhost:8772.'});
   if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
   res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
   if(req.method==='OPTIONS'){res.setHeader('Access-Control-Allow-Methods','GET, POST');res.setHeader('Access-Control-Allow-Headers','Content-Type, X-Officina-Token');res.writeHead(204);return res.end();}
   const url=new URL(req.url,BASE);
   if(url.pathname==='/oauth/callback'){
    if(!pending||url.searchParams.get('state')!==pending.state||Date.now()>pending.expires)throw Error('Collegamento scaduto o non valido. Riprova dalle Impostazioni.');
    const attempt=pending;pending=null;active++;locked=true;if(url.searchParams.has('error'))throw Error('Accesso non autorizzato.');
    const t=await token({grant_type:'authorization_code',code:url.searchParams.get('code'),redirect_uri:REDIRECT,code_verifier:attempt.verifier});
    const profile=await remote(providers[config.provider].profile,{headers:{Authorization:'Bearer '+t.access_token}});
    const email=profile.email||profile.mail||profile.userPrincipalName;
    if(!email||email.toLowerCase()!==config.email.toLowerCase())throw Error('L’account scelto non corrisponde al mittente nelle Impostazioni.');
    session={access:t.access_token,refresh:t.refresh_token,email,expires:Date.now()+t.expires_in*1000};
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});return res.end('<h1>Account collegato</h1><p>Puoi chiudere questa scheda e tornare all’officina. Premi Verifica collegamento nelle Impostazioni.</p>');
   }
   if(url.pathname==='/api/email/status'&&req.method==='GET')return json(200,status());
   if(url.pathname.startsWith('/api/email/')&&req.method==='POST'){
    if(req.headers['x-officina-token']!==csrf) return json(403,{error:'Sessione locale scaduta. Riapri le Impostazioni.'});
    let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>3000000)throw Error('Messaggio troppo lungo.');}const data=JSON.parse(raw||'{}');
    if(active&&['/api/email/config','/api/email/connect','/api/email/disconnect'].includes(url.pathname))throw Error('Operazione in corso: attendi prima di cambiare account.');
    if(url.pathname==='/api/email/config'){
     if(!providers[data.provider]||!address(data.email)||typeof data.clientId!=='string')throw Error('Compila servizio e indirizzo mittente.');
     const next={provider:data.provider,email:data.email.trim(),clientId:data.clientId.trim()};
     if(configFile){fs.mkdirSync(path.dirname(configFile),{recursive:true});fs.writeFileSync(configFile,JSON.stringify(next));}
     if(JSON.stringify(next)!==JSON.stringify(config)){session=null;pending=null;secret='';}config=next;if(data.secret)secret=data.secret;return json(200,status());
    }
    if(url.pathname==='/api/email/disconnect'){session=null;pending=null;secret='';return json(200,status());}
    if(url.pathname==='/api/email/connect'){
     if(!config.clientId)throw Error('Configura il Client ID OAuth: consulta LEGGIMI-email.txt.');
     const state=crypto.randomBytes(32).toString('hex'),verifier=crypto.randomBytes(48).toString('base64url');pending={state,verifier,expires:Date.now()+600000};
     const auth=new URL(providers[config.provider].auth);auth.search=new URLSearchParams({client_id:config.clientId,redirect_uri:REDIRECT,response_type:'code',scope:providers[config.provider].scope,state,code_challenge:crypto.createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',login_hint:config.email,prompt:'consent',...(config.provider==='gmail'?{access_type:'offline'}:{})});return json(200,{url:auth.href});
    }
    if(url.pathname==='/api/email/send'){
     if(typeof data.requestId!=='string'||data.requestId.length>100)throw Error('Richiesta non valida.');const body=payload(config,data),digest=crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
     active++;locked=true;const bearer=await access();
     if(sent.has(data.requestId)){const previous=sent.get(data.requestId);if(previous.digest!==digest)throw Error('Richiesta già utilizzata per un altro messaggio.');return json(previous.code,previous.result);}
     sent.set(data.requestId,{digest,code:409,result:{error:'Invio già avviato. Controlla la Posta inviata prima di riprovare.'}});
     try{await remote(config.provider==='gmail'?'https://gmail.googleapis.com/gmail/v1/users/me/messages/send':'https://graph.microsoft.com/v1.0/me/sendMail',{method:'POST',headers:{Authorization:'Bearer '+bearer,'Content-Type':'application/json'},body:JSON.stringify(body)});}catch(e){throw Error(e.message+' Esito da verificare nella Posta inviata; nessun nuovo invio automatico.');}
     const result={ok:true,message:'Email accettata dal servizio di posta.'};sent.set(data.requestId,{digest,code:200,result});return json(200,result);
    }
    return json(404,{error:'Funzione non disponibile'});
   }
   if(req.method!=='GET')return json(405,{error:'Metodo non consentito'});
   const relative=decodeURIComponent(url.pathname==='/'?'/officina-fatturazione.html':url.pathname),file=path.resolve(__dirname,'.'+relative);
   if(!file.startsWith(__dirname+path.sep)||relative.includes('/backend/')||!['.html','.js','.css','.woff2','.svg','.png','.jpg','.ico'].includes(path.extname(file)))return json(404,{error:'File non disponibile'});
   const content=await fs.promises.readFile(file);res.writeHead(200,{'Content-Type':({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(content);
  }catch(e){json(400,{error:e.code==='ENOENT'?'File non disponibile':e.message});}finally{if(locked)active--;}
 });return server;
}
module.exports={createService,payload,address};
if(require.main===module){const configFile=path.join(process.env.LOCALAPPDATA||process.env.HOME||__dirname,'Officina','email-settings.json');createService({configFile}).listen(8772,'127.0.0.1',()=>console.log('Servizio email Officina attivo: '+BASE+' — mantieni aperta questa finestra.'));}
