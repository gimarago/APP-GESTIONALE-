const test = require('node:test');
const assert = require('node:assert/strict');
const plates = require('../plate-recognition.js');
const imports = require('../table-import-core.js');
const tyres = require('../tyre-recognition.js');

test('motorcycle and foreign plates survive structured parking details', () => {
  for (const plate of ['ab 12345', 'AB123CD', 'B-AB 1234', 'ab12 cde', '1234 abc', 'ZH 123456', '1-ABC-123', '123456']) {
    const vehicle = 'Veicolo cliente';
    const legacy = plates.fromVehicleDetails(`${plate} · ${vehicle} · 50.000 km`);
    assert.deepEqual(legacy, {plate:plate.toUpperCase(), vehicle}, plate);
    const saved = plates.fromVehicleDetails(`${plate} · ${vehicle} · 50.000 km`, {plate, vehicle});
    assert.deepEqual(saved, {plate:plate.toUpperCase(), vehicle}, plate);
  }
});

test('dedicated plate data is kept, including an intentionally empty plate', () => {
  assert.deepEqual(plates.fromVehicleDetails('Fiat 500 · 120.000 km', {plate:'', vehicle:'Fiat 500'}), {plate:'', vehicle:'Fiat 500'});
  assert.deepEqual(plates.fromVehicleDetails('Fiat 500 · 120.000 km', {vehicle:'Fiat 500'}), {plate:'', vehicle:'Fiat 500'});
  assert.deepEqual(plates.fromVehicleDetails('BMW 320 · 50.000 km'), {plate:'', vehicle:'BMW 320'});
  assert.equal(plates.key(' b-ab 1234 '), plates.key('B AB-1234'));
});

test('free text plate recovery is bounded and does not accept models, amounts or tyre specifications', () => {
  for (const value of ['AB 123 CD', 'AB 12345', 'B-AB 1234', 'AB12 CDE', '1234 ABC', '1-ABC-123']) assert.equal(plates.find('Cliente · '+value), value);
  for (const value of ['Fiat 500', 'BMW 320', 'AS210', 'AS220', '100,75 €', '205/55 R16 91V FALKEN', '4 155/80/13 79T Falken SN832', 'XXAB12345ZZ']) assert.equal(plates.find(value), '', value);
});

test('history import keeps motorcycle and foreign plates separate without changing amounts or tyre work', () => {
  const names = ['AB12345', 'B-AB 1234', 'AB12 CDE', '1234 ABC', 'ZH 123456', '1-ABC-123', '123456'];
  const rows = names.map(plate => ['Cliente '+plate, plate, '2026-10-11', '4 205/55 R16 91V Falken AS210', '100,75']);
  const converted = imports.convert(rows, {customer:0, plate:1, date:2, work:3, amount:4}, 'clients');
  assert.equal(converted.filter(row => row.error).length, 0);
  const facts = imports.historyFacts(converted.map(row => row.item));
  assert.equal(facts.length, names.length);
  assert.deepEqual(facts.map(row => row.plate), names);
  assert.ok(facts.every(row => row.amount === 100.75 && row.tyre.quantity === 4));
  const detail = tyres.workDetails(rows[0][3]);
  assert.deepEqual(detail.modelTokens, ['as210']);
  assert.equal(detail.quantity, 4);
  assert.equal(detail.measure, '205/55/16');
});
