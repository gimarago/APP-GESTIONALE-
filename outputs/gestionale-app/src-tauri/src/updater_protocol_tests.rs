//! Exercise Tauri's actual updater with a public, deliberately non-executable
//! signed fixture. These tests only check, download and verify; never install.
use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpListener},
    sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}},
    thread::{self, JoinHandle},
    time::Duration,
};
use serde::Deserialize;
use tauri::{App, test::{MockRuntime, mock_builder, mock_context, noop_assets}};
use tauri_plugin_updater::{Error, Updater, UpdaterExt};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    pubkey: String,
    signature: String,
    unsigned_version_signature: String,
    body: String,
}
fn fixture() -> Fixture {
    let value: Fixture = serde_json::from_str(include_str!("../../tests/fixtures/updater-signed-fixture.json")).unwrap();
    assert_eq!(value.body, "MZ-SYNTHETIC-UPDATE-NOT-AN-EXECUTABLE\n");
    value
}

struct LoopbackRelease {
    address: SocketAddr,
    stop: Arc<AtomicBool>,
    requests: Arc<Mutex<Vec<String>>>,
    worker: Option<JoinHandle<()>>,
}
impl LoopbackRelease {
    fn new(version: Option<&str>, signature: &str, artifact: Vec<u8>) -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        assert!(address.ip().is_loopback());
        listener.set_nonblocking(true).unwrap();
        let manifest = version.map(|version| serde_json::to_vec(&serde_json::json!({
            "version": version,
            "notes": "Synthetic signed fixture; installation is prohibited.",
            "platforms": {"windows-x86_64": {
                "url": format!("http://{address}/artifact.exe"),
                "signature": signature,
            }},
        })).unwrap());
        let stop = Arc::new(AtomicBool::new(false));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stopped = stop.clone();
        let seen = requests.clone();
        let worker = thread::spawn(move || {
            while !stopped.load(Ordering::Acquire) {
                let (mut stream, peer) = match listener.accept() {
                    Ok(connection) => connection,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2)); continue;
                    },
                    Err(error) => panic!("loopback fixture accept failed: {error}"),
                };
                assert!(peer.ip().is_loopback());
                stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                stream.set_write_timeout(Some(Duration::from_secs(2))).unwrap();
                let mut request = Vec::new();
                let mut buffer = [0; 1024];
                while !request.windows(4).any(|part| part == b"\r\n\r\n") {
                    match stream.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(size) => request.extend_from_slice(&buffer[..size]),
                        Err(_) => break,
                    }
                    assert!(request.len() < 16_384, "fixture request header limit");
                }
                let header = String::from_utf8_lossy(&request);
                let path = header.lines().next().unwrap_or_default().strip_prefix("GET ")
                    .and_then(|line| line.split_whitespace().next()).unwrap_or_default();
                seen.lock().unwrap().push(path.to_string());
                let (status, content_type, body): (&str, &str, &[u8]) = match path {
                    "/latest.json" => match manifest.as_ref() {
                        Some(json) => ("200 OK", "application/json", json.as_slice()),
                        None => ("204 No Content", "application/json", &[]),
                    },
                    "/artifact.exe" => ("200 OK", "application/octet-stream", artifact.as_slice()),
                    _ => ("404 Not Found", "text/plain", b"Unexpected fixture path"),
                };
                let response = format!("HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                stream.write_all(response.as_bytes()).unwrap();
                stream.write_all(body).unwrap();
            }
        });
        Self {address, stop, requests, worker: Some(worker)}
    }
    fn endpoint(&self) -> String { format!("http://{}/latest.json", self.address) }
    fn assert_requests(&self, expected: &[&str]) {
        assert_eq!(*self.requests.lock().unwrap(), expected.iter().map(|path| path.to_string()).collect::<Vec<_>>());
    }
}
impl Drop for LoopbackRelease {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let result = worker.join();
            if !thread::panicking() { result.unwrap(); }
        }
    }
}

fn mock_updater(release: &LoopbackRelease, fixture: &Fixture) -> (App<MockRuntime>, Updater) {
    let mut context = mock_context(noop_assets());
    context.package_info_mut().version = "1.0.3".parse().unwrap();
    context.config_mut().identifier = "it.magomme.officina.updater-test".into();
    // The only HTTP exception is this disposable test context. No production
    // configuration, endpoint or private signing material is used here.
    context.config_mut().plugins.0.insert("updater".into(), serde_json::json!({
        "dangerousInsecureTransportProtocol": true,
        "endpoints": [release.endpoint()],
        "pubkey": fixture.pubkey,
        "requireSignedVersion": true,
        "allowDowngrades": false,
    }));
    let app = mock_builder().plugin(tauri_plugin_updater::Builder::new().build()).build(context).unwrap();
    let updater = app.updater_builder().no_proxy().timeout(Duration::from_secs(3))
        .configure_client(|client| client.redirect(reqwest_updates::redirect::Policy::none()))
        .build().unwrap();
    (app, updater)
}

#[test]
fn real_protocol_accepts_signed_new_release_and_rejects_corrupted_cache() {
    let fixture = fixture();
    let release = LoopbackRelease::new(Some("1.0.4"), &fixture.signature, fixture.body.as_bytes().to_vec());
    let (_app, updater) = mock_updater(&release, &fixture);
    tauri::async_runtime::block_on(async {
        let update = updater.check().await.unwrap().expect("new signed release");
        assert_eq!(update.current_version, "1.0.3");
        assert_eq!(update.version, "1.0.4");
        let mut progress = 0;
        let mut finished = false;
        let bytes = update.download(|chunk, total| {progress += chunk; assert_eq!(total, Some(fixture.body.len() as u64));}, || finished = true).await.unwrap();
        assert_eq!(bytes, fixture.body.as_bytes());
        assert_eq!(progress, bytes.len());
        assert!(finished);
        update.verify(&bytes).unwrap();
        let mut corrupted = bytes.clone();corrupted[3] ^= 1;
        assert!(matches!(update.verify(&corrupted), Err(Error::Minisign(_))));
    });
    release.assert_requests(&["/latest.json", "/artifact.exe"]);
}

#[test]
fn real_protocol_rejects_download_bytes_changed_after_signing() {
    let fixture = fixture();
    let mut tampered = fixture.body.as_bytes().to_vec();tampered[3] ^= 1;
    let release = LoopbackRelease::new(Some("1.0.4"), &fixture.signature, tampered);
    let (_app, updater) = mock_updater(&release, &fixture);
    tauri::async_runtime::block_on(async {
        let update = updater.check().await.unwrap().unwrap();
        assert!(matches!(update.download(|_, _| {}, || {}).await, Err(Error::Minisign(_))));
    });
    release.assert_requests(&["/latest.json", "/artifact.exe"]);
}

#[test]
fn real_protocol_rejects_inflated_manifest_version_for_older_signed_bytes() {
    let fixture = fixture();
    let release = LoopbackRelease::new(Some("1.0.5"), &fixture.signature, fixture.body.as_bytes().to_vec());
    let (_app, updater) = mock_updater(&release, &fixture);
    tauri::async_runtime::block_on(async {
        let update = updater.check().await.unwrap().unwrap();
        match update.download(|_, _| {}, || {}).await {
            Err(Error::SignedVersionMismatch {signed, announced}) => {
                assert_eq!(signed, "1.0.4");assert_eq!(announced, "1.0.5");
            },
            other => panic!("expected signed version mismatch, got {other:?}"),
        }
    });
    release.assert_requests(&["/latest.json", "/artifact.exe"]);
}

#[test]
fn real_protocol_rejects_valid_signature_without_signed_version() {
    let fixture = fixture();
    let release = LoopbackRelease::new(Some("1.0.4"), &fixture.unsigned_version_signature, fixture.body.as_bytes().to_vec());
    let (_app, updater) = mock_updater(&release, &fixture);
    tauri::async_runtime::block_on(async {
        let update = updater.check().await.unwrap().unwrap();
        assert!(matches!(update.download(|_, _| {}, || {}).await, Err(Error::MissingSignedVersion)));
    });
    release.assert_requests(&["/latest.json", "/artifact.exe"]);
}

#[test]
fn real_protocol_skips_equal_and_older_versions_without_downloading() {
    let fixture = fixture();
    for version in ["1.0.3", "1.0.2"] {
        let release = LoopbackRelease::new(Some(version), &fixture.signature, fixture.body.as_bytes().to_vec());
        let (_app, updater) = mock_updater(&release, &fixture);
        assert!(tauri::async_runtime::block_on(updater.check()).unwrap().is_none(), "{version}");
        release.assert_requests(&["/latest.json"]);
    }
}

#[test]
fn real_protocol_accepts_no_release_response_without_downloading() {
    let fixture = fixture();
    let release = LoopbackRelease::new(None, &fixture.signature, fixture.body.as_bytes().to_vec());
    let (_app, updater) = mock_updater(&release, &fixture);
    assert!(tauri::async_runtime::block_on(updater.check()).unwrap().is_none());
    release.assert_requests(&["/latest.json"]);
}
