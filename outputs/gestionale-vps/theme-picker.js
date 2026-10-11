(() => {
  'use strict';
  const themes = {
    graphite: {name:'Grafite', description:'Elegante e hi-tech. Grafite e accenti ciano.', primary:'#285462', accent:'#64d8ef'},
    aurora: {name:'Aurora', description:'Atmosfera notturna, viola e lavanda.', primary:'#693589', accent:'#c8adff'},
    classic: {name:'Classico chiaro', description:'Superfici chiare, verde officina e lime.', primary:'#143d32', accent:'#d9fc52'}
  };
  const primary = document.getElementById('primaryColor');
  const accent = document.getElementById('accentColor');
  const host = [...document.querySelectorAll('#impostazioni .content > .card')].find(card => card.querySelector('h2')?.textContent.includes('Stato del sistema'));
  if (!host) return;
  host.insertAdjacentHTML('beforeend', '<div class="theme-settings"><div><h3>Aspetto dell’app</h3><p id="currentThemeLabel"></p></div><button class="btn" type="button" id="chooseTheme">Scegli tema</button><p id="themeSaveStatus" role="status" aria-live="polite"></p><button class="btn secondary" type="button" id="themeRetrySave" hidden>Riprova salvataggio tema</button></div>');
  const dialog = document.createElement('dialog');
  dialog.id = 'themePicker';
  dialog.setAttribute('aria-labelledby','themePickerTitle');
  dialog.innerHTML = '<div class="theme-picker-heading"><div><h2 id="themePickerTitle">Scegli tema</h2><p>La scelta e i colori vengono ricordati nel tuo account, anche su altri dispositivi.</p></div><button type="button" class="btn secondary" id="closeThemePicker">Chiudi</button></div><div class="theme-choices">'+Object.entries(themes).map(([id,theme])=>'<button type="button" class="theme-choice" data-theme-choice="'+id+'" aria-pressed="false"><span class="theme-preview preview-'+id+'" aria-hidden="true"><span class="preview-side"></span><span class="preview-main"><span class="preview-heading"></span><span class="preview-stats"><i></i><i></i><i></i></span><span class="preview-panel"></span></span></span><span class="theme-choice-title">'+theme.name+'<span class="theme-selected" aria-hidden="true">✓</span></span><span class="theme-description">'+theme.description+'</span></button>').join('')+'</div><p class="theme-picker-note" id="themePickerStatus" role="status" aria-live="polite">Puoi personalizzare i colori anche dalle impostazioni.</p><button class="btn secondary" type="button" id="themePickerRetry" hidden>Riprova salvataggio tema</button>';
  document.body.append(dialog);
  let state = {theme:'graphite', primary:themes.graphite.primary, accent:themes.graphite.accent};
  const validColor = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
  const saved = window.WorkshopCloud?.boot.appearance;
  if (saved && Object.hasOwn(themes,saved.theme)) {
    state={theme:saved.theme,primary:validColor(saved.primary)?saved.primary.toLowerCase():themes[saved.theme].primary,accent:validColor(saved.accent)?saved.accent.toLowerCase():themes[saved.theme].accent};
  }
  let sequence=0,persisted=0,saveTask=null,saveTimer;
  function apply() {
    document.body.classList.toggle('tech-theme',state.theme!=='classic');
    document.body.classList.toggle('theme-classic',state.theme==='classic');
    document.body.dataset.appearance=state.theme;
    for (const target of [document.documentElement,document.body]) {
      target.style.setProperty('--green',state.primary);
      target.style.setProperty('--lime',state.accent);
    }
    if(primary) primary.value=state.primary;
    if(accent) accent.value=state.accent;
    const custom=state.primary!==themes[state.theme].primary || state.accent!==themes[state.theme].accent;
    document.getElementById('currentThemeLabel').textContent='Tema attuale: '+themes[state.theme].name+(custom?' · colori personalizzati':'');
    dialog.querySelectorAll('[data-theme-choice]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.themeChoice===state.theme)));
  }
  function status(text,retry=false) {
    document.getElementById('themeSaveStatus').textContent=text;
    document.getElementById('themePickerStatus').textContent=text;
    document.getElementById('themeRetrySave').hidden=!retry;
    document.getElementById('themePickerRetry').hidden=!retry;
  }
  async function flush() {
    clearTimeout(saveTimer);
    if(saveTask)return saveTask;
    if(persisted===sequence)return;
    // Serialize and coalesce rapid selections. An older response can never
    // repaint a newer choice or win over the final request in this tab.
    const task=(async()=>{
      while(persisted<sequence){
        const version=sequence,choice={...state};
        status('Tema applicato. Salvataggio nel tuo account…');
        try{
          if(typeof parent.WorkshopCloudHost?.appearance!=='function')throw Error('Aggiorna il server per salvare il tema personale.');
          await parent.WorkshopCloudHost.appearance(window,choice);
          persisted=version;
          if(version===sequence){window.WorkshopCloud.boot.appearance=choice;status('Tema e colori salvati nel tuo account.');}
        }catch(error){
          if(version!==sequence)continue;
          status('Tema applicato, ma non salvato: '+(error.message||'verifica la connessione.')+' Riprova prima di ricaricare o uscire.',true);
          throw error;
        }
      }
    })();
    saveTask=task;
    try{await task;}finally{if(saveTask===task)saveTask=null;}
  }
  function persist(delay=0) {
    sequence++;
    clearTimeout(saveTimer);
    if(delay){status('Tema applicato. Salvataggio nel tuo account…');saveTimer=setTimeout(()=>void flush().catch(()=>{}),delay);}
    else void flush().catch(()=>{});
  }
  document.getElementById('chooseTheme').addEventListener('click',()=>dialog.showModal());
  document.getElementById('closeThemePicker').addEventListener('click',()=>dialog.close());
  dialog.querySelectorAll('[data-theme-choice]').forEach(button=>button.addEventListener('click',()=>{
    const id=button.dataset.themeChoice;
    state={theme:id,primary:themes[id].primary,accent:themes[id].accent};
    apply(); persist();
  }));
  const customize=()=>{
    state.primary=primary.value; state.accent=accent.value;
    apply(); persist(200);
  };
  primary?.addEventListener('input',customize);
  accent?.addEventListener('input',customize);
  primary?.addEventListener('change',()=>void flush().catch(()=>{}));
  accent?.addEventListener('change',()=>void flush().catch(()=>{}));
  for(const id of ['themeRetrySave','themePickerRetry'])document.getElementById(id).addEventListener('click',()=>void flush().catch(()=>{}));
  if(window.WorkshopCloud){window.WorkshopCloud.appearanceFlush=flush;Object.defineProperty(window.WorkshopCloud,'appearancePending',{get:()=>persisted<sequence});}
  apply();
})();
