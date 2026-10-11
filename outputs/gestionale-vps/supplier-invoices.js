/* Payables are server records, separate from the legacy customer-invoice archive. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const section = $('supplierInvoices');
  if (!section || window.parent === window) return;

  const role = window.parent.WorkshopCloudBoot?.user?.role || 'viewer';
  const canWrite = () => role !== 'viewer' && window.parent.WorkshopCloudHost?.canWrite?.();
  const money = value => new Intl.NumberFormat('it-IT', {style:'currency', currency:'EUR'}).format((Number(value) || 0) / 100);
  const today = () => {
    const date = new Date();
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
  };
  const dateText = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value.slice(8,10) + '/' + value.slice(5,7) + '/' + value.slice(0,4) : '—';
  const dateTimeText = value => {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('it-IT', {dateStyle:'short', timeStyle:'short'});
  };
  const inputMoney = value => ((Number(value) || 0) / 100).toFixed(2).replace('.', ',');
  function parseCents(value) {
    let raw = String(value || '').trim().replace(/[\s\u00a0]/g, '');
    if (raw.includes(',')) raw = raw.replace(/\./g, '').replace(',', '.');
    if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) throw Error('Inserisci un importo valido, con al massimo due decimali.');
    const [whole, cents = ''] = raw.split('.');
    const result = Number(whole) * 100 + Number(cents.padEnd(2, '0'));
    if (!Number.isSafeInteger(result) || result < 1) throw Error('L’importo deve essere maggiore di zero.');
    return result;
  }
  const node = (tag, className, content) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (content !== undefined) element.textContent = String(content);
    return element;
  };
  const val = (item, key) => item?.[key] == null ? '' : String(item[key]);
  const active = () => !window.parent.document.getElementById('workspace')?.hidden && (getComputedStyle(section).display !== 'none' || (document.getElementById('analysis') && getComputedStyle(document.getElementById('analysis')).display !== 'none'));
  const isPending = item => item.verified === false;
  const isCreditNote = item => ['TD04', 'TD08'].includes(String(item?.documentType || '').toUpperCase());
  const itemMoney = value => value == null ? 'Da verificare' : money(value);
  const isOpen = item => !isPending(item) && Number(item.outstandingCents) > 0;
  const isOverdue = item => isOpen(item) && item.status === 'overdue';
  const statusInfo = item => isPending(item) ? ['Da verificare', 'review'] : !isOpen(item) ? ['Saldata', 'paid'] : isOverdue(item) ? ['Scaduta', 'overdue'] : Number(item.paidCents) > 0 ? ['Parziale', 'partial'] : ['Da saldare', 'open'];

  let csrf = '', items = [], summary = {}, currentId = null, currentDetail = null;
  let expensesLoaded = false, expensesError = '';
  let loading = false, queued = false, noticeTimer = null;
  let knownRevision = -1, wantedRevision = -1, remoteData = null, remoteTimer = null, remoteFailures = 0, writing = 0;
  let formMode = 'create', editingId = null, editingVersion = null, formMutationId = null, paymentMutationId = null;

  function notice(message, sticky = false) {
    clearTimeout(noticeTimer);
    $('supplierInvoiceNotice').hidden = !message;
    $('supplierInvoiceNotice').textContent = message || '';
    if (message && !sticky) noticeTimer = setTimeout(() => notice(''), 8000);
  }
  async function api(path = '', method = 'GET', data) {
    const response = await fetch('/api/supplier-invoices' + path, {
      method, credentials:'same-origin', cache:'no-store',
      headers:{...(data ? {'Content-Type':'application/json'} : {}), ...(method !== 'GET' ? {'X-CSRF-Token':csrf} : {})},
      body:data ? JSON.stringify(data) : undefined,
      signal:AbortSignal.timeout(12000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = result.error;
      const error = new Error(detail?.message || (typeof detail === 'string' ? detail : 'Operazione non riuscita.'));
      error.status = response.status;
      error.code = detail?.code;
      throw error;
    }
    return result;
  }
  function renderSummary() {
    $('supplierToPay').textContent = money(summary.toPayCents);
    $('supplierOverdue').textContent = money(summary.overdueCents);
    $('supplierDueSoon').textContent = money(summary.dueSoonCents);
    $('supplierOpenCount').textContent = String(Number(summary.countOpen) || 0);
    $('supplierPendingReviewCount').textContent = String(Number(summary.pendingReviewCount) || 0);
  }

  // Expenses share the income date filter, but remain separate from workshop revenue/profit.
  const incomeFilter = $('analysisIncomePeriod');
  if (incomeFilter && $('cashExpensesTotal')) {
    const card = node('section', 'card analysis-card supplier-expenses');
    card.id = 'analysisExpenses';
    card.setAttribute('aria-labelledby', 'analysisExpensesTitle');
    card.innerHTML = `<div class="analysis-card-head"><div><h2 id="analysisExpensesTitle">Spese fornitori</h2><p>Totali IVA inclusa, in base alla data della fattura. Segue il filtro “Periodo incassi”.</p></div><button type="button" class="btn secondary" id="analysisOpenSuppliers" data-view="supplierInvoices">Apri fatture fornitori</button></div>
      <p id="analysisExpensesPeriod" class="analysis-summary"></p>
      <p id="analysisExpensesError" class="cash-error" role="status" hidden></p>
      <div class="analysis-kpis" aria-live="polite"><div class="analysis-kpi"><span>Totale spese</span><strong id="analysisExpensesTotal">—</strong><small id="analysisExpensesCount"></small></div><div class="analysis-kpi"><span>Già pagato</span><strong id="analysisExpensesPaid">—</strong><small>Pagamenti sulle fatture del periodo</small></div><div class="analysis-kpi"><span>Da pagare</span><strong id="analysisExpensesOutstanding">—</strong><small>Residuo delle stesse fatture</small></div></div>
      <p id="analysisExpensesNote" class="cash-help"></p>
      <details class="cash-history"><summary>Dettaglio fatture <span id="analysisExpensesDetailCount"></span></summary><div class="cash-table-wrap"><table class="page-table cash-table"><thead><tr><th>Fornitore</th><th>Fattura</th><th>Data fattura</th><th>Totale</th><th>Già pagato</th><th>Da pagare</th></tr></thead><tbody id="analysisExpensesRows"></tbody></table></div></details>`;
    incomeFilter.closest('.analysis-card').after(card);
    $('analysisOpenSuppliers').addEventListener('click', () => document.querySelector('.nav [data-view="supplierInvoices"]')?.click());
    for (const id of ['analysisIncomePeriod', 'analysisIncomeStart', 'analysisIncomeEnd']) $(id)?.addEventListener('change', renderExpenses);
  }

  function expensePeriod() {
    const mode = incomeFilter?.value || 'all', current = today();
    let start = '', end = '', valid = true;
    let label = incomeFilter?.selectedOptions[0]?.textContent || 'Di sempre';
    if (mode === 'year') { start = current.slice(0, 4) + '-01-01'; end = current.slice(0, 4) + '-12-31'; }
    if (mode === 'fiveYears') {
      const date = new Date(current + 'T12:00:00');
      date.setFullYear(date.getFullYear() - 5);
      start = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
      end = current;
    }
    if (mode === 'custom') {
      start = $('analysisIncomeStart').value; end = $('analysisIncomeEnd').value;
      valid = /^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end) && start <= end;
      label = valid ? dateText(start) + ' – ' + dateText(end) : 'Seleziona un intervallo valido';
    }
    return {start, end, valid, label};
  }
  function renderExpenses() {
    if (!$('analysisExpenses')) return;
    const period = expensePeriod();
    const inPeriod = item => period.valid && (!period.start || item.issueDate >= period.start) && (!period.end || item.issueDate <= period.end);
    const invoices = items.filter(item => inPeriod(item) && !isPending(item) && !isCreditNote(item) && Number.isSafeInteger(item.totalCents));
    const excluded = items.filter(item => inPeriod(item) && (isPending(item) || isCreditNote(item)));
    const totals = invoices.reduce((sum, item) => {
      sum.total += item.totalCents; sum.paid += Number(item.paidCents) || 0; sum.outstanding += Number(item.outstandingCents) || 0;
      return sum;
    }, {total:0, paid:0, outstanding:0});
    const valid = expensesLoaded && period.valid;
    for (const prefix of ['cashExpenses', 'analysisExpenses']) {
      $(prefix + 'Total').textContent = valid ? money(totals.total) : '—';
      $(prefix + 'Paid').textContent = (prefix === 'cashExpenses' ? 'Già pagato: ' : '') + (valid ? money(totals.paid) : '—');
      $(prefix + 'Outstanding').textContent = (prefix === 'cashExpenses' ? 'Da pagare: ' : '') + (valid ? money(totals.outstanding) : '—');
      $(prefix + 'Period').textContent = (prefix === 'cashExpenses' ? 'Fatture · ' : 'Periodo spese: ') + period.label;
    }
    $('analysisExpensesError').hidden = !expensesError;
    $('analysisExpensesError').textContent = expensesError;
    $('analysisExpensesCount').textContent = valid ? invoices.length + (invoices.length === 1 ? ' fattura confermata' : ' fatture confermate') : '';
    $('analysisExpensesNote').textContent = excluded.length ? excluded.length + (excluded.length === 1 ? ' documento da verificare o nota di credito escluso dai totali.' : ' documenti da verificare o note di credito esclusi dai totali.') : 'Le fatture da verificare e le note di credito sono escluse dai totali.';
    $('analysisExpensesDetailCount').textContent = valid ? '(' + invoices.length + ')' : '';
    const rows = $('analysisExpensesRows');
    rows.replaceChildren();
    for (const item of [...invoices].sort((a,b) => b.issueDate.localeCompare(a.issueDate) || a.supplierName.localeCompare(b.supplierName))) {
      const row = node('tr');
      for (const value of [item.supplierName, item.number, dateText(item.issueDate), money(item.totalCents), money(item.paidCents), money(item.outstandingCents)]) row.append(node('td', '', value));
      rows.append(row);
    }
    if (!invoices.length) {
      const row = node('tr'), cell = node('td', 'no-results', !period.valid ? 'Seleziona un intervallo personalizzato valido.' : !expensesLoaded ? 'Dati fatture non ancora disponibili.' : 'Nessuna fattura confermata nel periodo.');
      cell.colSpan = 6; row.append(cell); rows.append(row);
    }
    window.dispatchEvent(new CustomEvent('supplier-invoices:cash-cycle', {detail:{
      loaded:expensesLoaded,
      averagePaymentDays:Number.isFinite(summary.averagePaymentDays)?summary.averagePaymentDays:null,
      paymentCount:Number(summary.paymentCount)||0,
      error:expensesError
    }}));
  }
  renderExpenses();
  function renderSync(sync) {
    const label = $('supplierSyncStatus');
    label.classList.remove('success', 'warn');
    if (!sync) {
      label.textContent = 'Ricezione automatica da PEC non ancora configurata. Le fatture inserite manualmente sono separate da quelle emesse ai clienti.';
      return;
    }
    const issueCount = Array.isArray(sync.issues) ? sync.issues.length : Number(sync.issues) || 0;
    if (sync.errorCode || issueCount > 0) {
      label.classList.add('warn');
      label.textContent = [
        issueCount ? `La ricezione PEC ha segnalato ${issueCount} anomalie da controllare nei log del VPS.` : '',
        sync.errorCode ? `Ultimo tentativo PEC: errore ${sync.errorCode} (${dateTimeText(sync.lastRunAt)}).` : '',
        'Alcune fatture potrebbero non essere presenti.'
      ].filter(Boolean).join(' ');
    } else if (sync.lastSuccessAt) {
      label.classList.add('success');
      label.textContent = 'Ricezione PEC configurata. Ultima lettura riuscita: ' + dateTimeText(sync.lastSuccessAt) + '. Le fatture importate devono essere verificate prima di entrare nel totale da pagare.';
    } else {
      label.textContent = 'Ricezione PEC configurata; prima lettura non ancora completata. Le fatture inserite manualmente sono separate da quelle emesse ai clienti.';
    }
  }
  function cell(label, text, className) {
    const wrap = node('span', className || '');
    wrap.append(node('small', 'supplier-cell-label', label), node('span', 'supplier-cell-value', text));
    return wrap;
  }
  function renderList() {
    const container = $('supplierInvoiceList');
    container.replaceChildren();
    const query = $('supplierInvoiceSearch').value.trim().toLocaleLowerCase('it-IT');
    const filter = $('supplierInvoiceFilter').value;
    const matches = items.filter(item => {
      const text = [item.supplierName, item.supplierTaxId, item.number].join(' ').toLocaleLowerCase('it-IT');
      if (query && !text.includes(query)) return false;
      if (filter === 'review') return isPending(item);
      if (filter === 'open') return isOpen(item);
      if (filter === 'overdue') return isOverdue(item);
      if (filter === 'paid') return !isPending(item) && Number(item.outstandingCents) === 0;
      return true;
    });
    if (!matches.length) {
      container.append(node('p', 'supplier-empty', items.length ? 'Nessuna fattura corrisponde ai filtri.' : 'Nessuna fattura fornitore registrata.'));
      return;
    }
    for (const item of matches) {
      const button = node('button', 'supplier-list-row');
      button.type = 'button';
      button.dataset.view = 'supplier-detail'; // Remains navigable for read-only accounts.
      button.dataset.supplierId = String(item.id);
      button.setAttribute('aria-label', `${item.supplierName}, fattura ${item.number}, residuo ${itemMoney(item.outstandingCents)}. Apri dettagli.`);
      const who = node('span', 'supplier-cell-supplier');
      who.append(node('strong', '', item.supplierName || 'Fornitore'), node('small', '', 'Fattura ' + (item.number || '—') + ' · ' + dateText(item.issueDate)));
      const due = cell('Scadenza', dateText(item.dueDate), 'supplier-cell-due');
      const total = cell('Totale', itemMoney(item.totalCents), 'supplier-cell-total');
      const outstanding = cell('Da pagare', itemMoney(item.outstandingCents), 'supplier-cell-outstanding');
      outstanding.querySelector('.supplier-cell-value').classList.add('outstanding');
      const [label, kind] = statusInfo(item);
      button.append(who, due, total, outstanding, node('span', 'supplier-badge ' + kind, label));
      container.append(button);
    }
  }
  function definition(grid, label, value) {
    const box = node('div');
    box.append(node('dt', '', label), node('dd', '', value || '—'));
    grid.append(box);
  }
  function invoicePreview(xml) {
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw Error('Il file XML contiene dichiarazioni non ammesse.');
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length || doc.documentElement?.localName !== 'FatturaElettronica') {
      throw Error('L’XML originale non è una fattura elettronica leggibile.');
    }
    const child = (parent, name) => Array.from(parent?.children || []).find(element => element.localName === name);
    const children = (parent, name) => Array.from(parent?.children || []).filter(element => element.localName === name);
    const value = (parent, ...names) => names.reduce(child, parent)?.textContent?.trim() || '';
    const bodies = Array.from(doc.getElementsByTagNameNS('*', 'FatturaElettronicaBody'));
    if (!bodies.length) throw Error('Nessun corpo fattura presente nell’XML.');
    const panel = node('div', 'supplier-xml-preview');
    panel.append(node('h4', '', 'Contenuto della fattura originale'));
    let count = 0;
    for (const body of bodies) {
      const general = child(child(body, 'DatiGenerali'), 'DatiGeneraliDocumento');
      const head = node('p', 'supplier-xml-head',
        ['Documento ' + (value(general, 'Numero') || '—'), value(general, 'Data'),
          value(general, 'Divisa'), value(general, 'ImportoTotaleDocumento')].filter(Boolean).join(' · '));
      panel.append(head);
      const lines = children(child(body, 'DatiBeniServizi'), 'DettaglioLinee');
      for (const line of lines) {
        if (count >= 500) break;
        const row = node('div', 'supplier-xml-line');
        row.append(node('strong', '', value(line, 'Descrizione') || 'Voce senza descrizione'));
        const details = [value(line, 'Quantita') && 'Quantità: ' + value(line, 'Quantita'),
          value(line, 'PrezzoUnitario') && 'Prezzo unitario: ' + value(line, 'PrezzoUnitario'),
          value(line, 'PrezzoTotale') && 'Totale riga: ' + value(line, 'PrezzoTotale')];
        row.append(node('small', '', details.filter(Boolean).join(' · ')));
        panel.append(row);
        count++;
      }
      if (count >= 500) break;
    }
    if (!count) panel.append(node('p', '', 'Nessuna riga di dettaglio presente nell’XML.'));
    if (count >= 500) panel.append(node('p', '', 'Sono mostrate le prime 500 righe. Scarica l’XML per il documento completo.'));
    panel.append(node('p', 'supplier-xml-caveat', 'Anteprima dei dati XML; verifica sempre l’originale e non usare questa vista come documento fiscale.'));
    return panel;
  }
  function renderDetail(item) {
    const previousPreview = currentDetail?.id === item.id && item.hasOriginal ? $('supplierInvoiceDetail').querySelector('.supplier-xml-preview') : null;
    const focused = $('supplierInvoiceDetail').contains(document.activeElement) ? document.activeElement : null;
    const focusedView = focused?.dataset.view, focusedText = focused?.textContent;
    currentDetail = item;
    const panel = $('supplierInvoiceDetail');
    panel.replaceChildren();
    const header = node('div', 'supplier-detail-head');
    const name = node('div');
    name.append(node('h3', '', item.supplierName || 'Fornitore'), node('p', '', 'Fattura ' + (item.number || '—') + ' · ' + (String(item.source || '').toLowerCase() === 'pec' ? 'Ricevuta via PEC' : item.source === 'sdi' ? 'Ricevuta dallo SdI' : 'Inserita manualmente')));
    const close = node('button', 'btn secondary', 'Chiudi dettagli');
    close.type = 'button'; close.dataset.view = 'supplier-close-detail'; close.addEventListener('click', closeDetail);
    header.append(name, close);
    panel.append(header);
    if (isPending(item)) panel.append(node('p', 'supplier-reception-note', isCreditNote(item) ? 'Questo documento è una nota di credito. Non viene trattato come una fattura da pagare; consulta l’XML originale e verifica come registrarlo.' : 'Da verificare: controlla importo e scadenza rispetto alla fattura originale prima di confermare. Questa fattura non è ancora inclusa nel totale da pagare.'));
    const grid = node('dl', 'supplier-detail-grid');
    definition(grid, 'Partita IVA / C.F.', item.supplierTaxId);
    if (item.documentType) definition(grid, 'Tipo documento', item.documentType);
    definition(grid, 'Data fattura', dateText(item.issueDate));
    definition(grid, 'Scadenza', dateText(item.dueDate));
    definition(grid, 'Importo totale', itemMoney(item.totalCents));
    definition(grid, 'Pagato', itemMoney(item.paidCents));
    definition(grid, 'Residuo', itemMoney(item.outstandingCents));
    panel.append(grid);
    if (item.notes) panel.append(node('p', 'supplier-detail-note', item.notes));
    const actions = node('div', 'supplier-detail-actions');
    if (item.hasOriginal) {
      const preview = node('button', 'btn secondary', 'Visualizza fattura');
      preview.type = 'button';
      preview.dataset.view = 'supplier-preview'; // Viewing is allowed for read-only users.
      preview.addEventListener('click', async () => {
        preview.disabled = true;
        try {
          const response = await fetch('/api/supplier-invoices/' + encodeURIComponent(item.id) + '/original',
            {credentials:'same-origin', cache:'no-store', signal:AbortSignal.timeout(12000)});
          if (!response.ok) throw Error('Originale non disponibile.');
          const xml = await response.text();
          if (currentId !== item.id || !actions.isConnected) return;
          const original = panel.querySelector('.supplier-xml-preview');
          const rendered = invoicePreview(xml);
          if (original) original.replaceWith(rendered); else actions.insertAdjacentElement('afterend', rendered);
        } catch (error) { notice('Anteprima non disponibile: ' + error.message, true); }
        finally { preview.disabled = false; }
      });
      actions.append(preview);
      const xml = node('a', 'btn secondary', 'Scarica XML originale');
      xml.href = '/api/supplier-invoices/' + encodeURIComponent(item.id) + '/original';
      xml.download = 'fattura-fornitore.xml';
      actions.append(xml);
    }
    if (role !== 'viewer') {
      const edit = node('button', 'btn secondary', isPending(item) ? 'Verifica / modifica' : 'Modifica dati');
      edit.type = 'button'; edit.addEventListener('click', () => openInvoiceForm(item));
      actions.append(edit);
      if (isOpen(item)) {
        const pay = node('button', 'btn', 'Registra pagamento');
        pay.type = 'button'; pay.addEventListener('click', () => openPaymentForm(item));
        actions.append(pay);
      }
    }
    panel.append(actions);
    if (previousPreview) panel.append(previousPreview);
    panel.append(node('h4', '', 'Pagamenti registrati'));
    const payments = node('ul', 'supplier-payment-list');
    if (!Array.isArray(item.payments) || !item.payments.length) payments.append(node('li', '', 'Nessun pagamento registrato.'));
    else for (const payment of item.payments) {
      const row = node('li');
      const left = node('div');
      left.append(node('span', '', dateText(payment.paidAt) + ' · ' + (payment.method || 'Pagamento')));
      if (payment.reference) left.append(node('small', '', payment.reference));
      row.append(left, node('strong', '', money(payment.amountCents)));
      payments.append(row);
    }
    panel.append(payments);
    panel.hidden = false;
    if (focused && !focused.isConnected) {
      const target = [...panel.querySelectorAll('button,a')].find(element => focusedView ? element.dataset.view === focusedView : element.textContent === focusedText);
      target?.focus({preventScroll:true});
    }
  }
  function closeDetail() {
    currentId = null; currentDetail = null;
    $('supplierInvoiceDetail').hidden = true;
    $('supplierInvoiceDetail').replaceChildren();
  }
  async function openDetail(id) {
    currentId = String(id);
    $('supplierInvoiceDetail').hidden = false;
    $('supplierInvoiceDetail').textContent = 'Caricamento dettagli…';
    try {
      const response = await api('/' + encodeURIComponent(id));
      if (currentId !== String(id)) return;
      renderDetail(response.item || response);
      $('supplierInvoiceDetail').scrollIntoView({block:'nearest', behavior:'smooth'});
    } catch (error) {
      if (currentId === String(id)) { closeDetail(); notice('Dettaglio non disponibile: ' + error.message, true); }
    }
  }
  async function reload() {
    if (loading) { queued = true; return; }
    loading = true;
    try {
      const data = await api();
      present(data); remoteData = null;
      if (currentId) {
        const id = currentId;
        const detail = await api('/' + encodeURIComponent(id));
        if (currentId === id) renderDetail(detail.item || detail);
      }
    } catch (error) {
      expensesError = 'Spese non aggiornate: ' + error.message + (expensesLoaded ? ' Sono mostrati gli ultimi dati disponibili.' : '');
      renderExpenses();
      if (active()) notice('Aggiornamento fatture non riuscito: ' + error.message, true);
    } finally {
      loading = false;
      if (queued) { queued = false; queueMicrotask(reload); }
      else scheduleRemote();
    }
  }
  function present(data) {
    const focused = document.activeElement?.closest('[data-supplier-id]');
    items = Array.isArray(data.items) ? data.items : [];
    summary = data.summary || {};
    knownRevision = Math.max(knownRevision, Number(data.revision) || 0);
    remoteFailures = 0;
    expensesLoaded = true; expensesError = '';
    renderSummary(); renderSync(data.sync); renderList(); renderExpenses();
    if (focused && !focused.isConnected) [...$('supplierInvoiceList').querySelectorAll('[data-supplier-id]')].find(element => element.dataset.supplierId === focused.dataset.supplierId)?.focus({preventScroll:true});
  }
  const canRefresh = () => !writing && !!window.parent.WorkshopCloudHost?.canRefresh?.(window);
  function scheduleRemote(delay = 600) {
    if (remoteTimer || !csrf || !active() || wantedRevision <= knownRevision && !remoteData) return;
    remoteTimer = setTimeout(() => {remoteTimer = null; void refreshRemote();}, delay);
  }
  async function refreshRemote() {
    if (!active()) return;
    if (loading || !canRefresh()) {scheduleRemote(); return;}
    if (wantedRevision <= knownRevision && !remoteData) return;
    loading = true;
    let failedRefresh = false;
    try {
      const data = remoteData && Number(remoteData.revision) >= wantedRevision ? remoteData : await api();
      remoteData = data;
      // A form can open during the request. Keep its original version and its
      // draft; present the fetched records only after it has been closed.
      if (!canRefresh()) return;
      const id = currentId;
      const listed = data.items?.find(item => String(item.id) === id);
      const detail = id && listed && listed.version !== currentDetail?.version ? await api('/' + encodeURIComponent(id)) : null;
      if (!canRefresh()) return;
      present(data); remoteData = null;
      if (detail && currentId === id) {
        const item = detail.item || detail;
        if (JSON.stringify(item) !== JSON.stringify(currentDetail)) renderDetail(item);
      }
    } catch (error) {
      failedRefresh = true; remoteData = null;
      expensesError = 'Spese non aggiornate: ' + error.message + (expensesLoaded ? ' Sono mostrati gli ultimi dati disponibili.' : '');
      renderExpenses();
      if (active()) notice('Aggiornamento fatture non riuscito: ' + error.message, true);
      remoteFailures++;
      return;
    } finally {
      loading = false;
      if (queued) {queued = false; queueMicrotask(reload);}
      else if (remoteData || wantedRevision > knownRevision) scheduleRemote(failedRefresh ? remoteFailures === 1 ? 3000 : remoteFailures === 2 ? 10000 : 30000 : 600);
    }
  }
  window.addEventListener('workshop-remote-update', event => {
    if (event.detail?.domain !== 'supplier-invoices') return;
    const revision = Number(event.detail.revision);
    if (!Number.isSafeInteger(revision) || revision < 0) return;
    wantedRevision = Math.max(wantedRevision, revision); scheduleRemote();
  });
  const showError = (id, message) => { const field = $(id); field.textContent = message; field.hidden = !message; };
  function openModal(id, focusId) {
    $(id).classList.add('open');
    $(focusId)?.focus();
  }
  function closeModal(id) {
    $(id).classList.remove('open');
  }
  function openInvoiceForm(item = null) {
    if (!canWrite()) return;
    const form = $('supplierInvoiceForm');
    form.reset(); form.dataset.conflicted = '';
    formMode = item ? 'edit' : 'create';
    editingId = item?.id ?? null;
    editingVersion = item?.version ?? null;
    formMutationId = crypto.randomUUID();
    $('supplierInvoiceFormTitle').textContent = item ? (isPending(item) ? 'Verifica fattura ricevuta' : 'Modifica fattura fornitore') : 'Registra fattura fornitore';
    $('supplierFormName').value = val(item, 'supplierName');
    $('supplierFormTaxId').value = val(item, 'supplierTaxId');
    $('supplierFormNumber').value = val(item, 'number');
    $('supplierFormIssueDate').value = item?.issueDate || today();
    $('supplierFormDueDate').value = item?.dueDate || '';
    $('supplierFormTotal').value = item?.totalCents == null ? '' : inputMoney(item.totalCents);
    $('supplierFormNotes').value = val(item, 'notes');
    $('supplierFormReviewBox').hidden = !item || !isPending(item) || isCreditNote(item);
    $('supplierFormVerified').checked = false;
    $('supplierFormSubmit').disabled = false;
    $('supplierFormSubmit').textContent = item ? 'Salva modifiche' : 'Salva fattura';
    showError('supplierFormError', '');
    openModal('supplierInvoiceModal', 'supplierFormName');
  }
  function openPaymentForm(item) {
    if (!canWrite() || !isOpen(item)) return;
    $('supplierPaymentForm').reset(); $('supplierPaymentForm').dataset.conflicted = '';
    paymentMutationId = crypto.randomUUID();
    $('supplierPaymentAmount').value = inputMoney(item.outstandingCents);
    $('supplierPaymentDate').value = today();
    $('supplierPaymentSubmit').disabled = false;
    showError('supplierPaymentError', '');
    openModal('supplierPaymentModal', 'supplierPaymentAmount');
  }
  $('supplierFormVerified').addEventListener('change', () => {
    if (formMode === 'edit' && !$('supplierFormReviewBox').hidden) $('supplierFormSubmit').textContent = $('supplierFormVerified').checked ? 'Salva e conferma' : 'Salva senza confermare';
  });
  $('supplierInvoiceForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (!canWrite()) return;
    const button = $('supplierFormSubmit');
    if (button.disabled) return;
    showError('supplierFormError', '');
    let data;
    try {
      data = {
        supplierName:$('supplierFormName').value.trim(),
        supplierTaxId:$('supplierFormTaxId').value.trim(),
        number:$('supplierFormNumber').value.trim(),
        issueDate:$('supplierFormIssueDate').value,
        dueDate:$('supplierFormDueDate').value || null,
        totalCents:parseCents($('supplierFormTotal').value),
        notes:$('supplierFormNotes').value.trim()
      };
      if (!data.supplierName || !data.number || !data.issueDate) throw Error('Compila fornitore, numero e data della fattura.');
      if (formMode === 'edit') {
        data.expectedVersion = editingVersion;
        if (!$('supplierFormReviewBox').hidden && $('supplierFormVerified').checked) data.verified = true;
      } else data.mutationId = formMutationId;
    } catch (error) { showError('supplierFormError', error.message); return; }
    button.disabled = true;
    writing++;
    try {
      if (formMode === 'edit') await api('/' + encodeURIComponent(editingId), 'PATCH', data);
      else await api('', 'POST', data);
      closeModal('supplierInvoiceModal');
      await reload();
      if (editingId && currentId === String(editingId)) await openDetail(editingId);
      notice(formMode === 'edit' ? 'Fattura aggiornata.' : 'Fattura registrata.');
    } catch (error) {
      if (error.code === 'SUPPLIER_CONFLICT') {
        $('supplierInvoiceForm').dataset.conflicted = '1';
        showError('supplierFormError', 'Questa fattura è stata modificata da un altro operatore. Nessuna modifica è stata sovrascritta. Chiudi e riapri la scheda, confronta i dati aggiornati e ripeti.');
        await reload();
      } else showError('supplierFormError', error.message || 'Salvataggio non riuscito. Riprova.');
    } finally { writing--; button.disabled = $('supplierInvoiceForm').dataset.conflicted === '1'; scheduleRemote(); }
  });
  $('supplierPaymentForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (!canWrite() || !currentId) return;
    const button = $('supplierPaymentSubmit');
    if (button.disabled) return;
    showError('supplierPaymentError', '');
    let data;
    try {
      if (!$('supplierPaymentConfirmed').checked) throw Error('Conferma che il pagamento è già stato effettuato.');
      data = {
        mutationId:paymentMutationId,
        amountCents:parseCents($('supplierPaymentAmount').value),
        paidAt:$('supplierPaymentDate').value,
        method:$('supplierPaymentMethod').value,
        reference:$('supplierPaymentReference').value.trim()
      };
      if (!data.paidAt) throw Error('Indica la data del pagamento.');
      if (data.amountCents > Number(currentDetail?.outstandingCents || 0)) throw Error('L’importo supera il saldo ancora da pagare.');
    } catch (error) { showError('supplierPaymentError', error.message); return; }
    button.disabled = true;
    const id = currentId;
    writing++;
    try {
      await api('/' + encodeURIComponent(id) + '/payments', 'POST', data);
      closeModal('supplierPaymentModal');
      await reload();
      if (currentId === id) await openDetail(id);
      notice('Pagamento registrato. Il bonifico non è stato eseguito dal gestionale.');
    } catch (error) {
      if (['SUPPLIER_OVERPAYMENT', 'SUPPLIER_UNVERIFIED'].includes(error.code)) {
        $('supplierPaymentForm').dataset.conflicted = '1';
        showError('supplierPaymentError', 'Il saldo è cambiato nel frattempo. Nessun pagamento è stato registrato da questa richiesta. Chiudi, controlla il nuovo saldo e riapri il modulo.');
        await reload();
      } else showError('supplierPaymentError', error.message || 'Registrazione non riuscita. Riprova.');
    } finally { writing--; button.disabled = $('supplierPaymentForm').dataset.conflicted === '1'; scheduleRemote(); }
  });
  $('supplierInvoiceNew').hidden = role === 'viewer';
  $('supplierInvoiceNew').addEventListener('click', () => openInvoiceForm());
  $('supplierExportCsv').addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const data = await api();
      const records = Array.isArray(data.items) ? data.items : [];
      const amount = value => value == null ? '' : inputMoney(value);
      const lines = [
        ['Fornitore','Partita IVA / C.F.','Numero','Tipo documento','Origine','Verificata','Data fattura','Scadenza','Totale IVA inclusa EUR','Pagato EUR','Da pagare EUR','Stato','Note'],
        ...records.map(item => [item.supplierName,item.supplierTaxId,item.number,item.documentType,item.source === 'pec' ? 'PEC' : item.source === 'sdi' ? 'SdI' : 'Manuale',item.verified ? 'Sì' : 'No',item.issueDate,item.dueDate,amount(item.totalCents),amount(item.paidCents),amount(item.outstandingCents),statusInfo(item)[0],item.notes])
      ];
      const safeCell = value => {
        let text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
        // Spreadsheet applications can execute a cell beginning with one of these symbols.
        if (/^[=+\-@]/.test(text)) text = "'" + text;
        return '"' + text.replace(/"/g, '""') + '"';
      };
      const csv = '\uFEFF' + lines.map(row => row.map(safeCell).join(';')).join('\r\n') + '\r\n';
      const url = URL.createObjectURL(new Blob([csv], {type:'text/csv;charset=utf-8'}));
      const link = node('a');
      link.href = url; link.download = 'fatture-fornitori-' + today() + '.csv';
      link.dataset.view = 'supplier-export-file'; // Read-only users may download this summary.
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (error) { notice('Esportazione non riuscita: ' + error.message, true); }
    finally { button.disabled = false; }
  });
  $('supplierInvoiceList').addEventListener('click', event => {
    const item = event.target.closest('[data-supplier-id]');
    if (item) openDetail(item.dataset.supplierId);
  });
  $('supplierInvoiceSearch').addEventListener('input', renderList);
  $('supplierInvoiceFilter').addEventListener('change', renderList);
  $('supplierFormCancel').addEventListener('click', () => closeModal('supplierInvoiceModal'));
  $('supplierPaymentCancel').addEventListener('click', () => closeModal('supplierPaymentModal'));
  for (const id of ['supplierInvoiceModal', 'supplierPaymentModal']) $(id).addEventListener('click', event => { if (event.target === $(id)) closeModal(id); });
  window.addEventListener('workshop-section-change', event => {
    closeModal('supplierInvoiceModal'); closeModal('supplierPaymentModal');
    if (['supplierInvoices', 'analysis'].includes(event.detail?.view)) reload();
  });

  fetch('/api/session', {credentials:'same-origin', cache:'no-store'}).then(response => response.json()).then(session => {
    if (!session.user || !session.csrf) throw Error('Sessione scaduta. Accedi di nuovo.');
    csrf = session.csrf;
    reload();
  }).catch(error => notice('Fatture fornitori non disponibili: ' + error.message, true));
})();
