import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkWindowsPhotoLocation } from '../../dist/photo-location.mjs';

const signal = new AbortController().signal;
const gps = Buffer.alloc(28);
gps.write('II');
gps.writeUInt16LE(42, 2);
gps.writeUInt32LE(8, 4);
gps.writeUInt16LE(1, 8);
gps.writeUInt16LE(0x8825, 10);
gps.writeUInt16LE(4, 12);
gps.writeUInt32LE(1, 14);
gps.writeUInt32LE(26, 18);
gps.writeUInt16LE(1, 26);

function jpeg(payload) {
  const header = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 0]);
  header.writeUInt16BE(payload.length + 2, 4);
  return new Blob([header, payload, Buffer.from([0xff, 0xd9])]);
}

test('detects JPEG EXIF GPS and an independent XMP location segment', async () => {
  assert.equal(await checkWindowsPhotoLocation(jpeg(Buffer.concat([Buffer.from('Exif\0\0'), gps])), signal), 'present');
  assert.equal(await checkWindowsPhotoLocation(jpeg(Buffer.from('<x exif:GPSLatitude="12"/>')), signal), 'present');
  assert.equal(await checkWindowsPhotoLocation(jpeg(Buffer.from('<x dc:title="A photo"/>')), signal), 'none');
});

test('checks the eXIf chunk in PNG and the padded EXIF chunk in WebP', async () => {
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, gps.length, 0x65, 0x58, 0x49, 0x66]);
  assert.equal(await checkWindowsPhotoLocation(new Blob([pngHeader, gps, Buffer.alloc(4)]), signal), 'present');
  const webpHeader = Buffer.from('RIFF\0\0\0\0WEBPEXIF\0\0\0\0');
  webpHeader.writeUInt32LE(gps.length + 1, 16);
  assert.equal(await checkWindowsPhotoLocation(new Blob([webpHeader, gps, Buffer.alloc(2)]), signal), 'present');
});
