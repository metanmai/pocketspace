const iosTransport = globalThis.window?.webkit?.messageHandlers?.pocketspace;
const transport = globalThis.window?.PocketspaceNative ?? iosTransport;
export const mobile = Boolean(transport);
export const mobilePlatform = iosTransport ? 'ios' : mobile ? 'android' : undefined;
export const nativeVideo = mobile && window.pocketspaceMobileCapabilities?.nativeVideo !== false;
const chunkSize = 256 * 1024;
const pending = new Map();
const progressListeners = new Map();
let sequence = 0;

if (mobile) {
  document.documentElement.classList.add('native-mobile');
  window.__pocketspaceReply = ({ id, result, error }) => {
    const request = pending.get(String(id));
    if (!request) return;
    pending.delete(String(id));
    if (error?.code === 'cancelled') request.reject(new DOMException(error.message, 'AbortError'));
    else if (error) request.reject(new Error(error.message));
    else request.resolve(result);
  };
  window.__pocketspaceProgress = ({ jobId, fraction, attempt }) => {
    progressListeners.get(String(jobId))?.(fraction, attempt);
  };
}

function request(method, args = {}) {
  const id = String(++sequence);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      transport.postMessage(JSON.stringify({ id, method, args }));
    } catch (error) {
      pending.delete(id);
      reject(error);
    }
  });
}

function encode(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

function decode(base64) {
  return Uint8Array.from(atob(base64), character => character.charCodeAt(0));
}

function nativeFile(descriptor) {
  const { token, size } = descriptor;
  return {
    ...descriptor,
    slice(start, end) {
      return {
        async arrayBuffer() {
          const limit = Math.min(size, end);
          const bytes = new Uint8Array(Math.max(0, limit - start));
          for (let offset = start; offset < limit; offset += chunkSize) {
            const length = Math.min(chunkSize, limit - offset);
            const { base64 } = await request('readChunk', { token, offset, length });
            const chunk = decode(base64);
            if (chunk.length !== length) throw new Error('The file could not be read completely.');
            bytes.set(chunk, offset - start);
          }
          return bytes.buffer;
        },
      };
    },
  };
}

export function mediaUrl(file) {
  return file.token ? file.url : URL.createObjectURL(file);
}

export function revokeMediaUrl(url) {
  if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
}

export async function asBlob(file, signal) {
  if (!file.token) return file;
  const parts = [];
  for (let offset = 0; offset < file.size; offset += chunkSize) {
    signal.throwIfAborted();
    parts.push(await file.slice(offset, offset + chunkSize).arrayBuffer());
  }
  signal.throwIfAborted();
  return new Blob(parts, { type: file.type });
}

export async function pickFiles(mediaOnly) {
  return (await request(mediaOnly ? 'pickMedia' : 'pickFiles')).map(nativeFile);
}

export function receiveSharedPhotos(onPhotos) {
  if (mobilePlatform !== 'android') return Promise.resolve();
  window.__pocketspaceSharedPhotos = ({ files, skipped }) => onPhotos(files.map(nativeFile), skipped);
  return request('readyForSharedPhotos');
}

export function releaseFile(file) {
  return file?.token ? request('release', { tokens: [file.token] }).catch(() => {}) : Promise.resolve();
}

export function playNative(file) {
  return request('preview', { token: file.token });
}

export async function digest(bytes) {
  if (globalThis.crypto?.subtle) return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const { base64 } = await request('digest', { base64: encode(new Uint8Array(bytes)) });
  return decode(base64);
}

async function createWriter(name, type, size) {
  const { token } = await request('beginWrite', { name, type, size });
  let offset = 0;
  return {
    async write(bytes, signal) {
      for (let start = 0; start < bytes.length; start += chunkSize) {
        signal?.throwIfAborted();
        const chunk = bytes.subarray(start, start + chunkSize);
        await request('writeChunk', { token, offset, base64: encode(chunk) });
        offset += chunk.length;
      }
    },
    async finish() {
      return nativeFile(await request('endWrite', { token }));
    },
    dispose: () => releaseFile({ token }),
  };
}

export async function createMobileDiskOutput() {
  const writer = await createWriter('Pocketspace.zip', 'application/zip', null);
  let file;
  return {
    writable: {
      write: writer.write,
      async close() { file = await writer.finish(); },
    },
    blob: () => file,
    dispose: writer.dispose,
  };
}

async function stage(file, name, signal) {
  if (file.token) return file;
  const writer = await createWriter(name, file.type || 'application/octet-stream', file.size);
  try {
    for (let offset = 0; offset < file.size; offset += chunkSize) {
      signal.throwIfAborted();
      const bytes = await file.slice(offset, offset + chunkSize).arrayBuffer();
      await writer.write(new Uint8Array(bytes), signal);
    }
    signal.throwIfAborted();
    return await writer.finish();
  } catch (error) {
    await writer.dispose();
    throw error;
  }
}

export async function checkPhotoLocation(file, signal) {
  const input = await stage(file, file.name, signal);
  try {
    signal.throwIfAborted();
    return await request('photoLocation', { token: input.token });
  } finally {
    if (input !== file) await releaseFile(input);
  }
}

export async function compressNativeVideo(file, profile, signal, update, targetBytes) {
  const input = await stage(file, file.name, signal);
  const jobId = String(++sequence);
  const cancel = () => { void request('cancel', { jobId }).catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  progressListeners.set(jobId, update);
  let output;
  try {
    signal.throwIfAborted();
    output = nativeFile(await request('compressVideo', {
      token: input.token, jobId, profile, targetBytes,
    }));
    signal.throwIfAborted();
    return { blob: output, extension: 'mp4', dispose: () => releaseFile(output) };
  } catch (error) {
    await releaseFile(output);
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    progressListeners.delete(jobId);
    if (input !== file) await releaseFile(input);
  }
}

export async function saveMobile(file, name, signal = new AbortController().signal) {
  const output = await stage(file, name, signal);
  try {
    signal.throwIfAborted();
    await request('save', { token: output.token, name, type: output.type });
  } finally {
    if (output !== file) await releaseFile(output);
  }
}

export async function shareMobile(entries, signal) {
  const staged = [];
  try {
    for (const { file, name } of entries) {
      signal.throwIfAborted();
      staged.push({ source: file, output: await stage(file, name, signal), name });
    }
    signal.throwIfAborted();
    await request('share', {
      tokens: staged.map(({ output }) => output.token),
      names: staged.map(({ name }) => name),
    });
  } finally {
    await Promise.all(staged.filter(({ source, output }) => source !== output)
      .map(({ output }) => releaseFile(output)));
  }
}
