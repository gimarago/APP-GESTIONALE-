/* Each client submits only records it changed, against the versions it read.
 * An acknowledgement never advances versions of unseen remote records. */
(() => {
 'use strict';
 const $=id=>document.getElementById(id),R=WorkshopCloudRecords,clientId=crypto.randomUUID();
 let user=null,csrf='',remote=null,versions={},frame=null,ready=false,editing=false,blocked=false,dirty=false,saving=false,pending=null,baseline=null,saveTimer,polling=false,events=null,loading=false,lastView='dashboard',finishing=false,generation=0,refreshNeeded=false;
 let operatingAddressSupported=false,inventoryCountSupported=false,inventoryCountSalesSupported=false,inventoryNewStockSupported=false,workReportsSupported=false,prefetched=null,userAppearance=null;
 let frameTimer,failedFrame=null;
 let navigationTask=null,navigationDraining=false,navigationView=null;
 let liveTask=null,liveTimer,refreshAgain=false,inventoryRefreshing=false,connectionNeedsRecovery=false,leaving=false,draftArchiveWarning=false,retainedDraft=null,minimumSnapshotRevision=0;
 let updateLeaving=null;
 const resetPage=location.pathname==='/reset-password';
 let resetToken=resetPage?new URL(location.href).searchParams.get('token'):null,recoveryAvailable=null;
 // A recovery link contains a one-time secret. Remove it from browser history
 // immediately; it must never be copied into storage or a follow-up URL.
 if(resetPage)history.replaceState(null,'','/reset-password');
 function showAccess(mode){for(const [name,id] of Object.entries({login:'loginForm',recovery:'recoveryForm',reset:'resetForm'}))$(id).hidden=name!==mode;}
 function recoveryStatus(){
   const unavailable=recoveryAvailable===false;
   $('recoveryForm').querySelector('button[type="submit"]').disabled=unavailable;
   $('recoveryError').textContent=unavailable?'Il recupero via email non è ancora attivo. Chiedi all’amministratore di reimpostare la password dalla console del VPS.':'';
 }
 async function fetchJson(url,options,unchanged,timeoutMs=8000){
   // AbortController also works on browsers without AbortSignal.timeout.
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
   try{
     const response=await fetch(url,{...options,signal:controller.signal});let result;
     if(response.status===304&&unchanged!==undefined)return unchanged;
     try{result=await response.json();}catch(error){if(controller.signal.aborted)throw error;const invalid=new Error('Il VPS ha restituito una risposta non valida (HTTP '+response.status+'). Riprova.');invalid.status=response.status;throw invalid;}
     if(!response.ok){const error=new Error(result?.error?.message||'Richiesta non riuscita (HTTP '+response.status+').');error.status=response.status;error.code=result?.error?.code;error.conflicts=result?.conflicts;error.omittedConflicts=result?.omittedConflicts;throw error;}
     return result;
   }catch(error){if(controller.signal.aborted){const timeout=new Error('Il VPS non ha risposto entro '+timeoutMs/1000+' secondi. Verifica la connessione e riprova.');timeout.code='REQUEST_TIMEOUT';throw timeout;}throw error;}
   finally{clearTimeout(timer);}
 }
 function resetRequest(action,data){
   return fetchJson('/api/password-reset/'+action,{method:'POST',credentials:'same-origin',cache:'no-store',referrerPolicy:'no-referrer',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
 }
 const draftKey='officina.cloud.draft.v1',archivePrefix='officina.cloud.archived-draft.';let volatileDraft=null;
 const readDraft=()=>{try{return volatileDraft||sessionStorage.getItem(draftKey);}catch{return volatileDraft;}};
 function archivedDrafts(){const result=[];try{for(let i=0;i<sessionStorage.length;i++){const key=sessionStorage.key(i);if(key.startsWith(archivePrefix))result.push(JSON.parse(sessionStorage.getItem(key)));}}catch{}return result;}
 function hasDrafts(){return !!(retainedDraft||readDraft())||archivedDrafts().length>0;}
 function archiveDraft(){if(draftArchiveWarning&&retainedDraft)return false;const raw=readDraft();if(!raw)return true;try{sessionStorage.setItem(archivePrefix+crypto.randomUUID(),raw);sessionStorage.removeItem(draftKey);volatileDraft=null;return true;}catch{notice('Spazio insufficiente per conservare un’altra bozza. Scarica le bozze ed elimina le copie già verificate prima di continuare.');return false;}}
 const notice=text=>{$('notice').hidden=!text;$('notice').textContent=text;};
 const status=(title,message)=>{$('mode').textContent=title;$('status').textContent=message;};
 function buttons(){ $('cloudBar').hidden=!(blocked||connectionNeedsRecovery||draftArchiveWarning); $('recover').hidden=!(dirty||(blocked&&remote)||hasDrafts()); $('managementRecover').hidden=!(dirty||(blocked&&remote)||hasDrafts()); $('clearDrafts').hidden=!hasDrafts()||dirty||pending||saving; $('reload').hidden=!(blocked||connectionNeedsRecovery); $('reload').disabled=saving||finishing||loading; $('importLabel').hidden=user?.role!=='admin'||!editing||remote?.revision!==0||saving||dirty||finishing||loading;for(const id of ['more','logout','export','recover','managementRecover','clearDrafts'])$(id).disabled=!!updateLeaving; }
 function finishGuard(value){finishing=value||!!updateLeaving;if(frame){const locked=loading||!!updateLeaving||value&&(!navigationTask||navigationDraining||cloud()?.applying);frame.inert=locked;frame.style.pointerEvents=locked?'none':'';}$('loginPanel').inert=!!updateLeaving;buttons();}
 function request(path,method='GET',body){
   return fetchJson('/api/'+path,{method,credentials:'same-origin',cache:'no-store',headers:{...(body?{'Content-Type':'application/json'}:{}),...(method!=='GET'?{'X-CSRF-Token':csrf}:{})},body:body?JSON.stringify(body):undefined});
 }
 function requestState(snapshot){
   return fetchJson('/api/state',{method:'GET',credentials:'same-origin',cache:'no-store',headers:snapshot?{'If-None-Match':'"officina-state-'+snapshot.revision+'"'}:{}},snapshot);
 }
 const cloud=()=>{try{return frame?.contentWindow?.WorkshopCloud;}catch{return null;}};
 function stateNow(){return cloud()?.capture()||remote?.state;}
 const same=(a,b)=>R.stable(a)===R.stable(b);
 function keepDraft(){const state=stateNow();if(state)volatileDraft=JSON.stringify({protocol:2,baseRevision:remote?.revision,versions,capturedAt:new Date().toISOString(),state,forms:cloud()?.formDraft(),pending,conflictReport:WorkshopCloudConflicts.report()});try{if(volatileDraft&&!(draftArchiveWarning&&retainedDraft))sessionStorage.setItem(draftKey,volatileDraft);}catch{notice('La memoria del dispositivo non è sufficiente: scarica subito la bozza prima di chiudere questa pagina.');}buttons();}
 function freeze(message){clearTimeout(liveTimer);refreshAgain=false;if(ready)keepDraft();blocked=true;editing=false;cloud()?.mode(false);status('Modifiche sospese',message);notice(message+(WorkshopCloudConflicts.report()?' Apri “Confronta modifiche” per vedere autore e valori coinvolti. La tua bozza è conservata.':' La tua bozza è recuperabile: scaricala e confrontala con i dati aggiornati.')+' Gli altri operatori possono continuare.');buttons();}
 function loadFrame(snapshot,view){
   WorkshopCloudConflicts.clear();
   clearTimeout(liveTimer);
   clearTimeout(frameTimer);failedFrame=null;
   lastView=view||cloud()?.view()||lastView;ready=false;loading=true;remote=snapshot;versions={...snapshot.versions};refreshNeeded=false;prefetched=null;connectionNeedsRecovery=false;minimumSnapshotRevision=snapshot.revision;generation++;
   window.WorkshopCloudBoot={state:snapshot.state,user,appearance:userAppearance,editing,view:lastView,features:{operatingAddress:operatingAddressSupported,inventoryCount:inventoryCountSupported?4:0,inventoryCountSales:inventoryCountSalesSupported?1:0,inventoryNewStock:inventoryNewStockSupported?1:0,workReports:workReportsSupported?1:0}};
   const next=document.createElement('iframe');next.title='Gestionale officina';next.src='/legacy';next.inert=true;next.style.pointerEvents='none';frame=next;
   const failFrame=message=>{if(frame===next&&loading&&failedFrame!==next)window.WorkshopCloudHost.failed(next.contentWindow,message);};
   const armTimeout=()=>{clearTimeout(frameTimer);frameTimer=setTimeout(()=>failFrame('La pagina del gestionale non ha completato l’avvio. Riprova con “Ricarica dati server”.'),30000);};
   next.addEventListener('error',()=>failFrame('Impossibile caricare la pagina del gestionale.'),{once:true});
   next.addEventListener('load',()=>{if(frame!==next||!loading||failedFrame===next)return;if(!cloud())failFrame('La pagina del gestionale non è disponibile o non ha avviato l’applicazione.');else armTimeout();},{once:true});
   armTimeout();$('frameHost').replaceChildren(next);buttons();
 }
 function connectEvents(){events?.close();events=new EventSource('/api/events');events.addEventListener('change',()=>refresh());events.addEventListener('supplier-invoices',event=>{let data;try{data=JSON.parse(event.data);}catch{return;}if(ready&&frame?.contentWindow)frame.contentWindow.dispatchEvent(new frame.contentWindow.CustomEvent('workshop-remote-update',{detail:{domain:'supplier-invoices',revision:data.revision}}));});}
 function connectionFailure(error){
   loading=false;ready=false;blocked=true;editing=false;
   const message=error.message||'Impossibile recuperare i dati dal VPS.';
   status('Connessione non completata',message);notice(message+' Premi “Ricarica dati server” per riprovare.');
   const text=document.createElement('p');text.className='loading';text.textContent='Archivio non caricato.';$('frameHost').replaceChildren(text);frame=null;buttons();
 }
 window.WorkshopCloudHost={
   canWrite(){return !!user&&editing&&!blocked&&!finishing&&ready;},
   prepareToLeave,
   cancelLeaving,
   synchronizing(){return !!navigationTask||!!liveTask;},
   canRefresh(source){return source===frame?.contentWindow&&liveSafe();},
   logout(source){if(!updateLeaving&&source===frame?.contentWindow&&user)return logout();},
   manage(source){if(!updateLeaving&&source===frame?.contentWindow&&user)toggleManagement();},
   async appearance(source,value){
     if(source!==frame?.contentWindow||!user)throw Error('Accedi per salvare il tema.');
     if(updateLeaving?.prepared)throw Error('Attendi il riavvio dell’app prima di modificare il tema.');
     const accountId=user.id,result=await request('appearance','PUT',value);
     if(source===frame?.contentWindow&&user?.id===accountId)userAppearance=result;
     return result;
   },
   uploadModule(source,data){
     if(source!==frame?.contentWindow||!this.canWrite())throw Error('Non hai il permesso di caricare moduli in questo momento.');
     return fetchJson('/api/module-files',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(data)},undefined,120000);
   },
   sendEmail(source,data){
     if(source!==frame?.contentWindow||!this.canWrite())throw Error('L’invio email è disponibile solo per un account con permesso di modifica.');
     return request('email/send','POST',data);
   },
   inventoryVersion(source){return source===frame?.contentWindow&&ready&&!blocked&&!loading?(versions['domain:inventory']||0):null;},
   recordVersions(source){return source===frame?.contentWindow&&ready&&!blocked&&!loading?{...versions}:null;},
   async refreshInventory(source){
     if(source!==frame?.contentWindow||!this.canWrite())throw Error('Non puoi avviare il conteggio mentre la connessione è sospesa.');
     const sourceFrame=frame,deadline=Date.now()+12000;inventoryRefreshing=true;
     try{
       while(polling||liveTask){
         if(sourceFrame!==frame||blocked||!ready||!editing)throw Error('La connessione è cambiata. Riapri il magazzino e riprova.');
         if(Date.now()>=deadline)throw Error('La sincronizzazione del magazzino è ancora in corso. Attendi qualche secondo e riprova.');
         await new Promise(resolve=>setTimeout(resolve,40));
       }
       if(sourceFrame!==frame||blocked||!ready||!editing||dirty||pending||saving)throw Error('Le modifiche locali non sono ancora state salvate. Attendi la sincronizzazione e riprova.');
       finishGuard(true);
       for(let attempt=0;attempt<3;attempt++){
         const token=generation,current=await requestState();
         if(sourceFrame!==frame||blocked||!ready||!editing)throw Error('La connessione è cambiata. Riapri il magazzino e riprova.');
         if(current.revision<(remote?.revision||0))continue;
         if(current.revision!==remote.revision||refreshNeeded){
           if(dirty||pending||saving)throw Error('Sono arrivate altre modifiche locali. Salvale e riprova ad avviare l’inventario.');
           if(!await applySnapshot(current,sourceFrame,token))continue;
         }
         if(remote?.revision!==current.revision)continue;
         prefetched=null;refreshNeeded=false;
         status(editing?'Modifica condivisa':'Consultazione',`Revisione ${remote.revision} · sincronizzazione automatica`);
         return {state:stateNow(),versions:{...versions},revision:remote.revision};
       }
       throw Error('Il magazzino continua a cambiare su un altro dispositivo. Le scorte sono state sincronizzate; riprova ad avviare l’inventario.');
     }finally{
       if(sourceFrame===frame)finishGuard(false);
       inventoryRefreshing=false;
       if(refreshAgain&&!blocked){refreshAgain=false;queueMicrotask(()=>refresh());}
     }
   },
   ready(source){if(source!==frame?.contentWindow)return;if(failedFrame===frame){cloud()?.mode(false);return;}clearTimeout(frameTimer);ready=true;loading=false;baseline=stateNow();cloud().mode(editing&&!blocked);frame.inert=finishing;frame.style.pointerEvents=finishing?'none':'';status(editing?'Modifica condivisa':'Consultazione',`Revisione ${remote.revision} · sincronizzazione automatica`);buttons();connectEvents();},
   navigate(source,view){if(source!==frame?.contentWindow||!ready||loading||view===cloud()?.view()&&!navigationTask)return false;if(finishing&&!navigationTask)return true;if(blocked)return false;const client=cloud();if(client?.navigationBusy()){const warning='Hai un modulo aperto, ad esempio un rapporto di intervento o una bozza fattura.';notice(warning+' Le modifiche non salvate andranno perse se lo chiudi.');if(!window.confirm(warning+'\n\nVuoi cambiare sezione e chiudere il modulo senza salvare?')){notice('Cambio di sezione annullato. Il modulo è ancora aperto e le modifiche non salvate sono conservate.');return true;}if(!client.discardOpenForms?.()||client.navigationBusy()){notice('Il modulo non può essere chiuso mentre è in corso un salvataggio. Attendi e riprova.');return true;}notice('');}void navigate(view);return true;},
   changed(source){if(source!==frame?.contentWindow||!ready||!editing||blocked||finishing)return;try{if(same(stateNow(),baseline))return;dirty=true;status('Modifica condivisa','Modifiche in attesa di conferma');keepDraft();clearTimeout(saveTimer);saveTimer=setTimeout(save,650);}catch(e){freeze('Impossibile preparare i dati: '+e.message);}},
   failed(source,message){if(source===frame?.contentWindow){clearTimeout(frameTimer);failedFrame=frame;loading=false;freeze('Avvio del gestionale incompleto: '+message);}},
   denied(){notice(blocked?'Ricarica i dati aggiornati dopo aver conservato la bozza.':finishing?'Sincronizzazione in corso: tra poco potrai modificare i dati.':'Questo account può solo consultare i dati.');},
   flush
 };
 async function save(options={}){
   if(saving||!editing||blocked||!ready||(finishing&&!options.drain))return;
   let capture,changes;
   try{capture=stateNow();changes=R.diff(baseline,capture,versions);}catch(e){freeze('Impossibile preparare il salvataggio: '+e.message);return;}
   if(!pending&&!changes.length){dirty=false;buttons();return;}
   saving=true;dirty=true;status('Salvataggio…','Attendi la conferma del VPS');
   let serverGeneratedChanges=false;
   const saveGeneration=generation,saveSource=frame;
   const operation=pending||{path:'changes',method:'PUT',data:{protocol:2,mutationId:crypto.randomUUID(),clientId,changes,versions:{...versions}},state:capture};pending=operation;keepDraft();buttons();
   try{
     const result=await request(operation.path,operation.method,operation.data);
     if(saveGeneration!==generation||saveSource!==frame||!user)return;
     // A background snapshot predating this acknowledgement must not replace
     // the newly saved local records at the next section change.
     prefetched=null;baseline=operation.state;Object.assign(versions,result.versions);
     // Any confirmed save establishes a floor for later GET responses. This
     // also covers a normal edit acknowledged before the generated count
     // refresh has finished: an older snapshot cannot undo that saved edit.
     minimumSnapshotRevision=Math.max(minimumSnapshotRevision,result.revision);
     if((versions['domain:inventory']||0)===result.previousInventoryVersion)versions['domain:inventory']=result.inventoryVersion;
     serverGeneratedChanges=result.serverGeneratedChanges===true;
     // A sale can update the shared count draft inside the server transaction.
     // Its values and versions have not been read by this device yet. Keep the
     // old revision so the next snapshot loads them, even for our own save.
     if(serverGeneratedChanges)refreshNeeded=true;
     else if(remote.revision===result.previousRevision)remote.revision=result.revision;else refreshNeeded=true;
     remote.state=operation.state;if(pending===operation)pending=null;dirty=!same(stateNow(),baseline);
     if(!dirty){volatileDraft=null;if(!(draftArchiveWarning&&retainedDraft))try{sessionStorage.removeItem(draftKey);}catch{}}else keepDraft();
     if(!blocked){status('Modifica condivisa',`Salvato sul VPS · ${new Date().toLocaleTimeString('it-IT')}`);if(!refreshNeeded&&!draftArchiveWarning)notice('');}
   }catch(error){
     if(saveGeneration!==generation||saveSource!==frame||!user)return;
     if(error.status===409&&Array.isArray(error.conflicts)){
       // The user may have edited again while the rejected request was in
       // flight. Compare the current draft; retain the original pending request
       // separately for recovery and idempotent retries.
       let proposal=operation;try{proposal={data:{changes:R.diff(baseline,stateNow(),versions)}};}catch{}
       const report=WorkshopCloudConflicts.capture(error.conflicts,baseline,proposal,error.omittedConflicts||0);
       freeze('Conflitto di modifica'+(report.cards[0]?.title?': '+report.cards[0].title:'.')+' Nessun dato di questo invio è stato sovrascritto.');
       WorkshopCloudConflicts.show();
     }else freeze([400,409,413].includes(error.status)?error.message:'Conferma del salvataggio non ricevuta. Verifica la connessione.');
   }
   finally{saving=false;buttons();if(dirty&&!blocked&&!finishing){clearTimeout(saveTimer);saveTimer=setTimeout(save,650);}if(!blocked&&!finishing&&(serverGeneratedChanges||!dirty))queueMicrotask(()=>refresh());}
 }
 async function flush(options={}){
   if(blocked)throw Error('Salvataggio sospeso: risolvi il conflitto o ripristina la connessione prima di proseguire.');
   if(user?.role==='viewer')return;
   if(finishing&&!(options.leaving&&updateLeaving))throw Error('Attendi il salvataggio in corso.');
   finishGuard(true);clearTimeout(saveTimer);
   try{
     while(saving)await new Promise(r=>setTimeout(r,50));
     if(options.navigation){
       // Recheck because stock, appointment and delivery callbacks can extend
       // the settling window. A clean section change has no fixed delay.
       let delay;while((delay=cloud()?.settleDelay?.()??650)>0){await new Promise(r=>setTimeout(r,delay));if(!cloud()?.settleDelay)break;}
     }else await new Promise(r=>setTimeout(r,650));
     await save({drain:true});if(!blocked&&!same(stateNow(),baseline))await save({drain:true});if(blocked||dirty||pending)throw Error(options.leaving?'Operazione non confermata dal VPS: l’aggiornamento dell’app non può iniziare.':'Operazione non confermata dal server: il documento non può essere esportato.');
   }
   finally{finishGuard(false);if(refreshNeeded&&!blocked)queueMicrotask(()=>refresh());}
 }
 // Windows starts the installer and exits immediately. A sessionStorage draft
 // cannot survive that exit, so unfinished forms and recovery drafts must be
 // resolved by the user before installation rather than silently archived.
 async function prepareToLeave(options={}){
   if(options.reason!=='update')throw Error('Operazione di chiusura non riconosciuta.');
   if(updateLeaving){if(updateLeaving.prepared)return true;throw Error('Attendi la preparazione dell’aggiornamento in corso.');}
   const fail=message=>{notice(message);throw Error(message);};
   if(leaving||loading||finishing||navigationTask||liveTask||inventoryRefreshing)fail('Attendi il completamento della sincronizzazione prima di aggiornare l’app.');
   if(user&&(!ready||blocked||connectionNeedsRecovery||navigator.onLine===false))fail('Ripristina la connessione e risolvi le modifiche sospese prima di aggiornare l’app.');
   if(cloud()?.navigationBusy())fail('Completa o chiudi il modulo aperto prima di aggiornare l’app. Le modifiche del modulo sono ancora conservate.');
   let archived=false;try{for(let index=0;index<sessionStorage.length;index++)if(sessionStorage.key(index)?.startsWith(archivePrefix)){archived=true;break;}}catch{fail('Impossibile verificare le bozze conservate. Scaricale prima di aggiornare l’app.');}
   if(archived||retainedDraft||draftArchiveWarning)fail('Sono presenti bozze da recuperare. Scaricale e verifica le copie da Gestione prima di aggiornare l’app.');
   // Finish change/blur handlers before locking, including a settings field
   // whose value has changed but whose delayed save has not started yet.
   try{frame?.contentDocument?.activeElement?.blur();}catch{}
   const transition={source:frame,token:generation,account:user,prepared:false};updateLeaving=transition;
   finishGuard(true);clearTimeout(saveTimer);clearTimeout(liveTimer);
   const current=()=>{
     if(updateLeaving!==transition)return false;
     if(frame!==transition.source||generation!==transition.token||user!==transition.account)throw Error('La sessione è cambiata durante la preparazione. Riapri l’aggiornamento e riprova.');
     if(user&&(!ready||loading||blocked||connectionNeedsRecovery||navigator.onLine===false))throw Error('Il salvataggio non è confermato. Ripristina la connessione prima di aggiornare l’app.');
     return true;
   };
   try{
     if(user){await flush({navigation:true,leaving:true});if(!current())return false;await cloud()?.appearanceFlush?.();if(!current())return false;}
     if(cloud()?.navigationBusy())throw Error('Il modulo aperto deve essere completato o chiuso prima di aggiornare l’app.');
     if(dirty||pending||saving||cloud()?.appearancePending||user&&!same(stateNow(),baseline))throw Error('Attendi la conferma di tutte le modifiche prima di aggiornare l’app.');
     if(hasDrafts())throw Error('Sono presenti bozze da recuperare. Scaricale e verifica le copie da Gestione prima di aggiornare l’app.');
     transition.prepared=true;
     if(user)status('Aggiornamento dell’app','Modifiche salvate sul VPS. Attendi l’installazione e il riavvio.');
     return true;
   }catch(error){if(updateLeaving===transition){cancelLeaving();notice(error.message);}throw error;}
 }
 function cancelLeaving(){
   if(!updateLeaving)return false;
   updateLeaving=null;finishGuard(false);
   if(user&&ready&&!blocked){status(editing?'Modifica condivisa':'Consultazione',dirty?'Modifiche in attesa di conferma':`Revisione ${remote.revision} · sincronizzazione automatica`);if(dirty){clearTimeout(saveTimer);saveTimer=setTimeout(save,650);}else queueMicrotask(()=>refresh());}
   return true;
 }
 function busy(){return dirty||pending||!ready||!same(stateNow(),baseline)||cloud()?.busy();}
 function liveSafe(){
   const client=cloud();
   if(!(!!user&&ready&&!loading&&!blocked&&!pending&&!saving&&!finishing&&!navigationTask&&!liveTask&&!document.hidden&&!!client&&!client.initializing&&!client.liveBusy?.()&&client.settleDelay()===0))return false;
   // Inventory operations must retain the versions they used until their save
   // is acknowledged. Two independent deductions can propose the same final
   // quantity; accepting a peer snapshot first would silently coalesce them.
   try{const changes=R.diff(baseline,stateNow(),versions);return !changes.some(change=>R.inventoryRecord(change.key))&&!R.needsInventoryGuard(changes,R.flatten(baseline));}catch{return false;}
 }
 function queueLive(delay=600){
   clearTimeout(liveTimer);
   if(user&&ready&&!loading&&!blocked&&!updateLeaving&&!document.hidden)liveTimer=setTimeout(()=>void applyLive(),delay);
 }
 async function applySnapshot(current,source,token){
   if(frame!==source||token!==generation||blocked||!ready||loading)return false;
   // A GET started before our sale acknowledgement may finish afterwards.
   // It cannot satisfy the refresh required for the server-adjusted counts.
   if(current.revision<minimumSnapshotRevision){if(prefetched===current)prefetched=null;refreshAgain=true;return false;}
   if(current.revision===remote.revision)return true;
   const client=cloud();
   if(!client?.apply)throw Error('Aggiorna l’app per sincronizzare i dati nella schermata aperta.');
   const displayed=stateNow(),baseRecords=R.flatten(baseline),localRecords=R.flatten(displayed),serverRecords=R.flatten(current.state),mergedRecords=new Map(serverRecords),nextVersions={...current.versions},retainedLocalKeys=new Set();
   // Keep local edits on their own records while accepting unrelated server
   // records. A concurrent edit to the same record keeps its old version so
   // the normal save path still reports a genuine conflict.
   for(const key of new Set([...baseRecords.keys(),...localRecords.keys()])){
     const base=baseRecords.get(key),local=localRecords.get(key);
     if(R.stable(base)===R.stable(local))continue;
     const server=serverRecords.get(key);
     if(R.stable(local)===R.stable(server))continue;
     if(localRecords.has(key))mergedRecords.set(key,local);else mergedRecords.delete(key);
     nextVersions[key]=versions[key]||0;
     retainedLocalKeys.add(key);
   }
   const mergedState=R.inflate(mergedRecords);
   const stockChanged=!same(current.state.dom['#stockRows'],baseline.dom['#stockRows']);
   const stockVersionChanged=Object.keys(current.versions).some(key=>{try{const parts=JSON.parse(key);return parts[0]==='row'&&parts[1]==='#stockRows'&&(current.versions[key]||0)!==(remote.versions[key]||0);}catch{return false;}});
   const inventoryDraftChanged=current.state.storage['officina.inventory.v1']!==baseline.storage['officina.inventory.v1'];
   frame.inert=true;frame.style.pointerEvents='none';
   const appliedState=await client.apply(mergedState,displayed);
   if(frame!==source||token!==generation||blocked||!ready||loading)return false;
   // Stock controls and other legacy decorators normalize the received DOM.
   // Adopt those read-only changes as the baseline, rather than writing them
   // back as edits. Retained local records still compare against the server's
   // values and keep their old versions, so real edits are saved or conflict.
   const normalizedState=appliedState||stateNow();
   if(retainedLocalKeys.size){
     const normalizedRecords=R.flatten(normalizedState);
     for(const key of retainedLocalKeys){if(serverRecords.has(key))normalizedRecords.set(key,serverRecords.get(key));else normalizedRecords.delete(key);}
     baseline=R.inflate(normalizedRecords);
   }else baseline=normalizedState;
   remote=current;versions=nextVersions;generation++;dirty=R.diff(baseline,stateNow(),versions).length>0;
   if(dirty){keepDraft();clearTimeout(saveTimer);saveTimer=setTimeout(save,650);}
   if(stockChanged||stockVersionChanged||inventoryDraftChanged){const target=source.contentWindow,selectors=stockChanged||stockVersionChanged?['#stockRows']:[];target.dispatchEvent(new target.CustomEvent('workshop-cloud-snapshot-applied',{detail:{revision:current.revision,versions:{...current.versions},selectors,inventoryDraftChanged}}));}
   return true;
 }
 async function applyLive(){
   if(!prefetched||prefetched.revision===remote?.revision&&!refreshNeeded)return;
   if(!liveSafe()){
     if(ready&&!blocked&&!dirty&&!saving&&!finishing&&!navigationTask&&!liveTask)status(editing?'Modifica condivisa':'Consultazione','Aggiornamenti in attesa: concludi la modifica o chiudi il modulo aperto.');
     queueLive();return;
   }
   const current=prefetched,source=frame,token=generation;
   // Fetching never locks the app. Fence only the short DOM update, after
   // rechecking edits made while the request was in flight.
   liveTask=(async()=>{
     finishGuard(true);
     try{
       if(!await applySnapshot(current,source,token))return;
       if(prefetched===current)prefetched=null;
       refreshNeeded=false;
       status(editing?'Modifica condivisa':'Consultazione',dirty?'Aggiornamento ricevuto · salvataggio delle modifiche locali':`Revisione ${remote.revision} · sincronizzazione automatica`);
       buttons();
     }catch(error){if(frame===source&&token===generation&&!blocked){if(editing)freeze('Sincronizzazione non completata: '+error.message);else notice('Sincronizzazione non completata: '+error.message);}}
     finally{finishGuard(false);}
   })();
   try{await liveTask;}finally{liveTask=null;if(refreshAgain&&!blocked){refreshAgain=false;queueMicrotask(()=>refresh());}else if(prefetched&&prefetched.revision!==remote?.revision)queueLive(0);}
 }
 async function refresh(){
   if(inventoryRefreshing){refreshAgain=true;return;}
   if(!user||blocked)return;
   if(polling||loading||saving||finishing||navigationTask||liveTask||document.hidden){refreshAgain=true;return;}
   polling=true;const token=generation,revision=remote?.revision;
   try{const current=await requestState(prefetched||remote);if(token!==generation||revision!==remote?.revision||current.revision<minimumSnapshotRevision||saving||finishing||blocked){if(!blocked)refreshAgain=true;return;}
     // Incoming versions stay separate until the current local draft is clean.
     connectionNeedsRecovery=false;buttons();prefetched=current;
     if(current.revision!==remote.revision||refreshNeeded){refreshNeeded=true;buttons();await applyLive();}
   }catch(error){if(token===generation&&!finishing&&!blocked){if(error.status===401){if(ready)keepDraft();await start({user:null,csrf:null});$('loginError').textContent='La sessione è scaduta. Accedi di nuovo.';}else if(editing)freeze('Connessione al VPS non disponibile.');else{connectionNeedsRecovery=true;status('Non connesso','Dati visualizzati non aggiornati.');buttons();}}}
   finally{polling=false;if(refreshAgain&&!blocked&&!loading&&!saving&&!finishing&&!navigationTask&&!liveTask&&!document.hidden&&user){refreshAgain=false;queueMicrotask(()=>refresh());}}
 }
 async function navigate(view){
   const client=cloud(),source=frame,token=generation;
   if(client?.navigationBusy()){notice('Hai un modulo aperto, ad esempio un rapporto di intervento o una bozza fattura. Completa il salvataggio oppure chiudilo con il pulsante Chiudi; il cambio di sezione è sospeso finché resta aperto.');return;}
   navigationView=view;
   const display=()=>queueMicrotask(()=>{if(frame===source&&token===generation&&!blocked)client.navigate(navigationView||view);});
   if(navigationTask){if(!navigationDraining)display();return navigationTask;}
   const clean=!dirty&&!pending&&!saving&&client.settleDelay()===0;
   navigationDraining=!clean;
   // Display a clean section immediately. Network latency only delays its data,
   // never the menu response; further section clicks share the same request.
   if(clean)display();
   navigationTask=(async()=>{
   try{
     // Never advance the versions of unseen records before committing local edits.
     // A conflicting stale write still stops here and preserves its draft.
     await flush({navigation:true});
     if(frame!==source||token!==generation||blocked)return;
     navigationDraining=false;
     finishGuard(true);
     if(!clean)client.navigate(navigationView);
     const current=await requestState(prefetched||remote);
     if(frame!==source||token!==generation||blocked)return;
     if(!await applySnapshot(current,source,token))return;
     prefetched=null;refreshNeeded=false;lastView=client.view();
     status(editing?'Modifica condivisa':'Consultazione',`Revisione ${remote.revision} · sincronizzazione automatica`);
     if(!hasDrafts())notice('');buttons();
   }catch(error){
     if(frame!==source||token!==generation||blocked)return;
     if(error.status===401){await start({user:null,csrf:null});$('loginError').textContent='La sessione è scaduta. Accedi di nuovo.';}
     else if(editing)freeze('Sincronizzazione non completata: '+error.message);
     else notice('Sincronizzazione non completata: '+error.message);
   }finally{navigationDraining=false;finishGuard(false);}
   })();
   try{await navigationTask;}finally{navigationTask=null;navigationView=null;if(refreshAgain&&!blocked){refreshAgain=false;queueMicrotask(()=>refresh());}}
 }
 async function start(session){
   if(updateLeaving)return;
   WorkshopCloudConflicts.clear();
   clearTimeout(liveTimer);refreshAgain=false;connectionNeedsRecovery=false;userAppearance=session.appearance||null;generation++;
   user=session.user;csrf=session.csrf;prefetched=null;operatingAddressSupported=session.features?.operatingAddress===true;inventoryCountSupported=session.features?.inventoryCount===4;inventoryCountSalesSupported=session.features?.inventoryCountSales===1;inventoryNewStockSupported=session.features?.inventoryNewStock===1;workReportsSupported=session.features?.workReports===1;recoveryAvailable=typeof session.passwordResetAvailable==='boolean'?session.passwordResetAvailable:null;if(!user){clearTimeout(frameTimer);clearTimeout(saveTimer);events?.close();loading=false;ready=false;editing=false;blocked=true;cloud()?.mode(false);$('workspace').hidden=true;$('loginPanel').hidden=false;showAccess('login');return;}
   editing=user.role!=='viewer';blocked=false;dirty=false;pending=null;notice('');$('management').hidden=true;$('more').setAttribute('aria-expanded','false');
   draftArchiveWarning=!archiveDraft();if(draftArchiveWarning)retainedDraft ||= readDraft();
   $('workspace').hidden=false;$('loginPanel').hidden=true;$('identity').textContent=user.username+' · '+({admin:'Amministratore',operator:'Operatore',viewer:'Consultazione'}[user.role]||user.role);
   const token=++generation;loading=true;ready=false;remote=null;status('Connessione…','Caricamento archivio dal VPS…');buttons();
   try{
     const snapshot=await request('state');if(token!==generation)return;
     loadFrame(snapshot);if(draftArchiveWarning)notice('Archivio aggiornato. Una bozza precedente è ancora disponibile in questa scheda: scaricala prima di iniziare nuove modifiche, perché lo spazio per conservarne una copia è esaurito.');buttons();
   }catch(error){if(token!==generation)return;if(error.status===401){await start({user:null,csrf:null});$('loginError').textContent='La sessione è scaduta. Accedi di nuovo.';}else connectionFailure(error);}
 }
 $('loginForm').onsubmit=async event=>{event.preventDefault();$('loginError').textContent='';const button=event.target.querySelector('button');button.disabled=true;try{const session=await request('login','POST',{username:$('username').value,password:$('password').value});$('password').value='';await start(session);}catch(error){$('loginError').textContent=error.message;}finally{button.disabled=false;}};
 $('forgotPassword').onclick=()=>{showAccess('recovery');$('recoveryResult').textContent='';recoveryStatus();if(recoveryAvailable!==false)$('recoveryEmail').focus();};
 $('recoveryBack').onclick=()=>{showAccess('login');$('recoveryError').textContent='';$('recoveryResult').textContent='';};
 $('resetBack').onclick=()=>{resetToken=null;location.replace('/');};
 $('recoveryForm').onsubmit=async event=>{
   event.preventDefault();$('recoveryResult').textContent='';$('recoveryError').textContent='';
   if(recoveryAvailable===false){recoveryStatus();return;}
   const button=event.target.querySelector('button[type="submit"]');button.disabled=true;
   try{await resetRequest('request',{email:$('recoveryEmail').value.trim()});$('recoveryEmail').value='';$('recoveryResult').textContent='Se l’indirizzo è associato a un account, riceverai un link per cambiare la password.';}
   catch(error){if(error.code==='RESET_UNAVAILABLE'){recoveryAvailable=false;recoveryStatus();}else $('recoveryError').textContent='Impossibile inviare la richiesta ora. Riprova tra poco.';}
   finally{if(recoveryAvailable!==false)button.disabled=false;}
 };
 $('resetForm').onsubmit=async event=>{
   event.preventDefault();$('resetError').textContent='';$('resetResult').textContent='';
   if(!resetToken){$('resetError').textContent='Link non valido o scaduto. Richiedine uno nuovo dalla pagina di accesso.';return;}
   const password=$('newPassword').value;
   if(password!==$('confirmPassword').value){$('resetError').textContent='Le password non corrispondono.';return;}
   const button=event.target.querySelector('button[type="submit"]');button.disabled=true;
   try{await resetRequest('confirm',{token:resetToken,password});resetToken=null;$('newPassword').value='';$('confirmPassword').value='';button.hidden=true;$('resetResult').textContent='Password cambiata. Ora puoi accedere con la nuova password.';}
   catch(error){$('resetError').textContent=error.code==='RESET_INVALID'?'Link non valido o scaduto. Richiedine uno nuovo dalla pagina di accesso.':error.message;button.disabled=false;}
 };
 function toggleManagement(){if(updateLeaving)return;$('management').hidden=!$('management').hidden;$('more').setAttribute('aria-expanded',String(!$('management').hidden));}
 $('more').onclick=toggleManagement;
 function download(value,name){const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 $('export').onclick=async()=>{if(updateLeaving)return;try{const current=await request('state');download({format:'officina-cloud-export',exportedAt:new Date().toISOString(),...current},'officina-dati-'+new Date().toISOString().slice(0,10)+'.json');}catch(error){notice(error.message);}};
 $('recover').onclick=()=>{const drafts=archivedDrafts(),seen=new Set();for(const raw of [retainedDraft,readDraft()])if(raw&&!seen.has(raw)){seen.add(raw);try{drafts.push(JSON.parse(raw));}catch{}}if(!drafts.length)drafts.push({baseRevision:remote?.revision,state:stateNow(),pending,forms:cloud()?.formDraft()});download({format:'officina-cloud-drafts',drafts},'officina-bozze-da-confrontare.json');const wasWarning=draftArchiveWarning;retainedDraft=null;if(wasWarning)notice('Bozza scaricata. Elimina le copie già verificate da Gestione per liberare spazio.');buttons();};
 $('managementRecover').onclick=()=>$('recover').click();
 $('clearDrafts').onclick=()=>{if(updateLeaving||dirty||pending||saving)return;if(!confirm('Hai scaricato e verificato tutte le bozze? Verranno eliminate solo le copie di recupero di questa scheda.'))return;try{for(const key of Object.keys(sessionStorage))if(key===draftKey||key.startsWith(archivePrefix))sessionStorage.removeItem(key);volatileDraft=null;retainedDraft=null;draftArchiveWarning=false;notice('Bozze di questa scheda eliminate.');buttons();}catch{notice('Impossibile eliminare le bozze.');}};
 $('reload').onclick=async()=>{
   if(saving||finishing||loading)return;
   if(ready&&(blocked||busy())&&!confirm('Ricaricare i dati del VPS? Le modifiche non confermate saranno conservate in una bozza da confrontare.'))return;
   if(ready&&(blocked||busy()))keepDraft();finishGuard(true);
   try{
     await cloud()?.appearanceFlush?.();
     if(pending){try{await request(pending.path,pending.method,pending.data);}catch(error){if(![400,403,409,413].includes(error.status))throw error;}}
     draftArchiveWarning=!archiveDraft();if(draftArchiveWarning)retainedDraft ||= readDraft();const current=await request('state');pending=null;dirty=false;blocked=false;editing=user.role!=='viewer';loadFrame(current);notice(draftArchiveWarning?'Dati del server ricaricati. La bozza precedente è ancora disponibile da scaricare; scaricala prima di iniziare nuove modifiche, perché lo spazio per conservarne una copia è esaurito.':'');
   }catch(error){if(error.status===401){await start({user:null,csrf:null});$('loginError').textContent='La sessione è scaduta. Accedi di nuovo.';}else notice('Riconnessione non completata: '+error.message);}finally{finishGuard(false);}
 };
 $('import').onchange=async event=>{
   const file=event.target.files[0];if(!file)return;if(saving||finishing||dirty||loading){notice('Attendi il completamento delle operazioni prima di importare.');event.target.value='';return;}
   finishGuard(true);clearTimeout(saveTimer);
   try{if(user.role!=='admin'||!editing||remote.revision!==0)throw Error('Importazione disponibile solo all’amministratore su archivio nuovo.');if(file.size>16*1024*1024)throw Error('Archivio troppo grande (massimo 16 MB).');const data=JSON.parse(await file.text()),state=data.state||data;if(!confirm('Importare questo archivio nel VPS vuoto?'))return;
     await cloud()?.appearanceFlush?.();
     pending={path:'import',method:'POST',data:{baseRevision:0,mutationId:crypto.randomUUID(),clientId,state},state};dirty=true;keepDraft();await request(pending.path,pending.method,pending.data);pending=null;dirty=false;volatileDraft=null;sessionStorage.removeItem(draftKey);loadFrame(await request('state'));notice('Archivio importato. Verifica clienti, appuntamenti e quantità di magazzino.');
   }catch(error){if(pending)freeze('Importazione non confermata: '+error.message);else notice(error.message);}finally{event.target.value='';finishGuard(false);}
 };
 async function logout(){if(leaving||loading||finishing)return;leaving=true;try{if(blocked){if(!confirm('Uscire conservando la bozza in questa scheda?'))return;if(!archiveDraft())return;}else{await flush();if(cloud()?.navigationBusy()){if(!confirm('Il modulo aperto non è stato completato. Uscire conservandone una bozza?'))return;keepDraft();if(!archiveDraft())return;}}finishGuard(true);await cloud()?.appearanceFlush?.();await request('logout','POST',{});events?.close();frame?.remove();frame=null;user=null;remote=null;await start({user:null,csrf:null});}catch(error){notice(error.message);}finally{finishGuard(false);leaving=false;}}
 $('logout').onclick=logout;
 window.addEventListener('beforeunload',event=>{if(updateLeaving?.prepared&&!dirty&&!saving&&!pending&&!cloud()?.appearancePending&&!hasDrafts()&&(!user||same(stateNow(),baseline)))return;if(ready&&!same(stateNow(),baseline))dirty=true;if(dirty||saving||pending||cloud()?.appearancePending||(editing&&cloud()?.busy())){keepDraft();event.preventDefault();event.returnValue='';}});
 window.addEventListener('offline',()=>{if(editing)freeze('Il dispositivo è offline.');else if(user){connectionNeedsRecovery=true;status('Non connesso','Il dispositivo è offline. Dati visualizzati non aggiornati.');buttons();}});
 document.addEventListener('visibilitychange',()=>{if(document.hidden&&editing)save();else if(!document.hidden)refresh();});
 setInterval(refresh,3000);
 if(resetPage){showAccess('reset');if(!resetToken){$('resetError').textContent='Link non valido o scaduto. Richiedine uno nuovo dalla pagina di accesso.';$('resetForm').querySelector('button[type="submit"]').disabled=true;}}
 else request('session').then(start).catch(error=>{$('loginError').textContent='Server non raggiungibile: '+error.message;});
})();
