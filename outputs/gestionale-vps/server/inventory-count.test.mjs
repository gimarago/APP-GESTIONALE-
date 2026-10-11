import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { openDatabase } from './database.mjs';
import { recordStore } from './records.mjs';
import { makeStateValidator } from './validation.mjs';

const require = createRequire(import.meta.url), R = require('../cloud-records.js'), schema = require('../cloud-schema.js');
const inventoryName = 'officina.inventory.v1';
const td = children => ({ t: 'td', a: {}, c: children });
const stock = (id, value, unit = 'pz') => ({
  t: 'tr', a: { 'data-cloud-id': id, 'data-unit': unit, 'data-quantity': String(value), 'data-minimum': '5' },
  c: [td([{ t: 'b', a: {}, c: ['Product ' + id] }]), td(['Categoria']), td([]), td(['€ 10,00']), td(['Scaffale A']), td(['DISPONIBILE'])]
});
function setQuantity(row, value) {
  row.a['data-quantity'] = String(value);
  row.c[2].c = [{ t: 'span', a: { class: 'qty-adjust' }, c: [
    { t: 'button', a: { type: 'button' }, c: ['−'] },
    { t: 'b', a: {}, c: [value.toLocaleString('it-IT', { maximumFractionDigits: 3 })] },
    { t: 'span', a: { class: 'stock-unit-label' }, c: [row.a['data-unit']] },
    { t: 'button', a: { type: 'button' }, c: ['+'] }
  ] }];
  return row;
}
const inventory = state => JSON.parse(state.storage[inventoryName] || '{}');
const writeInventory = (state, data) => { state.storage[inventoryName] = JSON.stringify(data); };
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'officina-inventory-test-')), db = openDatabase(directory);
  const auth = { role: 'operator', username: 'Counter', sessionId: randomUUID() }, clientId = randomUUID();
  const validator = makeStateValidator(schema);
  let store = recordStore(db, validator, Date.now);
  t.after(() => {
    db.close();
    const absolute = resolve(directory);
    assert.ok(absolute.startsWith(resolve(tmpdir()) + sep) && basename(absolute).startsWith('officina-inventory-test-'));
    rmSync(absolute, { recursive: true, force: true });
  });
  const operation = (base, change) => {
    const next = structuredClone(base.state || R.empty()); change(next);
    return { protocol: 2, clientId, mutationId: randomUUID(), versions: base.versions, changes: R.diff(base.state, next, base.versions) };
  };
  const save = (change, base = store.read()) => store.commit(auth, operation(base, change));
  const seed = rows => save(state => {
    state.dom['#stockRows'] = rows.map(row => setQuantity(row, Number(row.a['data-quantity'])));
    writeInventory(state, { interval: 30, enabled: true, history: [], nextDue: '2026-10-30' });
  });
  const start = () => {
    const base = store.read(), draft = {
      id: randomUUID(), status: 'counting', startedAt: '2026-10-04T09:00:00.000Z', baseInventoryVersion: base.versions['domain:inventory'] || 0,
      baseStockVersions: Object.fromEntries(base.state.dom['#stockRows'].map(row => {
        const key = JSON.stringify(['row', '#stockRows', row.a['data-cloud-id']]); return [key, base.versions[key] || 0];
      })),
      items: base.state.dom['#stockRows'].map(row => ({
        cloudId: row.a['data-cloud-id'], product: row.c[0].c[0].c[0], category: 'Categoria', unit: row.a['data-unit'],
        expectedQuantity: Number(row.a['data-quantity']), countedQuantity: 0
      }))
    };
    save(state => writeInventory(state, { ...inventory(state), countDraft: draft }), base);
    return draft;
  };
  const review = quantities => save(state => {
    const data = inventory(state); data.countDraft.status = 'review';
    for (const item of data.countDraft.items) if (Object.hasOwn(quantities, item.cloudId)) item.countedQuantity = quantities[item.cloudId];
    writeInventory(state, data);
  });
  const apply = state => {
    const data = inventory(state), draft = data.countDraft;
    draft.status = 'applied'; draft.appliedAt = '2026-10-04T09:30:00.000Z';
    data.history = [...data.history, '2026-10-04']; data.nextDue = '2026-11-03';
    for (const item of draft.items) {
      if (item.isNew) {
        const data = item.stock, row = stock(item.cloudId, 0, data.unit);
        row.c[0].c[0].c = [data.product]; row.c[1].c = [data.category]; row.c[3].c = [data.price === null ? '€ —' : '€ ' + data.price.toLocaleString('it-IT', {minimumFractionDigits:2,maximumFractionDigits:2})]; row.c[4].c = [data.location || '—'];
        row.a['data-unit-profit'] = String(data.unitProfit); row.a['data-minimum'] = String(data.minimum); state.dom['#stockRows'].push(row);
      }
      setQuantity(state.dom['#stockRows'].find(row => row.a['data-cloud-id'] === item.cloudId), item.countedQuantity);
    }
    writeInventory(state, data);
  };
  return { db, auth, get store() { return store; }, operation, save, seed, start, review, apply, restart() { store = recordStore(db, validator, Date.now); } };
}
const fails = (action, status, code) => assert.throws(action, error => error.status === status && error.code === code);

test('count drafts start at zero and atomically replace every quantity with unit precision and calendar history', t => {
  const f = fixture(t);
  f.seed([stock('pieces', 1000), stock('litres', 1234.5, 'lt'), stock('kilos', 1.234, 'kg'), stock('metres', 1.25, 'm'), stock('grams', 900, 'g')]);
  const original = f.store.read(), domain = original.versions['domain:inventory'];
  f.start();
  const counting = f.store.read();
  assert.deepEqual(counting.state.dom['#stockRows'], original.state.dom['#stockRows']);
  assert.ok(inventory(counting.state).countDraft.items.every(item => item.countedQuantity === 0));
  f.review({ pieces: 1200, litres: 1001.5, kilos: 0.125, metres: 3.42 });
  assert.equal(f.store.read().versions['domain:inventory'], domain);
  const result = f.save(f.apply), applied = f.store.read(), data = inventory(applied.state);
  assert.deepEqual(applied.state.dom['#stockRows'].map(row => Number(row.a['data-quantity'])), [1200, 1001.5, 0.125, 3.42, 0]);
  for (const row of applied.state.dom['#stockRows']) {
    assert.equal(row.a['data-minimum'], '5');
    assert.deepEqual(row.c[3], td(['€ 10,00'])); assert.deepEqual(row.c[4], td(['Scaffale A']));
  }
  assert.equal(data.countDraft.status, 'applied'); assert.deepEqual(data.history, ['2026-10-04']); assert.equal(data.nextDue, '2026-11-03');
  assert.equal(data.countDraft.baseInventoryVersion, domain);
  assert.equal(result.inventoryVersion, applied.revision); assert.equal(applied.versions[R.key('storage', inventoryName)], applied.revision);
});

test('different operators can save different counted stock rows concurrently and each sees both values', t => {
  const f = fixture(t); f.seed([stock('tyre', 12), stock('oil', 5, 'lt')]); f.start();
  const base = f.store.read(), baseState = structuredClone(base.state);
  const change = (id, value) => {
    const next = structuredClone(baseState), data = inventory(next); const item = data.countDraft.items.find(row => row.cloudId === id);
    item.countedQuantity = value; item.countInput = String(value); item.counted = true; writeInventory(next, data); return next;
  };
  const left = f.operation(base, state => Object.assign(state, change('tyre', 9)));
  const right = f.operation(base, state => Object.assign(state, change('oil', 2.5)));
  const leftKeys = left.changes.map(item => item.key), rightKeys = right.changes.map(item => item.key);
  assert.deepEqual(leftKeys, [JSON.stringify(['inventory-count-item', inventory(base.state).countDraft.id, 'tyre'])]);
  assert.deepEqual(rightKeys, [JSON.stringify(['inventory-count-item', inventory(base.state).countDraft.id, 'oil'])]);
  f.store.commit(f.auth, left); f.store.commit(f.auth, right);
  const saved = inventory(f.store.read().state).countDraft;
  assert.deepEqual(saved.items.map(item => item.countedQuantity), [9, 2.5]);
  assert.deepEqual(R.inflate(R.flatten(f.store.read().state)), f.store.read().state);
});

test('concurrent edits to the same counted stock row still raise a precise conflict', t => {
  const f = fixture(t); f.seed([stock('tyre', 12), stock('oil', 5, 'lt')]); f.start();
  const base = f.store.read(), initial = structuredClone(base.state);
  const change = value => f.operation(base, state => {
    const data = inventory(state); const item = data.countDraft.items.find(row => row.cloudId === 'tyre');
    item.countedQuantity = value; item.countInput = String(value); item.counted = true; writeInventory(state, data);
  });
  f.store.commit(f.auth, change(9));
  fails(() => f.store.commit(f.auth, change(8)), 409, 'RECORD_CONFLICT');
  assert.equal(inventory(f.store.read().state).countDraft.items[0].countedQuantity, 9);
  assert.notDeepEqual(initial, f.store.read().state);
});

const newItem = () => ({cloudId:randomUUID(), isNew:true, product:'Olio inventario', category:'Lubrificanti', unit:'lt', expectedQuantity:0, countedQuantity:2.5, counted:true, countInput:'2,5', stock:{product:'Olio inventario', category:'Lubrificanti', unit:'lt', price:14.25, unitProfit:2.5, location:'B-2', minimum:3}});
const addDraftItem = (f, item) => f.save(state => {const data=inventory(state);data.countDraft.items.push(item);writeInventory(state,data);});

test('new stock stays in the shared draft through restart then is atomically inserted with counted quantities', t => {
  const f=fixture(t);f.seed([stock('existing',12)]);f.start();const before=f.store.read(), item=newItem();
  addDraftItem(f,item);
  assert.deepEqual(f.store.read().state.dom,before.state.dom);assert.equal(f.store.read().versions['domain:inventory'],before.versions['domain:inventory']);
  f.restart();assert.deepEqual(inventory(f.store.read().state).countDraft.items.at(-1),item);
  f.review({existing:9});const pending=f.operation(f.store.read(),f.apply), result=f.store.commit(f.auth,pending), state=f.store.read();
  assert.deepEqual(state.state.dom['#stockRows'].map(row=>Number(row.a['data-quantity'])),[9,2.5]);
  const added=state.state.dom['#stockRows'][1];assert.equal(added.a['data-cloud-id'],item.cloudId);assert.equal(added.a['data-unit-profit'],'2.5');assert.equal(added.a['data-minimum'],'3');
  assert.deepEqual(added.c[3].c,['€ 14,25']);assert.deepEqual(added.c[4].c,['B-2']);assert.equal(inventory(state.state).countDraft.status,'applied');
  f.restart();assert.equal(f.store.commit(f.auth,pending).replayed,true);assert.equal(f.store.read().revision,result.revision);assert.equal(f.store.read().state.dom['#stockRows'].length,2);
});

test('new stock metadata and captured rows cannot be forged during count or application', t => {
  const f=fixture(t);f.seed([stock('existing',12)]);f.start();const item=newItem();addDraftItem(f,item);const saved=f.store.read();
  for(const corrupt of [data=>data.countDraft.items.shift(),data=>data.countDraft.items[0].isNew=true,data=>data.countDraft.items[1].stock.price=15,data=>data.countDraft.items[1].expectedQuantity=1,data=>data.countDraft.items[1].stock.unknown='field']) {
    fails(()=>f.save(state=>{const data=inventory(state);corrupt(data);writeInventory(state,data);}),400,'INVENTORY_COUNT');assert.deepEqual(f.store.read(),saved);
  }
  f.review({existing:9});const review=f.store.read();
  for(const corrupt of [row=>row.c[0].c[0].c=['Other product'],row=>row.c[1].c=['Ricambi'],row=>row.c[3].c=['€ 30,00'],row=>row.a['data-unit-profit']='9',row=>row.a['data-minimum']='9',row=>row.c[4].c=['Other shelf']]) {
    fails(()=>f.save(state=>{f.apply(state);corrupt(state.dom['#stockRows'][1]);}),400,'INVENTORY_COUNT');assert.deepEqual(f.store.read(),review);
  }
});

test('new count items never bypass stock races and failed application cannot partially create them', t => {
  const f=fixture(t);f.seed([stock('existing',12)]);f.start();const item=newItem();addDraftItem(f,item);f.review({existing:9});
  const pending=f.operation(f.store.read(),f.apply);f.db.exec("CREATE TRIGGER new_count_failure BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT,'injected new item failure'); END;");
  const original=f.store.read();assert.throws(()=>f.store.commit(f.auth,pending),/injected new item failure/);assert.deepEqual(f.store.read(),original);f.db.exec('DROP TRIGGER new_count_failure');
  f.save(state=>setQuantity(state.dom['#stockRows'][0],11));const fresh=f.store.read();
  fails(()=>f.save(f.apply,fresh),409,'DEPENDENCY_CONFLICT');assert.deepEqual(f.store.read(),fresh);assert.equal(f.store.read().state.dom['#stockRows'].length,1);
  assert.equal(inventory(f.store.read().state).countDraft.items.at(-1).cloudId,item.cloudId);
});

test('a live baseline update for one stock allows counts on other items to apply without an inventory-wide conflict', t => {
  const f = fixture(t); f.seed([stock('tyre', 12), stock('oil', 5, 'lt')]); f.start();
  f.save(state => setQuantity(state.dom['#stockRows'].find(row => row.a['data-cloud-id'] === 'oil'), 6));
  const latest = f.store.read(), key = JSON.stringify(['row', '#stockRows', 'oil']);
  f.save(state => {
    const data = inventory(state), item = data.countDraft.items.find(value => value.cloudId === 'oil');
    item.expectedQuantity = 6; data.countDraft.baseStockVersions[key] = latest.versions[key]; writeInventory(state, data);
  }, latest);
  f.review({ tyre: 10, oil: 4.5 }); f.save(f.apply);
  assert.deepEqual(f.store.read().state.dom['#stockRows'].map(row => Number(row.a['data-quantity'])), [10, 4.5]);
});

test('calendar and count metadata do not fence an intervention against unchanged stock', t => {
  const f = fixture(t); f.seed([stock('tyre', 12)]);
  const base = f.store.read(), domain = base.versions['domain:inventory'];
  f.start(); f.review({ tyre: 12 });
  f.save(state => { const data = inventory(state); data.interval = 60; data.nextDue = '2026-12-03'; writeInventory(state, data); });
  const beforeCompletion = f.store.read();
  assert.equal(beforeCompletion.versions['domain:inventory'], domain);
  assert.notEqual(beforeCompletion.versions[R.key('storage', inventoryName)], base.versions[R.key('storage', inventoryName)]);
  f.save(state => state.dom['#agendaRows'].push({ t: 'tr', a: { 'data-cloud-id': 'job' }, c: [td(['COMPLETATO'])] }), base);
  assert.equal(f.store.read().state.dom['#agendaRows'].length, 1);
  f.save(f.apply);
  assert.equal(f.store.read().versions['domain:inventory'], domain, 'An unchanged replacement does not invent a stock mutation.');
});

test('upgrade recovers a legacy count invalidated only by draft metadata without losing quantities', t => {
  const f = fixture(t); f.seed([stock('tyre', 12), stock('oil', 5, 'lt')]); f.start(); f.review({tyre:9,oil:1.5});
  const before=f.store.read(), raw=inventory(before.state).countDraft;
  f.db.prepare("UPDATE record_versions SET revision=? WHERE key='domain:inventory'").run(before.revision);
  f.db.prepare("DELETE FROM metadata WHERE key='inventory-count-protocol'").run();
  f.restart();
  const restored=f.store.read(), draft=inventory(restored.state).countDraft;
  assert.equal(restored.revision,before.revision+1);
  assert.deepEqual(draft,{...raw,baseInventoryVersion:before.revision});
  assert.deepEqual(restored.state.dom,before.state.dom);
  assert.equal(restored.versions['domain:inventory'],before.revision);
  const storageVersion=restored.versions[R.key('storage',inventoryName)];
  f.restart(); assert.equal(f.store.read().revision,restored.revision);
  assert.equal(f.store.read().versions[R.key('storage',inventoryName)],storageVersion);
  f.save(f.apply);
  assert.deepEqual(f.store.read().state.dom['#stockRows'].map(row=>Number(row.a['data-quantity'])),[9,1.5]);
});

for(const reason of ['stock ABA','audit gap'])test(reason==='stock ABA'?'upgrade preserves a blocked legacy count when stock history shows an ABA race':'per-stock versions keep a legacy count safe despite a gap in unrelated inventory audit history', t => {
  const f=fixture(t); f.seed([stock('tyre',12)]); f.start(); f.review({tyre:9});
  if(reason==='stock ABA') {f.save(state=>setQuantity(state.dom['#stockRows'][0],11));f.save(state=>setQuantity(state.dom['#stockRows'][0],12));}
  else f.db.prepare("DELETE FROM audit WHERE action='records-saved' AND revision=2").run();
  const before=f.store.read();
  f.db.prepare("UPDATE record_versions SET revision=? WHERE key='domain:inventory'").run(before.revision);
  f.db.prepare("DELETE FROM metadata WHERE key='inventory-count-protocol'").run();
  f.restart();assert.equal(f.store.read().revision,before.revision);
  assert.deepEqual(f.store.read().state,before.state);
  if(reason==='stock ABA') fails(()=>f.save(f.apply),409,'DEPENDENCY_CONFLICT');
  else { f.save(f.apply); assert.equal(Number(f.store.read().state.dom['#stockRows'][0].a['data-quantity']),9); }
});

for (const race of ['add', 'change', 'delete', 'ABA']) test(`a ${race} stock race cannot be hidden by adopting fresh record versions`, t => {
  const f = fixture(t); f.seed([stock('tyre', 12), stock('oil', 5, 'lt')]); f.start(); f.review({ tyre: 10, oil: 0 });
  f.save(state => {
    if (race === 'add') state.dom['#stockRows'].push(setQuantity(stock('new', 4), 4));
    else if (race === 'delete') state.dom['#stockRows'].pop();
    else setQuantity(state.dom['#stockRows'][0], 11);
  });
  if (race === 'ABA') f.save(state => setQuantity(state.dom['#stockRows'][0], 12));
  const fresh = f.store.read();
  const pending = f.operation(fresh, state => {
    // For deleted products, prepare the same attempted replacement a stale UI
    // could submit after refreshing only its optimistic versions.
    if (race === 'delete') state.dom['#stockRows'].push(setQuantity(stock('oil', 5, 'lt'), 5));
    f.apply(state);
  });
  fails(() => f.store.commit(f.auth, pending), 409, 'DEPENDENCY_CONFLICT');
  assert.deepEqual(f.store.read(), fresh);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM receipts WHERE mutation_id=?').get(pending.mutationId).n, 0);
});

test('a storage-only completion marker cannot skip mismatching live quantities', t => {
  const f = fixture(t); f.seed([stock('tyre', 12)]); f.start(); f.review({ tyre: 10 });
  const before = f.store.read();
  fails(() => f.save(state => { const data = inventory(state); data.countDraft.status = 'applied'; writeInventory(state, data); }), 400, 'INVENTORY_COUNT');
  assert.deepEqual(f.store.read(), before);
});

test('replacement rejects inconsistent visible quantities, missing products, changed units and forged baselines', t => {
  const f = fixture(t); f.seed([stock('tyre', 12), stock('oil', 5, 'lt')]); f.start(); f.review({ tyre: 10, oil: 1.5 });
  const before = f.store.read();
  for (const corrupt of [
    state => { state.dom['#stockRows'][0].c[2].c[0].c[1].c = ['99']; },
    state => { state.dom['#stockRows'][0].a['data-quantity'] = '99'; },
    state => { state.dom['#stockRows'][0].a['data-quantity'] = ''; },
    state => { state.dom['#stockRows'].pop(); },
    state => { state.dom['#stockRows'][1].a['data-unit'] = 'kg'; },
    state => { const data = inventory(state); data.countDraft.baseInventoryVersion++; writeInventory(state, data); },
    state => { const data = inventory(state); data.countDraft.items[0].expectedQuantity = 20; writeInventory(state, data); },
    state => { const data = inventory(state); data.countDraft.items[0].countedQuantity = 1.5; writeInventory(state, data); }
  ]) {
    fails(() => f.save(state => { f.apply(state); corrupt(state); }), 400, 'INVENTORY_COUNT');
    assert.deepEqual(f.store.read(), before);
  }
});

test('a count must be stored before application and cannot mutate its completed report', t => {
  const f = fixture(t); f.seed([stock('tyre', 0)]);
  const seed = f.store.read();
  fails(() => f.save(state => writeInventory(state, { countDraft: { id: randomUUID(), status: 'applied', baseInventoryVersion: seed.versions['domain:inventory'], items: [] } })), 400, 'INVENTORY_COUNT');
  assert.deepEqual(f.store.read(), seed);
  f.start(); f.save(f.apply);
  const applied = f.store.read();
  fails(() => f.save(state => { const data = inventory(state); data.countDraft.items[0].countedQuantity = 1; writeInventory(state, data); }), 400, 'INVENTORY_COUNT');
  assert.deepEqual(f.store.read(), applied);
  f.save(state => { const data = inventory(state); data.enabled = false; writeInventory(state, data); });
  assert.equal(inventory(f.store.read().state).enabled, false);
});

test('retrying an acknowledged count after later stock writes and restart returns the receipt without replaying quantities', t => {
  const f = fixture(t); f.seed([stock('tyre', 12)]); f.start(); f.review({ tyre: 10 });
  const pending = f.operation(f.store.read(), f.apply), first = f.store.commit(f.auth, pending);
  f.save(state => setQuantity(state.dom['#stockRows'][0], 9));
  const latest = f.store.read(); f.restart();
  const replay = f.store.commit(f.auth, pending);
  assert.equal(replay.replayed, true); assert.equal(replay.revision, first.revision);
  assert.deepEqual(f.store.read(), latest);
});

test('receipt failure rolls back count completion, quantities, versions and audit together', t => {
  const f = fixture(t); f.seed([stock('tyre', 12)]); f.start(); f.review({ tyre: 10 });
  const before = f.store.read(), audits = f.db.prepare('SELECT count(*) AS n FROM audit').get().n;
  const pending = f.operation(before, f.apply);
  f.db.exec("CREATE TRIGGER count_failure BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END;");
  assert.throws(() => f.store.commit(f.auth, pending), /injected receipt failure/);
  assert.deepEqual(f.store.read(), before); assert.equal(f.db.prepare('SELECT count(*) AS n FROM audit').get().n, audits);
  f.db.exec('DROP TRIGGER count_failure');
  f.store.commit(f.auth, pending);
  assert.equal(inventory(f.store.read().state).countDraft.status, 'applied');
});
