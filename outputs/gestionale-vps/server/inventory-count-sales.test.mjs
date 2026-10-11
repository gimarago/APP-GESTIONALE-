import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { openDatabase } from './database.mjs';
import { recordStore } from './records.mjs';
import { makeStateValidator, HttpError } from './validation.mjs';

const require = createRequire(import.meta.url), R = require('../cloud-records.js'), Dio = require('../inventory-dio-core.js'), schema = require('../cloud-schema.js');
const name = 'officina.inventory.v1', at = Date.parse('2026-10-09T08:00:00Z');
const stockKey = id => R.key('row', '#stockRows', id);
const td = c => ({ t: 'td', a: {}, c });
const data = state => JSON.parse(state.storage[name]);
const write = (state, value) => { state.storage[name] = JSON.stringify(value); };
const item = (snapshot, id = 'tyre') => data(snapshot.state).countDraft.items.find(value => value.cloudId === id);
const countKey = snapshot => R.key('inventory-count-item', data(snapshot.state).countDraft.id, 'tyre');
function setQuantity(row, value) {
  row.a['data-quantity'] = String(value);
  row.c[2].c = [{ t: 'span', a: { class: 'qty-adjust' }, c: [
    { t: 'b', a: {}, c: [value.toLocaleString('it-IT', { maximumFractionDigits: 3 })] },
    { t: 'span', a: { class: 'stock-unit-label' }, c: [row.a['data-unit']] }
  ] }];
}
const rowFor = (state, id = 'tyre') => state.dom['#stockRows'].find(row => row.a['data-cloud-id'] === id);
function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'officina-count-sales-')), db = openDatabase(directory), validator = makeStateValidator(schema);
  const auth = { role: 'operator', username: 'Counter', sessionId: randomUUID() }, clientId = randomUUID();
  let store = recordStore(db, validator, Date.now, options.validateCommit);
  t.after(() => {
    db.close(); const absolute = resolve(directory);
    assert.ok(absolute.startsWith(resolve(tmpdir()) + sep) && basename(absolute).startsWith('officina-count-sales-'));
    rmSync(absolute, { recursive: true, force: true });
  });
  const operation = (change, base = store.read()) => {
    const next = structuredClone(base.state || R.empty()); change(next);
    return { protocol: 2, clientId, mutationId: randomUUID(), versions: base.versions, changes: R.diff(base.state, next, base.versions) };
  };
  const save = (change, base) => store.commit(auth, operation(change, base));
  save(state => {
    for (const [id, quantity, unit] of [['tyre', options.quantity ?? 12, options.unit || 'pz'], ['other', 20, 'pz']]) {
      const row = { t: 'tr', a: { 'data-cloud-id': id, 'data-unit': unit, 'data-minimum': '0' }, c: [td(['Product ' + id]), td(['Categoria']), td([]), td(['€ 10,00']), td(['A']), td(['DISPONIBILE'])] };
      setQuantity(row, quantity);
      if (options.history !== false) row.a['data-dio-history'] = JSON.stringify(Dio.createLedger(at, quantity, 10));
      state.dom['#stockRows'].push(row);
    }
    write(state, { interval: 30, history: [], enabled: true });
  });
  const start = () => {
    const base = store.read();
    save(state => write(state, { ...data(state), countDraft: {
      id: randomUUID(), status: 'counting', startedAt: new Date(at).toISOString(), baseInventoryVersion: base.versions['domain:inventory'],
      baseStockVersions: Object.fromEntries(state.dom['#stockRows'].map(row => [stockKey(row.a['data-cloud-id']), base.versions[stockKey(row.a['data-cloud-id'])]])),
      items: state.dom['#stockRows'].map(row => ({ cloudId: row.a['data-cloud-id'], product: 'Product ' + row.a['data-cloud-id'], category: 'Categoria', unit: row.a['data-unit'], expectedQuantity: Number(row.a['data-quantity']), countedQuantity: 0, counted: false, countInput: '0' }))
    } }), base);
  };
  const count = (value, id = 'tyre') => state => {
    const valueData = data(state), target = valueData.countDraft.items.find(value => value.cloudId === id);
    Object.assign(target, { countedQuantity: value, counted: true, countInput: String(value) }); write(state, valueData);
  };
  const sale = (quantity, eventId = 'sale:tyre:agenda:job', id = 'tyre') => state => {
    const row = rowFor(state, id), available = Number(row.a['data-quantity']);
    const ledger = Dio.parseLedger(row.a['data-dio-history']) || Dio.createLedger(at, available, 10);
    const previous = ledger.events.find(event => event.id === eventId)?.quantity || 0;
    row.a['data-dio-history'] = JSON.stringify(Dio.upsert(ledger, { id: eventId, kind: 'sale', quantity, unitCost: 10, at: at + 1000 }));
    setQuantity(row, available + previous - quantity);
  };
  const reverse = (eventId = 'sale:tyre:agenda:job') => state => {
    const row = rowFor(state), ledger = Dio.parseLedger(row.a['data-dio-history']), quantity = ledger.events.find(event => event.id === eventId)?.quantity || 0;
    row.a['data-dio-history'] = JSON.stringify(Dio.remove(ledger, eventId)); setQuantity(row, Number(row.a['data-quantity']) + quantity);
  };
  const apply = state => {
    const value = data(state); value.countDraft.status = 'applied';
    for (const counted of value.countDraft.items) setQuantity(rowFor(state, counted.cloudId), counted.countedQuantity);
    write(state, value);
  };
  return { db, auth, get store() { return store; }, operation, save, start, count, sale, reverse, apply, restart() { store = recordStore(db, validator, Date.now, options.validateCommit); } };
}

test('sale atomically deducts an already counted stock, preserves count discrepancy and applies the adjusted count', t => {
  const f = fixture(t); f.start(); f.save(f.count(10));
  const before = f.store.read(), key = countKey(before), result = f.save(f.sale(4)), saved = f.store.read();
  assert.equal(result.serverGeneratedChanges, true); assert.equal(Object.hasOwn(result.versions, key), false);
  assert.equal(saved.versions[key], result.revision); assert.equal(item(saved).countedQuantity, 6);
  assert.equal(item(saved).countInput, '6'); assert.equal(item(saved).expectedQuantity, 8); assert.notEqual(item(saved).needsRecount, true);
  assert.equal(data(saved.state).countDraft.baseStockVersions[stockKey('tyre')], saved.versions[stockKey('tyre')]);
  assert.equal(item(saved, 'other').counted, false);
  const audited = JSON.parse(f.db.prepare("SELECT details FROM audit WHERE revision=? AND action='records-saved'").get(result.revision).details);
  assert.ok(audited.keys.includes(key)); assert.ok(audited.serverGeneratedKeys.includes(key));
  f.save(f.apply); assert.equal(Number(rowFor(f.store.read().state).a['data-quantity']), 6);
});

test('first sale initializes missing historical ledger and still updates the saved count', t => {
  const f = fixture(t, { history: false }); f.start(); f.save(f.count(12));
  assert.equal(f.save(f.sale(3)).serverGeneratedChanges, true); assert.equal(item(f.store.read()).countedQuantity, 9);
});

test('uncounted article stays uncounted at zero and can later be counted against its updated baseline', t => {
  const f = fixture(t); f.start(); const result = f.save(f.sale(4)), saved = f.store.read();
  assert.equal(result.serverGeneratedChanges, true); assert.equal(item(saved).countedQuantity, 0); assert.equal(item(saved).counted, false);
  assert.equal(item(saved).expectedQuantity, 8);
  f.save(f.count(8)); f.save(f.apply); assert.equal(Number(rowFor(f.store.read().state).a['data-quantity']), 8);
});

test('sequential sales, re-edits and reversals adjust only the actual net movement', t => {
  const f = fixture(t); f.start(); f.save(f.count(12));
  f.save(f.sale(4)); f.save(f.sale(2, 'sale:tyre:agenda:another')); assert.equal(item(f.store.read()).countedQuantity, 6);
  f.save(f.sale(3)); assert.equal(item(f.store.read()).countedQuantity, 7);
  f.save(f.reverse()); assert.equal(item(f.store.read()).countedQuantity, 10);
  f.save(f.reverse('sale:tyre:agenda:another')); assert.equal(item(f.store.read()).countedQuantity, 12);
});

test('replayed sales preserve their acknowledgement flag without repeating any adjustment after restart', t => {
  const f = fixture(t); f.start(); f.save(f.count(12)); const operation = f.operation(f.sale(4));
  const first = f.store.commit(f.auth, operation); f.save(f.sale(2, 'sale:tyre:agenda:another'));
  const latest = f.store.read(); f.restart(); const replay = f.store.commit(f.auth, operation);
  assert.equal(first.serverGeneratedChanges, true); assert.equal(replay.serverGeneratedChanges, true); assert.equal(replay.replayed, true);
  assert.equal(replay.revision, first.revision); assert.deepEqual(f.store.read(), latest); assert.equal(item(latest).countedQuantity, 6);
});

test('generated keys remain excluded from acknowledgement versions even if explicitly requested unchanged', t => {
  const f = fixture(t); f.start(); f.save(f.count(12)); const base = f.store.read(), operation = f.operation(f.sale(4), base), key = countKey(base);
  operation.changes.push({ key, expectedVersion: base.versions[key], value: R.flatten(base.state).get(key) });
  const result = f.store.commit(f.auth, operation); assert.equal(result.serverGeneratedChanges, true); assert.equal(Object.hasOwn(result.versions, key), false);
  assert.equal(f.store.read().versions[key], result.revision);
});

test('litre consumption and its reversal retain supported decimal precision', t => {
  const f = fixture(t, { quantity: 10.5, unit: 'lt' }); f.start(); f.save(f.count(9.7)); f.save(f.sale(4.3, 'sale:consumable:agenda:oil'));
  assert.equal(item(f.store.read()).countedQuantity, 5.4); assert.equal(item(f.store.read()).expectedQuantity, 6.2);
  f.save(f.reverse('sale:consumable:agenda:oil')); assert.equal(item(f.store.read()).countedQuantity, 9.7);
});

test('unsupported live stock precision cannot generate an invalid counted baseline', t => {
  const f = fixture(t, { quantity: 10.5, unit: 'lt' }); f.start(); f.save(f.count(10.5)); const before = item(f.store.read());
  const result = f.save(f.sale(0.25, 'sale:consumable:agenda:oil'));
  assert.equal(Object.hasOwn(result, 'serverGeneratedChanges'), false); assert.deepEqual(item(f.store.read()), before);
  assert.throws(() => f.save(f.apply), error => error.status === 409 && error.code === 'DEPENDENCY_CONFLICT');
});

test('overflowing reversal arithmetic cannot serialize a non-finite counted quantity', t => {
  const f = fixture(t, { quantity: Number.MAX_VALUE }); f.start();
  const legacyCount = state => { f.count(Number.MAX_VALUE)(state); const value = data(state); delete value.countDraft.items[0].countInput; write(state, value); };
  f.save(legacyCount); f.save(f.sale(Number.MAX_VALUE)); f.save(legacyCount);
  const before = item(f.store.read()), result = f.save(f.reverse());
  assert.equal(Object.hasOwn(result, 'serverGeneratedChanges'), false); assert.deepEqual(item(f.store.read()), before);
  assert.ok(Number.isFinite(item(f.store.read()).countedQuantity));
  assert.throws(() => f.save(f.apply), error => error.status === 409 && error.code === 'DEPENDENCY_CONFLICT');
});

for (const attribute of ['data-tyre-stock-id', 'data-consumable-stock-id']) test('one-time ' + attribute + ' assignment keeps an unchanged reviewed count current for its later sale', t => {
  const f = fixture(t); f.start(); f.save(f.count(10));
  f.save(state => { const value = data(state); value.countDraft.status = 'review'; write(state, value); });
  const base = f.store.read(), counted = item(base), key = countKey(base);
  const result = f.save(state => { rowFor(state).a[attribute] = 'stock-lookup-' + randomUUID(); });
  const saved = f.store.read();
  assert.equal(result.serverGeneratedChanges, true); assert.equal(Object.hasOwn(result.versions, key), false); assert.deepEqual(item(saved), counted);
  assert.equal(data(saved.state).countDraft.baseStockVersions[stockKey('tyre')], result.revision);
  f.save(f.sale(4)); assert.equal(item(f.store.read()).countedQuantity, 6); f.save(f.apply);
  assert.equal(Number(rowFor(f.store.read().state).a['data-quantity']), 6);
});

test('passive lookup assignment can update the unchanged article baseline alongside an unrelated count edit', t => {
  const f = fixture(t); f.start(); f.save(f.count(12));
  const result = f.save(state => { rowFor(state).a['data-tyre-stock-id'] = 'tyre-lookup'; f.count(20, 'other')(state); });
  assert.equal(result.serverGeneratedChanges, true); assert.equal(item(f.store.read(), 'other').countedQuantity, 20);
  f.save(f.sale(4)); assert.equal(item(f.store.read()).countedQuantity, 8);
});

for (const reason of ['existing ID replacement', 'history change', 'other attribute', 'same item count edit', 'stale ABA base']) test('lookup assignment never bypasses ' + reason, t => {
  const f = fixture(t); f.start(); f.save(f.count(12));
  if (reason === 'existing ID replacement') f.save(state => { rowFor(state).a['data-tyre-stock-id'] = 'original'; });
  if (reason === 'stale ABA base') { f.save(state => setQuantity(rowFor(state), 11)); f.save(state => setQuantity(rowFor(state), 12)); }
  const baseline = data(f.store.read().state).countDraft.baseStockVersions[stockKey('tyre')];
  const result = f.save(state => {
    const row = rowFor(state); row.a['data-tyre-stock-id'] = 'new-lookup';
    if (reason === 'history change') row.a['data-dio-history'] = JSON.stringify(Dio.upsert(Dio.parseLedger(row.a['data-dio-history']), { id: 'manual', at: at + 1000, kind: 'adjustment', delta: 0 }));
    if (reason === 'other attribute') row.a['data-location'] = 'other';
    if (reason === 'same item count edit') f.count(11)(state);
  });
  assert.equal(Object.hasOwn(result, 'serverGeneratedChanges'), false);
  assert.equal(data(f.store.read().state).countDraft.baseStockVersions[stockKey('tyre')], baseline);
});

for (const input of ['10,', 'abc', '11']) test('sale does not reinterpret an incomplete or mismatching count input: ' + input, t => {
  const f = fixture(t); f.start(); f.save(f.count(12));
  f.save(state => { const value = data(state); value.countDraft.items[0].countInput = input; write(state, value); });
  const counted = item(f.store.read());
  const passive = f.save(state => { rowFor(state).a['data-tyre-stock-id'] = 'lookup'; });
  assert.equal(passive.serverGeneratedChanges, true); assert.deepEqual(item(f.store.read()), counted);
  const result = f.save(f.sale(4)); assert.equal(Object.hasOwn(result, 'serverGeneratedChanges'), false); assert.deepEqual(item(f.store.read()), counted);
});

test('consumption exceeding the saved physical count is visible and requires recount before application', t => {
  const f = fixture(t); f.start(); f.save(f.count(2)); const base = f.store.read(), result = f.save(f.sale(4)), saved = f.store.read();
  assert.equal(result.serverGeneratedChanges, true); assert.equal(item(saved).countedQuantity, 0); assert.equal(item(saved).needsRecount, true);
  assert.equal(data(saved.state).countDraft.baseStockVersions[stockKey('tyre')], base.versions[stockKey('tyre')]);
  assert.throws(() => f.save(f.apply), error => error.status === 409 && error.code === 'DEPENDENCY_CONFLICT');
});

for (const kind of ['no sale history', 'adjustment', 'receipt', 'revalue', 'identity']) test('does not infer a counted sale for ' + kind, t => {
  const f = fixture(t); f.start(); f.save(f.count(12)); const before = item(f.store.read());
  const result = f.save(state => {
    const row = rowFor(state);
    if (kind === 'no sale history') { setQuantity(row, 8); return; }
    f.sale(4)(state);
    if (kind === 'identity') row.c[0].c = ['Renamed product'];
    else {
      const ledger = Dio.parseLedger(row.a['data-dio-history']);
      const event = kind === 'adjustment' ? { id: 'manual', at: at + 2000, kind, delta: -1 }
        : kind === 'receipt' ? { id: 'load', at: at + 2000, kind, quantity: 1, unitCost: 12 }
          : { id: 'price', at: at + 2000, kind, unitCost: 12 };
      row.a['data-dio-history'] = JSON.stringify(Dio.upsert(ledger, event));
      if (kind !== 'revalue') setQuantity(row, kind === 'adjustment' ? 7 : 9);
    }
  });
  assert.equal(Object.hasOwn(result, 'serverGeneratedChanges'), false); assert.deepEqual(item(f.store.read()), before);
});

test('a previously stale or flagged count is never repaired by guessing a later sale', t => {
  const f = fixture(t); f.start(); f.save(f.count(12));
  f.save(state => setQuantity(rowFor(state), 11)); const stale = item(f.store.read());
  assert.equal(Object.hasOwn(f.save(f.sale(2)), 'serverGeneratedChanges'), false); assert.deepEqual(item(f.store.read()), stale);
  const current = f.store.read();
  f.save(state => { const value = data(state), target = value.countDraft.items[0]; target.expectedQuantity = 9; target.needsRecount = true; write(state, value); }, current);
  const flagged = item(f.store.read()); assert.equal(Object.hasOwn(f.save(f.sale(1, 'sale:tyre:agenda:another')), 'serverGeneratedChanges'), false); assert.deepEqual(item(f.store.read()), flagged);
});

test('newly created and already applied drafts are not changed by the sale adjustment hook', t => {
  const f = fixture(t); f.start(); f.save(f.count(12)); f.save(f.apply); const applied = item(f.store.read());
  assert.equal(Object.hasOwn(f.save(f.sale(3)), 'serverGeneratedChanges'), false); assert.deepEqual(item(f.store.read()), applied);
  f.start(); assert.equal(item(f.store.read()).countedQuantity, 0);
});

test('a newly created counted draft in the sale proposal has no unambiguous earlier count to adjust', t => {
  const f = fixture(t), base = f.store.read();
  const result = f.save(state => {
    write(state, { ...data(state), countDraft: {
      id: randomUUID(), status: 'counting', startedAt: new Date(at).toISOString(), baseInventoryVersion: base.versions['domain:inventory'],
      baseStockVersions: Object.fromEntries(state.dom['#stockRows'].map(row => [stockKey(row.a['data-cloud-id']), base.versions[stockKey(row.a['data-cloud-id'])]])),
      items: state.dom['#stockRows'].map(row => ({ cloudId: row.a['data-cloud-id'], product: 'Product ' + row.a['data-cloud-id'], category: 'Categoria', unit: row.a['data-unit'], expectedQuantity: Number(row.a['data-quantity']), countedQuantity: Number(row.a['data-quantity']), counted: true, countInput: row.a['data-quantity'] }))
    } });
    f.sale(4)(state);
  }, base);
  assert.equal(Object.hasOwn(result, 'serverGeneratedChanges'), false); assert.equal(item(f.store.read()).countedQuantity, 12);
  assert.throws(() => f.save(f.apply), error => error.status === 409 && error.code === 'DEPENDENCY_CONFLICT');
});

test('a concurrent save on the same counted article stays fenced while unrelated counts can proceed', t => {
  const f = fixture(t); f.start(); f.save(f.count(12)); const base = f.store.read();
  const count = f.operation(f.count(11), base), other = f.operation(f.count(20, 'other'), base);
  f.save(f.sale(4), base); assert.throws(() => f.store.commit(f.auth, count), error => error.status === 409 && error.code === 'RECORD_CONFLICT');
  f.store.commit(f.auth, other); assert.equal(item(f.store.read(), 'other').countedQuantity, 20); assert.equal(item(f.store.read()).countedQuantity, 8);
  f.save(f.apply); assert.equal(Number(rowFor(f.store.read().state).a['data-quantity']), 8);
});

test('count saved before a concurrent sale is the count the server adjusts', t => {
  const f = fixture(t); f.start(); f.save(f.count(12)); const base = f.store.read(), sale = f.operation(f.sale(4), base);
  f.save(f.count(11), base); const result = f.store.commit(f.auth, sale); assert.equal(result.serverGeneratedChanges, true); assert.equal(item(f.store.read()).countedQuantity, 7);
});

test('counting and selling the same article in a single client proposal is not silently reinterpreted', t => {
  const f = fixture(t); f.start(); f.save(f.count(12));
  const result = f.save(state => { f.count(9)(state); f.sale(4)(state); });
  assert.equal(Object.hasOwn(result, 'serverGeneratedChanges'), false); assert.equal(item(f.store.read()).countedQuantity, 9);
  assert.throws(() => f.save(f.apply), error => error.status === 409 && error.code === 'DEPENDENCY_CONFLICT');
});

test('validation of the generated state and a receipt failure both roll back stock, counts, versions and audit', t => {
  let reject = false;
  const f = fixture(t, { validateCommit(state) { if (reject && data(state).countDraft.items[0].countedQuantity === 8) throw new HttpError(400, 'TEST', 'generated count rejected'); } });
  f.start(); f.save(f.count(12)); const before = f.store.read(), auditCount = f.db.prepare('SELECT count(*) AS n FROM audit').get().n;
  const operation = f.operation(f.sale(4)); reject = true;
  assert.throws(() => f.store.commit(f.auth, operation), error => error.status === 400 && error.code === 'TEST'); assert.deepEqual(f.store.read(), before);
  reject = false; f.db.exec("CREATE TRIGGER sales_failure BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END;");
  assert.throws(() => f.store.commit(f.auth, operation), /injected receipt failure/); assert.deepEqual(f.store.read(), before);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM audit').get().n, auditCount);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM receipts WHERE mutation_id=?').get(operation.mutationId).n, 0);
});
