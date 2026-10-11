(() => {
 'use strict';
 const cloud=window.WorkshopCloud;
 if(cloud.failed)return;
 const logo=document.getElementById('shopLogoInput');if(logo){logo.accept='image/png,image/jpeg,image/webp';logo.addEventListener('change',event=>{const file=logo.files[0];if(file&&(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>2*1024*1024)){event.stopImmediatePropagation();logo.value='';alert('Usa un logo PNG, JPG o WEBP fino a 2 MB.');}},true);}
 const now=new Date(),today=[now.getFullYear(),String(now.getMonth()+1).padStart(2,'0'),String(now.getDate()).padStart(2,'0')].join('-');
 for(const id of ['appDate','ledgerDatePicker','workDate','agendaDatePicker','salesDate','parkEntry','recallDate']){const field=document.getElementById(id);if(field)field.value=today;}
 const dateLabel=now.toLocaleDateString('it-IT',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
 for(const selector of ['header.greeting small','#agenda .page-head p']){const el=document.querySelector(selector);if(el)el.textContent=dateLabel;}
 // Account roles are supplied by the authenticated server session.
 const personal=document.getElementById('personalAccessForm');if(personal)personal.addEventListener('submit',event=>{event.preventDefault();event.stopImmediatePropagation();alert('Gli account e i ruoli sono gestiti sul server dall’amministratore.');},true);
 const style=document.createElement('style');style.textContent='html[data-cloud-mode="read"] button:not(.nav button):not([data-view]){cursor:default} html{scroll-padding-top:10px} @media(max-width:700px){body{min-width:0!important}.layout{min-width:0!important}.sidebar{min-width:64px!important}main{min-width:0!important}.page-table{min-width:600px}.table-wrap,.card:has(>.page-table){overflow-x:auto}.modal-card{max-width:calc(100vw - 20px)!important;max-height:90dvh;overflow:auto}.form-grid{grid-template-columns:1fr!important}}';document.head.append(style);
 for(const name of ['makeCustomerNamesClickable','bindStockEditors','updateCustomerSuggestions','renderAgendaDay','syncDashboardToday','syncAllCustomerInterventions','syncParkingCustomers','renderStockPageTotal','renderCriticalStock','renderLiveTyreSummary','renderSelectedLedger','renderDataAnalysis','syncAllFinalTotals','renderRevisionAgenda','renderTyreSalesDay','filterStock']){try{window[name]?.();}catch(error){parent.WorkshopCloudHost.failed(window,name+': '+error.message);return;}}
 // DOM observers observe only business roots. Visual redraws settle before the
 // baseline is taken, then persisted changes are collected in one transaction.
 const observer=new MutationObserver(()=>cloud.observedChange?cloud.observedChange():cloud.changed());for(const selector of WorkshopCloudSchema.selectors){const root=document.querySelector(selector);if(root)observer.observe(root,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['data-date','data-plate','data-km','data-vehicle','data-revision-category','data-removed-vehicles','data-cash-destination','data-cash-account-id','data-work-lines','data-acceptance-lines','data-acceptance-edited','data-quantity','data-minimum','data-reorder-enabled','data-unit-profit','data-work-notes','data-completed-date','data-removed-from-parking','data-agenda-tyre-deductions','data-parking-tyre-deductions','data-agenda-consumable-deductions','data-parking-consumable-deductions','data-dio-history','data-dio-completed-date','data-dio-completed-at']});}
 const desired=document.querySelector('.nav button[data-view="'+CSS.escape(cloud.boot.view||'dashboard')+'"]');desired?.click();
 setTimeout(()=>{if(!cloud.failed)cloud.finish();},900);
})();

/* Riepilogo incassi dai dati condivisi. */
(() => {
  'use strict';

  const modal = document.getElementById('revenueModal');
  const period = document.getElementById('incomePeriod');
  const compare = document.getElementById('comparePeriod');
  const compareSelector = document.getElementById('compareSelector');
  const customDates = document.getElementById('compareCustomDates');
  const compareStart = document.getElementById('compareStart');
  const compareEnd = document.getElementById('compareEnd');
  const compareResult = document.getElementById('compareResult');
  const totalElement = document.getElementById('incomeTotal');
  const rowsElement = document.getElementById('incomeRows');
  const chart = document.getElementById('incomeChart');
  const revenueCard = document.querySelector('.revenue');
  if (!modal || !period || !revenueCard) return;
  revenueCard.querySelector('.cardhead h2').textContent = 'Valore lavori del mese';
  revenueCard.title = 'Apri il riepilogo del valore dei lavori';
  modal.querySelector('.cardhead h2').textContent = 'Valore lavori registrati';
  modal.querySelector('.cardhead p').textContent = 'Comprende i lavori completati e lo storico importato. Per lo storico non è noto se il cliente ha pagato.';
  const chartHeading = modal.querySelector('.income-chart-wrap h3');
  if (chartHeading) chartHeading.textContent = 'Andamento del valore dei lavori';
  document.getElementById('incomeChart')?.setAttribute('aria-label', 'Grafico del valore dei lavori');

  const departments = [
    ['meccanica', 'Interventi meccanica', '#3d9484'],
    ['pneumatici', 'Pneumatici e servizi', '#5ed4e4'],
    ['tagliandi', 'Tagliandi', '#7d9ce3'],
    ['revisioni', 'Revisioni', '#ffad77'],
    ['carRent', 'Car Rent', '#a68ada']
  ];
  // The inherited HTML legend still separates tyres from their services.
  // Derive its labels and colours from the same sectors as the real report.
  const legend = modal.querySelector('.income-legend') || document.createElement('div');
  legend.className = 'income-legend';
  if (!legend.parentElement) chartHeading?.after(legend);
  legend.replaceChildren(...departments.map(([key, label, color]) => {
    const entry = document.createElement('span'), swatch = document.createElement('i');
    swatch.dataset.department = key; swatch.style.background = color; swatch.setAttribute('aria-hidden', 'true');
    entry.append(swatch, document.createTextNode(label));
    return entry;
  }));
  const currency = new Intl.NumberFormat('it-IT', {style:'currency', currency:'EUR'});
  const shortCurrency = new Intl.NumberFormat('it-IT', {style:'currency', currency:'EUR', maximumFractionDigits:0});
  const iso = date => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
  const today = () => iso(new Date());
  const shiftDays = (value, days) => {
    const date = new Date(value + 'T12:00:00');
    date.setDate(date.getDate() + days);
    return iso(date);
  };
  const normalizeDate = value => {
    const raw = String(value || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    const italian = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    return italian ? italian[3] + '-' + italian[2].padStart(2, '0') + '-' + italian[1].padStart(2, '0') : '';
  };
  const amount = value => {
    if (typeof value === 'number') return Number.isFinite(value) ? Math.max(0, value) : 0;
    const raw = String(value || '').replace(/[^\d,.-]/g, '');
    if (!raw) return 0;
    const normalized = raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : /\.\d{1,2}$/.test(raw) ? raw : raw.replace(/\./g, '');
    return Math.max(0, Number(normalized) || 0);
  };
  const readLines = (row, key) => {
    try {
      const lines = JSON.parse(row.dataset[key] || '[]');
      return Array.isArray(lines) ? lines.filter(line => String(line?.description || '').trim()) : [];
    } catch (_) { return []; }
  };
  const classify = description => {
    const key = window.classifyIncomeDepartment?.(description);
    return departments.some(item => item[0] === key) ? key : 'meccanica';
  };
  const entries = () => {
    const result = [];
    document.querySelectorAll('#agendaRows tr:not(.agenda-empty)').forEach(row => {
      if (row.querySelector('.status-select')?.value !== 'COMPLETATO') return;
      const date = normalizeDate(row.dataset.date);
      if (!date) return;
      const lines = readLines(row, 'acceptanceLines');
      const fallback = [{description:row.cells[3]?.querySelector('.work-input')?.value || row.cells[3]?.textContent || '', amount:row.cells[4]?.querySelector('.amount-input')?.value || row.cells[4]?.textContent || ''}];
      for (const line of lines.length ? lines : fallback) result.push({date, department:classify(line.description), value:amount(line.amount), plate:row.cells[2]?.textContent.trim() || '', work:line.description});
    });
    document.querySelectorAll('#agenda .parking-section .parking-row').forEach(row => {
      if (row.querySelector('.parking-status')?.value !== 'COMPLETATO') return;
      const date = normalizeDate(row.dataset.completedDate || row.dataset.exit || row.dataset.entry);
      if (!date) return;
      const lines = readLines(row, 'workLines');
      const fallback = [{description:row.children[3]?.querySelector('b')?.textContent || '', amount:row.querySelector('.parking-total strong')?.textContent || ''}];
      const vehicle=window.parkingDataFromRow?.(row) || {};
      for (const line of lines.length ? lines : fallback) result.push({date, department:classify(line.description), value:amount(line.amount), plate:vehicle.plate || '', work:line.description});
    });
    for (const entry of window.WorkshopLedgerCash?.snapshot().entries || []) {
      if (entry.sourceRow) continue;
      const date = normalizeDate(entry.date);
      if (!date) continue;
      const lines = Array.isArray(entry.lines) && entry.lines.length
        ? entry.lines : [{description:entry.work, amount:entry.amount}];
      const plate = String(entry.vehicle || '').split(' · ')[0].trim();
      for (const line of lines) result.push({date, department:classify(line.description), value:amount(line.amount), plate, work:line.description});
    }
    for(const item of window.WorkshopImportedHistory?.facts(result.map(entry=>({plate:entry.plate,date:entry.date,work:entry.work,amount:entry.value}))) || []){
      result.push({date:item.date,department:classify(item.work),value:item.amount,plate:item.plate,work:item.work,imported:true});
    }
    return result;
  };
  const rangeFor = (name, reference = today()) => {
    const date = new Date(reference + 'T12:00:00');
    if (name === 'day') return {start:reference, end:shiftDays(reference, 1)};
    if (name === 'week') {
      const monday = shiftDays(reference, -((date.getDay() + 6) % 7));
      return {start:monday, end:shiftDays(monday, 7)};
    }
    if (name === 'year') return {start:date.getFullYear() + '-01-01', end:(date.getFullYear() + 1) + '-01-01'};
    return {start:iso(new Date(date.getFullYear(), date.getMonth(), 1)), end:iso(new Date(date.getFullYear(), date.getMonth() + 1, 1))};
  };
  const report = range => {
    const values = Object.fromEntries(departments.map(([key]) => [key, 0]));
    const filtered = entries().filter(item => item.date >= range.start && item.date < range.end);
    for (const item of filtered) values[item.department] += item.value;
    return {range, values, items:filtered, total:Object.values(values).reduce((sum, value) => sum + value, 0)};
  };
  const comparisonRange = () => {
    const selected = compareSelector.value, reference = today();
    if (selected === 'custom') {
      const start = normalizeDate(compareStart.value), end = normalizeDate(compareEnd.value);
      return start && end && start <= end ? {start, end:shiftDays(end, 1)} : null;
    }
    if (/^\d{4}$/.test(selected)) return {start:selected + '-01-01', end:(Number(selected) + 1) + '-01-01'};
    if (selected === 'yesterday') return rangeFor('day', shiftDays(reference, -1));
    if (selected === 'lastWeek') return rangeFor('week', shiftDays(reference, -7));
    if (selected === 'lastMonth') return rangeFor('month', iso(new Date(new Date(reference + 'T12:00:00').getFullYear(), new Date(reference + 'T12:00:00').getMonth() - 1, 15)));
    if (selected === 'lastYear') return rangeFor('year', iso(new Date(new Date(reference + 'T12:00:00').getFullYear() - 1, 0, 15)));
    if (period.value === 'day') return rangeFor('day', shiftDays(reference, -1));
    if (period.value === 'week') return rangeFor('week', shiftDays(reference, -7));
    if (period.value === 'year') return rangeFor('year', iso(new Date(new Date(reference + 'T12:00:00').getFullYear() - 1, 0, 15)));
    return rangeFor('month', iso(new Date(new Date(reference + 'T12:00:00').getFullYear(), new Date(reference + 'T12:00:00').getMonth() - 1, 15)));
  };
  const chartBuckets = (name, range) => {
    if (name === 'day') return [{label:'Oggi', start:range.start, end:range.end}];
    if (name === 'week') return Array.from({length:7}, (_, index) => {
      const start = shiftDays(range.start, index);
      return {label:new Intl.DateTimeFormat('it-IT', {weekday:'short'}).format(new Date(start + 'T12:00:00')), start, end:shiftDays(start, 1)};
    });
    if (name === 'year') return Array.from({length:12}, (_, index) => {
      const year = Number(range.start.slice(0, 4));
      const start = iso(new Date(year, index, 1));
      return {label:new Intl.DateTimeFormat('it-IT', {month:'short'}).format(new Date(start + 'T12:00:00')), start, end:iso(new Date(year, index + 1, 1))};
    });
    return Array.from({length:5}, (_, index) => {
      const start = shiftDays(range.start, index * 7);
      const end = shiftDays(start, 7) < range.end ? shiftDays(start, 7) : range.end;
      return {label:String(index * 7 + 1) + '–' + String(Math.min(index * 7 + 7, Number(shiftDays(range.end, -1).slice(-2)))), start, end};
    }).filter(bucket => bucket.start < range.end);
  };
  const renderChart = (name, data) => {
    const buckets = chartBuckets(name, data.range).map(bucket => {
      const values = Object.fromEntries(departments.map(([key]) => [key, 0]));
      for (const item of data.items) if (item.date >= bucket.start && item.date < bucket.end) values[item.department] += item.value;
      return {...bucket, values, total:Object.values(values).reduce((sum, value) => sum + value, 0)};
    });
    const max = Math.max(1, ...buckets.map(bucket => bucket.total));
    const step = 384 / buckets.length, width = Math.min(42, Math.max(12, step - 8));
    const parts = ['<title>Andamento degli importi nel periodo</title><desc>Importi registrati per data e reparto.</desc>'];
    parts.push('<line x1="24" y1="125" x2="408" y2="125" stroke="currentColor" opacity=".25"/>');
    buckets.forEach((bucket, index) => {
      const x = 24 + index * step + (step - width) / 2;
      let bottom = 125;
      for (const [key, label, color] of departments) {
        const height = bucket.values[key] / max * 92;
        if (height <= 0) continue;
        bottom -= height;
        parts.push('<rect data-department="' + key + '" data-value="' + bucket.values[key] + '" x="' + x.toFixed(1) + '" y="' + bottom.toFixed(1) + '" width="' + width.toFixed(1) + '" height="' + height.toFixed(1) + '" rx="2" fill="' + color + '"><title>' + bucket.label + ' · ' + label + ': ' + currency.format(bucket.values[key]) + '</title></rect>');
      }
      parts.push('<text x="' + (x + width / 2).toFixed(1) + '" y="145" text-anchor="middle">' + bucket.label + '</text>');
    });
    chart.innerHTML = parts.join('');
    // The selected theme can recolour SVG fills. Use the displayed segment's
    // colour for its swatch so the legend remains accurate in either theme.
    for (const [key, , color] of departments) {
      const segment = chart.querySelector('[data-department="' + key + '"]');
      legend.querySelector('[data-department="' + key + '"]').style.backgroundColor = segment ? getComputedStyle(segment).fill : color;
    }
  };
  const renderComparison = current => {
    const enabled = compare.checked;
    compareSelector.classList.toggle('show', enabled);
    customDates.classList.toggle('hidden', !enabled || compareSelector.value !== 'custom');
    compareResult.classList.toggle('show', enabled);
    if (!enabled) return;
    const previousRange = comparisonRange();
    if (!previousRange) { compareResult.textContent = 'Seleziona un intervallo di confronto valido.'; return; }
    const previous = report(previousRange).total, difference = current.total - previous;
    const percent = previous ? ' · ' + (difference / previous * 100).toLocaleString('it-IT', {maximumFractionDigits:1}) + '%' : '';
    const label = compareSelector.selectedOptions[0]?.textContent || 'Periodo precedente';
    compareResult.textContent = label + ': ' + currency.format(previous) + ' · Differenza ' + (difference > 0 ? '+' : '') + currency.format(difference) + percent;
  };
  const render = () => {
    const name = ['day', 'week', 'month', 'year'].includes(period.value) ? period.value : 'month';
    const current = report(rangeFor(name));
    totalElement.textContent = currency.format(current.total);
    const rows = departments.filter(([key]) => current.values[key] > 0);
    rowsElement.innerHTML = rows.length ? rows.map(([key, label]) => '<tr><td>' + label + '</td><td>' + currency.format(current.values[key]) + '</td></tr>').join('') : '<tr><td colspan="2">Nessun importo registrato nel periodo.</td></tr>';
    modal.querySelector('.trend').textContent = current.items.length ? current.items.length + (current.items.length === 1 ? ' lavorazione registrata' : ' lavorazioni registrate') : 'Nessun dato registrato';
    renderChart(name, current);
    renderComparison(current);
    return current;
  };
  const refresh = () => {
    const monthly = report(rangeFor('month'));
    revenueCard.querySelector('.amount').textContent = shortCurrency.format(monthly.total);
    revenueCard.querySelector('.cardhead span').textContent = new Intl.DateTimeFormat('it-IT', {month:'short', year:'numeric'}).format(new Date()).toUpperCase();
    revenueCard.querySelector('small').textContent = monthly.items.length ? monthly.items.length + (monthly.items.length === 1 ? ' lavorazione completata' : ' lavorazioni completate') : 'Nessun dato registrato';
    const imported = monthly.items.filter(item => item.imported).length;
    if(imported) revenueCard.querySelector('small').textContent += ' · ' + imported + (imported === 1 ? ' lavoro storico' : ' lavori storici') + ' (pagamento non indicato)';
    if (modal.classList.contains('open')) render();
  };

  const head = modal.querySelector('.cardhead');
  const controls = document.createElement('div');
  controls.className = 'revenue-report-controls';
  const controlRow = document.createElement('div');
  controlRow.className = 'revenue-report-control-row';
  controlRow.append(period, compare.parentElement, compareSelector);
  controls.append(controlRow, customDates, compareResult);
  head.after(controls);
  document.head.insertAdjacentHTML('beforeend', `<style>
    #revenueModal .modal-card{width:min(640px,100%);min-width:0}
    #revenueModal .cardhead{display:block;margin-bottom:12px}
    #revenueModal .cardhead p{margin-bottom:0}
    #revenueModal .revenue-report-controls{display:grid;gap:10px;min-width:0;margin:0 0 16px}
    #revenueModal .revenue-report-control-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;min-width:0}
    #revenueModal #incomePeriod{flex:1 1 155px;min-width:130px;max-width:100%}
    #revenueModal .compare-control{display:inline-flex;align-items:center;gap:6px;flex:0 1 auto;margin:0;white-space:nowrap}
    #revenueModal .compare-picker.show{display:block;flex:1 1 180px;min-width:0;max-width:100%}
    #revenueModal #compareCustomDates{display:flex;flex-wrap:wrap;align-items:center;gap:6px;max-width:100%}
    #revenueModal #compareCustomDates input{min-width:0;max-width:100%;flex:1 1 140px}
    #revenueModal .compare-result{max-width:100%;overflow-wrap:anywhere;margin:0}
    #revenueModal .income-chart-wrap{max-width:100%;overflow:hidden}
    @media(max-width:520px){#revenueModal .revenue-report-control-row>*{flex-basis:100%}#revenueModal #incomePeriod,#revenueModal .compare-picker.show{width:100%}}
  </style>`);

  window.WorkshopRevenue = {refresh, render, reportFor:name => report(rangeFor(name))};
  window.renderIncome = render;
  period.addEventListener('change', render);
  compare.addEventListener('change', render);
  compareSelector.addEventListener('change', render);
  compareStart.addEventListener('change', render);
  compareEnd.addEventListener('change', render);
  revenueCard.addEventListener('click', render);
  revenueCard.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') render(); });
  refresh();
})();
