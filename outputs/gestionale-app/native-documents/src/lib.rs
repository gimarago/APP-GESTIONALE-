//! Documents received from the authenticated web application. No command accepts a path.
//! The host app must grant only allow-export-document / allow-print-document to its
//! exact HTTPS origin and main window; never grant these to document-print.
use serde::{Deserialize, Serialize};
use tauri::{plugin::{Builder, TauriPlugin}, Manager, Runtime};

mod validation;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod desktop;
#[cfg(any(target_os = "android", target_os = "ios"))]
mod mobile;

#[derive(Serialize, Deserialize)]
pub struct DocumentResult {
    /// `presented` means the OS UI opened; it does not attest to printing or delivery.
    pub status: String,
}
impl DocumentResult {
    fn new(status: &str) -> Self { Self { status: status.into() } }
}

#[tauri::command]
async fn export_document<R: Runtime>(
    app: tauri::AppHandle<R>, name: String, mime: String, base64: String,
) -> Result<DocumentResult, String> {
    let document = validation::export(&name, &mime, &base64)?;
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    return desktop::export(app, document).await;
    #[cfg(any(target_os = "android", target_os = "ios"))]
    return mobile::export(app, document).await;
}

#[tauri::command]
async fn print_document<R: Runtime>(
    app: tauri::AppHandle<R>, html: String, title: String,
    label_width_mm: Option<f64>, label_height_mm: Option<f64>,
) -> Result<DocumentResult, String> {
    let document = validation::print(&html, &title, label_width_mm, label_height_mm)?;
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    return desktop::print(app, document).await;
    #[cfg(any(target_os = "android", target_os = "ios"))]
    return mobile::print(app, document).await;
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    let builder = Builder::new("officina-documents")
        .invoke_handler(tauri::generate_handler![export_document, print_document]);
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.register_uri_scheme_protocol(desktop::PRINT_SCHEME, |context, request| {
        desktop::serve(&context.app_handle().state::<desktop::DocumentState>(), context.webview_label(), request)
    });
    builder
        .setup(|app, api| {
            #[cfg(any(target_os = "android", target_os = "ios"))]
            app.manage(mobile::init(api)?);
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            {
                let _ = api;
                app.manage(desktop::DocumentState::default());
            }
            Ok(())
        })
        .build()
}
