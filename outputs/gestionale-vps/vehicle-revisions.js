(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const schedule = window.WorkshopRevisionSchedule;
  const reminders = window.WorkshopRevisionReminders;
  const source = $('customerRows');
  const history = $('historyModal');
  const customerForm = $('customerForm');
  if (!schedule || !reminders || !source || !history || !customerForm) return;
  const writable = () => !window.WorkshopCloud || (document.documentElement.dataset.cloudMode === 'edit' && window.WorkshopCloud.boot.user.role !== 'viewer');
  const maySave = () => writable() && (!window.WorkshopCloud || window.parent.WorkshopCloudHost?.canWrite?.());
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const fillOptions = select => select.replaceChildren(...schedule.categories.map(item => new Option(item.label, item.value)));
  const dateLabel = value => value ? value.split('-').reverse().join('/') : 'Non registrata';
  const nameKey = value => String(value || '').trim().normalize('NFKC').toLocaleLowerCase('it-IT');

  const newField = node('div', 'field full vehicle-revision-new-field');
  const newLabel = node('label', '', 'Categoria per i richiami revisione');
  newLabel.htmlFor = 'customerRevisionCategory';
  const newCategory = node('select');
  newCategory.id = 'customerRevisionCategory';
  fillOptions(newCategory);
  newField.append(newLabel, newCategory);
  customerForm.querySelector('.form-grid').append(newField);

  // Store the selection on the newly created authoritative vehicle row, after
  // the legacy form handler has created it and reset the visible fields.
  const submitted = new WeakMap();
  customerForm.addEventListener('submit', event => {
    if (!maySave()) return;
    submitted.set(event, {rows:new Set(source.rows), category:newCategory.value});
  }, true);
  customerForm.addEventListener('submit', event => {
    const pending = submitted.get(event);
    if (!pending || event.defaultPrevented && customerForm.closest('.form-modal')?.classList.contains('open')) return;
    const row = [...source.rows].find(item => !pending.rows.has(item));
    if (!row) return;
    const value = schedule.category(pending.category).value;
    if (value) row.dataset.revisionCategory = value;
    reminders.refresh();
  });
  const additionalVehicle = window.openAdditionalVehicle;
  if (typeof additionalVehicle === 'function') window.openAdditionalVehicle = function(name) {
    newCategory.value = '';
    return additionalVehicle.apply(this, arguments);
  };
  document.querySelector('#clienti [data-cloud-open="customerModal"]')?.addEventListener('click', () => { newCategory.value = ''; }, true);

  const modal = node('div', 'form-modal');
  modal.id = 'vehicleRevisionModal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'vehicleRevisionTitle');
  modal.innerHTML = '<form id="vehicleRevisionForm" class="modal-card"><h2 id="vehicleRevisionTitle">Revisioni veicoli</h2><p id="vehicleRevisionCustomer"></p><p id="vehicleRevisionHint">Scegli l’intervallo per ciascuna targa. Il campo resta vuoto finché non lo imposti; la scadenza usa l’ultima revisione completata e la fine del mese.</p><div id="vehicleRevisionRows"></div><p id="vehicleRevisionError" role="alert"></p><div class="modal-actions"><button id="vehicleRevisionClose" type="button" class="btn secondary">Chiudi</button><button id="vehicleRevisionSave" type="submit" class="btn">Salva categorie</button></div></form>';
  document.querySelector('main').append(modal);
  const button = node('button', 'btn secondary', 'Revisioni veicoli');
  button.type = 'button';
  button.id = 'openVehicleRevisions';
  history.querySelector('.modal-actions').prepend(button);

  let selectedCustomer = '', selectedPlate = '', selectedVehicle = '', settings = [], saving = false;
  let returnToHistory = true, returnFocus = null;
  const pendingWork = new Set();
  const groupedHistory = window.openCustomerHistory;
  if (typeof groupedHistory === 'function') window.openCustomerHistory = function(name, vehicle, plate) {
    selectedCustomer = String(name || '').trim();
    selectedVehicle = String(vehicle || '');
    selectedPlate = schedule.plateKey(plate);
    return groupedHistory.apply(this, arguments);
  };

  function updateMode() {
    for (const {select} of settings) select.disabled = !writable() || saving;
    $('vehicleRevisionSave').hidden = !writable();
    $('vehicleRevisionSave').disabled = saving;
    newCategory.disabled = !writable();
  }
  function preview(item) {
    const latest = item.latest;
    const due = schedule.deadline(latest, item.select.value);
    item.summary.textContent = !item.select.value
      ? 'Intervallo non impostato.' + (latest ? ' Ultima revisione: ' + dateLabel(latest) + '.' : '') + ' I richiami automatici inizieranno dopo la scelta dell’intervallo.'
      : latest
      ? 'Ultima revisione: ' + dateLabel(latest) + ' · Prossima scadenza: ' + dateLabel(due)
      : 'Nessuna revisione completata registrata: la scadenza verrà calcolata quando sarà disponibile.';
  }
  function open(name = selectedCustomer, plate = selectedPlate, options = {}) {
    returnToHistory = !options.fromWork;
    returnFocus = options.focus || null;
    selectedCustomer = String(name || '').trim();
    selectedPlate = schedule.plateKey(plate);
    const matches = [...source.rows].filter(row => nameKey(row.cells[0]?.textContent) === nameKey(selectedCustomer) && (!selectedPlate || schedule.plateKey(row.cells[4]?.textContent) === selectedPlate));
    const groups = new Map();
    for (const row of matches) {
      const id = schedule.plateKey(row.cells[4]?.textContent);
      if (!id) continue;
      if (!groups.has(id)) groups.set(id, {plate:row.cells[4].textContent.trim(), vehicle:row.cells[3]?.textContent.trim() || 'Veicolo', rows:[]});
      groups.get(id).rows.push(row);
    }
    settings = [];
    const latest = reminders.automaticDates().latest;
    $('vehicleRevisionRows').replaceChildren();
    $('vehicleRevisionCustomer').textContent = selectedCustomer;
    $('vehicleRevisionHint').textContent = options.fromWork
      ? 'La lavorazione contiene una revisione. Imposta l’intervallo per questa targa per attivare i richiami; puoi anche chiudere e compilarlo in seguito.'
      : 'Scegli l’intervallo per ciascuna targa. Il campo resta vuoto finché non lo imposti; la scadenza usa l’ultima revisione completata e la fine del mese.';
    $('vehicleRevisionError').textContent = '';
    for (const item of groups.values()) {
      const card = node('div', 'vehicle-revision-item');
      const heading = node('h3', '', item.vehicle + ' · ' + item.plate);
      const select = node('select');
      select.id = 'vehicleRevisionCategory-' + schedule.plateKey(item.plate);
      select.dataset.plate = schedule.plateKey(item.plate);
      const label = node('label', '', 'Categoria e intervallo revisione');
      label.htmlFor = select.id;
      fillOptions(select);
      select.value = schedule.category(item.rows[0].dataset.revisionCategory).value;
      const summary = node('p', 'vehicle-revision-summary');
      const setting = {...item, select, summary, latest:latest[schedule.plateKey(item.plate)]};
      select.addEventListener('change', () => preview(setting));
      card.append(heading, label, select, summary);
      $('vehicleRevisionRows').append(card);
      settings.push(setting);
      preview(setting);
    }
    if (!settings.length) $('vehicleRevisionRows').append(node('p', '', 'Nessun veicolo con una targa registrata.'));
    updateMode();
    window.closeModal('historyModal');
    modal.classList.add('open');
    (settings[0]?.select || $('vehicleRevisionClose')).focus();
  }
  function close() {
    if (saving) return;
    modal.classList.remove('open');
    if (returnToHistory && selectedCustomer) {
      window.openCustomerHistory(selectedCustomer, selectedVehicle, selectedPlate);
      button.focus();
    } else if (returnFocus?.isConnected) returnFocus.focus();
    else document.querySelector('.nav [data-view].active')?.focus();
    setTimeout(openPendingWork, 0);
  }
  button.addEventListener('click', () => open());
  $('vehicleRevisionClose').addEventListener('click', close);
  modal.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (event.key !== 'Tab') return;
    const focusable = [...modal.querySelectorAll('button,select')].filter(element => !element.disabled && !element.hidden);
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  $('vehicleRevisionForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (saving || !maySave()) return;
    if (settings.some(item => item.rows.some(row => !row.isConnected))) {
      $('vehicleRevisionError').textContent = 'I veicoli sono cambiati. Chiudi e riapri le categorie prima di salvare.';
      return;
    }
    saving = true;
    updateMode();
    try {
      for (const item of settings) {
        const value = schedule.category(item.select.value).value;
        for (const row of item.rows) {
          if (!value) delete row.dataset.revisionCategory;
          else if (row.dataset.revisionCategory !== value) row.dataset.revisionCategory = value;
        }
      }
      reminders.refresh();
      window.WorkshopCloud?.changed(false);
      if (window.WorkshopCloud) await window.WorkshopCloud.flush();
      if (window.WorkshopCloud && !window.parent.WorkshopCloudHost?.canWrite?.()) {
        $('vehicleRevisionError').textContent = 'Le modifiche sono ancora da sincronizzare. Controlla lo stato del collegamento prima di chiudere.';
        return;
      }
      saving = false;
      close();
    } catch {
      $('vehicleRevisionError').textContent = 'Salvataggio non riuscito. Le categorie restano nella bozza: controlla il collegamento e riprova.';
    } finally {
      saving = false;
      updateMode();
    }
  });
  const workRows = () => [...document.querySelectorAll('#agendaRows tr:not(.agenda-empty),#agenda .parking-row')];
  function workData(row) {
    const parking = row.classList.contains('parking-row');
    let lines = [];
    try { lines = JSON.parse(row.dataset[parking ? 'workLines' : 'acceptanceLines'] || '[]'); } catch {}
    const descriptions = Array.isArray(lines) && lines.length ? lines.map(line => String(line.description || ''))
      : [parking ? row.children[3]?.querySelector('b')?.textContent || '' : row.querySelector('.work-input')?.value || row.cells[3]?.textContent || ''];
    const plate = schedule.plateKey(parking ? row.children[0]?.querySelector('small')?.textContent.split('·')[0] : row.cells[2]?.textContent);
    return {plate, descriptions, signature:JSON.stringify([plate, descriptions])};
  }
  function openPendingWork() {
    if (!writable() || window.WorkshopCloud?.initializing) { pendingWork.clear(); return; }
    if (document.querySelector('.form-modal.open,dialog[open]')) return;
    for (const row of pendingWork) {
      pendingWork.delete(row);
      if (!row.isConnected) continue;
      const data = workData(row);
      if (!data.plate || !data.descriptions.some(schedule.isRevision)) continue;
      const matches = [...source.rows].filter(item => schedule.plateKey(item.cells[4]?.textContent) === data.plate);
      if (!matches.length || matches.some(item => schedule.category(item.dataset.revisionCategory).value)) continue;
      const customer = matches[0].cells[0]?.textContent.trim();
      const focus = row.querySelector('.status-select,.parking-status,.work-input');
      open(customer, data.plate, {fromWork:true, focus});
      return;
    }
  }
  // Work forms reset immediately, and the legacy creation handlers finish the
  // customer and line data asynchronously. Inspect the saved rows afterwards.
  document.addEventListener('submit', event => {
    const form = event.target;
    if (!form.matches('#appointmentForm,#acceptanceForm,#parkingForm') || !maySave() || window.WorkshopCloud?.initializing) return;
    const edited = form.id === 'acceptanceForm' ? window.getEditedAcceptanceRow?.()
      : form.id === 'parkingForm' && typeof editingParkingRow !== 'undefined' ? editingParkingRow : null;
    const before = new Map(workRows().map(row => [row, workData(row).signature]));
    setTimeout(() => {
      if (form.closest('.form-modal')?.classList.contains('open') || !writable()) return;
      if (edited?.isConnected) pendingWork.add(edited);
      for (const row of workRows()) if (before.get(row) !== workData(row).signature) pendingWork.add(row);
      openPendingWork();
    }, 300);
  }, true);
  document.addEventListener('change', event => {
    if (!event.target.matches('#agendaRows .work-input,#agendaRows .status-select,#agenda .parking-status') || !maySave() || window.WorkshopCloud?.initializing) return;
    const row = event.target.closest('tr,.parking-row');
    if (!row) return;
    setTimeout(() => { pendingWork.add(row); openPendingWork(); }, 300);
  }, true);
  const modalObserver = new MutationObserver(() => { if (pendingWork.size) openPendingWork(); });
  for (const dialog of document.querySelectorAll('.form-modal,dialog')) modalObserver.observe(dialog, {attributes:true,attributeFilter:['class','open']});
  new MutationObserver(updateMode).observe(document.documentElement, {attributes:true, attributeFilter:['data-cloud-mode']});
  window.WorkshopVehicleRevisions = {open};
  updateMode();
})();
