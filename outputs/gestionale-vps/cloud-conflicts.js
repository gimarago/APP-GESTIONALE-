/* Conflict cards contain only the affected business fields, never snapshots. */
(() => {
 'use strict';
 const D=WorkshopConflictDetails,R=WorkshopCloudRecords,$=id=>document.getElementById(id);
 let report=null;
 const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
 const dialog=el('dialog',undefined,'conflict-dialog');dialog.id='conflictDialog';dialog.setAttribute('aria-labelledby','conflictTitle');
 const head=el('div',undefined,'conflict-heading'),heading=el('h2','Confronta le modifiche');heading.id='conflictTitle';
 const close=el('button','Chiudi','secondary');close.type='button';close.onclick=()=>dialog.close();head.append(heading,close);
 const intro=el('p','Un altro dispositivo ha modificato dati coinvolti nel tuo salvataggio. Nessuna modifica di questo invio è stata applicata. La tua bozza è conservata.');
 const content=el('div');content.id='conflictCards';
 const footer=el('div',undefined,'conflict-actions'),download=el('button','Scarica confronto','secondary'),reload=el('button','Ricarica dati server');
 download.id='conflictDownload';reload.id='conflictReload';download.type=reload.type='button';
 download.onclick=()=>{if(!report)return;const url=URL.createObjectURL(new Blob([JSON.stringify({format:'officina-conflict-report',...report},null,2)],{type:'application/json'}));const link=el('a');link.href=url;link.download='officina-confronto-modifiche.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
 reload.onclick=()=>{dialog.close();$('reload').click();};
 footer.append(download,reload);dialog.append(head,intro,content,el('p','Controlla il confronto, poi ricarica i dati aggiornati. Potrai reinserire la modifica che vuoi conservare; la bozza completa resta scaricabile.','conflict-guidance'),footer);document.body.append(dialog);
 function recordCard(conflict,before,attempts,related=false){
  const detail=conflict.detail||{},local=attempts.get(conflict.key),old=before.get(conflict.key);
  const own=local?D.difference(conflict.key,old,local.value).slice(0,24):[];
  const oldFields=new Map(D.describe(conflict.key,old).fields.map(f=>[f.key,f.value]));
  const current=new Map((detail.currentFields||[]).map(f=>[f.key,f.value]));
  const remoteChanges=detail.changes||[],fields=new Map();
  for(const change of [...remoteChanges,...own])fields.set(change.key,change.label);
  if(!fields.size)for(const field of (detail.currentFields||[]).slice(0,12))fields.set(field.key,field.label);
  const title=detail.title||D.describe(conflict.key,local?.value||old).title||conflict.label;
  return {key:conflict.key,title,related,linked:!remoteChanges.length&&!!detail.related?.length,updatedBy:detail.updatedBy||null,updatedAt:detail.updatedAt||null,changes:remoteChanges,comparison:[...fields].map(([key,label])=>({key,label,previous:oldFields.get(key)??own.find(c=>c.key===key)?.before??'Non disponibile',server:current.get(key)??remoteChanges.find(c=>c.key===key)?.after??'—',proposed:own.find(c=>c.key===key)?.after??(local?oldFields.get(key)??'—':null)})),omittedChanges:detail.omittedChanges||0,omittedRelated:detail.omittedRelated||0,historyLimited:detail.historyLimited===true};
 }
 function renderCard(item){
  const card=el('article',undefined,'conflict-card'+(item.related?' is-related':''));
  card.append(el('h3',item.title));
  const at=typeof item.updatedAt==='number'?new Date(item.updatedAt).toLocaleString('it-IT'):'';
  card.append(el('p',item.updatedBy?item.updatedBy+(item.linked?' ha modificato dati collegati a questa operazione':' ha aggiornato questa voce')+(at?' · '+at:''):'Autore non disponibile nello storico del server.','conflict-author'));
  if(item.changes.length){const list=el('ul',undefined,'conflict-changes');for(const change of item.changes)list.append(el('li',change.label+': '+change.before+' → '+change.after));card.append(list);}
  else card.append(el('p',item.linked?'Le modifiche collegate sono indicate nelle schede seguenti.':'Il dettaglio della modifica precedente non è disponibile. Qui trovi i valori attuali del server.','conflict-history-note'));
  const table=el('table'),thead=el('thead'),header=el('tr'),labels=['Campo','Il dato che avevi','Ora sul server','La tua modifica'];
  for(const label of labels)header.append(el('th',label));thead.append(header);table.append(thead);
  const tbody=el('tbody');for(const field of item.comparison){const row=el('tr');[field.label,field.previous,field.server,field.proposed??'Nessuna modifica diretta'].forEach((value,i)=>{const cell=el('td',value);cell.dataset.label=labels[i];row.append(cell);});tbody.append(row);}table.append(tbody);
  if(item.comparison.length){const wrap=el('div',undefined,'conflict-table');wrap.append(table);card.append(wrap);}
  if(item.omittedChanges||item.omittedRelated||item.historyLimited)card.append(el('p','Il confronto mostra un riepilogo limitato delle modifiche collegate. La bozza completa è conservata.','conflict-history-note'));
  return card;
 }
 function clear(){report=null;if(dialog.open)dialog.close();content.replaceChildren();$('conflictDetails').hidden=true;}
 function show(){if(report&&!dialog.open)dialog.showModal();}
 $('conflictDetails').onclick=show;
 window.WorkshopCloudConflicts=Object.freeze({clear,show,report:()=>report,
  capture(conflicts,baseline,operation,omittedConflicts=0){
   let before=new Map();try{before=R.flatten(baseline);}catch{}
   const attempts=new Map((operation?.data?.changes||[]).map(c=>[c.key,c])),cards=[],seen=new Set(),relatedRecords=new Map();
   for(const conflict of (conflicts||[]).slice(0,30)){
    if(!seen.has(conflict.key)){cards.push(recordCard(conflict,before,attempts));seen.add(conflict.key);}
    for(const related of (conflict.detail?.related||[]).slice(0,20))relatedRecords.set(related.key,related);
   }
   const additional=[...relatedRecords.values()].filter(item=>!seen.has(item.key));
   cards.push(...additional.slice(0,20).map(item=>recordCard(item,before,attempts,true)));
   const omittedCards=Math.max(0,additional.length-20);
   report={capturedAt:new Date().toISOString(),cards,omittedConflicts,omittedCards};
   content.replaceChildren(...cards.map(renderCard));
   if(!cards.length)content.append(el('p','Il server ha segnalato un conflitto senza ulteriori dettagli. Conserva la bozza e ricarica i dati aggiornati.'));
   if(omittedConflicts)content.append(el('p','Altre '+omittedConflicts+' voci in conflitto. Il salvataggio è stato sospeso interamente.'));
   if(omittedCards)content.append(el('p','Altre '+omittedCards+' modifiche collegate non sono mostrate in questo riepilogo. La bozza completa è conservata.'));
   $('conflictDetails').hidden=false;return report;
  }
 });
})();
