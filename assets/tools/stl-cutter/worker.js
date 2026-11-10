// One job per worker: 'load' parses a file, 'cut' splits a triangle soup, 'zip' packs the pieces.
// The page cancels by terminate().
import { parseMesh, bounds, weld, writeSTL } from '../../lib/mesh-io.js';
import { zipStore } from '../../lib/zip.js';
import { analyze } from '../../lib/mesh-analyze.js';
import { volume, orient, slab } from './cut-plan.js';

// manifold-3d (WASM): Booleans whose result is guaranteed to be a closed mesh. The plain file (not jsDelivr's
// +esm bundle) is imported so that the wasm next to it is found; locateFile says so explicitly.
const MANIFOLD_URL = 'https://cdn.jsdelivr.net/npm/manifold-3d@3.5.4/';

onmessage = async ({ data }) => {
  try {
    await { load, cut, zip }[data.cmd](data);
  } catch (e) {
    // Errors lose custom fields when posted, so send the parts ui.errorText needs.
    const code = e.code || (e instanceof RangeError ? 'too_large' : undefined); // RangeError: out of memory
    postMessage({ error: { code, data: e.data, message: e.message } });
  }
};

async function load({ file, allowTruncated }) {
  const mesh = await parseMesh(file, { name: file.name, allowTruncated, onProgress: (progress) => postMessage({ progress }) });
  const tri = mesh.triangles;
  const box = bounds(tri);
  const size = box.max.map((v, i) => v - box.min[i]);
  if (!size.every(Number.isFinite)) throw Object.assign(new Error('no finite triangles'), { code: 'no_triangles' });
  let open = null; // unknown when a huge mesh leaves no memory for the check
  try {
    const a = analyze(tri);
    open = a.openEdges + a.nonManifold;
  } catch {}
  postMessage({ loaded: { triangles: tri, count: mesh.count, bad: mesh.bad, truncated: mesh.truncated, size, open, volume: volume(tri) } }, [tri.buffer]);
}

async function zip({ files }) {
  const entries = [];
  for (const f of files) entries.push({ name: f.name, data: f.data ?? new Uint8Array(await writeSTL(f.triangles).arrayBuffer()) });
  postMessage({ zip: zipStore(entries) });
}

async function cut({ triangles, perm, n, joints }) {
  postMessage({ stage: 'lib' });
  let M;
  try {
    M = await (await import(`${MANIFOLD_URL}manifold.js`)).default({ locateFile: (file) => MANIFOLD_URL + file });
    M.setup();
  } catch (e) {
    throw Object.assign(new Error(e?.message || String(e)), { code: 'lib' });
  }
  postMessage({ stage: 'prep' });
  const dims = orient(triangles, perm);
  // Soup -> solid. Vertices are merged only when their coordinates are identical: nothing is repaired.
  const solid = (tri) => {
    const { vertices, indices } = weld(tri);
    return new M.Manifold(new M.Mesh({ numProp: 3, vertProperties: vertices, triVerts: indices }));
  };
  const soup = (s) => {
    const { vertProperties: v, triVerts: t, numProp: k } = s.getMesh();
    const out = new Float32Array(t.length * 3);
    for (let i = 0; i < t.length; i++) out.set(v.subarray(t[i] * k, t[i] * k + 3), i * 3);
    return out;
  };

  let pieces;
  try {
    let model;
    try {
      model = solid(triangles);
    } catch (e) {
      if (e?.code === 'NotManifold') throw Object.assign(new Error(e.message), { code: 'open' });
      throw e;
    }
    // Closed but inside out: the library would cut the space around the model instead of the model.
    if (!(model.volume() > 0)) throw Object.assign(new Error('volume is not positive'), { code: 'open' });

    // Cut axis by axis: X slabs first, then each slab along Y, then along Z. Later cuts work on smaller meshes.
    let total = 0;
    for (let a = 0, cells = 1; a < 3; a++) if (n[a] > 1) total += (cells *= n[a]);
    let done = 0;
    let parts = [{ index: [], solid: model }];
    for (let axis = 0; axis < 3; axis++) {
      if (n[axis] === 1) {
        for (const p of parts) p.index.push(0);
        continue;
      }
      const cutters = Array.from({ length: n[axis] }, (_, m) => solid(slab(dims, axis, m, n[axis], joints[axis])));
      const next = [];
      for (const part of parts) {
        for (let m = 0; m < n[axis]; m++) {
          postMessage({ stage: 'cut', done, total });
          const piece = part.solid.intersect(cutters[m]);
          const status = piece.status(); // Booleans are lazy: this is where the work (and any failure) happens
          if (status !== 'NoError') throw new Error(status);
          done++;
          if (piece.isEmpty()) piece.delete(); // empty cell
          else next.push({ index: [...part.index, m], solid: piece });
        }
        part.solid.delete(); // WASM objects are not garbage collected
      }
      for (const c of cutters) c.delete();
      parts = next;
    }
    pieces = parts.map(({ index, solid: s }) => {
      const tri = soup(s);
      s.delete();
      return { index, triangles: tri, ...bounds(tri), volume: volume(tri) };
    });
  } catch (e) {
    if (e?.code === 'open') throw e;
    // Out of memory arrives as a RangeError, an aborted WASM runtime or a bare C++ exception, depending on where.
    const message = e?.message || String(e);
    const memory = e instanceof RangeError || !(e instanceof Error) || /memory|alloc|abort|ResultTooLarge/i.test(message);
    throw Object.assign(new Error(message), { code: memory ? 'too_large' : 'cut' });
  }
  postMessage({ pieces, dims }, pieces.map((p) => p.triangles.buffer));
}
