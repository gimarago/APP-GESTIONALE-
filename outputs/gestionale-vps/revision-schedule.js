(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WorkshopRevisionSchedule = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  const categories = Object.freeze([
    Object.freeze({value:'', label:'— Seleziona intervallo —', years:0}),
    Object.freeze({value:'ordinary', label:'Uso ordinario · ogni 2 anni', years:2}),
    Object.freeze({value:'taxi', label:'Taxi · ogni anno', years:1}),
    Object.freeze({value:'ncc', label:'NCC (autovettura) · ogni anno', years:1}),
    Object.freeze({value:'annual', label:'Altra categoria con revisione annuale', years:1})
  ]);
  const category = value => categories.find(item => item.value === value) || categories[0];
  const isRevision = value => /\b(?:revision[ei]|revis|rev)\b/i.test(String(value || ''));
  const plateKey = value => String(value || '').replace(/\s*\d[\d.,\s]*\s*km\s*$/i, '').replace(/[^a-z0-9]/gi, '').toUpperCase();
  function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
    const date = new Date(value + 'T00:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }
  function deadline(lastRevision, selectedCategory) {
    const years = category(selectedCategory).years;
    if (!years || !validDate(lastRevision)) return '';
    const [year, month] = lastRevision.split('-').map(Number);
    const targetYear = year + years;
    if (targetYear > 9999) return '';
    // Periodic inspections expire at the end of the corresponding month.
    const end = new Date(0);
    end.setUTCFullYear(targetYear, month, 0);
    return end.toISOString().slice(0, 10);
  }
  return Object.freeze({categories, category, isRevision, plateKey, validDate, deadline});
});
