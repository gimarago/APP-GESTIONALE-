/* Installed by the native shell, never served to ordinary web browsers.
 * No credentials or application data are persisted here. All HTTP requests
 * stay in the authenticated WebView, preserving server cookies and CSRF rules.
 */
(function installNativeClient(window) {
  'use strict';
  const {document, location, HTMLAnchorElement, Blob, FileReader, URL, AbortController} = window;
  const fetch = window.fetch.bind(window);
  if (location.origin !== 'https://api.magomme.it' || window.WorkshopNative) return;
  const MAX_BYTES = 32 * 1024 * 1024;
  const MIME = {pdf:'application/pdf', json:'application/json', xml:'application/xml', csv:'text/csv', txt:'text/plain', p7m:'application/pkcs7-mime'};
  const invoke = (command, args) => {
    const api = window.top.__TAURI__?.core;
    return api ? api.invoke(command, args) : Promise.reject(new Error('Collegamento con l’app non disponibile. Chiudi e riapri l’app.'));
  };
  function notify(text, error = false) {
    const doc = window.top.document;
    if (!doc.body) return;
    let box = doc.getElementById('officinaNativeNotice');
    if (!box) {
      box = doc.createElement('div'); box.id = 'officinaNativeNotice';
      box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite');
      Object.assign(box.style, {position:'fixed',bottom:'max(18px, env(safe-area-inset-bottom))',left:'16px',right:'16px',zIndex:'2147483647',padding:'14px 18px',borderRadius:'12px',background:'#152d36',border:'1px solid #60d5e9',color:'white',font:'14px system-ui',boxShadow:'0 4px 24px #0008'});
      doc.body.append(box);
    }
    box.textContent = text; box.style.borderColor = error ? '#ff897e' : '#60d5e9'; box.hidden = false;
    clearTimeout(box._hide); box._hide = setTimeout(() => { box.hidden = true; }, error ? 14000 : 7000);
  }
  function errorMessage(error) { return typeof error === 'string' ? error : error?.message || 'Operazione non riuscita.'; }
  function nativeName(value, type) {
    let name = String(value || '').normalize('NFC').replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_').trim().replace(/[. ]+$/, '');
    if (!name) name = 'documento.' + (Object.keys(MIME).find(ext => MIME[ext] === type?.split(';')[0]) || 'txt');
    if (name.length > 160) name = name.slice(0, 145) + name.slice(name.lastIndexOf('.'));
    const extension = name.split('.').pop().toLowerCase();
    if (!MIME[extension]) throw new Error('Formato non supportato dall’app. Scarica questo documento dal browser.');
    return {name, mime: MIME[extension]};
  }
  function toBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onerror = () => reject(new Error('Impossibile leggere il documento.'));
      reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.readAsDataURL(blob);
    });
  }
  let exporting = false;
  async function exportBlob(blob, name) {
    if (exporting) throw new Error('Completa prima il salvataggio o la condivisione già aperti.');
    if (!(blob instanceof Blob) || blob.size === 0 || blob.size > MAX_BYTES) throw new Error('Documento vuoto o superiore a 32 MB.');
    const file = nativeName(name, blob.type);
    exporting = true;
    try {
      const result = await invoke('plugin:officina-documents|export_document', {...file, base64:await toBase64(blob)});
      notify(result?.status === 'saved' ? 'Documento salvato nella posizione scelta.' : result?.status === 'cancelled' ? 'Salvataggio annullato.' : 'Scegli dove salvare o condividere il documento.');
      return result;
    } finally { exporting = false; }
  }
  async function printHtml(html, title = 'Documento officina', options = {}) {
    if (typeof html !== 'string' || html.length > 4 * 1024 * 1024) throw new Error('Documento troppo grande per la stampa.');
    const result = await invoke('plugin:officina-documents|print_document', {html, title, labelWidthMm:options.labelWidthMm ?? null, labelHeightMm:options.labelHeightMm ?? null});
    notify(result?.status === 'cancelled' ? 'Stampa annullata.' : 'Seleziona la stampante o salva come PDF nella finestra di stampa.');
    return result;
  }
  async function openExternal(url) { return invoke('open_external', {url:String(url)}); }
  function fire(promise) { promise.catch(error => notify(errorMessage(error), true)); }
  Object.defineProperty(window, 'WorkshopNative', {value:Object.freeze({exportBlob, printHtml, openExternal}), configurable:false});

  // Capture both connected and detached download anchors used by PDF/JSON/XML/CSV exports.
  const originalClick = HTMLAnchorElement.prototype.click;
  function isDownload(link) { return link instanceof HTMLAnchorElement && link.hasAttribute('download') && !!link.href; }
  async function download(link) {
    const url = new URL(link.href, location.href);
    const ownBlob = url.protocol === 'blob:' && url.origin === location.origin;
    if (!ownBlob && url.origin !== location.origin) throw new Error('Download esterno non autorizzato.');
    if (!ownBlob && url.protocol !== 'https:') throw new Error('Download non sicuro.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    try {
      const response = await fetch(url.href, {credentials:'same-origin', signal:controller.signal});
      if (!response.ok) throw new Error('Download non riuscito. Verifica la sessione e riprova.');
      if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('Il documento supera 32 MB.');
      // Stream into a bounded buffer instead of allocating arbitrarily large responses.
      const reader = response.body?.getReader(); const chunks = []; let size = 0;
      if (reader) {
        while (true) { const {done,value} = await reader.read(); if (done) break; size += value.length; if (size > MAX_BYTES) { await reader.cancel(); throw new Error('Il documento supera 32 MB.'); } chunks.push(value); }
      } else { const data = await response.arrayBuffer(); if (data.byteLength > MAX_BYTES) throw new Error('Il documento supera 32 MB.'); chunks.push(data); }
      const disposition = response.headers.get('content-disposition') || '';
      let serverName = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
      if (serverName) { try { serverName = decodeURIComponent(serverName); } catch { serverName = ''; } }
      serverName ||= /filename="([^"]+)"/i.exec(disposition)?.[1] || /filename=([^;\s]+)/i.exec(disposition)?.[1];
      const name = serverName || link.download || (ownBlob ? '' : url.pathname.split('/').pop());
      return await exportBlob(new Blob(chunks, {type:response.headers.get('content-type') || ''}), name);
    } finally { clearTimeout(timer); }
  }
  function handleLinkClick(event) {
    const link = event.target.closest?.('a[href]'); if (!link || event.defaultPrevented) return;
    if (isDownload(link)) { event.preventDefault(); fire(download(link)); return; }
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin) { event.preventDefault(); fire(openExternal(url.href)); }
    else if (link.target === '_blank') { event.preventDefault(); notify('Apri questa pagina dal browser se devi usare una seconda finestra.', true); }
  }
  // The app validates contact details and prepares WhatsApp URLs in onclick.
  // Let those handlers run before resolving the final URL or exporting a file.
  document.addEventListener('click', handleLinkClick);
  HTMLAnchorElement.prototype.click = function() {
    if (this.isConnected) return originalClick.call(this);
    // Detached export anchors do not bubble to document. Listen temporarily at
    // their root, after existing handlers, while preserving normal click events.
    const root = this.getRootNode();
    root.addEventListener('click', handleLinkClick);
    try { return originalClick.call(this); }
    finally { root.removeEventListener('click', handleLinkClick); }
  };

  // The existing app reserves a blank popup before async email preparation and
  // writes static print documents to another popup. Native platforms have no
  // browser popup UI: route these two well-defined operations explicitly.
  window.open = (url = '') => {
    if (url && url !== 'about:blank') { fire(openExternal(new URL(url, location.href).href)); return null; }
    let html = '', closed = false;
    const navigate = target => { if (!closed && target && target !== 'about:blank') fire(openExternal(new URL(target, location.href).href)); };
    const locationProxy = {set href(value) { navigate(value); }, assign:navigate, replace:navigate};
    return {
      get closed() { return closed; }, close() { closed = true; }, focus() {},
      get location() { return locationProxy; }, set location(value) { navigate(value); },
      document: {
        open() { html = ''; }, write(...parts) { html += parts.join(''); },
        close() { if (!closed && html) { closed = true; fire(printHtml(html, 'Modulo officina')); } }
      }
    };
  };
  window.print = () => {
    const paper = document.getElementById('workshopLabelPaper') || document.getElementById('workshopPrintPaper');
    if (!paper) { notify('Apri prima l’anteprima del documento da stampare.', true); return; }
    const clone = paper.cloneNode(true); clone.querySelectorAll('button,input,select,textarea,script').forEach(el => el.remove());
    const label = paper.id === 'workshopLabelPaper';
    const options = label ? {labelWidthMm:parseFloat(paper.style.width), labelHeightMm:parseFloat(paper.style.height)} : {};
    fire(printHtml('<!doctype html><html><body>' + clone.outerHTML + '</body></html>', label ? 'Etichetta chiavi' : 'Scheda officina', options));
  };

  function ready() {
    if (window !== window.top) return;
    if (document.getElementById('loginForm') || document.getElementById('frameHost')) invoke('client_ready').catch(() => {});
    const viewport = document.querySelector('meta[name=viewport]');
    if (viewport && !viewport.content.includes('viewport-fit')) viewport.content += ', viewport-fit=cover';
    const style = document.createElement('style');
    style.textContent = '#workspace{box-sizing:border-box;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);background:#142f3a}.login{box-sizing:border-box;padding:max(24px,env(safe-area-inset-top)) max(24px,env(safe-area-inset-right)) max(24px,env(safe-area-inset-bottom)) max(24px,env(safe-area-inset-left))}';
    document.head.append(style);
    if (window.__OFFICINA_PLATFORM__ === 'android' && window.__TAURI__?.app?.onBackButtonPress) {
      let closing = false;
      window.__TAURI__.app.onBackButtonPress(async () => {
        if (closing) return;
        const frame = document.querySelector('#frameHost iframe')?.contentWindow;
        const inner = frame?.document;
        const previewClose = inner?.getElementById('workshopLabelClose') || inner?.getElementById('workshopPrintClose');
        if (previewClose) { previewClose.click(); return; }
        const dialog = inner?.querySelector('dialog[open]');
        if (dialog) { dialog.close(); return; }
        const modal = inner?.querySelector('.form-modal.open');
        if (modal && frame.closeModal) { frame.closeModal(modal.id); return; }
        const active = inner?.querySelector('.nav button.active');
        if (active && active.dataset.view !== 'dashboard') { inner.querySelector('.nav [data-view="dashboard"]')?.click(); return; }
        closing = true;
        try {
          if (frame?.WorkshopCloud && window.WorkshopCloudHost?.flush) await window.WorkshopCloudHost.flush();
          await invoke('close_client');
        } catch (error) { notify(errorMessage(error), true); }
        finally { closing = false; }
      }).catch(() => {});
    }
    // Install the same adapter in same-origin frames even on older Android
    // WebViews whose document-start injection only runs in the main frame.
    const watched = new WeakSet();
    const attach = frame => {
      if (watched.has(frame)) return;
      watched.add(frame);
      const install = () => { try { installNativeClient(frame.contentWindow); } catch { /* Never enter another origin. */ } };
      frame.addEventListener('load', install); install();
    };
    document.querySelectorAll('iframe').forEach(attach);
    new window.MutationObserver(() => document.querySelectorAll('iframe').forEach(attach)).observe(document.body, {childList:true, subtree:true});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, {once:true}); else ready();
})(window);
