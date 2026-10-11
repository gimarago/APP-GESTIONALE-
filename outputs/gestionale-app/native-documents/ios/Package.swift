// swift-tools-version:5.3
import PackageDescription

let package = Package(
    name: "tauri-plugin-officina-documents",
    platforms: [.iOS(.v13)],
    products: [.library(name: "tauri-plugin-officina-documents", type: .static, targets: ["tauri-plugin-officina-documents"])],
    dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
    targets: [.target(name: "tauri-plugin-officina-documents", dependencies: [.byName(name: "Tauri")], path: "Sources")]
)
