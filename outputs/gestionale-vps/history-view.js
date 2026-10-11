/* One history card represents one completed workshop intervention. */
(() => {
  'use strict';

  const modal = document.getElementById('historyModal');
  const title = document.getElementById('historyTitle');
  const vehicleSummary = document.getElementById('historyVehicle');
  const content = document.getElementById('historyContent');
  if (!modal || !title || !vehicleSummary || !content) return;

  const searchLabel = document.createElement('label');
  searchLabel.className = 'history-search-label';
  searchLabel.htmlFor = 'historyWorkSearch';
  searchLabel.textContent = 'Cerca nei lavori eseguiti';
  const search = document.createElement('input');
  search.id = 'historyWorkSearch';
  search.type = 'search';
  search.autocomplete = 'off';
  search.placeholder = 'Es. pneumatici, frizione, tagliando';
  const resultCount = document.createElement('p');
  resultCount.id = 'historyResultCount';
  resultCount.setAttribute('role', 'status');
  vehicleSummary.after(searchLabel, search, resultCount);

  const normalize = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('it-IT');
  const plateKey = value => String(value ?? '').replace(/[^a-z0-9]/gi, '').toUpperCase();
  const number = value => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    let raw = String(value ?? '').replace(/[^0-9,.-]/g, '');
    if (raw.includes(',')) raw = raw.replace(/\./g, '').replace(',', '.');
    return Number(raw) || 0;
  };
  const money = value => new Intl.NumberFormat('it-IT', {style:'currency', currency:'EUR'}).format(number(value));
  const isoDate = value => {
    const text = String(value ?? '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
    const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    return match ? match[3] + '-' + match[2].padStart(2, '0') + '-' + match[1].padStart(2, '0') : '';
  };
  const dateLabel = value => {
    const iso = isoDate(value);
    return iso ? iso.split('-').reverse().join('/') : String(value || '—');
  };
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const workLines = (lines, fallbackWork, fallbackAmount) => {
    const valid = Array.isArray(lines) ? lines.filter(line => String(line?.description || '').trim()) : [];
    return (valid.length ? valid : [{description:fallbackWork || 'Intervento', amount:fallbackAmount || 0}])
      .map(line => ({description:String(line.description).trim(), amount:number(line.amount)}));
  };
  const mileage = value => {
    const raw = String(value ?? '').replace(/\s/g, '').replace(/\.(?=\d{3}(?:\D|$))/g, '').replace(',', '.').replace(/[^0-9.]/g, '');
    const km = Number(raw);
    return raw !== '' && Number.isFinite(km) && km >= 0 ? Math.round(km).toLocaleString('it-IT') + ' km' : '';
  };

  let groups = [];
  function collectGroups(name, vehicle, plate) {
    const selectedPlate = plateKey(plate);
    const customerName = normalize(name.trim());
    const readRowLines = (row, key, fallbackWork, fallbackAmount) => {
      let lines = [];
      try { lines = JSON.parse(row.dataset[key] || '[]'); } catch (_) { lines = []; }
      return workLines(lines, fallbackWork, fallbackAmount);
    };
    const agendaGroups = [...document.querySelectorAll('#agendaRows tr')]
      .filter(row => row.querySelector('.status-select')?.value === 'COMPLETATO'
        && (selectedPlate ? plateKey(row.cells[2]?.textContent) === selectedPlate : normalize(row.cells[1]?.textContent) === customerName))
      .map((row, index) => {
        const work = row.cells[3]?.querySelector('.work-input')?.value || row.cells[3]?.textContent || 'Intervento';
        const amount = row.cells[4]?.querySelector('.amount-input')?.value || row.cells[4]?.textContent || 0;
        const lines = readRowLines(row, 'acceptanceLines', work, amount);
        return {
          id:row.dataset.cloudId || row.dataset.cashAccountId || row.dataset.ledgerKey || 'agenda-' + index,
          source:'agenda',
          date:row.dataset.date || workshopToday,
          time:row.cells[0]?.textContent.trim() || '',
          vehicle:[row.dataset.vehicle || vehicle, row.cells[2]?.textContent.trim(), mileage(row.dataset.km)].filter(Boolean).join(' · '),
          total:amount,
          lines,
          notes:row.dataset.workNotes || '',
          order:index
        };
      });
    const parkingGroups = [...document.querySelectorAll('#agenda .parking-section .parking-row')]
      .filter(row => row.querySelector('.parking-status')?.value === 'COMPLETATO')
      .map(row => ({row, data:window.parkingDataFromRow(row)}))
      .filter(({data}) => selectedPlate ? plateKey(data.plate) === selectedPlate : normalize(data.customer) === customerName)
      .map(({row, data}, index) => {
        const fallbackAmount = row.querySelector('.parking-total strong')?.textContent || 0;
        const lines = readRowLines(row, 'workLines', data.work || 'Intervento', fallbackAmount);
        return {
          id:row.dataset.cloudId || row.dataset.cashAccountId || row.dataset.ledgerKey || 'parking-' + index,
          source:'parking',
          date:row.dataset.completedDate || data.completedDate || data.exit || workshopToday,
          time:'',
          vehicle:[data.vehicle || vehicle, data.plate || plate, mileage(data.km ?? row.dataset.km)].filter(Boolean).join(' · '),
          total:lines.reduce((sum, line) => sum + line.amount, 0),
          lines,
          notes:row.dataset.workNotes || '',
          order:agendaGroups.length + index
        };
      });
    const liveIds = new Set([...agendaGroups, ...parkingGroups].map(group => group.id));
    const archivedGroups = (window.WorkshopLedgerCash?.snapshot().entries || [])
      .filter(entry => !entry.sourceRow && normalize(entry.customer) === customerName
        && !liveIds.has(entry.cashId) && !liveIds.has(entry.key)
        && (!selectedPlate || plateKey(entry.vehicle).includes(selectedPlate)))
      .map((entry, index) => {
        const lines = workLines(entry.lines, entry.work, entry.amount);
        return {
          id:entry.cashId || entry.key || 'archive-' + index,
          source:entry.source || 'archive',
          date:entry.date,
          time:entry.time && entry.time !== '—' ? entry.time : '',
          vehicle:String(entry.vehicle || plate || vehicle || '').trim(),
          total:entry.amount ?? lines.reduce((sum, line) => sum + line.amount, 0),
          lines,
          notes:entry.notes || '',
          order:agendaGroups.length + parkingGroups.length + index
        };
      });

    let imported = [];
    try {
      const data = JSON.parse(localStorage.getItem('officina-table-import-v1') || 'null');
      imported = Array.isArray(data?.history) ? data.history : [];
    } catch (_) {
      imported = [];
    }
    const importedGroups = imported
      .filter(item => String(item.work || '').trim() && (selectedPlate ? plateKey(item.plate) === selectedPlate : normalize(item.customer) === customerName))
      .map((item, index) => ({
        id:'import-' + index,
        source:'import',
        date:item.date,
        time:'',
        vehicle:[item.vehicle, item.plate, mileage(item.km)].filter(Boolean).join(' · '),
        total:item.amount,
        lines:workLines(null, item.work, item.amount),
        notes:item.notes || '',
        order:agendaGroups.length + parkingGroups.length + archivedGroups.length + index
      }));
    return [...agendaGroups, ...parkingGroups, ...archivedGroups, ...importedGroups]
      .sort((a, b) => isoDate(b.date).localeCompare(isoDate(a.date)) || String(b.time).localeCompare(String(a.time)) || a.order - b.order);
  }

  function render() {
    const query = normalize(search.value.trim());
    const visible = groups.filter(group => !query || group.lines.some(line => normalize(line.description).includes(query)));
    resultCount.textContent = visible.length === 1 ? '1 intervento' : visible.length + ' interventi';
    content.replaceChildren();
    if (!visible.length) {
      content.append(element('p', 'history-empty', query
        ? 'Nessun lavoro eseguito corrisponde alla ricerca.'
        : 'Nessun intervento completato ancora registrato per questo veicolo.'));
      return;
    }
    for (const group of visible) {
      const card = element('article', 'history-job');
      card.dataset.historyId = group.id;
      card.dataset.historySource = group.source;
      const heading = element('div', 'history-job-heading');
      const headingText = element('div', 'history-job-heading-text');
      headingText.append(
        element('strong', 'history-job-date', 'Intervento del ' + dateLabel(group.date) + (group.time ? ' · ' + group.time : '')),
        element('small', 'history-job-vehicle', group.vehicle || 'Veicolo non indicato')
      );
      const total = element('div', 'history-job-total', money(group.total));
      total.setAttribute('aria-label', 'Totale intervento ' + money(group.total));
      heading.append(headingText, total);
      const lineList = element('div', 'history-job-lines');
      group.lines.forEach(line => {
        const lineRow = element('div', 'history-job-line');
        if (query && normalize(line.description).includes(query)) lineRow.classList.add('matches-query');
        lineRow.append(element('span', 'history-job-description', line.description), element('span', 'history-job-amount', money(line.amount)));
        lineList.append(lineRow);
      });
      card.append(heading, element('p', 'history-job-count', group.lines.length === 1 ? '1 lavorazione' : group.lines.length + ' lavorazioni'), lineList);
      if (group.notes) card.append(element('p', 'history-job-notes', 'Note: ' + group.notes));
      content.append(card);
    }
  }
  search.addEventListener('input', render);

  window.openCustomerHistory = function openGroupedCustomerHistory(name, vehicle, plate) {
    const vehicles = [...document.querySelectorAll('#customerRows tr')]
      .filter(row => normalize(row.cells[0]?.textContent.trim()) === normalize(name.trim()))
      .map(row => (row.cells[3]?.textContent.trim() || 'Veicolo') + ' · ' + (row.cells[4]?.textContent.trim() || '—'));
    title.textContent = 'Storico — ' + name;
    vehicleSummary.textContent = 'Veicoli associati: ' + (vehicles.length ? vehicles.join(' · ') : vehicle + ' · ' + plate);
    groups = collectGroups(name, vehicle, plate);
    search.value = '';
    render();
    const actions = modal.querySelector('.modal-actions');
    let addVehicle = actions.querySelector('.add-vehicle');
    if (!addVehicle) {
      addVehicle = element('button', 'btn secondary add-vehicle', '+ Aggiungi veicolo');
      addVehicle.type = 'button';
      actions.prepend(addVehicle);
    }
    addVehicle.onclick = () => openAdditionalVehicle(name);
    openModal('historyModal');
  };
})();
