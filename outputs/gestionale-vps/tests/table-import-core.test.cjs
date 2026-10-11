const test = require('node:test');
const assert = require('node:assert/strict');
const importer = require('../table-import-core.js');

test('historical jobs keep distinct notes and exclude only matching completed work', () => {
  const base = {customer:'Mario Rossi',plate:'AA123BB',vehicle:'Fiat Panda',date:'2026-09-30',work:'4 pneumatici 205/55 R16',amount:400};
  const history = [{...base,notes:'Primo treno'}, {...base,notes:'Secondo treno'}, {...base,notes:'Primo treno'}];
  assert.equal(importer.historyFacts(history).length, 2);
  assert.equal(importer.historyFacts(history).reduce((sum,item)=>sum+(item.tyre?.quantity||0),0), 8);
  const live = [{plate:'AA123BB',date:'2026-09-30',work:base.work,amount:400}];
  assert.equal(importer.historyFacts(history,live).length, 1);
});

test('imported tyre quantity can be explicit and malformed plate text is rejected', () => {
  const rows = [['Mario Rossi','TAGLIANDO+5,5LT OLIO','2026-09-30','Cambio olio','100']];
  const converted = importer.convert(rows,{customer:0,plate:1,date:2,work:3,amount:4},'clients');
  assert.match(converted[0].error,/Targa/);
  const fact = importer.historyFacts([{customer:'Mario Rossi',plate:'AB-123-CD',date:'2026-09-30',work:'Montaggio gomme',amount:50,tyreQuantity:2,tyreMeasure:'205/55 R16'}]);
  assert.equal(fact[0].tyre.quantity,2);
  assert.equal(fact[0].tyre.measure,'205/55 R16');
});
