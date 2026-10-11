const assert=require('node:assert/strict');
const parts=require('./parts-recognition');
const matches=(work,stock)=>parts.tokens(work,'wiper').every(token=>parts.tokens(stock,'wiper').includes(token));
for(const brand of ['pointS','Point S','POINT-S']){
  const work='1 tergicristallo 450mm '+brand;
  assert.equal(matches(work,'Spazzola Omnicraft 450 mm'),false);
  assert.equal(matches(work,'Spazzola Point S 45 cm'),true);
  assert.equal(matches(work,'Spazzola 450 mm'),false);
  assert.equal(matches(work,'Spazzola Point S 650 mm'),false);
  assert.equal(parts.quantity(work,'wiper').quantity,1);
}
assert.equal(matches('1 tergicristallo 450mm Omnicraft','Spazzola Point S 450mm'),false);
assert.equal(matches('1 tergicristallo 450mm Omnicraft','Spazzola Omni Craft 450mm'),true);
assert(parts.tokens('lampadina H7 PointS','bulb').includes('brand:points'));
console.log('Marca Point S / Omnicraft: 18 controlli superati.');
