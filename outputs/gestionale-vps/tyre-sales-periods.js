(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WorkshopTyreSalesPeriods = api;
})(globalThis, () => {
  'use strict';
  const iso = date => String(date.getUTCFullYear()).padStart(4, '0') + '-' +
    String(date.getUTCMonth() + 1).padStart(2, '0') + '-' + String(date.getUTCDate()).padStart(2, '0');
  function parse(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
    const date = new Date(value + 'T12:00:00Z');
    return Number.isFinite(date.getTime()) && iso(date) === value ? date : null;
  }
  function anchor(year, month, day = 1) {
    if (!Number.isInteger(year) || year < 1 || year > 9999 || !Number.isInteger(month) || month < 1 || month > 12) return '';
    const date = new Date(0);
    date.setUTCHours(12, 0, 0, 0);
    date.setUTCFullYear(year, month, 0);
    const last = date.getUTCDate();
    date.setUTCDate(Math.min(last, Math.max(1, day)));
    return iso(date);
  }
  function shift(mode, value, delta) {
    const date = parse(value);
    if (!date || !Number.isInteger(delta)) return '';
    if (mode === 'month' || mode === 'year') {
      const months = date.getUTCFullYear() * 12 + date.getUTCMonth() + delta * (mode === 'year' ? 12 : 1);
      return anchor(Math.floor(months / 12), (months % 12 + 12) % 12 + 1, date.getUTCDate());
    }
    date.setUTCDate(date.getUTCDate() + delta * (mode === 'week' ? 7 : 1));
    return date.getUTCFullYear() >= 1 && date.getUTCFullYear() <= 9999 ? iso(date) : '';
  }
  function range(mode, value, start, end) {
    if (mode === 'custom') return {start, end, valid:!!parse(start) && !!parse(end) && start <= end};
    const date = parse(value);
    if (!date) return {start:'', end:'', valid:false};
    if (mode === 'week') {
      const monday = shift('day', value, -((date.getUTCDay() + 6) % 7));
      return {start:monday, end:shift('day', monday, 6), valid:true};
    }
    if (mode === 'month') return {start:anchor(date.getUTCFullYear(), date.getUTCMonth() + 1), end:anchor(date.getUTCFullYear(), date.getUTCMonth() + 1, 31), valid:true};
    if (mode === 'year') return {start:anchor(date.getUTCFullYear(), 1), end:anchor(date.getUTCFullYear(), 12, 31), valid:true};
    return {start:value, end:value, valid:true};
  }
  return {parse, anchor, shift, range};
});
