/* Manual recalls share the authoritative per-vehicle customer rows. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const source = $('customerRows'), form = $('recallForm'), customer = $('recallCustomer');
  const button = document.querySelector('#richiami .page-head .btn');
  if (!source || !form || !customer || !button) return;
  const normalize = value => String(value || '').trim().normalize('NFKC').toLocaleLowerCase('it-IT');
  const plateKey = value => normalize(value).replace(/[^a-z0-9]/g, '');
  const nonempty = value => value && !['—', '-', '–'].includes(value);
  const field = document.createElement('div');
  field.className = 'field full hidden';
  field.id = 'recallVehicleField';
  field.hidden = true;
  const label = document.createElement('label');
  label.htmlFor = 'recallVehicle';
  label.textContent = 'Veicolo';
  const vehicle = document.createElement('select');
  vehicle.id = 'recallVehicle';
  field.append(label, vehicle);
  customer.closest('.field').after(field);
  let groups = [];

  function groupedCustomers() {
    const result = new Map();
    for (const row of source.rows) {
      if (row.cells.length < 6) continue;
      const name = row.cells[0].textContent.trim(), key = normalize(name);
      if (!name) continue;
      if (!result.has(key)) result.set(key, {key, name, vehicles:new Map()});
      const model = row.cells[3].textContent.trim(), plate = row.cells[4].textContent.trim();
      if (!nonempty(model) && !nonempty(plate)) continue;
      const id = plateKey(plate) || 'vehicle:' + normalize(model);
      if (!result.get(key).vehicles.has(id)) result.get(key).vehicles.set(id, {
        id, model:nonempty(model) ? model : '', plate:nonempty(plate) ? plate : ''
      });
    }
    return [...result.values()].sort((a, b) => a.name.localeCompare(b.name, 'it', {sensitivity:'base'}));
  }

  function updateVehicles() {
    const group = groups.find(item => item.key === customer.value);
    const choices = group ? [...group.vehicles.values()] : [];
    const multiple = choices.length > 1;
    field.hidden = !multiple;
    field.classList.toggle('hidden', !multiple);
    vehicle.required = multiple;
    vehicle.disabled = !multiple;
    vehicle.replaceChildren(...choices.map(item => new Option([item.model, item.plate].filter(Boolean).join(' · '), item.id)));
    if (multiple) vehicle.prepend(new Option('Seleziona un veicolo', ''));
    vehicle.value = choices.length === 1 ? choices[0].id : '';
  }

  button.textContent = '+ Aggiungi richiamo';
  button.removeAttribute('data-cloud-open');
  button.onclick = () => {
    form.reset();
    groups = groupedCustomers();
    customer.replaceChildren(new Option(groups.length ? 'Seleziona un cliente' : 'Nessun cliente in archivio', ''),
      ...groups.map(group => new Option(group.name, group.key)));
    customer.value = '';
    form.querySelector('[type="submit"]').disabled = !groups.length;
    $('recallDate').value = localCreationDate();
    updateVehicles();
    openModal('recallModal');
    customer.focus();
  };
  customer.addEventListener('change', updateVehicles);
  form.addEventListener('submit', event => {
    event.preventDefault();
    const group = groups.find(item => item.key === customer.value);
    if (!group || !form.reportValidity()) return;
    const selected = group.vehicles.get(vehicle.value);
    if (group.vehicles.size > 1 && !selected) { vehicle.focus(); return; }
    const row = document.createElement('div');
    row.className = 'agenda-row';
    const dot = document.createElement('div');
    dot.className = 'dot';
    const content = document.createElement('div');
    content.className = 'agenda-text';
    const name = document.createElement('b'), detail = document.createElement('span');
    name.textContent = group.name;
    if (selected) {
      if (selected.model) row.dataset.vehicle = selected.model;
      if (selected.plate) row.dataset.plate = selected.plate;
    }
    detail.textContent = [$('recallReason').value.trim(), selected && [selected.model, selected.plate].filter(Boolean).join(' · '),
      $('recallDate').value.split('-').reverse().join('/')].filter(Boolean).join(' · ');
    content.append(name, detail);
    row.append(dot, content);
    document.querySelector('#richiami .agenda-list').append(row);
    closeModal('recallModal');
    form.reset();
    updateVehicles();
    window.WorkshopRevisionReminders?.refresh();
  });
})();
