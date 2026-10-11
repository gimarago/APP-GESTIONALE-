use std::sync::{Arc, Mutex};
use serde::Serialize;
use tauri::{Manager, WebviewWindow};

const ENDPOINT: &str = "https://api.magomme.it/app-updates/windows-x86_64/latest.json";
const MAX_DOWNLOAD: u64 = 150 * 1024 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    supported: bool,
    current_version: String,
    state: String,
    version: Option<String>,
    notes: Option<String>,
    message: Option<String>,
    downloaded: u64,
    total: Option<u64>,
    can_download: bool,
    can_install: bool,
}

struct Inner {
    status: Status,
    #[cfg(target_os = "windows")]
    update: Option<tauri_plugin_updater::Update>,
    bytes: Option<Arc<Vec<u8>>>,
}
pub struct Updates(Mutex<Inner>);
impl Updates {
    pub fn new(version: &str) -> Self {
        Self(Mutex::new(Inner {
            status: Status { supported: cfg!(target_os = "windows"), current_version: version.into(), state:"idle".into(), version:None, notes:None, message:None, downloaded:0, total:None, can_download:false, can_install:false },
            #[cfg(target_os = "windows")]
            update: None,
            bytes: None,
        }))
    }
    fn snapshot(&self) -> Result<Status, String> { self.0.lock().map(|s|s.status.clone()).map_err(|_|"Aggiornamento temporaneamente non disponibile.".into()) }
    fn begin(&self, phase: &str) -> Result<(), String> {
        let mut s=self.0.lock().map_err(|_|"Aggiornamento temporaneamente non disponibile.")?;
        if matches!(s.status.state.as_str(), "checking" | "downloading" | "installing") { return Err("Attendi l’operazione di aggiornamento in corso.".into()); }
        s.status.state=phase.into();s.status.message=None;Ok(())
    }
    fn error(&self, message: &str) -> String {
        if let Ok(mut s)=self.0.lock(){s.status.state="error".into();s.status.message=Some(message.into());s.status.can_install=s.bytes.is_some();}
        message.into()
    }
}
fn permitted(label: &str, url: &tauri::Url) -> bool { label=="main" && (super::policy::local(url) || super::policy::workshop(url)) }
fn authorize(window: &WebviewWindow) -> Result<(), String> {
    if window.url().map(|u|permitted(window.label(), &u)).unwrap_or(false) { Ok(()) } else { Err("Aggiornamenti disponibili soltanto nell’app Officina.".into()) }
}
fn artifact_url(url: &tauri::Url) -> bool {
    let Some(name)=url.path().strip_prefix("/app-updates/windows-x86_64/") else{return false};
    super::policy::workshop(url) && url.query().is_none() && url.fragment().is_none()
        && name.starts_with("Officina-Windows-") && name.ends_with("-setup.exe")
        && name.chars().all(|c|c.is_ascii_alphanumeric() || matches!(c,'.'|'-'|'_'))
}
#[tauri::command]
pub fn updater_status(window: WebviewWindow, state: tauri::State<'_, Updates>) -> Result<Status,String> { authorize(&window)?;state.snapshot() }

#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn updater_check(window: WebviewWindow, state: tauri::State<'_, Updates>) -> Result<Status,String> {
    use tauri_plugin_updater::UpdaterExt;
    use std::time::Duration;
    authorize(&window)?;state.begin("checking")?;
    {let mut s=state.0.lock().unwrap();s.update=None;s.bytes=None;s.status.version=None;s.status.notes=None;s.status.downloaded=0;s.status.total=None;s.status.can_install=false;s.status.can_download=false;}
    let updater=window.app_handle().updater_builder()
        .endpoints(vec![ENDPOINT.parse().unwrap()])
        .map_err(|_|state.error("Configurazione aggiornamenti non valida."))?
        .timeout(Duration::from_secs(15))
        .configure_client(|client|client.https_only(true).redirect(reqwest_updates::redirect::Policy::none()))
        .build().map_err(|_|state.error("Impossibile inizializzare gli aggiornamenti."))?;
    let result=updater.check().await.map_err(|e|state.error(match e {
        tauri_plugin_updater::Error::ReleaseNotFound => "Aggiornamenti dell’app non ancora pubblicati. Riprova più tardi.",
        _=>"Impossibile verificare gli aggiornamenti. Controlla la connessione e riprova.",
    }))?;
    let mut s=state.0.lock().unwrap();
    if let Some(mut update)=result {
        if !artifact_url(&update.download_url){drop(s);return Err(state.error("Il pacchetto di aggiornamento non proviene dal server dell’officina."));}
        update.timeout=Some(Duration::from_secs(600));
        s.status.version=Some(update.version.clone());s.status.notes=update.body.clone();s.status.state="available".into();s.status.can_download=true;s.update=Some(update);
    }else{s.status.state="idle".into();s.status.message=Some("L’app è già aggiornata.".into());}
    Ok(s.status.clone())
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn updater_download(window: WebviewWindow, state: tauri::State<'_, Updates>) -> Result<Status,String> {
    authorize(&window)?;
    let update={let mut s=state.0.lock().unwrap();
        if matches!(s.status.state.as_str(),"checking"|"downloading"|"installing"){return Err("Attendi l’operazione di aggiornamento in corso.".into());}
        let update=s.update.clone().ok_or("Verifica prima gli aggiornamenti disponibili.")?;
        s.status.state="downloading".into();s.status.message=None;s.bytes=None;s.status.can_install=false;s.status.downloaded=0;s.status.total=None;update
    };
    let (tx,rx)=tokio::sync::oneshot::channel();let mut limit_sender=Some(tx);
    let download=update.download(|chunk,total|{
        let mut s=state.0.lock().unwrap();s.status.downloaded=s.status.downloaded.saturating_add(chunk as u64);s.status.total=total;
        if s.status.downloaded>MAX_DOWNLOAD || total.is_some_and(|size|size>MAX_DOWNLOAD){if let Some(tx)=limit_sender.take(){let _=tx.send(());}}
    },||{});
    tokio::pin!(download);
    let bytes=tokio::select!{
        biased;
        _=rx=>return Err(state.error("Il pacchetto di aggiornamento è troppo grande.")),
        result=&mut download=>result.map_err(|e|state.error(match e {
            tauri_plugin_updater::Error::Minisign(_) | tauri_plugin_updater::Error::SignedVersionMismatch{..} | tauri_plugin_updater::Error::MissingSignedVersion | tauri_plugin_updater::Error::Base64(_) | tauri_plugin_updater::Error::SignatureUtf8(_) => "Il pacchetto non supera la verifica della firma. Non è stato installato. Riprova la verifica degli aggiornamenti.",
            _=>"Download non completato. Controlla la connessione e riprova.",
        }))?,
    };
    let mut s=state.0.lock().unwrap();s.status.downloaded=bytes.len() as u64;s.status.total=Some(bytes.len() as u64);s.bytes=Some(Arc::new(bytes));s.status.state="ready".into();s.status.can_install=true;s.status.can_download=false;Ok(s.status.clone())
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn updater_install(window: WebviewWindow, state: tauri::State<'_, Updates>) -> Result<Status,String> {
    authorize(&window)?;
    let (update,bytes)={let mut s=state.0.lock().unwrap();
        if matches!(s.status.state.as_str(),"checking"|"downloading"|"installing"){return Err("Attendi l’operazione di aggiornamento in corso.".into());}
        let pair=(s.update.clone().ok_or("Verifica prima gli aggiornamenti.")?,s.bytes.clone().ok_or("Scarica prima l’aggiornamento e attendi la verifica della firma.")?);
        s.status.state="installing".into();s.status.message=None;pair
    };
    // Windows starts NSIS with /UPDATE and restarts the app. On success the
    // plugin exits this process, so the UI must have confirmed its save first.
    tauri::async_runtime::spawn_blocking(move||update.install(bytes.as_slice())).await
        .map_err(|_|state.error("Installazione non avviata. Puoi continuare a usare l’app e riprovare."))?
        .map_err(|_|state.error("Installazione non avviata. Puoi continuare a usare l’app e riprovare."))?;
    state.snapshot()
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub async fn updater_check(window: WebviewWindow, state: tauri::State<'_, Updates>) -> Result<Status,String> { authorize(&window)?;state.snapshot() }
#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub async fn updater_download(window: WebviewWindow) -> Result<Status,String> { authorize(&window)?;Err("Aggiornamento disponibile nell’app Windows.".into()) }
#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub async fn updater_install(window: WebviewWindow) -> Result<Status,String> { authorize(&window)?;Err("Aggiornamento disponibile nell’app Windows.".into()) }

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn updater_cannot_be_called_by_other_windows_or_origins(){
        for url in ["https://api.magomme.it/","http://tauri.localhost/index.html","tauri://localhost/index.html"] {assert!(permitted("main",&url.parse().unwrap()));assert!(!permitted("officina-print",&url.parse().unwrap()));}
        for url in ["https://evil.invalid/","http://api.magomme.it/","https://api.magomme.it:8443/","https://user@api.magomme.it/","http://tauri.localhost/other.html"]{assert!(!permitted("main",&url.parse().unwrap()));}
    }
    #[test] fn download_urls_are_pinned_to_the_office_release_directory(){
        assert!(artifact_url(&"https://api.magomme.it/app-updates/windows-x86_64/Officina-Windows-1.0.4-setup.exe".parse().unwrap()));
        for url in ["http://api.magomme.it/app-updates/windows-x86_64/Officina-Windows-1.0.4-setup.exe","https://evil.invalid/app-updates/windows-x86_64/Officina-Windows-1.0.4-setup.exe","https://api.magomme.it/app-updates/windows-x86_64/../Officina-Windows-1.0.4-setup.exe","https://api.magomme.it/app-updates/windows-x86_64/Officina-Windows-1.0.4-setup.exe?file=other","https://api.magomme.it/app-updates/windows-x86_64/Officina-Windows-1.0.4-setup.exe#x","https://api.magomme.it/app-updates/windows-x86_64/Officina-Windows-other.zip","https://api.magomme.it/app-updates/windows-x86_64/Officina-Windows-1.0.4/setup.exe"]{assert!(!artifact_url(&url.parse().unwrap()),"{url}");}
    }
    #[test] fn concurrent_operations_are_rejected_but_errors_allow_retry(){
        let state=Updates::new("1.0.3");state.begin("checking").unwrap();assert!(state.begin("downloading").is_err());assert!(state.begin("installing").is_err());state.error("Offline");assert!(state.begin("checking").is_ok());
        assert!(!state.snapshot().unwrap().can_install);
    }
}
