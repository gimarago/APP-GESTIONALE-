use tauri::Url;

pub fn workshop(url: &Url) -> bool {
    url.scheme() == "https" && url.host_str() == Some("api.magomme.it")
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty() && url.password().is_none()
}

pub fn local(url: &Url) -> bool {
    let origin = (url.scheme() == "tauri" && url.host_str() == Some("localhost") && url.port().is_none())
        || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost") && url.port_or_known_default() == Some(80));
    origin && url.username().is_empty() && url.password().is_none()
        && matches!(url.path(), "/" | "/index.html")
}

pub fn external(url: &Url) -> bool {
    if url.as_str().len() > 16_384 || !url.username().is_empty() || url.password().is_some() { return false; }
    match url.scheme() {
        "https" => url.port_or_known_default() == Some(443) && matches!(url.host_str(),
            Some("wa.me" | "api.whatsapp.com" | "web.whatsapp.com" | "mail.google.com" | "outlook.live.com" | "outlook.office.com")),
        "mailto" => !url.path().is_empty() && !url.as_str().to_lowercase().contains("%0a") && !url.as_str().to_lowercase().contains("%0d"),
        "tel" => { let number = url.path(); !number.is_empty() && number.chars().all(|c| c.is_ascii_digit() || matches!(c, '+' | '-' | '(' | ')' | ' ')) && url.query().is_none() },
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn only_exact_https_workshop_origin() {
        assert!(workshop(&Url::parse("https://api.magomme.it/legacy").unwrap()));
        for value in ["http://api.magomme.it/", "https://api.magomme.it.evil.example/", "https://api.magomme.it:444/", "https://evil@api.magomme.it/", "https://magomme.it/"] {
            assert!(!workshop(&Url::parse(value).unwrap()), "{value}");
        }
    }
    #[test] fn external_links_cannot_start_programs_or_change_server() {
        for value in ["file:///C:/Windows/System32/cmd.exe", "javascript:alert(1)", "ms-settings:privacy", "https://mail.google.com.evil.example/", "http://wa.me/123", "https://api.magomme.it/", "mailto:a@b.it?subject=x%0d%0aBcc:c@d.it"] {
            assert!(!external(&Url::parse(value).unwrap()), "{value}");
        }
        assert!(external(&Url::parse("https://wa.me/393331234567?text=Ciao").unwrap()));
        assert!(external(&Url::parse("https://mail.google.com/mail/?view=cm").unwrap()));
        assert!(external(&Url::parse("tel:+393331234567").unwrap()));
    }
    #[test] fn local_navigation_is_limited_to_launcher() {
        assert!(local(&Url::parse("tauri://localhost/index.html?retry=1").unwrap()));
        assert!(local(&Url::parse("http://tauri.localhost/").unwrap()));
        assert!(!local(&Url::parse("https://tauri.localhost/").unwrap()));
        assert!(!local(&Url::parse("http://tauri.localhost:8080/").unwrap()));
        assert!(!local(&Url::parse("file:///etc/passwd").unwrap()));
    }
}
