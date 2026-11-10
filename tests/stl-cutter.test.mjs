// Run `python src/build.py` first: the module is imported from the built copy so its ../../lib imports resolve.
import test from 'node:test';
import assert from 'node:assert/strict';
import { countFor, plan, jointFor, orient, volume, slab, pieceLabel, mapSVG } from '../assets/tools/stl-cutter/cut-plan.js';
import { analyze } from '../assets/lib/mesh-analyze.js';

const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} vs ${b}`);

// Tetrahedron with outward normals, volume 1*2*3/6 = 1.
const tetra = () => new Float32Array([0, 0, 0, 0, 2, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 3, 0, 2, 0, 1, 0, 0, 0, 2, 0, 0, 0, 3]);

test('countFor: pieces fit with their teeth included', () => {
  assert.equal(countFor(150, 196, 4), 1);
  assert.equal(countFor(372, 196, 4), 2); // 186 + 4 <= 196
  assert.equal(countFor(372, 186, 4), 3); // 186 + 4 > 186, so 124 + 8
  assert.equal(countFor(588, 196, 4), 4); // the old tool made 3 pieces of 204 mm
  assert.equal(countFor(588, 196, 0), 3); // flat cut: exactly 196
  assert.equal(countFor(500, 8, 4), Infinity); // teeth alone fill the usable length
  for (const [len, eff, t] of [[372, 196, 4], [1000, 150, 6], [401, 200, 0.5]]) {
    const n = countFor(len, eff, t);
    assert.ok(len / n + Math.min(n - 1, 2) * t <= eff + 1e-6);
  }
});

test('plan: keeps the orientation unless asked, and manual counts win', () => {
  const eff = [56, 56, 196];
  assert.deepEqual(plan([50, 100, 6], eff, 4).perm, [0, 1, 2]);
  assert.deepEqual(plan([50, 100, 6], eff, 4).n, [1, 2, 1]);
  const r = plan([50, 100, 6], eff, 4, { rotate: true });
  assert.equal(r.total, 1);
  assert.deepEqual(r.dims, [50, 6, 100]);
  assert.deepEqual(plan([50, 100, 6], [196, 196, 196], 4, { rotate: true }).perm, [0, 1, 2]); // already fits: no rotation
  assert.deepEqual(plan([50, 100, 6], eff, 4, { rotate: true, manual: [3, 1, 2] }).n, [3, 1, 2]);
  assert.equal(plan([500, 10, 10], [8, 8, 8], 4).total, Infinity);
});

test('orient: a proper rotation that keeps Z up for an X/Y swap', () => {
  for (const perm of [[0, 1, 2], [1, 0, 2], [0, 2, 1], [2, 1, 0], [1, 2, 0], [2, 0, 1]]) {
    const t = tetra();
    const dims = orient(t, perm);
    assert.deepEqual(dims, perm.map((a) => [1, 2, 3][a]));
    near(volume(t), 1); // a mirror would give -1
  }
  const t = tetra();
  orient(t, [1, 0, 2]);
  assert.equal(t[17], 3); // the apex is still at the top
});

test('slab: closed prisms that tile the padded box without overlap', () => {
  const dims = [100, 60, 20];
  const box = 102 * 62 * 22;
  for (const tooth of [null, { width: 15, depth: 4, gap: 0.3 }, { width: 15, depth: 4, gap: 0 }]) {
    for (const axis of [0, 1, 2]) {
      const joint = jointFor(dims, axis, tooth);
      let sum = 0;
      for (let m = 0; m < 3; m++) {
        const s = slab(dims, axis, m, 3, joint);
        assert.ok(analyze(s).watertight, `axis ${axis} slab ${m} is watertight`);
        assert.ok(volume(s) > 0);
        sum += volume(s);
      }
      // Only the clearance beside each tooth is missing: 2 planes x teeth x 2 sides x gap x depth x length.
      const gaps = joint ? 2 * joint.segs * 2 * joint.gap * joint.depth * (dims[3 - axis - joint.comb] + 2) : 0;
      near(sum, box - gaps, 1e-4);
    }
  }
});

test('slab: teeth reach exactly one tooth depth past the plane', () => {
  const dims = [100, 60, 20];
  const joint = jointFor(dims, 0, { width: 15, depth: 4, gap: 0.3 });
  assert.equal(joint.comb, 1); // comb along Y, teeth are upright bars
  assert.equal(joint.segs, 4);
  const xs = (m) => slab(dims, 0, m, 2, joint).filter((_, i) => i % 3 === 0);
  near(Math.max(...xs(0)), 54, 1e-3); // plus a few microns, see NUDGE_PLANE
  near(Math.min(...xs(1)), 46, 1e-3);
  assert.ok(Math.max(...xs(0)) < 54.01);
});

test('labels and map', () => {
  assert.equal(pieceLabel([0, 1, 0], [2, 2, 1]), 'X1-Y2');
  assert.equal(pieceLabel([0, 1, 2], [2, 2, 3]), 'X1-Y2-Z3');
  const svg = mapSVG([372, 270, 45], [2, 2, 1], [{ index: [0, 0, 0] }, { index: [1, 1, 0] }]);
  assert.ok(svg.includes('>X1-Y1<') && svg.includes('>X2-Y2<') && !svg.includes('>X2-Y1<'));
  assert.ok(!/NaN|undefined/.test(svg));
});

// ---- regression tests for reviewed defects ----------------------------------------------------------
import { pieceColor } from '../assets/tools/stl-cutter/cut-plan.js';

// Is (x, y) inside the prism at height z? Parity of the soup's triangles above the point.
function inside(tri, x, y, z) {
  let n = 0;
  for (let i = 0; i < tri.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = tri.subarray(i, i + 9);
    const d = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (!d) continue;
    const u = ((x - ax) * (cy - ay) - (cx - ax) * (y - ay)) / d;
    const v = ((bx - ax) * (y - ay) - (x - ax) * (by - ay)) / d;
    if (u >= 0 && v >= 0 && u + v <= 1 && az + u * (bz - az) + v * (cz - az) > z) n++;
  }
  return n % 2 === 1;
}

test('cutting along X and Y with finger joints leaves no loose sliver at the grid corner', () => {
  const dims = [300, 300, 100];
  const n = [2, 2, 1];
  const tooth = { width: 15, depth: 4, gap: 0.3 };
  const jx = jointFor(dims, 0, tooth, n);
  const jy = jointFor(dims, 1, tooth, n);
  assert.equal(jx.comb, 1);
  assert.equal(jy.comb, 0);
  assert.ok(jx.flat[9] && jx.flat[10] && !jx.flat[8] && !jx.flat[11]); // the teeth beside the crossing are left out
  for (const [mx, my] of [[0, 0], [1, 1], [0, 1], [1, 0]]) {
    // only the triangles over the sampled window matter
    const near = (tri) => tri.filter((_, i) => {
      const t = i - (i % 9);
      return [0, 1].every((k) => Math.max(tri[t + k], tri[t + 3 + k], tri[t + 6 + k]) > 137 && Math.min(tri[t + k], tri[t + 3 + k], tri[t + 6 + k]) < 163);
    });
    const sx = near(slab(dims, 0, mx, 2, jx));
    const sy = near(slab(dims, 1, my, 2, jy));
    // cells of 0.25 mm around the crossing (offset so that no sample lies on a face); count connected regions
    const N = 96;
    const cell = new Uint8Array(N * N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = 138.013 + i * 0.25, y = 138.017 + j * 0.25;
      cell[j * N + i] = inside(sx, x, y, 50.01) && inside(sy, x, y, 50.01) ? 1 : 0;
    }
    let regions = 0;
    for (let s = 0; s < N * N; s++) {
      if (cell[s] !== 1) continue;
      regions++;
      const stack = [s];
      cell[s] = 2;
      while (stack.length) {
        const c = stack.pop();
        for (const d of [c - 1, c + 1, c - N, c + N]) {
          if (d < 0 || d >= N * N || cell[d] !== 1 || (Math.abs(d - c) === 1 && ((d / N) | 0) !== ((c / N) | 0))) continue;
          cell[d] = 2;
          stack.push(d);
        }
      }
    }
    assert.equal(regions, 1, `piece X${mx + 1}-Y${my + 1}`);
  }
  // the slabs still tile the box
  let sum = 0;
  for (let m = 0; m < 2; m++) sum += volume(slab(dims, 0, m, 2, jx));
  const teeth = jx.flat.filter((f) => !f).length;
  near(sum, 302 * 302 * 102 - teeth * 2 * 0.3 * 4 * 102, 1e-4);
});

test('a side too short for two teeth gets a flat cut, not a one-tooth "joint"', () => {
  const tooth = { width: 15, depth: 4, gap: 0.3 };
  assert.equal(jointFor([300, 10, 10], 0, tooth, [2, 1, 1]), null);
  assert.ok(jointFor([300, 40, 10], 0, tooth, [2, 1, 1]));
  // every tooth would sit beside a crossing cut: flat as well
  assert.equal(jointFor([300, 30, 100], 0, tooth, [2, 2, 1]), null);
});

test('plan: rotation is also tried with manual counts; a hopeless size is not a tooth problem', () => {
  const eff = [196, 196, 196];
  assert.deepEqual(plan([100, 100, 350], eff, 4, { manual: [2, 1, 1] }).perm, [0, 1, 2]);
  const r = plan([100, 100, 350], eff, 4, { rotate: true, manual: [2, 1, 1] });
  assert.deepEqual(r.dims, [350, 100, 100]); // the long side is the one that is cut
  assert.equal(r.over, 0);
  assert.deepEqual(plan([100, 100, 100], eff, 4, { rotate: true, manual: [2, 1, 1] }).perm, [0, 1, 2]); // no reason to turn
  // more than 50 pieces on an axis even with flat cuts: main.js then shows js_err_too_long, not js_err_no_fit
  assert.equal(plan([20000, 10, 10], eff, 0).total, Infinity);
  assert.equal(plan([300, 10, 10], [8, 8, 8], 4).total, Infinity); // here the teeth are the problem
  assert.equal(plan([300, 10, 10], [8, 8, 8], 0).total, 38 * 2 * 2);
});

test('pieces that touch never share a colour', () => {
  for (const n of [[4, 2, 2], [8, 2, 1], [8, 8, 3]]) {
    for (let i = 0; i < n[0]; i++) for (let j = 0; j < n[1]; j++) for (let k = 0; k < n[2]; k++) {
      const c = pieceColor([i, j, k], n);
      assert.notEqual(c, pieceColor([i + 1, j, k], n));
      assert.notEqual(c, pieceColor([i, j + 1, k], n));
      assert.notEqual(c, pieceColor([i, j, k + 1], n));
    }
  }
});
