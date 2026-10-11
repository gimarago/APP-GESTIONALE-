import Foundation
import Tauri
import UIKit

private struct ExportArgs: Decodable {
    let name: String
    let mime: String
    let base64: String
}
private struct PrintArgs: Decodable {
    let html: String
    let title: String
    let labelWidthMm: Double?
    let labelHeightMm: Double?
}

class DocumentsPlugin: Plugin, UIPrintInteractionControllerDelegate {
    // All access to this flag and presentation state is on the main queue.
    private var busy = false
    private var paperSize: CGSize? = nil

    private func claim(_ invoke: Invoke) -> Bool {
        if busy { invoke.reject("Chiudi prima il documento già aperto."); return false }
        busy = true
        return true
    }

    private func presenter() -> UIViewController? {
        guard var current = self.manager.viewController else { return nil }
        while let presented = current.presentedViewController { current = presented }
        return current
    }

    @objc public func exportDocument(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(ExportArgs.self)
        DispatchQueue.main.async {
            guard self.claim(invoke) else { return }
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    guard !args.name.isEmpty, args.name.utf8.count <= 180,
                          args.name == (args.name as NSString).lastPathComponent,
                          !args.name.hasPrefix("."),
                          args.name.rangeOfCharacter(from: CharacterSet.controlCharacters.union(CharacterSet(charactersIn: "<>:\"/\\|?*"))) == nil,
                          args.base64.utf8.count <= 44_739_244,
                          let data = Data(base64Encoded: args.base64), data.count <= 32 * 1024 * 1024
                    else { throw NSError(domain: "OfficinaDocuments", code: 1) }
                    let fm = FileManager.default
                    let root = fm.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("officina-exports", isDirectory: true)
                    try fm.createDirectory(at: root, withIntermediateDirectories: true)
                    let cutoff = Date().addingTimeInterval(-24 * 60 * 60)
                    for old in (try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: [.creationDateKey, .isDirectoryKey])) ?? [] {
                        let values = try? old.resourceValues(forKeys: [.creationDateKey, .isDirectoryKey])
                        if values?.isDirectory == true, let date = values?.creationDate, date < cutoff {
                            try? fm.removeItem(at: old)
                        }
                    }
                    let folder = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
                    try fm.createDirectory(at: folder, withIntermediateDirectories: true)
                    let file = folder.appendingPathComponent(args.name, isDirectory: false)
                    try data.write(to: file, options: [.atomic, .completeFileProtection])
                    // Files stay until the next cleanup, so a share extension may still read them.
                    DispatchQueue.main.async {
                        guard let presenter = self.presenter(), presenter.view.window != nil else {
                            self.busy = false; invoke.reject("Impossibile aprire la condivisione."); return
                        }
                        let controller = UIActivityViewController(activityItems: [file], applicationActivities: nil)
                        if let popover = controller.popoverPresentationController {
                            popover.sourceView = presenter.view
                            popover.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 1, height: 1)
                            popover.permittedArrowDirections = []
                        }
                        controller.completionWithItemsHandler = { _, completed, _, error in
                            DispatchQueue.main.async {
                                self.busy = false
                                if error != nil { invoke.reject("Condivisione del documento non riuscita.") }
                                else { invoke.resolve(["status": completed ? "shared" : "cancelled"]) }
                            }
                        }
                        presenter.present(controller, animated: true)
                    }
                } catch {
                    DispatchQueue.main.async {
                        self.busy = false; invoke.reject("Documento non valido o impossibile da preparare.")
                    }
                }
            }
        }
    }

    @objc public func printDocument(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(PrintArgs.self)
        DispatchQueue.main.async {
            guard self.claim(invoke) else { return }
            guard args.html.utf8.count <= 5 * 1024 * 1024, args.title.utf8.count <= 180,
                  UIPrintInteractionController.isPrintingAvailable,
                  let presenter = self.presenter(), presenter.view.window != nil
            else { self.busy = false; invoke.reject("Stampa non disponibile su questo dispositivo."); return }
            let controller = UIPrintInteractionController.shared
            self.paperSize = nil
            if let width = args.labelWidthMm, let height = args.labelHeightMm,
               width.isFinite, height.isFinite, (30.0...216.0).contains(width), (20.0...600.0).contains(height) {
                self.paperSize = CGSize(width: width * 72 / 25.4, height: height * 72 / 25.4)
            }
            controller.delegate = self
            let info = UIPrintInfo(dictionary: nil)
            info.jobName = args.title
            info.outputType = .general
            controller.printInfo = info
            // Rust removes scripts, active elements, links, external assets and caller CSS.
            // UIMarkupTextPrintFormatter does not run the application or its JavaScript.
            controller.printFormatter = UIMarkupTextPrintFormatter(markupText: args.html)
            let completion: UIPrintInteractionController.CompletionHandler = { _, completed, error in
                DispatchQueue.main.async {
                    self.busy = false
                    if error != nil { invoke.reject("Stampa non riuscita.") }
                    else { invoke.resolve(["status": completed ? "presented" : "cancelled"]) }
                }
            }
            let shown: Bool
            if UIDevice.current.userInterfaceIdiom == .pad {
                shown = controller.present(from: CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 1, height: 1), in: presenter.view, animated: true, completionHandler: completion)
            } else {
                shown = controller.present(animated: true, completionHandler: completion)
            }
            if !shown { self.busy = false; invoke.reject("Impossibile aprire la finestra di stampa.") }
        }
    }

    public func printInteractionController(_ printInteractionController: UIPrintInteractionController, choosePaper paperList: [UIPrintPaper]) -> UIPrintPaper {
        // AirPrint ultimately offers the physical paper formats supported by the printer.
        return UIPrintPaper.bestPaper(forPageSize: paperSize ?? CGSize(width: 595.28, height: 841.89), withPapersFrom: paperList)
    }
}

@_cdecl("init_plugin_officina_documents")
func initPlugin() -> Plugin { DocumentsPlugin() }
