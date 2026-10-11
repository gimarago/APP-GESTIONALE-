(() => {
  'use strict';

  const section = document.querySelector('#agenda .parking-section');
  const card = section?.querySelector('.card');
  const heading = section?.querySelector('.parking-head h2');
  if (!section || !card || !heading || document.getElementById('parkingVehicleSearch')) return;

  const count = document.createElement('span');
  count.id = 'parkingVehicleCount';
  count.className = 'parking-vehicle-count';
  count.setAttribute('aria-live', 'polite');
  heading.append(' ', count);

  const toolbar = document.createElement('div');
  toolbar.className = 'parking-search-toolbar';
  const label = document.createElement('label');
  label.htmlFor = 'parkingVehicleSearch';
  label.textContent = 'Cerca veicolo';
  const search = document.createElement('input');
  search.id = 'parkingVehicleSearch';
  search.type = 'search';
  search.autocomplete = 'off';
  search.placeholder = 'Cliente, targa o modello';
  const results = document.createElement('span');
  results.id = 'parkingSearchResults';
  results.setAttribute('role', 'status');
  toolbar.append(label, search, results);
  card.before(toolbar);

  const empty = document.createElement('p');
  empty.className = 'parking-search-empty';
  empty.textContent = 'Nessun veicolo corrisponde alla ricerca.';
  empty.hidden = true;
  card.after(empty);

  // Filtering belongs to this browser only. Never alter a row's class, hidden
  // attribute, or style: those fields are part of the shared VPS snapshot.
  const filterStyle = document.createElement('style');
  filterStyle.id = 'parkingSearchFilterStyle';
  document.head.append(filterStyle);

  const normalize = value => String(value || '').trim().toLocaleLowerCase('it-IT');
  const compact = value => normalize(value).replace(/[^\p{L}\p{N}]/gu, '');
  const isActive = row => row.matches('.parking-row') && !row.hidden && row.dataset.removedFromParking !== 'true';
  const searchableText = row => row.children[0]?.textContent || '';

  function update() {
    const rows = [...card.children].filter(isActive);
    const query = normalize(search.value);
    const compactQuery = compact(query);
    const filtered = query ? rows.filter(row => {
      const value = searchableText(row);
      return normalize(value).includes(query) || (compactQuery && compact(value).includes(compactQuery));
    }) : rows;
    const visible = new Set(filtered);
    const hiddenSelectors = rows.filter(row => !visible.has(row)).map(row =>
      `#agenda .parking-section .card > .parking-row:nth-child(${[...card.children].indexOf(row) + 1})`
    );
    const rule = hiddenSelectors.length ? `${hiddenSelectors.join(',')} { display: none !important; }` : '';
    if (filterStyle.textContent !== rule) filterStyle.textContent = rule;

    const countText = `${rows.length} ${rows.length === 1 ? 'veicolo' : 'veicoli'}`;
    if (count.textContent !== countText) count.textContent = countText;
    results.textContent = query ? `${filtered.length} ${filtered.length === 1 ? 'risultato' : 'risultati'} su ${rows.length}` : '';
    empty.hidden = !query || filtered.length > 0;
  }

  search.addEventListener('input', update);
  new MutationObserver(update).observe(card, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['hidden', 'data-removed-from-parking', 'data-vehicle']
  });
  update();
})();
