/* Protocol 2: stable records, optimistic versions and atomic change sets.
 * Shared by browser and server; never merge quantities by value equality. */
(function(root,factory){const api=factory(typeof module==='object'&&module.exports?require('./cloud-schema.js'):root.WorkshopCloudSchema);if(typeof module==='object'&&module.exports)module.exports=api;else root.WorkshopCloudRecords=api;})(globalThis,function(schema){
 'use strict';
 const rows=schema.selectors.slice(0,5), arrays=['officina-postit','officina-quotes-v1','officina-moduli-v1'], objects=['officina.customerFiscal.v1','officina-work-notes'], cash='ma-gomme-cashbook-v1';
 const key=(...parts)=>JSON.stringify(parts), clone=v=>structuredClone(v), inventory='officina.inventory.v1';
 const empty=()=>({schemaVersion:1,storage:{},dom:Object.fromEntries(schema.selectors.map(s=>[s,[]])),fields:{}});
 const stable=v=>JSON.stringify(sort(v));
 function sort(v){if(Array.isArray(v))return v.map(sort);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])]));return v;}
 function normalize(input,uuid){const state=clone(input||empty());for(const selector of rows){const seen=new Set();state.dom[selector]=state.dom[selector].filter(n=>typeof n!=='string'||n.trim());for(const node of state.dom[selector]){if(typeof node==='string')throw Error('Testo fuori dalle righe: '+selector);node.a||={};let id=node.a['data-cloud-id'];if(!id&&uuid)id=node.a['data-cloud-id']=uuid();if(typeof id!=='string'||!id||id.length>128||seen.has(id))throw Error('Identificativo riga mancante o duplicato: '+selector);seen.add(id);}}
   // Historical browser caches must never resurrect deleted stock rows.
   for(const [name,prop]of [['officina-table-import-v1','stocks'],['officina.deliveryLoads.v1','stock']])if(state.storage[name]){const data=JSON.parse(state.storage[name]);if(data&&!Array.isArray(data)&&typeof data==='object'){delete data[prop];state.storage[name]=JSON.stringify(data);}}
   return state;
 }
 function flatten(input){const state=normalize(input),out=new Map();for(const selector of schema.selectors){if(rows.includes(selector)){for(const node of state.dom[selector])out.set(key('row',selector,node.a['data-cloud-id']),node);}else if(state.dom[selector].length)out.set(key('dom',selector),state.dom[selector]);}
   for(const name of schema.fields)if(Object.hasOwn(state.fields,name))out.set(key('field',name),state.fields[name]);
   for(const [name,raw]of Object.entries(state.storage)){
     if(name===inventory){
       let data;try{data=JSON.parse(raw);}catch{out.set(key('storage',name),raw);continue;}
       const draft=data?.countDraft;
       if(!draft||!Array.isArray(draft.items)){out.set(key('storage',name),raw);continue;}
       const base={...data};delete base.countDraft;out.set(key('storage',name),JSON.stringify(base));
       const metadata={...draft};delete metadata.items;delete metadata.baseStockVersions;
       out.set(key('inventory-draft'),{metadata,hasBaseStockVersions:Object.hasOwn(draft,'baseStockVersions')});
       draft.items.forEach((item,index)=>{
         const stockKey=key('row','#stockRows',item.cloudId),baseStockVersion=draft.baseStockVersions?.[stockKey];
         out.set(key('inventory-count-item',draft.id,item.cloudId),{item,index,baseStockVersion:Number.isSafeInteger(baseStockVersion)?baseStockVersion:null});
       });
       continue;
     }
     if(arrays.includes(name)){const list=JSON.parse(raw);if(!Array.isArray(list))throw Error('Archivio non valido: '+name);const seen=new Set();for(const item of list){if(!item||typeof item.id!=='string'||!item.id||seen.has(item.id))throw Error('Identificativo duplicato o mancante: '+name);seen.add(item.id);out.set(key('item',name,item.id),item);}}
     else if(objects.includes(name)){const data=JSON.parse(raw);if(!data||Array.isArray(data)||typeof data!=='object')throw Error('Archivio non valido: '+name);for(const [id,value]of Object.entries(data))out.set(key('entry',name,id),value);}
     else if(name===cash){const data=JSON.parse(raw);if(data.version!==1||!Number.isInteger(data.nextId)||!Array.isArray(data.accounts)||!Array.isArray(data.payments))throw Error('Cassa non valida.');if(data.nextId!==1)out.set(key('cash-meta'),{version:1,nextId:data.nextId});for(const group of ['accounts','payments']){const seen=new Set();for(const item of data[group]){if(!item||typeof item.id!=='string'||!item.id||seen.has(item.id))throw Error('Identificativo cassa non valido.');seen.add(item.id);out.set(key('cash',group,item.id),item);}}}
     else out.set(key('storage',name),raw);
   }return out;
 }
 function inflate(records){const state=empty(),lists=Object.fromEntries(arrays.map(n=>[n,[]])),maps=Object.fromEntries(objects.map(n=>[n,{}])),book={version:1,nextId:1,accounts:[],payments:[]};let inventoryDraft=null;const inventoryItems=[];
   for(const [encoded,value]of records){let parts;try{parts=JSON.parse(encoded);}catch{throw Error('Chiave record non valida.');}if(!Array.isArray(parts)||encoded!==key(...parts))throw Error('Chiave record non canonica.');const [kind,name,id]=parts;
     if(kind==='row'&&parts.length===3&&rows.includes(name)&&typeof id==='string'&&id&&id.length<=128&&value?.a?.['data-cloud-id']===id)state.dom[name].push(value);
     else if(kind==='dom'&&parts.length===2&&schema.selectors.includes(name)&&!rows.includes(name)&&Array.isArray(value))state.dom[name]=value;
     else if(kind==='field'&&parts.length===2&&schema.fields.includes(name)&&typeof value==='string')state.fields[name]=value;
     else if(kind==='item'&&parts.length===3&&arrays.includes(name)&&value?.id===id)lists[name].push(value);
     else if(kind==='entry'&&parts.length===3&&objects.includes(name)&&typeof id==='string'&&!['__proto__','constructor','prototype'].includes(id))Object.defineProperty(maps[name],id,{value,enumerable:true,configurable:true,writable:true});
     else if(kind==='cash'&&parts.length===3&&['accounts','payments'].includes(name)&&value?.id===id)book[name].push(value);
     else if(kind==='cash-meta'&&parts.length===1&&value?.version===1&&Number.isInteger(value.nextId))book.nextId=value.nextId;
     else if(kind==='inventory-draft'&&parts.length===1&&value?.metadata&&typeof value.metadata.id==='string'&&typeof value.hasBaseStockVersions==='boolean')inventoryDraft=value;
     else if(kind==='inventory-count-item'&&parts.length===3&&typeof name==='string'&&typeof id==='string'&&value?.item?.cloudId===id&&Number.isSafeInteger(value.index)&&value.index>=0&&(value.baseStockVersion===null||Number.isSafeInteger(value.baseStockVersion)&&value.baseStockVersion>=0))inventoryItems.push({draftId:name,...value});
     else if(kind==='storage'&&parts.length===2&&schema.storageKeys.includes(name)&&![...arrays,...objects,cash].includes(name)&&typeof value==='string')state.storage[name]=value;
     else throw Error('Record non ammesso: '+encoded);
   }
   for(const [n,v]of Object.entries(lists))state.storage[n]=JSON.stringify(v);for(const [n,v]of Object.entries(maps))state.storage[n]=JSON.stringify(v);
   if(inventoryDraft){const data=JSON.parse(state.storage[inventory]||'{}'),draft=clone(inventoryDraft.metadata),items=inventoryItems.filter(value=>value.draftId===draft.id).sort((a,b)=>a.index-b.index);draft.items=items.map(value=>clone(value.item));if(inventoryDraft.hasBaseStockVersions){draft.baseStockVersions={};for(const value of items)if(value.baseStockVersion!==null)draft.baseStockVersions[key('row','#stockRows',value.item.cloudId)]=value.baseStockVersion;}data.countDraft=draft;state.storage[inventory]=JSON.stringify(data);}
   else if(inventoryItems.length)throw Error('Righe di conteggio senza intestazione inventario.');
   const ids=new Set(book.accounts.map(a=>a.id));if(book.accounts.some(a=>!a.meta||!a.state)||book.payments.some(p=>!ids.has(p.accountId)||!Number.isInteger(p.cents)||p.cents<0))throw Error('Riferimenti cassa non validi.');state.storage[cash]=JSON.stringify(book);
   return state;
 }
 function diff(before,after,versions={}){const a=flatten(before),b=flatten(after),result=[];for(const k of new Set([...a.keys(),...b.keys()]))if(stable(a.get(k))!==stable(b.get(k)))result.push({key:k,expectedVersion:versions[k]||0,value:b.has(k)?b.get(k):null});return result;}
 // Count drafts and calendar reminders are metadata. They have their own
 // optimistic record version and must not invalidate the stock they describe.
 function inventoryRecord(k){const [kind,name]=JSON.parse(k);return kind==='row'&&name==='#stockRows'||kind==='storage'&&['officina.deliveryLoads.v1','officina-table-import-v1'].includes(name);}
 const rowText=node=>typeof node==='string'?node:node?.t==='select'?'':(node?.c||[]).map(rowText).join(' ');
 function findNode(node,test){if(!node||typeof node==='string')return null;if(test(node))return node;for(const child of node.c||[]){const found=findNode(child,test);if(found)return found;}return null;}
 const hasClass=(node,name)=>String(node?.a?.class||'').split(/\s+/).includes(name);
 function workInventoryState(node,selector){
   if(!node)return null;
   const attrs=node.a||{},select=findNode(node,n=>n.t==='select'&&(hasClass(n,'status-select')||hasClass(n,'parking-status')||(n.c||[]).some(option=>option?.t==='option'&&['PROGRAMMATO','ACCETTATO','IN LAVORAZIONE','COMPLETATO','RITIRATO'].includes(option.a?.value))));
   const options=(select?.c||[]).filter(n=>n?.t==='option');
   const option=options.find(n=>Object.hasOwn(n.a||{},'selected'))||options[0];
   // Only the selected status matters. Every real status menu also contains
   // unselected COMPLETATO options, which are not a stock operation.
   const status=select?String(option?.a?.value??rowText(option)).trim():String(rowText(node).match(/\b(?:COMPLETATO|RITIRATO)\b/)?.[0]||'');
   const deductions=[];
   for(const name of ['data-agenda-tyre-deductions','data-parking-tyre-deductions','data-agenda-consumable-deductions','data-parking-consumable-deductions']){
     let entries;try{entries=JSON.parse(attrs[name]||'[]');}catch{entries=attrs[name];}
     // Request signatures and cached profit may be upgraded without moving
     // stock. Preserve fences for actual article/quantity/request changes.
     deductions.push(Array.isArray(entries)?entries.map(e=>({stockId:e?.stockId,quantity:e?.quantity,requested:e?.requested??e?.quantity})):entries);
   }
   let lines;const linesAttr=selector==='#agendaRows'?'data-acceptance-lines':'data-work-lines';
   try{lines=JSON.parse(attrs[linesAttr]||'[]');}catch{lines=attrs[linesAttr];}
   const input=findNode(node,n=>n.t==='input'&&hasClass(n,'work-input'));
   const description=value=>String(value||'').trim().replace(/\s+/g,' ').toLowerCase();
   const work=Array.isArray(lines)&&lines.length?lines.map(line=>description(line?.description)):typeof lines==='string'?{invalid:lines}:[description(input?.a?.value??rowText(node.c?.[3]))].filter(Boolean);
   const completion=attrs['data-completed-date']||'',removed=attrs['data-removed-from-parking']==='true';
   return {status,used:['COMPLETATO','RITIRATO'].includes(status),deductions,work,completion,removed};
 }
 const materialWork=state=>!!state&&(state.used||state.completion||state.removed||state.deductions.some(entries=>!Array.isArray(entries)||entries.length));
 function needsInventoryGuard(changes,before){return changes.some(c=>{
   const [kind,name]=JSON.parse(c.key);if(kind!=='row'||!['#agendaRows','#agenda .parking-section .card'].includes(name))return false;
   const previous=workInventoryState(before.get(c.key),name),next=workInventoryState(c.value,name);
   // Adding, removing or transferring a completed work can restore/use stock.
   if(!previous||!next)return materialWork(previous)||materialWork(next);
   if(previous.used!==next.used||stable(previous.deductions)!==stable(next.deductions))return true;
   if(!materialWork(previous)&&!materialWork(next))return false;
   return previous.status!==next.status||stable(previous.work)!==stable(next.work)||previous.completion!==next.completion||previous.removed!==next.removed;
 });}
 function dependencies(changes,before){const keys=new Set();
   const account=id=>{if(id)keys.add(key('cash','accounts',id));};
   const sourceRow=(selector,id)=>{if(['#agendaRows','#agenda .parking-section .card'].includes(selector)&&id){const encoded=key('row',selector,id);if(before.has(encoded))keys.add(encoded);}};
   let cashRows;
   const work=id=>{if(!id)return;account(id);if(!cashRows){cashRows=new Map();for(const [encoded,node]of before){const [kind,selector]=JSON.parse(encoded),cashId=node?.a?.['data-cash-account-id'];if(kind==='row'&&['#agendaRows','#agenda .parking-section .card'].includes(selector)&&cashId){if(!cashRows.has(cashId))cashRows.set(cashId,[]);cashRows.get(cashId).push(encoded);}}}for(const encoded of cashRows.get(id)||[])keys.add(encoded);};
   const report=r=>{for(const item of Array.isArray(r?.works)?r.works:[]){work(item.cashId);sourceRow(item.sourceSelector,item.rowId);}};
   const sourceMarkers=d=>({report:d?.sourceWorkReportId,works:d?.sourceWorkIds});
   for(const c of changes){const [kind,name]=JSON.parse(c.key);
     if(kind==='cash'&&name==='payments')for(const p of [c.value,before.get(c.key)])account(p?.accountId);
     if(kind==='row')for(const n of [c.value,before.get(c.key)])account(n?.a?.['data-cash-account-id']);
     if(kind==='storage'&&name==='officina.invoices.v1'){
       const old=JSON.parse(before.get(c.key)||'{}'),next=JSON.parse(c.value||'{}'),a=new Map((old.documents||[]).map(d=>[d.id,d])),b=new Map((next.documents||[]).map(d=>[d.id,d]));
       for(const id of new Set([...a.keys(),...b.keys()]))if(stable(a.get(id))!==stable(b.get(id))){
         account(a.get(id)?.cashLink);account(b.get(id)?.cashLink);
         // Ordinary invoice/payment edits do not re-read the source works.
         // A new or changed conversion must be based on current accounts and
         // source rows, including a source moved to another container.
         if(stable(sourceMarkers(a.get(id)))!==stable(sourceMarkers(b.get(id))))for(const doc of [a.get(id),b.get(id)])if(['TD01','TD24'].includes(doc?.type))for(const cashId of Array.isArray(doc.sourceWorkIds)?doc.sourceWorkIds:[])work(cashId);
       }
       const prior=new Map((old.workReports||[]).map(r=>[r.id,r]));
       for(const item of next.workReports||[])if(stable(prior.get(item.id))!==stable(item))report(item);
     }
   }return [...keys];
 }
 function label(encoded){const [kind,name,id]=JSON.parse(encoded);if(kind==='row')return ({'#customerRows':'Cliente','#agendaRows':'Appuntamento','#stockRows':'Articolo di magazzino','#agenda .parking-section .card':'Veicolo in parcheggio','#richiami .agenda-list':'Richiamo'}[name]||'Voce')+' · '+id.slice(0,8);if(kind==='cash')return 'Movimento / conto cassa';if(name==='officina.invoices.v1')return 'Archivio e numerazione fatture';return name||'Impostazioni cassa';}
 return Object.freeze({key,empty,normalize,flatten,inflate,diff,stable,rows,inventoryRecord,needsInventoryGuard,dependencies,label});
});
