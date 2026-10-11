mod policy;
mod updater;
#[cfg(all(test, target_os = "windows"))]
mod updater_protocol_tests;

use std::{sync::{Arc, atomic::{AtomicU64, Ordering}}, time::Duration};
use tauri::{Manager, WebviewUrl, WebviewWindow};
use tauri_plugin_opener::OpenerExt;

const VPS: &str = "https://api.magomme.it/";
#[derive(Clone, Default)]
struct Connection(Arc<AtomicU64>);

#[tauri::command]
async fn connect_vps(window: WebviewWindow, state: tauri::State<'_, Connection>) -> Result<(), String> {
    if !window.url().map(|u| policy::local(&u)).unwrap_or(false) {
        return Err("Operazione disponibile solo dalla schermata di avvio.".into());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .build().map_err(|_| "Impossibile inizializzare la connessione sicura.")?;
    let mut response = client.get(format!("{VPS}api/health")).send().await
        .map_err(|_| "Il VPS non è raggiungibile. Controlla Internet e riprova.")?;
    if !response.status().is_success() {
        return Err("Il VPS non è al momento disponibile. Riprova tra poco.".into());
    }
    // An arbitrary captive portal/redirect must not be mistaken for our server.
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "Risposta del VPS incompleta.")? {
        if bytes.len() + chunk.len() > 1024 { return Err("Risposta del VPS non valida.".into()); }
        bytes.extend_from_slice(&chunk);
    }
    if serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok().and_then(|v| v.get("ok").and_then(|x| x.as_bool())) != Some(true) {
        return Err("Il server non ha risposto come previsto. Riprova.".into());
    }
    let generation = state.0.fetch_add(1, Ordering::SeqCst) + 1;
    let connection = state.0.clone();
    window.navigate(VPS.parse().unwrap()).map_err(|_| "Impossibile aprire il gestionale.")?;
    // Covers loss of connection between health check and the main page load.
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(25));
        if connection.load(Ordering::SeqCst) == generation {
            let _ = window.navigate(local_url());
        }
    });
    Ok(())
}

fn local_url() -> tauri::Url {
    #[cfg(any(target_os = "windows", target_os = "android"))]
    let value = "http://tauri.localhost/index.html?retry=1";
    #[cfg(not(any(target_os = "windows", target_os = "android")))]
    let value = "tauri://localhost/index.html?retry=1";
    value.parse().unwrap()
}

#[tauri::command]
fn client_ready(window: WebviewWindow, state: tauri::State<'_, Connection>) -> Result<(), String> {
    if !window.url().map(|u| policy::workshop(&u)).unwrap_or(false) { return Err("Origine non ammessa.".into()); }
    state.0.fetch_add(1, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
async fn open_external(window: WebviewWindow, url: String) -> Result<(), String> {
    if !window.url().map(|u| policy::workshop(&u)).unwrap_or(false) { return Err("Origine non ammessa.".into()); }
    let target = tauri::Url::parse(&url).map_err(|_| "Collegamento non valido.")?;
    if !policy::external(&target) { return Err("Questo collegamento non è autorizzato nell’app.".into()); }
    window.app_handle().opener().open_url(target.as_str(), None::<&str>)
        .map_err(|_| "Nessuna applicazione disponibile per aprire il collegamento.".into())
}

#[tauri::command]
fn close_client(window: WebviewWindow) -> Result<(), String> {
    if !window.url().map(|u| policy::workshop(&u)).unwrap_or(false) { return Err("Origine non ammessa.".into()); }
    #[cfg(target_os = "android")]
    window.app_handle().exit(0);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_dialog::init());
    #[cfg(target_os = "windows")]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    builder
        .manage(Connection::default())
        // Automatic link handling is disabled: every URL passes our fixed policy.
        .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build())
        .plugin(tauri_plugin_officina_documents::init())
        .invoke_handler(tauri::generate_handler![connect_vps, client_ready, open_external, close_client, updater::updater_status, updater::updater_check, updater::updater_download, updater::updater_install])
        .setup(|app| {
            app.manage(updater::Updates::new(&app.package_info().version.to_string()));
            let platform = if cfg!(target_os = "android") { "android" } else if cfg!(target_os = "ios") { "ios" } else { "desktop" };
            let script = format!("window.__OFFICINA_PLATFORM__ = '{}';\n{}", platform, include_str!("../bridge.js"));
            #[cfg(target_os = "windows")]
            let script = format!("{script}\n{}", include_str!("../updater-ui.js"));
            let builder = tauri::WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Officina M.A. Gomme")
                .inner_size(1280.0, 850.0)
                .initialization_script_for_all_frames(script)
                .on_navigation(|url| policy::workshop(url) || policy::local(url));
            #[cfg(desktop)]
            let builder = builder.min_inner_size(380.0, 600.0)
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny);
            // Keep sandbox smoke tests in a disposable profile; release builds ignore it.
            #[cfg(all(debug_assertions, target_os = "windows"))]
            let builder = if let Some(profile) = std::env::var_os("OFFICINA_TEST_PROFILE") {
                let path = std::path::PathBuf::from(profile);
                if !path.is_absolute() {
                    return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "OFFICINA_TEST_PROFILE deve essere un percorso assoluto.").into());
                }
                builder.data_directory(path)
            } else { builder };
            builder.build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Impossibile avviare Officina");
}
