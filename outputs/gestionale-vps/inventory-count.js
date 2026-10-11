/* Physical inventory counts live in a separate draft until replacement is confirmed. */
(function (root, factory) {
  'use strict';
  const core = factory();
  if (typeof module === 'object' && module.exports) module.exports = core;
  else root.WorkshopInventoryCountCore = core;
})(globalThis, function () {
  'use strict';
  const precision = unit => ({pz:0, g:0, lt:1, kg:3, m:2})[unit] ?? 0;
  const active = draft => !!draft && ['counting', 'review'].includes(draft.status);
  function quantity(value, unit, quantize) {
    const raw = String(value ?? '').trim();
    if (!raw) return {value:0, error:null};
    if (!/^\d+(?:[.,]\d+)?$/.test(raw)) return {error:'Inserisci una quantità maggiore o uguale a zero.'};
    const parsed = Number(raw.replace(',', '.'));
    if (!Number.isFinite(parsed) || parsed > Number.MAX_SAFE_INTEGER) return {error:'La quantità inserita è troppo grande.'};
    const places = precision(unit), decimals = (raw.split(/[.,]/)[1] || '').replace(/0+$/, '').length;
    if (decimals > places) return {error:places === 0 ? 'Per ' + unit + ' inserisci una quantità intera.' : 'Per ' + unit + ' sono consentiti al massimo ' + places + ' decimali.'};
    return {value:quantize ? quantize(parsed, unit) : Number(parsed.toFixed(places)), error:null};
  }
  function draft(items, baseInventoryVersion, id, startedAt) {
    return {id, status:'counting', startedAt, baseInventoryVersion, items:items.map(item => ({...item, countedQuantity:0, counted:false, countInput:'0'}))};
  }
  function summary(value) {
    const items = value.items || [];
    const differences = items.filter(item => Number(item.expectedQuantity) !== Number(item.countedQuantity)).map(item => ({...item, difference:Number((item.countedQuantity - item.expectedQuantity).toFixed(precision(item.unit)))}));
    return {total:items.length, entered:items.filter(item => item.counted).length, unentered:items.filter(item => !item.counted).length, added:items.filter(item => item.isNew).length, differences};
  }
  const money = value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER / 100 && value === Math.round(value * 100) / 100;
  function validNewStock(item) {
    const stock = item.stock;
    return !!(item.isNew === true && item.expectedQuantity === 0 && stock && typeof stock === 'object' && !Array.isArray(stock)
      && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.cloudId)
      && ['pz','lt','kg','g','m'].includes(item.unit)
      && Object.keys(stock).length === 7 && ['product','category','unit','price','unitProfit','location','minimum'].every(key => Object.hasOwn(stock, key))
      && typeof stock.product === 'string' && stock.product.trim() && stock.product.length <= 1000
      && typeof stock.category === 'string' && stock.category.trim() && stock.category.length <= 160
      && typeof stock.location === 'string' && stock.location.length <= 500
      && stock.product === item.product && stock.category === item.category && stock.unit === item.unit
      && (stock.price === null || money(stock.price)) && money(stock.unitProfit)
      && Number.isSafeInteger(stock.minimum) && stock.minimum >= 0 && stock.minimum <= Number.MAX_SAFE_INTEGER);
  }
  function addStock(value, stock, cloudId, countedQuantity = 0) {
    if (!active(value) || value.status !== 'counting') throw Error('Torna al conteggio per aggiungere una scorta.');
    if (value.items.some(item => item.cloudId === cloudId)) throw Error('La scorta è già presente nel conteggio.');
    const item = {cloudId, isNew:true, product:stock.product, category:stock.category, unit:stock.unit, expectedQuantity:0, countedQuantity, counted:true, countInput:String(countedQuantity), stock:{...stock}};
    if (!validNewStock(item) || quantity(String(countedQuantity), stock.unit).error) throw Error('I dati della nuova scorta non sono validi.');
    value.items.push(item); return item;
  }
  function validate(value) {
    if (!value || !['counting','review','applied'].includes(value.status) || !Array.isArray(value.items) || !value.id || !Number.isSafeInteger(value.baseInventoryVersion) || value.baseInventoryVersion < 0) return false;
    const ids = new Set();
    return value.items.every(item => item && typeof item.cloudId === 'string' && item.cloudId && !ids.has(item.cloudId) && (ids.add(item.cloudId), true) && ['pz','lt','kg','g','m'].includes(item.unit) && Number.isFinite(item.expectedQuantity) && item.expectedQuantity >= 0 && Number.isFinite(item.countedQuantity) && item.countedQuantity >= 0 && (item.isNew === undefined && item.stock === undefined || validNewStock(item)));
  }
  return Object.freeze({precision, active, quantity, draft, summary, validate, addStock});
});

if (typeof document !== 'undefined') (() => {
  'use strict';
  const core = window.WorkshopInventoryCountCore, api = window.stockInventoryApi, cloud = window.WorkshopCloud;
  const head = document.querySelector('#magazzino .page-head');
  if (!core || !api || !head || !cloud) return;
  const storageKey = 'officina.inventory.v1', $ = id => document.getElementById(id);
  const clone = value => structuredClone(value), stable = window.WorkshopCloudRecords.stable;
  const role = cloud.boot?.user?.role || 'viewer';
  const adjustsSales = cloud.boot.features?.inventoryCountSales === 1;
  const canWrite = () => role !== 'viewer' && window.parent.WorkshopCloudHost?.canWrite?.();
  function compatibleServer() {
    if (cloud.boot.features?.inventoryCount === 4) return true;
    message('Il servizio sta usando una versione precedente del controllo inventario. Aggiorna e riavvia il servizio del gestionale, poi ricarica la pagina. La conta inserita è conservata.', true);
    return false;
  }
  let busy = false, discardPending = false, originalFocus;
  const rawDraft = () => readInventory().countDraft;
  const currentDraft = () => core.validate(rawDraft()) ? rawDraft() : null;
  function readInventory() {
    try {
      const value = JSON.parse(localStorage.getItem(storageKey) || '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  }
  function saveDraft(value) {
    const inventory = readInventory();
    if (value === null) delete inventory.countDraft;
    else inventory.countDraft = value;
    localStorage.setItem(storageKey, JSON.stringify(inventory));
    refreshButton();
  }
  function refreshButton() {
    const draft = currentDraft();
    $('inventoryCountStart').textContent = core.active(draft) ? 'Riprendi inventario' : 'Fai inventario';
    $('inventoryCountStart').hidden = role === 'viewer';
  }
  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  }
  function button(id, text, handler, secondary = false) {
    const element = node('button', text, 'btn' + (secondary ? ' secondary' : ''));
    element.type = 'button'; element.id = id; element.addEventListener('click', handler); return element;
  }
  const startButton = button('inventoryCountStart', 'Fai inventario', () => void open());
  (head.querySelector('.stock-header-actions') || head).append(startButton);
  const modal = node('div', undefined, 'form-modal inventory-count-modal');
  modal.id = 'inventoryCountModal'; modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-labelledby', 'inventoryCountTitle'); modal.setAttribute('aria-busy', 'false');
  const card = node('div', undefined, 'modal-card inventory-count-card');
  const heading = node('div', undefined, 'inventory-count-heading');
  const title = node('h2', 'Inventario magazzino'); title.id = 'inventoryCountTitle'; title.tabIndex = -1;
  const closeButton = button('inventoryCountClose', 'Chiudi', () => void close(), true);
  heading.append(title, closeButton);
  const description = node('p'); description.id = 'inventoryCountDescription';
  const status = node('p', '', 'inventory-count-status'); status.id = 'inventoryCountStatus'; status.setAttribute('role', 'status');
  const error = node('p', '', 'inventory-count-error'); error.id = 'inventoryCountError'; error.setAttribute('role', 'alert'); error.hidden = true;
  const content = node('div'); content.id = 'inventoryCountContent';
  const actions = node('div', undefined, 'modal-actions inventory-count-actions'); actions.id = 'inventoryCountActions';
  card.append(heading, description, status, error, content, actions); modal.append(card); document.body.append(modal);
  modal.addEventListener('click', event => { if (event.target === modal) void close(); });
  modal.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); void close(); }
    if (event.key === 'Tab') {
      const controls = [...modal.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled])')].filter(element => !element.hidden && element.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  function message(value, isError = false) {
    if (isError) { error.textContent = value; error.hidden = !value; }
    else status.textContent = value;
  }
  function setBusy(value, label = '') {
    busy = value;
    modal.setAttribute('aria-busy', String(value));
    modal.querySelectorAll('button,input,select').forEach(element => { element.disabled = value; });
    startButton.disabled = value;
    if (label) message(label);
  }
  const format = (value, unit) => Number(value).toLocaleString('it-IT', {maximumFractionDigits:core.precision(unit)}) + ' ' + unit;
  function stockState(state) {
    const textContent = value => typeof value === 'string' ? value : (value?.c || []).map(textContent).join('');
    const units = new Set(['pz', 'lt', 'kg', 'g', 'm']);
    const quantityFrom = value => {
      const match = String(value || '').replace(/\u00a0/g, ' ').match(/-?\d[\d.,]*/);
      if (!match) return null;
      const raw = match[0], normalized = raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw.replace(/\.(?=\d{3}(?:\.|$))/g, '');
      const quantity = Number(normalized); return Number.isFinite(quantity) ? quantity : null;
    };
    return [...(state?.dom?.['#stockRows'] || [])].filter(item => typeof item !== 'string' && item.a?.['data-cloud-id'] && !String(item.a.class || '').includes('empty-filter')).map(item => {
      const cells = item.c?.filter(child => child?.t === 'td' || child?.t === 'th') || [];
      const quantityText = textContent(cells[2]), savedUnit = String(item.a['data-unit'] || '').toLowerCase();
      const unit = units.has(savedUnit) ? savedUnit : (quantityText.match(/\b(pz|lt|kg|g|m)\b/i)?.[1] || 'pz').toLowerCase();
      const savedQuantity = String(item.a['data-quantity'] ?? '').trim(), quantity = savedQuantity && Number.isFinite(Number(savedQuantity)) ? Number(savedQuantity) : quantityFrom(quantityText);
      return [item.a['data-cloud-id'], textContent(cells[0]).trim(), textContent(cells[1]).trim(), unit, quantity];
    }).sort((a, b) => a[0].localeCompare(b[0]));
  }
  function refreshCountFromLiveStock(draft, versions) {
    if (!core.active(draft) || !['counting','review'].includes(draft.status)) return false;
    const rows = api.rows();
    const old = new Map(draft.items.map(item => [item.cloudId, item]));
    const base = {...(draft.baseStockVersions || {})}; let changed = false, removed = false, added = false, reset = false;
    const items = [];
    for (const row of rows) {
      const id = row.dataset.cloudId, key = window.WorkshopCloudRecords.key('row', '#stockRows', id), item = old.get(id);
      const product = api.productName(row), category = row.cells[1]?.textContent.trim() || '', unit = api.unitFor(row), quantity = api.quantityFor(row), version = versions?.[key] ?? base[key] ?? 0;
      if (item?.isNew) { items.push(item); old.delete(id); continue; }
      if (!item) {
        items.push({cloudId:id, product, category, unit, expectedQuantity:quantity, countedQuantity:0, counted:false, countInput:'0'});
        added = changed = true;
      } else {
        const baselineChanged = item.product !== product || item.category !== category || item.unit !== unit || item.expectedQuantity !== quantity || base[key] !== version;
        if (item.unit !== unit) { item.countedQuantity = 0; item.counted = false; item.countInput = '0'; item.needsRecount = false; reset = true; }
        else if (baselineChanged && item.counted) item.needsRecount = true;
        if (baselineChanged || item.needsRecount) changed = true;
        item.product = product; item.category = category; item.unit = unit; item.expectedQuantity = quantity; items.push(item); old.delete(id);
      }
      if (!item?.needsRecount) base[key] = version;
    }
    for (const item of old.values()) {
      if (item.isNew) { items.push(item); continue; }
      delete base[window.WorkshopCloudRecords.key('row', '#stockRows', item.cloudId)]; removed = changed = true;
    }
    if (!changed) return false;
    draft.items = items; draft.baseStockVersions = base; saveDraft(draft);
    return {added, removed, reset};
  }
  function applyLiveCountUpdate(detail) {
    const stockChanged = !!detail?.selectors?.includes('#stockRows'), draftChanged = !!detail?.inventoryDraftChanged;
    if (!stockChanged && !draftChanged) return;
    const draft = currentDraft(); refreshButton(); if (!core.active(draft)) return;
    const currentVersions = window.parent.WorkshopCloudHost?.recordVersions?.(window);
    const result = stockChanged ? refreshCountFromLiveStock(draft, {...(detail.versions || {}), ...(currentVersions || {})}) : null;
    if (!modal.classList.contains('open')) return;
    if ($('inventoryCountNewForm')) { message('Un altro operatore ha aggiornato il conteggio. Le modifiche sono caricate dopo aver salvato o chiuso il nuovo prodotto.'); return; }
    const search = $('inventoryCountSearch'), category = $('inventoryCountCategory'), list = $('inventoryCountList');
    if (!list && !$('inventoryCountReport')) return; // Do not replace an unfinished new-stock form.
    const active = document.activeElement, activeCountId = active?.dataset?.countQuantity, selection = activeCountId && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
    const filterText = search?.value || '', filterCategory = category?.value || '', scrollTop = list?.scrollTop || 0;
    render();
    const nextSearch = $('inventoryCountSearch'), nextCategory = $('inventoryCountCategory'), nextList = $('inventoryCountList');
    if (nextSearch) { nextSearch.value = filterText; nextSearch.dispatchEvent(new Event('input')); }
    if (nextCategory) { nextCategory.value = filterCategory; nextCategory.dispatchEvent(new Event('change')); }
    if (nextList) nextList.scrollTop = scrollTop;
    if (activeCountId) {
      const input = modal.querySelector('[data-count-quantity="' + CSS.escape(activeCountId) + '"]');
      if (input) { input.focus({preventScroll:true}); if (selection) input.setSelectionRange(...selection); }
    } else if (active?.id && modal.contains(active)) modal.querySelector('#' + CSS.escape(active.id))?.focus({preventScroll:true});
    message(stockChanged && result ? 'Le scorte sono aggiornate. Le quantità contate dagli operatori sono state unite.' : adjustsSales && stockChanged && draftChanged ? 'Conteggio aggiornato. Le vendite registrate sono già scalate dalle quantità contate.' : 'Conteggio aggiornato da un altro operatore.');
  }
  async function snapshot() {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch('/api/state', {credentials:'same-origin', cache:'no-store', signal:controller.signal});
      const value = await response.json();
      if (!response.ok) throw Error(value?.error?.message || 'Il magazzino sul server non è disponibile.');
      if (value?.state === null && value.protocol === 2 && value.revision === 0 && value.versions) value.state = window.WorkshopCloudRecords.empty();
      if (!value?.state || !value?.versions) throw Error('Il server ha restituito un magazzino non valido.');
      return value;
    } catch (failure) {
      if (failure.name === 'AbortError') throw Error('Il server non risponde. Verifica la connessione e riprova.');
      throw failure;
    } finally { clearTimeout(timeout); }
  }
  function showModal() {
    originalFocus = document.activeElement; modal.classList.add('open'); title.focus();
  }
  async function open() {
    if (busy || !canWrite()) return;
    discardPending = false; message('', true);
    if (cloud.boot.features?.inventoryCount !== 4) {
      render(); showModal(); compatibleServer();
      modal.querySelectorAll('[data-count-quantity],#inventoryCountActions button').forEach(element => { element.disabled = true; });
      return;
    }
    if (core.active(currentDraft())) {
      const draft = currentDraft();
      const refreshed = refreshCountFromLiveStock(draft, window.parent.WorkshopCloudHost?.recordVersions?.(window));
      if (refreshed) message('Ho aggiornato le scorte più recenti. Verifica gli articoli modificati prima di applicare il conteggio.');
      render(); showModal(); return;
    }
    content.replaceChildren(); actions.replaceChildren(); description.textContent = 'Preparazione del magazzino temporaneo…'; showModal();
    await start();
  }
  async function start() {
    if (busy || !canWrite()) return false;
    if (!compatibleServer()) return false;
    setBusy(true, 'Verifica e salvataggio dei dati in corso…'); message('', true);
    try {
      await cloud.flush();
      let current, local, synchronized = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        current = await window.parent.WorkshopCloudHost.refreshInventory(window);
        local = cloud.capture();
        if (stable(stockState(local)) === stable(stockState(current.state))) { synchronized = true; break; }
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 120));
      }
      if (!synchronized) throw Error('Il magazzino continua a cambiare su un altro dispositivo. Ho sincronizzato le scorte: riprova ad avviare l’inventario tra qualche secondo.');
      const rows = api.rows();
      if (!rows.length && cloud.boot.features?.inventoryNewStock !== 1) throw Error('Il magazzino è vuoto. Aggiungi almeno una scorta prima di fare l’inventario.');
      const items = rows.map(row => ({cloudId:row.dataset.cloudId, product:api.productName(row), category:row.cells[1]?.textContent.trim() || '', unit:api.unitFor(row), expectedQuantity:api.quantityFor(row)}));
      const next = core.draft(items, current.versions['domain:inventory'] || 0, crypto.randomUUID(), new Date().toISOString());
      next.baseStockVersions = Object.fromEntries(items.map(item => { const key = window.WorkshopCloudRecords.key('row', '#stockRows', item.cloudId); return [key, current.versions[key] || 0]; }));
      if (!core.validate(next)) throw Error('Le scorte non hanno ancora un identificativo valido. Chiudi e cambia sezione, poi riprova.');
      saveDraft(next); await cloud.flush(); render(); message('Bozza salvata. Inserisci le quantità effettivamente presenti.'); return true;
    } catch (failure) {
      render(); message(failure.message, true); return false;
    } finally { setBusy(false); }
  }
  function render() {
    discardPending = false; content.replaceChildren(); actions.replaceChildren();
    const draft = currentDraft();
    if (!draft) {
      title.textContent = 'Inventario magazzino'; description.textContent = 'Crea un magazzino temporaneo con tutte le quantità a zero.';
      actions.append(button('inventoryCountRetry', 'Avvia inventario', () => void start()));
      return;
    }
    title.textContent = draft.status === 'applied' ? 'Inventario applicato' : draft.status === 'review' ? 'Resoconto inventario' : 'Conteggio delle scorte';
    description.textContent = draft.status === 'counting' ? 'Il magazzino temporaneo parte da zero. Conta ogni prodotto e inserisci la quantità presente. La bozza viene salvata automaticamente.' : draft.status === 'applied' ? 'Il magazzino ora contiene le quantità contate. I prodotti mantengono prezzi, unità e prenotazioni.' : 'Verifica le differenze prima di sostituire le quantità del magazzino.';
    if (adjustsSales && core.active(draft)) description.textContent += ' Le vendite successive al conteggio vengono scalate automaticamente dalla bozza.';
    if (draft.status === 'counting') renderCount(draft); else renderSummary(draft);
  }
  function renderCount(draft) {
    const progress = node('p', '', 'inventory-count-progress'); progress.id = 'inventoryCountProgress';
    const updateProgress = () => { const result = core.summary(currentDraft()); progress.textContent = result.entered + ' di ' + result.total + ' prodotti contati · Quantità iniziali: 0'; };
    const countHead = node('div', undefined, 'inventory-count-tools');
    const addButton = button('inventoryCountAddStock', '+ Aggiungi scorta', renderNewStock, true);
    countHead.append(progress, addButton); content.append(countHead); updateProgress();
    const filters = node('div', undefined, 'inventory-count-filters');
    const searchLabel = node('label', 'Cerca prodotto');
    const search = node('input'); search.id = 'inventoryCountSearch'; search.type = 'search'; search.placeholder = 'Nome del prodotto'; searchLabel.append(search);
    const categoryLabel = node('label', 'Categoria');
    const category = node('select'); category.id = 'inventoryCountCategory'; category.append(new Option('Tutte le categorie', ''));
    [...new Set(draft.items.map(item => item.category))].sort((a, b) => a.localeCompare(b, 'it')).forEach(value => category.append(new Option(value, value))); categoryLabel.append(category);
    filters.append(searchLabel, categoryLabel); content.append(filters);
    const list = node('div', undefined, 'inventory-count-list'); list.id = 'inventoryCountList'; list.setAttribute('aria-label', 'Scorte del magazzino temporaneo');
    const empty = node('p', 'Nessun prodotto trovato.', 'inventory-count-empty'); empty.hidden = true;
    draft.items.forEach((item, index) => {
      const row = node('div', undefined, 'inventory-count-row'); row.dataset.countStockId = item.cloudId;
      const info = node('div', undefined, 'inventory-count-product'); info.append(node('strong', item.product), node('small', item.category + (item.isNew ? ' · Nuova scorta: verrà aggiunta applicando l’inventario' : ' · In magazzino: ' + format(item.expectedQuantity, item.unit))));
      const label = node('label', 'Quantità contata (' + item.unit + ')');
      const input = node('input'); input.type = 'text'; input.inputMode = core.precision(item.unit) ? 'decimal' : 'numeric'; input.autocomplete = 'off'; input.value = item.countInput ?? String(item.countedQuantity); input.id = 'inventoryCountQuantity' + index; input.dataset.countQuantity = item.cloudId; label.htmlFor = input.id; input.setAttribute('aria-label', 'Quantità contata di ' + item.product + ' in ' + item.unit); label.append(input);
      const saved = node('small', item.needsRecount ? 'Scorta modificata: inserisci di nuovo la quantità contata' : item.counted ? 'Contato' : 'Da contare', 'inventory-count-entered');
      const invalid = core.quantity(input.value, item.unit, api.quantize).error; input.setAttribute('aria-invalid', String(!!invalid));
      if (invalid) saved.textContent = invalid;
      input.addEventListener('focus', () => input.select());
      input.addEventListener('input', () => {
        const next = currentDraft(); if (!core.active(next)) return;
        const target = next.items.find(value => value.cloudId === item.cloudId), result = core.quantity(input.value, target.unit, api.quantize);
        target.countInput = input.value; target.counted = input.value.trim() !== '';
        if (!result.error) target.countedQuantity = result.value;
        if (target.counted && !result.error) {
          target.needsRecount = false;
          const key = window.WorkshopCloudRecords.key('row', '#stockRows', target.cloudId);
          const versions = window.parent.WorkshopCloudHost?.recordVersions?.(window);
          const row = api.rows().find(value => value.dataset.cloudId === target.cloudId);
          if (row && api.productName(row) === target.product && row.cells[1]?.textContent.trim() === target.category
            && api.unitFor(row) === target.unit && api.quantityFor(row) === target.expectedQuantity
            && Number.isSafeInteger(versions?.[key])) next.baseStockVersions[key] = versions[key];
        }
        input.setAttribute('aria-invalid', String(!!result.error)); saved.textContent = result.error ? result.error : target.counted ? 'Contato' : 'Da contare';
        saveDraft(next); updateProgress(); message('La bozza viene salvata automaticamente.'); message('', true);
      });
      const control = node('div', undefined, 'inventory-count-control'); control.append(label, saved); row.append(info, control); list.append(row);
    });
    list.append(empty); content.append(list);
    const filter = () => {
      const text = search.value.trim().toLocaleLowerCase('it-IT'); let visible = 0;
      list.querySelectorAll('[data-count-stock-id]').forEach((row, index) => {
        const item = draft.items[index]; row.hidden = !!(text && !item.product.toLocaleLowerCase('it-IT').includes(text) || category.value && item.category !== category.value); if (!row.hidden) visible++;
      }); empty.hidden = visible > 0;
    };
    search.addEventListener('input', filter); category.addEventListener('change', filter);
    actions.append(button('inventoryCountDiscard', 'Elimina bozza', askDiscard, true), button('inventoryCountReview', 'Completa conteggio', () => void review()));
  }
  function renderNewStock() {
    if (busy || !canWrite() || currentDraft()?.status !== 'counting') return;
    if (cloud.boot.features?.inventoryNewStock !== 1) { message('Aggiorna e riavvia il servizio del gestionale prima di aggiungere scorte al conteggio. La bozza è conservata.', true); return; }
    title.textContent = 'Nuova scorta nell’inventario';
    description.textContent = 'Inserisci il prodotto trovato durante il conteggio. Verrà aggiunto al magazzino solo quando premi “Applica inventario”.';
    content.replaceChildren(); actions.replaceChildren(); message('', true);
    const form = node('form', undefined, 'inventory-count-new-form'); form.id = 'inventoryCountNewForm';
    const fields = node('div', undefined, 'inventory-count-new-fields');
    const field = (id, caption, type, value = '', required = false) => {
      const label = node('label', caption), input = node('input'); input.id = id; input.type = type; input.value = value; input.required = required; label.htmlFor = id; label.append(input); fields.append(label); return input;
    };
    const product = field('inventoryNewProduct', 'Prodotto', 'text', '', true); product.maxLength = 1000;
    const categoryLabel = node('label', 'Categoria'), category = node('select'); category.id = 'inventoryNewCategory'; category.required = true; categoryLabel.htmlFor = category.id;
    category.append(new Option('Seleziona categoria', ''));
    const categoryOptions = [...(document.getElementById('stockCategory')?.options || [])].filter(option => option.value);
    categoryOptions.forEach(option => category.append(new Option(option.textContent, option.value)));
    categoryLabel.append(category); fields.append(categoryLabel);
    const unitLabel = node('label', 'Unità di misura'), unit = node('select'); unit.id = 'inventoryNewUnit'; unitLabel.htmlFor = unit.id;
    for (const [value, caption] of [['pz','Pezzi (pz)'],['lt','Litri (lt)'],['kg','Chilogrammi (kg)'],['g','Grammi (g)'],['m','Metri (m)']]) unit.append(new Option(caption, value));
    unitLabel.append(unit); fields.append(unitLabel);
    const quantity = field('inventoryNewQuantity', 'Quantità contata', 'text', '0', true); quantity.inputMode = 'decimal';
    const price = field('inventoryNewPrice', 'Prezzo unitario (€)', 'number'); price.min = '0'; price.step = '0.01';
    const profit = field('inventoryNewUnitProfit', 'Ricarico / profitto unitario (€)', 'number', '0'); profit.min = '0'; profit.step = '0.01';
    const location = field('inventoryNewLocation', 'Posizione', 'text'); location.maxLength = 500;
    const minimum = field('inventoryNewMinimum', 'Scorta minima', 'number', '5'); minimum.min = '0'; minimum.step = '1';
    const formActions = node('div', undefined, 'modal-actions inventory-count-actions');
    const cancel = button('inventoryNewCancel', 'Torna al conteggio', () => { render(); message('', true); }, true);
    const submit = node('button', 'Aggiungi al conteggio', 'btn'); submit.id = 'inventoryNewSave'; submit.type = 'submit'; formActions.append(cancel, submit);
    form.append(fields, formActions); content.append(form); product.focus();
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (busy || !canWrite() || !form.reportValidity()) return;
      const result = core.quantity(quantity.value, unit.value, api.quantize);
      if (result.error) { message(result.error, true); quantity.setAttribute('aria-invalid','true'); quantity.focus(); return; }
      const stock = {product:product.value.trim(), category:category.value, unit:unit.value, price:price.value === '' ? null : Number(price.value), unitProfit:profit.value === '' ? 0 : Number(profit.value), location:location.value.trim(), minimum:minimum.value === '' ? 5 : Number(minimum.value)};
      const next = currentDraft(); if (next?.status !== 'counting') { message('La bozza non è più disponibile. Chiudi e riapri l’inventario.', true); return; }
      setBusy(true, 'Salvataggio della nuova scorta nella bozza…'); message('', true);
      try {
        const added = core.addStock(next, stock, crypto.randomUUID(), result.value); saveDraft(next); await cloud.flush(); render();
        message('Nuova scorta salvata nella bozza. Il magazzino operativo non è stato modificato.');
        content.querySelector('[data-count-quantity="' + added.cloudId + '"]')?.focus();
      } catch (failure) { message(failure.message + ' I dati del conteggio sono conservati.', true); }
      finally { setBusy(false); }
    });
  }
  function renderSummary(draft) {
    const result = core.summary(draft);
    const overview = node('p', result.total + ' prodotti · ' + result.differences.length + ' differenze rilevate' + (result.added ? ' · ' + result.added + (result.added === 1 ? ' nuova scorta' : ' nuove scorte') : ''), 'inventory-count-progress'); content.append(overview);
    if (result.unentered && draft.status !== 'applied') {
      const warning = node('p', result.unentered === 1 ? '1 prodotto non è stato contato: sarà impostato a 0 quando applichi l’inventario.' : result.unentered + ' prodotti non sono stati contati: saranno impostati a 0 quando applichi l’inventario.', 'inventory-count-warning'); warning.id = 'inventoryCountUnentered'; content.append(warning);
    }
    const list = node('div', undefined, 'inventory-count-list inventory-count-report'); list.id = 'inventoryCountReport';
    const changedIds = new Set(result.differences.map(item => item.cloudId));
    const reported = draft.items.filter(item => item.isNew || item.needsRecount || changedIds.has(item.cloudId));
    if (!reported.length) list.append(node('p', 'Tutte le scorte corrispondono alle quantità del magazzino.', 'inventory-count-empty'));
    reported.forEach(item => {
      const difference = Number((item.countedQuantity - item.expectedQuantity).toFixed(core.precision(item.unit)));
      const row = node('div', undefined, 'inventory-count-row'); row.dataset.countStockId = item.cloudId;
      const info = node('div', undefined, 'inventory-count-product'); info.append(node('strong', item.product), node('small', item.category + (item.needsRecount ? ' · Scorta modificata: ricontare' : item.isNew ? ' · Nuova scorta' : '')));
      const values = node('dl', undefined, 'inventory-count-values');
      for (const [label, text] of [['In magazzino', format(item.expectedQuantity, item.unit)], ['Contati', format(item.countedQuantity, item.unit)], ['Differenza', (difference > 0 ? '+' : '') + format(difference, item.unit)]]) { const pair = node('div'); pair.append(node('dt', label), node('dd', text)); values.append(pair); }
      row.append(info, values); list.append(row);
    }); content.append(list);
    if (draft.status !== 'applied') actions.append(button('inventoryCountBack', 'Torna al conteggio', () => { const next = currentDraft(); next.status = 'counting'; saveDraft(next); message('', true); render(); }, true), button('inventoryCountDiscard', 'Elimina bozza', askDiscard, true), button('inventoryCountApply', 'Applica inventario', () => void apply()));
    else actions.append(button('inventoryCountDone', 'Chiudi resoconto', () => void close()));
  }
  function invalidQuantity(draft) {
    for (const item of draft.items) {
      if (item.needsRecount) return item.product + ': la scorta è cambiata durante il conteggio. Inserisci di nuovo la quantità contata.';
      const result = core.quantity(item.countInput ?? String(item.countedQuantity), item.unit, api.quantize);
      if (result.error) return item.product + ': ' + result.error;
      item.countedQuantity = result.value;
    }
    return null;
  }
  async function review() {
    if (busy || !canWrite()) return false;
    if (!compatibleServer()) return false;
    const draft = currentDraft(); if (!core.active(draft)) return false;
    const invalid = invalidQuantity(draft);
    if (invalid) { message(invalid, true); return false; }
    draft.status = 'review'; draft.reviewedAt = new Date().toISOString(); saveDraft(draft); render(); setBusy(true, 'Salvataggio del resoconto…');
    try { await cloud.flush(); message('Controlla il resoconto, poi premi “Applica inventario”.'); return true; }
    catch (failure) { message(failure.message, true); return false; }
    finally { setBusy(false); }
  }
  async function apply() {
    if (busy || !canWrite()) return false;
    if (!compatibleServer()) return false;
    const draft = currentDraft(); if (draft?.status !== 'review') return false;
    const invalid = invalidQuantity(draft); if (invalid) { message(invalid, true); return false; }
    setBusy(true, 'Verifica del magazzino e applicazione dell’inventario…'); message('', true);
    let rollback;
    try {
      await cloud.flush();
      let current = await snapshot();
      if (stable(stockState(cloud.capture())) !== stable(stockState(current.state))) throw Error('Le scorte mostrate non corrispondono al server. Attendi l’aggiornamento live e riprova.');
      let rebased = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        const update = refreshCountFromLiveStock(draft, current.versions);
        if (!update) break;
        rebased = true;
        if (draft.items.some(item => item.needsRecount)) { render(); throw Error('Una scorta contata è cambiata: inserisci di nuovo la quantità indicata prima di applicare.'); }
        await cloud.flush(); current = await snapshot();
        if (stable(stockState(cloud.capture())) !== stable(stockState(current.state))) throw Error('Le scorte sono cambiate di nuovo. Attendi l’aggiornamento live e riprova.');
        if (attempt === 2) throw Error('Il magazzino continua ad aggiornarsi. Attendi qualche secondo e riprova.');
      }
      if (rebased) { render(); message('Conteggio aggiornato alle ultime scorte ricevute.'); }
      if (Object.entries(draft.baseStockVersions || {}).some(([key, version]) => (current.versions[key] || 0) !== version)) throw Error('Una o più scorte sono cambiate durante il conteggio. Gli aggiornamenti in arrivo verranno mostrati: controlla le righe aggiornate e riprova.');
      const serverDraft = JSON.parse(current.state.storage[storageKey] || '{}').countDraft;
      if (serverDraft?.id !== draft.id || serverDraft.status !== 'review' || stable(serverDraft.items) !== stable(draft.items)) throw Error('La bozza è stata modificata da un altro operatore. Chiudi e cambia sezione per caricare l’ultima versione.');
      const rows = api.rows(), ids = rows.map(row => row.dataset.cloudId).sort(), capturedIds = draft.items.filter(item => !item.isNew).map(item => item.cloudId).sort();
      if (stable(ids) !== stable(capturedIds)) throw Error('L’elenco delle scorte è cambiato. Elimina la bozza e avvia un nuovo inventario con i dati aggiornati.');
      if (draft.items.some(item => item.isNew && ids.includes(item.cloudId))) throw Error('Una nuova scorta ha un identificativo già presente nel magazzino. L’inventario non è stato applicato.');
      rollback = {draft:clone(draft), quantities:rows.map(row => [row, api.quantityFor(row)]), added:[]};
      const byId = new Map(draft.items.map(item => [item.cloudId, item]));
      rows.forEach(row => api.setQuantity(row, byId.get(row.dataset.cloudId).countedQuantity));
      for (const item of draft.items.filter(value => value.isNew)) {
        const row = newStockRow(item); rollback.added.push(row); document.getElementById('stockRows').append(row);
      }
      draft.status = 'applied'; draft.appliedAt = new Date().toISOString(); saveDraft(draft);
      await cloud.flush();
      for (const name of ['filterStock','renderStockPageTotal','renderTyreSummary','renderCriticalStock']) window[name]?.();
      const now = new Date(), completedDate = window.localCreationDate?.() || [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
      window.dispatchEvent(new CustomEvent('workshop-inventory-count-applied', {detail:{id:draft.id, date:completedDate, draft:clone(draft)}}));
      render(); message('Inventario applicato e salvato sul server.'); return true;
    } catch (failure) {
      if (rollback) { rollback.added.forEach(row => row.remove()); rollback.quantities.forEach(([row, quantity]) => api.setQuantity(row, quantity)); saveDraft(rollback.draft); render(); }
      message(failure.message + (rollback ? ' La bozza è conservata. Ricarica i dati server per verificare le quantità e riprovare.' : ''), true); return false;
    } finally { setBusy(false); }
  }
  function newStockRow(item) {
    const data = item.stock, row = node('tr'); row.dataset.cloudId = item.cloudId; row.dataset.unit = data.unit; row.dataset.minimum = String(data.minimum);
    const product = node('td'); product.append(node('b', data.product));
    const price = node('td', data.price === null ? '€ —' : '€ ' + data.price.toLocaleString('it-IT', {minimumFractionDigits:2, maximumFractionDigits:2}), 'price-cell');
    row.append(product, node('td', data.category), node('td', '0 ' + data.unit), price, node('td', data.location || '—'), node('td'));
    api.setUnitProfit(row, data.unitProfit); api.setQuantity(row, item.countedQuantity); api.normalizeRows([row]); return row;
  }
  function askDiscard() {
    if (busy || !canWrite()) return;
    discardPending = true; actions.replaceChildren(); message('', true);
    message('Eliminare tutte le quantità inserite in questo inventario temporaneo?');
    actions.append(button('inventoryCountKeep', 'Conserva bozza', () => { message('Bozza conservata.'); render(); }, true), button('inventoryCountConfirmDiscard', 'Elimina inventario temporaneo', () => void discard()));
  }
  async function discard() {
    if (busy || !canWrite() || !discardPending) return false;
    setBusy(true, 'Eliminazione della bozza…');
    const previous = currentDraft();
    try { saveDraft(null); await cloud.flush(); modal.classList.remove('open'); originalFocus?.focus(); message(''); return true; }
    catch (failure) { saveDraft(previous); render(); message(failure.message + ' La bozza è conservata.', true); return false; }
    finally { discardPending = false; setBusy(false); }
  }
  async function close() {
    if (busy) return false;
    if (core.active(currentDraft()) && canWrite()) {
      setBusy(true, 'Salvataggio della bozza…');
      try { await cloud.flush(); }
      catch (failure) { message(failure.message + ' La bozza è conservata.', true); }
      finally { setBusy(false); }
    }
    modal.classList.remove('open'); originalFocus?.focus(); return true;
  }
  window.WorkshopInventoryCount = {open, start, review, apply, close, discard:askDiscard, draft:() => clone(currentDraft()), refresh:refreshButton, core};
  window.addEventListener('workshop-section-change', refreshButton);
  window.addEventListener('workshop-cloud-snapshot-applied', event => applyLiveCountUpdate(event.detail));
  refreshButton();
})();
