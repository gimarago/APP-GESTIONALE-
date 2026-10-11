use crate::{validation::{ExportDocument, PrintDocument}, DocumentResult};
use std::sync::{Arc, Mutex, atomic::{AtomicBool, AtomicU64, Ordering}};
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder, WindowEvent, webview::PageLoadEvent};
use tauri_plugin_dialog::DialogExt;

pub const PRINT_SCHEME: &str = "officina-print";
const PRINT_WINDOW: &str = "document-print";
const PRINT_CSP: &str = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

struct PrintSession { id: u64, html: Vec<u8> }

#[derive(Default)]
pub struct DocumentState {
    busy: Arc<AtomicBool>,
    active: Arc<Mutex<Option<PrintSession>>>,
    next_id: AtomicU64,
}

struct Lease { busy: Arc<AtomicBool>, active: Arc<Mutex<Option<PrintSession>>> }
impl Drop for Lease {
    fn drop(&mut self) {
        if let Ok(mut active) = self.active.lock() { active.take(); }
        self.busy.store(false, Ordering::Release);
    }
}
fn acquire<R: Runtime>(app: &AppHandle<R>) -> Result<Lease, String> {
    let state = app.state::<DocumentState>();
    let busy = state.busy.clone();
    busy.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "Chiudi prima la finestra del documento già aperta.".to_owned())?;
    Ok(Lease { busy, active: state.active.clone() })
}

fn document_path(id: u64) -> String { format!("/{id}/document.html") }
fn matches_document_url(url: &tauri::Url, id: u64) -> bool {
    // WebView2 maps registered protocols to http://<scheme>.localhost.
    let origin = (url.scheme() == PRINT_SCHEME && url.host_str() == Some("localhost"))
        || (url.scheme() == "http" && url.host_str() == Some("officina-print.localhost"));
    origin && url.port().is_none() && url.username().is_empty() && url.password().is_none()
        && url.path() == document_path(id) && url.query().is_none() && url.fragment().is_none()
}

pub fn serve(state: &DocumentState, window: &str, request: tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    let body = if window != PRINT_WINDOW {
        Err(tauri::http::StatusCode::FORBIDDEN)
    } else if request.method() != tauri::http::Method::GET {
        Err(tauri::http::StatusCode::METHOD_NOT_ALLOWED)
    } else {
        let url = tauri::Url::parse(&request.uri().to_string()).ok();
        match state.active.lock() {
            Ok(active) => match active.as_ref() {
                Some(document) if url.as_ref().is_some_and(|url| matches_document_url(url, document.id)) => Ok(document.html.clone()),
                _ => Err(tauri::http::StatusCode::NOT_FOUND),
            },
            Err(_) => Err(tauri::http::StatusCode::INTERNAL_SERVER_ERROR),
        }
    };
    let (status, body) = match body {
        Ok(body) => (tauri::http::StatusCode::OK, body),
        Err(status) => (status, Vec::new()),
    };
    tauri::http::Response::builder()
        .status(status)
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Content-Security-Policy", PRINT_CSP)
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .body(body).expect("fixed print response headers are valid")
}

pub async fn export<R: Runtime>(app: AppHandle<R>, document: ExportDocument) -> Result<DocumentResult, String> {
    let lease = acquire(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _lease = lease;
        let selected = app.dialog().file()
            .set_title("Salva documento Officina")
            .set_file_name(&document.name)
            .add_filter("Documento", &[document.extension.as_str()])
            .blocking_save_file();
        let Some(selected) = selected else { return Ok(DocumentResult::new("cancelled")); };
        let path = selected.into_path().map_err(|_| "Percorso scelto non supportato.".to_owned())?;
        // The only writable path is the one returned by the native, user-operated dialog.
        // No API lets JavaScript submit or discover arbitrary filesystem locations.
        std::fs::write(path, &document.bytes).map_err(|_| "Impossibile salvare il documento nella posizione scelta.".to_owned())?;
        Ok(DocumentResult::new("saved"))
    }).await.map_err(|_| "Esportazione interrotta.".to_owned())?
}

pub async fn print<R: Runtime>(app: AppHandle<R>, document: PrintDocument) -> Result<DocumentResult, String> {
    let lease = acquire(&app)?;
    let state = app.state::<DocumentState>();
    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    *state.active.lock().map_err(|_| "Impossibile preparare il documento di stampa.".to_owned())? =
        Some(PrintSession { id, html: document.html.into_bytes() });
    let print_once = Arc::new(AtomicBool::new(false));
    // HTML data URLs are rewritten by Tauri to include the launcher's CSP. That
    // both changes the allowed URL and blocks this document's inline print CSS.
    // Serve the one active, sanitized document from an isolated in-memory origin.
    let url = format!("{PRINT_SCHEME}://localhost{}", document_path(id));
    let builder = WebviewWindowBuilder::new(&app, PRINT_WINDOW, WebviewUrl::CustomProtocol(url.parse().map_err(|_| "Documento di stampa non valido.")?))
        .title(format!("{} — Stampa", document.title))
        .inner_size(850.0, 800.0)
        .disable_javascript()
        .devtools(false)
        .incognito(true)
        .on_navigation(move |url| matches_document_url(url, id))
        .on_page_load(move |window, event| {
            if event.event() == PageLoadEvent::Finished && matches_document_url(event.url(), id)
                && !print_once.swap(true, Ordering::AcqRel) {
                // WebView2 ExecuteScript remains available to the native host when page
                // JavaScript is disabled. Never evaluate any document-supplied source.
                #[cfg(target_os = "windows")]
                let result = window.eval("(() => { const images = Array.from(document.images).map(image => image.complete ? Promise.resolve() : new Promise(resolve => { image.addEventListener('load', resolve, {once:true}); image.addEventListener('error', resolve, {once:true}); })); Promise.all([document.fonts.ready, ...images]).then(() => requestAnimationFrame(() => requestAnimationFrame(() => window.print()))); })()");
                #[cfg(not(target_os = "windows"))]
                let result = window.print();
                if result.is_err() {
                    let _ = window.set_title("Stampa non disponibile — chiudi questa finestra e riprova");
                }
            }
        });
    // Match the main window's disposable profile only in Windows debug builds.
    #[cfg(all(debug_assertions, target_os = "windows"))]
    let builder = if let Some(profile) = std::env::var_os("OFFICINA_TEST_PROFILE") {
        let path = std::path::PathBuf::from(profile);
        if !path.is_absolute() { return Err("OFFICINA_TEST_PROFILE deve essere un percorso assoluto.".into()); }
        builder.data_directory(path)
    } else { builder };
    let window = builder.build()
        .map_err(|_| "Impossibile aprire l'anteprima di stampa.".to_owned())?;
    // Keep the document operation occupied until this preview closes; no concurrent windows.
    let held_lease = Mutex::new(Some(lease));
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            if let Ok(mut held) = held_lease.lock() { held.take(); }
        }
    });
    Ok(DocumentResult::new("presented"))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(url: &str) -> tauri::http::Request<Vec<u8>> {
        tauri::http::Request::builder().uri(url).body(Vec::new()).unwrap()
    }
    #[test]
    fn print_navigation_accepts_only_the_active_document_origin_and_path() {
        for value in ["officina-print://localhost/7/document.html", "http://officina-print.localhost/7/document.html"] {
            assert!(matches_document_url(&value.parse().unwrap(), 7), "{value}");
        }
        for value in ["about:blank", "data:text/html,blank", "https://api.magomme.it/7/document.html",
            "officina-print://other/7/document.html", "http://officina-print.localhost:8123/7/document.html",
            "officina-print://localhost/6/document.html", "officina-print://localhost/7/document.html?file=other",
            "officina-print://localhost/7/document.html#fragment", "officina-print://user@localhost/7/document.html"] {
            assert!(!matches_document_url(&value.parse().unwrap(), 7), "{value}");
        }
    }
    #[test]
    fn protocol_serves_sanitized_content_only_to_the_print_window() {
        let state = DocumentState::default();
        let document = crate::validation::print("<header class='heading'><h1>Scheda di accettazione</h1></header><section class='details'><div>Cliente: Prova</div></section><table><tr><td>Coppa olio</td><td>100,75</td></tr></table><script>alert(1)</script><img src='https://external.invalid/logo'>", "Scheda", None, None).unwrap();
        *state.active.lock().unwrap() = Some(PrintSession { id: 7, html: document.html.into_bytes() });
        let response = serve(&state, PRINT_WINDOW, request("officina-print://localhost/7/document.html"));
        assert_eq!(response.status(), tauri::http::StatusCode::OK);
        assert_eq!(response.headers()["Content-Security-Policy"], PRINT_CSP);
        assert_eq!(response.headers()["Cache-Control"], "no-store");
        let html = String::from_utf8(response.into_body()).unwrap();
        assert!(html.contains("Scheda di accettazione") && html.contains("Coppa olio") && html.contains("100,75"));
        assert!(html.contains("@page{size:A4"));
        assert!(!html.contains("alert(1)") && !html.contains("external.invalid"));
        // Optional visual fixture from the actual protocol response. This switch
        // exists only in the test binary, never in the installed application.
        if let Some(path) = std::env::var_os("OFFICINA_PRINT_TEST_HTML") {
            std::fs::write(path, &html).unwrap();
        }
        assert_eq!(serve(&state, PRINT_WINDOW, request("http://officina-print.localhost/7/document.html")).status(), tauri::http::StatusCode::OK);
        assert_eq!(serve(&state, "main", request("officina-print://localhost/7/document.html")).status(), tauri::http::StatusCode::FORBIDDEN);
        assert_eq!(serve(&state, PRINT_WINDOW, request("officina-print://localhost/6/document.html")).status(), tauri::http::StatusCode::NOT_FOUND);
        let post = tauri::http::Request::builder().method("POST").uri("officina-print://localhost/7/document.html").body(Vec::new()).unwrap();
        assert_eq!(serve(&state, PRINT_WINDOW, post).status(), tauri::http::StatusCode::METHOD_NOT_ALLOWED);
    }
    #[test]
    fn dropping_the_operation_removes_html_and_releases_the_next_document() {
        let state = DocumentState::default();
        state.busy.store(true, Ordering::Release);
        *state.active.lock().unwrap() = Some(PrintSession { id: 1, html: b"private document".to_vec() });
        let lease = Lease { busy: state.busy.clone(), active: state.active.clone() };
        drop(lease);
        assert!(!state.busy.load(Ordering::Acquire));
        assert!(state.active.lock().unwrap().is_none());
        assert_eq!(serve(&state, PRINT_WINDOW, request("officina-print://localhost/1/document.html")).status(), tauri::http::StatusCode::NOT_FOUND);
    }
}
