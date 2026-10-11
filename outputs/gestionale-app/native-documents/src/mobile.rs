use crate::{validation::{ExportDocument, PrintDocument}, DocumentResult};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Serialize, de::DeserializeOwned};
use tauri::{AppHandle, Manager, Runtime, plugin::{PluginApi, PluginHandle}};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_officina_documents);

pub struct NativeDocuments<R: Runtime>(PluginHandle<R>);

pub fn init<R: Runtime, C: DeserializeOwned>(api: PluginApi<R, C>) -> Result<NativeDocuments<R>, tauri::plugin::mobile::PluginInvokeError> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin("it.magomme.documents", "DocumentsPlugin")?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_officina_documents)?;
    Ok(NativeDocuments(handle))
}

#[derive(Serialize)]
struct ExportPayload { name: String, mime: String, base64: String }

pub async fn export<R: Runtime>(app: AppHandle<R>, document: ExportDocument) -> Result<DocumentResult, String> {
    let handle = app.state::<NativeDocuments<R>>().0.clone();
    tauri::async_runtime::spawn_blocking(move || handle.run_mobile_plugin("exportDocument", ExportPayload {
        name: document.name, mime: document.mime, base64: STANDARD.encode(document.bytes),
    }).map_err(|e| e.to_string())).await.map_err(|_| "Esportazione interrotta.".to_owned())?
}

pub async fn print<R: Runtime>(app: AppHandle<R>, document: PrintDocument) -> Result<DocumentResult, String> {
    let handle = app.state::<NativeDocuments<R>>().0.clone();
    tauri::async_runtime::spawn_blocking(move || handle.run_mobile_plugin("printDocument", document)
        .map_err(|e| e.to_string())).await.map_err(|_| "Stampa interrotta.".to_owned())?
}
