(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WorkshopPlateRecognition = api;
})(globalThis, () => {
  'use strict';
  const display = value => String(value ?? '').trim().toUpperCase();
  const key = value => display(value).replace(/[^A-Z0-9]/g, '');
  // An explicit Targa field is authoritative; a vehicle description is not.
  // Legacy free text is only scanned for bounded, identifiable plate shapes.
  const patterns = [
    /[A-Z]{2}\s*\d{3}\s*[A-Z]{2}/i,
    /[A-Z]{2}\s*\d{5,6}/i,
    /[A-Z]{2}\s*\d{2}\s*[A-Z]{3}/i,
    /[A-Z]{1,3}-[A-Z]{1,2}[ -]?\d{1,4}/i,
    /\d{4}[ -]?[A-Z]{3}/i,
    /\d-[A-Z]{3}-\d{3}/i
  ];
  function find(value) {
    const text = String(value ?? '');
    for (const pattern of patterns) {
      const match = new RegExp('(?<![A-Z0-9])(?:' + pattern.source + ')(?![A-Z0-9])', 'i').exec(text);
      if (match) return display(match[0]);
    }
    return '';
  }
  const stripMileage = value => String(value ?? '').replace(/(?:\s*·\s*)?\d[\d.,\s]*\s*km\s*$/i, '').replace(/\s*·\s*$/, '').trim();
  function fromVehicleDetails(value, fields = {}) {
    const text = String(value ?? '').trim(), parts = text.split('·').map(part => part.trim());
    const specified = Object.hasOwn(fields, 'plate');
    const knownVehicle = stripMileage(fields.vehicle);
    let plate = specified ? display(fields.plate) : '';
    if (!specified && parts[0] && (!knownVehicle || parts[0].toLowerCase() !== knownVehicle.toLowerCase())) {
      // New rows use data-plate. Older rows store Targa · Veicolo: this slot
      // also preserves foreign/numeric plates without broad free-text guesses.
      const structured = parts.length > 1 && !/^\d[\d.,\s]*\s*km$/i.test(parts[1])
        && /^[A-Z0-9 -]{2,18}$/i.test(parts[0]) && /^[A-Z0-9]{2,12}$/.test(key(parts[0]))
        && /\d/.test(parts[0]);
      plate = structured ? display(parts[0]) : find(parts[0]);
    }
    let vehicle = knownVehicle;
    if (!vehicle) {
      const first = parts[0];
      const rest = plate && key(first) === key(plate) ? parts.slice(1).join(' · ') : text;
      vehicle = stripMileage(rest);
    }
    return {plate, vehicle};
  }
  return {display, key, find, fromVehicleDetails};
});
