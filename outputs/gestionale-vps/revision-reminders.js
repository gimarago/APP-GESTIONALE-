(() => {
  'use strict';
  const $=id=>document.getElementById(id),key='officina.revisionReminders.v1';
  let config={enabled:true,days:30,secondEnabled:true,secondAfter:15,dates:{}};
  try{const saved=JSON.parse(localStorage.getItem(key)||'null');if(saved)config={...config,...saved};}catch{}
  let reminderSettingsChanged=false;
  document.addEventListener('workshop-cloud-state-loading',event=>{
    reminderSettingsChanged=!event.detail?.storageKeys||event.detail.storageKeys.includes(key);
    if(reminderSettingsChanged){config={enabled:true,days:30,secondEnabled:true,secondAfter:15,dates:{}};try{const saved=JSON.parse(localStorage.getItem(key)||'null');if(saved)config={...config,...saved};}catch{}}
  });
  const trigger=[...document.querySelectorAll('#impostazioni .detail-row')].find(el=>el.querySelector('b')?.textContent==='Notifiche promemoria');
  const dashboard=[...document.querySelectorAll('#dashboard .card')].find(el=>el.querySelector('h2')?.textContent==='Da richiamare')?.querySelector('.agenda-list');
  const recalls=document.querySelector('#richiami .agenda-list');
  if(!trigger||!dashboard||!recalls)return;
  function renderDashboardRecalls(){
    // Manual recalls have one authoritative record in the archive. The
    // dashboard mirrors it alongside computed revision reminders, never saves
    // another copy and never carries the archive's record identity or actions.
    const rows=[...recalls.children].filter(row=>row.classList.contains('agenda-row')).map(source=>{
      const row=source.cloneNode(true);
      row.removeAttribute('data-cloud-id');
      row.dataset.recallPreview='true';
      row.querySelectorAll('a.whatsapp-reminder').forEach(link=>link.remove());
      row.querySelectorAll('[id]').forEach(element=>element.removeAttribute('id'));
      return row;
    });
    if(!rows.length){const empty=document.createElement('p');empty.className='dashboard-recall-empty';empty.textContent='Nessun richiamo registrato.';rows.push(empty);}
    const markup=rows.map(row=>row.outerHTML).join('');
    if(dashboard.innerHTML!==markup)dashboard.replaceChildren(...rows);
    const note=document.querySelector('#richiami .section-note');if(note)note.textContent=recalls.querySelectorAll('.agenda-row').length+' richiami presenti.';
  }
  new MutationObserver(renderDashboardRecalls).observe(recalls,{childList:true,subtree:true,characterData:true,attributes:true});
  const schedule=window.WorkshopRevisionSchedule,norm=schedule.plateKey;
  const vehicles=()=>{const seen=new Set();return [...$('customerRows').rows].map(r=>({name:r.cells[0]?.textContent.trim(),plate:r.cells[4]?.textContent.trim(),vehicle:r.cells[3]?.textContent.trim(),category:schedule.category(r.dataset.revisionCategory).value})).filter(v=>{const id=norm(v.plate);if(!id||seen.has(id))return false;seen.add(id);return true;});};
  const readLines=(row,key,fallback)=>{try{const lines=JSON.parse(row.dataset[key]||'[]');if(Array.isArray(lines)&&lines.length)return lines.map(line=>String(line?.description||''));}catch{}return [String(fallback||'')];};
  function completedRevisions(){
    const records=[],liveAccounts=new Set();
    for(const row of $('agendaRows').rows){
      if(row.dataset.cashAccountId)liveAccounts.add(row.dataset.cashAccountId);
      if(row.querySelector('.status-select')?.value!=='COMPLETATO')continue;
      const descriptions=readLines(row,'acceptanceLines',row.cells[3]?.querySelector('.work-input')?.value||row.cells[3]?.textContent);
      if(descriptions.some(schedule.isRevision))records.push({plate:row.dataset.plate||row.cells[2]?.querySelector('.plate')?.textContent||row.cells[2]?.textContent,date:row.dataset.date});
    }
    for(const row of document.querySelectorAll('#agenda .parking-row')){
      if(row.dataset.cashAccountId)liveAccounts.add(row.dataset.cashAccountId);
      if(row.querySelector('.parking-status')?.value!=='COMPLETATO')continue;
      const descriptions=readLines(row,'workLines',row.children[3]?.querySelector('b')?.textContent);
      const plate=row.children[0]?.querySelector('small')?.textContent.split('·')[0];
      if(descriptions.some(schedule.isRevision))records.push({plate,date:row.dataset.completedDate||row.dataset.exit});
    }
    // Reading the journal directly avoids snapshot() assigning accounts while
    // opening a view. Reopened live jobs must not count as archived revisions.
    try{
      const journal=JSON.parse(localStorage.getItem('ma-gomme-cashbook-v1')||'null');
      for(const account of Array.isArray(journal?.accounts)?journal.accounts:[]){
        if(liveAccounts.has(account.id)||!account.state||(account.status&&account.status!=='COMPLETATO'))continue;
        const meta=account.meta;
        if(!meta||!['agenda','parking'].includes(meta.source))continue;
        const descriptions=Array.isArray(meta.lines)&&meta.lines.length?meta.lines.map(line=>String(line?.description||'')):[String(meta.work||'')];
        if(descriptions.some(schedule.isRevision))records.push({plate:String(meta.vehicle||'').split('·')[0],date:meta.date});
      }
    }catch{}
    for(const fact of window.WorkshopImportedHistory?.facts()||[])if(schedule.isRevision(fact.work))records.push({plate:fact.plate,date:fact.date});
    return records;
  }
  function automaticDates(){
    const latest={};
    for(const item of completedRevisions()){const id=norm(item.plate),date=item.date;if(!id||!schedule.validDate(date))continue;if(!latest[id]||date>latest[id])latest[id]=date;}
    const categories=new Map(vehicles().map(vehicle=>[norm(vehicle.plate),vehicle.category]));
    const dates={};for(const [id,date] of Object.entries(latest)){const due=schedule.deadline(date,categories.get(id));if(due)dates[id]=due;}
    return {latest,dates};
  }
  const modal=document.createElement('div');modal.id='revisionReminderSettings';modal.className='form-modal';modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');modal.setAttribute('aria-labelledby','revisionReminderTitle');
  modal.innerHTML='<form class="modal-card"><h2 id="revisionReminderTitle">Richiami automatici revisioni</h2><p>La scadenza è la fine del mese dell’ultima revisione completata, dopo uno o due anni secondo la categoria scelta per il veicolo. Senza un intervallo impostato non vengono generati richiami. Configuralo in Clienti e veicoli, aprendo lo storico e “Revisioni veicoli”, oppure quando salvi una lavorazione di revisione. Una nuova revisione completata aggiorna il richiamo.</p><label><input id="revisionRecallEnabled" type="checkbox"> Attiva richiami automatici</label><div class="field"><label for="revisionRecallDays">Giorni di anticipo</label><select id="revisionRecallDays"><option value="7">7 giorni</option><option value="15">15 giorni</option><option value="30">30 giorni</option><option value="60">60 giorni</option><option value="90">90 giorni</option></select></div><label><input id="revisionSecondEnabled" type="checkbox"> Attiva secondo richiamo se la revisione non risulta effettuata</label><div class="field"><label for="revisionSecondAfter">Giorni dopo il primo richiamo</label><input id="revisionSecondAfter" type="number" min="1" max="365" required></div><p id="revisionSaveError" role="alert"></p><div class="modal-actions"><button type="button" class="btn secondary" id="cancelRevisionReminders">Annulla</button><button class="btn" type="submit">Salva richiami</button></div></form>';
  document.querySelector('main').append(modal);
  const style=document.createElement('style');style.textContent='#revisionReminderSettings .modal-card{max-height:90vh;overflow:auto}#revisionDueRows{display:grid;gap:12px;margin-top:16px}#revisionDueRows label{display:grid;gap:5px}#revisionDueRows input{padding:9px;border:1px solid var(--line);border-radius:8px}';document.head.append(style);
  function render(){
    trigger.querySelector('span').textContent=config.enabled?'Revisioni: '+config.days+' giorni prima della scadenza. Clicca per configurare.':'Richiami revisioni disattivati. Clicca per configurare.';
    const now=new Date(),today=Date.UTC(now.getFullYear(),now.getMonth(),now.getDate());
    const {dates}=automaticDates();
    const due=config.enabled?vehicles().filter(v=>{const date=dates[norm(v.plate)];return /^\d{4}-\d{2}-\d{2}$/.test(date||'')&&Date.parse(date+'T00:00:00Z')-today<=config.days*86400000;}).sort((a,b)=>dates[norm(a.plate)].localeCompare(dates[norm(b.plate)])):[];
    for(const target of [recalls]){
      target.querySelectorAll('[data-revision-auto]').forEach(el=>el.remove());
      due.forEach(v=>{const row=document.createElement('div');row.className='agenda-row';row.dataset.revisionAuto='true';const content=document.createElement('div');content.className='agenda-text';const name=document.createElement('b'),detail=document.createElement('span');name.textContent=v.name;const date=dates[norm(v.plate)];const second=config.secondEnabled&&today>=Date.parse(date+'T00:00:00Z')+(config.secondAfter-config.days)*86400000;detail.textContent=(second?'Secondo richiamo · ':'Primo richiamo · ')+v.plate+' · Revisione '+(Date.parse(date+'T00:00:00Z')<today?'scaduta':'in scadenza')+' · '+date.split('-').reverse().join('/')+' · '+(schedule.category(v.category).years===1?'Annuale':'Biennale');content.append(name,detail);row.append(content);target.append(row);});
    }
    renderDashboardRecalls();
  }
  function open(){
    $('revisionRecallEnabled').checked=config.enabled;$('revisionRecallDays').value=String(config.days);$('revisionSaveError').textContent='';
    $('revisionSecondEnabled').checked=config.secondEnabled;$('revisionSecondAfter').value=config.secondAfter;
    modal.classList.add('open');$('revisionRecallEnabled').focus();
  }
  trigger.setAttribute('role','button');trigger.tabIndex=0;trigger.style.cursor='pointer';trigger.onclick=open;trigger.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open();}};
  $('cancelRevisionReminders').onclick=()=>{modal.classList.remove('open');trigger.focus();};
  modal.querySelector('form').onsubmit=e=>{e.preventDefault();const next={...config,enabled:$('revisionRecallEnabled').checked,days:Number($('revisionRecallDays').value),secondEnabled:$('revisionSecondEnabled').checked,secondAfter:Number($('revisionSecondAfter').value),dates:{...config.dates}};try{localStorage.setItem(key,JSON.stringify(next));}catch{$('revisionSaveError').textContent='Salvataggio non riuscito. Le impostazioni non sono state modificate.';return;}config=next;syncSelect();render();modal.classList.remove('open');};
  function syncSelect(){const select=$('shopReminder');if(!select)return;if(![...select.options].some(o=>parseInt(o.textContent)===config.days))select.add(new Option(config.days+' giorni prima'));select.selectedIndex=[...select.options].findIndex(o=>parseInt(o.textContent)===config.days);}
  $('settingsForm').addEventListener('submit',()=>{config.days=parseInt($('shopReminder').value)||30;try{localStorage.setItem(key,JSON.stringify(config));}catch{}render();});
  // Replace sample revision reminders, retaining unrelated and manually added recalls.
  for(const target of [dashboard,document.querySelector('#richiami .agenda-list')])for(const row of [...target.children])if(row.querySelector('b')?.textContent.startsWith('Giulia Neri')&&row.textContent.includes('Revisione scaduta'))row.remove();
  let timer;const redraw=()=>{clearTimeout(timer);timer=setTimeout(render,150);};
  const observer=new MutationObserver(redraw);
  observer.observe($('customerRows'),{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['data-revision-category']});
  for(const root of [$('agendaRows'),document.querySelector('#agenda .parking-section .card')])if(root)observer.observe(root,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['data-date','data-completed-date','data-acceptance-lines','data-work-lines','data-plate']});
  document.addEventListener('submit',()=>setTimeout(render,250),true);
  document.addEventListener('change',e=>{if(e.target.matches('.status-select,.parking-status'))setTimeout(render,250);});
  document.addEventListener('workshop:history-imported',redraw);
  document.addEventListener('workshop:customer-renamed',redraw);
  document.addEventListener('workshop-cloud-state-applied',event=>{
    const detail=event.detail;
    if(detail?.storageKeys&&!detail.storageKeys.some(value=>[key,'ma-gomme-cashbook-v1','officina-table-import-v1'].includes(value))&&!detail.selectors?.some(selector=>['#customerRows','#agendaRows','#agenda .parking-section .card','#richiami .agenda-list'].includes(selector)))return;
    clearTimeout(timer);if(reminderSettingsChanged)syncSelect();reminderSettingsChanged=false;render();
  });
  window.WorkshopRevisionReminders={automaticDates,vehicles,refresh:render};
  window.addEventListener('focus',render);setInterval(render,60000);syncSelect();render();setTimeout(render,0);
})();
