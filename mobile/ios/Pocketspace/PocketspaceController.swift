import AVKit
import CryptoKit
import PhotosUI
import UIKit
import UniformTypeIdentifiers
import WebKit

private final class ScriptProxy: NSObject, WKScriptMessageHandler {
    weak var controller: PocketspaceController?

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        controller?.receive(message)
    }
}

final class PocketspaceController: UIViewController, WKNavigationDelegate, UIDocumentPickerDelegate, PHPickerViewControllerDelegate {
    private var webView: WKWebView!
    private var store: FileStore!
    private var assets: URL!
    private let worker = DispatchQueue(label: "pocketspace.files", qos: .userInitiated)
    private var pickerRequest: (id: Any, exporting: Bool, exportToken: String?)?
    private var photoPickerID: Any?
    private var preparingShare = false
    private var jobs: [String: VideoJob] = [:]

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        do {
            store = try FileStore()
            guard let assets = Bundle.main.resourceURL?.appendingPathComponent("dist", isDirectory: true),
                  FileManager.default.fileExists(atPath: assets.appendingPathComponent("index.html").path) else {
                throw NativeError("assets", "The Pocketspace web assets are missing.")
            }
            self.assets = assets
            let config = WKWebViewConfiguration()
            config.websiteDataStore = .nonPersistent()
            config.allowsInlineMediaPlayback = true
            config.setURLSchemeHandler(LocalScheme(assets: assets, store: store), forURLScheme: "pocketspace")
            let proxy = ScriptProxy()
            proxy.controller = self
            config.userContentController.add(proxy, name: "pocketspace")
            webView = WKWebView(frame: .zero, configuration: config)
            webView.navigationDelegate = self
            webView.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(webView)
            let safe = view.safeAreaLayoutGuide
            NSLayoutConstraint.activate([
                webView.topAnchor.constraint(equalTo: safe.topAnchor),
                webView.bottomAnchor.constraint(equalTo: safe.bottomAnchor),
                webView.leadingAnchor.constraint(equalTo: safe.leadingAnchor),
                webView.trailingAnchor.constraint(equalTo: safe.trailingAnchor)
            ])
            webView.load(URLRequest(url: URL(string: "pocketspace://app/index.html")!))
        } catch {
            let label = UILabel(frame: view.bounds.insetBy(dx: 24, dy: 24))
            label.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            label.numberOfLines = 0
            label.textAlignment = .center
            label.text = (error as? NativeError)?.message ?? "Unable to open Pocketspace storage."
            view.addSubview(label)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = action.request.url
        let appPage = LocalScheme.isLocal(url) && ["/", "/index.html"].contains(url?.path ?? "")
        decisionHandler(appPage && action.targetFrame?.isMainFrame == true ? .allow : .cancel)
    }

    private func send(_ function: String, _ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.\(function)?.(\(json))")
    }

    private func reply(_ id: Any, result: Any = NSNull(), error: Error? = nil) {
        if let error {
            let failure = error as? NativeError ?? NativeError("native", error.localizedDescription)
            send("__pocketspaceReply", ["id": id, "error": ["code": failure.code, "message": failure.message]])
        } else {
            send("__pocketspaceReply", ["id": id, "result": result])
        }
    }

    func receive(_ message: WKScriptMessage) {
        guard message.name == "pocketspace", message.frameInfo.isMainFrame,
              LocalScheme.isLocal(message.frameInfo.request.url),
              let body = message.body as? String, body.utf8.count <= 1_400_000,
              let call = (try? JSONSerialization.jsonObject(with: Data(body.utf8))) as? [String: Any],
              let id = call["id"], id is String || id is NSNumber,
              let method = call["method"] as? String else { return }
        let args = call["args"] as? [String: Any] ?? [:]
        do {
            switch method {
            case "pickFiles":
                try requirePresentation()
                let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
                picker.allowsMultipleSelection = true
                picker.delegate = self
                pickerRequest = (id, false, nil)
                present(picker, animated: true)
            case "pickMedia":
                try requirePresentation()
                var configuration = PHPickerConfiguration()
                configuration.filter = .any(of: [.images, .videos])
                configuration.selectionLimit = 0
                configuration.selection = .ordered
                configuration.preferredAssetRepresentationMode = .current
                let picker = PHPickerViewController(configuration: configuration)
                picker.delegate = self
                photoPickerID = id
                present(picker, animated: true)
            case "save":
                try requirePresentation()
                let entry = try store.get(string("token", in: args))
                let name = try string("name", in: args)
                if name == entry.file.lastPathComponent {
                    export(entry.file, id: id, staging: nil)
                } else {
                    try stageExport(entry, name: name, id: id)
                }
            case "share":
                try requirePresentation()
                guard let tokens = args["tokens"] as? [String], !tokens.isEmpty else { throw NativeError.invalid }
                let entries = try tokens.map { try store.get($0) }
                let names = args["names"] as? [String] ?? entries.map { $0.file.lastPathComponent }
                guard entries.count == names.count else { throw NativeError.invalid }
                stageShare(entries, names: names, id: id)
            case "preview":
                try requirePresentation()
                let file = try store.get(string("token", in: args))
                let preview = AVPlayerViewController()
                preview.player = AVPlayer(url: file.file)
                present(preview, animated: true) {
                    preview.player?.play()
                    self.reply(id)
                }
            case "compressVideo":
                try compress(args, id: id)
            case "cancel":
                jobs[try string("jobId", in: args)]?.cancel()
                reply(id)
            case "release", "beginWrite", "writeChunk", "endWrite", "readChunk", "digest":
                worker.async { [weak self] in
                    guard let self else { return }
                    do {
                        let result = try self.fileOperation(method, args: args)
                        DispatchQueue.main.async { self.reply(id, result: result) }
                    } catch {
                        DispatchQueue.main.async { self.reply(id, error: error) }
                    }
                }
            default:
                throw NativeError.invalid
            }
        } catch {
            reply(id, error: error)
        }
    }

    private func string(_ key: String, in args: [String: Any]) throws -> String {
        guard let value = args[key] as? String, !value.isEmpty else { throw NativeError.invalid }
        return value
    }

    private func fileOperation(_ method: String, args: [String: Any]) throws -> Any {
        switch method {
        case "release":
            guard let tokens = args["tokens"] as? [String] else { throw NativeError.invalid }
            tokens.forEach(store.remove)
        case "beginWrite":
            let expected = (args["size"] as? NSNumber)?.int64Value
            let type = FileStore.safeMIME(try string("type", in: args))
            return ["token": try store.begin(string("name", in: args), type: type, expected: expected)]
        case "writeChunk":
            guard let offset = args["offset"] as? Int64, let base64 = args["base64"] as? String,
                  let data = Data(base64Encoded: base64) else { throw NativeError.invalid }
            try store.append(string("token", in: args), offset: offset, data: data)
        case "endWrite":
            return try store.finish(string("token", in: args)).descriptor
        case "readChunk":
            guard let offset = args["offset"] as? Int64, let length = args["length"] as? Int else {
                throw NativeError.invalid
            }
            let data = try store.read(string("token", in: args), offset: offset, length: length)
            return ["base64": data.base64EncodedString()]
        case "digest":
            guard let base64 = args["base64"] as? String, let data = Data(base64Encoded: base64),
                  data.count <= 1_048_576 else { throw NativeError.invalid }
            return ["base64": Data(SHA256.hash(data: data)).base64EncodedString()]
        default:
            throw NativeError.invalid
        }
        return NSNull()
    }

    private func requirePresentation() throws {
        guard presentedViewController == nil, pickerRequest == nil, photoPickerID == nil,
              !preparingShare else {
            throw NativeError("busy", "Close the current dialog and try again.")
        }
    }

    private func stageExport(_ entry: LocalFile, name: String, id: Any) throws {
        let (token, url) = try store.allocate(name)
        pickerRequest = (id, true, token)
        worker.async {
            do {
                try self.linkOrCopy(entry.file, to: url)
                DispatchQueue.main.async { self.export(url, id: id, staging: token) }
            } catch {
                self.store.remove(token)
                DispatchQueue.main.async {
                    self.pickerRequest = nil
                    self.reply(id, error: error)
                }
            }
        }
    }

    private func export(_ url: URL, id: Any, staging: String?) {
        let picker = UIDocumentPickerViewController(forExporting: [url], asCopy: true)
        picker.delegate = self
        pickerRequest = (id, true, staging)
        present(picker, animated: true)
    }

    private func linkOrCopy(_ source: URL, to output: URL) throws {
        do {
            try FileManager.default.linkItem(at: source, to: output)
        } catch {
            try FileManager.default.copyItem(at: source, to: output)
        }
    }

    private func stageShare(_ entries: [LocalFile], names: [String], id: Any) {
        preparingShare = true
        worker.async {
            var tokens: [String] = []
            do {
                var urls: [URL] = []
                for (entry, name) in zip(entries, names) {
                    let (token, output) = try self.store.allocate(name)
                    tokens.append(token)
                    try self.linkOrCopy(entry.file, to: output)
                    urls.append(output)
                }
                let files = urls
                let staging = tokens
                DispatchQueue.main.async {
                    self.preparingShare = false
                    self.presentShare(files, staging: staging, id: id)
                }
            } catch {
                tokens.forEach(self.store.remove)
                DispatchQueue.main.async {
                    self.preparingShare = false
                    self.reply(id, error: error)
                }
            }
        }
    }

    private func presentShare(_ files: [URL], staging: [String], id: Any) {
        let share = UIActivityViewController(activityItems: files, applicationActivities: nil)
        if let popover = share.popoverPresentationController {
            popover.sourceView = view
            popover.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
            popover.permittedArrowDirections = []
        }
        share.completionWithItemsHandler = { [weak self] _, completed, _, error in
            guard let self else { return }
            staging.forEach(self.store.remove)
            self.reply(id, error: error ?? (completed ? nil : NativeError.cancelled))
        }
        present(share, animated: true)
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        guard let request = pickerRequest else { return }
        pickerRequest = nil
        if let token = request.exportToken { store.remove(token) }
        reply(request.id, error: NativeError.cancelled)
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let request = pickerRequest else { return }
        pickerRequest = nil
        if request.exporting {
            if let token = request.exportToken { store.remove(token) }
            reply(request.id)
            return
        }
        worker.async {
            do {
                let result = try self.importFiles(urls)
                DispatchQueue.main.async { self.reply(request.id, result: result) }
            } catch {
                DispatchQueue.main.async { self.reply(request.id, error: error) }
            }
        }
    }

    private func importFiles(_ urls: [URL]) throws -> [[String: Any]] {
        var tokens: [String] = []
        do {
            return try urls.map { source in
                let scoped = source.startAccessingSecurityScopedResource()
                defer { if scoped { source.stopAccessingSecurityScopedResource() } }
                let (token, file) = try store.allocate(source.lastPathComponent)
                tokens.append(token)
                try FileManager.default.copyItem(at: source, to: file)
                return try store.register(token, url: file, type: FileStore.mime(source)).descriptor
            }
        } catch {
            tokens.forEach(store.remove)
            throw error
        }
    }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard let id = photoPickerID else { return }
        if results.isEmpty {
            photoPickerID = nil
            reply(id, error: NativeError.cancelled)
            return
        }
        // NSItemProvider's temporary URL is valid only inside its completion handler.
        importNextPhoto(results.map(\.itemProvider), at: 0, files: [], id: id)
    }

    private func importNextPhoto(_ providers: [NSItemProvider], at index: Int, files: [LocalFile], id: Any) {
        guard index < providers.count else {
            photoPickerID = nil
            reply(id, result: files.map(\.descriptor))
            return
        }
        let provider = providers[index]
        guard let identifier = provider.registeredTypeIdentifiers.first(where: {
            guard let type = UTType($0) else { return false }
            return type.conforms(to: .image) || type.conforms(to: .movie)
        }) else {
            photoImportFailed(id, files: files, error: NativeError("media", "Unable to read the selected media."))
            return
        }
        provider.loadFileRepresentation(forTypeIdentifier: identifier) { [weak self] source, error in
            guard let self else { return }
            do {
                guard let source else { throw error ?? NativeError.invalid }
                let ext = source.pathExtension.isEmpty ?
                    (UTType(identifier)?.preferredFilenameExtension ?? "") : source.pathExtension
                var name = provider.suggestedName ?? source.lastPathComponent
                if !ext.isEmpty, (name as NSString).pathExtension.lowercased() != ext.lowercased() {
                    name = (name as NSString).deletingPathExtension + "." + ext
                }
                let (token, destination) = try self.store.allocate(name)
                let entry: LocalFile
                do {
                    try self.linkOrCopy(source, to: destination)
                    entry = try self.store.register(token, url: destination, type: FileStore.mime(destination))
                } catch {
                    self.store.remove(token)
                    throw error
                }
                DispatchQueue.main.async {
                    self.importNextPhoto(providers, at: index + 1, files: files + [entry], id: id)
                }
            } catch {
                DispatchQueue.main.async { self.photoImportFailed(id, files: files, error: error) }
            }
        }
    }

    private func photoImportFailed(_ id: Any, files: [LocalFile], error: Error) {
        files.forEach { store.remove($0.token) }
        photoPickerID = nil
        reply(id, error: error)
    }

    private func compress(_ args: [String: Any], id: Any) throws {
        let token = try string("token", in: args)
        let jobID = try string("jobId", in: args)
        guard jobs[jobID] == nil, let profile = VideoProfile(rawValue: try string("profile", in: args)) else {
            throw NativeError.invalid
        }
        let target = (args["targetBytes"] as? NSNumber)?.int64Value
        if let target, !(1...FileStore.maxSize).contains(target) { throw NativeError.invalid }
        let entry = try store.pin(token)
        let job = VideoJob()
        jobs[jobID] = job
        let cache = store!
        Task {
            defer {
                jobs.removeValue(forKey: jobID)
                cache.unpin(token)
            }
            do {
                let result = try await job.compress(entry, store: cache, profile: profile, target: target) { value in
                    DispatchQueue.main.async {
                        self.send("__pocketspaceProgress", ["jobId": jobID, "fraction": value])
                    }
                }
                reply(id, result: result.descriptor)
            } catch {
                reply(id, error: error)
            }
        }
    }
}
