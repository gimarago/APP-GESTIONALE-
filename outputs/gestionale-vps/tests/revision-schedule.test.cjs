const {test} = require('node:test');
const assert = require('node:assert/strict');
const schedule = require('../revision-schedule.js');
const classifyIncome = require('../income-classification.js');

test('revision categories choose annual or biennial deadlines at the end of the inspection month', () => {
  assert.equal(schedule.deadline('2025-10-04', 'ordinary'), '2027-10-31');
  for (const category of ['taxi', 'ncc', 'annual']) assert.equal(schedule.deadline('2025-10-04', category), '2026-10-31');
  assert.equal(schedule.deadline('2024-02-29', 'taxi'), '2025-02-28');
  assert.equal(schedule.deadline('2023-02-28', 'taxi'), '2024-02-29');
  assert.equal(schedule.deadline('2026-04-01', 'ordinary'), '2028-04-30');
  assert.equal(schedule.deadline('2026-12-31', 'ncc'), '2027-12-31');
});

test('missing or unknown intervals stay unconfigured without inventing a deadline', () => {
  for (const value of [undefined, null, '', 'unknown']) {
    assert.equal(schedule.category(value).value, '');
    assert.equal(schedule.category(value).years, 0);
    assert.equal(schedule.deadline('2025-06-10', value), '');
  }
  assert.equal(schedule.category('ordinary').years, 2);
  for (const date of ['', null, '2025-02-29', '2025-13-01', '2025-10-00', '05/10/2025', 'not a date']) assert.equal(schedule.deadline(date, 'taxi'), '');
  assert.equal(schedule.plateKey('AB 123 CD 150.000 km'), 'AB123CD');
  assert.equal(schedule.plateKey('AB 123 CD'), 'AB123CD');
});

test('revision work recognizes complete words and common abbreviations without unrelated substrings', () => {
  for (const value of ['Revisione periodica', 'REVISIONI', 'rev', 'REV.', 'revis', 'Revis.', 'Tagliando + rev. ministeriale', 'preparazione (revis)']) {
    assert.equal(schedule.isRevision(value), true, value);
    assert.equal(classifyIncome(value), 'revisioni', value);
  }
  for (const value of ['', null, 'Preventivo', 'reversibile', 'revisore', 'revisionare', 'irrevisione', 'revamp', 'revisioneZ']) {
    assert.equal(schedule.isRevision(value), false, value);
    assert.notEqual(classifyIncome(value), 'revisioni', value);
  }
});
