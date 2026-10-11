import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { transaction, audit, hash, safeEqual } from './database.mjs';
import { HttpError } from './validation.mjs';
import { validateInventoryCount, recoverLegacyInventoryCount, adjustInventoryCountForSales } from './inventory-count.mjs';
const R=createRequire(import.meta.url)('../cloud-records.js');
const D=createRequire(import.meta.url)('../cloud-conflict-details.js');
const fail=(status,code,message,extra={})=>{throw new HttpError(status,code,message,extra);};
const ID=/^[A-Za-z0-9_-]{8,128}$/;
const version=v=>Number.isSafeInteger(v)&&v>=0;
const MAX_CONFLICTS=30,MAX_RELATED=20,MAX_FIELDS=24,MAX_AUDIT_RECORDS=200,MAX_AUDIT_BYTES=192*1024,MAX_CONFLICT_BYTES=256*1024;
const text=(value,limit=500)=>typeof value==='string'?value.slice(0,limit):typeof value==='number'||typeof value==='boolean'?String(value):'';
const label=k=>{try{return R.label(k);}catch{return 'Voce';}};
const publicField=f=>typeof f?.key==='string'&&!/password|passwd|token|secret|csrf|authorization|cookie|credential|private.?key/i.test(f.key);
function describe(k,value){
 const described=D.describe(k,value);
 return {title:text(described.title,240),fields:(described.fields||[]).filter(publicField).slice(0,MAX_FIELDS).map(f=>({key:text(f.key,200),label:text(f.label,160),value:text(f.value)}))};
}
function changes(k,before,after){
 const all=D.difference(k,before,after).filter(publicField);
 return {changes:all.slice(0,MAX_FIELDS).map(f=>({key:text(f.key,200),label:text(f.label,160),before:text(f.before),after:text(f.after)})),...(all.length>MAX_FIELDS?{omittedChanges:all.length-MAX_FIELDS}:{})};
}
const inventoryKey=k=>{try{return R.inventoryRecord(k);}catch{return false;}};
function savedSummaries(records,before){
 const summaries=[];let bytes=0;
 for(const c of records){
  if(summaries.length>=MAX_AUDIT_RECORDS)break;
  const previous=before.get(c.key),summary={key:c.key,title:describe(c.key,c.value===null?previous:c.value).title,...changes(c.key,previous,c.value),relatedKeys:R.dependencies([c],before)};
  const size=Buffer.byteLength(JSON.stringify(summary));if(bytes+size>MAX_AUDIT_BYTES)break;
  summaries.push(summary);bytes+=size;
 }
 return {summaryVersion:1,summaries,...(summaries.length<records.length?{omittedSummaries:records.length-summaries.length}:{})};
}

export function recordStore(db,validateState,now,validateCommit=()=>{}){
 const row=()=>db.prepare('SELECT revision,payload FROM state WHERE id=1').get();
 const getVersion=k=>db.prepare('SELECT revision FROM record_versions WHERE key=?').get(k)?.revision||0;
 const putVersion=(k,v)=>db.prepare('INSERT INTO record_versions(key,revision) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET revision=excluded.revision').run(k,v);
 function conflictPayload(keys,expected,before){
  const events=new Map();
  function eventAt(revision){
   if(!events.has(revision)){
    const saved=db.prepare("SELECT at,username,revision,details FROM audit WHERE revision=? AND action IN ('records-saved','initial-import') ORDER BY id DESC LIMIT 1").get(revision);
    let details;try{details=JSON.parse(saved?.details||'{}');}catch{details={};}
    events.set(revision,saved?{...saved,details}:null);
   }
   return events.get(revision);
  }
  function affects(event,k){
   if(!event)return false;
   const direct=Array.isArray(event.details.keys)?event.details.keys:[],dependencies=Array.isArray(event.details.dependencyKeys)?event.details.dependencyKeys:[];
   return k==='domain:inventory'?direct.some(inventoryKey):direct.includes(k)||dependencies.includes(k);
  }
  function detail(k,event=eventAt(getVersion(k)),summary){
   const current=describe(k,before.has(k)?before.get(k):k!=='domain:inventory'&&getVersion(k)>0?null:undefined);
   const attributed=affects(event,k)||!!summary;
   const source=summary||(event?.details.summaries||[]).find(s=>s.key===k);
   const delta=source?{changes:(source.changes||[]).filter(publicField).slice(0,MAX_FIELDS).map(c=>({key:text(c.key,200),label:text(c.label,160),before:text(c.before),after:text(c.after)})),...(source.omittedChanges?{omittedChanges:source.omittedChanges}:{})}:{changes:[]};
   return {title:source?.title?text(source.title,240):current.title,updatedBy:attributed&&event?.username?text(event.username,64):null,updatedAt:attributed&&Number.isSafeInteger(event?.at)?event.at:null,...delta,currentFields:current.fields};
  }
  function relatedEntry(k,event,summary){return {key:k,label:label(k),detail:detail(k,event,summary)};}
  function conflict(k){
   const last=eventAt(getVersion(k)),info=detail(k,last);
   if(k==='domain:inventory'){
    // Newest change for each article since this device's inventory version.
    // Both the scan and the visible list are bounded; no full snapshots leave
    // the server, including for old audit entries that only contain keys.
    const history=db.prepare("SELECT at,username,revision,details FROM audit WHERE revision>? AND revision<=? AND action IN ('records-saved','initial-import') ORDER BY revision DESC,id DESC LIMIT 64").all(expected(k),getVersion(k));
    const seen=new Set(),related=[];let omitted=0;
    for(const saved of history){
     let data;try{data=JSON.parse(saved.details||'{}');}catch{continue;}
     const event={...saved,details:data};
     for(const key of Array.isArray(data.keys)?data.keys:[]){
      if(!inventoryKey(key)||seen.has(key))continue;seen.add(key);
      if(related.length>=MAX_RELATED){omitted++;continue;}
      related.push(relatedEntry(key,event,(data.summaries||[]).find(s=>s.key===key)));
     }
    }
    info.title='Magazzino collegato all’intervento';info.currentFields=[];info.related=related;
    if(omitted)info.omittedRelated=omitted;
    if(history.length===64)info.historyLimited=true;
   }else if(last&&affects(last,k)){
    // A payment or transfer may fence an unchanged account. Attribute that
    // operation and describe its actual changed record instead of claiming
    // that the account's values were edited.
    const related=(last.details.summaries||[]).filter(s=>s.key!==k&&Array.isArray(s.relatedKeys)&&s.relatedKeys.includes(k));
    if(related.length){info.related=related.slice(0,MAX_RELATED).map(s=>relatedEntry(s.key,last,s));if(related.length>MAX_RELATED)info.omittedRelated=related.length-MAX_RELATED;}
   }
   return {key:k,label:k==='domain:inventory'?'Magazzino collegato all’intervento':label(k),detail:info};
  }
  const conflicts=[];let bytes=0;
  for(const k of keys.slice(0,MAX_CONFLICTS)){
   const entry=conflict(k);let size=Buffer.byteLength(JSON.stringify(entry));
   while(bytes+size>MAX_CONFLICT_BYTES&&entry.detail.related?.length){entry.detail.related.pop();entry.detail.omittedRelated=(entry.detail.omittedRelated||0)+1;size=Buffer.byteLength(JSON.stringify(entry));}
   if(bytes+size>MAX_CONFLICT_BYTES)break;
   conflicts.push(entry);bytes+=size;
  }
  return {conflicts,...(keys.length>conflicts.length?{omittedConflicts:keys.length-conflicts.length}:{})};
 }
 // Upgrade the old snapshot once, before accepting requests. Stable identities
 // and the migration marker commit together; a restart cannot reassign IDs.
 transaction(db,()=>{if(db.prepare("SELECT value FROM metadata WHERE key='record-protocol'").get())return;const current=row();if(current.payload){const state=R.normalize(JSON.parse(current.payload),randomUUID);validateState(state);const records=R.flatten(state);R.inflate(records);for(const k of records.keys())putVersion(k,current.revision);putVersion('domain:inventory',current.revision);db.prepare('UPDATE state SET payload=? WHERE id=1').run(JSON.stringify(state));}db.exec("DELETE FROM lease; INSERT INTO metadata(key,value) VALUES('record-protocol','2');");});
 transaction(db,()=>{
   if(db.prepare("SELECT value FROM metadata WHERE key='inventory-count-protocol'").get())return;
   const current=row();
   if(current.payload){
     const state=JSON.parse(current.payload),domain=getVersion('domain:inventory');
     const base=JSON.parse(state.storage['officina.inventory.v1']||'{}')?.countDraft?.baseInventoryVersion;
     const records=Number.isSafeInteger(base)?db.prepare("SELECT revision,action,details FROM audit WHERE revision>? AND revision<=? AND action IN ('records-saved','initial-import') ORDER BY revision").all(base,domain):[];
     const repaired=recoverLegacyInventoryCount(state,domain,records);
     if(repaired!==null){
       state.storage['officina.inventory.v1']=repaired;validateState(state);
       const revision=current.revision+1;
       db.prepare('UPDATE state SET revision=?,payload=?,updated_at=? WHERE id=1').run(revision,JSON.stringify(state),now());
       putVersion(R.key('storage','officina.inventory.v1'),revision);
       audit(db,null,'inventory-count-upgraded',revision,{previousInventoryVersion:domain});
     }
   }
   db.prepare("INSERT INTO metadata(key,value) VALUES('inventory-count-protocol','2')").run();
 });
 // Inventory count drafts used to share one storage record. Seed versions for
 // the new per-item records before accepting requests so an existing draft
 // remains editable after upgrading the server.
 transaction(db,()=>{
   if(db.prepare("SELECT value FROM metadata WHERE key='inventory-count-records'").get())return;
   const current=row();
   if(current.payload)for(const key of R.flatten(JSON.parse(current.payload)).keys())if(!getVersion(key))putVersion(key,current.revision);
   db.prepare("INSERT INTO metadata(key,value) VALUES('inventory-count-records','1')").run();
 });
 function read(){const current=row();return {protocol:2,revision:current.revision,state:current.payload?JSON.parse(current.payload):null,versions:Object.fromEntries(db.prepare('SELECT key,revision FROM record_versions').all().map(v=>[v.key,v.revision]))};}
 function commit(auth,data,importing=false){
   if(!['operator','admin'].includes(auth.role))fail(403,'READ_ONLY','Questo account può solo consultare i dati.');
   if(!ID.test(data.clientId||'')||!ID.test(data.mutationId||''))fail(400,'IDENTITY','Identificativo operazione non valido.');
   const requestHash=hash(JSON.stringify([importing,data]));
   return transaction(db,()=>{
     const receipt=db.prepare('SELECT * FROM receipts WHERE mutation_id=?').get(data.mutationId);
     if(receipt){if(receipt.session_id!==auth.sessionId||!safeEqual(receipt.request_hash,requestHash)||!receipt.result)fail(409,'IDEMPOTENCY_CONFLICT','Identificativo già usato per un’altra operazione.');return {...JSON.parse(receipt.result),replayed:true};}
     const current=row(),before=current.payload?R.flatten(JSON.parse(current.payload)):new Map(),revision=current.revision+1;let changes,state,dependencies=[],serverGeneratedKeys=[];
     if(importing){
       if(auth.role!=='admin')fail(403,'ADMIN_REQUIRED','Importazione riservata all’amministratore.');
       if(current.revision!==0||data.baseRevision!==0)fail(409,'IMPORT_NOT_EMPTY','Importazione consentita solo su archivio nuovo.');
       validateState(data.state);
       try{state=R.normalize(data.state,randomUUID);changes=R.diff(null,state,{});}catch(e){fail(400,'INVALID_RECORD',e.message);}
     }else{
       if(data.protocol!==2)fail(409,'UPGRADE_REQUIRED','Ricarica la pagina per usare il salvataggio condiviso.');
       if(!Array.isArray(data.changes)||!data.changes.length||data.changes.length>20000||!data.versions||typeof data.versions!=='object'||Array.isArray(data.versions))fail(400,'CHANGES','Elenco modifiche non valido.');
       changes=data.changes;
     }
     const seen=new Set(),conflicts=[];
     for(const c of changes){if(!c||typeof c.key!=='string'||c.key.length>2000||seen.has(c.key)||!version(c.expectedVersion)||!Object.hasOwn(c,'value'))fail(400,'CHANGE','Modifica non valida o duplicata.');seen.add(c.key);if(getVersion(c.key)!==c.expectedVersion)conflicts.push(c.key);if(c.value===null&&!before.has(c.key)&&!conflicts.includes(c.key))fail(400,'MISSING_RECORD','La voce da eliminare non esiste.');}
     if(conflicts.length)fail(409,'RECORD_CONFLICT','Una voce è stata modificata da un altro operatore. Nessuna parte di questo salvataggio è stata applicata.',conflictPayload(conflicts,k=>changes.find(c=>c.key===k).expectedVersion,before));
     if(!importing){
       try{dependencies=R.dependencies(changes,before);if(R.needsInventoryGuard(changes,before))dependencies.push('domain:inventory');}catch{fail(400,'KEY','Chiave record non valida.');}
       const stale=dependencies.filter(k=>!version(data.versions[k]??0)||(data.versions[k]||0)!==getVersion(k));
       if(stale.length)fail(409,'DEPENDENCY_CONFLICT','Sono cambiati dati collegati a questa operazione. Aggiorna e verifica prima di riprovare.',conflictPayload([...new Set(stale)],k=>version(data.versions[k])?data.versions[k]:0,before));
       const next=new Map(before);for(const c of changes){if(c.value===null)next.delete(c.key);else next.set(c.key,c.value);}
       try{state=R.inflate(next);const canonical=R.flatten(state);for(const c of changes)if(c.value!==null&&R.stable(canonical.get(c.key))!==R.stable(c.value))fail(400,'NON_CANONICAL','Record non canonico.');}catch(e){if(e instanceof HttpError)throw e;fail(400,'INVALID_RECORD',e.message);}
       validateState(state);
       validateInventoryCount(before,state,getVersion('domain:inventory'),getVersion);
       serverGeneratedKeys=adjustInventoryCountForSales(before,state,revision,getVersion);
       if(serverGeneratedKeys.length)validateState(state);
     }
     validateCommit(state);
     const payload=JSON.stringify(state);if(Buffer.byteLength(payload)>16*1024*1024)fail(413,'TOO_LARGE','Archivio oltre il limite di 16 MB.');
     const previousInventoryVersion=getVersion('domain:inventory');
     db.prepare('UPDATE state SET revision=?,payload=?,updated_at=? WHERE id=1').run(revision,payload,now());
     const touched=new Set(changes.map(c=>c.key));
     // Reading/changing a payment, invoice or work linked to an account fences
     // stale changes to that account, even when its value did not change.
     for(const k of dependencies)if(k!=='domain:inventory')touched.add(k);
     for(const k of serverGeneratedKeys)touched.add(k);
     for(const k of touched)putVersion(k,revision);
     if(importing||changes.some(c=>R.inventoryRecord(c.key)))putVersion('domain:inventory',revision);
     const generated=new Set(serverGeneratedKeys),result={protocol:2,revision,previousRevision:current.revision,versions:Object.fromEntries([...touched].filter(k=>!generated.has(k)).map(k=>[k,revision])),previousInventoryVersion,inventoryVersion:getVersion('domain:inventory'),replayed:false,...(generated.size?{serverGeneratedChanges:true}:{})};
     db.prepare('INSERT INTO receipts(mutation_id,session_id,request_hash,revision,created_at,result) VALUES(?,?,?,?,?,?)').run(data.mutationId,auth.sessionId,requestHash,revision,now(),JSON.stringify(result));
     const audited=changes.filter(c=>!generated.has(c.key));if(generated.size){const after=R.flatten(state);for(const key of generated)audited.push({key,value:after.get(key)});}
     audit(db,auth,importing?'initial-import':'records-saved',revision,{clientId:data.clientId,mutationId:data.mutationId,keys:audited.map(c=>c.key),dependencyKeys:dependencies,...(generated.size?{serverGeneratedKeys:[...generated]}:{}),...savedSummaries(audited,before)});
     return result;
   });
 }
 return {read,commit};
}
