fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&["connect_vps", "client_ready", "open_external", "close_client", "updater_status", "updater_check", "updater_download", "updater_install"]),
        ),
    )
    .expect("Impossibile preparare il progetto Officina");
}
