import { HttpError } from './validation.mjs';
import { createRequire } from 'node:module';

const R = createRequire(import.meta.url)('../cloud-records.js');
const Dio = createRequire(import.meta.url)('../inventory-dio-core.js');
const Count = createRequire(import.meta.url)('../inventory-count.js');

const units = new Set(['pz', 'lt', 'kg', 'g', 'm']);
const newStockFields = ['product', 'category', 'unit', 'price', 'unitProfit', 'location', 'minimum'];
const money = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER / 100 && value === Math.round(value * 100) / 100;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const quantity = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const unitQuantity = (value, unit) => quantity(value) && value === Number(value.toFixed(unit === 'lt' ? 1 : unit === 'kg' ? 3 : unit === 'm' ? 2 : 0));
const invalid = message => { throw new HttpError(400, 'INVENTORY_COUNT', message); };
const stockKey = id => JSON.stringify(['row', '#stockRows', id]);
const conflict = keys => {
  const conflicts = [...new Set(keys || [])].slice(0, 30).map(key => {
    let id = ''; try { id = JSON.parse(key)[2] || ''; } catch {}
    return { key, label: id ? 'Articolo di magazzino · ' + id.slice(0, 8) : 'Magazzino dell’inventario' };
  });
  throw new HttpError(409, 'DEPENDENCY_CONFLICT', 'Una o più scorte sono cambiate durante il conteggio. Controlla gli articoli indicati e riprova.', {
    conflicts: conflicts.length ? conflicts : [{ key: 'domain:inventory', label: 'Magazzino dell’inventario' }]
  });
};
const text = node => typeof node === 'string' ? node : (node?.c || []).map(text).join('');
const find = (node, predicate) => {
  if (!plain(node)) return null;
  if (predicate(node)) return node;
  for (const child of node.c || []) { const match = find(child, predicate); if (match) return match; }
  return null;
};
function numberFrom(value) {
  const source = String(value ?? '').trim().replace(/[^0-9,.-]/g, '');
  if (!source) return NaN;
  const comma = source.lastIndexOf(',');
  const normalized = comma > -1
    ? source.replace(/\./g, '').replace(',', '.')
    : /^\d{1,3}(?:\.\d{3})+$/.test(source) ? source.replace(/\./g, '') : source;
  return Number(normalized);
}
function stockQuantity(row, requireStored = false) {
  const cell = row.c?.filter(child => child?.t === 'td' || child?.t === 'th')[2];
  const control = find(cell, node => (node.a?.class || '').split(/\s+/).includes('qty-adjust'));
  const display = control && find(control, node => node.t === 'b');
  const shown = display ? numberFrom(text(display)) : cell ? numberFrom(text(cell)) : NaN;
  const stored = row.a?.['data-quantity'];
  if (requireStored && stored === undefined || stored === '') return NaN;
  const saved = stored === undefined ? shown : Number(stored);
  // The browser reads the control before the data attribute. Both must agree
  // so refreshing a completed count cannot restore a different quantity.
  if (!quantity(saved) || !Number.isFinite(shown) || shown !== saved) return NaN;
  return saved;
}
function stockUnit(row) {
  const saved = row.a?.['data-unit'];
  if (units.has(saved)) return saved;
  const cell = row.c?.filter(child => child?.t === 'td' || child?.t === 'th')[2];
  return text(cell).match(/\b(pz|lt|kg|g|m)\b/i)?.[1].toLowerCase() || 'pz';
}
function stockRows(records) {
  const rows = new Map();
  for (const [key, row] of records) {
    const [kind, name, id] = JSON.parse(key);
    if (kind === 'row' && name === '#stockRows') rows.set(id, row);
  }
  return rows;
}
function validateDraft(draft) {
  if (!plain(draft) || typeof draft.id !== 'string' || !draft.id || draft.id.length > 128
    || !['counting', 'review', 'applied'].includes(draft.status)
    || !Number.isSafeInteger(draft.baseInventoryVersion) || draft.baseInventoryVersion < 0
    || !Array.isArray(draft.items) || draft.items.length > 20000) invalid('Bozza inventario non valida.');
  const ids = new Set();
  for (const item of draft.items) {
    if (!plain(item) || typeof item.cloudId !== 'string' || !item.cloudId || item.cloudId.length > 128
      || ids.has(item.cloudId) || !units.has(item.unit)
      || !unitQuantity(item.expectedQuantity, item.unit) || !unitQuantity(item.countedQuantity, item.unit)) invalid('Articolo o quantità dell’inventario non validi.');
    if (item.needsRecount !== undefined && typeof item.needsRecount !== 'boolean') invalid('Conferma del nuovo conteggio non valida.');
    if (item.isNew !== undefined || item.stock !== undefined) validateNewStock(item);
    ids.add(item.cloudId);
  }
  if (draft.baseStockVersions !== undefined) {
    if (!plain(draft.baseStockVersions) || Object.keys(draft.baseStockVersions).length > 20000
      || Object.entries(draft.baseStockVersions).some(([key, revision]) => {
        let parts; try { parts = JSON.parse(key); } catch { return true; }
        return !Array.isArray(parts) || parts.length !== 3 || parts[0] !== 'row' || parts[1] !== '#stockRows'
          || !ids.has(parts[2]) || !Number.isSafeInteger(revision) || revision < 0;
      })) invalid('Versioni delle scorte nell’inventario non valide.');
  }
  return ids;
}
function validateNewStock(item) {
  const stock = item.stock;
  if (item.isNew !== true || item.expectedQuantity !== 0 || !plain(stock)
    || Object.keys(stock).length !== newStockFields.length || newStockFields.some(key => !Object.hasOwn(stock, key))
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.cloudId)
    || typeof stock.product !== 'string' || !stock.product.trim() || stock.product.length > 1000
    || typeof stock.category !== 'string' || !stock.category.trim() || stock.category.length > 160
    || typeof stock.location !== 'string' || stock.location.length > 500
    || stock.product !== item.product || stock.category !== item.category || stock.unit !== item.unit
    || stock.price !== null && !money(stock.price) || !money(stock.unitProfit)
    || !Number.isSafeInteger(stock.minimum) || stock.minimum < 0) invalid('I dati della nuova scorta dell’inventario non sono validi.');
}
function sameCapturedItems(before, after, rows, versionFor) {
  const items = new Map(after.items.map(item => [item.cloudId, item]));
  const sameBaseline = (old, item) => old.unit === item.unit && old.expectedQuantity === item.expectedQuantity
    && old.product === item.product && old.category === item.category && old.isNew === item.isNew
    && (old.isNew ? newStockFields.every(key => old.stock[key] === item.stock[key])
      : (before.baseStockVersions?.[stockKey(old.cloudId)] ?? null) === (after.baseStockVersions?.[stockKey(item.cloudId)] ?? null));
  const currentBaseline = item => {
    const row = rows.get(item.cloudId), cells = row?.c?.filter(child => child?.t === 'td' || child?.t === 'th');
    return !!row && cells?.length >= 3 && text(cells[0]).trim() === item.product && text(cells[1]).trim() === item.category
      && stockUnit(row) === item.unit && stockQuantity(row) === item.expectedQuantity
      && (after.baseStockVersions?.[stockKey(item.cloudId)] === versionFor(stockKey(item.cloudId))
        || item.needsRecount === true && after.baseStockVersions?.[stockKey(item.cloudId)] < versionFor(stockKey(item.cloudId)));
  };
  if (!before.items.every(old => {
    const item = items.get(old.cloudId);
    if (!item) return !old.isNew && !rows.has(old.cloudId);
    return sameBaseline(old, item) || !old.isNew && currentBaseline(item);
  })) return false;
  const oldIds = new Set(before.items.map(item => item.cloudId));
  return after.items.every(item => oldIds.has(item.cloudId)
    || item.isNew === true && after.status === 'counting'
    || !item.isNew && ['counting', 'review'].includes(after.status) && currentBaseline(item));
}
function matchesIds(items, rows) {
  return items.size === rows.size && [...items].every(id => rows.has(id));
}
const existingIds = draft => new Set(draft.items.filter(item => !item.isNew).map(item => item.cloudId));
function matchesNewStock(item, row) {
  const stock = item.stock, cells = row?.c?.filter(child => child?.t === 'td' || child?.t === 'th');
  return cells?.length >= 6 && text(cells[0]).trim() === stock.product && text(cells[1]).trim() === stock.category
    && text(cells[4]).trim() === (stock.location || '—') && Number(row.a['data-minimum']) === stock.minimum
    && Number(row.a['data-unit-profit']) === stock.unitProfit
    && (stock.price === null ? text(cells[3]).trim() === '€ —' : numberFrom(text(cells[3])) === stock.price);
}

// Apply only recorded sales, including their reversals. A generic decrease
// could be a manual correction or another inventory: it is not safe to infer
// that the already counted physical stock left the workshop.
function saleDelta(before, after) {
  const previousRaw = before.a?.['data-dio-history'], nextRaw = after.a?.['data-dio-history'];
  const previous = previousRaw ? Dio.parseLedger(previousRaw) : null, next = Dio.parseLedger(nextRaw);
  if (!next || previousRaw && !previous) return null;
  if (previous) {
    if (previous.startedAt !== next.startedAt || R.stable(previous.opening) !== R.stable(next.opening)) return null;
  } else if (next.opening.quantity !== stockQuantity(before) || next.events.some(event => event.kind !== 'sale')) return null;
  const events = ledger => new Map((ledger?.events || []).map(event => [event.id, event]));
  const oldEvents = events(previous), newEvents = events(next);
  if (oldEvents.size !== (previous?.events.length || 0) || newEvents.size !== next.events.length) return null;
  let delta = 0;
  for (const id of new Set([...oldEvents.keys(), ...newEvents.keys()])) {
    const old = oldEvents.get(id), current = newEvents.get(id);
    if (old?.kind === 'sale' || current?.kind === 'sale') {
      if (old && old.kind !== 'sale' || current && current.kind !== 'sale') return null;
      delta += (current?.quantity || 0) - (old?.quantity || 0);
    } else if (R.stable(old) !== R.stable(current)) return null;
  }
  const change = stockQuantity(before) - stockQuantity(after);
  return Number.isFinite(delta) && Math.abs(delta) > 1e-8 && Number.isFinite(change) && Math.abs(change - delta) < 1e-8 ? delta : null;
}

// The first intervention can assign a lookup ID to an existing article. This
// one-time addition does not move physical stock and must not make a saved
// count stale before that intervention is subsequently completed.
function assignsStockLookupId(before, after) {
  const oldAttrs = { ...before.a }, nextAttrs = { ...after.a }; let added = false;
  for (const attribute of ['data-tyre-stock-id', 'data-consumable-stock-id']) {
    if ((oldAttrs[attribute] === undefined || oldAttrs[attribute] === '') && typeof nextAttrs[attribute] === 'string'
      && nextAttrs[attribute].trim() && nextAttrs[attribute].length <= 128) {
      delete oldAttrs[attribute]; delete nextAttrs[attribute]; added = true;
    }
  }
  return added && R.stable({ ...before, a: oldAttrs }) === R.stable({ ...after, a: nextAttrs });
}

// Called in the record transaction, after validating the client's count edits.
// Returning the affected record keys lets the store version these generated
// changes without telling the sender that it has already seen their values.
export function adjustInventoryCountForSales(before, state, revision, versionFor = () => 0) {
  const oldData = JSON.parse(R.inflate(before).storage['officina.inventory.v1'] || '{}');
  const nextData = JSON.parse(state.storage['officina.inventory.v1'] || '{}');
  const old = oldData?.countDraft, next = nextData?.countDraft;
  if (!old || !next || old.id !== next.id || !['counting', 'review'].includes(old.status) || !['counting', 'review'].includes(next.status)) return [];
  try { validateDraft(old); validateDraft(next); } catch { return []; }
  const oldRows = stockRows(before), nextRows = new Map(state.dom['#stockRows'].map(row => [row.a['data-cloud-id'], row]));
  const oldItems = new Map(old.items.map(item => [item.cloudId, item])), keys = [];
  for (const item of next.items) {
    const prior = oldItems.get(item.cloudId), rowBefore = oldRows.get(item.cloudId), rowAfter = nextRows.get(item.cloudId), key = stockKey(item.cloudId);
    if (!prior || item.isNew || item.needsRecount === true || !rowBefore || !rowAfter
      || R.stable(item) !== R.stable(prior)
      || (old.baseStockVersions?.[key] ?? null) !== (next.baseStockVersions?.[key] ?? null)
      || next.baseStockVersions?.[key] !== versionFor(key)
      || item.expectedQuantity !== stockQuantity(rowBefore) || item.unit !== stockUnit(rowBefore) || item.unit !== stockUnit(rowAfter)) continue;
    const cellsBefore = rowBefore.c?.filter(child => child?.t === 'td' || child?.t === 'th'), cellsAfter = rowAfter.c?.filter(child => child?.t === 'td' || child?.t === 'th');
    if (text(cellsBefore?.[0]).trim() !== item.product || text(cellsAfter?.[0]).trim() !== item.product
      || text(cellsBefore?.[1]).trim() !== item.category || text(cellsAfter?.[1]).trim() !== item.category) continue;
    if (assignsStockLookupId(rowBefore, rowAfter)) {
      next.baseStockVersions[key] = revision;
      keys.push(R.key('inventory-count-item', next.id, item.cloudId));
      continue;
    }
    if (item.counted === true && Object.hasOwn(item, 'countInput')) {
      const entered = Count.quantity(item.countInput, item.unit);
      if (!String(item.countInput ?? '').trim() || entered.error || entered.value !== item.countedQuantity) continue;
    }
    const delta = saleDelta(rowBefore, rowAfter);
    if (delta === null) continue;
    const precision = item.unit === 'lt' ? 1 : item.unit === 'kg' ? 3 : item.unit === 'm' ? 2 : 0;
    const nextCount = item.counted === true ? Number((item.countedQuantity - delta).toFixed(precision)) : 0;
    const nextQuantity = stockQuantity(rowAfter);
    if (!unitQuantity(nextQuantity, item.unit) || !unitQuantity(Math.max(0, nextCount), item.unit)) continue;
    item.expectedQuantity = nextQuantity;
    item.countedQuantity = Math.max(0, nextCount);
    if (item.counted === true) item.countInput = String(item.countedQuantity);
    if (nextCount < 0) item.needsRecount = true;
    else next.baseStockVersions[key] = revision;
    keys.push(R.key('inventory-count-item', next.id, item.cloudId));
  }
  if (keys.length) { validateDraft(next); state.storage['officina.inventory.v1'] = JSON.stringify(nextData); }
  return keys;
}

// Older running servers counted draft saves as inventory writes. Recover only
// when the complete audit interval proves that no stock write occurred. Keep
// the inventory version monotonic so unrelated stale work remains fenced.
export function recoverLegacyInventoryCount(state, inventoryVersion, auditRows) {
  const data = JSON.parse(state.storage['officina.inventory.v1'] || '{}'), draft = data?.countDraft;
  if (!draft || !['counting', 'review'].includes(draft.status) || draft.baseInventoryVersion >= inventoryVersion) return null;
  try { validateDraft(draft); } catch { return null; }
  let revision = draft.baseInventoryVersion;
  for (const row of auditRows) {
    if (row.revision <= revision || row.revision > inventoryVersion) continue;
    if (row.revision !== revision + 1 || row.action !== 'records-saved') return null;
    let keys;
    try { keys = JSON.parse(row.details)?.keys; } catch { return null; }
    if (!Array.isArray(keys) || keys.some(encoded => {
      let parts; try { parts = JSON.parse(encoded); } catch { return true; }
      return parts[0] === 'row' && parts[1] === '#stockRows'
        || parts[0] === 'storage' && ['officina.deliveryLoads.v1', 'officina-table-import-v1'].includes(parts[1]);
    })) return null;
    revision = row.revision;
  }
  if (revision !== inventoryVersion) return null;
  const rows = stockRows(new Map(state.dom['#stockRows'].map(row => [JSON.stringify(['row', '#stockRows', row.a['data-cloud-id']]), row])));
  if (!matchesIds(existingIds(draft), rows)) return null;
  if (draft.items.filter(item => !item.isNew).some(item => stockQuantity(rows.get(item.cloudId)) !== item.expectedQuantity || stockUnit(rows.get(item.cloudId)) !== item.unit)) return null;
  draft.baseInventoryVersion = inventoryVersion;
  return JSON.stringify(data);
}

// Called inside the record transaction after structural state validation. The
// original inventory revision remains as audit context; safety is fenced by
// the version of each captured stock row so unrelated changes can proceed.
export function validateInventoryCount(before, state, inventoryVersion, versionFor = () => 0) {
  const oldValue = R.inflate(before).storage['officina.inventory.v1'], nextValue = state.storage['officina.inventory.v1'];
  if (oldValue === nextValue) return;
  const old = JSON.parse(oldValue || '{}')?.countDraft;
  const next = JSON.parse(nextValue || '{}')?.countDraft;
  if (!next || JSON.stringify(old) === JSON.stringify(next)) return;
  const ids = validateDraft(next), rows = stockRows(before);
  if (old?.id === next.id) {
    validateDraft(old);
    if (old.baseInventoryVersion !== next.baseInventoryVersion || !sameCapturedItems(old, next, rows, versionFor)) invalid('La base dell’inventario non può essere modificata durante il conteggio.');
    if (old.status === 'applied') invalid('Un inventario applicato non può essere modificato. Avvia un nuovo conteggio.');
  } else {
    if (next.status !== 'counting') invalid('Avvia e salva il conteggio prima di applicare l’inventario.');
    if (next.items.some(item => item.isNew)) invalid('Avvia e salva il conteggio prima di aggiungere nuove scorte.');
    if (!matchesIds(ids, rows)) {
      const differences = new Set([...ids].filter(id => !rows.has(id)).concat([...rows.keys()].filter(id => !ids.has(id))));
      conflict([...differences].map(stockKey));
    }
    const stale = [];
    for (const item of next.items) {
      const row = rows.get(item.cloudId);
      const key = stockKey(item.cloudId), cells = row?.c?.filter(child => child?.t === 'td' || child?.t === 'th');
      if (stockQuantity(row) !== item.expectedQuantity || stockUnit(row) !== item.unit
        || cells?.length < 3 || text(cells[0]).trim() !== item.product || text(cells[1]).trim() !== item.category
        || next.baseStockVersions?.[key] !== versionFor(key)) stale.push(key);
    }
    if (stale.length) conflict(stale);
  }
  if (next.status !== 'applied') return;
  if (!old || old.id !== next.id || !['counting', 'review'].includes(old.status)) invalid('Il conteggio da applicare non è stato salvato.');
  if (!matchesIds(existingIds(next), rows) || next.items.some(item => item.isNew && rows.has(item.cloudId))) {
    const existing = existingIds(next), differences = new Set([...existing].filter(id => !rows.has(id)).concat([...rows.keys()].filter(id => !existing.has(id))));
    conflict([...differences].map(stockKey));
  }
  const stale = next.items.filter(item => !item.isNew && (item.needsRecount === true
    || next.baseStockVersions?.[stockKey(item.cloudId)] !== versionFor(stockKey(item.cloudId)))).map(item => stockKey(item.cloudId));
  if (stale.length) conflict(stale);
  const afterRows = new Map(state.dom['#stockRows'].map(row => [row.a['data-cloud-id'], row]));
  if (!matchesIds(ids, afterRows)) invalid('La sostituzione deve includere tutte le scorte dell’inventario.');
  for (const item of next.items) {
    const row = afterRows.get(item.cloudId);
    if (stockUnit(row) !== item.unit || stockQuantity(row, true) !== item.countedQuantity) invalid('Le quantità del magazzino devono corrispondere al conteggio completato.');
    if (item.isNew && !matchesNewStock(item, row)) invalid('La nuova scorta deve mantenere i dati salvati nel conteggio.');
  }
}
