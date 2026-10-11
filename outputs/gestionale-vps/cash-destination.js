/* Residual cash allocation and explicitly confirmed advance receipts. */
(() => {
  'use strict';
  const api = window.WorkshopLedgerCash;
  const agenda = document.getElementById('agendaRows');
  const parking = document.querySelector('#agenda .parking-section .card');
  if (!api || !agenda || !parking) return;
  const controls = new WeakMap();
  let parkingEditor = null;
  const rows = () => [...agenda.querySelectorAll('tr:not(.agenda-empty)'), ...parking.querySelectorAll('.parking-row')];
  const labelFor = value => value === 'split' ? 'Ripartito' : value === 'outside' ? 'Fuori cassa' : 'In cassa';
  function control(id) {
    const container = document.createElement('div');
    container.className = 'cash-destination';
    container.innerHTML = '<label class="cash-destination-switch"><input type="checkbox" role="switch" class="cash-destination-input" checked><span class="cash-destination-track" aria-hidden="true"></span><span class="cash-destination-label">In cassa</span></label><small class="cash-destination-reason" hidden>Modifica nel libro contabile</small>';
    const input = container.querySelector('input');
    if (id) input.id = id;
    return container;
  }
  function update(container, state, customer = '') {
    const input = container.querySelector('input');
    input.checked = state.value !== 'outside';
    input.disabled = state.locked || document.documentElement.dataset.cloudMode === 'read';
    input.setAttribute('aria-label', 'Destinazione importo' + (customer ? ' di ' + customer : '') + ': ' + labelFor(state.value));
    input.title = state.reason || 'Il completamento registra l’importo nella colonna scelta del libro contabile.';
    container.classList.toggle('is-locked', state.locked);
    const caption = container.querySelector('.cash-destination-label');
    if (caption.textContent !== labelFor(state.value)) caption.textContent = labelFor(state.value);
    const reason = container.querySelector('.cash-destination-reason');
    reason.hidden = !state.locked;
    reason.title = state.reason || '';
  }
  function renderRow(row) {
    const status = row.querySelector('.status-select,.parking-status');
    if (!status) return;
    let container = controls.get(row);
    if (!container?.isConnected) {
      container = row.querySelector('.cash-destination');
      if (!container) {
        container = control();
        if (row.tagName === 'TR') {
          const cell = document.createElement('td');
          cell.className = 'cash-destination-cell';
          cell.append(container);
          status.closest('td').before(cell);
        } else {
          container.classList.add('parking-cash-destination');
          status.closest('.parking-actions')?.before(container);
          if (!container.isConnected) status.parentElement.before(container);
        }
      }
      controls.set(row, container);
    }
    const state = api.destinationForRow(row);
    const name = row.tagName === 'TR' ? row.cells[1]?.textContent.trim() : row.children[0]?.querySelector('b')?.textContent.trim();
    update(container, state, name);
    let deposit=row.querySelector('.deposit-control');
    if(!deposit){
      deposit=document.createElement('div');deposit.className='deposit-control';
      deposit.innerHTML='<strong class="deposit-amount"></strong><button type="button" class="deposit-register" data-register-deposit>+ Acconto</button>';
      if(row.tagName==='TR'){
        const cell=document.createElement('td');cell.className='deposit-cell';cell.append(deposit);container.closest('td').before(cell);
      }else{deposit.classList.add('parking-deposit');container.before(deposit);}
    }
    const info=api.depositForRow(row),amount=deposit.querySelector('.deposit-amount'),button=deposit.querySelector('button');
    if(row.tagName!=='TR'&&!deposit.querySelector('.deposit-caption')) {
      const caption=document.createElement('small');caption.className='deposit-caption';caption.textContent='Acconto';deposit.prepend(caption);
    }
    const label=money(info.amount);if(amount.textContent!==label)amount.textContent=label;
    amount.title='Totale degli acconti già registrati in cassa';
    button.disabled=info.remaining<=0||document.documentElement.dataset.cloudMode==='read';
    button.setAttribute('aria-label','Registra un nuovo acconto per '+name);
    button.title=info.remaining>0?'Registra un nuovo pagamento anticipato in cassa.':'Non resta un importo da ricevere.';
  }
  function refresh() {
    const header = agenda.closest('table')?.querySelector('thead tr');
    if (header && !header.querySelector('.cash-destination-heading')) {
      const heading = document.createElement('th');
      heading.className = 'cash-destination-heading';
      heading.textContent = 'Cassa';
      heading.scope = 'col';
      header.children[5]?.before(heading);
    }
    if(header&&!header.querySelector('.deposit-heading')){
      const heading=document.createElement('th');heading.className='deposit-heading';heading.textContent='Acconto';heading.scope='col';
      header.querySelector('.cash-destination-heading')?.before(heading);
    }
    for (const row of rows()) renderRow(row);
    for (const cell of agenda.querySelectorAll('.agenda-empty td')) cell.colSpan = header?.children.length || 8;
  }
  document.addEventListener('change', event => {
    const input = event.target.closest('.cash-destination-input');
    const row = input?.closest('#agendaRows tr,.parking-row');
    if (!input || !row) return;
    const state = api.destinationForRow(row);
    if (state.locked) { renderRow(row); return; }
    try{api.setDestination(row,input.checked?'inCash':'outside');}catch(error){alert(error.message);}
    renderRow(row);
  });
  for (const [formId, fieldId] of [['appointmentForm', 'appCashDestination'], ['parkingForm', 'parkCashDestination']]) {
    const form = document.getElementById(formId);
    if (!form || form.querySelector('#' + fieldId)) continue;
    const field = document.createElement('div');
    field.className = 'field';
    const label = document.createElement('label');
    label.htmlFor = fieldId;
    label.textContent = 'Destinazione importo al completamento';
    field.append(label, control(fieldId));
    form.querySelector('.form-grid').append(field);
    field.querySelector('input').addEventListener('change', event => {
      if (formId === 'parkingForm' && parkingEditor?.row === editingParkingRow) {
        const state = api.destinationForRow(parkingEditor.row);
        if (state.locked) { update(field.querySelector('.cash-destination'), state); return; }
        parkingEditor.changed = true;
      }
      update(field.querySelector('.cash-destination'), {value:event.target.checked ? 'inCash' : 'outside', locked:false});
    });
    form.addEventListener('reset', () => setTimeout(() => {
      // Opening an existing parking sheet resets the form before filling it.
      // Its delayed reset callback must keep the loaded ledger allocation.
      if (formId === 'parkingForm' && parkingEditor?.row === editingParkingRow && parkingEditor.row.isConnected) {
        update(field.querySelector('.cash-destination'), api.destinationForRow(parkingEditor.row));
      } else {
        if (formId === 'parkingForm') parkingEditor = null;
        update(field.querySelector('.cash-destination'), {value:'inCash', locked:false});
      }
    }, 0));
  }
  const openParking = window.openParkingEditor;
  window.openParkingEditor = function(row) {
    const state = api.destinationForRow(row);
    parkingEditor = {row, changed:false};
    const result = openParking(row);
    update(document.getElementById('parkCashDestination').closest('.cash-destination'), state);
    return result;
  };
  document.addEventListener('click', event => {
    if (event.target.closest('[data-cloud-open="parkingModal"]')) {
      parkingEditor = null;
      update(document.getElementById('parkCashDestination').closest('.cash-destination'), {value:'inCash', locked:false});
    }
  }, true);
  document.addEventListener('submit', event => {
    if (event.target.id !== 'parkingForm') return;
    const row = parkingEditor?.row;
    // A switch cannot describe a manual split. Only an explicit user change
    // replaces a saved allocation; opening or saving the sheet keeps it.
    if (!row || row !== editingParkingRow || !parkingEditor.changed || api.destinationForRow(row).locked) return;
    const value=document.getElementById('parkCashDestination').checked?'inCash':'outside';
    try { api.setDestination(row, value); }
    catch (error) { event.preventDefault(); event.stopImmediatePropagation(); alert(error.message); }
  }, true);
  const money=value=>Number(value||0).toLocaleString('it-IT',{style:'currency',currency:'EUR'});
  const dialog=document.createElement('dialog');dialog.id='depositDialog';dialog.setAttribute('aria-labelledby','depositTitle');
  dialog.innerHTML='<form id="depositForm"><h2 id="depositTitle">Registra acconto</h2><p id="depositCustomer"></p><p>Il nuovo acconto viene registrato subito in cassa. Al completamento del lavoro verrà registrato soltanto il residuo.</p><p id="depositSummary"></p><div class="field"><label for="depositValue">Nuovo acconto (€)</label><input id="depositValue" type="text" inputmode="decimal" autocomplete="off" required placeholder="Es. 30,00"></div><p id="depositError" role="alert"></p><div class="modal-actions"><button type="button" class="btn secondary" id="cancelDeposit">Annulla</button><button class="btn" type="submit" id="confirmDeposit">Registra acconto</button></div></form>';
  document.body.append(dialog);
  const get=id=>document.getElementById(id);let depositRow=null,requestId='',busy=false;
  document.addEventListener('click',event=>{
    const trigger=event.target.closest('[data-register-deposit]');if(!trigger||trigger.disabled)return;
    depositRow=trigger.closest('#agendaRows tr,.parking-row');if(!depositRow)return;
    const info=api.depositForRow(depositRow);requestId=crypto.randomUUID();
    get('depositCustomer').textContent=info.customer+' · '+info.vehicle;
    get('depositSummary').textContent='Acconti già registrati: '+money(info.amount)+' · Ancora da ricevere: '+money(info.remaining);
    get('depositValue').value='';get('depositError').textContent='';dialog.showModal();get('depositValue').focus();
  });
  get('cancelDeposit').addEventListener('click',()=>{if(!busy)dialog.close();});
  dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
  get('depositForm').addEventListener('submit',async event=>{
    event.preventDefault();if(busy||!depositRow?.isConnected)return;
    busy=true;get('confirmDeposit').disabled=true;get('cancelDeposit').disabled=true;get('depositError').textContent='';
    try{
      api.recordDeposit(depositRow,get('depositValue').value,requestId);
      await window.WorkshopCloud?.flush();dialog.close();refresh();
    }catch(error){get('depositError').textContent=error.message||'Acconto non confermato. Conserva la bozza prima di ricaricare i dati.';refresh();}
    finally{busy=false;get('confirmDeposit').disabled=false;get('cancelDeposit').disabled=false;}
  });
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; refresh(); });
  };
  const observer = new MutationObserver(schedule);
  observer.observe(agenda, {childList:true, subtree:true});
  observer.observe(parking, {childList:true, subtree:true});
  new MutationObserver(schedule).observe(document.documentElement,{attributes:true,attributeFilter:['data-cloud-mode']});
  document.addEventListener('cashbook:changed', schedule);
  document.addEventListener('change', event => { if (event.target.matches('.status-select,.parking-status')) schedule(); });
  window.WorkshopCashDestination = {refresh, parkingFormDestination() {
    if (parkingEditor?.row === editingParkingRow) {
      const state = api.destinationForRow(parkingEditor.row);
      if (!parkingEditor.changed || state.locked) return state.value === 'split' ? parkingEditor.row.dataset.cashDestination : state.value;
    }
    return document.getElementById('parkCashDestination').checked ? 'inCash' : 'outside';
  }};
  refresh();
})();
