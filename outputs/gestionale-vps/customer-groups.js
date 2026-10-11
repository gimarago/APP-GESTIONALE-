/* The authoritative per-vehicle rows stay in #customerRows for cloud sync. */
(() => {
  'use strict';
  const source = document.getElementById('customerRows');
  const page = document.getElementById('clienti');
  const search = document.getElementById('search');
  if (!source || !page || !search) return;

  const sourceTable = source.closest('table');
  sourceTable.classList.add('customer-source-table');
  sourceTable.setAttribute('aria-hidden', 'true');
  const mobileSearch = document.createElement('input');
  mobileSearch.id = 'customerGroupMobileSearch';
  mobileSearch.className = 'customer-group-mobile-search';
  mobileSearch.type = 'search';
  mobileSearch.autocomplete = 'off';
  mobileSearch.setAttribute('aria-label', 'Cerca cliente o targa');
  mobileSearch.placeholder = 'Cerca cliente o targa';
  page.querySelector('.page-head')?.insertAdjacentElement('afterend', mobileSearch);
  const table = document.createElement('table');
  table.className = 'page-table customer-group-table';
  table.setAttribute('aria-label', 'Clienti e veicoli raggruppati');
  const head = document.createElement('thead');
  const heading = document.createElement('tr');
  for (const label of ['Cliente', 'Telefono', 'Email', 'Veicolo', 'Targa', 'Ultimo intervento']) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = label;
    heading.append(cell);
  }
  head.append(heading);
  const body = document.createElement('tbody');
  body.id = 'customerGroups';
  table.append(head, body);
  sourceTable.insertAdjacentElement('afterend', table);
  const empty = document.createElement('p');
  empty.className = 'customer-group-empty';
  empty.setAttribute('role', 'status');
  table.insertAdjacentElement('afterend', empty);
  const status = document.createElement('p');
  status.id = 'customerVehicleDeleteStatus';
  status.className = 'customer-vehicle-delete-status';
  status.setAttribute('role', 'status');
  status.hidden = true;
  table.insertAdjacentElement('afterend', status);

  const expanded = new Set();
  const collapsedDuringSearch = new Set();
  const normalize = value => String(value || '').trim().normalize('NFKC').toLocaleLowerCase('it-IT');
  const plateKey = value => normalize(value).replace(/[^a-z0-9]/g, '');
  const nonempty = value => value && value !== '—' && value !== '-' && value !== '–';
  const meaningful = value => nonempty(String(value || '').trim()) ? String(value).trim() : '';
  const vehicleKey = (vehicle, plate) => meaningful(plate) ? 'plate:' + plateKey(plate) : 'vehicle:' + normalize(meaningful(vehicle));
  const pending = new Set();
  const canWrite = () => document.documentElement.dataset.cloudMode !== 'read'
    && (!window.WorkshopCloud || window.parent.WorkshopCloudHost?.canWrite?.());
  const removedKeys = row => {
    try {
      const keys = JSON.parse(row.dataset.removedVehicles || '[]');
      return Array.isArray(keys) ? keys.filter(value => typeof value === 'string') : [];
    } catch { return []; }
  };
  const isoDate = value => {
    const text = String(value || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
    const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    return match ? `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}` : '';
  };
  const cell = (row, index) => row.cells[index]?.textContent.trim() || '';
  const appendCell = (row, text) => {
    const item = row.insertCell();
    item.textContent = text;
    return item;
  };
  const customerRows = key => [...source.rows].filter(row => row.cells.length >= 6 && normalize(cell(row, 0)) === key);
  const fingerprint = rows => JSON.stringify(rows.map(row => window.WorkshopCloud?.serialize(row) || row.outerHTML));
  const say = (message, error = false) => {
    status.hidden = !message;
    status.textContent = message;
    status.classList.toggle('is-error', error);
    status.setAttribute('role', error ? 'alert' : 'status');
  };

  window.WorkshopCustomerArchive = {
    // A removed plate must not be projected back from historical parking work.
    // Explicitly saved vehicle rows always take precedence over a tombstone.
    isVehicleRemoved(name, plate) {
      const key = plateKey(meaningful(plate));
      if (!key) return false;
      const rows = customerRows(normalize(name));
      if (rows.some(row => meaningful(cell(row, 4)) && plateKey(cell(row, 4)) === key)) return false;
      return rows.some(row => removedKeys(row).includes('plate:' + key));
    }
  };

  async function removeVehicle(group, item) {
    if (!canWrite() || pending.has(group.key)) return;
    const rows = customerRows(group.key);
    const key = vehicleKey(item.vehicle, item.plate);
    const matches = rows.filter(row => vehicleKey(cell(row, 3), cell(row, 4)) === key);
    if (!matches.length) { say('Il veicolo non è più presente. Aggiorna i dati.', true); return; }
    const description = [meaningful(item.vehicle), meaningful(item.plate)].filter(Boolean).join(' · ') || 'questo veicolo';
    if (!confirm('Eliminare ' + description + ' dall’anagrafica di ' + group.name + '? Il cliente e lo storico dei lavori e dei documenti saranno conservati.')) return;
    const before = fingerprint(rows);
    pending.add(group.key);
    render();
    say('Eliminazione del veicolo…');
    try {
      await window.WorkshopCloud?.flush();
      if (!canWrite()) return;
      const current = customerRows(group.key);
      if (fingerprint(current) !== before || matches.some(row => !row.isConnected || row.parentElement !== source)) {
        throw Error('I dati di questo cliente sono cambiati. Controlla il veicolo prima di eliminarlo.');
      }
      const keys = new Set(current.flatMap(removedKeys));
      keys.add(key);
      let keeper = current.find(row => !matches.includes(row));
      if (!keeper) {
        // Preserve the customer even when the last vehicle is removed. This
        // row carries contacts, fiscal identity and suppression of old work.
        keeper = matches[0];
        keeper.cells[3].replaceChildren();
        keeper.cells[4].replaceChildren();
        delete keeper.dataset.revisionCategory;
        delete keeper.dataset.revisionInterval;
      }
      keeper.dataset.removedVehicles = JSON.stringify([...keys].sort());
      for (const row of matches) if (row !== keeper) row.remove();
      if (typeof knownClients !== 'undefined') for (const name of Object.keys(knownClients)) {
        if (normalize(name) === group.key) delete knownClients[name];
      }
      window.updateCustomerSuggestions?.();
      document.dispatchEvent(new CustomEvent('workshop-customer-vehicle-removed', {detail:{name:group.name, plate:item.plate, vehicle:item.vehicle}}));
      window.WorkshopCloud?.changed();
      render();
      await window.WorkshopCloud?.flush();
      say('Veicolo eliminato dall’anagrafica.');
    } catch (error) {
      // The cloud bridge keeps the complete draft on a failed or conflicting
      // commit. Restoring old rows here would overwrite concurrent edits.
      say(error.message || 'Impossibile confermare l’eliminazione del veicolo.', true);
    } finally {
      pending.delete(group.key);
      render();
      [...body.querySelectorAll('.customer-group-row')]
        .find(row => row.dataset.customerKey === group.key)
        ?.querySelector('.customer-group-toggle')?.focus();
    }
  }

  function groupedRows() {
    const groups = new Map();
    for (const row of source.rows) {
      if (row.cells.length < 6) continue;
      const name = cell(row, 0);
      if (!name) continue;
      const key = normalize(name);
      let group = groups.get(key);
      if (!group) {
        group = {key, name, phone:'', email:'', latest:'', latestISO:'', vehicles:new Map()};
        groups.set(key, group);
      }
      const phone = cell(row, 1);
      const email = cell(row, 2);
      if (!group.phone && nonempty(phone)) group.phone = phone;
      if (!group.email && nonempty(email)) group.email = email;
      const vehicle = cell(row, 3);
      const plate = cell(row, 4);
      const last = cell(row, 5);
      const date = isoDate(last);
      if (date && date > group.latestISO) {
        group.latestISO = date;
        group.latest = last;
      }
      // A customer without associated vehicles is still a valid customer.
      if (!meaningful(vehicle) && !meaningful(plate)) continue;
      const associatedKey = vehicleKey(vehicle, plate);
      const previous = group.vehicles.get(associatedKey);
      if (!previous || (date && date > previous.latestISO)) {
        group.vehicles.set(associatedKey, {vehicle, plate, latest:last, latestISO:date});
      }
    }
    return [...groups.values()];
  }

  function openHistory(name, vehicle = '', plate = '') {
    if (typeof window.openCustomerHistory === 'function') window.openCustomerHistory(name, vehicle, plate);
  }

  function render() {
    const query = normalize(search.value);
    const compactQuery = plateKey(query);
    const fragment = document.createDocumentFragment();
    let matching = 0;
    for (const group of groupedRows()) {
      const allVehicles = [...group.vehicles.values()];
      const matchesName = normalize(group.name).includes(query);
      const matchingVehicles = allVehicles.filter(item => {
        const plate = plateKey(item.plate);
        return normalize(item.vehicle).includes(query)
          || normalize(item.plate).includes(query)
          || (compactQuery && plate.includes(compactQuery));
      });
      if (query && !matchesName && !matchingVehicles.length) continue;
      matching += 1;
      const shownVehicles = query && !matchesName ? matchingVehicles : allVehicles;
      const isOpen = query ? !collapsedDuringSearch.has(group.key) : expanded.has(group.key);

      const parent = document.createElement('tr');
      parent.className = 'customer-group-row';
      parent.dataset.customerKey = group.key;
      const first = parent.insertCell();
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'customer-group-toggle customer-open';
      toggle.setAttribute('aria-expanded', String(isOpen));
      toggle.setAttribute('aria-label', `${isOpen ? 'Nascondi' : 'Mostra'} ${allVehicles.length} ${allVehicles.length === 1 ? 'veicolo' : 'veicoli'} di ${group.name}`);
      toggle.textContent = group.name;
      first.append(toggle);
      const count = document.createElement('small');
      count.className = 'customer-group-count';
      count.textContent = `${allVehicles.length} ${allVehicles.length === 1 ? 'veicolo' : 'veicoli'}`;
      first.append(count);
      appendCell(parent, group.phone || '—');
      appendCell(parent, group.email || '—');
      const historyCell = parent.insertCell();
      const history = document.createElement('button');
      history.type = 'button';
      history.className = 'customer-group-history customer-open';
      history.textContent = 'Storico e dati cliente';
      history.setAttribute('aria-label', `Apri storico e dati di ${group.name}`);
      history.addEventListener('click', () => openHistory(group.name));
      historyCell.append(history);
      appendCell(parent, '—');
      appendCell(parent, group.latest || '—');
      toggle.addEventListener('click', () => {
        const set = query ? collapsedDuringSearch : expanded;
        if (set.has(group.key)) set.delete(group.key);
        else set.add(group.key);
        if (query) {
          if (isOpen) set.add(group.key);
          else set.delete(group.key);
        }
        render();
        [...body.querySelectorAll('.customer-group-row')]
          .find(row => row.dataset.customerKey === group.key)
          ?.querySelector('.customer-group-toggle')?.focus();
      });
      fragment.append(parent);

      if (!isOpen) continue;
      for (const item of shownVehicles) {
        const child = document.createElement('tr');
        child.className = 'customer-vehicle-row';
        child.dataset.customerKey = group.key;
        appendCell(child, '↳');
        appendCell(child, '');
        appendCell(child, '');
        const vehicleCell = child.insertCell();
        const vehicleButton = document.createElement('button');
        vehicleButton.type = 'button';
        vehicleButton.className = 'customer-vehicle-history customer-open';
        vehicleButton.textContent = item.vehicle || 'Veicolo non specificato';
        vehicleButton.setAttribute('aria-label', `Apri storico di ${group.name}, ${item.vehicle || 'veicolo'} ${item.plate}`);
        vehicleButton.addEventListener('click', () => openHistory(group.name, item.vehicle, item.plate));
        vehicleCell.append(vehicleButton);
        const plateCell = child.insertCell();
        const plateLabel = document.createElement('span');
        plateLabel.className = 'plate';
        plateLabel.textContent = item.plate || '—';
        plateCell.append(plateLabel);
        const lastCell = appendCell(child, item.latest || '—');
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'customer-vehicle-delete';
        remove.textContent = '×';
        remove.title = 'Elimina veicolo';
        remove.setAttribute('aria-label', `Elimina ${meaningful(item.vehicle) || 'veicolo'} ${meaningful(item.plate)} di ${group.name}`);
        remove.disabled = document.documentElement.dataset.cloudMode === 'read' || pending.has(group.key);
        remove.hidden = document.documentElement.dataset.cloudMode === 'read';
        remove.addEventListener('click', event => { event.stopPropagation(); removeVehicle(group, item); });
        lastCell.classList.add('customer-vehicle-actions');
        lastCell.append(remove);
        fragment.append(child);
      }
    }
    body.replaceChildren(fragment);
    empty.hidden = matching > 0;
    empty.textContent = query ? 'Nessun cliente o targa corrispondente.' : 'Nessun cliente registrato.';
  }

  let scheduled = false;
  function scheduleRender() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      render();
    });
  }
  search.addEventListener('input', () => {
    mobileSearch.value = search.value;
    collapsedDuringSearch.clear();
    scheduleRender();
  });
  mobileSearch.addEventListener('input', () => {
    search.value = mobileSearch.value;
    search.dispatchEvent(new Event('input'));
  });
  mobileSearch.value = search.value;
  // An intentional form save may re-associate a previously removed plate.
  // Capture the values before the legacy submit handler resets its inputs.
  document.getElementById('customerForm')?.addEventListener('submit', () => {
    const name = document.getElementById('customerName')?.value;
    const plate = document.getElementById('customerPlate')?.value;
    const vehicle = document.getElementById('customerVehicle')?.value;
    const key = vehicleKey(vehicle, plate);
    const before = new Set(customerRows(normalize(name)));
    setTimeout(() => {
      if (!canWrite()) return;
      const rows = customerRows(normalize(name));
      const added = rows.find(row => !before.has(row) && vehicleKey(cell(row, 3), cell(row, 4)) === key);
      if (!added) return;
      const keys = new Set(rows.flatMap(removedKeys));
      keys.delete(key);
      if (keys.size) added.dataset.removedVehicles = JSON.stringify([...keys].sort());
      for (const row of rows) {
        if (row !== added) {
          const remaining = removedKeys(row).filter(value => value !== key);
          if (remaining.length) row.dataset.removedVehicles = JSON.stringify(remaining);
          else delete row.dataset.removedVehicles;
          if (!meaningful(cell(row, 3)) && !meaningful(cell(row, 4))) row.remove();
        }
      }
    }, 0);
  }, true);
  new MutationObserver(scheduleRender).observe(source, {childList:true, subtree:true, characterData:true});
  new MutationObserver(scheduleRender).observe(document.documentElement, {attributes:true, attributeFilter:['data-cloud-mode']});
  render();
})();
