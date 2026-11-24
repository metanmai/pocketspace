import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { unzipSync } from '../../dist/vendor/fflate.mjs';

const entries = new Map();
const calls = [];
let nextToken = 0;
let video;
const descriptor = ({ token, name, type, bytes }) => ({
  token, name, type, size: bytes.length, url: `https://app.example/files/${token}`,
});

function add(name, type, bytes) {
  const token = String(++nextToken);
  const entry = { token, name, type, bytes };
  entries.set(token, entry);
  return entry;
}

const input = add('clip.mov', 'video/quicktime', Buffer.alloc(600_000, 30));
globalThis.document = { documentElement: { classList: { add() {} } } };
globalThis.window = {
  PocketspaceNative: {
    postMessage(payload) {
      const { id, method, args } = JSON.parse(payload);
      calls.push({ method, args });
      const reply = (result, error) => window.__pocketspaceReply({ id, result, error });
      queueMicrotask(() => {
        switch (method) {
          case 'pickFiles':
            reply([descriptor(input)]);
            break;
          case 'readChunk': {
            assert.ok(args.length <= 256 * 1024);
            const { bytes } = entries.get(args.token);
            reply({ base64: bytes.subarray(args.offset, args.offset + args.length).toString('base64') });
            break;
          }
          case 'beginWrite':
            reply({ token: add(args.name, args.type, Buffer.alloc(0)).token });
            break;
          case 'writeChunk': {
            const entry = entries.get(args.token);
            assert.equal(args.offset, entry.bytes.length);
            const bytes = Buffer.from(args.base64, 'base64');
            assert.ok(bytes.length <= 256 * 1024);
            entry.bytes = Buffer.concat([entry.bytes, bytes]);
            reply();
            break;
          }
          case 'endWrite':
            reply(descriptor(entries.get(args.token)));
            break;
          case 'save':
          case 'share':
            reply();
            break;
          case 'compressVideo':
            video = reply;
            window.__pocketspaceProgress({ jobId: args.jobId, fraction: 0.5, attempt: 1 });
            break;
          case 'cancel':
            video(undefined, { code: 'cancelled', message: 'Cancelled' });
            reply();
            break;
          case 'release':
            for (const token of args.tokens) entries.delete(token);
            reply();
            break;
          default:
            assert.fail(`Unexpected method ${method}`);
        }
      });
    },
  },
};

const { compressNativeVideo, createMobileDiskOutput, pickFiles, saveMobile, shareMobile } = await import('../../dist/mobile.mjs');
const { archiveZip, contentId, variantFile } = await import('../../dist/archive.mjs');

test('reads native files in bounded chunks and preserves the archive manifest', async () => {
  const [file] = await pickFiles();
  const { signal } = new AbortController();
  const fileDigest = createHash('sha256').update(input.bytes).digest();
  assert.equal(await contentId(file, signal), createHash('sha256').update(fileDigest).digest('hex'));
  const { blob } = await archiveZip([{ file, kind: 'video' }], 'originals', signal);
  const zip = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  assert.deepEqual(Buffer.from(zip['clip.mov']), input.bytes);
  const manifest = JSON.parse(new TextDecoder().decode(zip['pocketspace-manifest.json']));
  assert.equal(manifest.assets[0].original.id, await contentId(file, signal));
  assert.equal(manifest.assets[0].path, 'clip.mov');
});

test('stages a browser Blob for save and releases it afterward', async () => {
  const start = calls.length;
  const file = new Blob([Buffer.alloc(600_000, 31)], { type: 'image/jpeg' });
  await saveMobile(file, 'image-compressed.jpg');
  const actions = calls.slice(start);
  assert.deepEqual(actions.map(action => action.method), [
    'beginWrite', 'writeChunk', 'writeChunk', 'writeChunk', 'endWrite', 'save', 'release',
  ]);
  assert.equal(actions.at(-2).args.name, 'image-compressed.jpg');
  assert.equal(entries.has(actions.at(-2).args.token), false);
});

test('streams ZIP output to disk and shares its requested filename', async () => {
  const writer = await createMobileDiskOutput();
  assert.equal(calls.at(-1).args.size, null);
  await writer.writable.write(new Uint8Array([1, 2, 3]));
  await writer.writable.close();
  const blob = writer.blob();
  const result = { blob, name: 'clip-compressed.zip' };
  const file = variantFile({ result }, 'compressed');
  const { signal } = new AbortController();
  await shareMobile([{ file, name: file.name }], signal);
  assert.deepEqual(calls.at(-1), {
    method: 'share', args: { tokens: [blob.token], names: ['clip-compressed.zip'] },
  });
  await writer.dispose();
  assert.equal(entries.has(blob.token), false);
});

test('cancels native video processing and disconnects its progress callback', async () => {
  const [file] = await pickFiles();
  const controller = new AbortController();
  const progress = [];
  const pending = compressNativeVideo(file, 'balanced', controller.signal, fraction => {
    progress.push(fraction);
    controller.abort();
  }, 200_000);
  await assert.rejects(pending, { name: 'AbortError' });
  const compression = calls.find(({ method }) => method === 'compressVideo');
  const cancellation = calls.find(({ method }) => method === 'cancel');
  assert.equal(compression.args.targetBytes, 200_000);
  assert.equal(cancellation.args.jobId, compression.args.jobId);
  window.__pocketspaceProgress({ jobId: compression.args.jobId, fraction: 0.8 });
  assert.deepEqual(progress, [0.5]);
});
