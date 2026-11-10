// Mesh readers (binary/ASCII STL, OBJ, 3MF) and writers (binary STL, OBJ, 3MF).
// Everything is a triangle soup: Float32Array, 9 floats per triangle, millimetres.
// Typed arrays only on the hot paths, so a 500 MB binary STL loads without giant
// JS arrays or strings. No DOM: works in a window, a Worker and Node 24.
import { readZip, zipStore } from './zip.js';

/** code: 'empty' | 'not_mesh' | 'truncated' | 'too_large' | 'no_triangles'. data: details for the message. */
export class MeshError extends Error {
  constructor(code, data = {}) {
    super(`mesh: ${code}`);
    this.name = 'MeshError';
    this.code = code;
    this.data = data;
  }
}

const CHUNK = 1_000_000; // triangles per read of a binary STL (50 MB)
const utf8 = new TextDecoder();
const ws = (c) => c === 32 || (c >= 9 && c <= 13);
const finite = (s) => s - s === 0; // false for NaN and +-Infinity

function alloc(Type, n) {
  try {
    return new Type(n);
  } catch {
    throw new MeshError('too_large');
  }
}
function grow(arr, need) {
  if (need <= arr.length) return arr;
  const next = alloc(arr.constructor, Math.max(need, arr.length * 2));
  next.set(arr);
  return next;
}
function latin1(u8, a, b) {
  let s = '';
  for (; a < b; a += 8192) s += String.fromCharCode.apply(null, u8.subarray(a, Math.min(b, a + 8192)));
  return s;
}

function source(input) {
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    return {
      size: input.size,
      async read(a, b) {
        try {
          return new Uint8Array(await input.slice(a, b).arrayBuffer());
        } catch (e) {
          if (e instanceof RangeError) throw new MeshError('too_large');
          throw e;
        }
      },
    };
  }
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  return { size: u8.length, read: async (a, b) => u8.subarray(a, b) };
}

// [{name, start}] markers -> [{name, start, count}] without empty ranges, covering every triangle.
function ranges(marks, total, fallback) {
  const out = [];
  marks.forEach((m, k) => {
    const count = (k + 1 < marks.length ? marks[k + 1].start : total) - m.start;
    if (count > 0) out.push({ name: m.name || fallback, start: m.start, count });
  });
  if (!out.length || out[0].start > 0) out.unshift({ name: fallback, start: 0, count: out.length ? out[0].start : total });
  return out;
}

function finish(format, tri, w, bad, objects, extra) {
  if (!w) throw new MeshError('no_triangles', { bad });
  // slice, not subarray: triangles.buffer is exactly the data, so it is safe to transfer from a Worker
  const triangles = w === tri.length ? tri : tri.slice(0, w);
  return { format, triangles, count: w / 9, objects, bad, truncated: null, unit: 'millimeter', ...extra };
}

/**
 * Read a mesh file. The format is detected from the content, never from the name.
 * @param {Blob | ArrayBuffer | Uint8Array} input
 * @param {{name?: string, allowTruncated?: boolean, onProgress?: (fraction: number) => void}} [opts]
 *   name: file name, used only to label objects. allowTruncated: load the intact part of a cut-off STL.
 * @returns {Promise<{format: 'stl-binary'|'stl-ascii'|'obj'|'3mf', triangles: Float32Array, count: number,
 *   objects: {name: string, start: number, count: number}[], bad: number,
 *   truncated: null | {declared: number | null, present: number}, unit: string}>}
 *   objects[].start/count are in triangles. bad = triangles with NaN/Infinity coordinates or invalid
 *   indices; they are left out of `triangles`. unit = the file's own unit (output is always mm).
 * @throws {MeshError}
 */
export async function parseMesh(input, opts = {}) {
  const src = source(input);
  if (!src.size) throw new MeshError('empty');
  const name = (opts.name || '').replace(/\.[^.]*$/, '') || 'model';
  let head = await src.read(0, Math.min(src.size, 4096));

  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 3 && head[3] === 4) return parse3MF(await src.read(0, src.size), name);

  const isText = !head.includes(0);
  // A text file may start with a long comment block or name line before its first vertex / facet.
  // ponytail: looks at the first 1 MB only; read further if real files ever need it.
  if (isText && src.size > 4096) head = await src.read(0, Math.min(src.size, 1 << 20));
  const text = isText ? latin1(head, 0, head.length) : '';
  if (/facet\s+normal/i.test(text) || (/^\s*solid\b/i.test(text) && src.size <= 4096)) {
    return asciiSTL(await src.read(0, src.size), name, opts);
  }
  if (/^[ \t]*v[ \t]+[-+.\d]/m.test(text)) return parseOBJ(await src.read(0, src.size), name);

  // Binary STL: 80-byte header, uint32 count, 50 bytes per triangle.
  if (src.size < 84) throw new MeshError('not_mesh');
  const declared = new DataView((await src.read(80, 84)).slice().buffer).getUint32(0, true);
  const present = Math.floor((src.size - 84) / 50);
  let truncated = null;
  // Size does not match the count: a cut-off (or padded) STL, or not an STL at all?
  // Real triangles have sane numbers (normals are not checked: some exporters do not normalise them).
  if (src.size !== 84 + declared * 50 && declared && (isText || !present || !(await plausible(src, Math.min(declared, present))))) {
    throw new MeshError('not_mesh');
  }
  if (present < declared) {
    truncated = { declared, present };
    if (!opts.allowTruncated) throw new MeshError('truncated', truncated);
  }
  const n = Math.min(declared, present);
  const tri = alloc(Float32Array, n * 9);
  let w = 0;
  let bad = 0;
  for (let t = 0; t < n; t += CHUNK) {
    const m = Math.min(CHUNK, n - t);
    const u8 = await src.read(84 + t * 50, 84 + (t + m) * 50);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    for (let i = 0, o = 12; i < m; i++, o += 50) {
      let s = 0;
      for (let k = 0; k < 9; k++) s += tri[w + k] = dv.getFloat32(o + k * 4, true);
      if (finite(s)) w += 9;
      else bad++;
    }
    opts.onProgress?.((t + m) / n);
  }
  return finish('stl-binary', tri, w, bad, [{ name, start: 0, count: w / 9 }], { truncated });
}

async function plausible(src, present) {
  const step = Math.max(1, Math.floor(present / 200));
  let ok = 0;
  let seen = 0;
  for (let t = 0; t < present; t += step, seen++) {
    const u8 = await src.read(84 + t * 50, 84 + t * 50 + 48);
    const dv = new DataView(u8.buffer, u8.byteOffset, 48);
    let good = true;
    for (let k = 0; k < 12; k++) if (!(Math.abs(dv.getFloat32(k * 4, true)) < 1e7)) good = false;
    if (good) ok++;
  }
  return ok >= seen * 0.9;
}

const VERTEX = [118, 101, 114, 116, 101, 120];
const SOLID = [115, 111, 108, 105, 100];
const ENDSOLID = [101, 110, 100, ...SOLID];
function keywordAt(u8, i, kw) {
  if (i > 0 && !ws(u8[i - 1])) return false;
  for (let k = 0; k < kw.length; k++) if ((u8[i + k] | 32) !== kw[k]) return false;
  const end = u8[i + kw.length];
  return end === undefined || ws(end);
}

function asciiSTL(u8, name, opts) {
  const len = u8.length;
  // Calls onVertex(index after the keyword) for every vertex and onSolid(start, end of its line, isEnd) for
  // every "solid" / "endsolid" at the start of a line. The rest of such a line is a free-text name, so a
  // "vertex" or "solid" inside it is not a keyword.
  const walk = (onVertex, onSolid) => {
    for (let i = 0; i < len; i++) {
      const c = u8[i] | 32;
      if (c === 118 && keywordAt(u8, i, VERTEX)) i = onVertex(i + 6);
      else if ((c === 115 && keywordAt(u8, i, SOLID)) || (c === 101 && keywordAt(u8, i, ENDSOLID))) {
        let j = i - 1;
        while (j >= 0 && (u8[j] === 32 || u8[j] === 9)) j--;
        if (j >= 0 && u8[j] !== 10 && u8[j] !== 13) continue;
        let e = u8.indexOf(10, i);
        if (e < 0) e = len;
        onSolid(i + 5, e, c === 101);
        i = e;
      }
    }
  };
  let nv = 0;
  walk((i) => (nv++, i), () => {});
  const tri = alloc(Float32Array, Math.floor(nv / 3) * 9);
  const marks = [];
  let w = 0;
  let bad = 0;
  let corner = 0;
  let ended = false; // the last solid was closed by "endsolid": the file is complete
  let cut = false;
  walk(
    (i) => {
      ended = false;
      for (let k = 0; k < 3; k++) {
        while (i < len && ws(u8[i])) i++;
        const a = i;
        while (i < len && !ws(u8[i])) i++;
        tri[w + corner * 3 + k] = i > a && i - a < 40 ? Number(latin1(u8, a, i)) : NaN;
      }
      // A number that runs into the end of the file may have lost digits: that vertex does not count.
      if (i >= len) cut = true;
      else if (++corner === 3) {
        corner = 0;
        let s = 0;
        for (let k = 0; k < 9; k++) s += tri[w + k];
        if (finite(s)) w += 9;
        else bad++;
      }
      return i;
    },
    (a, b, isEnd) => {
      ended = isEnd;
      if (!isEnd) marks.push({ name: utf8.decode(u8.subarray(a, b)).trim(), start: w / 9 });
    },
  );
  let truncated = null;
  if (!ended || corner || cut) {
    truncated = { declared: null, present: w / 9 + bad };
    if (!opts.allowTruncated) throw new MeshError('truncated', truncated);
  }
  return finish('stl-ascii', tri, w, bad, ranges(marks, w / 9, name), { truncated });
}

function parseOBJ(u8, name) {
  const len = u8.length;
  let v = new Float32Array(3 * 4096);
  let nv = 0;
  let tri = new Float32Array(9 * 4096);
  let w = 0;
  let bad = 0;
  const marks = [];
  for (let a = 0, b; a < len; a = b + 1) {
    b = u8.indexOf(10, a);
    if (b < 0) b = len;
    while (u8[a] === 32 || u8[a] === 9) a++;
    const c = u8[a];
    if ((c !== 118 && c !== 102 && c !== 111 && c !== 103) || (u8[a + 1] !== 32 && u8[a + 1] !== 9)) continue;
    const rest = utf8.decode(u8.subarray(a + 2, b)).trim();
    if (c === 111 || c === 103) {
      marks.push({ name: rest, start: w / 9 }); // o / g
    } else if (c === 118) {
      const p = rest.split(/\s+/);
      v = grow(v, nv * 3 + 3);
      for (let k = 0; k < 3; k++) v[nv * 3 + k] = Number(p[k] || NaN);
      nv++;
    } else {
      // f: "i", "i/t", "i/t/n" or "i//n"; 1-based, negative = relative to the end. Polygons become a fan.
      const idx = rest.split(/\s+/).map((t) => {
        const i = parseInt(t, 10);
        return i > 0 ? i - 1 : nv + i;
      });
      for (let k = 1; k + 1 < idx.length; k++) {
        tri = grow(tri, w + 9);
        let s = 0;
        for (const [c3, i] of [idx[0], idx[k], idx[k + 1]].entries()) {
          for (let d = 0; d < 3; d++) s += tri[w + c3 * 3 + d] = i >= 0 && i < nv ? v[i * 3 + d] : NaN;
        }
        if (finite(s)) w += 9;
        else bad++;
      }
    }
  }
  if (!nv) throw new MeshError('not_mesh');
  return finish('obj', tri, w, bad, ranges(marks, w / 9, name));
}

// ---- 3MF ----------------------------------------------------------------------------------------

const UNITS = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };
const XYZ = /\bx="([^"]*)"\s+y="([^"]*)"\s+z="([^"]*)"/;
const V123 = /\bv1="([^"]*)"\s+v2="([^"]*)"\s+v3="([^"]*)"/;
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function attr(tag, name) {
  const m = new RegExp(`[\\s:]${name}\\s*=\\s*["']([^"']*)["']`).exec(tag);
  return m && m[1].replace(/&(#x?[\da-f]+|\w+);/gi, (all, e) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : (ENT[e] ?? all));
}
function matrix(s) {
  const m = s ? s.trim().split(/\s+/).map(Number) : [];
  return m.length === 12 ? m : null; // null = identity
}
// 3MF matrices are 4x3, row vectors: v' = v * M. mul(a, b) applies a first, then b.
function mul(a, b) {
  if (!a || !b) return a || b;
  const r = new Array(12);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j] + (i === 3 ? b[9 + j] : 0);
    }
  }
  return r;
}

// One pass over the XML bytes, tag by tag; only short tag strings are ever created.
function parseModel(u8) {
  const model = { unit: 1, unitName: 'millimeter', objects: new Map(), items: [] };
  let cur = null;
  for (let a = u8.indexOf(60), b; a >= 0; a = u8.indexOf(60, b)) {
    b = u8.indexOf(62, a);
    if (b < 0) break;
    const tag = latin1(u8, a, b);
    const m = /^<(\/?)(?:[\w.-]+:)?([\w.-]+)/.exec(tag);
    if (!m) continue;
    const el = m[2];
    if (el === 'vertex' && cur) {
      const r = XYZ.exec(tag) || [0, attr(tag, 'x'), attr(tag, 'y'), attr(tag, 'z')];
      cur.v = grow(cur.v, cur.nv * 3 + 3);
      for (let k = 0; k < 3; k++) cur.v[cur.nv * 3 + k] = Number(r[k + 1] ?? NaN);
      cur.nv++;
    } else if (el === 'triangle' && cur) {
      const r = V123.exec(tag) || [0, attr(tag, 'v1'), attr(tag, 'v2'), attr(tag, 'v3')];
      cur.t = grow(cur.t, cur.nt * 3 + 3);
      for (let k = 0; k < 3; k++) {
        const i = Number(r[k + 1] ?? NaN);
        cur.t[cur.nt * 3 + k] = Number.isInteger(i) && i >= 0 ? i : 0xffffffff;
      }
      cur.nt++;
    } else if (el === 'object') {
      cur = null;
      if (!m[1]) {
        cur = { name: attr(utf8.decode(u8.subarray(a, b)), 'name'), v: new Float32Array(3072), nv: 0, t: new Uint32Array(3072), nt: 0, parts: [] };
        model.objects.set(attr(tag, 'id'), cur);
      }
    } else if (el === 'component' || el === 'item') {
      const ref = { id: attr(tag, 'objectid'), path: attr(tag, 'path')?.replace(/^\//, ''), m: matrix(attr(tag, 'transform')) };
      if (el === 'item') model.items.push(ref);
      else cur?.parts.push(ref);
    } else if (el === 'model' && !m[1]) {
      model.unitName = attr(tag, 'unit') || 'millimeter';
      model.unit = UNITS[model.unitName] ?? 1;
    }
  }
  return model;
}

async function parse3MF(u8, name) {
  let zip;
  const models = new Map();
  const text = async (n) => {
    const d = await zip.read(n);
    return d ? utf8.decode(d) : '';
  };
  const load = async (path) => {
    if (!models.has(path)) {
      const real = zip.names.find((n) => n.toLowerCase() === path.toLowerCase());
      const data = real && (await zip.read(real));
      if (!data) throw new MeshError('not_mesh', { reason: 'missing ' + path });
      models.set(path, parseModel(data));
    }
    return models.get(path);
  };
  let root;
  let names = '';
  try {
    zip = readZip(u8);
    const rel = /<Relationship\b[^>]*3dmodel"[^>]*>/i.exec(await text('_rels/.rels'));
    const rootPath = (rel && attr(rel[0], 'Target')?.replace(/^\//, '')) || zip.names.find((n) => /^3D\/[^/]*\.model$/i.test(n));
    if (!rootPath) throw new MeshError('not_mesh', { reason: 'no model part' });
    root = await load(rootPath);
    // Sub-model files referenced by components (Bambu Studio / Orca keep meshes in 3D/Objects/*.model).
    for (let queue = [root]; queue.length; ) {
      const model = queue.pop();
      for (const p of [...model.items, ...[...model.objects.values()].flatMap((o) => o.parts)]) {
        if (p.path && !models.has(p.path)) queue.push(await load(p.path));
      }
    }
    names = await text('Metadata/model_settings.config'); // Bambu Studio keeps object names here
  } catch (e) {
    if (e instanceof MeshError) throw e;
    if (e instanceof RangeError) throw new MeshError('too_large');
    if (e.code === 'bad_zip') throw new MeshError('not_mesh', { reason: e.message });
    throw e;
  }

  let items = root.items;
  if (!items.length) {
    const used = new Set([...root.objects.values()].flatMap((o) => o.parts.filter((p) => !p.path).map((p) => p.id)));
    items = [...root.objects.keys()].filter((id) => !used.has(id)).map((id) => ({ id, m: null }));
  }
  const at = (model, ref) => (ref.path ? models.get(ref.path) : model);
  // Triangles of an object with all its components. Counted once per object, so a file whose objects
  // reference each other many times over (or in a circle) is answered at once instead of walked.
  const counts = new Map();
  const count = (model, id) => {
    const o = model?.objects.get(id);
    if (!o) return 0;
    if (!counts.has(o)) {
      counts.set(o, -1); // being counted
      counts.set(o, o.parts.reduce((n, p) => n + count(at(model, p), p.id), o.nt));
    } else if (counts.get(o) < 0) throw new MeshError('not_mesh', { reason: 'components refer to each other in a circle' });
    return counts.get(o);
  };
  const tri = alloc(Float32Array, items.reduce((n, it) => n + count(at(root, it), it.id), 0) * 9);
  const scale = root.unit;
  let w = 0;
  let bad = 0;
  const emit = (model, id, m) => {
    const o = model?.objects.get(id);
    if (!o) return;
    // A mirroring transform (negative determinant) turns every triangle inside out: swap two corners back.
    const mirror = m && m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]) < 0;
    for (let k = 0; k < o.nt * 3; k += 3) {
      let s = 0;
      for (let c = 0; c < 3; c++) {
        const i = o.t[k + (mirror ? 2 - c : c)] * 3;
        const ok = i < o.nv * 3;
        const x = ok ? o.v[i] : NaN;
        const y = ok ? o.v[i + 1] : NaN;
        const z = ok ? o.v[i + 2] : NaN;
        s += tri[w + c * 3] = (m ? x * m[0] + y * m[3] + z * m[6] + m[9] : x) * scale;
        s += tri[w + c * 3 + 1] = (m ? x * m[1] + y * m[4] + z * m[7] + m[10] : y) * scale;
        s += tri[w + c * 3 + 2] = (m ? x * m[2] + y * m[5] + z * m[8] + m[11] : z) * scale;
      }
      if (finite(s)) w += 9;
      else bad++;
    }
    for (const p of o.parts) emit(at(model, p), p.id, mul(p.m, m));
  };
  const marks = items.map((it) => {
    const start = w / 9;
    emit(at(root, it), it.id, it.m);
    const id = String(it.id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const meta = new RegExp(`<object\\s+id="${id}"[^>]*>\\s*<metadata\\s+key="name"\\s+value="[^"]*"`).exec(names);
    return { name: at(root, it)?.objects.get(it.id)?.name || (meta && attr(meta[0], 'value')) || '', start };
  });
  return finish('3mf', tri, w, bad, ranges(marks, w / 9, name), { unit: root.unitName });
}

// ---- helpers and writers --------------------------------------------------------------------------

/** Bounding box of a triangle soup: {min: [x,y,z], max: [x,y,z]} (Infinity/-Infinity when empty). */
export function bounds(tri) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tri.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const x = tri[i + k];
      if (x < min[k]) min[k] = x;
      if (x > max[k]) max[k] = x;
    }
  }
  return { min, max };
}

/**
 * Merge bit-identical vertices (-0 equals 0). Exact match only, no tolerance.
 * @returns {{vertices: Float32Array, indices: Uint32Array}} indices has 3 entries per triangle
 */
export function weld(tri) {
  const n = tri.length / 3;
  const src = new Uint32Array(tri.buffer, tri.byteOffset, tri.length);
  let cap = 16;
  while (cap < n * 2) cap *= 2;
  const table = alloc(Int32Array, cap).fill(-1);
  const out = alloc(Uint32Array, n * 3); // bit patterns of the unique vertices
  const indices = alloc(Uint32Array, n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const a = src[i * 3] === 0x80000000 ? 0 : src[i * 3];
    const b = src[i * 3 + 1] === 0x80000000 ? 0 : src[i * 3 + 1];
    const c = src[i * 3 + 2] === 0x80000000 ? 0 : src[i * 3 + 2];
    let h = Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791);
    h = (h ^ (h >>> 15)) & (cap - 1);
    for (;;) {
      const j = table[h];
      if (j < 0) {
        table[h] = count;
        out[count * 3] = a;
        out[count * 3 + 1] = b;
        out[count * 3 + 2] = c;
        indices[i] = count++;
        break;
      }
      if (out[j * 3] === a && out[j * 3 + 1] === b && out[j * 3 + 2] === c) {
        indices[i] = j;
        break;
      }
      h = (h + 1) & (cap - 1);
    }
  }
  return { vertices: new Float32Array(out.buffer, 0, count * 3), indices };
}

/** Binary STL as a Blob, built in 10 MB pieces. Normals are recomputed from the vertices. */
export function writeSTL(tri) {
  const n = tri.length / 9;
  const head = new Uint8Array(84);
  head.set(new TextEncoder().encode('binary STL'));
  new DataView(head.buffer).setUint32(80, n, true);
  const parts = [head];
  for (let t = 0; t < n; t += 200_000) {
    const m = Math.min(200_000, n - t);
    const dv = new DataView(new ArrayBuffer(m * 50));
    for (let i = 0; i < m; i++) {
      const p = (t + i) * 9;
      const ux = tri[p + 3] - tri[p], uy = tri[p + 4] - tri[p + 1], uz = tri[p + 5] - tri[p + 2];
      const vx = tri[p + 6] - tri[p], vy = tri[p + 7] - tri[p + 1], vz = tri[p + 8] - tri[p + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      dv.setFloat32(i * 50, nx / l, true);
      dv.setFloat32(i * 50 + 4, ny / l, true);
      dv.setFloat32(i * 50 + 8, nz / l, true);
      for (let k = 0; k < 9; k++) dv.setFloat32(i * 50 + 12 + k * 4, tri[p + k], true);
    }
    parts.push(dv);
  }
  return new Blob(parts, { type: 'model/stl' });
}

// Shortest decimal text that reads back as the same float32.
function f32(x) {
  for (let p = 6; p < 9; p++) {
    const s = +x.toPrecision(p);
    if (Math.fround(s) === x) return s;
  }
  return +x.toPrecision(9);
}
// Text for n records, pushed in pieces so no single string grows huge.
function lines(parts, n, line) {
  let s = '';
  for (let i = 0; i < n; i++) {
    s += line(i);
    if (s.length > 1 << 20) {
      parts.push(s);
      s = '';
    }
  }
  parts.push(s);
}

/** Wavefront OBJ (welded vertices) as a Blob. */
export function writeOBJ(tri) {
  const { vertices: v, indices: ix } = weld(tri);
  const parts = [];
  lines(parts, v.length / 3, (i) => `v ${f32(v[i * 3])} ${f32(v[i * 3 + 1])} ${f32(v[i * 3 + 2])}\n`);
  lines(parts, ix.length / 3, (i) => `f ${ix[i * 3] + 1} ${ix[i * 3 + 1] + 1} ${ix[i * 3 + 2] + 1}\n`);
  return new Blob(parts, { type: 'model/obj' });
}

/**
 * Minimal 3MF (core spec, millimetres, welded vertices) as a Blob.
 * @param {Float32Array} tri
 * @param {{name: string, start: number, count: number}[]} [objects] one 3MF object per range; default: one object
 */
export function write3MF(tri, objects = [{ name: 'model', start: 0, count: tri.length / 9 }]) {
  const xml = (s) =>
    String(s)
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]/g, '') // not allowed in XML 1.0, even escaped
      .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const parts = ['<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n<resources>\n'];
  objects.forEach((o, k) => {
    const { vertices: v, indices: ix } = weld(tri.subarray(o.start * 9, (o.start + o.count) * 9));
    parts.push(`<object id="${k + 1}" type="model" name="${xml(o.name)}"><mesh><vertices>\n`);
    lines(parts, v.length / 3, (i) => `<vertex x="${f32(v[i * 3])}" y="${f32(v[i * 3 + 1])}" z="${f32(v[i * 3 + 2])}"/>\n`);
    parts.push('</vertices><triangles>\n');
    lines(parts, ix.length / 3, (i) => `<triangle v1="${ix[i * 3]}" v2="${ix[i * 3 + 1]}" v3="${ix[i * 3 + 2]}"/>\n`);
    parts.push('</triangles></mesh></object>\n');
  });
  parts.push('</resources>\n<build>\n' + objects.map((_, k) => `<item objectid="${k + 1}"/>\n`).join('') + '</build>\n</model>\n');
  return zipStore(
    [
      {
        name: '[Content_Types].xml',
        data: '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>',
      },
      {
        name: '_rels/.rels',
        data: '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>',
      },
      { name: '3D/3dmodel.model', data: parts },
    ],
    'model/3mf',
  );
}
