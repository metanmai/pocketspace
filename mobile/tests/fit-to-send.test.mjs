import assert from 'node:assert/strict';
import { test } from 'node:test';
import { zipFiles } from '../../dist/archive.mjs';
import { fitMedia, splitMedia } from '../../dist/fit-to-send.mjs';
import { unzipSync } from '../../dist/vendor/fflate.mjs';

const signal = new AbortController().signal;
const ignoreProgress = () => {};
const photo = (name, size, value = 0) => new File([new Uint8Array(size).fill(value)], name);

test('fits the complete ZIP and preserves the bytes of a photo kept original', async () => {
  const kept = photo('camera.jpg', 400, 123);
  const other = photo('camera.jpg', 1000);
  const compress = async (file, kind, profile, signal, update, target) => {
    assert.equal(file, other);
    assert.equal(kind, 'photo');
    return { blob: photo('camera-compressed.jpg', target), name: 'camera-compressed.jpg' };
  };
  const { blob } = await fitMedia([{ file: kept, keep: true }, { file: other }], 1000, signal, ignoreProgress, compress);
  assert.ok(blob.size <= 1000);
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  assert.deepEqual(files['camera.jpg'], new Uint8Array(await kept.arrayBuffer()));
  assert.ok(files['camera-compressed.jpg'].length < other.size);
});

test('accepts an exact fit with duplicate names and does not re-encode', async () => {
  const first = photo('é.jpg', 400, 1);
  const second = photo('é.jpg', 300, 2);
  const { blob: reference } = await zipFiles([
    { name: first.name, blob: first },
    { name: 'é (2).jpg', blob: second },
  ], signal);
  const compress = () => assert.fail('Already fits');
  const photos = [{ file: first }, { file: second }];
  const { blob } = await fitMedia(photos, reference.size, signal, ignoreProgress, compress);
  assert.equal(blob.size, reference.size);
  assert.deepEqual(Object.keys(unzipSync(new Uint8Array(await blob.arrayBuffer()))), ['é.jpg', 'é (2).jpg']);
});

test('rejects a budget that covers photo bytes without ZIP overhead', async () => {
  const file = photo('screenshot.png', 400);
  await assert.rejects(fitMedia([{ file, keep: true }], 400, signal, ignoreProgress), /originals alone/);
});

test('rejects the batch when encoder targets cannot be met', async () => {
  const file = photo('camera.jpg', 400);
  const unchanged = async () => null;
  await assert.rejects(fitMedia([{ file }], 300, signal, ignoreProgress, unchanged), /Smallest ZIP found/);
});

test('cancels fitting before producing a ZIP', async () => {
  const controller = new AbortController();
  const file = photo('camera.jpg', 400);
  const compress = async () => { controller.abort(); return null; };
  await assert.rejects(fitMedia([{ file }], 300, controller.signal, ignoreProgress, compress), { name: 'AbortError' });
});

test('split parts preserve originals and respect the cap including ZIP overhead', async () => {
  const files = [photo('a.jpg', 400, 1), photo('b.jpg', 400, 2)];
  const parts = await splitMedia(files.map(file => ({ file, keep: true })), 600, signal, ignoreProgress);
  assert.equal(parts.length, 2);
  for (const [index, { blob }] of parts.entries()) {
    assert.ok(blob.size <= 600);
    const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    assert.deepEqual(Object.keys(entries), [files[index].name]);
    assert.deepEqual(entries[files[index].name], new Uint8Array(await files[index].arrayBuffer()));
  }
});

test('releases replaced video encodes and keeps the preview available until disposal', async () => {
  const file = new File([new Uint8Array(2000)], 'clip.mp4', { type: 'video/mp4' });
  const released = [];
  let attempt = 0;
  const encode = async (source, kind) => {
    assert.equal(source, file);
    assert.equal(kind, 'video');
    const index = ++attempt;
    const blob = new Blob([new Uint8Array(index === 1 ? 600 : 300)]);
    return { name: 'clip-compressed.mp4', blob, dispose: () => released.push(index) };
  };
  const output = await fitMedia([{ file, kind: 'video' }], 500, signal, ignoreProgress, encode);
  assert.deepEqual(released, [1]);
  assert.equal(output.entries[0].blob.size, 300);
  await output.dispose();
  assert.deepEqual(released, [1, 2]);
});
