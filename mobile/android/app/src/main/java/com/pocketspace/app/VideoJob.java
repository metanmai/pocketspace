package com.pocketspace.app;

import android.content.Context;
import android.media.MediaMetadataRetriever;
import android.os.Handler;

import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.effect.FrameDropEffect;
import androidx.media3.effect.Presentation;
import androidx.media3.transformer.AudioEncoderSettings;
import androidx.media3.transformer.Composition;
import androidx.media3.transformer.DefaultEncoderFactory;
import androidx.media3.transformer.EditedMediaItem;
import androidx.media3.transformer.Effects;
import androidx.media3.transformer.ExportException;
import androidx.media3.transformer.ExportResult;
import androidx.media3.transformer.ProgressHolder;
import androidx.media3.transformer.Transformer;
import androidx.media3.transformer.VideoEncoderSettings;

import java.io.File;
import java.io.IOException;
import java.util.List;

@UnstableApi
final class VideoJob {
    interface Callback {
        void progress(double fraction, int attempt);
        void complete(File file);
        void failed(String code, String message);
    }

    record Preset(int edge, int fps, double density, double fraction) {
        static Preset get(String profile) {
            return switch (profile) {
                case "detail" -> new Preset(2560, 60, .085, .86);
                case "small" -> new Preset(1280, 30, .046, .54);
                default -> new Preset(1920, 30, .067, .72);
            };
        }
    }

    record Source(int width, int height, float fps, double duration, boolean audio) {
        static Source inspect(Context context, LocalFiles.Entry entry) throws IOException {
            MediaMetadataRetriever metadata = new MediaMetadataRetriever();
            try {
                metadata.setDataSource(context, entry.source());
                int width = Integer.parseInt(metadata.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH));
                int height = Integer.parseInt(metadata.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT));
                String rotation = metadata.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION);
                if ("90".equals(rotation) || "270".equals(rotation)) {
                    int originalWidth = width;
                    width = height;
                    height = originalWidth;
                }
                double duration = Long.parseLong(metadata.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)) / 1000.0;
                if (duration <= 0 || width <= 0 || height <= 0) throw new IOException("This video has no readable dimensions or duration.");
                String frameCount = metadata.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_FRAME_COUNT);
                String captureRate = metadata.extractMetadata(MediaMetadataRetriever.METADATA_KEY_CAPTURE_FRAMERATE);
                float fps = frameCount != null ? (float) (Long.parseLong(frameCount) / duration)
                        : captureRate != null ? Float.parseFloat(captureRate) : 0;
                boolean audio = "yes".equals(metadata.extractMetadata(MediaMetadataRetriever.METADATA_KEY_HAS_AUDIO));
                return new Source(width, height, fps, duration, audio);
            } finally {
                metadata.release();
            }
        }
    }

    private final Context context;
    private final Handler handler;
    private final LocalFiles files;
    final LocalFiles.Entry entry;
    private final Preset preset;
    private final long target;
    private final Callback callback;
    private Source source;
    private int presetBitrate;
    private int videoBitrate;
    private int audioBitrate;
    private double scale;
    private int attempt;
    private boolean finished;
    private File current;
    private File best;
    private Transformer transformer;

    VideoJob(Context context, Handler handler, LocalFiles files, LocalFiles.Entry entry,
             String profile, long target, Callback callback) {
        this.context = context;
        this.handler = handler;
        this.files = files;
        this.entry = entry;
        this.preset = Preset.get(profile);
        this.target = target;
        this.callback = callback;
    }

    void start(Source metadata) {
        if (finished) return;
        source = metadata;
        scale = Math.min(1, (double) preset.edge / Math.max(source.width, source.height));
        double fps = Math.min(preset.fps, source.fps > 0 ? source.fps : preset.fps);
        presetBitrate = (int) Math.max(180_000, Math.round(Math.min(
                (double) source.width * source.height * scale * scale * fps * preset.density,
                (entry.size * 8.0 / source.duration - (source.audio ? 128_000 : 0)) * preset.fraction)));
        double budget = target > 0 ? target * 8.0 * .94 / source.duration : Double.POSITIVE_INFINITY;
        audioBitrate = (int) Math.max(24_000, Math.min(128_000, budget * .22));
        videoBitrate = (int) Math.max(24_000, Math.min(presetBitrate, budget - (source.audio ? audioBitrate : 0)));
        encode();
    }

    private void encode() {
        attempt++;
        callback.progress(0, attempt);
        try {
            current = files.temporary();
            // Transformer creates the output itself.
            if (!current.delete()) throw new IOException("Couldn’t prepare the video output.");
            double targetScale = scale * Math.max(.12, Math.sqrt((double) videoBitrate / presetBitrate));
            int width = Math.max(2, (int) Math.round(source.width * targetScale / 2) * 2);
            int height = Math.max(2, (int) Math.round(source.height * targetScale / 2) * 2);
            var presentation = Presentation.createForWidthAndHeight(width, height, Presentation.LAYOUT_SCALE_TO_FIT);
            List<androidx.media3.common.Effect> effects = source.fps > preset.fps * 1.02
                    ? List.of(presentation, FrameDropEffect.createDefaultFrameDropEffect(preset.fps)) : List.of(presentation);
            var edited = new EditedMediaItem.Builder(MediaItem.fromUri(entry.source()))
                    .setEffects(new Effects(List.of(), effects))
                    .build();
            var encoder = new DefaultEncoderFactory.Builder(context)
                    .setRequestedVideoEncoderSettings(new VideoEncoderSettings.Builder().setBitrate(videoBitrate).build())
                    .setRequestedAudioEncoderSettings(new AudioEncoderSettings.Builder().setBitrate(audioBitrate).build())
                    .build();
            transformer = new Transformer.Builder(context)
                    .setVideoMimeType(MimeTypes.VIDEO_H264)
                    .setAudioMimeType(MimeTypes.AUDIO_AAC)
                    .setEncoderFactory(encoder)
                    .addListener(new Transformer.Listener() {
                        @Override public void onCompleted(Composition composition, ExportResult result) {
                            if (finished) return;
                            if (result.videoFrameCount <= 0 || (source.audio && result.audioMimeType == null)) {
                                failedAttempt();
                                return;
                            }
                            completedAttempt();
                        }

                        @Override public void onError(Composition composition, ExportResult result, ExportException exception) {
                            failedAttempt();
                        }
                    })
                    .build();
            transformer.start(edited, current.getAbsolutePath());
            handler.postDelayed(poll, 150);
        } catch (IOException | RuntimeException error) {
            failedAttempt();
        }
    }

    private final Runnable poll = new Runnable() {
        @Override public void run() {
            if (finished || transformer == null) return;
            var progress = new ProgressHolder();
            if (transformer.getProgress(progress) == Transformer.PROGRESS_STATE_AVAILABLE) {
                callback.progress(progress.progress / 100.0, attempt);
            }
            handler.postDelayed(this, 150);
        }
    };

    private void completedAttempt() {
        handler.removeCallbacks(poll);
        long size = current.length();
        if (size == 0) {
            failedAttempt();
            return;
        }
        if (best == null || size < best.length()) {
            if (best != null) best.delete();
            best = current;
        } else {
            current.delete();
        }
        current = null;
        if (target <= 0 || best.length() <= target || attempt == 3 || videoBitrate <= 24_000) {
            complete();
        } else {
            videoBitrate = (int) Math.max(24_000, videoBitrate * Math.min(.85, target / (double) size * .9));
            encode();
        }
    }

    private void failedAttempt() {
        if (finished) return;
        handler.removeCallbacks(poll);
        if (current != null) current.delete();
        current = null;
        if (best != null) complete();
        else fail("video", "Android couldn’t encode this video with its audio.");
    }

    private void complete() {
        finished = true;
        callback.progress(1, attempt);
        callback.complete(best);
    }

    void fail(String code, String message) {
        if (finished) return;
        finished = true;
        handler.removeCallbacks(poll);
        if (transformer != null) transformer.cancel();
        if (current != null) current.delete();
        if (best != null) best.delete();
        callback.failed(code, message);
    }
}
