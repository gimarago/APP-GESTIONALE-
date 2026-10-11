const {test} = require('node:test');
const assert = require('node:assert/strict');
const core = require('../inventory-count.js');

test('physical draft resets every quantity without mutating the source or product metadata', () => {
  const source = [{cloudId:'tyre-1', product:'Pneumatico', category:'Gomme', unit:'pz', expectedQuantity:12}, {cloudId:'oil-1', product:'Olio motore', category:'Fluidi', unit:'lt', expectedQuantity:8.5}];
  const before = structuredClone(source);
  const draft = core.draft(source, 7, 'count-id', '2026-10-04T08:00:00Z');
  assert.deepEqual(source, before);
  assert.deepEqual(draft.items.map(item => item.countedQuantity), [0, 0]);
  assert.deepEqual(draft.items.map(item => item.cloudId), ['tyre-1', 'oil-1']);
  assert.equal(draft.baseInventoryVersion, 7);
  assert.equal(core.validate(draft), true);
  assert.equal(core.active(draft), true);
});

test('pieces and grams require integers while decimal units follow inventory precision', () => {
  assert.equal(core.quantity('1,5', 'pz').value, undefined);
  assert.match(core.quantity('1,5', 'pz').error, /intera/);
  assert.match(core.quantity('1.1', 'g').error, /intera/);
  assert.deepEqual(core.quantity('3,5', 'lt'), {value:3.5, error:null});
  assert.deepEqual(core.quantity('0,125', 'kg'), {value:0.125, error:null});
  assert.deepEqual(core.quantity('2.25', 'm'), {value:2.25, error:null});
  assert.match(core.quantity('3,51', 'lt').error, /1 decimali/);
  for (const input of ['-1','NaN','1abc','1e4','Infinity']) assert.ok(core.quantity(input, 'lt').error);
  assert.deepEqual(core.quantity('', 'pz'), {value:0, error:null});
  assert.deepEqual(core.quantity('2.0', 'pz'), {value:2, error:null});
});

test('resoconto includes unseen products as zero and can be resumed from JSON', () => {
  const draft = core.draft([{cloudId:'stock-1', product:'Pneumatico', category:'Gomme', unit:'pz', expectedQuantity:5}, {cloudId:'stock-2', product:'Olio', category:'Fluidi', unit:'lt', expectedQuantity:10.5}], 11, 'count-id', '2026-10-04');
  draft.items[1].countedQuantity = 3.5; draft.items[1].counted = true; draft.items[1].countInput = '3,5'; draft.status = 'review';
  const resumed = JSON.parse(JSON.stringify(draft)), report = core.summary(resumed);
  assert.equal(core.validate(resumed), true);
  assert.equal(report.entered, 1); assert.equal(report.unentered, 1);
  assert.deepEqual(report.differences.map(item => [item.cloudId, item.countedQuantity, item.difference]), [['stock-1',0,-5],['stock-2',3.5,-7]]);
  resumed.status = 'applied'; assert.equal(core.active(resumed), false);
});

test('corrupt or duplicated stock identities cannot form a resumable draft', () => {
  const draft = core.draft([{cloudId:'stock-1', product:'Scorta', category:'Gomme', unit:'pz', expectedQuantity:2}], 0, 'count-id', '2026-10-04');
  assert.equal(core.validate({...draft, baseInventoryVersion:-1}), false);
  assert.equal(core.validate({...draft, items:[draft.items[0], draft.items[0]]}), false);
  assert.equal(core.validate({...draft, items:[{...draft.items[0], unit:'unknown'}]}), false);
  assert.equal(core.validate({...draft, items:[{...draft.items[0], countedQuantity:Infinity}]}), false);
});

test('new products are temporary count items with preserved metadata and precise quantities', () => {
  const source = [{cloudId:'stock-1', product:'Scorta', category:'Gomme', unit:'pz', expectedQuantity:2}];
  const draft = core.draft(source, 3, 'count-id', '2026-10-05');
  const stock = {product:'Olio sintetico', category:'Lubrificanti', unit:'lt', price:12.75, unitProfit:2.5, location:'A-2', minimum:3};
  const item = core.addStock(draft, stock, 'dc08151d-e0c4-426f-9340-d6b348a6dac2', 4.5);
  assert.equal(source.length, 1); assert.equal(draft.baseInventoryVersion, 3);
  assert.equal(item.expectedQuantity, 0); assert.equal(item.counted, true); assert.deepEqual(item.stock, stock);
  assert.equal(core.validate(JSON.parse(JSON.stringify(draft))), true);
  assert.equal(core.summary(draft).added, 1);
  assert.throws(() => core.addStock(draft, stock, item.cloudId), /già presente/);
  assert.throws(() => core.addStock(draft, {...stock, price:-1}, 'dc08151d-e0c4-426f-9340-d6b348a6dac3'), /non.*validi/);
  assert.throws(() => core.addStock(draft, stock, 'dc08151d-e0c4-426f-9340-d6b348a6dac3', 0.125), /non.*validi/);
  draft.status = 'review'; assert.throws(() => core.addStock(draft, stock, 'another'), /Torna al conteggio/);
  const invalid = structuredClone(draft); invalid.items[1].stock.category = 'Pneumatici'; assert.equal(core.validate(invalid), false);
});
