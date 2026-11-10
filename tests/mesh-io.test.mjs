import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMesh, MeshError, bounds, weld, writeSTL, writeOBJ, write3MF } from '../src/assets/lib/mesh-io.js';
import { zipStore } from '../src/assets/lib/zip.js';

// 10 x 20 x 30 mm box, 12 triangles
function box(x = 10, y = 20, z = 30) {
  const p = [[0, 0, 0], [x, 0, 0], [x, y, 0], [0, y, 0], [0, 0, z], [x, 0, z], [x, y, z], [0, y, z]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return new Float32Array(f.flatMap((t) => t.flatMap((i) => p[i])));
}
const bytes = async (blob) => new Uint8Array(await blob.arrayBuffer());
const ascii = (tri, name = 'box') =>
  `solid ${name}\n` +
  Array.from({ length: tri.length / 9 }, (_, t) =>
    ` facet normal 0 0 0\n  outer loop\n${[0, 1, 2].map((c) => `   vertex ${tri[t * 9 + c * 3]} ${tri[t * 9 + c * 3 + 1]} ${tri[t * 9 + c * 3 + 2]}\n`).join('')}  endloop\n endfacet\n`).join('') +
  `endsolid ${name}\n`;
const enc = (s) => new TextEncoder().encode(s);
const code = (c, data) => (e) => {
  assert.ok(e instanceof MeshError, String(e));
  assert.equal(e.code, c);
  if (data) assert.deepEqual(e.data, data);
  return true;
};

test('binary STL round trip, bounds and object range', async () => {
  const m = await parseMesh(await bytes(writeSTL(box())), { name: 'part.stl' });
  assert.equal(m.format, 'stl-binary');
  assert.equal(m.count, 12);
  assert.deepEqual([...m.triangles], [...box()]);
  assert.deepEqual(m.objects, [{ name: 'part', start: 0, count: 12 }]);
  assert.deepEqual(bounds(m.triangles), { min: [0, 0, 0], max: [10, 20, 30] });
  assert.equal(m.bad, 0);
  assert.equal(m.truncated, null);
});

test('binary STL whose header starts with "solid" is still binary', async () => {
  const u8 = await bytes(writeSTL(box()));
  u8.set(enc('solid looks like ascii'));
  assert.equal((await parseMesh(u8)).format, 'stl-binary');
});

test('binary STL with trailing bytes loads; Blob and ArrayBuffer inputs work', async () => {
  const u8 = await bytes(writeSTL(box()));
  const padded = new Uint8Array(u8.length + 7);
  padded.set(u8);
  assert.equal((await parseMesh(padded)).count, 12);
  assert.equal((await parseMesh(new Blob([u8]))).count, 12);
  assert.equal((await parseMesh(u8.buffer)).count, 12);
});

test('truncated binary STL: typed error with counts, intact part on request', async () => {
  const cut = (await bytes(writeSTL(box()))).subarray(0, 84 + 50 * 7 + 13);
  await assert.rejects(parseMesh(cut), code('truncated', { declared: 12, present: 7 }));
  const m = await parseMesh(cut, { allowTruncated: true });
  assert.equal(m.count, 7);
  assert.deepEqual(m.truncated, { declared: 12, present: 7 });
  assert.deepEqual([...m.triangles], [...box().subarray(0, 63)]);
});

test('ASCII STL: plain, without "solid" prefix, multiple solids', async () => {
  const m = await parseMesh(enc(ascii(box())), { name: 'a.stl' });
  assert.equal(m.format, 'stl-ascii');
  assert.deepEqual([...m.triangles], [...box()]);
  assert.deepEqual(m.objects, [{ name: 'box', start: 0, count: 12 }]);

  const noPrefix = ascii(box()).replace(/^solid box\n/, '﻿');
  assert.equal((await parseMesh(enc(noPrefix), { name: 'a.stl' })).count, 12);

  const two = await parseMesh(enc(ascii(box(), 'left side') + ascii(box(1, 1, 1).subarray(0, 18), '오른쪽')));
  assert.deepEqual(two.objects, [{ name: 'left side', start: 0, count: 12 }, { name: '오른쪽', start: 12, count: 2 }]);
});

test('ASCII STL cut in the middle of a facet is reported as truncated', async () => {
  const text = ascii(box());
  const cut = enc(text.slice(0, text.lastIndexOf('vertex')));
  await assert.rejects(parseMesh(cut), code('truncated', { declared: null, present: 11 }));
  assert.equal((await parseMesh(cut, { allowTruncated: true })).count, 11);
});

test('errors: empty, garbage, text, zero triangles', async () => {
  await assert.rejects(parseMesh(new Uint8Array(0)), code('empty'));
  const rnd = new Uint8Array(100_000);
  for (let i = 0, s = 1; i < rnd.length; i++) rnd[i] = (s = (Math.imul(s, 1103515245) + 12345) >>> 0) >>> 16;
  await assert.rejects(parseMesh(rnd), code('not_mesh'));
  await assert.rejects(parseMesh(enc('G28\nG1 X10 Y10 E1.5 F1800\n'.repeat(400))), code('not_mesh'));
  await assert.rejects(parseMesh(enc('PK\x03\x04 not really a zip'.repeat(10))), code('not_mesh'));
  await assert.rejects(parseMesh(await bytes(writeSTL(new Float32Array(0)))), code('no_triangles'));
  await assert.rejects(parseMesh(enc('solid empty\nendsolid empty\n')), code('no_triangles'));
});

test('NaN / Infinity triangles are counted and left out, not silently kept', async () => {
  const tri = box();
  tri[9] = NaN;
  tri[40] = Infinity;
  const m = await parseMesh(await bytes(writeSTL(tri)));
  assert.equal(m.count, 10);
  assert.equal(m.bad, 2);
  assert.equal(m.triangles.buffer.byteLength, 10 * 36); // exact buffer: safe to transfer
  assert.ok(m.triangles.every(Number.isFinite));
  const a = await parseMesh(enc(ascii(box()).replace('vertex 10 20 0', 'vertex 10 nan 0')));
  assert.equal(a.bad, 1);
  assert.equal(a.count, 11);
});

test('OBJ: quads are triangulated, negative and slash indices, objects', async () => {
  const obj = `# comment
o base
v 0 0 0
v 10 0 0
v 10 10 0
v 0 10 0
f 1/1/1 2/2/1 3/3/1 4/4/1
o tip
v 5 5 8
f -1 1 2
f 1//1 2//1 99//1
`;
  const m = await parseMesh(enc(obj), { name: 'x.obj' });
  assert.equal(m.format, 'obj');
  assert.equal(m.count, 3);
  assert.equal(m.bad, 1);
  assert.deepEqual(m.objects, [{ name: 'base', start: 0, count: 2 }, { name: 'tip', start: 2, count: 1 }]);
  assert.deepEqual([...m.triangles.subarray(18)], [5, 5, 8, 0, 0, 0, 10, 0, 0]);
});

test('OBJ and 3MF writers round trip', async () => {
  const o = await parseMesh(await bytes(writeOBJ(box())));
  assert.deepEqual([...o.triangles], [...box()]);
  const tri = new Float32Array([...box(), ...box(0.1, 1e-7, 123456.789)]);
  const m = await parseMesh(write3MF(tri, [{ name: 'A & B', start: 0, count: 12 }, { name: '둘째', start: 12, count: 12 }]));
  assert.equal(m.format, '3mf');
  assert.deepEqual([...m.triangles], [...tri]);
  assert.deepEqual(m.objects, [{ name: 'A & B', start: 0, count: 12 }, { name: '둘째', start: 12, count: 12 }]);
});

test('3MF: unit, build-item and component transforms, external object files, slicer names', async () => {
  const mesh = '<mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh>';
  const zip = zipStore([
    { name: '_rels/.rels', data: '<Relationships><Relationship Target="/3D/3dmodel.model" Id="r" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>' },
    {
      name: '3D/3dmodel.model',
      data: `<?xml version="1.0"?><model unit="inch" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"><resources>
        <object id="1" type="model" name="plain">${mesh}</object>
        <object id="2" type="model"><components>
          <component p:path="/3D/Objects/object_1.model" objectid="7" transform="2 0 0 0 2 0 0 0 2 1 0 0"/>
          <component objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 5"/>
        </components></object></resources>
        <build><item objectid="1"/><item objectid="2" transform="0 1 0 -1 0 0 0 0 1 10 0 0"/></build></model>`,
    },
    { name: '3D/Objects/object_1.model', data: `<model unit="inch"><resources><object id="7" type="model">${mesh}</object></resources></model>` },
    { name: 'Metadata/model_settings.config', data: '<config><object id="2">\n<metadata key="name" value="Assembly &amp; co"/></object></config>' },
  ]);
  const m = await parseMesh(zip, { name: 'plate.3mf' });
  assert.equal(m.unit, 'inch');
  assert.deepEqual(m.objects, [{ name: 'plain', start: 0, count: 1 }, { name: 'Assembly & co', start: 1, count: 2 }]);
  const mm = [...m.triangles].map((v) => Math.round((v / 25.4) * 1e4) / 1e4);
  assert.deepEqual(mm.slice(0, 9), [0, 0, 0, 1, 0, 0, 0, 1, 0]);
  // external part: scale 2, move +1 x, then item: rotate 90 deg about z (x,y -> -y,x) and move +10 x
  assert.deepEqual(mm.slice(9, 18), [10, 1, 0, 10, 3, 0, 8, 1, 0]);
  // local part: move +5 z, then the same item transform
  assert.deepEqual(mm.slice(18), [10, 0, 5, 10, 1, 5, 9, 0, 5]);
});

test('3MF without a mesh or with a missing part gives typed errors', async () => {
  const rels = { name: '_rels/.rels', data: '<Relationships><Relationship Target="/3D/3dmodel.model" Type="x/3dmodel"/></Relationships>' };
  await assert.rejects(parseMesh(zipStore([rels, { name: '3D/3dmodel.model', data: '<model><resources/><build/></model>' }])), code('no_triangles'));
  await assert.rejects(parseMesh(zipStore([rels])), code('not_mesh'));
  await assert.rejects(parseMesh(zipStore([{ name: 'readme.txt', data: 'hi' }])), code('not_mesh'));
});

test('weld merges identical vertices', () => {
  const { vertices, indices } = weld(box());
  assert.equal(vertices.length, 8 * 3);
  assert.equal(indices.length, 36);
  const back = [...indices].flatMap((i) => [...vertices.subarray(i * 3, i * 3 + 3)]);
  assert.deepEqual(back, [...box()]);
});

test('large binary STL through a Blob is read in chunks', async () => {
  const n = 1_050_000;
  const tri = new Float32Array(n * 9);
  for (let i = 0; i < tri.length; i++) tri[i] = (i % 1000) / 8;
  const seen = [];
  const m = await parseMesh(writeSTL(tri), { onProgress: (f) => seen.push(f) });
  assert.equal(m.count, n);
  assert.equal(seen.length, 2);
  assert.equal(seen.at(-1), 1);
  assert.equal(m.triangles[tri.length - 1], tri[tri.length - 1]);
  assert.equal(m.triangles[9_000_005], tri[9_000_005]);
});

// ---- regression tests for reviewed defects ----------------------------------------------------------
import { analyze } from '../src/assets/lib/mesh-analyze.js';

const RELS = { name: '_rels/.rels', data: '<Relationships><Relationship Target="/3D/3dmodel.model" Type="x/3dmodel"/></Relationships>' };
function model3mf(tri, build, extra = '') {
  const v = Array.from({ length: tri.length / 3 }, (_, i) => `<vertex x="${tri[i * 3]}" y="${tri[i * 3 + 1]}" z="${tri[i * 3 + 2]}"/>`).join('');
  const t = Array.from({ length: tri.length / 9 }, (_, i) => `<triangle v1="${i * 3}" v2="${i * 3 + 1}" v3="${i * 3 + 2}"/>`).join('');
  const data = `<model unit="millimeter"><resources><object id="1" type="model"><mesh><vertices>${v}</vertices><triangles>${t}</triangles></mesh></object>${extra}</resources><build>${build}</build></model>`;
  return zipStore([RELS, { name: '3D/3dmodel.model', data }]);
}

test('3MF: a mirroring transform does not turn the part inside out', async () => {
  const plain = await parseMesh(model3mf(box(), '<item objectid="1"/>'));
  assert.equal(analyze(plain.triangles).flipped, 0);
  for (const build of [
    '<item objectid="1" transform="-1 0 0 0 1 0 0 0 1 10 0 0"/>', // mirrored build item
    '<item objectid="2"/>', // mirrored component
    '<item objectid="2" transform="1 0 0 0 -1 0 0 0 1 0 0 0"/>', // mirrored twice = a rotation
  ]) {
    const m = await parseMesh(model3mf(box(), build, '<object id="2" type="model"><components><component objectid="1" transform="1 0 0 0 1 0 0 0 -1 0 0 0"/></components></object>'));
    const a = analyze(m.triangles);
    assert.equal(a.flipped, 0, build);
    assert.ok(a.watertight);
    assert.ok(Math.abs(a.volume - 6000) < 1e-3);
  }
});

test('3MF: odd object ids and runaway component trees give a MeshError, not a crash or a hang', async () => {
  await assert.rejects(parseMesh(model3mf(box(), '<item objectid="(1"/>')), code('no_triangles'));
  // 16 levels, each object holding the next one six times: 6^16 triangles' worth, answered at once
  let chain = '';
  for (let id = 2; id <= 17; id++) chain += `<object id="${id}" type="model"><components>${`<component objectid="${id === 2 ? 1 : id - 1}"/>`.repeat(6)}</components></object>`;
  await assert.rejects(parseMesh(model3mf(box(), '<item objectid="17"/>', chain)), code('too_large'));
  const loop = '<object id="2" type="model"><components><component objectid="3"/></components></object><object id="3" type="model"><components><component objectid="2"/></components></object>';
  await assert.rejects(parseMesh(model3mf(box(), '<item objectid="2"/>', loop)), code('not_mesh'));
});

test('ASCII STL: every way of being cut off is reported, and no damaged vertex is kept', async () => {
  const full = ascii(box());
  assert.equal((await parseMesh(enc(full))).truncated, null);
  const second = full.indexOf(' facet', full.indexOf(' facet') + 1);
  const third = full.indexOf(' facet', second + 1);
  const cuts = {
    'inside a facet header': [full.slice(0, third + 12), 2],
    'after an endfacet': [full.slice(0, third), 2],
    'inside the last number of a facet': [full.slice(0, full.indexOf('  endloop', third) - 2), 2], // "... 30\n" -> "... 3"
    'before endsolid': [full.slice(0, full.lastIndexOf('endsolid')), 12],
  };
  for (const [where, [text, present]] of Object.entries(cuts)) {
    await assert.rejects(parseMesh(enc(text)), code('truncated', { declared: null, present }), where);
    const m = await parseMesh(enc(text), { allowTruncated: true });
    assert.equal(m.count, present, where);
    assert.deepEqual([...m.triangles], [...box().subarray(0, present * 9)], where);
  }
});

test('ASCII STL: "vertex" or "solid" inside a solid name is not a keyword', async () => {
  for (const [a, b] of [['my vertex model', 'x'], ['a', 'my vertex model'], ['vertex 1 2 3', 'solid vertex']]) {
    const m = await parseMesh(enc(ascii(box()).replace('solid box', `solid ${a}`).replace('endsolid box', `endsolid ${b}`)));
    assert.equal(m.count, 12);
    assert.equal(m.truncated, null);
    assert.equal(m.objects[0].name, a);
  }
});

test('format detection looks past a long text header', async () => {
  const pad = '# comment\n'.repeat(600); // 6 KB
  assert.equal((await parseMesh(enc(pad + 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'))).format, 'obj');
  assert.equal((await parseMesh(enc('vt 0 0\n'.repeat(900) + 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'))).format, 'obj');
  assert.equal((await parseMesh(enc(ascii(box(), 'n'.repeat(5000))))).format, 'stl-ascii');
});

test('binary STL with normals that are not unit length: cut off = truncated, padded = loads', async () => {
  const u8 = await bytes(writeSTL(box()));
  const dv = new DataView(u8.buffer);
  for (let t = 0; t < 12; t++) dv.setFloat32(84 + t * 50 + 8, 25, true); // normal (x, y, 25)
  assert.equal((await parseMesh(u8)).count, 12);
  await assert.rejects(parseMesh(u8.slice(0, 84 + 7 * 50 + 20)), code('truncated', { declared: 12, present: 7 }));
  const padded = new Uint8Array(u8.length + 2);
  padded.set(u8);
  assert.equal((await parseMesh(padded)).count, 12);
});

test('write3MF drops control characters that XML does not allow in a name', async () => {
  const m = await parseMesh(enc(ascii(box(), 'a\x01b')));
  assert.equal(m.objects[0].name, 'a\x01b');
  const xml = new TextDecoder().decode(await (await import('../src/assets/lib/zip.js')).readZip(await bytes(write3MF(m.triangles, m.objects))).read('3D/3dmodel.model'));
  assert.ok(xml.includes('name="ab"'));
  assert.ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(xml));
});

test('ASCII STL cut in the middle of a number does not load the shortened number', async () => {
  const text = 'solid a\n facet normal 0 0 1\n  outer loop\n   vertex 0 0 0\n   vertex 1 0 0\n   vertex 0 1 3';
  await assert.rejects(parseMesh(enc(text)), code('truncated', { declared: null, present: 0 })); // was 3.75
  await assert.rejects(parseMesh(enc(text), { allowTruncated: true }), code('no_triangles'));
});
