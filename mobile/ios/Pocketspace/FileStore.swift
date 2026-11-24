import CryptoKit
import Foundation
import UniformTypeIdentifiers
import WebKit

struct NativeError: Error {
    let code: String
    let message: String

    init(_ code: String, _ message: String) {
        self.code = code
        self.message = message
    }

    static let invalid = NativeError("invalid", "The file or request is invalid.")
    static let cancelled = NativeError("cancelled", "The operation was cancelled.")
}

struct LocalFile {
    let token: String
    let file: URL
    let type: String
    let size: Int64

    var descriptor: [String: Any] {
        let url = URL(string: "pocketspace://app/files/")!
            .appendingPathComponent(token).appendingPathComponent(file.lastPathComponent)
        return ["token": token, "name": file.lastPathComponent, "size": size,
                "type": type, "url": url.absoluteString]
    }
}

final class FileStore {
    static let chunkLimit = 256 * 1024
    static let maxSize: Int64 = 4_300_000_000

    private struct PendingWrite {
        let file: URL
        let type: String
        let expected: Int64?
        var offset: Int64
    }

    private let root: URL
    private let lock = NSLock()
    private var files: [String: LocalFile] = [:]
    private var writes: [String: PendingWrite] = [:]
    private var pins: [String: Int] = [:]
    private var deferredRemoval = Set<String>()

    init() throws {
        let cache = try FileManager.default.url(for: .cachesDirectory, in: .userDomainMask,
                                                appropriateFor: nil, create: true)
        root = cache.appendingPathComponent("PocketspaceSession", isDirectory: true)
        if FileManager.default.fileExists(atPath: root.path) {
            try FileManager.default.removeItem(at: root)
        }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    func allocate(_ name: String) throws -> (String, URL) {
        let token = UUID().uuidString
        let directory = root.appendingPathComponent(token, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        let cleaned = name.components(separatedBy: CharacterSet(charactersIn: "/\\:\0")
            .union(.controlCharacters)).joined(separator: "_")
        let path = cleaned as NSString
        let ext = path.pathExtension
        let suffix = ext.isEmpty || ext.utf8.count > 32 ? "" : "." + ext
        let stem = suffix.isEmpty ? cleaned : path.deletingPathExtension
        var filename = ""
        var remaining = 240 - suffix.utf8.count
        for character in stem {
            let length = String(character).utf8.count
            if length > remaining { break }
            filename.append(character)
            remaining -= length
        }
        if ["", ".", ".."].contains(filename) { filename = "Pocketspace-file" }
        filename += suffix
        return (token, directory.appendingPathComponent(filename, isDirectory: false))
    }

    func register(_ token: String, url: URL, type: String) throws -> LocalFile {
        let values = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
        guard values.isRegularFile == true, let size = values.fileSize else { throw NativeError.invalid }
        let entry = LocalFile(token: token, file: url, type: type, size: Int64(size))
        lock.lock()
        files[token] = entry
        lock.unlock()
        return entry
    }

    func get(_ token: String) throws -> LocalFile {
        lock.lock()
        defer { lock.unlock() }
        guard let file = files[token] else { throw NativeError.invalid }
        return file
    }

    func pin(_ token: String) throws -> LocalFile {
        lock.lock()
        defer { lock.unlock() }
        guard let file = files[token], !deferredRemoval.contains(token) else { throw NativeError.invalid }
        pins[token, default: 0] += 1
        return file
    }

    func unpin(_ token: String) {
        lock.lock()
        guard let count = pins[token] else {
            lock.unlock()
            return
        }
        if count > 1 {
            pins[token] = count - 1
            lock.unlock()
            return
        }
        pins.removeValue(forKey: token)
        let shouldRemove = deferredRemoval.remove(token) != nil
        if shouldRemove { files.removeValue(forKey: token) }
        lock.unlock()
        if shouldRemove { removeDirectory(token) }
    }

    func remove(_ token: String) {
        guard UUID(uuidString: token) != nil else { return }
        lock.lock()
        if pins[token] != nil {
            deferredRemoval.insert(token)
            lock.unlock()
            return
        }
        files.removeValue(forKey: token)
        writes.removeValue(forKey: token)
        lock.unlock()
        removeDirectory(token)
    }

    private func removeDirectory(_ token: String) {
        try? FileManager.default.removeItem(at: root.appendingPathComponent(token, isDirectory: true))
    }

    func begin(_ name: String, type: String, expected: Int64?) throws -> String {
        if let expected, !(0...Self.maxSize).contains(expected) { throw NativeError.invalid }
        let (token, url) = try allocate(name)
        guard FileManager.default.createFile(atPath: url.path, contents: nil) else {
            remove(token)
            throw NativeError("storage", "Unable to create a temporary file.")
        }
        lock.lock()
        writes[token] = PendingWrite(file: url, type: type, expected: expected, offset: 0)
        lock.unlock()
        return token
    }

    func append(_ token: String, offset: Int64, data: Data) throws {
        lock.lock()
        defer { lock.unlock() }
        guard var write = writes[token], offset == write.offset, data.count <= Self.chunkLimit,
              Int64(data.count) <= (write.expected ?? Self.maxSize) - offset else {
            throw NativeError.invalid
        }
        let handle = try FileHandle(forWritingTo: write.file)
        defer { try? handle.close() }
        try handle.seek(toOffset: UInt64(offset))
        try handle.write(contentsOf: data)
        write.offset += Int64(data.count)
        writes[token] = write
    }

    func finish(_ token: String) throws -> LocalFile {
        lock.lock()
        guard let write = writes[token], write.expected == nil || write.expected == write.offset else {
            lock.unlock()
            throw NativeError.invalid
        }
        writes.removeValue(forKey: token)
        lock.unlock()
        return try register(token, url: write.file, type: write.type)
    }

    func read(_ token: String, offset: Int64, length: Int) throws -> Data {
        let entry = try get(token)
        guard offset >= 0, offset <= entry.size, (0...Self.chunkLimit).contains(length),
              Int64(length) <= entry.size - offset else { throw NativeError.invalid }
        let handle = try FileHandle(forReadingFrom: entry.file)
        defer { try? handle.close() }
        try handle.seek(toOffset: UInt64(offset))
        return try handle.read(upToCount: length) ?? Data()
    }

    static func mime(_ file: URL) -> String {
        switch file.pathExtension.lowercased() {
        case "mjs", "js": return "text/javascript"
        case "css": return "text/css"
        case "html": return "text/html"
        default: return UTType(filenameExtension: file.pathExtension)?.preferredMIMEType
            ?? "application/octet-stream"
        }
    }

    static func safeMIME(_ value: String) -> String {
        value.range(of: "^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$", options: .regularExpression) == nil
            ? "application/octet-stream" : value
    }
}
