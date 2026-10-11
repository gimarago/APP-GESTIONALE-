(() => {
  'use strict';
  const api=window.WorkshopLedgerCash;
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const status=(text)=>text==='COMPLETATO'?'COMPLETATO':'IN LAVORAZIONE';
  const captureRow=(row,source)=>{
    if(window.WorkshopCloud)return undefined;
    const clone=row.cloneNode(true);
    [...row.querySelectorAll('input,select,textarea')].forEach((field,i)=>{
      const copy=clone.querySelectorAll('input,select,textarea')[i];
      if(copy.tagName==='SELECT') [...copy.options].forEach(o=>o.toggleAttribute('selected',o.value===field.value));
      else if(copy.tagName==='TEXTAREA') copy.textContent=field.value;
      else copy.setAttribute('value',field.value);
    });
    return {source,html:clone.outerHTML};
  };
  const restoreRow=(entry,nextStatus)=>{
    let row=[...document.querySelectorAll('#agendaRows tr,#agenda .parking-row')].find(r=>r.dataset.cashAccountId===entry.cashId);
    if(!row) row=[...document.querySelectorAll(entry.source==='agenda'?'#agendaRows tr':'#agenda .parking-row')].find(r=>{
      const customer=entry.source==='agenda'?r.cells[1]?.textContent:r.children[0]?.querySelector('b')?.textContent;
      const vehicle=entry.source==='agenda'?r.cells[2]?.textContent:r.children[0]?.querySelector('small')?.textContent;
      return !r.dataset.cashAccountId && customer?.trim()===entry.customer && vehicle?.trim()===entry.vehicle && (entry.source!=='agenda'||(r.dataset.date||'2026-09-02')===entry.date);
    });
    if(!window.WorkshopCloud && !row && entry.restoreData?.html) {
      const container=document.createElement(entry.source==='agenda'?'tbody':'div');
      container.innerHTML=entry.restoreData.html;
      row=container.firstElementChild;
      row.querySelectorAll('script,iframe,object,embed').forEach(n=>n.remove());
      [row,...row.querySelectorAll('*')].forEach(n=>[...n.attributes].forEach(a=>{if(a.name.startsWith('on'))n.removeAttribute(a.name);}));
    }
    const restoredFromExistingData=Boolean(row);
    if(!row) {
      row=document.createElement(entry.source==='agenda'?'tr':'div');
      if(entry.source==='agenda') row.innerHTML=`<td>${esc(entry.time)}</td><td>${esc(entry.customer)}</td><td>${esc(entry.vehicle)}</td><td><input class="work-input" value="${esc(entry.work)}"></td><td><input class="amount-input" value="${entry.amount}"></td><td><select class="status-select"><option>IN ATTESA</option><option>IN LAVORAZIONE</option><option>COMPLETATO</option></select></td>`;
      else {
        row.className='parking-row';
        row.innerHTML=`<div><b>${esc(entry.customer)}</b><small>${esc(entry.vehicle)}</small></div><div><small>${esc(entry.date)}</small></div><div><small>${esc(entry.date)}</small></div><div><b>${esc(entry.work)}</b></div><div><select class="parking-status"><option>IN LAVORAZIONE</option><option>COMPLETATO</option></select></div>`;
      }
    }
    row.dataset.cashAccountId=entry.cashId;
    if(!row.dataset.date)row.dataset.date=entry.date;
    if(!row.hasAttribute('data-work-notes'))row.dataset.workNotes=entry.notes||'';
    const linesKey=entry.source==='agenda'?'acceptanceLines':'workLines';
    if(!row.dataset[linesKey])row.dataset[linesKey]=JSON.stringify(entry.lines||[]);
    const work=row.querySelector('.work-input'),amount=row.querySelector('.amount-input');
    if(!restoredFromExistingData){if(work)work.value=entry.work;if(amount)amount.value=String(entry.amount);}
    row.style.display='';row.hidden=false;
    const parent=entry.source==='agenda'?document.getElementById('agendaRows'):document.querySelector('#agenda .parking-section .card');
    if(!row.isConnected)parent.append(row);
    if(amount)amount.dispatchEvent(new Event('input',{bubbles:true}));
    let select=row.querySelector('.status-select,.parking-status');
    if(![...select.options].some(o=>o.value===nextStatus))select.add(new Option(nextStatus,nextStatus));
    select.value=nextStatus;
    if(entry.source==='parking') {
      row.dataset.completedDate=nextStatus==='COMPLETATO'?entry.date:'';
      const data=window.parkingDataFromRow(row);data.status=nextStatus;
      window.renderParkingRow(row,data);
      select=row.querySelector('.parking-status');
    }
    select.dispatchEvent(new Event('change',{bubbles:true}));
    if(entry.source==='agenda') {
      const picker=document.getElementById('agendaDatePicker');
      if(picker){picker.value=entry.date;picker.dispatchEvent(new Event('change',{bubbles:true}));}
    }
    return row;
  };
  window.WorkshopExtras={captureRow,restoreRow};
  // Only the customer directory owns the header search.
  const search=document.getElementById('search');
  const updateSearch=()=>{search.style.setProperty('display',document.querySelector('.nav button.active')?.dataset.view==='clienti'?'block':'none','important');};
  new MutationObserver(updateSearch).observe(document.querySelector('.nav'),{attributes:true,subtree:true,attributeFilter:['class']});updateSearch();
  document.head.insertAdjacentHTML('beforeend',`<style>
    .ledger-work-layout{display:flex;align-items:center;gap:14px}.ledger-work-layout .ledger-work-trigger{flex:1;min-width:0}.ledger-work-layout .ledger-reopen{flex:none;margin:0;padding:3px 7px!important;min-height:22px!important;height:22px;font-size:10px!important;font-weight:500!important;line-height:14px;border-radius:5px;white-space:nowrap}
    .quick-postit{display:block;width:100%;padding:14px 0;text-align:left;background:transparent;border:0;border-top:1px solid var(--line);color:var(--ink);cursor:pointer;font:inherit}.quick-postit span{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.6}.quick-postit small{display:block;margin-top:6px;color:var(--muted);font-size:10px}.quick-postit-empty{color:var(--muted);padding:14px 0}
    .work-note-field{display:block;margin:16px 0;color:var(--ink);font-weight:600}.work-note-field textarea{display:block;width:100%;box-sizing:border-box;margin-top:8px;min-height:95px;padding:12px;background:var(--paper);color:var(--ink);border:1px solid var(--line);border-radius:8px;font:inherit;resize:vertical}
    .postit-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:18px;margin-top:22px}.postit{padding:20px;border:1px solid var(--line);border-top:4px solid #e4bf51;border-radius:12px;background:var(--white);color:var(--ink)}.postit p{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.6}.postit small{color:var(--muted)}.postit .btn{margin:8px 8px 0 0}.postit.done p{text-decoration:line-through;opacity:.6}.ledger-reopen{font-size:10px;margin:6px 0}.detail-row p{flex-basis:100%}
  </style>`);
  for(const [form,id] of [['acceptanceForm','acceptanceNotes'],['parkingForm','parkingNotes'],['appointmentForm','appointmentNotes']]) {
    const target=document.getElementById(form);
    const label=document.createElement('label');label.className='work-note-field';label.textContent='Note';
    const field=document.createElement('textarea');field.id=id;field.placeholder='Indicazioni, richieste del cliente o dettagli del lavoro';label.append(field);
    target.querySelector('.modal-actions').before(label);
  }
  const noteKey=row=>[row.dataset.date||'',row.cells?.[1]?.textContent||row.children[0]?.querySelector('b')?.textContent,row.cells?.[2]?.textContent||row.children[0]?.querySelector('small')?.textContent].join('|');
  let savedNotes={};try{savedNotes=JSON.parse(localStorage.getItem('officina-work-notes')||'{}');}catch{}
  document.addEventListener('workshop-cloud-state-loading',event=>{
    if(event.detail?.storageKeys&&!event.detail.storageKeys.includes('officina-work-notes'))return;
    try{const next=JSON.parse(localStorage.getItem('officina-work-notes')||'{}');savedNotes=next&&typeof next==='object'&&!Array.isArray(next)?next:{};}catch{savedNotes={};}
  });
  const restoreNotes=()=>{if(window.WorkshopCloud?.applying)return;document.querySelectorAll('#agendaRows tr,#agenda .parking-row').forEach(row=>{if(row.dataset.workNotes===undefined && savedNotes[noteKey(row)]!==undefined)row.dataset.workNotes=savedNotes[noteKey(row)];});};
  restoreNotes();new MutationObserver(restoreNotes).observe(document.getElementById('agenda'),{childList:true,subtree:true});
  document.addEventListener('submit',event=>{
    if(!event.target.matches('#acceptanceForm,#parkingForm,#appointmentForm'))return;
    let savedRow=event.target.id==='acceptanceForm'?window.getAcceptanceRow?.():event.target.id==='parkingForm'&&typeof editingParkingRow!=='undefined'?editingParkingRow:null;
    const created=event.target.id==='appointmentForm'?{source:'agenda',name:document.getElementById('appCustomer').value,plate:document.getElementById('appPlate').value,time:document.getElementById('appTime').value,note:document.getElementById('appointmentNotes').value}:event.target.id==='parkingForm'?{source:'parking',name:document.getElementById('parkCustomer').value,plate:document.getElementById('parkPlate').value,note:document.getElementById('parkingNotes').value}:null;
    if(event.target.id==='parkingForm' && typeof editingParkingRow!=='undefined' && editingParkingRow) {
      editingParkingRow.dataset.workNotes=document.getElementById('parkingNotes').value;
      if(editingParkingRow.dataset.cashAccountId) api.setStatus(editingParkingRow.dataset.cashAccountId,document.getElementById('parkStatus').value);
    }
    setTimeout(()=>{
      if(created) {
        const rows=[...document.querySelectorAll(created.source==='agenda'?'#agendaRows tr':'#agenda .parking-row')];
        const row=rows.reverse().find(r=>created.source==='agenda'?r.cells[1]?.textContent.trim()===created.name && r.cells[0]?.textContent.match(/\d{1,2}:\d{2}/)?.[0]===created.time:r.children[0]?.querySelector('b')?.textContent.trim()===created.name);
        if(row){row.dataset.workNotes=created.note;savedRow=row;}
      }
      document.querySelectorAll('#agendaRows tr,#agenda .parking-row').forEach(row=>{if(row.dataset.workNotes!==undefined)savedNotes[noteKey(row)]=row.dataset.workNotes;});
      api.save(savedRow||null);
      try{localStorage.setItem('officina-work-notes',JSON.stringify(savedNotes));}catch{alert('Impossibile salvare le note nel browser.');}
    },0);
  },true);
  // The shared archive owns work rows. An old, unlinked cash account must not
  // reopen a different completed job at startup and credit its stock again.
  if (!window.WorkshopCloud) api.savedAccounts().filter(a=>a.status && a.status!=='COMPLETATO').forEach(a=>restoreRow({...a.meta,cashId:a.id},a.status));
  window.renderSelectedLedger();
  // Personal notes board.
  const button=document.createElement('button');button.type='button';button.dataset.view='postit';button.innerHTML='<i aria-hidden="true">▤</i> Post-it';
  document.querySelector('.nav [data-view="magazzino"]').after(button);
  pageIds.push('postit');titles.postit='Post-it';
  const section=document.createElement('section');section.id='postit';section.style.display='none';
  section.innerHTML='<div class="page-head"><div><h2>Post-it</h2><p>Appunti e promemoria per la tua officina.</p></div></div><form id="postitForm" class="card"><label class="work-note-field">Nuovo post-it<textarea id="postitText" required maxlength="5000" placeholder="Scrivi un appunto…"></textarea></label><button class="btn" type="submit">Salva post-it</button><p role="status" id="postitStatus"></p></form><div class="postit-grid" id="postitList"></div>';
  const footer=document.querySelector('.tech-page-footer');if(footer)footer.before(section);else document.querySelector('main').append(section);button.addEventListener('click',()=>showPage('postit'));
  let notes=[];let invalid=false;try{notes=JSON.parse(localStorage.getItem('officina-postit')||'[]');if(!Array.isArray(notes))throw Error();}catch{invalid=true;notes=[];}
  const quick=document.querySelector('#dashboard .content aside .card');
  if(quick) {
    quick.innerHTML='<div class="cardhead"><h2>Post-it</h2><button class="link" type="button" id="openQuickNotes">TUTTI →</button></div><div id="quickNotes"></div>';
    document.getElementById('openQuickNotes').addEventListener('click',()=>button.click());
  }
  const renderQuick=()=>{
    if(!quick)return;
    const pending=notes.filter(n=>!n.done);
    document.getElementById('quickNotes').innerHTML=pending.length?pending.slice(0,4).map(n=>'<button class="quick-postit" type="button" data-open-note="'+esc(n.id)+'"><span>'+esc(n.text)+'</span><small>'+esc(new Date(n.date).toLocaleDateString('it-IT'))+'</small></button>').join(''):'<p class="quick-postit-empty">Nessun post-it da completare.</p>';
  };
  quick?.addEventListener('click',event=>{const id=event.target.closest('[data-open-note]')?.dataset.openNote;if(!id)return;button.click();const note=notes.find(n=>n.id===id);if(note){editId=id;document.getElementById('postitText').value=note.text;document.getElementById('postitText').focus();}});
  let editId=null;
  const save=next=>{try{if(invalid)throw Error();localStorage.setItem('officina-postit',JSON.stringify(next));notes=next;document.getElementById('postitStatus').textContent='Salvato.';return true;}catch{document.getElementById('postitStatus').textContent='Impossibile salvare i post-it nel browser.';return false;}};
  const render=()=>{renderQuick();document.getElementById('postitList').innerHTML=notes.length?notes.map(n=>`<article class="postit ${n.done?'done':''}" data-note="${esc(n.id)}"><small>${esc(new Date(n.date).toLocaleDateString('it-IT'))}</small><p>${esc(n.text)}</p><button class="btn secondary" data-action="edit">Modifica</button><button class="btn secondary" data-action="done">${n.done?'Riapri':'Fatto'}</button><button class="btn secondary" data-action="delete">Elimina</button></article>`).join(''):'<p>Nessun post-it. Scrivi il primo appunto.</p>';};
  document.addEventListener('workshop-cloud-state-loading',event=>{
    if(event.detail?.storageKeys&&!event.detail.storageKeys.includes('officina-postit'))return;
    try{const next=JSON.parse(localStorage.getItem('officina-postit')||'[]');if(!Array.isArray(next))throw Error();notes=next;invalid=false;}
    catch{notes=[];invalid=true;}
    if(!document.getElementById('postitText').value.trim())editId=null;
  });
  document.addEventListener('workshop-cloud-state-applied',event=>{
    const detail=event.detail;
    if(!detail?.storageKeys||detail.storageKeys.includes('officina-work-notes')||detail.selectors?.some(selector=>['#agendaRows','#agenda .parking-section .card'].includes(selector)))restoreNotes();
    if(!detail?.storageKeys||detail.storageKeys.includes('officina-postit'))render();
  });
  document.getElementById('postitForm').addEventListener('submit',event=>{event.preventDefault();const field=document.getElementById('postitText');if(!field.value.trim())return;const next=notes.map(n=>({...n}));if(editId){next.find(n=>n.id===editId).text=field.value.trim();}else next.unshift({id:crypto.randomUUID(),text:field.value.trim(),date:new Date().toISOString(),done:false});if(save(next)){field.value='';editId=null;render();}});
  document.addEventListener('workshop-discard-open-forms',()=>{editId=null;document.getElementById('postitText').value='';document.getElementById('postitStatus').textContent='';});
  document.getElementById('postitList').addEventListener('click',event=>{const action=event.target.dataset.action;const id=event.target.closest('[data-note]')?.dataset.note;if(!action||!id)return;const note=notes.find(n=>n.id===id);if(action==='edit'){editId=id;document.getElementById('postitText').value=note.text;document.getElementById('postitText').focus();return;}if(action==='delete' && !confirm('Eliminare questo post-it?'))return;const next=action==='delete'?notes.filter(n=>n.id!==id):notes.map(n=>n.id===id?{...n,done:!n.done}:n);if(save(next))render();});render();
})();
