// Planning and geometry for the splitter, without DOM or three.js so Node can test it.
// Frame: after orient() the model sits with its bounding-box minimum at the origin; dims = its size.

export const MAX_PIECES = 200;
export const COLORS = ['#9184d9', '#ff8a3a', '#4ade80', '#f472b6', '#facc15', '#38bdf8', '#d2cefd', '#fb7185'];
const PAD = 1; // mm the cutters reach beyond the model on every outer side
const MAX_N = 50;
// CAD models have many vertices on round coordinates, and so would evenly spaced cut planes. Every cutter face
// is moved a few microns off the round value (far below print resolution, and inside the 0.01 mm fit
// tolerance) so that model faces rarely lie exactly in a cutter face. The former CSG library needed this;
// manifold-3d copes with coincident faces, and the offset is kept because the tested geometry is built on it.
const NUDGE_PLANE = 0.0043;
const NUDGE_COMB = 0.0037;

// perm[r] = the original axis that becomes axis r. Identity first, then the one that keeps Z up.
export const PERMS = [[0, 1, 2], [1, 0, 2], [0, 2, 1], [2, 1, 0], [1, 2, 0], [2, 0, 1]];
const isSwap = (p) => (p[0] !== 0) + (p[1] !== 1) + (p[2] !== 2) === 2;

/** Pieces needed along one axis so that every piece, joint teeth included, is at most `eff` long. */
export function countFor(len, eff, tooth) {
  if (len <= eff + 1e-6) return 1;
  // An end piece carries teeth on one side, a middle piece on both.
  for (let n = 2; n <= MAX_N; n++) if (len / n + Math.min(n - 1, 2) * tooth <= eff + 1e-6) return n;
  return Infinity;
}

/**
 * Choose orientation and grid. size: model size [x,y,z]; eff: usable volume; tooth: how far a joint tooth
 * sticks out of a piece (0 for flat cuts); rotate: also try the other five axis-aligned orientations;
 * manual: [nx,ny,nz] to override the counts (with rotate, the orientation in which most pieces fit wins).
 * @returns {{perm: number[], dims: number[], n: number[], total: number}} total is Infinity if nothing fits
 */
export function plan(size, eff, tooth, { rotate = false, manual = null } = {}) {
  let best;
  for (const perm of rotate ? PERMS : [PERMS[0]]) {
    const dims = perm.map((s) => size[s]);
    const n = manual || dims.map((d, a) => countFor(d, eff[a], tooth));
    // axes on which a piece is still too long (only possible with manual counts)
    const over = n.filter((v, a) => dims[a] / v + Math.min(v - 1, 2) * tooth > eff[a] + 1e-6).length;
    const cand = { perm, dims, n, total: n[0] * n[1] * n[2], axes: n.filter((v) => v > 1).length, over };
    const d = best && (cand.over - best.over || cand.total - best.total || cand.axes - best.axes);
    if (!best || d < 0) best = cand;
  }
  return best;
}

/**
 * Finger-joint layout for the cut planes across `axis`, or null for a flat cut.
 * Teeth alternate along `comb` and run straight through the third axis. For a vertical cut the comb runs
 * along the other horizontal axis when it has room for two teeth, so teeth print as upright bars.
 * Width is adjusted so a whole number of teeth fits.
 * n: pieces per axis. Where another cut crosses this one (a cut plane across the comb axis), the teeth next
 * to the crossing are left out (`flat`): a tooth there would be cut off by the other joint and come out as
 * a loose sliver. Returns null as well when no interlocking tooth is left (the side is too short).
 */
export function jointFor(dims, axis, tooth, n = [1, 1, 1]) {
  if (!tooth) return null;
  const others = [0, 1, 2].filter((a) => a !== axis); // ascending, so a horizontal axis comes first
  const comb = axis === 2
    ? (dims[0] >= dims[1] ? 0 : 1)
    : (dims[others[0]] >= 2 * tooth.width || dims[others[0]] >= dims[others[1]] ? others[0] : others[1]);
  const segs = Math.max(1, Math.round(dims[comb] / tooth.width));
  const w = dims[comb] / segs;
  const reach = tooth.depth + 0.5; // how far the other joint's teeth reach from its cut plane, plus a margin
  const flat = Array.from({ length: segs }, (_, s) => {
    for (let m = 1; m < n[comb]; m++) {
      const c = (m * dims[comb]) / n[comb];
      if ((s + 1) * w > c - reach && s * w < c + reach) return true;
    }
    return false;
  });
  if (segs < 2 || flat.every(Boolean)) return null;
  return { comb, segs, flat, depth: tooth.depth, gap: tooth.gap };
}

/**
 * Rotate the soup in place by perm (a proper rotation, never a mirror: a swap of two axes negates the new X,
 * so swapping X and Y is a quarter turn about Z and the model is not turned upside down), then move the
 * bounding-box minimum to the origin. Returns the size.
 */
export function orient(tri, perm) {
  const flip = isSwap(perm) ? -1 : 1;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const v = [0, 0, 0];
  for (let i = 0; i < tri.length; i += 3) {
    v[0] = flip * tri[i + perm[0]];
    v[1] = tri[i + perm[1]];
    v[2] = tri[i + perm[2]];
    for (let k = 0; k < 3; k++) {
      tri[i + k] = v[k];
      if (v[k] < min[k]) min[k] = v[k];
      if (v[k] > max[k]) max[k] = v[k];
    }
  }
  for (let i = 0; i < tri.length; i += 3) for (let k = 0; k < 3; k++) tri[i + k] -= min[k];
  return max.map((m, k) => m - min[k]);
}

/** Signed volume of a triangle soup (positive when the normals point outwards). */
export function volume(tri) {
  let v = 0;
  for (let i = 0; i < tri.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = [tri[i], tri[i + 1], tri[i + 2], tri[i + 3], tri[i + 4], tri[i + 5], tri[i + 6], tri[i + 7], tri[i + 8]];
    v += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

// Height of one side of the joint at plane P as [u0, u1, height] steps covering the padded comb range.
// upper = false: top of the piece below the plane; upper = true: underside of the piece above it.
// Even teeth belong to the lower piece and odd teeth to the upper one. A tooth is `gap` narrower on each
// side than its socket; tip and socket floor touch, so the assembled length is unchanged.
function profile(P, upper, U, j) {
  if (!j) return [[-PAD, U + PAD, P]];
  const w = U / j.segs;
  const out = [];
  for (let s = 0; s < j.segs; s++) {
    const u0 = s ? s * w + NUDGE_COMB : -PAD;
    const u1 = s < j.segs - 1 ? (s + 1) * w + NUDGE_COMB : U + PAD;
    const tip = upper ? P - j.depth : P + j.depth;
    if (j.flat[s]) out.push([u0, u1, P]);
    else if ((s % 2 === 1) !== upper) out.push([u0, u1, upper ? P + j.depth : P - j.depth]); // socket, full width
    else out.push([u0, u0 + j.gap, P], [u0 + j.gap, u1 - j.gap, tip], [u1 - j.gap, u1, P]);
  }
  return out.filter(([a, b]) => b - a > 1e-9);
}

/**
 * Closed prism (triangle soup, outward normals) covering slab m of n across `axis`: everything between the
 * joint surface of cut plane m and that of plane m+1, reaching PAD beyond the model elsewhere.
 * The n slabs of an axis never overlap, so intersecting the model with one slab per axis gives pieces that
 * cannot collide, also at the corners of a multi-axis grid.
 */
export function slab(dims, axis, m, n, joint) {
  const comb = joint ? joint.comb : (axis + 1) % 3;
  const keep = 3 - axis - comb;
  const U = dims[comb];
  const step = dims[axis] / n;
  const lo = m ? profile(m * step + NUDGE_PLANE, true, U, joint) : [[-PAD, U + PAD, -PAD]];
  const hi = m < n - 1 ? profile((m + 1) * step + NUDGE_PLANE, false, U, joint) : [[-PAD, U + PAD, dims[axis] + PAD]];
  const at = (steps, u) => steps.find(([a, b]) => u >= a && u <= b)[2];
  const marks = [...new Set([...lo, ...hi].flatMap(([a, b]) => [a, b]))].sort((a, b) => a - b);
  const strips = [];
  for (let i = 0; i + 1 < marks.length; i++) {
    const mid = (marks[i] + marks[i + 1]) / 2;
    strips.push({ u0: marks[i], u1: marks[i + 1], lo: at(lo, mid), hi: at(hi, mid) });
  }

  const out = [];
  const v0 = -PAD;
  const v1 = dims[keep] + PAD;
  const put = (p, v) => {
    const q = [0, 0, 0];
    q[comb] = p[0];
    q[axis] = p[1];
    q[keep] = v;
    out.push(q[0], q[1], q[2]);
  };
  strips.forEach((s, k) => {
    const L = strips[k - 1];
    const R = strips[k + 1];
    // Outline of the strip, counter-clockwise in (u, height). The neighbours' corners are inserted on the
    // shared sides so the caps of adjacent strips meet vertex to vertex (no T-junctions).
    const inside = (nb) => (nb ? [nb.lo, nb.hi].filter((y) => y > s.lo && y < s.hi).sort((a, b) => a - b) : []);
    const pts = [[s.u0, s.lo], [s.u1, s.lo], ...inside(R).map((y) => [s.u1, y]), [s.u1, s.hi], [s.u0, s.hi], ...inside(L).reverse().map((y) => [s.u0, y])];
    const c = [(s.u0 + s.u1) / 2, (s.lo + s.hi) / 2];
    pts.forEach((p, i) => {
      const q = pts[(i + 1) % pts.length];
      put(c, v0); put(q, v0); put(p, v0); // caps: a fan around the centre
      put(c, v1); put(p, v1); put(q, v1);
      const nb = p[0] !== q[0] ? null : p[0] === s.u1 ? R : L;
      const mid = (p[1] + q[1]) / 2;
      if (nb && mid > nb.lo && mid < nb.hi) return; // side shared with the next strip: no wall
      put(p, v0); put(q, v0); put(q, v1);
      put(p, v0); put(q, v1); put(p, v1);
    });
  });
  const tri = new Float32Array(out);
  if (volume(tri) < 0) for (let i = 0; i < tri.length; i += 9) for (let k = 0; k < 3; k++) [tri[i + k], tri[i + 3 + k]] = [tri[i + 3 + k], tri[i + k]];
  return tri;
}

/** 'X1-Y2' (plus '-Z1' when there is more than one layer): 1-based grid position of a piece. */
export const pieceLabel = (index, n) => `X${index[0] + 1}-Y${index[1] + 1}` + (n[2] > 1 ? `-Z${index[2] + 1}` : '');

/** Colour of a piece, the same in the 3D view, the table and the map. */
// 1, 3 and 5 steps through the 8 colours per axis: pieces that touch never share a colour.
export const pieceColor = (index) => COLORS[(index[0] + index[1] * 3 + index[2] * 5) % COLORS.length];

/**
 * Assembly map as an SVG string: one top view per Z layer (X to the right, Y upwards), each cell labelled
 * like the file names. pieces: [{index}] (cells without a piece are drawn empty).
 */
export function mapSVG(dims, n, pieces) {
  const W = 320;
  const cw = W / n[0];
  const ch = Math.max(34, Math.min(cw * 1.5, (cw * (dims[1] / n[1])) / (dims[0] / n[0])));
  const H = ch * n[1];
  const top = n[2] > 1 ? 24 : 0;
  const have = new Set(pieces.map((p) => p.index.join()));
  const font = Math.max(9, Math.min(15, cw / 4.6));
  let body = '';
  for (let k = 0; k < n[2]; k++) {
    const y0 = k * (H + top + 20) + top;
    if (top) body += `<text x="24" y="${y0 - 8}" fill="#e9e9ed" font-size="14" font-weight="600">Z${k + 1}</text>`;
    for (let j = 0; j < n[1]; j++) {
      for (let i = 0; i < n[0]; i++) {
        const x = 24 + i * cw;
        const y = y0 + (n[1] - 1 - j) * ch;
        const index = [i, j, k];
        const on = have.has(index.join());
        body += `<rect x="${x + 1}" y="${y + 1}" width="${cw - 2}" height="${ch - 2}" rx="4" fill="${on ? pieceColor(index, n) : 'none'}" stroke="#75798c"${on ? '' : ' stroke-dasharray="4 4"'}/>`;
        if (on) body += `<text x="${x + cw / 2}" y="${y + ch / 2}" fill="#161826" font-size="${font}" font-weight="700" text-anchor="middle" dominant-baseline="central">${pieceLabel(index, n)}</text>`;
      }
    }
    body += `<text x="${24 + W}" y="${y0 + H + 14}" fill="#9397ab" font-size="12" text-anchor="end">X →</text>`;
    body += `<text x="4" y="${y0 + 12}" fill="#9397ab" font-size="12">Y</text><text x="4" y="${y0 + 26}" fill="#9397ab" font-size="12">↑</text>`;
  }
  const height = n[2] * (H + top + 20);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W + 28} ${height}" width="${W + 28}" height="${height}" font-family="system-ui, sans-serif" role="img"><title>${n.join(' × ')}</title><rect width="100%" height="100%" fill="#161826"/>${body}</svg>`;
}
