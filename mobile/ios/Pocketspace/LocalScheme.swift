import Foundation
import WebKit

final class LocalScheme: NSObject, WKURLSchemeHandler {
    private let assets: URL
    private let store: FileStore
    private let worker = DispatchQueue(label: "pocketspace.scheme", qos: .userInitiated, attributes: .concurrent)
    private var active = Set<ObjectIdentifier>()

    init(assets: URL, store: FileStore) {
        self.assets = assets
        self.store = store
    }

    static func isLocal(_ url: URL?) -> Bool {
        url?.scheme == "pocketspace" && url?.host == "app" && url?.port == nil &&
            url?.user == nil && url?.password == nil
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let key = ObjectIdentifier(task)
        active.insert(key)
        worker.async {
            do {
                try self.serve(task, key: key)
            } catch {
                _ = self.deliver(key, terminal: true) {
                    task.didFailWithError(URLError(.resourceUnavailable))
                }
            }
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        active.remove(ObjectIdentifier(task))
    }

    private func deliver(_ key: ObjectIdentifier, terminal: Bool = false, _ action: () -> Void) -> Bool {
        DispatchQueue.main.sync {
            guard active.contains(key) else { return false }
            if terminal { active.remove(key) }
            action()
            return true
        }
    }

    private func serve(_ task: WKURLSchemeTask, key: ObjectIdentifier) throws {
        let request = task.request
        guard let url = request.url, Self.isLocal(url),
              ["GET", "HEAD"].contains(request.httpMethod ?? "GET") else { throw NativeError.invalid }
        let parts = url.pathComponents.dropFirst()
        let file: URL
        let type: String
        let size: Int64
        if parts.first == "files" {
            guard parts.count == 3 else { throw NativeError.invalid }
            let entry = try store.get(parts[parts.index(after: parts.startIndex)])
            guard parts.last == entry.file.lastPathComponent else { throw NativeError.invalid }
            (file, type, size) = (entry.file, entry.type, entry.size)
        } else {
            guard !parts.contains(where: { $0 == "." || $0 == ".." || $0.contains("/") }) else {
                throw NativeError.invalid
            }
            file = parts.isEmpty ? assets.appendingPathComponent("index.html") :
                parts.reduce(assets) { $0.appendingPathComponent($1) }
            let values = try file.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
            guard values.isRegularFile == true, let bytes = values.fileSize else { throw NativeError.invalid }
            (type, size) = (FileStore.mime(file), Int64(bytes))
        }
        var status = 200
        var start: Int64 = 0
        var end = size - 1
        var headers = [
            "Content-Type": type, "Accept-Ranges": "bytes", "Access-Control-Allow-Origin": "*",
            "Access-Control-Expose-Headers": "Content-Length, Content-Range",
            "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; script-src 'self' pocketspace:; style-src 'self' 'unsafe-inline' pocketspace:; img-src 'self' pocketspace: blob: data:; media-src 'self' pocketspace: blob:; connect-src 'self' pocketspace: blob:; worker-src 'self' pocketspace: blob:; base-uri 'none'; form-action 'none'; frame-src 'none'"
        ]
        if let range = request.value(forHTTPHeaderField: "Range") {
            if let bounds = Self.bounds(range, size: size) {
                (start, end) = bounds
                status = 206
                headers["Content-Range"] = "bytes \(start)-\(end)/\(size)"
            } else {
                status = 416
                end = -1
                headers["Content-Range"] = "bytes */\(size)"
            }
        }
        headers["Content-Length"] = String(end - start + 1)
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        guard deliver(key, { task.didReceive(response) }) else { return }
        if request.httpMethod != "HEAD", end >= start {
            let handle = try FileHandle(forReadingFrom: file)
            defer { try? handle.close() }
            try handle.seek(toOffset: UInt64(start))
            var remaining = end - start + 1
            while remaining > 0 {
                guard let data = try handle.read(upToCount: Int(min(remaining, Int64(FileStore.chunkLimit)))),
                      !data.isEmpty else { throw NativeError.invalid }
                guard deliver(key, { task.didReceive(data) }) else { return }
                remaining -= Int64(data.count)
            }
        }
        _ = deliver(key, terminal: true) { task.didFinish() }
    }

    private static func bounds(_ range: String, size: Int64) -> (Int64, Int64)? {
        guard size > 0, range.hasPrefix("bytes=") else { return nil }
        let parts = range.dropFirst(6).split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 2 else { return nil }
        if parts[0].isEmpty, let count = Int64(parts[1]), count > 0 {
            return (max(0, size - count), size - 1)
        }
        guard let start = Int64(parts[0]), start >= 0, start < size else { return nil }
        if parts[1].isEmpty { return (start, size - 1) }
        guard let end = Int64(parts[1]), end >= start else { return nil }
        return (start, min(end, size - 1))
    }
}
