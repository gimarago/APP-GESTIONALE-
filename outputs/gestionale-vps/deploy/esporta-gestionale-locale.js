/* Esporta il gestionale locale GIA APERTO. Incollare l'intero file nella
 * console degli strumenti sviluppatore di quella pagina, poi premere Invio.
 * Legge il DOM e le sole chiavi applicative elencate sotto. Non invia dati,
 * non modifica gli archivi e non esegue salvataggi dell'applicazione.
 */
(() => {
  'use strict';
  const schema = {
    selectors: ['#agendaRows','#customerRows','#stockRows','#agenda .parking-section .card','#richiami .agenda-list','#billingWorks','#billingHeading','#billingData'],
    storageKeys: ['ma-gomme-cashbook-v1','officina-quotes-v1','officina.invoices.v1','officina.customerFiscal.v1','officina.customerFiscal.v1.history','officina.deliveryLoads.v1','officina-table-import-v1','officina-moduli-v1','officina-work-notes','officina-postit','officina.inventory.v1','officina.revisionReminders.v1','officinaWorkshopLogo','officina-email-settings-v1'],
    fields: ['shopName','shopPhone','shopAddress','shopVat','shopEmail','shopHours','shopReminder'],
    tags: ['tr','td','th','div','span','b','strong','small','br','p','i','em','button','input','select','option','textarea','label','ul','ol','li'],
    attributes: ['class','title','role','type','value','checked','selected','readonly','disabled','hidden','tabindex','colspan','rowspan','min','max','step','placeholder','maxlength','inputmode','autocomplete','required','name','for']
  };
  const tags = new Set(schema.tags), attributes = new Set(schema.attributes);
  const omitted = '.agenda-empty,.empty-filter,.stock-reserved,[data-revision-auto],a.whatsapp-reminder';
  const state = {schemaVersion:1, storage:{}, dom:{}, fields:{}};
  let nodeCount = 0;

  function encode(node, depth = 0) {
    if (depth > 40 || ++nodeCount > 300000) throw new Error('Archivio troppo complesso: esportazione interrotta senza modificare i dati.');
    if (node.nodeType === 3) return node.nodeValue || '';
    if (node.nodeType !== 1 || node.matches(omitted)) return null;
    const tag = node.tagName.toLowerCase();
    if (!tags.has(tag)) return null;
    const attrs = {};
    for (const attribute of node.attributes) {
      const key = attribute.name.toLowerCase();
      if (key === 'hidden' || key === 'style' || /^on/.test(key) || /^(?:src|srcdoc|href|formaction)$/.test(key)) continue;
      // Flags used to remember installed event listeners are not business data.
      if (/^data-.*(?:ready|bound)$/i.test(key)) continue;
      if (attributes.has(key) || /^data-[a-z0-9-]+$/.test(key) || /^aria-[a-z0-9-]+$/.test(key)) attrs[key] = attribute.value;
    }
    // These controls may have changed without their HTML attributes changing.
    if (tag === 'input') {
      if (/^(?:password|file)$/i.test(node.type)) return null;
      attrs.value = node.value;
      delete attrs.checked;
      if (node.checked) attrs.checked = '';
    }
    if (tag === 'option') {
      delete attrs.selected;
      if (node.selected) attrs.selected = '';
    }
    // A removed parking row remains part of historical work and accounting.
    if (node.matches('.parking-row[data-removed-from-parking="true"]')) attrs.hidden = '';
    let children;
    if (tag === 'textarea') children = [node.value];
    else if (tag === 'td' && node.cellIndex === 0 && node.parentElement?.parentElement?.id === 'customerRows') children = [node.textContent];
    else children = Array.from(node.childNodes, child => encode(child, depth + 1)).filter(child => child !== null);
    return {t:tag, a:attrs, c:children};
  }

  const required = schema.selectors.filter(selector => !document.querySelector(selector));
  if (required.length) throw new Error('Apri il gestionale originale e attendi il caricamento completo. Contenitori mancanti: '+required.join(', '));
  if (window.WorkshopCloud || window.WorkshopCloudHost) throw new Error('Questo script serve per il gestionale locale originale. Nella versione VPS usa Gestione > Esporta copia dati.');
  for (const selector of schema.selectors) {
    const root = document.querySelector(selector);
    state.dom[selector] = Array.from(root.childNodes, child => encode(child)).filter(child => child !== null);
  }
  for (const key of schema.storageKeys) {
    const value = localStorage.getItem(key);
    if (value === null) continue;
    if (key !== 'officinaWorkshopLogo') {
      try { JSON.parse(value); }
      catch { throw new Error('Archivio locale non leggibile: '+key+'. Esportazione interrotta; conserva aperta questa pagina.'); }
    }
    state.storage[key] = value;
  }
  for (const id of schema.fields) {
    const field = document.getElementById(id);
    if (!field) throw new Error('Impostazione mancante: '+id+'. Attendi il caricamento completo del gestionale.');
    state.fields[id] = field.value;
  }
  const exportedAt = new Date().toISOString();
  const archive = {format:'officina-cloud-export', state, exportedAt};
  const bytes = new Blob([JSON.stringify(archive, null, 2)], {type:'application/json;charset=utf-8'});
  if (bytes.size > 16 * 1024 * 1024) throw new Error('Archivio oltre 16 MB: richiedi una migrazione assistita mantenendo aperto il gestionale. Nessun dato e stato modificato.');
  const filename = 'officina-migrazione-'+exportedAt.replace(/[:.]/g,'-')+'.json';
  const link = document.createElement('a'), url = URL.createObjectURL(bytes);
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);

  // Only counts in the console: no customers, addresses, invoices or credentials.
  const counts = {
    'Clienti / veicoli': state.dom['#customerRows'].filter(n => n && n.t === 'tr').length,
    'Appuntamenti': state.dom['#agendaRows'].filter(n => n && n.t === 'tr').length,
    'Articoli magazzino': state.dom['#stockRows'].filter(n => n && n.t === 'tr').length,
    'Veicoli parcheggio, inclusi archiviati': state.dom['#agenda .parking-section .card'].filter(n => n && typeof n === 'object' && /(?:^|\s)parking-row(?:\s|$)/.test(n.a.class || '')).length,
    'Richiami manuali': state.dom['#richiami .agenda-list'].filter(n => n && typeof n === 'object' && /(?:^|\s)agenda-row(?:\s|$)/.test(n.a.class || '')).length,
    'Archivi applicativi': Object.keys(state.storage).length,
    'Impostazioni officina': Object.keys(state.fields).length,
    'Dimensione file, byte': bytes.size
  };
  console.info('Esportazione preparata. Verifica il file nella cartella Download prima di chiudere il gestionale:', filename);
  console.table(counts);
  return {file:filename, exportedAt, conteggi:counts};
})();
