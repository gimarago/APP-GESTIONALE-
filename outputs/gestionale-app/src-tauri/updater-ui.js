/* Injected only by the Windows native shell. Ordinary browser pages and
 * child frames never receive access to the update controls. */
(function installUpdaterUI(window) {
  'use strict';
  const {document, location} = window;
  const launcher = (location.origin === 'http://tauri.localhost' || location.protocol === 'tauri:' && location.hostname === 'localhost') && /\/(?:index\.html)?$/.test(location.pathname);
  if (window !== window.top || !['desktop', 'windows'].includes(window.__OFFICINA_PLATFORM__) ||
      (!launcher && location.origin !== 'https://api.magomme.it') || !window.__TAURI__?.core?.invoke || window.WorkshopUpdater) return;
  const invoke = (command, args) => window.__TAURI__.core.invoke(command, args);
  const states = new Set(['idle', 'checking', 'available', 'downloading', 'ready', 'installing', 'error']);
  let snapshot = {supported:true, currentVersion:'', state:'idle', canDownload:false, canInstall:false};
  let pending = false, preparing = false, cancelledPreparation = false, panelOpen = false;
  let pollTimer = null, polling = false, epoch = 0, lastAction = '', displayMessage = '';
  let button, dialog, status, current, available, progress, progressLabel, check, download, install, close;
  const messageOf = error => typeof error === 'string' ? error : error?.message || 'Operazione non riuscita. Verifica la connessione e riprova.';
  const busyState = () => ['checking', 'downloading', 'installing'].includes(snapshot.state);
  const clean = (value, max = 1400) => typeof value === 'string' ? value.slice(0, max) : '';
  function normalized(value) {
    if (!value || typeof value !== 'object' || !states.has(value.state)) return null;
    const result = {supported:typeof value.supported === 'boolean' ? value.supported : snapshot.supported,
      currentVersion:clean(value.currentVersion, 100) || snapshot.currentVersion, state:value.state,
      version:clean(value.version, 100), message:clean(value.message)};
    result.canDownload = typeof value.canDownload === 'boolean' ? value.canDownload :
      ['available', 'error'].includes(value.state) && Boolean(result.version);
    result.canInstall = typeof value.canInstall === 'boolean' ? value.canInstall : value.state === 'ready';
    for (const key of ['downloaded', 'total']) if (Number.isFinite(value[key]) && value[key] >= 0) result[key] = value[key];
    return result;
  }
  function update(value) {
    const next = normalized(value);
    if (!next) return false;
    snapshot = next; epoch++;
    render(); return true;
  }
  function schedulePoll() {
    clearTimeout(pollTimer); pollTimer = null;
    if (!panelOpen || !busyState()) return;
    pollTimer = setTimeout(async () => {await readStatus(); schedulePoll();}, 500);
  }
  async function readStatus() {
    if (polling) return;
    polling = true;
    const started = epoch;
    try {
      const value = await invoke('updater_status');
      if (started === epoch) update(value);
    } catch (error) {
      if (started === epoch && !pending) update({...snapshot, state:'error', message:messageOf(error)});
    } finally {polling = false;}
  }
  function render() {
    if (!dialog) return;
    current.textContent = snapshot.currentVersion ? 'Versione installata: ' + snapshot.currentVersion : 'Versione installata: lettura in corso…';
    available.hidden = !snapshot.version;
    available.textContent = 'Nuova versione: ' + snapshot.version;
    const messages = {idle:'Premi “Verifica aggiornamenti” per cercare una nuova versione.', checking:'Verifica degli aggiornamenti in corso…',
      available:'È disponibile una nuova versione dell’app.', downloading:'Download dell’aggiornamento in corso…',
      ready:'Aggiornamento scaricato. Puoi installarlo e riavviare l’app.', installing:'Installazione in corso. L’app verrà riavviata.',
      error:'Aggiornamento non riuscito. Verifica la connessione e riprova.'};
    status.textContent = displayMessage || snapshot.message || (snapshot.supported ? messages[snapshot.state] : 'Gli aggiornamenti non sono disponibili in questa versione dell’app.');
    status.setAttribute('role', displayMessage || snapshot.state === 'error' ? 'alert' : 'status');
    progress.hidden = snapshot.state !== 'downloading';
    progressLabel.hidden = progress.hidden;
    if (snapshot.state === 'downloading') {
      if (snapshot.total > 0) {
        const percent = Math.min(100, Math.round((snapshot.downloaded || 0) / snapshot.total * 100));
        progress.value = percent;
        progressLabel.textContent = percent + '% · ' + ((snapshot.downloaded || 0) / 1048576).toLocaleString('it-IT', {maximumFractionDigits:1}) + ' di ' + (snapshot.total / 1048576).toLocaleString('it-IT', {maximumFractionDigits:1}) + ' MB';
      } else {progress.removeAttribute('value'); progressLabel.textContent = 'Download in corso…';}
    }
    const blocked = pending || busyState() || !snapshot.supported;
    check.disabled = blocked;
    check.hidden = snapshot.state === 'ready' || snapshot.state === 'installing';
    download.hidden = !snapshot.supported || !snapshot.canDownload || !['available', 'error'].includes(snapshot.state);
    download.disabled = blocked;
    download.textContent = snapshot.state === 'error' && lastAction === 'download' ? 'Riprova download' : 'Scarica aggiornamento';
    install.hidden = !snapshot.supported || !snapshot.canInstall || !['ready', 'error'].includes(snapshot.state);
    install.disabled = blocked;
    install.textContent = preparing ? 'Salvataggio in corso…' : 'Installa e riavvia';
    button.setAttribute('aria-expanded', String(panelOpen));
    dialog.setAttribute('aria-busy', String(pending || busyState()));
    schedulePoll();
  }
  function hidePanel() {
    if (preparing) cancelledPreparation = true;
    panelOpen = false;
    clearTimeout(pollTimer); pollTimer = null;
    if (dialog.open) dialog.close();
    button.setAttribute('aria-expanded', 'false');
    button.focus();
  }
  function openPanel() {
    if (panelOpen) {dialog.focus(); return;}
    panelOpen = true;
    displayMessage = '';
    dialog.showModal(); render();
    void readStatus();
    close.focus();
  }
  async function action(command, state, name) {
    if (pending || busyState() || !snapshot.supported || command === 'updater_download' && !snapshot.canDownload) return;
    pending = true; lastAction = name; displayMessage = '';
    update({...snapshot, state, message:''});
    try {
      const value = await invoke(command);
      if (!update(value)) await readStatus();
    } catch (error) {update({...snapshot, state:'error', message:messageOf(error)});}
    finally {pending = false; render();}
  }
  async function installUpdate() {
    if (pending || busyState() || !snapshot.canInstall || !snapshot.supported) return;
    pending = true; preparing = true; cancelledPreparation = false; displayMessage = 'Conferma dei salvataggi prima del riavvio…'; render();
    const host = window.WorkshopCloudHost;
    let attemptedGuard = false, handedToInstaller = false;
    try {
      if (typeof host?.prepareToLeave === 'function') {
        attemptedGuard = true;
        const proceed = await host.prepareToLeave({reason:'update'});
        if (proceed !== true || cancelledPreparation || !panelOpen) {displayMessage = 'Installazione annullata. Puoi continuare a lavorare.'; return;}
      } else if (document.querySelector('#frameHost iframe')) {
        throw new Error('Ricarica il gestionale prima di installare l’aggiornamento, dopo aver salvato le schede aperte.');
      }
      if (cancelledPreparation || !panelOpen) return;
      preparing = false; displayMessage = '';
      update({...snapshot, state:'installing', message:''});
      const value = await invoke('updater_install');
      if (!update(value)) await readStatus();
      handedToInstaller = snapshot.state === 'installing';
      if (!handedToInstaller && snapshot.state !== 'error') displayMessage = 'Installazione non avviata. Riprova.';
    } catch (error) {
      displayMessage = messageOf(error);
      update({...snapshot, state:'ready', message:''});
    } finally {
      preparing = false; pending = false;
      if (attemptedGuard && !handedToInstaller) {
        try {await host.cancelLeaving?.();} catch (error) {displayMessage = messageOf(error);}
      }
      render();
    }
  }
  function placeButton() {
    const actions = document.querySelector('#cloudBar:not([hidden]) .cloud-actions');
    const main = launcher && document.querySelector('main');
    const target = actions || main || document.body;
    if (button.parentElement !== target) target.append(button);
    button.classList.toggle('officina-updater-floating', !actions && !main);
    button.classList.toggle('officina-updater-launcher', Boolean(main));
  }
  function ready() {
    if (document.getElementById('officinaUpdaterButton')) return;
    const style = document.createElement('style');
    style.textContent = `#officinaUpdaterButton{border:1px solid #3a6675;border-radius:9px;padding:9px 12px;background:#17323e;color:#dceef5;font:600 12px system-ui;cursor:pointer}#officinaUpdaterButton.officina-updater-floating{position:fixed;bottom:max(18px,env(safe-area-inset-bottom));right:max(18px,env(safe-area-inset-right));z-index:9999;box-shadow:0 4px 14px #0005}#officinaUpdaterButton.officina-updater-launcher{display:block;margin:18px auto 0}#officinaUpdaterButton:focus-visible,#officinaUpdaterDialog button:focus-visible{outline:3px solid #62d4e9;outline-offset:3px}#officinaUpdaterDialog{box-sizing:border-box;width:min(520px,calc(100vw - 32px));max-height:calc(100dvh - 32px);overflow:auto;border:1px solid #3a6675;border-radius:16px;padding:24px;background:#10222e;color:#dceef5;box-shadow:0 14px 70px #0009;font:14px/1.5 system-ui}#officinaUpdaterDialog::backdrop{background:#020a13b8}#officinaUpdaterDialog h2{margin:0 0 12px;font-size:22px}#officinaUpdaterDialog p{margin:10px 0;overflow-wrap:anywhere}#officinaUpdaterCurrent,#officinaUpdaterVersion,#officinaUpdaterProgressLabel{color:#a8c8d8}#officinaUpdaterProgress{width:100%;accent-color:#62d4e9}#officinaUpdaterDialog .officina-updater-actions{display:flex;gap:9px;flex-wrap:wrap;margin-top:20px}#officinaUpdaterDialog button{border:1px solid #3a6675;border-radius:9px;padding:10px 13px;background:#17323e;color:#dceef5;font:600 13px system-ui;cursor:pointer}#officinaUpdaterDialog button.officina-updater-primary{background:#62d4e9;border-color:#62d4e9;color:#08232d}#officinaUpdaterDialog button:disabled{opacity:.55;cursor:wait}#officinaUpdaterDialog [hidden]{display:none!important}`;
    document.head.append(style);
    button = document.createElement('button'); button.id = 'officinaUpdaterButton'; button.type = 'button'; button.textContent = 'Aggiornamenti';
    button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-expanded', 'false'); button.setAttribute('aria-controls', 'officinaUpdaterDialog');
    dialog = document.createElement('dialog'); dialog.id = 'officinaUpdaterDialog'; dialog.setAttribute('aria-labelledby', 'officinaUpdaterTitle');
    dialog.innerHTML = '<h2 id="officinaUpdaterTitle">Aggiornamenti dell’app</h2><p id="officinaUpdaterCurrent"></p><p id="officinaUpdaterVersion" hidden></p><p id="officinaUpdaterMessage" role="status" aria-live="polite"></p><progress id="officinaUpdaterProgress" max="100" aria-label="Download aggiornamento" hidden></progress><p id="officinaUpdaterProgressLabel" hidden></p><p>L’installazione chiude e riavvia l’app.</p><div class="officina-updater-actions"><button type="button" id="officinaUpdaterCheck">Verifica aggiornamenti</button><button type="button" id="officinaUpdaterDownload" class="officina-updater-primary" hidden>Scarica aggiornamento</button><button type="button" id="officinaUpdaterInstall" class="officina-updater-primary" hidden>Installa e riavvia</button><button type="button" id="officinaUpdaterClose">Chiudi</button></div>';
    document.body.append(dialog);
    const get = id => document.getElementById('officinaUpdater' + id);
    current=get('Current'); available=get('Version'); status=get('Message'); progress=get('Progress'); progressLabel=get('ProgressLabel');
    check=get('Check'); download=get('Download'); install=get('Install'); close=get('Close');
    button.addEventListener('click', openPanel); close.addEventListener('click', hidePanel);
    dialog.addEventListener('cancel', event => {event.preventDefault(); hidePanel();});
    check.addEventListener('click', () => void action('updater_check', 'checking', 'check'));
    download.addEventListener('click', () => void action('updater_download', 'downloading', 'download'));
    install.addEventListener('click', () => void installUpdate());
    placeButton(); render();
    const bar = document.getElementById('cloudBar');
    if (bar) new window.MutationObserver(placeButton).observe(bar, {attributes:true, attributeFilter:['hidden']});
    // Status is read-only. Update checks, downloads and installs require clicks.
    void readStatus();
    window.addEventListener('pagehide', () => {clearTimeout(pollTimer); pollTimer = null;});
  }
  Object.defineProperty(window, 'WorkshopUpdater', {value:Object.freeze({open:() => button && openPanel()}), configurable:false});
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, {once:true}); else ready();
})(window);
