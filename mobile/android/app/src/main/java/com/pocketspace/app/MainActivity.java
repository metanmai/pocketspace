package com.pocketspace.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.media.ExifInterface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.core.content.FileProvider;
import androidx.media3.common.util.UnstableApi;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@UnstableApi
public final class MainActivity extends Activity {
    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final String INDEX = ORIGIN + "/assets/index.html";
    private static final int PICK = 1;
    private static final int SAVE = 2;
    private static final long SHARE_MAX_AGE = 24 * 60 * 60 * 1000L;
    private static final Set<File> LIVE_SCRATCH = ConcurrentHashMap.newKeySet();
    private static final java.util.regex.Pattern XMP_LOCATION = java.util.regex.Pattern.compile(
            "GPS(?:Latitude|Longitude|Altitude)|Location(?:Shown|Created)|(?:photoshop:City|photoshop:State|photoshop:Country|Iptc4xmpCore:Location)",
            java.util.regex.Pattern.CASE_INSENSITIVE);
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Map<String, VideoJob> videos = new HashMap<>();
    private final Set<String> deferredReleases = new HashSet<>();
    private WebView web;
    private LocalFiles files;
    private File scratch;
    private String pickRequest;
    private int pickLimit;
    private String saveRequest;
    private LocalFiles.Entry saveEntry;
    private boolean closed;
    private boolean sharedPhotosReady;
    private final ArrayList<JSONObject> sharedPhotos = new ArrayList<>();

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        scratch = new File(getCacheDir(), "scratch/" + UUID.randomUUID());
        LIVE_SCRATCH.add(scratch);
        files = new LocalFiles(getContentResolver(), scratch);
        web = new WebView(this);
        web.setBackgroundColor(0xfff6f4ff);
        var root = new android.widget.FrameLayout(this);
        root.setBackgroundColor(0xfff6f4ff);
        root.addView(web, new android.widget.FrameLayout.LayoutParams(-1, -1));
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            var edges = insets.getInsets(android.view.WindowInsets.Type.systemBars()
                    | android.view.WindowInsets.Type.displayCutout() | android.view.WindowInsets.Type.ime());
            view.setPadding(edges.left, edges.top, edges.right, edges.bottom);
            return android.view.WindowInsets.CONSUMED;
        });
        setContentView(root);
        root.requestApplyInsets();
        getWindow().getDecorView().setSystemUiVisibility(
                android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | android.view.View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setBlockNetworkLoads(true);
        if ((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
        var assets = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return true;
            }

            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (!ORIGIN.equals(originOf(url))) return missing();
                String path = url.getPath();
                String method = request.getMethod();
                if (path != null && path.startsWith(LocalFiles.PREFIX) && !request.isForMainFrame()
                        && (method.equals("GET") || method.equals("HEAD"))) {
                    String range = null;
                    for (var entry : request.getRequestHeaders().entrySet()) {
                        if ("range".equalsIgnoreCase(entry.getKey())) range = entry.getValue();
                    }
                    try {
                        return files.response(path.substring(LocalFiles.PREFIX.length()), range, method.equals("HEAD"));
                    } catch (IOException | RuntimeException error) {
                        return missing();
                    }
                }
                if (method.equals("GET") && (!request.isForMainFrame() || INDEX.equals(url.toString()))) {
                    // Android's asset MIME map is inconsistent for ES modules.
                    if (path != null && path.startsWith("/assets/") && path.endsWith(".mjs")) {
                        String asset = path.substring("/assets/".length());
                        if (asset.contains("..") || asset.contains("\\")) return missing();
                        try {
                            return new WebResourceResponse("text/javascript", "UTF-8", getAssets().open(asset));
                        } catch (IOException error) {
                            return missing();
                        }
                    }
                    WebResourceResponse response = assets.shouldInterceptRequest(url);
                    if (response != null) return response;
                }
                return missing();
            }
        });
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(web, "PocketspaceNative", Set.of(ORIGIN),
                    (view, message, source, mainFrame, proxy) -> {
                        if (mainFrame && ORIGIN.equals(originOf(source)) && INDEX.equals(view.getUrl())) {
                            handle(message.getData());
                        }
                    });
            web.loadUrl(INDEX);
        } else {
            web.loadData("<h2>Pocketspace</h2><p>Update Android System WebView to open Pocketspace.</p>", "text/html", "UTF-8");
        }
        worker.execute(this::cleanCache);
        receivePhotos(getIntent());
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        receivePhotos(intent);
    }

    @SuppressWarnings("deprecation")
    private void receivePhotos(Intent intent) {
        if (intent == null || intent.getType() == null || !intent.getType().startsWith("image/")) return;
        var uris = new java.util.LinkedHashSet<Uri>();
        if (Intent.ACTION_SEND.equals(intent.getAction())) {
            if (intent.getParcelableExtra(Intent.EXTRA_STREAM) instanceof Uri uri) uris.add(uri);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) {
            ArrayList<?> streams = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (streams != null) {
                for (Object stream : streams) if (stream instanceof Uri uri) uris.add(uri);
            }
        } else {
            return;
        }
        ClipData clip = intent.getClipData();
        if (clip != null) {
            for (int index = 0; index < clip.getItemCount(); index++) uris.add(clip.getItemAt(index).getUri());
        }
        worker.execute(() -> {
            JSONArray imported = new JSONArray();
            int skipped = 0;
            for (Uri uri : uris) {
                LocalFiles.Entry entry = null;
                try {
                    if (uri != null && "content".equals(uri.getScheme())) {
                        String type = getContentResolver().getType(uri);
                        if (type != null && type.startsWith("image/")) entry = files.addUri(uri, true);
                        if (entry != null && entry.size > 0) {
                            imported.put(entry.descriptor(ORIGIN));
                            continue;
                        }
                    }
                } catch (IOException | JSONException | RuntimeException ignored) {}
                if (entry != null) files.release(entry.token);
                skipped++;
            }
            try {
                JSONObject batch = new JSONObject().put("files", imported).put("skipped", Math.max(skipped, uris.isEmpty() ? 1 : 0));
                main.post(() -> {
                    if (closed) return;
                    if (sharedPhotosReady) emit("__pocketspaceSharedPhotos", batch);
                    else sharedPhotos.add(batch);
                });
            } catch (JSONException ignored) {}
        });
    }

    private static String originOf(Uri uri) {
        return uri.getScheme() + "://" + uri.getEncodedAuthority();
    }

    private static WebResourceResponse missing() {
        return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", Map.of(), null);
    }

    private void handle(String message) {
        if (closed || message == null || message.length() > 390_000) return;
        String id = null;
        try {
            JSONObject request = new JSONObject(message);
            id = request.getString("id");
            String method = request.getString("method");
            JSONObject args = request.optJSONObject("args");
            if (args == null) args = new JSONObject();
            switch (method) {
                case "readyForSharedPhotos" -> {
                    sharedPhotosReady = true;
                    reply(id, true, null, null);
                    for (JSONObject batch : sharedPhotos) emit("__pocketspaceSharedPhotos", batch);
                    sharedPhotos.clear();
                }
                case "pickFiles", "pickMedia" -> pick(id, args.optInt("limit", Integer.MAX_VALUE), method.equals("pickMedia"));
                case "save" -> save(id, args);
                case "share" -> share(id, args.getJSONArray("tokens"), args.optJSONArray("names"));
                case "preview" -> preview(id, args.getString("token"));
                case "compressVideo" -> compressVideo(id, args);
                case "cancel" -> {
                    VideoJob job = videos.get(args.getString("jobId"));
                    if (job != null) job.fail("cancelled", "Video compression cancelled.");
                    reply(id, true, null, null);
                }
                case "release" -> {
                    JSONArray tokens = args.getJSONArray("tokens");
                    for (int index = 0; index < tokens.length(); index++) release(tokens.getString(index));
                    reply(id, true, null, null);
                }
                case "beginWrite", "writeChunk", "endWrite", "readChunk", "photoLocation" -> {
                    String requestId = id;
                    JSONObject arguments = args;
                    worker.execute(() -> {
                        try {
                            reply(requestId, transfer(method, arguments), null, null);
                        } catch (IOException | JSONException | RuntimeException error) {
                            reply(requestId, null, "file", error.getMessage());
                        }
                    });
                }
                default -> reply(id, null, "method", "Unknown Pocketspace action.");
            }
        } catch (IOException | JSONException | RuntimeException error) {
            if (id != null) reply(id, null, "file", error.getMessage());
        }
    }

    private Object transfer(String method, JSONObject args) throws IOException, JSONException {
        return switch (method) {
            case "photoLocation" -> photoLocation(files.lookup(args.getString("token"), true));
            case "beginWrite" -> {
                var entry = files.begin(LocalFiles.safeName(args.getString("name")),
                        LocalFiles.safeType(args.getString("type")), args.optLong("size", -1));
                yield new JSONObject().put("token", entry.token);
            }
            case "writeChunk" -> {
                var entry = files.lookup(args.getString("token"), false);
                byte[] bytes = Base64.decode(args.getString("base64"), Base64.NO_WRAP);
                files.write(entry, args.getLong("offset"), bytes);
                yield true;
            }
            case "endWrite" -> {
                var entry = files.lookup(args.getString("token"), false);
                files.finish(entry);
                yield entry.descriptor(ORIGIN);
            }
            default -> {
                var entry = files.lookup(args.getString("token"), true);
                long offset = args.getLong("offset");
                int length = args.getInt("length");
                if (offset < 0 || offset > entry.size || length < 0 || length > LocalFiles.CHUNK) {
                    throw new IOException("Invalid file range.");
                }
                byte[] bytes = new byte[(int) Math.min(length, entry.size - offset)];
                int read = 0;
                if (bytes.length != 0) {
                    try (InputStream input = files.openAt(entry, offset)) {
                        while (read < bytes.length) {
                            int count = input.read(bytes, read, bytes.length - read);
                            if (count < 0) throw new IOException("The file ended early.");
                            read += count;
                        }
                    }
                }
                yield new JSONObject().put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP));
            }
        };
    }

    private String photoLocation(LocalFiles.Entry entry) {
        if (!Set.of("image/jpeg", "image/png", "image/webp", "image/heic", "image/heif").contains(entry.type)) {
            return "unknown";
        }
        try (InputStream input = files.open(entry)) {
            var exif = new ExifInterface(input);
            for (String tag : new String[]{ExifInterface.TAG_GPS_LATITUDE, ExifInterface.TAG_GPS_LONGITUDE,
                    ExifInterface.TAG_GPS_ALTITUDE, ExifInterface.TAG_GPS_DEST_LATITUDE,
                    ExifInterface.TAG_GPS_DEST_LONGITUDE, ExifInterface.TAG_GPS_AREA_INFORMATION}) {
                if (exif.hasAttribute(tag)) return "present";
            }
            String xmp = exif.getAttribute(ExifInterface.TAG_XMP);
            return xmp != null && XMP_LOCATION.matcher(xmp).find() ? "present" : "none";
        } catch (IOException | RuntimeException error) {
            return "unknown";
        }
    }

    private void pick(String id, int limit, boolean media) {
        if (pickRequest != null) {
            reply(id, null, "busy", "Files is already open.");
            return;
        }
        boolean opened = false;
        if (media && Build.VERSION.SDK_INT >= 33) {
            Intent picker = new Intent(android.provider.MediaStore.ACTION_PICK_IMAGES);
            if (limit > 1) picker.putExtra(android.provider.MediaStore.EXTRA_PICK_IMAGES_MAX,
                    Math.min(limit, android.provider.MediaStore.getPickImagesMaxLimit()));
            try {
                startActivityForResult(picker, PICK);
                opened = true;
            } catch (android.content.ActivityNotFoundException ignored) {}
        }
        if (!opened) {
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                    .setType("*/*").putExtra(Intent.EXTRA_ALLOW_MULTIPLE, limit > 1)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            if (media) intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"image/*", "video/*"});
            startActivityForResult(intent, PICK);
        }
        pickRequest = id;
        pickLimit = Math.max(0, limit);
    }

    private void save(String id, JSONObject args) throws IOException, JSONException {
        if (saveRequest != null) {
            reply(id, null, "busy", "Files is already open.");
            return;
        }
        var entry = files.lookup(args.getString("token"), true);
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                .setType(LocalFiles.safeType(args.optString("type", entry.type)))
                .putExtra(Intent.EXTRA_TITLE, LocalFiles.safeName(args.optString("name", entry.name)))
                .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        startActivityForResult(intent, SAVE);
        saveRequest = id;
        saveEntry = entry;
    }

    @Override protected void onActivityResult(int request, int status, Intent data) {
        super.onActivityResult(request, status, data);
        if (request == PICK && pickRequest != null) {
            String id = pickRequest;
            pickRequest = null;
            int limit = pickLimit;
            if (status != RESULT_OK || data == null) {
                reply(id, null, "cancelled", "File selection cancelled.");
                return;
            }
            ClipData selection = data.getClipData();
            ArrayList<Uri> uris = new ArrayList<>();
            if (selection != null) {
                for (int index = 0; index < Math.min(limit, selection.getItemCount()); index++) {
                    Uri uri = selection.getItemAt(index).getUri();
                    if (uri != null && !uris.contains(uri)) uris.add(uri);
                }
            } else if (data.getData() != null && limit > 0) {
                uris.add(data.getData());
            }
            worker.execute(() -> {
                JSONArray results = new JSONArray();
                ArrayList<String> registered = new ArrayList<>();
                try {
                    for (Uri uri : uris) {
                        LocalFiles.Entry entry = files.addUri(uri);
                        registered.add(entry.token);
                        results.put(entry.descriptor(ORIGIN));
                    }
                    reply(id, results, null, null);
                } catch (IOException | JSONException | RuntimeException error) {
                    for (String token : registered) files.release(token);
                    reply(id, null, "file", error.getMessage());
                }
            });
        } else if (request == SAVE && saveRequest != null) {
            String id = saveRequest;
            var entry = saveEntry;
            saveRequest = null;
            saveEntry = null;
            Uri destination = data == null ? null : data.getData();
            if (status != RESULT_OK || destination == null) {
                reply(id, null, "cancelled", "Save cancelled.");
                releaseIfDeferred(entry.token);
                return;
            }
            worker.execute(() -> {
                try {
                    try (OutputStream output = getContentResolver().openOutputStream(destination, "wt")) {
                        if (output == null) throw new IOException("Couldn’t open the save location.");
                        copy(entry, output);
                    }
                    reply(id, true, null, null);
                } catch (IOException | RuntimeException error) {
                    reply(id, null, "save", error.getMessage());
                }
            });
            releaseIfDeferred(entry.token);
        }
    }

    private void share(String id, JSONArray tokens, JSONArray names) throws IOException, JSONException {
        if (tokens.length() < 1) throw new IOException("Choose files to share.");
        ArrayList<LocalFiles.Entry> entries = new ArrayList<>();
        for (int index = 0; index < tokens.length(); index++) entries.add(files.lookup(tokens.getString(index), true));
        worker.execute(() -> {
            File group = new File(new File(getCacheDir(), "shared"), UUID.randomUUID().toString());
            ArrayList<Uri> uris = new ArrayList<>();
            String commonType = LocalFiles.safeType(entries.get(0).type);
            try {
                for (int index = 0; index < entries.size(); index++) {
                    LocalFiles.Entry entry = entries.get(index);
                    if (!commonType.equals(LocalFiles.safeType(entry.type))) commonType = "*/*";
                    File itemDir = new File(group, UUID.randomUUID().toString());
                    if (!itemDir.mkdirs()) throw new IOException("Couldn’t prepare the share files.");
                    String name = names == null ? entry.name : names.optString(index, entry.name);
                    File item = new File(itemDir, LocalFiles.safeName(name));
                    try (OutputStream output = new java.io.FileOutputStream(item)) {
                        copy(entry, output);
                    }
                    uris.add(FileProvider.getUriForFile(this, getPackageName() + ".files", item));
                }
                String type = commonType;
                main.post(() -> launchShare(id, uris, type, group));
            } catch (IOException | RuntimeException error) {
                deleteTree(group);
                reply(id, null, "share", error.getMessage());
            }
        });
    }

    private void preview(String id, String token) throws IOException {
        var entry = files.lookup(token, true);
        android.widget.VideoView player = new android.widget.VideoView(this);
        android.widget.MediaController controller = new android.widget.MediaController(this);
        var dialog = new android.app.AlertDialog.Builder(this)
                .setTitle(entry.name)
                .setView(player)
                .setPositiveButton("Close", null)
                .create();
        player.setMediaController(controller);
        player.setOnErrorListener((media, what, extra) -> {
            dialog.dismiss();
            android.widget.Toast.makeText(this, "Android couldn’t play this video.", android.widget.Toast.LENGTH_LONG).show();
            return true;
        });
        dialog.setOnDismissListener(ignored -> player.stopPlayback());
        dialog.show();
        player.setVideoURI(entry.source());
        player.start();
        reply(id, true, null, null);
    }

    @Override public void onBackPressed() {
        if (web == null || !INDEX.equals(web.getUrl())) {
            super.onBackPressed();
            return;
        }
        web.evaluateJavascript("(() => { const dialog = [...document.querySelectorAll('dialog[open]')].at(-1);"
                + " if (!dialog) return false;"
                + " if (dialog.dispatchEvent(new Event('cancel', {cancelable:true}))) dialog.close(); return true; })()",
                closedDialog -> {
                    if (!"true".equals(closedDialog)) super.onBackPressed();
                });
    }

    private void launchShare(String id, ArrayList<Uri> uris, String type, File group) {
        if (closed) return;
        Intent intent = new Intent(uris.size() == 1 ? Intent.ACTION_SEND : Intent.ACTION_SEND_MULTIPLE)
                .setType(type).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        ClipData clip = ClipData.newRawUri("Pocketspace", uris.get(0));
        for (int index = 1; index < uris.size(); index++) clip.addItem(new ClipData.Item(uris.get(index)));
        intent.setClipData(clip);
        if (uris.size() == 1) intent.putExtra(Intent.EXTRA_STREAM, uris.get(0));
        else intent.putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
        try {
            startActivity(Intent.createChooser(intent, "Share files"));
            reply(id, true, null, null);
        } catch (RuntimeException error) {
            worker.execute(() -> deleteTree(group));
            reply(id, null, "share", error.getMessage());
        }
    }

    private void cleanCache() {
        File[] sessions = scratch.getParentFile().listFiles();
        if (sessions != null) {
            for (File session : sessions) {
                if (!LIVE_SCRATCH.contains(session)) deleteTree(session);
            }
        }
        File[] groups = new File(getCacheDir(), "shared").listFiles();
        if (groups == null) return;
        long cutoff = System.currentTimeMillis() - SHARE_MAX_AGE;
        for (File group : groups) if (group.lastModified() < cutoff) deleteTree(group);
    }

    private static void deleteTree(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        file.delete();
    }

    private void copy(LocalFiles.Entry entry, OutputStream output) throws IOException {
        try (InputStream input = files.open(entry)) {
            byte[] buffer = new byte[LocalFiles.CHUNK];
            int count;
            while ((count = input.read(buffer)) >= 0) output.write(buffer, 0, count);
        }
    }

    private void compressVideo(String id, JSONObject args) throws IOException, JSONException {
        String jobId = args.getString("jobId");
        if (videos.containsKey(jobId)) throw new IOException("This video is already being processed.");
        var entry = files.lookup(args.getString("token"), true);
        var job = new VideoJob(this, main, files, entry, args.optString("profile"), args.optLong("targetBytes"),
                new VideoJob.Callback() {
                    @Override public void progress(double fraction, int attempt) {
                        try {
                            emit("__pocketspaceProgress", new JSONObject().put("jobId", jobId).put("fraction", fraction).put("attempt", attempt));
                        } catch (JSONException ignored) {}
                    }

                    @Override public void complete(File file) {
                        videos.remove(jobId);
                        releaseIfDeferred(entry.token);
                        try {
                            String name = entry.name.replaceFirst("(?<=.)\\.[^.]+$", "") + "-compressed.mp4";
                            reply(id, files.addOutput(name, "video/mp4", file).descriptor(ORIGIN), null, null);
                        } catch (JSONException error) {
                            reply(id, null, "video", "Couldn’t read the video output.");
                        }
                    }

                    @Override public void failed(String code, String message) {
                        videos.remove(jobId);
                        releaseIfDeferred(entry.token);
                        reply(id, null, code, message);
                    }
                });
        videos.put(jobId, job);
        worker.execute(() -> {
            try {
                var source = VideoJob.Source.inspect(this, entry);
                main.post(() -> job.start(source));
            } catch (IOException | RuntimeException error) {
                main.post(() -> job.fail("video", "Android couldn’t open this video format."));
            }
        });
    }

    private void release(String token) {
        if (saveEntry != null && saveEntry.token.equals(token)) {
            deferredReleases.add(token);
            return;
        }
        for (VideoJob video : videos.values()) {
            if (video.entry.token.equals(token)) {
                deferredReleases.add(token);
                return;
            }
        }
        deferredReleases.remove(token);
        worker.execute(() -> files.release(token));
    }

    private void releaseIfDeferred(String token) {
        if (deferredReleases.contains(token)) release(token);
    }

    private void reply(String id, Object result, String code, String message) {
        try {
            JSONObject payload = new JSONObject().put("id", id);
            if (code == null) payload.put("result", result == null ? JSONObject.NULL : result);
            else payload.put("error", new JSONObject().put("code", code)
                    .put("message", message == null ? "Couldn’t complete this action." : message));
            emit("__pocketspaceReply", payload);
        } catch (JSONException ignored) {}
    }

    private void emit(String callback, JSONObject payload) {
        String json = JSONObject.quote(payload.toString()).replace("\u2028", "\\u2028").replace("\u2029", "\\u2029");
        main.post(() -> {
            if (!closed && INDEX.equals(web.getUrl())) {
                web.evaluateJavascript("window." + callback + "?.(JSON.parse(" + json + "));", null);
            }
        });
    }

    @Override protected void onDestroy() {
        closed = true;
        for (VideoJob job : new ArrayList<>(videos.values())) job.fail("cancelled", "Video compression cancelled.");
        worker.execute(() -> {
            try {
                files.clear();
                deleteTree(scratch);
            } finally {
                LIVE_SCRATCH.remove(scratch);
            }
        });
        worker.shutdown();
        web.destroy();
        super.onDestroy();
    }
}
