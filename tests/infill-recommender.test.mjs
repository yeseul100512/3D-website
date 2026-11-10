// Scenarios derived from the owner's infill guide (pattern choice, starting ranges, material notes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recommend, OPTIONS } from '../src/tools/infill-recommender/rules.js';

const base = { use: 'household', load: 'none', material: 'pla', priority: 'strength', size: 'normal', topQuality: false };
const rec = (o) => recommend({ ...base, ...o });

test('display model without load: Lightning, Adaptive Cubic as alternative, extra top layers', () => {
  const r = rec({ use: 'display', priority: 'speed' });
  assert.equal(r.pattern, 'lightning');
  assert.equal(r.alt, 'adaptivecubic');
  assert.deepEqual([r.density.lo, r.density.hi, r.walls.lo, r.walls.hi], [5, 10, 2, 2]);
  assert.deepEqual([r.top.lo, r.top.hi, r.top.extra], [5, 7, true]); // 4-5 plus 1-2
  assert.deepEqual([r.bottom.lo, r.bottom.hi], [3, 3]);
  assert.ok(r.notes.includes('lightning_weak') && r.fixes.includes('display_force'));
  assert.ok(!r.fixes.includes('weak'));
});

test('display model that takes any force: Adaptive Cubic instead of Lightning', () => {
  const r = rec({ use: 'display', load: 'all' });
  assert.equal(r.pattern, 'adaptivecubic');
  assert.ok(!r.notes.includes('lightning_weak'));
});

test('transparent / exposed infill: Concentric, Locked Zag alternative, update note', () => {
  const r = rec({ use: 'visible' });
  assert.deepEqual([r.pattern, r.alt], ['concentric', 'lockedzag']);
  assert.ok(r.notes.includes('new_pattern'));
});

test('exposed infill under load: Locked Zag first and a warning about Concentric', () => {
  const r = rec({ use: 'visible', load: 'side' });
  assert.deepEqual([r.pattern, r.alt], ['lockedzag', 'concentric']);
  assert.ok(r.notes.includes('concentric_weak'));
});

test('functional part, load from every direction: Gyroid / Cubic, 25-40 %, 3-4 walls', () => {
  const r = rec({ use: 'functional', load: 'all' });
  assert.deepEqual([r.pattern, r.alt], ['gyroid', 'cubic']);
  assert.deepEqual([r.density.lo, r.density.hi, r.density.start], [25, 40, 25]);
  assert.deepEqual([r.walls.lo, r.walls.hi, r.walls.start], [3, 4, 4]); // strength: walls first
  assert.deepEqual([r.top.lo, r.top.hi, r.top.extra], [5, 6, false]);
  assert.deepEqual([r.bottom.lo, r.bottom.hi], [4, 4]);
  assert.ok(r.notes.includes('gyroid_vibration'));
  assert.equal(r.fixes[0], 'weak');
});

test('side shear load: Tri-hexagon, 2D Lattice with a large angle as alternative', () => {
  const r = rec({ use: 'functional', load: 'side' });
  assert.deepEqual([r.pattern, r.alt], ['trihexagon', 'lattice_large']);
  assert.ok(r.notes.includes('new_pattern'));
});

test('compression from above: 2D Lattice with a small angle', () => {
  const r = rec({ use: 'functional', load: 'top' });
  assert.equal(r.pattern, 'lattice_small');
  assert.ok(r.notes.includes('new_pattern'));
});

test('stiffness / impact: Honeycomb with its material cost; lighter priority picks 3D Honeycomb', () => {
  const r = rec({ use: 'functional', load: 'impact' });
  assert.deepEqual([r.pattern, r.alt], ['honeycomb', 'honeycomb3d']);
  assert.ok(r.notes.includes('honeycomb_cost'));
  const light = rec({ use: 'functional', load: 'impact', priority: 'weight' });
  assert.deepEqual([light.pattern, light.alt], ['honeycomb3d', 'honeycomb']);
  assert.ok(!light.notes.includes('honeycomb_cost'));
});

test('heavy load / screw joints: 40-60 %, 4-6 walls, modifier advice, Cubic before Gyroid', () => {
  const r = rec({ use: 'heavy', load: 'all' });
  assert.deepEqual([r.pattern, r.alt], ['cubic', 'gyroid']);
  assert.deepEqual([r.density.lo, r.density.hi, r.walls.lo, r.walls.hi, r.walls.start], [40, 60, 4, 6, 6]);
  assert.deepEqual([r.top.lo, r.top.hi, r.bottom.lo, r.bottom.hi], [6, 7, 4, 5]);
  assert.ok(r.notes.includes('modifier'));
});

test('quick household prototype without load: Grid / Cross Hatch and the scraping note', () => {
  const r = rec({ priority: 'speed' });
  assert.deepEqual([r.pattern, r.alt], ['grid', 'crosshatch']);
  assert.ok(r.notes.includes('grid_scrape'));
  assert.equal(r.walls.start, 2);
});

test('household part: 15-20 %, 2-3 walls, low density adds top layers', () => {
  const r = rec({});
  assert.equal(r.pattern, 'gyroid');
  assert.deepEqual([r.density.lo, r.density.hi, r.walls.lo, r.walls.hi], [15, 20, 2, 3]);
  assert.deepEqual([r.top.lo, r.top.hi, r.top.extra], [6, 7, true]); // 5 plus 1-2 because the start is 15 %
  assert.deepEqual([r.bottom.lo, r.bottom.hi], [3, 4]);
  assert.ok(!r.notes.includes('gyroid_vibration'));
});

test('large model with time or material priority: Adaptive Cubic, but not for heavy loads', () => {
  assert.equal(rec({ use: 'functional', load: 'all', size: 'large', priority: 'speed' }).pattern, 'adaptivecubic');
  assert.equal(rec({ size: 'large', priority: 'weight' }).pattern, 'adaptivecubic');
  assert.equal(rec({ use: 'functional', load: 'all', size: 'large' }).pattern, 'gyroid'); // strength first
  assert.equal(rec({ use: 'heavy', load: 'all', size: 'large', priority: 'speed' }).pattern, 'cubic');
});

test('load across the layers (Z): orientation note first, general pattern, layer-split fix', () => {
  const r = rec({ use: 'functional', load: 'z' });
  assert.equal(r.notes[0], 'z');
  assert.equal(r.pattern, 'gyroid');
  assert.ok(r.fixes.includes('layer_split'));
});

test('ABS/ASA: enclosure note, Gyroid even for heavy parts, warp fix', () => {
  const r = rec({ use: 'heavy', load: 'all', material: 'abs' });
  assert.equal(r.pattern, 'gyroid');
  assert.ok(r.notes.includes('abs') && !r.notes.includes('abs_flat'));
  assert.ok(r.fixes.includes('warp'));
});

test('large flat ABS/ASA part: strength from walls, density stays low, Monotonic top', () => {
  const r = rec({ use: 'functional', load: 'all', material: 'abs', size: 'flat', priority: 'speed' });
  assert.ok(r.notes.includes('abs_flat'));
  assert.equal(r.walls.start, r.walls.hi);
  assert.equal(r.density.start, r.density.lo);
  assert.equal(r.topPattern, 'monotonic');
});

test('CF filament: hardened nozzle / orientation note and layer-split fix', () => {
  const r = rec({ use: 'functional', load: 'all', material: 'cf' });
  assert.ok(r.notes.includes('cf') && r.fixes.includes('layer_split'));
  assert.ok(!rec({ material: 'other' }).notes.some((n) => ['abs', 'cf'].includes(n)));
});

test('top surface: Monotonic only when asked; surface priority starts at the thicker top', () => {
  assert.equal(rec({}).topPattern, null);
  assert.equal(rec({ topQuality: true }).topPattern, 'monotonic');
  const r = rec({ use: 'functional', load: 'all', priority: 'surface' });
  assert.equal(r.topPattern, 'monotonic');
  assert.equal(r.top.start, r.top.hi);
  assert.equal(r.walls.start, r.walls.lo);
});

test('every combination gives finite, ordered numbers and known keys; bad input throws', () => {
  let n = 0;
  for (const use of OPTIONS.use) for (const load of OPTIONS.load) for (const material of OPTIONS.material)
    for (const priority of OPTIONS.priority) for (const size of OPTIONS.size) for (const topQuality of [false, true]) {
      const r = recommend({ use, load, material, priority, size, topQuality });
      for (const k of ['density', 'walls', 'top', 'bottom']) {
        const { lo, hi, start } = r[k];
        assert.ok([lo, hi, start].every(Number.isInteger) && lo <= start && start <= hi && lo > 0, `${k} ${use}/${load}`);
      }
      assert.ok(r.density.hi <= 60 && r.pattern !== r.alt && r.fixes.length >= 2);
      // never Triangles for strength, never a weak pattern for a loaded working part
      if (load !== 'none' && use !== 'visible') assert.ok(!['lightning', 'concentric', 'grid', 'crosshatch'].includes(r.pattern));
      n++;
    }
  assert.equal(n, 5 * 6 * 4 * 4 * 3 * 2);
  assert.throws(() => recommend({ ...base, use: 'rocket' }), RangeError);
  assert.throws(() => recommend({ ...base, load: undefined }), RangeError);
  assert.throws(() => recommend(null), RangeError);
});
