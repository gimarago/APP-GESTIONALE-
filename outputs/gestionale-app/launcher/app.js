(() => {
  'use strict';
  const status = document.getElementById('status');
  const retry = document.getElementById('retry');
  let pending = false;
  async function connect() {
    if (pending) return;
    pending = true;
    retry.hidden = true;
    status.textContent = 'Connessione al gestionale…';
    try {
      if (!window.__TAURI__?.core?.invoke) throw new Error('Apri questa schermata dall’app Officina installata.');
      await window.__TAURI__.core.invoke('connect_vps');
      status.textContent = 'Connessione riuscita. Apertura del gestionale…';
      // If a connection fails after the health check, never leave an endless spinner.
      setTimeout(() => { retry.hidden = false; status.textContent = 'Il gestionale non si è aperto. Controlla la connessione e riprova.'; }, 15000);
    } catch (error) {
      status.textContent = typeof error === 'string' ? error : error.message || 'Connessione non riuscita. Riprova.';
      retry.hidden = false;
    } finally { pending = false; }
  }
  retry.addEventListener('click', connect);
  window.addEventListener('online', connect);
  if (new URL(location.href).searchParams.has('retry')) {
    status.textContent = 'Il gestionale non si è aperto in tempo. Controlla la connessione e riprova.';
    retry.hidden = false;
  } else connect();
})();
