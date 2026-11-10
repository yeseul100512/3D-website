// One job per worker: 'load' parses a file, 'cut' splits a triangle soup, 'zip' packs the pieces.
// The page cancels by terminate().
import { parseMesh, bounds, writeSTL } from '../../lib/mesh-io.js';
import { zipStore } from '../../lib/zip.js';
import { analyze } from '../../lib/mesh-analyze.js';
import { volume, orient, slab } from './cut-plan.js';

// The jsDelivr bundle of three-bvh-csg 0.0.18 imports exactly these two builds; using the same three URL
// here keeps a single copy of three.js in the worker.
const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.182.0/+esm';
const CSG_URL = 'https://cdn.jsdelivr.net/npm/three-bvh-csg@0.0.18/+esm';

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
  let THREE, CSG;
  if (n.some((v) => v > 1)) { // nothing to cut: no need for the library (or a connection)
    postMessage({ stage: 'lib' });
    try {
      [THREE, CSG] = await Promise.all([import(THREE_URL), import(CSG_URL)]);
    } catch (e) {
      throw Object.assign(new Error(e.message), { code: 'lib' });
    }
  }
  postMessage({ stage: 'prep' });
  const dims = orient(triangles, perm);
  const evaluator = CSG && new CSG.Evaluator();
  if (CSG) {
    evaluator.attributes = ['position'];
    evaluator.useGroups = false;
  }
  const brush = (tri) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(tri, 3));
    const b = new CSG.Brush(g);
    b.updateMatrixWorld();
    return b;
  };
  // Result geometry -> plain soup (handles an index and a draw range, whichever the library produced).
  const soup = (g) => {
    const pos = g.attributes.position;
    if (!pos) return new Float32Array(0);
    if (!g.index) return pos.array.slice(0, Math.min(pos.count, g.drawRange.count) * 3);
    const idx = g.index.array;
    const count = Math.min(g.index.count, g.drawRange.count);
    const out = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) out.set(pos.array.subarray(idx[i] * 3, idx[i] * 3 + 3), i * 3);
    return out;
  };

  // Cut axis by axis: X slabs first, then each slab along Y, then along Z. Later cuts work on smaller meshes.
  let total = 0;
  for (let a = 0, cells = 1; a < 3; a++) if (n[a] > 1) total += (cells *= n[a]);
  let done = 0;
  let parts = [{ index: [], tri: triangles }];
  try {
    for (let axis = 0; axis < 3; axis++) {
      if (n[axis] === 1) {
        for (const p of parts) p.index.push(0);
        continue;
      }
      const cutters = Array.from({ length: n[axis] }, (_, m) => brush(slab(dims, axis, m, n[axis], joints[axis])));
      const next = [];
      for (const part of parts) {
        const b = brush(part.tri);
        for (let m = 0; m < n[axis]; m++) {
          postMessage({ stage: 'cut', done, total });
          const tri = soup(evaluator.evaluate(b, cutters[m], CSG.INTERSECTION).geometry);
          done++;
          if (tri.length >= 36) next.push({ index: [...part.index, m], tri }); // fewer than 4 triangles: empty cell
        }
      }
      parts = next;
    }
  } catch (e) {
    throw Object.assign(new Error(e.message), { code: e instanceof RangeError ? 'too_large' : 'cut' });
  }
  // The CSG library sometimes leaves a sliver of a cutter face, which lies outside the model: drop those.
  const tidy = (tri) => {
    let w = 0;
    for (let i = 0; i < tri.length; i += 9) {
      let inside = true;
      for (let k = 0; k < 9; k++) if (tri[i + k] < -0.01 || tri[i + k] > dims[k % 3] + 0.01) inside = false;
      if (inside) tri.copyWithin(w, i, i + 9), (w += 9);
    }
    return tri.slice(0, w);
  };
  const pieces = parts.map(({ index, tri }) => ({ index, triangles: (tri = tidy(tri)), ...bounds(tri), volume: volume(tri) }));
  postMessage({ pieces, dims }, pieces.map((p) => p.triangles.buffer));
}
