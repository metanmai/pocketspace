import { compressFileToZip } from './archive.mjs';
import { createDiskOutput, diskThreshold } from './output.mjs';

export const zipInputLimit = 4e9;
const photoPixelLimit = 64_000_000;

export const profiles = {
  detail: { photoEdge: 3600, photoQuality: .91, videoEdge: 2560, fps: 60, bitsPerPixel: .085, fraction: .86 },
  balanced: { photoEdge: 2560, photoQuality: .83, videoEdge: 1920, fps: 30, bitsPerPixel: .067, fraction: .72 },
  small: { photoEdge: 1600, photoQuality: .72, videoEdge: 1280, fps: 30, bitsPerPixel: .046, fraction: .54 },
};

export class MediaError extends Error {}

async function isAnimated(file) {
  const extension = file.name.split('.').at(-1).toLowerCase();
  if (file.type === 'image/gif' || ['gif', 'apng'].includes(extension)) return true;
  const header = new DataView(await file.slice(0, 33).arrayBuffer());
  if (header.byteLength < 21) return false;
  if (header.getUint32(0) === 0x52494646 && header.getUint32(8) === 0x57454250) {
    return header.getUint32(12) === 0x56503858 && Boolean(header.getUint8(20) & 2);
  }
  if (header.getUint32(0) !== 0x89504e47) return false;

  // APNG places its animation control chunk before the first image data chunk.
  for (let offset = 8; offset + 8 <= file.size;) {
    const chunk = new DataView(await file.slice(offset, offset + 8).arrayBuffer());
    const type = chunk.getUint32(4);
    if (type === 0x6163544c) return true;
    if (type === 0x49444154 || type === 0x49454e44) return false;
    offset += chunk.getUint32(0) + 12;
  }
  return false;
}

async function photo(file, profile, signal, targetBytes) {
  if (await isAnimated(file)) throw new MediaError('Animated images are skipped to preserve motion.');
  signal.throwIfAborted();
  const url = URL.createObjectURL(file);
  const image = new Image();
  const canvas = document.createElement('canvas');
  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new MediaError('This browser couldn’t open the photo format.'));
      image.src = url;
    });
    signal.throwIfAborted();
    if (image.naturalWidth * image.naturalHeight > photoPixelLimit) {
      throw new MediaError('This photo exceeds 64 megapixels. Try Lossless ZIP or resize the photo first.');
    }
    await image.decode().catch(() => {
      throw new MediaError('This browser couldn’t open the photo format.');
    });
    signal.throwIfAborted();
    let scale = Math.min(1, profile.photoEdge / Math.max(image.naturalWidth, image.naturalHeight));
    const context = canvas.getContext('2d');
    // JPEG is broadly compatible. WebP preserves transparency for other inputs.
    const jpeg = /\.(jpe?g|hei[cf])$/i.test(file.name) || /image\/(jpeg|hei[cf])$/.test(file.type);
    const mime = jpeg ? 'image/jpeg' : 'image/webp';
    function draw() {
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      context.imageSmoothingQuality = 'high';
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
    }
    async function encode(quality) {
      signal.throwIfAborted();
      const candidate = await new Promise(resolve => canvas.toBlob(resolve, mime, quality));
      signal.throwIfAborted();
      if (!candidate?.size) throw new MediaError('This browser couldn’t export the photo.');
      return candidate;
    }

    draw();
    let blob = await encode(profile.photoQuality);
    if (targetBytes && blob.size > targetBytes) {
      // Try reducing encoding quality before reducing the image dimensions.
      const minimumQuality = .35;
      for (let attempt = 0; attempt < 6; attempt++) {
        const minimum = await encode(minimumQuality);
        if (minimum.size < blob.size) blob = minimum;
        if (minimum.size <= targetBytes) {
          let low = minimumQuality;
          let high = profile.photoQuality;
          for (let step = 0; step < 6; step++) {
            const quality = (low + high) / 2;
            const candidate = await encode(quality);
            if (candidate.size <= targetBytes) {
              blob = candidate;
              low = quality;
            } else {
              high = quality;
            }
          }
          break;
        }
        if (attempt === 5 || Math.max(canvas.width, canvas.height) === 1) break;
        scale *= Math.max(.15, Math.min(.8, Math.sqrt(targetBytes / minimum.size) * .9));
        draw();
        const resized = await encode(profile.photoQuality);
        if (resized.size < blob.size) blob = resized;
        if (resized.size <= targetBytes) break;
      }
    }
    const extension = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/png': 'png' }[blob.type];
    return { blob, extension };
  } finally {
    canvas.width = canvas.height = 1;
    URL.revokeObjectURL(url);
  }
}

async function video(file, profile, signal, update, targetBytes) {
  if (!('VideoEncoder' in window) || !('VideoDecoder' in window)) {
    throw new MediaError('Video compression needs a browser with WebCodecs support.');
  }
  const {
    ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, Mp4OutputFormat, Output, Quality, StreamTarget, WebMOutputFormat,
  } = await import('./vendor/mediabunny.mjs');
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  try {
    const [track, audio] = await Promise.all([input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack()]);
    if (!track || !await track.canDecode()) throw new MediaError('This browser can’t decode the video codec.');
    const [width, height, duration, stats] = await Promise.all([
      track.getDisplayWidth(), track.getDisplayHeight(), input.computeDuration(), track.computePacketStats(80),
    ]);
    signal.throwIfAborted();
    if (!Number.isFinite(duration) || duration <= 0) throw new MediaError('This video has no readable duration.');
    const scale = Math.min(1, profile.videoEdge / Math.max(width, height));
    const fps = Math.min(profile.fps, stats.averagePacketRate || profile.fps);
    const presetBitrate = Math.max(180_000, Math.round(Math.min(
      width * height * scale ** 2 * fps * profile.bitsPerPixel,
      (file.size * 8 / duration - (audio ? 128_000 : 0)) * profile.fraction,
    )));
    const budget = targetBytes ? targetBytes * 8 * .94 / duration : Infinity;
    const audioBitrate = Math.max(24_000, Math.min(128_000, Math.round(budget * .22)));
    let bitrate = Math.max(24_000, Math.min(presetBitrate, Math.round(budget - (audio ? audioBitrate : 0))));
    const useDisk = file.size >= diskThreshold;
    const formats = [
      { format: new Mp4OutputFormat(useDisk ? { fastStart: false } : {}), extension: 'mp4', mime: 'video/mp4', codec: 'avc', audioCodec: 'aac' },
      { format: new WebMOutputFormat(), extension: 'webm', mime: 'video/webm', codec: 'vp9', audioCodec: 'opus' },
    ];

    async function encode(attempt) {
      const targetScale = scale * Math.max(.12, Math.sqrt(bitrate / presetBitrate));
      const size = width >= height
        ? { width: Math.max(2, Math.round(width * targetScale / 2) * 2) }
        : { height: Math.max(2, Math.round(height * targetScale / 2) * 2) };
      for (const { format, extension, mime, codec, audioCodec } of formats) {
        signal.throwIfAborted();
        const disk = useDisk ? await createDiskOutput().catch(() => {
          throw new MediaError('Local scratch storage is unavailable for this video.');
        }) : undefined;
        const target = disk ? new StreamTarget(disk.writable, { chunked: true }) : new BufferTarget();
        const output = new Output({ format, target });
        let conversion;
        let completed = false;
        const cancel = () => { void conversion.cancel().catch(() => {}); };
        try {
          conversion = await Conversion.init({
            input,
            output,
            tracks: 'primary',
            tags: {},
            video: {
              ...size,
              ...(stats.averagePacketRate > profile.fps * 1.02 ? { frameRate: profile.fps } : {}),
              codec,
              quality: new Quality({ bitrate }),
              forceTranscode: true,
              allowTransformationMetadata: false,
            },
            audio: { codec: audioCodec, quality: new Quality({ bitrate: audioBitrate }) },
          });
          signal.throwIfAborted();
          if (!conversion.isValid || !conversion.utilizedTracks.includes(track)
            || (audio && !conversion.utilizedTracks.includes(audio))) continue;
          signal.addEventListener('abort', cancel, { once: true });
          conversion.onProgress = fraction => update(fraction, attempt);
          await conversion.execute();
          signal.throwIfAborted();
          const blob = disk ? await disk.blob(mime) : target.buffer && new Blob([target.buffer], { type: mime });
          if (blob?.size) {
            completed = true;
            return { blob, extension, dispose: disk?.dispose };
          }
        } catch (error) {
          signal.throwIfAborted();
          console.warn(`Could not encode ${extension}.`, error);
        } finally {
          signal.removeEventListener('abort', cancel);
          if (conversion?.state === 'executing') await conversion.cancel().catch(() => {});
          if (!completed) await disk?.dispose();
        }
        update(0, attempt);
      }
      throw new MediaError('This browser couldn’t encode the video with its audio.');
    }

    let best;
    try {
      for (let attempt = 1; attempt <= 3; attempt++) {
        update(0, attempt);
        let result;
        try {
          result = await encode(attempt);
        } catch (error) {
          signal.throwIfAborted();
          if (!best) throw error;
          break;
        }
        if (!best || result.blob.size < best.blob.size) {
          await best?.dispose?.();
          best = result;
        } else {
          await result.dispose?.();
        }
        if (!targetBytes || best.blob.size <= targetBytes || bitrate === 24_000) break;
        bitrate = Math.max(24_000, Math.floor(bitrate * Math.min(.85, targetBytes / result.blob.size * .9)));
      }
      return best;
    } catch (error) {
      await best?.dispose?.();
      throw error;
    }
  } finally {
    input.dispose();
  }
}

export async function compress(file, kind, profileName, signal, update, targetBytes) {
  const profile = profiles[profileName];
  let result;
  if (kind === 'zip') {
    if (file.size >= zipInputLimit) throw new MediaError('Lossless ZIP supports files under 4 GB.');
    try {
      result = { ...await compressFileToZip(file, profileName, signal, update), extension: 'zip' };
    } catch (error) {
      signal.throwIfAborted();
      throw new MediaError('Couldn’t create the ZIP. Check available disk space and try again.');
    }
  } else {
    result = await (kind === 'photo' ? photo(file, profile, signal, targetBytes) : video(file, profile, signal, update, targetBytes));
  }
  if (signal.aborted || result.blob.size >= file.size) await result.dispose?.();
  signal.throwIfAborted();
  if (result.blob.size >= file.size) return null;
  const baseName = file.name.replace(/(?<=.)\.[^.]+$/, '') || 'File';
  return { ...result, name: `${baseName}-compressed.${result.extension}` };
}
