fn main() {
    tauri_plugin::Builder::new(&["export_document", "print_document"])
        .android_path("android")
        .ios_path("ios")
        .build();
}
