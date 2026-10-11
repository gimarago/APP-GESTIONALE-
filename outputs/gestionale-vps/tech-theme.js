/* Presentation enhancements. Existing IDs, controls and application data stay in place. */
(() => {
  'use strict';
  document.body.classList.add('tech-theme');
  const paths = {
    dashboard:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    agenda:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 10h18m-13 4h2m4 0h2m-8 4h2"/>',
    libroContabile:'<path d="M5 3h14v18l-3-2-4 2-4-2-3 2V3Zm4 5h6m-6 4h6m-6 4h3"/>',
    clienti:'<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3m1-16a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 5v2"/>',
    preventivi:'<path d="M14 3H5v18h14V8l-5-5Zm0 0v5h5M8 12h8m-8 4h5"/>',
    quotes:'<path d="M4 4h16v16H4zM8 9h8m-8 4h5m4 2 2 2 3-4"/>',
    supplierInvoices:'<path d="M5 3h10l4 4v14H5zM15 3v5h4M8 12h8m-8 4h8"/>',
    magazzino:'<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 5v9l9 5 9-5V8m-9 5v9m-5-16 9 5"/>',
    analysis:'<path d="M4 3v18h17M8 16v-4m5 4V6m5 10V9"/>',
    impostazioni:'<path d="m9 3-1 3-3 1v4l-2 1 2 2v3l3 1 1 3h5l1-3 3-1v-3l2-2-2-1V7l-3-1-1-3H9Z"/><circle cx="11.5" cy="12" r="3"/>',
    income:'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18m-5 6h2"/>',
    check:'<path d="m8 12 3 3 5-6"/><path d="m12 3 8 3v6c0 4-4 7-8 9-4-2-8-5-8-9V6l8-3Z"/>'
  };
  const icon = key => '<svg class="tech-icon" viewBox="0 0 24 24" aria-hidden="true">'+(paths[key]||paths.analysis)+'</svg>';
  const nav = document.querySelector('.nav');
  nav.setAttribute('aria-label','Navigazione principale');
  nav.querySelectorAll('button').forEach(button => {
    const label = button.dataset.navLabel || button.textContent.replace(/^[^\p{L}]+/u,'').trim();
    button.setAttribute('title',label);
    button.setAttribute('aria-label',label);
    const glyph = button.querySelector('i');
    if (glyph) { glyph.innerHTML=icon(button.dataset.navIcon || button.dataset.view); glyph.setAttribute('aria-hidden','true'); }
  });
  const navLabel=document.createElement('div'); navLabel.className='nav-label'; navLabel.textContent='SPAZIO DI LAVORO'; nav.prepend(navLabel);
  const settings=nav.querySelector('[data-view="analysis"], [data-view="dataAnalysis"], [data-view="analisi"]');
  if(settings) { const label=document.createElement('div'); label.className='nav-label control'; label.textContent='CONTROLLO'; settings.before(label); }
  const syncNav=()=>nav.querySelectorAll('button').forEach(button=>{ if(button.classList.contains('active')) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current'); });
  nav.addEventListener('click',()=>queueMicrotask(syncNav)); syncNav();
  document.querySelector('.brand-title').insertAdjacentHTML('afterbegin','<span class="brand-symbol" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.4"><path d="m16 3 11 6.5v13L16 29 5 22.5v-13L16 3Z"/><path d="m9 21 4-10 3 6 3-6 4 10M10 19h12"/></svg></span>');
  document.querySelector('.brand-title').insertAdjacentHTML('afterend','<span class="brand-caption">Gestione officina</span>');
  document.querySelector('.side').insertAdjacentHTML('beforeend','<div class="workspace-note"><div class="workspace-note-inner"><span class="workspace-avatar" aria-hidden="true">MA</span><div><strong>La tua officina</strong><small>Un unico spazio, ogni attività.</small></div></div></div>');
  document.querySelector('.greeting').insertAdjacentHTML('beforeend','<p class="tech-subtitle">Ogni dettaglio, sotto controllo.</p>');
  document.querySelectorAll('#dashboard .stat').forEach((stat,index)=>stat.insertAdjacentHTML('beforeend','<span class="stat-icon">'+icon(['agenda','income','preventivi','check'][index])+'</span>'));
  document.querySelector('main').insertAdjacentHTML('beforeend','<footer class="tech-page-footer"><span>M.A. GOMME SRL · GESTIONE OFFICINA</span><span>PRECISIONE, OGNI GIORNO.</span></footer>');
  const companyInput = document.getElementById('shopName');
  const companyBrand = document.querySelector('.brand-name');
  function companyInitials(name) {
    const core = name.trim().replace(/\b(?:s[.\s]*r[.\s]*l[.\s]*s?|s[.\s]*p[.\s]*a|s[.\s]*n[.\s]*c|s[.\s]*a[.\s]*s)\.?$/iu, '');
    const words = core.match(/[\p{L}\p{N}]+/gu) || [];
    return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || 'Officina').slice(0, 2)).toLocaleUpperCase('it-IT');
  }
  function syncCompanyIdentity() {
    const name = companyInput?.value.trim() || companyBrand.textContent.trim() || 'Officina';
    document.querySelector('.workspace-avatar').textContent = companyInitials(name);
    document.querySelector('.workspace-avatar').title = name;
    document.querySelector('.tech-page-footer span').textContent = name + ' · GESTIONE OFFICINA';
  }
  companyInput?.addEventListener('input', syncCompanyIdentity);
  document.getElementById('settingsForm')?.addEventListener('submit', syncCompanyIdentity);
  document.addEventListener('workshop-cloud-state-applied',event=>{if(!event.detail?.fields||event.detail.fields.includes('shopName'))syncCompanyIdentity();});
  new MutationObserver(syncCompanyIdentity).observe(companyBrand, {childList:true, characterData:true, subtree:true});
  syncCompanyIdentity();
})();
