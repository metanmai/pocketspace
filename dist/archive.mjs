import { createDiskOutput, diskThreshold } from './output.mjs';

export const zipLimit = 400e6;
const chunkBytes = 1024 * 1024;
const contentIds = new WeakMap();

export function availableItems(items, variant) {
  return items.filter(item => variant === 'originals' ? item.kind && item.file.size : item.result);
}

export function variantFile(item, variant) {
  if (variant === 'originals') return item.file;
  return new File([item.result.blob], item.result.name, { type: item.result.blob.type });
}

function safeName(name) {
  const cleaned = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^[. ]+|[. ]+$/g, '');
  const dot = cleaned.lastIndexOf('.');
  const suffix = dot > 0 ? cleaned.slice(dot, dot + 16) : '';
  const stem = (suffix ? cleaned.slice(0, dot) : cleaned).slice(0, 80) || 'Media';
  return { stem: /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem) ? `_${stem}` : stem, suffix };
}

export function uniqueName(name, taken) {
  const { stem, suffix } = safeName(name);
  let output = `${stem}${suffix}`;
  for (let index = 2; taken.has(output.toLowerCase()); index++) output = `${stem} (${index})${suffix}`;
  taken.add(output.toLowerCase());
  return output;
}

async function buildZip(entries, signal, { level, disk, update } = {}) {
  const { Zip, ZipDeflate, ZipPassThrough } = await import('./vendor/fflate.mjs');
  const output = disk ? await createDiskOutput() : undefined;
  const chunks = [];
  const archive = new Zip((error, chunk) => {
    if (error) throw error;
    chunks.push(chunk);
  });
  async function flush() {
    if (!output) return;
    for (const chunk of chunks.splice(0)) await output.writable.write(chunk);
  }
  let written = 0;
  const total = entries.reduce((sum, entry) => sum + entry.blob.size, 0);
  try {
    for (const { name, blob } of entries) {
      signal.throwIfAborted();
      const entry = level ? new ZipDeflate(name, { level }) : new ZipPassThrough(name);
      archive.add(entry);
      for (let offset = 0; offset < blob.size; offset += chunkBytes) {
        const buffer = await blob.slice(offset, offset + chunkBytes).arrayBuffer();
        signal.throwIfAborted();
        entry.push(new Uint8Array(buffer));
        if (output) await flush();
        written += buffer.byteLength;
        update?.(written / total);
      }
      entry.push(new Uint8Array(), true);
    }
    archive.end();
    if (!output) return { blob: new Blob(chunks, { type: 'application/zip' }) };
    await flush();
    await output.writable.close();
    return { blob: await output.blob('application/zip'), dispose: output.dispose };
  } catch (error) {
    await output?.dispose();
    throw error;
  }
}

export async function zipFiles(entries, signal) {
  const { blob } = await buildZip(entries, signal);
  return blob;
}

export async function compressFileToZip(file, profile, signal, update) {
  const level = { detail: 1, balanced: 6, small: 9 }[profile];
  const disk = file.size >= diskThreshold;
  return buildZip([{ name: uniqueName(file.name, new Set()), blob: file }], signal, { level, disk, update });
}

export async function contentId(blob, signal) {
  signal.throwIfAborted();
  if (contentIds.has(blob)) return contentIds.get(blob);
  // Hash each MiB separately so hashing a long clip never buffers the whole file.
  const hashes = new Uint8Array(Math.ceil(blob.size / chunkBytes) * 32);
  for (let offset = 0, index = 0; offset < blob.size; offset += chunkBytes, index += 32) {
    signal.throwIfAborted();
    const chunk = await blob.slice(offset, offset + chunkBytes).arrayBuffer();
    hashes.set(new Uint8Array(await crypto.subtle.digest('SHA-256', chunk)), index);
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', hashes));
  const id = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  contentIds.set(blob, id);
  return id;
}

async function describe(item, signal) {
  const original = { name: item.file.name, bytes: item.file.size, id: await contentId(item.file, signal) };
  const compressed = item.result && {
    name: item.result.name,
    bytes: item.result.blob.size,
    id: await contentId(item.result.blob, signal),
  };
  return { original, ...(compressed && { compressed }) };
}

function makeManifest(variant, assets) {
  return new Blob([JSON.stringify({
    format: 'pocketspace-archive', version: 1,
    contentIdAlgorithm: 'SHA-256 of concatenated SHA-256 digests of 1048576-byte chunks',
    variant, assets,
  }, null, 2) + '\n'], { type: 'application/json' });
}

export async function archiveZip(items, variant, signal) {
  const names = new Set(['pocketspace-manifest.json']);
  const entries = [];
  const assets = [];
  for (const item of items) {
    const blob = variantFile(item, variant);
    const name = uniqueName(blob.name, names);
    assets.push({ ...await describe(item, signal), path: name });
    entries.push({ name, blob });
  }
  entries.push({ name: 'pocketspace-manifest.json', blob: makeManifest(variant, assets) });
  return zipFiles(entries, signal);
}

async function writeMissing(directory, fileName, blob, id, signal) {
  const { stem, suffix } = safeName(fileName);
  for (let index = 1; ; index++) {
    signal.throwIfAborted();
    const name = `${stem}--${id.slice(0, 16)}${index === 1 ? '' : `-${index}`}${suffix}`;
    try {
      const handle = await directory.getFileHandle(name);
      const existing = await handle.getFile();
      if (existing.size === blob.size && await contentId(existing, signal) === id) return { name, added: false };
      continue;
    } catch (error) {
      if (error.name === 'TypeMismatchError') continue;
      if (error.name !== 'NotFoundError') throw error;
    }
    signal.throwIfAborted();
    const handle = await directory.getFileHandle(name, { create: true });
    const writable = await handle.createWritable({ mode: 'exclusive' });
    await blob.stream().pipeTo(writable, { signal });
    return { name, added: true };
  }
}

export async function syncArchive(folder, items, variant, signal, onProgress) {
  const root = await folder.getDirectoryHandle('Pocketspace Archive', { create: true });
  const target = await root.getDirectoryHandle(variant, { create: true });
  const assets = [];
  let added = 0;
  for (const [index, item] of items.entries()) {
    signal.throwIfAborted();
    onProgress(index + 1, items.length);
    const asset = await describe(item, signal);
    const file = variantFile(item, variant);
    const { id } = variant === 'originals' ? asset.original : asset.compressed;
    const saved = await writeMissing(target, file.name, file, id, signal);
    if (saved.added) added++;
    assets.push({ ...asset, path: `${variant}/${saved.name}` });
  }
  const manifest = makeManifest(variant, assets);
  await writeMissing(root, `${variant}-manifest.json`, manifest, await contentId(manifest, signal), signal);
  return { added, existing: items.length - added };
}
