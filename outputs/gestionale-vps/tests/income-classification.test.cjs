const {test} = require('node:test');
const assert = require('node:assert/strict');
const classify = require('../income-classification.js');

test('tagliandi recognize explicit servicing and the requested filters', () => {
  for (const text of [
    'Tagliando completo', 'tagliandi', 'Filtro aria', 'filtri abitacolo',
    'filtro anti polline', 'filtro antipolline', 'filtro anti-polline',
    'filtro olio', 'filtro carburante', 'filtro diesel', 'filtro benzina',
    "sostituzione filtro dell'aria", 'filtro dell’olio'
  ]) assert.equal(classify(text), 'tagliandi', text);
});

test('written oil descriptions recognize litres and an oil type in any order', () => {
  for (const text of [
    '4 lt olio 5W30', 'OLIO 5 W-30 4,5 litri', 'olio 0w20 4.5 l',
    '4lt5w30 olio', '1 litro olio SAE 30', '4 lt olio 10-40',
    '4 l olio sintetico', 'olio semisintetico 4 litri', '2 lt olio minerale'
  ]) assert.equal(classify(text), 'tagliandi', text);
});

test('litres and viscosity identify oil shorthand without the word oil', () => {
  for (const text of [
    '4L 5-30 LL', '4L5-30LL', '4lt5w30', '4,5L0W20LL',
    '4 l 10W-40 LL', '4.5 litri 5W30', '4litri5W30',
    '4 lt 5W30 Castrol', '2L SAE 30', '4L 5W30 C3',
    '4L5-30LL04', '4L0W20LLIV'
  ]) assert.equal(classify(text), 'tagliandi', text);
});

test('oil parts, brand names and incomplete oil descriptions stay mechanical', () => {
  for (const text of [
    'coppa olio', 'pompa olio', 'tappo olio', 'olio', 'olio motore',
    'Castrol', 'Magnatec', 'GTX', 'Edge', 'Vecton', 'Transmax', 'lubrificante',
    '5W30', '5-30 LL', 'olio 5W30', '4 lt olio',
    '4 kg olio 5W30', '400 ml olio 5W30', 'olio 5w30 senza litri',
    '4 kg 5W30', '4L5-30LLX', '4 litri sintetico', '4 l minerale',
    'filtro generico', 'filtro ariazione', 'prefiltro olio', 'portafiltro olio'
  ]) assert.equal(classify(text), 'meccanica', text);
});

test('other departments retain their classification and priority', () => {
  for (const [text, expected] of [
    ['tagliando e revisione', 'revisioni'],
    ['4 lt olio 5W30 e REV.', 'revisioni'],
    ['noleggio filtro aria', 'tagliandi'],
    ['Car rent', 'carRent'],
    ['noleggio coppa olio', 'carRent'],
    ['4 205/55/16 Falken', 'pneumatici'],
    ['convergenza', 'pneumatici'],
    ['diagnosi motore', 'meccanica'],
    ['', 'meccanica'], [null, 'meccanica']
  ]) assert.equal(classify(text), expected, String(text));
});
