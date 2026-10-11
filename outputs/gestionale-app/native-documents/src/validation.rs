use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::{borrow::Cow, collections::HashSet};

pub const MAX_BYTES: usize = 32 * 1024 * 1024;
const MAX_INPUT: usize = 48 * 1024 * 1024;
const MAX_HTML: usize = 4 * 1024 * 1024;

pub struct ExportDocument {
    pub name: String,
    pub mime: String,
    pub extension: String,
    pub bytes: Vec<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintDocument {
    pub html: String,
    pub title: String,
    pub label_width_mm: Option<f64>,
    pub label_height_mm: Option<f64>,
}

pub fn export(name: &str, mime: &str, base64: &str) -> Result<ExportDocument, String> {
    if name.len() + mime.len() + base64.len() > MAX_INPUT {
        return Err("Documento troppo grande (massimo 32 MiB).".into());
    }
    if name.is_empty() || name.len() > 180 || name.trim() != name
        || name.starts_with('.') || name.ends_with('.')
        || name.chars().any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
    {
        return Err("Nome del documento non valido.".into());
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
    {
        return Err("Nome del documento riservato dal sistema.".into());
    }
    let extension = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    let mime = mime.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    let valid = match extension.as_str() {
        "pdf" => mime == "application/pdf",
        "json" => mime == "application/json",
        "xml" => matches!(mime.as_str(), "application/xml" | "text/xml"),
        "csv" => mime == "text/csv",
        "txt" => mime == "text/plain",
        "p7m" => matches!(mime.as_str(), "application/pkcs7-mime" | "application/x-pkcs7-mime"),
        _ => false,
    };
    if !valid { return Err("Tipo di documento non consentito.".into()); }
    // Bound encoded size before decoding to avoid allocating a 48 MiB decoded buffer.
    if base64.len() > ((MAX_BYTES + 2) / 3) * 4 {
        return Err("Documento troppo grande (massimo 32 MiB).".into());
    }
    let bytes = STANDARD.decode(base64).map_err(|_| "Documento Base64 non valido.")?;
    if bytes.len() > MAX_BYTES { return Err("Documento troppo grande (massimo 32 MiB).".into()); }
    Ok(ExportDocument { name: name.into(), mime, extension, bytes })
}

pub fn print(html: &str, title: &str, label_width_mm: Option<f64>, label_height_mm: Option<f64>) -> Result<PrintDocument, String> {
    if html.len() > MAX_HTML || title.len() > 180 || title.chars().any(char::is_control) {
        return Err("Documento di stampa non valido o troppo grande.".into());
    }
    let label_css = match (label_width_mm, label_height_mm) {
        (None, None) => String::new(),
        (Some(width), Some(height)) if width.is_finite() && height.is_finite()
            && (30.0..=216.0).contains(&width) && (20.0..=600.0).contains(&height) =>
            format!("@page{{size:{width}mm {height}mm;margin:0;padding:0}}body{{box-sizing:border-box;width:{width}mm;min-height:{height}mm;margin:0;padding:3mm}}body>div{{box-sizing:border-box;max-width:100%}}"),
        _ => return Err("Dimensioni dell'etichetta non valide.".into()),
    };
    let mut cleaner = ammonia::Builder::default();
    cleaner
        .url_schemes(HashSet::from(["data"]))
        .url_relative(ammonia::UrlRelative::Deny)
        .add_generic_attributes(&["class", "style", "id"])
        .filter_style_properties(HashSet::from([
            "height", "width", "max-width", "font-size", "font-weight", "text-align",
            "white-space", "margin", "margin-top", "margin-bottom", "padding",
            "border", "border-top", "border-bottom", "display", "gap",
        ]))
        .attribute_filter(|element, attr, value| {
            if attr == "href" || attr == "srcset" { return None; }
            if attr == "src" {
                if element != "img" || !["data:image/png;base64,", "data:image/jpeg;base64,", "data:image/webp;base64,"]
                    .iter().any(|prefix| value.starts_with(prefix)) { return None; }
            }
            Some(Cow::Borrowed(value))
        });
    let body = cleaner.clean(html).to_string();
    let title_safe = title.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;");
    Ok(PrintDocument {
        title: if title.trim().is_empty() { "Documento Officina".into() } else { title.into() },
        html: format!("<!doctype html><html lang=\"it\"><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\"><title>{title_safe}</title><style>{}{label_css}</style></head><body>{body}</body></html>", include_str!("print.css")),
        label_width_mm,
        label_height_mm,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn export_rejects_paths_and_executable_types() {
        for name in ["../test.pdf", "C:\\test.pdf", "x/y.pdf", "NUL.pdf", "con.json", "LPT2.txt", "test.pdf ", "test.exe"] {
            assert!(export(name, "application/pdf", "YQ==").is_err(), "{name}");
        }
        assert!(export("test.pdf", "text/plain", "YQ==").is_err());
        assert!(export("test.pdf", "application/pdf", "invalid!").is_err());
        assert_eq!(export("Preventivo cliente.pdf", "application/pdf", "YQ==").unwrap().bytes, b"a");
        assert!(export("fattura.xml", "text/xml; charset=utf-8", "YQ==").is_ok());
    }
    #[test]
    fn encoded_limit_applies_before_decoding() {
        let huge = "A".repeat(((MAX_BYTES + 2) / 3) * 4 + 4);
        assert!(export("test.pdf", "application/pdf", &huge).is_err());
    }
    #[test]
    fn printing_removes_execution_and_remote_resources_but_keeps_signature() {
        let result = print("<script>alert(1)</script><style>@import 'https://evil.invalid';</style><iframe src=https://evil.invalid></iframe><img src='https://evil.invalid/x'><img src='data:image/png;base64,YQ==' onload='alert(1)'><a href='javascript:alert(1)'>a</a><div class='sign'><p>Firma</p></div>", "<test>", None, None).unwrap();
        assert!(!result.html.contains("evil.invalid"));
        assert!(!result.html.contains("alert(1)"));
        assert!(!result.html.contains("<script"));
        assert!(result.html.contains("data:image/png;base64,YQ=="));
        assert!(result.html.contains("class=\"sign\""));
        assert!(result.html.contains("&lt;test&gt;"));
    }
    #[test]
    fn label_dimensions_are_bounded_numbers() {
        assert!(print("etichetta", "Etichetta", Some(80.0), Some(60.0)).unwrap().html.contains("size:80mm 60mm"));
        assert!(print("", "", Some(f64::NAN), Some(60.0)).is_err());
        assert!(print("", "", Some(80.0), None).is_err());
        assert!(print("", "", Some(80.0), Some(601.0)).is_err());
    }
}
