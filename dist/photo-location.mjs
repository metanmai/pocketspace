const location = /GPS(?:Latitude|Longitude|Altitude)|Location(?:Shown|Created)|(?:photoshop:(?:City|State|Country)|Iptc4xmpCore:Location)/i;
const decode = new TextDecoder();

function exifHasLocation(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const order = view.getUint16(0);
  if (order !== 0x4949 && order !== 0x4d4d) throw new Error('Invalid EXIF byte order');
  const little = order === 0x4949;
  if (view.getUint16(2, little) !== 42) throw new Error('Invalid EXIF header');
  const directory = view.getUint32(4, little);
  const count = view.getUint16(directory, little);
  for (let i = 0; i < count; i++) {
    const offset = directory + 2 + 12 * i;
    if (view.getUint16(offset, little) !== 0x8825) continue;
    const gps = view.getUint32(offset + 8, little);
    return gps > 0 && view.getUint16(gps, little) > 0;
  }
  return false;
}

export async function checkWindowsPhotoLocation(file, signal) {
  const read = async (offset, length) => {
    signal.throwIfAborted();
    return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
  };
  const signature = await read(0, 12);
  const jpeg = signature[0] === 0xff && signature[1] === 0xd8;
  const png = signature[0] === 0x89 && decode.decode(signature.subarray(1, 4)) === 'PNG';
  const webp = decode.decode(signature.subarray(0, 4)) === 'RIFF'
    && decode.decode(signature.subarray(8, 12)) === 'WEBP';
  if (!jpeg && !png && !webp) return 'unknown';
  let uncertain = false;
  for (let offset = jpeg ? 2 : png ? 8 : 12; offset < file.size;) {
    const header = await read(offset, jpeg ? 4 : 8);
    if (jpeg && header[0] === 0xff && header[1] === 0xff) { offset++; continue; }
    if (jpeg && (header[1] === 0xda || header[1] === 0xd9)) break;
    if (header.length !== (jpeg ? 4 : 8) || (jpeg && header[0] !== 0xff)) return 'unknown';
    const view = new DataView(header.buffer);
    const type = jpeg ? header[1] : decode.decode(header.subarray(png ? 4 : 0, png ? 8 : 4));
    if (type === 'IEND') break;
    const length = jpeg ? view.getUint16(2) - 2 : view.getUint32(png ? 0 : 4, webp);
    const data = offset + header.length;
    offset = data + length + (png ? 4 : webp ? length % 2 : 0);
    if (length < 0 || offset > file.size) return 'unknown';
    if (![0xe1, 'eXIf', 'EXIF', 'XMP ', 'iTXt', 'tEXt', 'zTXt'].includes(type)) continue;
    if (length > 1024 * 1024) { uncertain = true; continue; }
    const bytes = await read(data, length);
    const exif = decode.decode(bytes.subarray(0, 6)) === 'Exif\0\0';
    if (exif || type === 'eXIf' || type === 'EXIF') {
      if (exifHasLocation(exif ? bytes.subarray(6) : bytes)) return 'present';
    } else if (location.test(decode.decode(bytes))) {
      return 'present';
    } else if (type === 'zTXt' || (type === 'iTXt' && bytes[bytes.indexOf(0) + 1] === 1)) {
      uncertain = true;
    }
  }
  return uncertain ? 'unknown' : 'none';
}
