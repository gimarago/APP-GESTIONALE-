const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');
const parts = require('../parts-recognition.js');

const html = fs.readFileSync(path.join(__dirname, '../officina-fatturazione.html'), 'utf8');
const blockStart = html.indexOf('/* Scarico automatico e prudente dei consumabili');
const sourceStart = html.indexOf('  const normal =', blockStart);
const sourceEnd = html.indexOf('  const requestsForLines =', sourceStart);
assert.ok(blockStart >= 0 && sourceStart > blockStart && sourceEnd > sourceStart);
const source = html.slice(sourceStart, sourceEnd);

function recognition(products) {
  const rows = products.map((product, index) => ({
    product,
    dataset: {consumableStockId: 'oil-' + index},
    cells: [{textContent: product}, {textContent: 'Lubrificanti'}],
    unit: 'lt'
  }));
  const inventory = {
    rows: () => rows,
    productName: row => row.product,
    unitFor: row => row.unit,
    numberFrom: value => Number(String(value).replace(',', '.')),
    quantize: value => Math.round(value * 1000) / 1000
  };
  const window = {WorkshopParts: parts};
  vm.runInNewContext(source, {inventory, window});
  return description => Array.from(window.workshopProductRequests(description), request => ({product: request.row.product, quantity: request.quantity}));
}

test('spaced oil shorthand uses its grade and LL qualifier without needing the word olio', () => {
  const ll = 'Olio Castrol Edge 5W30 LL';
  const recognize = recognition([ll, 'Olio Castrol Edge 5W30 C3']);
  assert.deepEqual(recognize('4L 5-30 LL'), [{product: ll, quantity: 4}]);
});

test('attached litre quantity and LL qualifier retain the exact viscosity and quantity', () => {
  const ll530 = 'Olio Castrol Edge 5W30 LL';
  const ll020 = 'Olio Castrol Edge 0W20 LL';
  const recognize = recognition([ll530, ll020, 'Olio Castrol Edge 5W30 C3']);
  assert.deepEqual(recognize('4L5-30LL'), [{product: ll530, quantity: 4}]);
  assert.deepEqual(recognize('4,5L0W20LL'), [{product: ll020, quantity: 4.5}]);
  assert.deepEqual(recognize('4lt5w30 LL'), [{product: ll530, quantity: 4}]);
  assert.deepEqual(recognition([ll530])('4lt5w30'), [{product: ll530, quantity: 4}]);
  assert.deepEqual(recognition(['Olio 5W30 LL-04'])('4L5-30LL04'), [{product: 'Olio 5W30 LL-04', quantity: 4}]);
  assert.deepEqual(recognize('4L5-30LL + 500ml0W20LL'), [{product: ll530, quantity: 4}, {product: ll020, quantity: 0.5}]);
});

test('oil shorthand never ignores a conflicting specification or an ambiguous stock match', () => {
  assert.deepEqual(recognition(['Olio Castrol Edge 5W30 C3'])('4L5-30LL'), []);
  assert.deepEqual(recognition(['Olio Castrol Edge 5W30 LL', 'Olio Castrol Magnatec 5W30 LL'])('4L5-30LL'), []);
  assert.deepEqual(recognition(['Olio Castrol Edge 5W30 LL'])('4L0-20LL'), []);
  assert.deepEqual(recognition(['Olio Castrol Edge 5W30 LL'])('5-30 LL'), []);
});

test('brand and family still discriminate otherwise equal oil grades', () => {
  const edge = 'Olio Castrol Edge 5W30 LL';
  assert.deepEqual(recognition([edge, 'Olio Castrol Magnatec 5W30 LL'])('4L5-30LL Castrol Edge'), [{product: edge, quantity: 4}]);
});
