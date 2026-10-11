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

const require = createRequire(import.meta.url);
const R = require('../cloud-records.js'), schema = require('../cloud-schema.js');
const cashName = 'ma-gomme-cashbook-v1';
const accountId = 'cash-00000000-0000-4000-8000-000000000001';
const td = value => ({ t: 'td', a: {}, c: [value] });
const job = (status = 'IN LAVORAZIONE') => ({
  t: 'tr', a: { 'data-cloud-id': 'shared-work', 'data-cash-account-id': accountId, 'data-ledger-key': 'same-work', 'data-date': '2026-10-04', 'data-cash-destination': 'outside' },
  c: [td('09:00'), td('Cliente Test'), td('AB123CD'), td('Diagnosi'), td('€ 100,00'), td({ t: 'select', a: { class: 'status-select' }, c: [{ t: 'option', a: { selected: '', value: status }, c: [status] }] })]
});
const book = state => JSON.parse(state.storage[cashName]);
const writeBook = (state, value) => { state.storage[cashName] = JSON.stringify(value); };
const deposit = (id = 'deposit-one', cents = 2000) => ({ id, kind: 'deposit', accountId, date: '2026-10-04', time: '09:00', cents, days: 0, meta: { customer: 'Cliente Test', vehicle: 'AB123CD', work: 'Diagnosi' } });

function fixture(t, status = 'IN LAVORAZIONE') {
  const directory = mkdtempSync(join(tmpdir(), 'officina-finance-test-')), db = openDatabase(directory);
  const store = recordStore(db, makeStateValidator(schema), Date.now);
  const auth = { role: 'operator', username: 'Test', sessionId: randomUUID() }, clientId = randomUUID();
  t.after(() => {
    db.close();
    const absolute = resolve(directory);
    assert.ok(absolute.startsWith(resolve(tmpdir()) + sep) && basename(absolute).startsWith('officina-finance-test-'));
    rmSync(absolute, { recursive: true, force: true });
  });
  const operation = (base, update) => {
    const state = structuredClone(base.state || R.empty()); update(state);
    return { protocol: 2, clientId, mutationId: randomUUID(), versions: base.versions, changes: R.diff(base.state, state, base.versions) };
  };
  const save = (update, base = store.read()) => store.commit(auth, operation(base, update));
  save(state => {
    state.dom['#agendaRows'] = [job(status)];
    state.dom['#stockRows'] = [{ t: 'tr', a: { 'data-cloud-id': 'stock-one', 'data-quantity': '12', 'data-unit': 'pz' }, c: [td('Pneumatico'), td('Pneumatici'), td('12')] }];
    writeBook(state, { version: 1, nextId: 1, accounts: [{ id: accountId, status, meta: { source: 'agenda', amount: 100, customer: 'Cliente Test', vehicle: 'AB123CD', date: '2026-10-04', work: 'Diagnosi' }, state: { outside: 100, inCash: 0, profit: 20, lastEdited: 'outside' } }], payments: [] });
  });
  return { db, store, auth, operation, save };
}

// A move keeps the work's cash identity; only its container and metadata change.
const transfer = (state, updateAccount = true) => {
  const source = state.dom['#agendaRows'][0];
  const target = { t: 'div', a: { ...source.a, class: 'parking-row', 'data-entry': '2026-10-04' }, c: [
    { t: 'div', a: {}, c: [{ t: 'b', a: {}, c: ['Cliente Test'] }, { t: 'small', a: {}, c: ['AB123CD'] }] },
    { t: 'select', a: { class: 'parking-status' }, c: structuredClone(source.c[5].c[0].c) }
  ] };
  state.dom['#agendaRows'] = [];
  state.dom['#agenda .parking-section .card'] = [target];
  if (updateAccount) {
    const data = book(state); data.accounts[0].meta.source = 'parking'; writeBook(state, data);
  }
};
const rejects = (action, code) => assert.throws(action, error => error.status === 409 && error.code === code);

test('a concurrent deposit fences source unlinking even when transfer does not rewrite the cash account', t => {
  const f = fixture(t), base = f.store.read();
  const move = f.operation(base, state => transfer(state, false));
  f.save(state => { const data = book(state); data.payments.push(deposit()); writeBook(state, data); }, base);
  const afterDeposit = f.store.read();
  rejects(() => f.store.commit(f.auth, move), 'DEPENDENCY_CONFLICT');
  assert.deepEqual(f.store.read(), afterDeposit);
  assert.equal(afterDeposit.state.dom['#agendaRows'].length, 1);
  assert.equal(afterDeposit.state.dom['#agenda .parking-section .card'].length, 0);
  assert.equal(book(afterDeposit.state).payments[0].cents, 2000);
});

test('a transfer fences a stale deposit and stale edits to the removed source without partial payments or rows', t => {
  const f = fixture(t), base = f.store.read();
  const payment = f.operation(base, state => { const data = book(state); data.payments.push(deposit()); writeBook(state, data); });
  const sourceEdit = f.operation(base, state => { state.dom['#agendaRows'][0].c[4] = td('€ 150,00'); });
  f.save(state => transfer(state, false), base);
  const moved = f.store.read();
  rejects(() => f.store.commit(f.auth, payment), 'DEPENDENCY_CONFLICT');
  rejects(() => f.store.commit(f.auth, sourceEdit), 'RECORD_CONFLICT');
  assert.deepEqual(f.store.read(), moved);
  assert.equal(book(moved.state).payments.length, 0);
  assert.equal(moved.state.dom['#agenda .parking-section .card'][0].a['data-cash-account-id'], accountId);
  assert.equal(moved.versions[R.key('cash', 'accounts', accountId)], moved.revision);
});

test('transfer and deposit receipt replay preserve one account, original payment IDs and unchanged stock', t => {
  const f = fixture(t);
  const depositOperation = f.operation(f.store.read(), state => { const data = book(state); data.payments.push(deposit()); writeBook(state, data); });
  const depositResult = f.store.commit(f.auth, depositOperation);
  assert.equal(f.store.commit(f.auth, depositOperation).replayed, true);
  assert.equal(f.store.read().revision, depositResult.revision);
  const beforeMove = f.store.read(), move = f.operation(beforeMove, transfer);
  const result = f.store.commit(f.auth, move), moved = f.store.read();
  assert.equal(f.store.commit(f.auth, move).replayed, true);
  assert.deepEqual(f.store.read(), moved);
  assert.equal(result.revision, moved.revision);
  assert.deepEqual(moved.state.dom['#stockRows'], beforeMove.state.dom['#stockRows']);
  assert.equal(moved.state.dom['#agendaRows'].length, 0);
  assert.equal(moved.state.dom['#agenda .parking-section .card'].length, 1);
  const data = book(moved.state);
  assert.equal(data.accounts.length, 1); assert.equal(data.accounts[0].id, accountId);
  assert.equal(data.accounts[0].meta.source, 'parking');
  assert.deepEqual(data.payments, book(beforeMove.state).payments);
  assert.equal(data.payments[0].id, 'deposit-one');
  assert.equal(moved.versions['domain:inventory'], beforeMove.versions['domain:inventory']);
});

test('a completed transfer rejects a stock race and atomically leaves its source, account and payment unchanged', t => {
  const f = fixture(t, 'COMPLETATO');
  f.save(state => { state.dom['#agendaRows'][0].a['data-agenda-tyre-deductions'] = JSON.stringify([{ stockId: 'stock-one', requested: 2, quantity: 2 }]); const data = book(state); data.payments.push(deposit()); writeBook(state, data); });
  const base = f.store.read(), move = f.operation(base, transfer);
  f.save(state => { state.dom['#stockRows'][0].a['data-quantity'] = '10'; state.dom['#stockRows'][0].c[2] = td('10'); }, base);
  const changedStock = f.store.read();
  rejects(() => f.store.commit(f.auth, move), 'DEPENDENCY_CONFLICT');
  assert.deepEqual(f.store.read(), changedStock);
  assert.equal(changedStock.state.dom['#agendaRows'].length, 1);
  assert.equal(changedStock.state.dom['#agenda .parking-section .card'].length, 0);
  assert.equal(book(changedStock.state).accounts[0].meta.source, 'agenda');
  assert.equal(book(changedStock.state).payments[0].id, 'deposit-one');
});

test('deposit deletion is atomic, fences a concurrent receipt and replays without deleting another deposit', t => {
  const f = fixture(t);
  f.save(state => { const data = book(state); data.payments.push(deposit()); data.accounts[0].state.outside = 80; writeBook(state, data); });
  const base = f.store.read();
  const remove = state => {
    const data = book(state), payment = data.payments.find(p => p.id === 'deposit-one');
    data.payments = data.payments.filter(p => p.id !== payment.id);
    data.accounts[0].state.outside += payment.cents / 100;
    data.accounts[0].preserveReceipts = true; writeBook(state, data);
  };
  const staleDeletion = f.operation(base, remove);
  f.save(state => { const data = book(state); data.payments.push(deposit('deposit-two', 1000)); data.accounts[0].state.outside = 70; writeBook(state, data); }, base);
  const newer = f.store.read();
  assert.throws(() => f.store.commit(f.auth, staleDeletion), error => error.status === 409);
  assert.deepEqual(f.store.read(), newer);
  const deletion = f.operation(newer, remove), result = f.store.commit(f.auth, deletion), saved = f.store.read();
  assert.deepEqual(book(saved.state).payments.map(p => p.id), ['deposit-two']);
  assert.equal(book(saved.state).accounts[0].state.outside, 90);
  assert.equal(book(saved.state).accounts[0].meta.amount, 100);
  assert.equal(book(saved.state).accounts[0].state.profit, 20);
  assert.deepEqual(saved.state.dom, newer.state.dom);
  assert.equal(saved.versions['domain:inventory'], newer.versions['domain:inventory']);
  assert.equal(f.store.commit(f.auth, deletion).replayed, true);
  assert.equal(f.store.read().revision, result.revision);assert.deepEqual(f.store.read(), saved);
  const other = fixture(t);
  other.save(state => { const data = book(state); data.payments.push(deposit()); data.accounts[0].state.outside = 80; writeBook(state, data); });
  const beforeDeletion = other.store.read();
  const addReceipt = state => { const data = book(state); data.payments.push(deposit('deposit-two', 1000)); data.accounts[0].state.outside -= 10; writeBook(state, data); };
  const staleReceipt = other.operation(beforeDeletion, addReceipt);
  other.save(remove, beforeDeletion);const deleted = other.store.read();
  assert.throws(() => other.store.commit(other.auth, staleReceipt), error => error.status === 409);
  assert.deepEqual(other.store.read(), deleted);assert.deepEqual(book(deleted.state).payments, []);
  assert.equal(book(deleted.state).accounts[0].state.outside, 100);
  const retry = other.operation(deleted, addReceipt), receiptResult = other.store.commit(other.auth, retry);
  assert.deepEqual(book(other.store.read().state).payments.map(p => p.id), ['deposit-two']);
  assert.equal(book(other.store.read().state).accounts[0].state.outside, 90);
  assert.equal(other.store.commit(other.auth, retry).replayed, true);
  assert.equal(other.store.read().revision, receiptResult.revision);
  assert.deepEqual(other.store.read().state.dom, beforeDeletion.state.dom);
});
