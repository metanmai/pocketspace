import { uniqueName, zipFiles, zipLimit } from './archive.mjs';
import { compress, MediaError, photoWithoutMetadata } from './compress.mjs';

const empty = new Blob();

export class PhotoPrivacyError extends Error {}

async function prepareEntry({ file, kind = 'photo', keep, stripLocation }, signal) {
  const entry = { file, kind, keep, blob: file, name: file.name, privateCopy: false };
  if (kind !== 'photo' || keep || !stripLocation) return entry;
  try {
    return { ...entry, ...await photoWithoutMetadata(file, signal), privateCopy: true };
  } catch (error) {
    signal.throwIfAborted();
    throw new PhotoPrivacyError(`Couldn’t remove location metadata from ${file.name}. Remove that photo from the batch or choose Keep original to include it as-is.`);
  }
}

async function zipSize(entries, signal) {
  const headers = await zipFiles(entries.map(({ name }) => ({ name, blob: empty })), signal);
  return headers.blob.size;
}

async function checkedZip(entries, limit, signal) {
  const output = await zipFiles(entries, signal);
  if (!signal.aborted && output.blob.size <= limit) return { ...output, entries };
  await output.dispose?.();
  signal.throwIfAborted();
  throw new MediaError('The ZIP exceeds the limit. Try a larger limit.');
}

export async function fitMedia(items, limit, signal, update, encode = compress) {
  if (!items.length || !Number.isSafeInteger(limit) || limit < 1 || limit > zipLimit) {
    throw new RangeError('Enter a ZIP limit between 1 byte and 400 MB.');
  }
  const entries = [];
  for (const item of items) {
    signal.throwIfAborted();
    if (item.stripLocation && item.kind === 'photo' && !item.keep) update(`Removing metadata from ${item.file.name}…`);
    entries.push(await prepareEntry(item, signal));
  }
  return fitEntries(entries, limit, signal, update, encode);
}

async function fitEntries(entries, limit, signal, update, encode = compress) {
  const disposeEntries = () => Promise.all(entries.map(entry => entry.dispose?.()));
  let smallest;

  async function measure() {
    const taken = new Set();
    const named = entries.map(({ file, kind, name, blob, privateCopy }) => {
      return { name: uniqueName(name, taken), blob, file, kind, privateCopy };
    });
    const overhead = await zipSize(named, signal);
    const size = named.reduce((sum, { blob }) => sum + blob.size, overhead);
    return { named, size, overhead };
  }

  try {
    for (let attempt = 0; attempt <= 4; attempt++) {
      signal.throwIfAborted();
      const { named, size, overhead } = await measure();
      smallest = Math.min(smallest ?? size, size);
      if (size <= limit) {
        update('Preparing ZIP…');
        const output = await checkedZip(named, limit, signal);
        return {
          ...output,
          dispose: () => Promise.all([output.dispose?.(), disposeEntries()]),
        };
      }

      const fixed = entries.filter(entry => entry.keep);
      const fixedBytes = fixed.reduce((sum, entry) => sum + entry.blob.size, 0);
      if (fixedBytes >= limit && fixed.length) {
        throw new MediaError('The originals alone use the ZIP budget. Raise the limit or uncheck Keep original.');
      }
      const candidates = entries.filter(entry => !entry.keep);
      if (attempt === 4 || !candidates.length) break;
      const candidateBytes = size - overhead - fixedBytes;
      // Leave room for longer output names and give later passes room to recover from missed targets.
      const ratio = Math.max(0, (limit - overhead - fixedBytes - candidates.length * 32) / candidateBytes);
      for (const [index, entry] of candidates.entries()) {
        signal.throwIfAborted();
        update(`Fitting ${entry.kind} ${index + 1} of ${candidates.length}…`);
        const target = Math.max(1, Math.floor(entry.blob.size * Math.min(.98, ratio)));
        try {
          const result = entry.privateCopy
            ? await photoWithoutMetadata(entry.file, signal, target)
            : await encode(entry.file, entry.kind, 'detail', signal, fraction => {
              update(`Fitting ${entry.kind} ${index + 1} of ${candidates.length} · ${Math.round(fraction * 100)}%`);
            }, target);
          if (result && result.blob.size < entry.blob.size) {
            await entry.dispose?.();
            entry.blob = result.blob;
            entry.name = result.name;
            entry.dispose = result.dispose;
          } else {
            await result?.dispose?.();
          }
        } catch (error) {
          signal.throwIfAborted();
          if (!(error instanceof MediaError)) throw error;
          // Keep the smallest available version if the device cannot re-encode this file.
          entry.keep = true;
        }
      }
    }
    throw new MediaError(`Smallest ZIP found was ${smallest.toLocaleString()} bytes. Raise the limit or keep fewer originals.`);
  } catch (error) {
    await disposeEntries();
    throw error;
  }
}

export async function splitMedia(items, limit, signal, update) {
  const parts = [];
  let entries = [];
  let taken = new Set();
  const endRecord = await zipSize([], signal);
  let bytes = endRecord;

  async function finishPart() {
    if (!entries.length) return;
    parts.push(await checkedZip(entries, limit, signal));
    entries = [];
    taken = new Set();
    bytes = endRecord;
  }

  try {
    for (const [index, item] of items.entries()) {
      signal.throwIfAborted();
      update(`Packing file ${index + 1} of ${items.length}…`);
      const entry = await prepareEntry(item, signal);
      const { file, name } = entry;
      entry.name = uniqueName(name, taken);
      let size = entry.blob.size + await zipSize([entry], signal) - endRecord;
      if (bytes + size > limit) {
        await finishPart();
        entry.name = uniqueName(name, taken);
        size = entry.blob.size + await zipSize([entry], signal) - endRecord;
      }
      if (bytes + size > limit) {
        try {
          parts.push(await fitEntries([entry], limit, signal, update));
        } catch (error) {
          if (!(error instanceof MediaError)) throw error;
          throw new MediaError(`${file.name} couldn’t fit in a ZIP on its own. ${error.message}`);
        }
      } else {
        bytes += size;
        entries.push(entry);
      }
    }
    await finishPart();
    return parts;
  } catch (error) {
    await Promise.all(parts.map(part => part.dispose?.()));
    throw error;
  }
}
