(function(){
  'use strict';
  const $=id=>document.getElementById(id), key='officina.customerFiscal.v1';
  const normalize=s=>String(s||'').trim().toLocaleLowerCase('it');
  let records={};
  try{records=JSON.parse(localStorage.getItem(key)||'{}');}catch(e){alert('Archivio dati fiscali non leggibile. Modifiche disabilitate.');return;}
  document.addEventListener('workshop-cloud-state-loading',event=>{
    if(event.detail?.storageKeys&&!event.detail.storageKeys.includes(key))return;
    const next=JSON.parse(localStorage.getItem(key)||'{}');
    if(!next||typeof next!=='object'||Array.isArray(next))throw Error('Archivio dati fiscali non valido.');
    records=next;
  });
  const fields=[['name','Denominazione fiscale / ragione sociale'],['vat','Partita IVA'],['cf','Codice fiscale'],['address','Indirizzo e numero civico'],['zip','CAP'],['city','Comune'],['province','Provincia'],['code','Codice destinatario SdI'],['pec','PEC']];
  function inputs(prefix,container){for(const [k,label] of fields){const div=document.createElement('div');div.className='field';const lab=document.createElement('label');lab.htmlFor=prefix+k;lab.textContent=label;const input=document.createElement('input');input.id=prefix+k;input.type=k==='pec'?'email':'text';if(k==='code')input.maxLength=7;if(k==='province')input.maxLength=2;div.append(lab,input);container.append(div);}}
  function read(prefix){const p=Object.fromEntries(fields.map(([k])=>[k,$(prefix+k).value.trim()]));for(const k of ['cf','province','code'])p[k]=p[k].toUpperCase();return p;}
  function check(p){if(p.vat&&!/^\d{11}$/.test(p.vat))throw Error('Partita IVA italiana: inserire 11 cifre.');if(p.cf&&!/^(?:[A-Z0-9]{16}|\d{11})$/.test(p.cf))throw Error('Controllare il codice fiscale.');if(p.zip&&!/^\d{5}$/.test(p.zip))throw Error('CAP italiano: inserire 5 cifre.');if(p.province&&!/^[A-Z]{2}$/.test(p.province))throw Error('Provincia: inserire due lettere.');if(p.code&&!/^[A-Z0-9]{7}$/.test(p.code))throw Error('Codice destinatario: inserire 7 caratteri.');}
  function save(name,p){
    const id=normalize(name),previous=records[id];
    if(previous){const backupKey=key+'.history';const history=JSON.parse(localStorage.getItem(backupKey)||'[]');history.push({name:id,at:new Date().toISOString(),data:previous});localStorage.setItem(backupKey,JSON.stringify(history));}
    const next={...records,[id]:p};localStorage.setItem(key,JSON.stringify(next));records=next;
  }
  // Un nuovo cliente creato senza anagrafica fiscale non eredita record orfani omonimi.
  document.addEventListener('submit',event=>{
    const field=event.target.id==='appointmentForm'?'appCustomer':event.target.id==='parkingForm'?'parkCustomer':null;
    if(!field)return;const name=$(field).value.trim();
    if(!name||[...$('customerRows').rows].some(row=>normalize(row.cells[0]?.textContent||'')===normalize(name)))return;
    try{save(name,{name});}catch{event.preventDefault();event.stopImmediatePropagation();alert('Impossibile inizializzare i dati del nuovo cliente. Controllare lo spazio di archiviazione.');}
  },true);
  window.WorkshopCustomerFiscal={
    get:name=>({...records[normalize(name)]}),
    fillNewVehicle(name){
      const p=records[normalize(name)]||{};
      for(const [k] of fields)$('newFiscal'+k).value=p[k]||(k==='name'?name:'');
      if(p.phone!==undefined)$('customerPhone').value=p.phone;
      if(p.email!==undefined)$('customerEmail').value=p.email;
    }
  };
  const form=$('customerForm'),grid=form.querySelector('.form-grid');
  const note=document.createElement('p');note.textContent='Dati per fatturazione italiana (facoltativi; verificati prima dell’emissione).';note.className='field full';grid.append(note);inputs('newFiscal',grid);
  form.style.maxHeight='90vh';form.style.overflowY='auto';
  $('customerName').addEventListener('input',()=>{if(!$('customerName').readOnly)for(const [k] of fields)$('newFiscal'+k).value='';});
  form.addEventListener('submit',e=>{try{const p=read('newFiscal');const existing=records[normalize($('customerName').value)];if($('customerName').readOnly&&existing){for(const [k] of fields)if(!p[k])p[k]=existing[k]||'';}p.name=p.name||$('customerName').value.trim();p.phone=$('customerPhone').value.trim();p.email=$('customerEmail').value.trim();check(p);save($('customerName').value,p);}catch(err){e.preventDefault();e.stopImmediatePropagation();alert(err.message);}},{capture:true});
  const modal=document.createElement('div');modal.id='fiscalEditModal';modal.className='form-modal';modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');modal.innerHTML='<form class="modal-card" id="fiscalEditForm" style="max-height:90vh;overflow-y:auto"><h2>Modifica dati cliente</h2><p id="fiscalEditName"></p><p>Le modifiche valgono per tutti i veicoli del cliente. Le fatture già salvate non vengono alterate.</p><div class="form-grid"><div class="field full"><label for="fiscalCustomerName">Nome cliente</label><input id="fiscalCustomerName" required maxlength="160" autocomplete="name"></div><div class="field"><label for="fiscalPhone">Telefono</label><input id="fiscalPhone"></div><div class="field"><label for="fiscalEmail">Email</label><input id="fiscalEmail" type="email"></div></div><div class="modal-actions"><button type="button" class="btn secondary" id="fiscalCancel">Annulla</button><button class="btn" type="submit">Salva dati cliente</button></div></form>';
  document.querySelector('main').append(modal);inputs('editFiscal',modal.querySelector('.form-grid'));let editing='';
  const button=document.createElement('button');button.type='button';button.className='btn secondary';button.textContent='Modifica dati cliente';document.querySelector('#historyModal .modal-actions').prepend(button);
  button.onclick=()=>{editing=$('historyTitle').textContent.replace(/^Storico\s*[—–-]\s*/,'').trim();const row=[...$('customerRows').rows].find(r=>normalize(r.cells[0].textContent)===normalize(editing));if(!row)return;const p=records[normalize(editing)]||{};$('fiscalEditName').textContent='Cliente: '+editing;$('fiscalCustomerName').value=editing;for(const [k] of fields)$('editFiscal'+k).value=p[k]||(k==='name'?editing:'');$('fiscalPhone').value=p.phone??row.cells[1].textContent.replace('—','').trim();$('fiscalEmail').value=p.email??row.cells[2].textContent.replace('—','').trim();closeModal('historyModal');openModal('fiscalEditModal');};
  $('fiscalCancel').onclick=()=>closeModal('fiscalEditModal');
  const clearFiscal=document.createElement('button');clearFiscal.type='button';clearFiscal.className='btn secondary';clearFiscal.textContent='Svuota dati fiscali';
  clearFiscal.onclick=()=>{for(const [k] of fields)$('editFiscal'+k).value='';$('editFiscalname').focus();};
  $('fiscalCancel').before(clearFiscal);
  function syncContacts(name,p){for(const row of $('customerRows').rows){if(normalize(row.cells[0].textContent)!==normalize(name))continue;if(p.phone!==undefined)row.cells[1].textContent=p.phone||'—';if(p.email!==undefined)row.cells[2].textContent=p.email||'—';}}
  function renamedStorage(name,p){
    const oldKey=normalize(editing),newKey=normalize(name),changes=[];
    const previous=records[oldKey],next={...records};
    if(oldKey!==newKey)delete next[oldKey];
    next[newKey]=p;
    changes.push([key,JSON.stringify(next)]);
    if(previous){
      const backupKey=key+'.history',history=JSON.parse(localStorage.getItem(backupKey)||'[]');
      if(!Array.isArray(history))throw Error('Archivio delle modifiche cliente non valido.');
      history.push({name:oldKey,at:new Date().toISOString(),data:previous});
      changes.push([backupKey,JSON.stringify(history)]);
    }
    for(const [storageKey,listKey] of [['officina-table-import-v1','history'],['officina-quotes-v1',null]]){
      const raw=localStorage.getItem(storageKey);
      if(!raw)continue;
      const data=JSON.parse(raw),list=listKey?data?.[listKey]:data;
      if(!Array.isArray(list))throw Error('Archivio collegato non leggibile: '+storageKey);
      let changed=false;
      const updated=list.map(item=>{
        if(normalize(item?.customer)!==oldKey)return item;
        changed=true;
        return {...item,customer:name};
      });
      if(changed)changes.push([storageKey,JSON.stringify(listKey?{...data,[listKey]:updated}:updated)]);
    }
    return {changes,next};
  }
  function applyStorage(changes){
    const previous=changes.map(([storageKey])=>[storageKey,localStorage.getItem(storageKey)]),written=[];
    const restore=()=>{for(const [storageKey,value] of previous)if(written.includes(storageKey)){if(value===null)localStorage.removeItem(storageKey);else localStorage.setItem(storageKey,value);}};
    try{
      for(const [storageKey,value] of changes){localStorage.setItem(storageKey,value);written.push(storageKey);}
      return restore;
    }catch(error){restore();throw error;}
  }
  function updateCustomerReferences(oldName,newName,p){
    const matches=value=>normalize(value)===normalize(oldName);
    for(const row of $('customerRows').rows)if(matches(row.cells[0]?.textContent))row.cells[0].textContent=newName;
    window.makeCustomerNamesClickable?.();
    syncContacts(newName,p);
    for(const row of $('agendaRows').rows)if(matches(row.cells[1]?.textContent))row.cells[1].textContent=newName;
    for(const row of document.querySelectorAll('#agenda .parking-section .parking-row')){
      const label=row.children[0]?.querySelector('b');
      if(label&&matches(label.textContent))label.textContent=newName;
    }
    for(const row of document.querySelectorAll('#richiami .agenda-list .agenda-row:not([data-revision-auto])')){
      const label=row.querySelector('.agenda-text b');
      if(label&&matches(label.textContent))label.textContent=newName;
    }
    for(const id of ['appCustomer','parkCustomer','quoteCustomer'])if($(id)&&matches($(id).value))$(id).value=newName;
    if(typeof knownClients!=='undefined'){
      for(const [name,value] of Object.entries(knownClients))if(matches(name)){delete knownClients[name];knownClients[newName]=value;}
    }
    window.updateCustomerSuggestions?.();
    window.syncDashboardToday?.();
    window.renderSelectedLedger?.();
    window.renderDataAnalysis?.();
    document.dispatchEvent(new CustomEvent('workshop:customer-renamed',{detail:{oldName,newName}}));
  }
  $('fiscalEditForm').onsubmit=e=>{e.preventDefault();try{
    const name=$('fiscalCustomerName').value.trim();
    if(!name||name.length>160||/[<>"\x00-\x1f\x7f]/.test(name)||['__proto__','constructor','prototype'].includes(normalize(name)))throw Error('Inserisci un nome cliente valido (massimo 160 caratteri).');
    const oldKey=normalize(editing),newKey=normalize(name);
    if(oldKey!==newKey&&[...$('customerRows').rows].some(row=>normalize(row.cells[0]?.textContent)===newKey))throw Error('Esiste già un cliente con questo nome.');
    if(oldKey!==newKey&&Object.hasOwn(records,newKey))throw Error('Esistono già dati fiscali per questo nome.');
    const p=read('editFiscal');p.phone=$('fiscalPhone').value.trim();p.email=$('fiscalEmail').value.trim();
    if(!p.name||normalize(p.name)===oldKey)p.name=name;
    check(p);
    const {changes,next}=renamedStorage(name,p),rollback=applyStorage(changes);
    try{window.WorkshopLedgerCash?.renameCustomer?.(editing,name);}catch(error){rollback();throw error;}
    records=next;
    updateCustomerReferences(editing,name,p);
    closeModal('fiscalEditModal');
  }catch(err){alert('Salvataggio non riuscito: '+err.message);}};
  for(const [name,p] of Object.entries(records))syncContacts(name,p);
})();
