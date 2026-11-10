// Tiny ZIP: store-only writer + reader (stored and deflated entries).
// No ZIP64: archives and entries must stay under 4 GB.

const enc = new TextEncoder();
const dec = new TextDecoder();
const bad = (message) => Object.assign(new Error(message), { code: 'bad_zip' });

let table;
export function crc32(bytes, crc = 0) {
  table ??= Uint32Array.from({ length: 256 }, (_, n) => {
    for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n;
  });
  crc = ~crc;
  for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  return ~crc >>> 0;
}

/**
 * Build an uncompressed ZIP.
 * @param {{name: string, data: string | Uint8Array | (string | Uint8Array)[]}[]} entries
 * @returns {Blob}
 */
export function zipStore(entries, type = 'application/zip') {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const chunks = (Array.isArray(data) ? data : [data]).map((d) => (typeof d === 'string' ? enc.encode(d) : d));
    let crc = 0;
    let size = 0;
    for (const c of chunks) {
      crc = crc32(c, crc);
      size += c.length;
    }
    const nameBytes = enc.encode(name);
    if (offset + size > 0xfff00000) throw bad('zip too large (no ZIP64)');
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(12, 0x21, true); // 1980-01-01
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, nameBytes.length, true);
    parts.push(local, nameBytes, ...chunks);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(14, 0x21, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, size, true);
    cd.setUint32(24, size, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint32(42, offset, true);
    central.push(cd, nameBytes);
    offset += 30 + nameBytes.length + size;
  }
  const cdSize = central.reduce((n, p) => n + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type });
}

/**
 * Open a ZIP held in memory. Throws an Error with code 'bad_zip' when the
 * archive is not a ZIP, is cut off, or an entry cannot be inflated.
 * @param {ArrayBuffer | Uint8Array} input
 * @returns {{names: string[], size(name: string): number, read(name: string): Promise<Uint8Array | null>}}
 */
export function readZip(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let e = u8.length - 22;
  const stop = Math.max(0, e - 65535);
  while (e >= stop && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0 || e < stop) throw bad('not a zip file, or the end of the file is missing');

  const entries = new Map();
  let p = dv.getUint32(e + 16, true);
  for (let i = dv.getUint16(e + 10, true); i > 0; i--) {
    if (p + 46 > u8.length || dv.getUint32(p, true) !== 0x02014b50) throw bad('zip directory is damaged');
    const nameLen = dv.getUint16(p + 28, true);
    entries.set(dec.decode(u8.subarray(p + 46, p + 46 + nameLen)), {
      method: dv.getUint16(p + 10, true),
      csize: dv.getUint32(p + 20, true),
      usize: dv.getUint32(p + 24, true),
      offset: dv.getUint32(p + 42, true),
    });
    p += 46 + nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }

  async function read(name) {
    const en = entries.get(name);
    if (!en) return null;
    const o = en.offset;
    if (en.csize === 0xffffffff || o === 0xffffffff) throw bad('ZIP64 is not supported');
    if (o + 30 > u8.length || dv.getUint32(o, true) !== 0x04034b50) throw bad('zip entry is damaged');
    const start = o + 30 + dv.getUint16(o + 26, true) + dv.getUint16(o + 28, true);
    if (start + en.csize > u8.length) throw bad('zip entry is cut off');
    const raw = u8.subarray(start, start + en.csize);
    if (en.method === 0) return raw;
    if (en.method !== 8) throw bad('unsupported zip compression');
    try {
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (err) {
      if (err instanceof RangeError) throw err; // out of memory, not a damaged file
      throw bad('zip entry cannot be decompressed');
    }
  }

  return { names: [...entries.keys()], size: (name) => entries.get(name)?.usize ?? -1, read };
}
