const test = require('node:test');
const assert = require('node:assert/strict');
const periods = require('../tyre-sales-periods.js');

test('startup calendar assets are embedded and match the tested source files', () => {
  const fs = require('node:fs'), path = require('node:path');
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'officina-fatturazione.html'), 'utf8').replace(/\r\n/g, '\n');
  for (const [name, tag] of [['tyre-sales-periods.js', 'script'], ['tyre-sales.css', 'style']]) {
    const content = fs.readFileSync(path.join(root, name), 'utf8').replace(/\r\n/g, '\n').trimEnd();
    assert.ok(html.includes(`<!-- BEGIN ${name} -->\n<${tag}>\n${content}\n</${tag}>\n<!-- END ${name} -->`), name);
  }
});

test('selected periods include their full dates, with Monday weeks and leap years', () => {
  assert.deepEqual(periods.range('week', '2024-01-31'), {start:'2024-01-29', end:'2024-02-04', valid:true});
  assert.deepEqual(periods.range('month', '2024-02-10'), {start:'2024-02-01', end:'2024-02-29', valid:true});
  assert.deepEqual(periods.range('year', '2024-01-31'), {start:'2024-01-01', end:'2024-12-31', valid:true});
  assert.equal(periods.range('custom', '', '2024-02-30', '2024-03-01').valid, false);
  assert.equal(periods.range('custom', '', '2024-03-01', '2024-02-01').valid, false);
  assert.equal(periods.range('day', '').valid, false);
});

test('navigation crosses year and month boundaries without overflowing short months', () => {
  assert.equal(periods.shift('month', '2024-01-31', 1), '2024-02-29');
  assert.equal(periods.shift('month', '2024-01-31', -1), '2023-12-31');
  assert.equal(periods.shift('year', '2024-02-29', 1), '2025-02-28');
  assert.equal(periods.shift('week', '2024-01-31', 1), '2024-02-07');
  assert.equal(periods.shift('day', '2024-03-30', 1), '2024-03-31');
  assert.equal(periods.anchor(2024, 2, 31), '2024-02-29');
});
