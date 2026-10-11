'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');
const parts = require('../parts-recognition.js');

const html = fs.readFileSync(path.join(__dirname, '../officina-fatturazione.html'), 'utf8');
const block = html.indexOf('/* Scarico automatico e prudente dei consumabili');
const start = html.indexOf('  const normal =', block);
const end = html.indexOf('  const materialWasUsed =', start);
assert.ok(block >= 0 && start > block && end > start);
const source = html.slice(start, end);

function fixture({quantity = 10, receipt = null, status = 'COMPLETATO'} = {}) {
  let now = new Date('2026-10-08T12:00:00').getTime();
  const StockDate = class extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
  const stocks = [];
  const writes = [], removed = [];
  const addStock = (product, amount) => {
    const row = {product, quantity: amount, dataset: {consumableStockId: 'oil-' + stocks.length}, cells: [{textContent: product}, {textContent: 'Lubrificanti'}], unit: 'lt'};
    stocks.push(row);
    return row;
  };
  const stock = addStock('Olio Castrol Edge 5W30 LL', quantity);
  const inventory = {
    rows: () => stocks,
    productName: row => row.product,
    unitFor: row => row.unit,
    numberFrom: value => Number(String(value).replace(',', '.')),
    quantize: value => Math.round(Number(value) * 1000) / 1000,
    quantityFor: row => row.quantity,
    unitProfitFor: () => 3,
    setQuantity(row, value, movement) { row.quantity = value; writes.push({id: row.dataset.consumableStockId, value, ...movement}); },
    removeDioSale(row, eventId) { removed.push({id: row.dataset.consumableStockId, eventId}); }
  };
  const window = {WorkshopParts: parts, WorkshopCloud: {applying: false}};
  vm.runInNewContext(source + '\nwindow.testSyncRows=syncRows;', {inventory, window, Date: StockDate});
  const row = {status, dataset: {
    ledgerKey: 'agenda-test', cloudId: 'work-test',
    acceptanceLines: JSON.stringify([{description: '4L 5-30 LL', amount: 80}]),
    ...(receipt ? {agendaConsumableDeductions: JSON.stringify(receipt), dioCompletedDate: '2026-10-06', dioCompletedAt: String(new Date('2026-10-06T12:00:00').getTime())} : {})
  }};
  const sync = () => window.testSyncRows([row], item => item.status === 'COMPLETATO', 'acceptanceLines', 'agendaConsumableDeductions', 'agenda');
  const receiptFor = () => JSON.parse(row.dataset.agendaConsumableDeductions || '[]');
  const edit = description => { row.dataset.acceptanceLines = JSON.stringify([{description, amount: 80}]); };
  return {stock, row, writes, removed, addStock, sync, receiptFor, edit, advanceDay: () => { now += 86400000; }, now: () => now};
}

const legacyReceipt = () => [{stockId: 'oil-0', requested: 4, quantity: 4, unitProfit: 3}];

test('an unchanged legacy oil receipt survives a newly ambiguous stock catalogue without a reversal', () => {
  const f = fixture({quantity: 6, receipt: legacyReceipt()});
  f.sync();
  const saved = f.row.dataset.agendaConsumableDeductions;
  f.addStock('Olio Castrol Magnatec 5W30 LL', 20);
  f.sync();
  assert.equal(f.stock.quantity, 6);
  assert.equal(f.row.dataset.agendaConsumableDeductions, saved);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.removed, []);
});

test('new receipts retain the work signature and do not replay when another matching oil is added', () => {
  const f = fixture();
  f.sync();
  assert.equal(f.stock.quantity, 6);
  assert.equal(typeof f.receiptFor()[0].requestSignature, 'string');
  const saved = f.row.dataset.agendaConsumableDeductions, writes = f.writes.length;
  f.addStock('Olio Castrol Magnatec 5W30 LL', 20);
  f.sync();
  assert.equal(f.stock.quantity, 6);
  assert.equal(f.row.dataset.agendaConsumableDeductions, saved);
  assert.equal(f.writes.length, writes);
});

test('a real oil quantity edit reverses the prior receipt and consumes the new quantity', () => {
  const f = fixture({quantity: 6, receipt: legacyReceipt()});
  f.sync();
  f.edit('6L 5-30 LL');
  f.sync();
  assert.equal(f.stock.quantity, 4);
  assert.equal(f.receiptFor()[0].requested, 6);
  assert.equal(f.receiptFor()[0].quantity, 6);
  assert.deepEqual(f.writes.map(item => item.kind), ['reversal', 'sale']);
  f.sync();
  assert.equal(f.writes.length, 2, 'repeated sync cannot consume twice');
});

test('reopening a consumed work clears its DIO completion time and later completion uses the new date', () => {
  const f = fixture({quantity: 6, receipt: legacyReceipt()});
  f.sync();
  f.row.status = 'IN LAVORAZIONE';
  f.sync();
  assert.equal(f.stock.quantity, 10);
  assert.deepEqual(f.receiptFor(), []);
  assert.equal(f.row.dataset.dioCompletedDate, '');
  assert.equal(f.row.dataset.dioCompletedAt, '');
  f.advanceDay();
  f.row.status = 'COMPLETATO';
  f.sync();
  assert.equal(f.stock.quantity, 6);
  assert.equal(Number(f.row.dataset.dioCompletedAt), f.now());
});

test('a partial receipt is not silently completed by a later restock', () => {
  const f = fixture({quantity: 2});
  f.sync();
  assert.equal(f.stock.quantity, 0);
  assert.equal(f.receiptFor()[0].quantity, 2);
  assert.equal(f.receiptFor()[0].requested, 4);
  const saved = f.row.dataset.agendaConsumableDeductions;
  f.stock.quantity = 8;
  f.sync();
  assert.equal(f.stock.quantity, 8);
  assert.equal(f.row.dataset.agendaConsumableDeductions, saved);
});

test('an amount-only edit does not replace the original receipt or its purchase-cost history', () => {
  const f = fixture({quantity: 6, receipt: legacyReceipt()});
  f.sync();
  const saved = f.row.dataset.agendaConsumableDeductions;
  f.row.dataset.acceptanceLines = JSON.stringify([{description: '4L 5-30 LL', amount: 120}]);
  f.sync();
  assert.equal(f.row.dataset.agendaConsumableDeductions, saved);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.removed, []);
});
