// Mesh diagnosis and repair (src/assets/lib/mesh-analyze.js). Fixtures are built here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, repair, verdict, bedFit, unitHint, thinWalls, buildBVH, raycast } from '../src/assets/lib/mesh-analyze.js';

const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} vs ${b}`);

// Axis-aligned box with outward faces: 12 triangles, two per side in the order -z +z -y +y -x +x.
function box(sx = 10, sy = 10, sz = 10, ox = 0, oy = 0, oz = 0) {
  const v = [];
  for (let i = 0; i < 8; i++) v.push([ox + (i & 1 ? sx : 0), oy + (i & 2 ? sy : 0), oz + (i & 4 ? sz : 0)]);
  const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  return new Float32Array(quads.flatMap(([a, b, c, d]) => [a, b, c, a, c, d]).flatMap((i) => v[i]));
}
const join = (...parts) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let w = 0;
  for (const p of parts) {
    out.set(p, w);
    w += p.length;
  }
  return out;
};
const reversed = (t) => [t[0], t[1], t[2], t[6], t[7], t[8], t[3], t[4], t[5]];
const insideOut = (t) => {
  for (let i = 0; i < t.length; i += 9) t.set(reversed(t.subarray(i, i + 9)), i);
  return t;
};

test('clean cube: watertight, exact size, volume and area, nothing to report', () => {
  const a = analyze(box());
  assert.deepEqual(a.size, [10, 10, 10]);
  assert.equal(a.triangles, 12);
  assert.equal(a.vertices, 8);
  assert.equal(a.watertight, true);
  near(a.volume, 1000);
  near(a.area, 600);
  assert.equal(a.shells, 1);
  for (const k of ['openEdges', 'holesTotal', 'nonManifold', 'flipped', 'degenerate', 'duplicate']) assert.equal(a[k], 0, k);
  assert.equal(verdict(a), 'ok');
  assert.equal(verdict(a, { truncated: true }), 'attention');
  assert.equal(verdict(a, { bad: 3 }), 'auto');
});

test('cube with one side removed: one hole of 4 edges; capping it restores a watertight cube', () => {
  const open = box().slice(0, 10 * 9); // drops the +x side
  const a = analyze(open);
  assert.equal(a.watertight, false);
  assert.equal(a.openEdges, 4);
  assert.equal(a.holesTotal, 1);
  assert.equal(a.holes[0].edges, 4);
  assert.equal(a.holes[0].cappable, true);
  near(a.holes[0].size, Math.hypot(10, 10));
  assert.equal(a.hl.open.length, 4 * 6);
  assert.equal(verdict(a), 'attention');

  assert.equal(repair(open, a).tri, open); // nothing chosen, nothing changed
  const r = repair(open, a, { holes: [0] });
  assert.equal(r.capped, 1);
  const b = analyze(r.tri);
  assert.equal(b.triangles, 12);
  assert.equal(b.watertight, true);
  assert.equal(b.flipped, 0); // the cap faces outward
  near(b.volume, 1000);
  assert.deepEqual([b.min, b.max], [a.min, a.max]); // bounding box untouched
});

test('several holes are capped one by one; a bent hole is closed without moving the bounding box', () => {
  const open = box().slice(0, 8 * 9); // drops -x and +x: two separate holes
  const a = analyze(open);
  assert.equal(a.holesTotal, 2);
  const one = analyze(repair(open, a, { holes: [1] }).tri); // only the chosen hole is closed
  assert.equal(one.holesTotal, 1);
  const b = analyze(repair(open, a, { holes: [0, 1] }).tri);
  assert.equal(b.watertight, true);
  near(b.volume, 1000);

  const bent = join(box().slice(0, 9 * 2), box().slice(9 * 4, 9 * 6), box().slice(9 * 8)); // drops +z and +y: one bent hole
  const c = analyze(bent);
  assert.equal(c.holesTotal, 1);
  assert.equal(c.holes[0].edges, 6);
  const d = analyze(repair(bent, c, { holes: [0] }).tri);
  assert.equal(d.openEdges, 0);
  assert.deepEqual([d.min, d.max], [c.min, c.max]);

  // two triangular holes that touch at one corner are still two separate, closable holes
  const t = box();
  const pinch = join(t.slice(0, 9 * 3), t.slice(9 * 4, 9 * 10), t.slice(9 * 11)); // drops (4,7,6) of +z and (1,3,7) of +x
  const e = analyze(pinch);
  assert.equal(e.holesTotal, 2);
  assert.deepEqual(e.holes.map((h) => [h.edges, h.cappable]), [[3, true], [3, true]]);
  const f = analyze(repair(pinch, e, { holes: [0, 1] }).tri);
  assert.equal(f.watertight, true);
  near(f.volume, 1000);
});

test('one flipped triangle is found and turned back; a fully inside-out cube counts all 12', () => {
  const t = box();
  t.set(reversed(t.subarray(27, 36)), 27);
  const a = analyze(t);
  assert.equal(a.flipped, 1);
  assert.equal(a.watertight, true);
  assert.equal(a.hl.flipped.length, 9);
  assert.equal(verdict(a), 'auto');
  const r = repair(t, a, { normals: true });
  assert.equal(r.flipped, 1);
  const fixed = analyze(r.tri);
  assert.equal(fixed.flipped, 0);
  near(fixed.volume, 1000);

  const inside = insideOut(box());
  const b = analyze(inside);
  assert.equal(b.flipped, 12);
  near(b.volume, 1000);
  assert.equal(analyze(repair(inside, b, { normals: true }).tri).flipped, 0);
});

test('a cavity inside a solid is not reported as flipped', () => {
  const a = analyze(join(box(), insideOut(box(4, 4, 4, 3, 3, 3))));
  assert.equal(a.flipped, 0);
  assert.equal(a.shells, 2);
  near(a.volume, 1000 - 64);
});

test('duplicated and collapsed triangles are counted and removed only on request', () => {
  const t = box();
  const dup = join(t, t.subarray(0, 9), new Float32Array([0, 0, 0, 0, 0, 0, 10, 0, 0]));
  const a = analyze(dup);
  assert.equal(a.duplicate, 1);
  assert.equal(a.degenerate, 1);
  assert.equal(a.watertight, true); // they are not part of the surface
  assert.equal(a.nonManifold, 0);
  near(a.volume, 1000);
  assert.equal(verdict(a), 'auto');
  const r = repair(dup, a, { clean: true });
  assert.equal(r.removed, 2);
  assert.deepEqual([...r.tri], [...t]);
});

test('a fin on a cube edge is a non-manifold edge', () => {
  const fin = new Float32Array([0, 0, 0, 10, 0, 0, 5, -5, -5]);
  const a = analyze(join(box(), fin));
  assert.equal(a.nonManifold, 1);
  assert.equal(a.watertight, false);
  assert.equal(a.hl.nonManifold.length, 3 * 6);
  assert.equal(a.openEdges, 2);
  assert.equal(verdict(a), 'attention');
});

test('two separate cubes are two shells; cubes touching at a corner are one', () => {
  const a = analyze(join(box(), box(10, 10, 10, 20, 0, 0)));
  assert.equal(a.shells, 2);
  assert.equal(a.watertight, true);
  near(a.volume, 2000);
  assert.deepEqual(a.size, [30, 10, 10]);
  assert.equal(analyze(join(box(), box(10, 10, 10, 10, 10, 10))).shells, 1);
});

test('welding with a tolerance closes hairline gaps and reports how many vertices merged', () => {
  const t = box();
  t[2] += 0.0004; // first corner of the first triangle no longer matches its neighbours exactly
  const a = analyze(t);
  assert.ok(a.openEdges > 0);
  const r = repair(t, a, { tol: 0.001 });
  assert.equal(r.merged, 1);
  const b = analyze(r.tri);
  assert.equal(b.openEdges, 0);
  assert.equal(b.vertices, 8);
});

test('bedFit and unitHint', () => {
  assert.deepEqual(bedFit([100, 100, 100], [256, 256, 256]), { fit: 'as_is' });
  assert.deepEqual(bedFit([256, 256, 256], [256, 256, 256]), { fit: 'as_is' });
  assert.deepEqual(bedFit([50, 300, 50], [180, 180, 350]), { fit: 'rotated' });
  const r = bedFit([372, 270, 45], [256, 256, 256]);
  assert.equal(r.fit, 'too_big');
  near(r.over[0], 116);
  near(r.over[1], 14);
  assert.equal(r.over[2], 0);
  assert.equal(unitHint([0.05, 0.1, 0.006]), 'm');
  assert.equal(unitHint([2, 4, 0.25]), 'inch');
  assert.equal(unitHint([50, 100, 6]), null);
  assert.equal(unitHint([50000, 100, 6]), 'big');
});

test('thin walls: a 0.5 mm plate is thin, a 10 mm cube is not; ray casting gives exact distances', () => {
  const plate = box(20, 20, 0.5);
  const p = thinWalls(plate, analyze(plate).flip, 0.8, 4000);
  assert.ok(p.share > 0.9, `plate share ${p.share}`);
  assert.equal(p.samples, 4000);
  assert.ok(p.thin.length >= 4);
  const cube = box();
  const c = thinWalls(cube, analyze(cube).flip, 0.8, 4000);
  assert.ok(c.share < 0.01, `cube share ${c.share}`);
  // an inside-out cube gives the same answer because analyze() says which way each face really points
  const inv = insideOut(box());
  assert.ok(thinWalls(inv, analyze(inv).flip, 0.8, 4000).share < 0.01);
  assert.equal(raycast(buildBVH(cube), 5, 4, -5, 0, 0, 1), 5);
  assert.equal(raycast(buildBVH(cube), 5, 4, -5, 0, 0, 1, 5.5), 15);
  assert.equal(raycast(buildBVH(cube), 50, 4, -5, 0, 0, 1), Infinity);
});

// ---- regression tests for reviewed defects ----------------------------------------------------------

// UV sphere: `seg` segments around, seg / 2 rings; small triangles near the poles.
function sphere(r, seg) {
  const p = (i, j) => {
    const th = (Math.PI * j) / (seg / 2), ph = (2 * Math.PI * (i % seg)) / seg;
    return [r * Math.sin(th) * Math.cos(ph), r * Math.sin(th) * Math.sin(ph), r * Math.cos(th)];
  };
  const out = [];
  for (let j = 0; j < seg / 2; j++) {
    for (let i = 0; i < seg; i++) {
      if (j > 0) out.push(...p(i, j), ...p(i, j + 1), ...p(i + 1, j));
      if (j < seg / 2 - 1) out.push(...p(i + 1, j), ...p(i, j + 1), ...p(i + 1, j + 1));
    }
  }
  return new Float32Array(out);
}

test('welding never moves a vertex further than the tolerance, however dense the mesh', () => {
  const t = sphere(5, 400); // edges of about 0.08 mm and much shorter near the poles
  for (const tol of [0.001, 0.02, 0.1]) {
    const r = repair(t, analyze(t), { tol });
    assert.equal(r.tri.length, t.length);
    let far = 0;
    for (let i = 0; i < t.length; i += 3) far = Math.max(far, Math.hypot(r.tri[i] - t[i], r.tri[i + 1] - t[i + 1], r.tri[i + 2] - t[i + 2]));
    assert.ok(far <= tol * 1.0001, `tol ${tol}: moved ${far}`);
    const b = analyze(r.tri);
    near(b.size[2], 10, 2 * tol); // the sphere is still a sphere
    assert.ok(b.volume > 500, `tol ${tol}: volume ${b.volume}`);
  }
});

test('the outline of a flat sheet or of loose triangles is not offered as a hole to close', () => {
  const quad = new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 0, 0, 10, 10, 0, 0, 10, 0]);
  const a = analyze(quad);
  assert.equal(a.holesTotal, 1);
  assert.equal(a.holes[0].cappable, false);
  const r = repair(quad, a, { holes: [0] });
  assert.equal(r.capped, 0);
  assert.equal(r.tri.length, quad.length);
  // two loose triangles that share one corner
  const loose = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 1, 0, -1, 1]);
  assert.ok(analyze(loose).holes.every((h) => !h.cappable));
  // a real hole (a cube without its top) is still closed
  const open = join(box().subarray(0, 18), box().subarray(36));
  const b = analyze(open);
  assert.equal(b.holes[0].cappable, true);
  assert.ok(analyze(repair(open, b, { holes: [0] }).tri).watertight);
});

test('a mesh without triangles is never "printable as it is"', () => {
  const a = analyze(new Float32Array(0));
  assert.deepEqual(a.size, [0, 0, 0]);
  assert.equal(verdict(a), 'attention');
  const collapsed = new Float32Array([0, 0, 0, 0, 0, 0, 1, 0, 0]);
  const r = repair(collapsed, analyze(collapsed), { clean: true });
  assert.equal(r.tri.length, 0);
  assert.equal(verdict(analyze(r.tri)), 'attention');
});

test('thin walls: a surface with nothing behind it is all thin, not 0 %', () => {
  const sheet = new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 0, 0, 10, 10, 0, 0, 10, 0]);
  assert.equal(thinWalls(sheet, analyze(sheet).flip, 0.8, 2000).share, 1);
  const doubled = join(sheet, insideOut(sheet.slice())); // zero-thickness wall: two faces back to back
  assert.equal(thinWalls(doubled, analyze(doubled).flip, 0.8, 2000).share, 1);
});

test('more holes than can be listed: the largest and the smallest are both offered', () => {
  // 600 separate cubes, each missing its top; the opening grows with the cube
  const parts = [];
  for (let i = 0; i < 600; i++) {
    const s = 1 + i * 0.01;
    const b = box(s, s, s, i * 20, 0, 0);
    parts.push(b.subarray(0, 18), b.subarray(36));
  }
  const a = analyze(join(...parts));
  assert.equal(a.holesTotal, 600);
  assert.equal(a.holes.length, 500);
  near(a.holes[0].size, Math.hypot(6.99, 6.99), 1e-3);
  near(a.holes.at(-1).size, Math.hypot(1, 1), 1e-3);
});
