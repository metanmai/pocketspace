package com.pocketspace.app;

import android.content.ContentResolver;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.webkit.WebResourceResponse;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

final class LocalFiles {
    static final long LIMIT = 4_300_000_000L;
    static final int CHUNK = 256 * 1024;
    static final String PREFIX = "/local/";
    private final ContentResolver resolver;
    private final File directory;
    private final Map<String, Entry> entries = new ConcurrentHashMap<>();

    LocalFiles(ContentResolver resolver, File directory) {
        this.resolver = resolver;
        this.directory = directory;
    }

    static String safeName(String name) {
        String cleaned = name.replaceAll("[/\\\\\\p{Cntrl}]", "_").trim();
        if (cleaned.isEmpty() || cleaned.equals(".") || cleaned.equals("..")) return "Pocketspace";
        if (cleaned.getBytes(StandardCharsets.UTF_8).length <= 240) return cleaned;
        int dot = cleaned.lastIndexOf('.');
        String extension = dot > 0 ? cleaned.substring(dot) : "";
        if (extension.getBytes(StandardCharsets.UTF_8).length > 24) extension = "";
        int available = 240 - extension.getBytes(StandardCharsets.UTF_8).length;
        int end = 0;
        while (available > 0) {
            int next = cleaned.offsetByCodePoints(end, 1);
            int bytes = cleaned.substring(end, next).getBytes(StandardCharsets.UTF_8).length;
            if (bytes > available) break;
            available -= bytes;
            end = next;
        }
        return cleaned.substring(0, end) + extension;
    }

    static String safeType(String type) {
        return type.matches("[a-zA-Z0-9!#$&^_.+~-]+/[a-zA-Z0-9!#$&^_.+~-]+")
                ? type : "application/octet-stream";
    }

    Entry addUri(Uri uri) throws IOException {
        return addUri(uri, false);
    }

    Entry addUri(Uri uri, boolean copyLocally) throws IOException {
        if (!ContentResolver.SCHEME_CONTENT.equals(uri.getScheme())) throw new IOException("Choose a file from Files.");
        String name = "File";
        long size = -1;
        try (Cursor cursor = resolver.query(uri, new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                if (!cursor.isNull(0)) name = cursor.getString(0);
                if (!cursor.isNull(1)) size = cursor.getLong(1);
            }
        }
        String type = resolver.getType(uri);
        Entry entry = new Entry(name, type == null ? "" : type, size, uri, null, true);
        if (copyLocally || size < 0) {
            File local = temporary();
            try (InputStream input = open(entry); var output = new java.io.FileOutputStream(local)) {
                byte[] buffer = new byte[CHUNK];
                int count;
                long copied = 0;
                while ((count = input.read(buffer)) != -1) {
                    copied += count;
                    if (copied > LIMIT) throw new IOException("This file exceeds the mobile size limit.");
                    output.write(buffer, 0, count);
                }
            } catch (IOException | RuntimeException error) {
                local.delete();
                throw error;
            }
            entry = new Entry(name, entry.type, local.length(), null, local, true);
        }
        entries.put(entry.token, entry);
        return entry;
    }

    File temporary() throws IOException {
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Local scratch storage is unavailable.");
        return File.createTempFile("output-", ".tmp", directory);
    }

    Entry addOutput(String name, String type, File file) {
        Entry entry = new Entry(name, type, file.length(), null, file, true);
        entries.put(entry.token, entry);
        return entry;
    }

    Entry begin(String name, String type, long size) throws IOException {
        if (size < -1 || size > LIMIT) throw new IOException("This output exceeds the mobile size limit.");
        Entry entry = new Entry(name, type, size, null, temporary(), false);
        entries.put(entry.token, entry);
        return entry;
    }

    Entry lookup(String token, boolean ready) throws IOException {
        Entry entry = entries.get(token);
        if (entry == null || entry.ready != ready) throw new IOException("This file is no longer available.");
        return entry;
    }

    void write(Entry entry, long offset, byte[] bytes) throws IOException {
        long limit = entry.size < 0 ? LIMIT : entry.size;
        if (bytes.length > CHUNK || offset < 0 || offset != entry.file.length() || offset + bytes.length > limit) {
            throw new IOException("Invalid file chunk.");
        }
        try (RandomAccessFile output = new RandomAccessFile(entry.file, "rw")) {
            output.seek(offset);
            output.write(bytes);
        }
    }

    void finish(Entry entry) throws IOException {
        long written = entry.file.length();
        if (entry.size >= 0 && entry.size != written) throw new IOException("The output is incomplete.");
        entry.size = written;
        entry.ready = true;
    }

    InputStream open(Entry entry) throws IOException {
        InputStream stream = entry.file != null ? new FileInputStream(entry.file) : resolver.openInputStream(entry.uri);
        if (stream == null) throw new IOException("Couldn’t read the file.");
        return stream;
    }

    InputStream openAt(Entry entry, long offset) throws IOException {
        if (offset == 0) return open(entry);
        if (entry.file != null) {
            FileInputStream input = new FileInputStream(entry.file);
            try {
                input.getChannel().position(offset);
                return input;
            } catch (IOException error) {
                input.close();
                throw error;
            }
        }
        // Some providers expose pipes. Try seeking first and fall back to streaming.
        var descriptor = resolver.openAssetFileDescriptor(entry.uri, "r");
        if (descriptor != null) {
            FileInputStream input;
            try {
                input = descriptor.createInputStream();
            } catch (IOException error) {
                descriptor.close();
                throw error;
            }
            try {
                input.getChannel().position(descriptor.getStartOffset() + offset);
                return input;
            } catch (IOException error) {
                input.close();
            }
        }
        InputStream input = open(entry);
        try {
            long remaining = offset;
            while (remaining > 0) {
                long skipped = input.skip(remaining);
                if (skipped > 0) remaining -= skipped;
                else if (input.read() < 0) throw new IOException("The file ended early.");
                else remaining--;
            }
            return input;
        } catch (IOException error) {
            input.close();
            throw error;
        }
    }

    WebResourceResponse response(String token, String range, boolean head) throws IOException {
        Entry entry = lookup(token, true);
        long size = entry.size;
        long start = 0;
        long end = size - 1;
        boolean partial = range != null;
        Map<String, String> headers = new HashMap<>();
        headers.put("Accept-Ranges", "bytes");
        headers.put("Cache-Control", "no-store");
        headers.put("X-Content-Type-Options", "nosniff");
        // Prevent HTML or SVG picked from Files from becoming an active document on this origin.
        headers.put("Content-Security-Policy", "default-src 'none'; sandbox");
        if (partial) {
            try {
                if (!range.matches("bytes=[0-9]*-[0-9]*") || size == 0) throw new NumberFormatException();
                String[] bounds = range.substring(6).split("-", -1);
                if (bounds[0].isEmpty()) {
                    long suffix = Long.parseLong(bounds[1]);
                    if (suffix == 0) throw new NumberFormatException();
                    start = Math.max(0, size - suffix);
                } else {
                    start = Long.parseLong(bounds[0]);
                    if (!bounds[1].isEmpty()) end = Math.min(end, Long.parseLong(bounds[1]));
                }
                if (start >= size || end < start) throw new NumberFormatException();
            } catch (NumberFormatException error) {
                headers.put("Content-Range", "bytes */" + size);
                return new WebResourceResponse("text/plain", null, 416, "Range Not Satisfiable", headers, null);
            }
            headers.put("Content-Range", "bytes " + start + "-" + end + "/" + size);
        }
        long length = end - start + 1;
        headers.put("Content-Length", Long.toString(length));
        String mime = safeType(entry.type);
        return new WebResourceResponse(mime, null, partial ? 206 : 200, partial ? "Partial Content" : "OK",
                headers, head ? null : new RangeStream(openAt(entry, start), start, length));
    }

    void release(String token) {
        Entry entry = entries.remove(token);
        if (entry != null && entry.file != null) entry.file.delete();
    }

    void clear() {
        for (String token : entries.keySet()) release(token);
        directory.delete();
    }

    static final class Entry {
        final String token = UUID.randomUUID().toString();
        final String name;
        final String type;
        final Uri uri;
        final File file;
        volatile long size;
        volatile boolean ready;

        Entry(String name, String type, long size, Uri uri, File file, boolean ready) {
            this.name = name;
            this.type = type;
            this.size = size;
            this.uri = uri;
            this.file = file;
            this.ready = ready;
        }

        JSONObject descriptor(String origin) throws JSONException {
            return new JSONObject().put("token", token).put("name", name).put("type", type)
                    .put("size", size).put("url", origin + PREFIX + token);
        }

        Uri source() {
            return file == null ? uri : Uri.fromFile(file);
        }
    }

    private static final class RangeStream extends FilterInputStream {
        // WebView seeks to the requested offset even for an intercepted 206 response.
        // Absorb that seek because the underlying file is already positioned there.
        private long webViewOffset;
        private long remaining;

        RangeStream(InputStream stream, long webViewOffset, long remaining) {
            super(stream);
            this.webViewOffset = webViewOffset;
            this.remaining = remaining;
        }

        @Override public int read() throws IOException {
            webViewOffset = 0;
            if (remaining == 0) return -1;
            int value = in.read();
            if (value >= 0) remaining--;
            return value;
        }

        @Override public int read(byte[] bytes, int offset, int length) throws IOException {
            if (length == 0) return 0;
            webViewOffset = 0;
            if (remaining == 0) return -1;
            int count = in.read(bytes, offset, (int) Math.min(remaining, length));
            if (count > 0) remaining -= count;
            return count;
        }

        @Override public long skip(long length) throws IOException {
            if (length <= 0) return 0;
            if (webViewOffset > 0) {
                long skipped = Math.min(Math.min(length, webViewOffset), Integer.MAX_VALUE);
                webViewOffset -= skipped;
                return skipped;
            }
            long skipped = in.skip(Math.min(remaining, length));
            remaining -= skipped;
            return skipped;
        }

        @Override public int available() throws IOException {
            long length = webViewOffset + remaining;
            // WebView treats zero as an unknown stream size and uses the response headers.
            return length > Integer.MAX_VALUE ? 0 : (int) length;
        }
    }
}
