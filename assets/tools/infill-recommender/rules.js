// Infill rules of thumb for Bambu Studio. Pure: answers in, keys out (all texts live in i18n.json).
// Pattern traits follow the Bambu Lab wiki "Fill Pattern Introduction"; the density / wall / shell
// ranges are common FDM starting points for a 0.4 mm nozzle and 0.2 mm layers, not measurements.

export const OPTIONS = {
  use: ['display', 'visible', 'household', 'functional', 'heavy'],
  load: ['none', 'all', 'side', 'top', 'impact', 'z'],
  material: ['pla', 'abs', 'cf', 'other'],
  priority: ['strength', 'speed', 'weight', 'surface'],
  size: ['normal', 'large', 'flat'],
};

// [density %, wall loops, top shell layers, bottom shell layers], each [low, high]
const TIERS = {
  display: [[5, 10], [2, 2], [4, 5], [3, 3]],
  visible: [[5, 10], [2, 2], [4, 5], [3, 3]], // decorative too
  household: [[15, 20], [2, 3], [5, 5], [3, 4]],
  functional: [[25, 40], [3, 4], [5, 6], [4, 4]],
  heavy: [[40, 60], [4, 6], [6, 7], [4, 5]],
};

/** -> [first choice, alternative] */
function pick({ use, load, material, priority, size }) {
  const light = priority === 'speed' || priority === 'weight';
  if (load === 'z') load = 'all'; // infill cannot fix a pull across the layers: note + general pattern
  if (use === 'visible') return load === 'none' ? ['concentric', 'lockedzag'] : ['lockedzag', 'concentric'];
  if (use === 'display') return load === 'none' ? ['lightning', 'adaptivecubic'] : ['adaptivecubic', 'gyroid'];
  if (load === 'side') return ['trihexagon', 'lattice_large'];
  if (load === 'top') return ['lattice_small', 'gyroid'];
  if (load === 'impact') return light ? ['honeycomb3d', 'honeycomb'] : ['honeycomb', 'honeycomb3d'];
  if (load === 'none' && use === 'household' && priority === 'speed') return ['grid', 'crosshatch'];
  if (size !== 'normal' && light && use !== 'heavy') return ['adaptivecubic', 'gyroid'];
  // Gyroid can vibrate at high density and speed, so heavy parts start with Cubic,
  // except ABS/ASA, where a pattern without crossings is kinder to curled infill.
  return use === 'heavy' && material !== 'abs' ? ['cubic', 'gyroid'] : ['gyroid', 'cubic'];
}

/**
 * @param {{use: string, load: string, material: string, priority: string, size: string, topQuality?: boolean}} a
 * @returns {{pattern: string, alt: string,
 *   density: {lo: number, hi: number, start: number}, walls: {lo: number, hi: number, start: number},
 *   top: {lo: number, hi: number, start: number, extra: boolean}, bottom: {lo: number, hi: number, start: number},
 *   topPattern: 'monotonic' | null, notes: string[], fixes: string[]}}
 */
export function recommend(a) {
  for (const k in OPTIONS) if (!OPTIONS[k].includes(a?.[k])) throw new RangeError(`bad ${k}: ${a?.[k]}`);
  const { use, load, material, priority, size } = a;
  const [pattern, alt] = pick(a);
  const [d, w, t, b] = TIERS[use];
  const loaded = load !== 'none';
  const absFlat = material === 'abs' && size === 'flat';

  // Strength comes from walls first, so density always starts at the low end of its range.
  const density = { lo: d[0], hi: d[1], start: d[0] };
  const walls = { lo: w[0], hi: w[1], start: priority === 'strength' || absFlat ? w[1] : w[0] };
  // Sparse support under the top skin (<= 15 % or Lightning) needs 1-2 more top layers.
  const extra = density.start <= 15 || pattern === 'lightning';
  const top = { lo: t[0] + (extra ? 1 : 0), hi: t[1] + (extra ? 2 : 0), extra };
  top.start = priority === 'surface' ? top.hi : top.lo;
  const bottom = { lo: b[0], hi: b[1], start: b[0] };
  const topPattern = a.topQuality || priority === 'surface' || size === 'flat' ? 'monotonic' : null;

  const both = [pattern, alt];
  const notes = [
    load === 'z' && 'z',
    use === 'visible' && loaded && 'concentric_weak',
    pattern === 'lightning' && 'lightning_weak',
    pattern === 'honeycomb' && 'honeycomb_cost',
    both.some((p) => p.startsWith('lattice') || p === 'lockedzag') && 'new_pattern',
    use === 'heavy' && 'modifier',
    material === 'abs' && 'abs',
    absFlat && 'abs_flat',
    material === 'cf' && 'cf',
    pattern === 'gyroid' && (use === 'functional' || use === 'heavy') && 'gyroid_vibration',
    pattern === 'grid' && 'grid_scrape',
  ].filter(Boolean);

  const fixes = [
    (loaded || use === 'functional' || use === 'heavy') && 'weak',
    pattern === 'lightning' && 'display_force',
    'top_sag',
    'noise',
    material === 'abs' && 'warp',
    (load === 'z' || material === 'cf') && 'layer_split',
  ].filter(Boolean);

  return { pattern, alt, density, walls, top, bottom, topPattern, notes, fixes };
}
