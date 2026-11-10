// Mesh diagnosis and conservative repair for triangle soups (Float32Array, 9 floats per triangle, mm).
// Pure functions on typed arrays: runs in a Worker and in Node. No DOM, no dependencies besides mesh-io.
import { weld } from './mesh-io.js';

const DEG = 1; // two corners are the same vertex: carries no surface, safe to drop
const ZERO = 2; // three different vertices on one line: zero area, but dropping it would open a gap
const DUP = 4; // same three vertices as an earlier triangle
const SKIP = DEG | DUP; // not part of the surface topology
const HL_MAX = 200_000; // elements per highlight buffer sent to the 3D view
const HOLES_KEPT = 5000; // ponytail: holes beyond this are only counted, not listed; raise if real files need it
export const HOLES_LISTED = 500;
export const CAP_MAX_EDGES = 2000; // ponytail: ear clipping is O(n^2); larger loops are reported but not capped

const pow2 = (n) => {
  let c = 16;
  while (c < n) c *= 2;
  return c;
};
const nextHe = (he) => he - (he % 3) + ((he + 1) % 3);

// Per-triangle flags, plus counts of degenerate (DEG or ZERO) and duplicate triangles.
function classify(tri, I, nt) {
  const flags = new Uint8Array(nt);
  const cap = pow2(nt * 2);
  const table = new Int32Array(cap).fill(-1);
  let degenerate = 0;
  let duplicate = 0;
  for (let t = 0; t < nt; t++) {
    const a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2];
    if (a === b || b === c || a === c) {
      flags[t] = DEG;
      degenerate++;
      continue;
    }
    const lo = Math.min(a, b, c), hi = Math.max(a, b, c), mid = a + b + c - lo - hi;
    let h = Math.imul(lo, 73856093) ^ Math.imul(mid, 19349663) ^ Math.imul(hi, 83492791);
    h = (h ^ (h >>> 15)) & (cap - 1);
    for (;;) {
      const j = table[h];
      if (j < 0) {
        table[h] = t;
        break;
      }
      const ja = I[j * 3], jb = I[j * 3 + 1], jc = I[j * 3 + 2];
      const jlo = Math.min(ja, jb, jc), jhi = Math.max(ja, jb, jc);
      if (jlo === lo && jhi === hi && ja + jb + jc - jlo - jhi === mid) {
        flags[t] = DUP;
        duplicate++;
        break;
      }
      h = (h + 1) & (cap - 1);
    }
    if (flags[t]) continue;
    const p = t * 9;
    const ux = tri[p + 3] - tri[p], uy = tri[p + 4] - tri[p + 1], uz = tri[p + 5] - tri[p + 2];
    const vx = tri[p + 6] - tri[p], vy = tri[p + 7] - tri[p + 1], vz = tri[p + 8] - tri[p + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = ux * ux + uy * uy + uz * uz + vx * vx + vy * vy + vz * vz;
    if (nx * nx + ny * ny + nz * nz <= 1e-14 * len * len) {
      flags[t] = ZERO;
      degenerate++;
    }
  }
  return { flags, degenerate, duplicate };
}

// mate[he]: the half-edge on the other side of the edge; -1 = open edge, -2 = edge shared by 3+ faces,
// -3 = triangle is not part of the topology. Half-edge he = t*3+k runs from corner k to corner k+1.
function mates(I, flags, nt) {
  const mate = new Int32Array(nt * 3).fill(-3);
  const cap = pow2(nt * 4.5);
  const table = new Int32Array(cap).fill(-1);
  let nonManifold = 0;
  for (let t = 0; t < nt; t++) {
    if (flags[t] & SKIP) continue;
    for (let k = 0; k < 3; k++) {
      const he = t * 3 + k;
      const a = I[he], b = I[nextHe(he)];
      const lo = a < b ? a : b, hi = a < b ? b : a;
      let h = Math.imul(lo, 73856093) ^ Math.imul(hi, 19349663);
      h = (h ^ (h >>> 15)) & (cap - 1);
      for (;;) {
        const r = table[h];
        if (r < 0) {
          table[h] = he;
          mate[he] = -1;
          break;
        }
        const ra = I[r], rb = I[nextHe(r)];
        if ((ra === lo && rb === hi) || (ra === hi && rb === lo)) {
          if (mate[r] === -1) {
            mate[r] = he;
            mate[he] = r;
          } else {
            if (mate[r] >= 0) {
              mate[mate[r]] = -2;
              nonManifold++;
            }
            mate[r] = -2;
            mate[he] = -2;
          }
          break;
        }
        h = (h + 1) & (cap - 1);
      }
    }
  }
  return { mate, nonManifold };
}

// Distance along the ray to triangle p (offset into the soup), or -1.
function rayTri(tri, p, ox, oy, oz, dx, dy, dz) {
  const ax = tri[p], ay = tri[p + 1], az = tri[p + 2];
  const e1x = tri[p + 3] - ax, e1y = tri[p + 4] - ay, e1z = tri[p + 5] - az;
  const e2x = tri[p + 6] - ax, e2y = tri[p + 7] - ay, e2z = tri[p + 8] - az;
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (det === 0) return -1;
  const inv = 1 / det;
  const tx = ox - ax, ty = oy - ay, tz = oz - az;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (!(u >= 0 && u <= 1)) return -1;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (!(v >= 0 && u + v <= 1)) return -1;
  return (e2x * qx + e2y * qy + e2z * qz) * inv;
}

/**
 * Diagnose a triangle soup.
 * @param {Float32Array} tri 9 floats per triangle, finite values only (parseMesh guarantees that)
 * @returns report: counts, sizes, the listed holes and `hl` (Float32Array positions to highlight:
 *   open / nonManifold / degenerate are line segments, 6 floats each; flipped / duplicate are triangles, 9 floats).
 *   `flags` and `flip` are per-triangle arrays used by repair() and thinWalls().
 */
export function analyze(tri) {
  const nt = tri.length / 9;
  const w = weld(tri);
  const V = w.vertices.slice(); // let go of weld's oversized buffer
  const I = w.indices;
  const nv = V.length / 3;
  const { flags, degenerate, duplicate } = classify(tri, I, nt);
  const { mate, nonManifold } = mates(I, flags, nt);

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < V.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (V[i + k] < min[k]) min[k] = V[i + k];
      if (V[i + k] > max[k]) max[k] = V[i + k];
    }
  }

  // Orientation: flood each edge-connected piece, flipping neighbours that wind the other way, then turn
  // the whole piece outward. flip[t] = 1 means "this triangle must be reversed".
  const flip = new Uint8Array(nt);
  const comp = new Int32Array(nt).fill(-1);
  const list = new Int32Array(nt);
  const flat = []; // per piece: an open sheet lying in one plane, where a cap would only double it
  let tail = 0, ncomp = 0, volume = 0, area = 0, flipped = 0, cavityChecks = 0, active = 0, openEdges = 0;
  // Is the point inside the rest of the mesh (everything except piece `id`)? Ray parity.
  const inside = (ox, oy, oz, id) => {
    let n = 0;
    for (let t = 0; t < nt; t++) {
      if (flags[t] & SKIP || comp[t] === id) continue;
      if (rayTri(tri, t * 9, ox, oy, oz, 0.5773, 0.2113, 0.7887) > 0) n++;
    }
    return n % 2 === 1;
  };
  for (let s = 0; s < nt; s++) {
    if (flags[s] & SKIP || comp[s] >= 0) continue;
    const id = ncomp++;
    const start = tail;
    let head = tail;
    list[tail++] = s;
    comp[s] = id;
    let v0 = 0, sx = 0, sy = 0, sz = 0, gx = 0, gy = 0, gz = 0, ar = 0, nflip = 0, closed = true;
    while (head < tail) {
      const t = list[head++];
      const p = t * 9;
      const sg = flip[t] ? -1 : 1;
      const ax = tri[p], ay = tri[p + 1], az = tri[p + 2];
      const bx = tri[p + 3], by = tri[p + 4], bz = tri[p + 5];
      const cx = tri[p + 6], cy = tri[p + 7], cz = tri[p + 8];
      const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
      const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      v0 += (sg * (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx))) / 6;
      sx += (sg * nx) / 2;
      sy += (sg * ny) / 2;
      sz += (sg * nz) / 2;
      gx += ax + bx + cx;
      gy += ay + by + cy;
      gz += az + bz + cz;
      ar += Math.sqrt(nx * nx + ny * ny + nz * nz) / 2;
      nflip += flip[t];
      for (let k = 0; k < 3; k++) {
        const m = mate[t * 3 + k];
        if (m < 0) {
          closed = false;
          if (m === -1) openEdges++;
          continue;
        }
        const t2 = (m / 3) | 0;
        if (comp[t2] < 0) {
          comp[t2] = id;
          flip[t2] = flip[t] ^ (I[t * 3 + k] === I[m] ? 1 : 0); // same direction on both sides = opposite winding
          list[tail++] = t2;
        }
      }
    }
    const cnt = tail - start;
    active += cnt;
    // Signed volume measured from the piece's own centre, so it also means something for an open piece.
    let vc = v0 - (gx * sx + gy * sy + gz * sz) / (9 * cnt);
    let invert = vc < -1e-6 * ar ** 1.5;
    // A closed piece that faces inward is correct when it is a cavity inside another piece.
    // ponytail: only the first 64 such pieces are ray-tested (O(triangles) each); the rest are left as they are.
    if (invert && closed) invert = cavityChecks++ < 64 ? !inside(tri[s * 9], tri[s * 9 + 1], tri[s * 9 + 2], id) : false;
    if (invert) {
      for (let i = start; i < tail; i++) flip[list[i]] ^= 1;
      nflip = cnt - nflip;
      vc = -vc;
    }
    flat.push(!closed && Math.hypot(sx, sy, sz) >= ar * (1 - 1e-6));
    flipped += nflip;
    volume += vc;
    area += ar;
  }

  // Shells: groups of triangles connected through shared vertices.
  const parent = new Int32Array(nv);
  for (let i = 0; i < nv; i++) parent[i] = i;
  const find = (x) => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  for (let t = 0; t < nt; t++) {
    if (flags[t] & SKIP) continue;
    const a = find(I[t * 3]);
    parent[find(I[t * 3 + 1])] = a;
    parent[find(I[t * 3 + 2])] = a;
  }
  let shells = 0;
  const seen = new Uint8Array(nv);
  for (let t = 0; t < nt; t++) {
    if (flags[t] & SKIP) continue;
    const r = find(I[t * 3]);
    if (!seen[r]) {
      seen[r] = 1;
      shells++;
    }
  }

  // Holes: walk the open edges in their corrected direction until the loop closes.
  const from = (he) => (flip[(he / 3) | 0] ? I[nextHe(he)] : I[he]);
  const to = (he) => (flip[(he / 3) | 0] ? I[he] : I[nextHe(he)]);
  let holes = [];
  let holesTotal = 0;
  if (openEdges) {
    // The next open edge after e: turn around the vertex e ends at (v), through the faces that share it.
    // The result may be an edge that was already walked (-4). -1 = the fan ends at a non-manifold edge.
    const around = (e, v) => {
      for (let guard = 0; guard < 100000; guard++) {
        const k = I[nextHe(e)] === v ? nextHe(e) : nextHe(nextHe(e)); // the other edge of this face at v
        if (mate[k] === -1 || mate[k] === -4) return k;
        if (mate[k] < 0) return -1;
        e = mate[k];
      }
      return -1;
    };
    // Up to two open half-edges leaving each vertex (outB = -2: more than two).
    const outA = new Int32Array(nv).fill(-1);
    const outB = new Int32Array(nv).fill(-1);
    for (let he = 0; he < nt * 3; he++) {
      if (mate[he] !== -1) continue;
      const f = from(he);
      if (outA[f] < 0) outA[f] = he;
      else outB[f] = outB[f] === -1 ? he : -2;
    }
    for (let he = 0; he < nt * 3; he++) {
      if (mate[he] !== -1) continue;
      const keep = holesTotal < HOLES_KEPT;
      const ids = [];
      let closed = false;
      const island = flat[comp[(he / 3) | 0]]; // the outline of a flat sheet or loose triangle, not a hole
      for (let e = he; ; ) {
        mate[e] = -4; // visited
        if (keep) ids.push(from(e));
        const v = to(e);
        let n = around(e, v);
        // Two fans of faces meet at v (two holes touch there): the hole continues along the other fan.
        if (outB[v] >= 0 && (n === outA[v] || n === outB[v])) n = n === outA[v] ? outB[v] : outA[v];
        if (n === he) {
          closed = true;
          break;
        }
        if (n < 0 || mate[n] !== -1) {
          if (keep) ids.push(to(e));
          break;
        }
        e = n;
      }
      // Holes that touch at a vertex come out as one loop through that vertex twice: split it there.
      const loops = [];
      if (closed && keep) {
        const at = new Map();
        const path = [];
        for (const v of ids) {
          if (at.has(v)) {
            const sub = path.splice(at.get(v));
            for (const u of sub) at.delete(u);
            loops.push(sub);
          }
          at.set(v, path.length);
          path.push(v);
        }
        loops.push(path);
      } else loops.push(ids);
      holesTotal += loops.length;
      if (!keep) continue;
      for (const loop of loops) {
        const pts = new Float32Array(loop.length * 3);
        const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        loop.forEach((v, i) => {
          for (let k = 0; k < 3; k++) {
            const x = (pts[i * 3 + k] = V[v * 3 + k]);
            if (x < lo[k]) lo[k] = x;
            if (x > hi[k]) hi[k] = x;
          }
        });
        const edges = closed ? loop.length : loop.length - 1;
        holes.push({
          edges,
          size: Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]),
          center: lo.map((x, k) => (x + hi[k]) / 2),
          closed,
          cappable: closed && !island && edges >= 3 && edges <= CAP_MAX_EDGES,
          pts,
        });
      }
    }
    // Too many to list: the largest (they decide the verdict) and the smallest (the ones worth closing).
    holes.sort((a, b) => b.size - a.size);
    if (holes.length > HOLES_LISTED) holes = [...holes.slice(0, HOLES_LISTED / 2), ...holes.slice(-HOLES_LISTED / 2)];
  }

  // Highlight geometry.
  const pick = (count, per, each) => {
    const buf = new Float32Array(Math.min(count, HL_MAX) * per);
    let wr = 0;
    each((...ids) => {
      if (wr + ids.length * 3 > buf.length) return;
      for (const v of ids) {
        buf[wr++] = V[v * 3];
        buf[wr++] = V[v * 3 + 1];
        buf[wr++] = V[v * 3 + 2];
      }
    });
    return wr === buf.length ? buf : buf.slice(0, wr);
  };
  const hes = (code) => (emit) => {
    for (let he = 0; he < nt * 3; he++) if (mate[he] === code) emit(I[he], I[nextHe(he)]);
  };
  const tris = (test) => (emit) => {
    for (let t = 0; t < nt; t++) if (test(t)) emit(I[t * 3], I[t * 3 + 1], I[t * 3 + 2]);
  };
  const hl = {
    open: pick(openEdges, 6, hes(-4)),
    nonManifold: pick(nonManifold * 3, 6, hes(-2)),
    flipped: pick(flipped, 9, tris((t) => flip[t])),
    duplicate: pick(duplicate, 9, tris((t) => flags[t] & DUP)),
    degenerate: pick(degenerate * 3, 6, (emit) => {
      for (let t = 0; t < nt; t++) {
        if (flags[t] & (DEG | ZERO)) for (let k = 0; k < 3; k++) emit(I[t * 3 + k], I[nextHe(t * 3 + k)]);
      }
    }),
  };

  return {
    triangles: nt,
    vertices: nv,
    min,
    max,
    size: max.map((x, k) => (nv ? x - min[k] : 0)),
    area,
    volume: Math.abs(volume),
    watertight: active > 0 && openEdges === 0 && nonManifold === 0,
    shells,
    openEdges,
    holes,
    holesTotal,
    nonManifold,
    flipped,
    degenerate,
    duplicate,
    hl,
    flags,
    flip,
  };
}

/**
 * 'ok' = printable as-is, 'auto' = a slicer will probably cope, 'attention' = look at it before printing.
 * @param r report from analyze() @param {{bad?: number, truncated?: boolean}} file what the reader dropped
 */
export function verdict(r, { bad = 0, truncated = false } = {}) {
  if (!r.triangles) return 'attention'; // nothing to print
  const diag = Math.hypot(...r.size);
  const bigHole = r.holes.some((h) => h.size > Math.max(1, diag * 0.02));
  if (truncated || r.nonManifold || bigHole || r.holesTotal > 20) return 'attention';
  return r.openEdges || r.flipped || r.degenerate || r.duplicate || bad ? 'auto' : 'ok';
}

/** Does a part of `size` [x,y,z] fit a build volume `bed` [x,y,z]? Axis-aligned orientations only. */
export function bedFit(size, bed) {
  const over = (s) => s.map((x, k) => Math.max(0, x - bed[k] - 1e-6));
  const ok = (s) => over(s).every((x) => x === 0);
  if (ok(size)) return { fit: 'as_is' };
  const [x, y, z] = size;
  if ([[y, x, z], [x, z, y], [z, y, x], [y, z, x], [z, x, y]].some(ok)) return { fit: 'rotated' };
  return { fit: 'too_big', over: over(size) };
}

/** Sizes that suggest the file was saved in another unit: 'm' (try x1000), 'inch' (x25.4), 'big' (x0.001). */
export function unitHint(size) {
  const m = Math.max(...size);
  return m < 1 ? 'm' : m < 10 ? 'inch' : m > 2000 ? 'big' : null;
}

// Triangulate a closed 3D loop (3 floats per point, in the winding the new faces should have) by ear
// clipping in its best-fit plane. Uses only the loop's own points, so the bounding box cannot grow.
function fillLoop(P) {
  const n = P.length / 3;
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < n; i++) {
    const a = i * 3, b = ((i + 1) % n) * 3;
    nx += (P[a + 1] - P[b + 1]) * (P[a + 2] + P[b + 2]);
    ny += (P[a + 2] - P[b + 2]) * (P[a] + P[b]);
    nz += (P[a] - P[b]) * (P[a + 1] + P[b + 1]);
  }
  const nl = Math.hypot(nx, ny, nz) || 1;
  nx /= nl, ny /= nl, nz /= nl;
  // u, v span the plane and u x v = n, so the loop is counter-clockwise in (u, v)
  let ux = -ny, uy = nx, uz = 0;
  if (Math.abs(nz) > 0.9) ux = 0, uy = -nz, uz = ny;
  const ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul, uy /= ul, uz /= ul;
  const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
  const X = new Float64Array(n), Y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    X[i] = P[i * 3] * ux + P[i * 3 + 1] * uy + P[i * 3 + 2] * uz;
    Y[i] = P[i * 3] * vx + P[i * 3 + 1] * vy + P[i * 3 + 2] * vz;
  }
  const cross = (a, b, c) => (X[b] - X[a]) * (Y[c] - Y[a]) - (Y[b] - Y[a]) * (X[c] - X[a]);
  const idx = Array.from({ length: n }, (_, i) => i);
  const out = new Float32Array((n - 2) * 9);
  let w = 0;
  while (idx.length >= 3) {
    const m = idx.length;
    let ear = -1, best = -Infinity, bestI = 0;
    for (let i = 0; i < m && ear < 0 && m > 3; i++) {
      const a = idx[(i + m - 1) % m], b = idx[i], c = idx[(i + 1) % m];
      const cr = cross(a, b, c);
      if (cr > best) best = cr, bestI = i;
      if (cr <= 0) continue;
      ear = i;
      for (const j of idx) {
        if (j !== a && j !== b && j !== c && cross(a, b, j) >= 0 && cross(b, c, j) >= 0 && cross(c, a, j) >= 0) {
          ear = -1;
          break;
        }
      }
    }
    if (ear < 0) ear = bestI; // no clean ear (loop is not flat or crosses itself): take the most convex corner
    for (const j of [idx[(ear + m - 1) % m], idx[ear], idx[(ear + 1) % m]]) {
      out[w++] = P[j * 3];
      out[w++] = P[j * 3 + 1];
      out[w++] = P[j * 3 + 2];
    }
    idx.splice(ear, 1);
    if (m === 3) break;
  }
  return out;
}

// Merge every vertex into the first earlier vertex within `tol` of it (a grid of cell size tol finds the
// candidates). Vertices only ever snap to a vertex that stays where it is, so nothing moves further than
// tol, however long a chain of close vertices is.
function weldTol(tri, tol) {
  const { vertices: V, indices: I } = weld(tri);
  const nv = V.length / 3;
  const target = new Int32Array(nv); // the vertex each one snaps to (itself when it stays)
  const cap = pow2(nv * 2);
  const head = new Int32Array(cap).fill(-1); // cell hash -> last kept vertex in it
  const next = new Int32Array(nv); // older kept vertices with the same hash
  const hash = (x, y, z) => {
    const h = Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791);
    return (h ^ (h >>> 15)) & (cap - 1);
  };
  const t2 = tol * tol;
  let merged = 0;
  for (let v = 0; v < nv; v++) {
    const px = V[v * 3], py = V[v * 3 + 1], pz = V[v * 3 + 2];
    const cx = Math.floor(px / tol), cy = Math.floor(py / tol), cz = Math.floor(pz / tol);
    let best = -1, bestD = t2;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (let j = head[hash(cx + dx, cy + dy, cz + dz)]; j >= 0; j = next[j]) {
        const d = (V[j * 3] - px) ** 2 + (V[j * 3 + 1] - py) ** 2 + (V[j * 3 + 2] - pz) ** 2;
        if (d <= bestD) best = j, bestD = d;
      }
    }
    target[v] = best < 0 ? v : best;
    if (best >= 0) merged++;
    else {
      const h = hash(cx, cy, cz);
      next[v] = head[h];
      head[h] = v;
    }
  }
  const out = new Float32Array(tri.length);
  for (let i = 0; i < I.length; i++) {
    const r = target[I[i]] * 3;
    out[i * 3] = V[r];
    out[i * 3 + 1] = V[r + 1];
    out[i * 3 + 2] = V[r + 2];
  }
  return { tri: out, merged };
}

/**
 * Apply the chosen repairs. Nothing happens unless asked for; the input is never modified.
 * @param {Float32Array} tri @param a analyze(tri)
 * @param {{holes?: number[], tol?: number, clean?: boolean, normals?: boolean}} opts
 *   holes: indices into a.holes to close; tol: merge vertices closer than this (mm, 0 = off);
 *   clean: drop collapsed and duplicate triangles; normals: make every piece consistent and outward.
 * @returns {{tri: Float32Array, capped: number, merged: number, removed: number, flipped: number}}
 */
export function repair(tri, a, { holes = [], tol = 0, clean = false, normals = false } = {}) {
  const caps = holes.map((h) => a.holes[h]).filter((h) => h?.cappable).map((h) => {
    const n = h.pts.length / 3;
    const rev = new Float32Array(h.pts.length); // new faces run against the open edges
    for (let i = 0; i < n; i++) rev.set(h.pts.subarray(i * 3, i * 3 + 3), (n - 1 - i) * 3);
    return fillLoop(rev);
  });
  let out = tri;
  if (caps.length) {
    out = new Float32Array(tri.length + caps.reduce((s, c) => s + c.length, 0));
    out.set(tri);
    let w = tri.length;
    for (const c of caps) {
      out.set(c, w);
      w += c.length;
    }
  }
  let merged = 0, removed = 0, flipped = 0;
  if (tol > 0) ({ tri: out, merged } = weldTol(out, tol));
  if (clean || normals) {
    const b = out === tri ? a : analyze(out);
    const res = new Float32Array(out.length);
    let w = 0;
    for (let t = 0; t < out.length / 9; t++) {
      if (clean && b.flags[t] & SKIP) {
        removed++;
        continue;
      }
      res.set(out.subarray(t * 9, t * 9 + 9), w);
      if (normals && b.flip[t]) {
        res.copyWithin(w + 3, w + 6, w + 9);
        res.set(out.subarray(t * 9 + 3, t * 9 + 6), w + 6);
        flipped++;
      }
      w += 9;
    }
    out = w === res.length ? res : res.slice(0, w);
  }
  return { tri: out, capped: caps.length, merged, removed, flipped };
}

// ---- wall thickness estimate ----------------------------------------------------------------------

/** Bounding-volume hierarchy over a soup (midpoint splits, up to 4 triangles per leaf). */
export function buildBVH(tri) {
  const n = tri.length / 9;
  const order = new Uint32Array(n);
  const cen = new Float32Array(n * 3);
  for (let t = 0; t < n; t++) {
    order[t] = t;
    for (let k = 0; k < 3; k++) cen[t * 3 + k] = (tri[t * 9 + k] + tri[t * 9 + 3 + k] + tri[t * 9 + 6 + k]) / 3;
  }
  const box = new Float32Array(Math.max(1, 2 * n) * 6);
  const kids = new Int32Array(Math.max(1, 2 * n) * 2); // [left, right], or [-1 - start, count] for a leaf
  let nodes = 1;
  const stack = [0, 0, n];
  while (stack.length) {
    const end = stack.pop(), start = stack.pop(), node = stack.pop();
    const b = node * 6;
    const c0 = [Infinity, Infinity, Infinity], c1 = [-Infinity, -Infinity, -Infinity];
    box.fill(Infinity, b, b + 3);
    box.fill(-Infinity, b + 3, b + 6);
    for (let i = start; i < end; i++) {
      const t = order[i];
      for (let k = 0; k < 3; k++) {
        for (let c = 0; c < 9; c += 3) {
          const x = tri[t * 9 + c + k];
          if (x < box[b + k]) box[b + k] = x;
          if (x > box[b + 3 + k]) box[b + 3 + k] = x;
        }
        const x = cen[t * 3 + k];
        if (x < c0[k]) c0[k] = x;
        if (x > c1[k]) c1[k] = x;
      }
    }
    if (end - start <= 4) {
      kids[node * 2] = -1 - start;
      kids[node * 2 + 1] = end - start;
      continue;
    }
    const ext = c1.map((x, k) => x - c0[k]);
    const axis = ext.indexOf(Math.max(...ext));
    const mid = (c0[axis] + c1[axis]) / 2;
    let i = start;
    for (let j = start; j < end; j++) {
      const t = order[j];
      if (cen[t * 3 + axis] < mid) {
        order[j] = order[i];
        order[i++] = t;
      }
    }
    if (i === start || i === end) i = (start + end) >> 1; // all centres in one spot
    kids[node * 2] = nodes;
    kids[node * 2 + 1] = nodes + 1;
    stack.push(nodes, start, i, nodes + 1, i, end);
    nodes += 2;
  }
  return { tri, order, box, kids };
}

/** Distance to the nearest triangle hit further than tmin along the ray, or Infinity. */
export function raycast({ tri, order, box, kids }, ox, oy, oz, dx, dy, dz, tmin = 0) {
  const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
  let best = Infinity;
  const stack = [0];
  while (stack.length) {
    const node = stack.pop();
    const b = node * 6;
    let t0 = (box[b] - ox) * ix, t1 = (box[b + 3] - ox) * ix;
    let lo = Math.min(t0, t1), hi = Math.max(t0, t1);
    t0 = (box[b + 1] - oy) * iy, t1 = (box[b + 4] - oy) * iy;
    lo = Math.max(lo, Math.min(t0, t1)), hi = Math.min(hi, Math.max(t0, t1));
    t0 = (box[b + 2] - oz) * iz, t1 = (box[b + 5] - oz) * iz;
    lo = Math.max(lo, Math.min(t0, t1)), hi = Math.min(hi, Math.max(t0, t1));
    if (!(hi >= Math.max(lo, 0)) || lo > best) continue;
    const l = kids[node * 2];
    if (l >= 0) {
      stack.push(l, kids[node * 2 + 1]);
      continue;
    }
    for (let i = -1 - l, e = i + kids[node * 2 + 1]; i < e; i++) {
      const t = rayTri(tri, order[i] * 9, ox, oy, oz, dx, dy, dz);
      if (t > tmin && t < best) best = t;
    }
  }
  return best;
}

/**
 * Estimate the share of the surface where the wall behind it is thinner than `limit` mm: random points
 * spread evenly over the surface, one ray each straight into the part, distance to the opposite wall.
 * @param {Float32Array} tri @param {Uint8Array} flip from analyze() (which triangles face the wrong way)
 * @returns {{share: number, samples: number, thin: Uint32Array}} thin = triangles with a thin sample
 */
export function thinWalls(tri, flip, limit, samples = 20000) {
  const n = tri.length / 9;
  const cum = new Float64Array(n);
  const N = new Float32Array(n * 3);
  let total = 0;
  for (let t = 0; t < n; t++) {
    const p = t * 9;
    const ux = tri[p + 3] - tri[p], uy = tri[p + 4] - tri[p + 1], uz = tri[p + 5] - tri[p + 2];
    const vx = tri[p + 6] - tri[p], vy = tri[p + 7] - tri[p + 1], vz = tri[p + 8] - tri[p + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    const s = l ? (flip[t] ? -1 : 1) / l : 0;
    N[t * 3] = nx * s;
    N[t * 3 + 1] = ny * s;
    N[t * 3 + 2] = nz * s;
    cum[t] = total += l / 2;
  }
  const mark = new Uint8Array(n);
  if (!(total > 0)) return { share: 0, samples: 0, thin: new Uint32Array(0) };
  const bvh = buildBVH(tri);
  let seed = 1; // fixed seed: the same file always gives the same estimate
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  let thin = 0;
  for (let s = 0; s < samples; s++) {
    const r = rnd() * total;
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (cum[m] < r) lo = m + 1;
      else hi = m;
    }
    const p = lo * 9;
    let u = rnd(), v = rnd();
    if (u + v > 1) u = 1 - u, v = 1 - v;
    const k = 1 - u - v;
    const x = tri[p] * k + tri[p + 3] * u + tri[p + 6] * v;
    const y = tri[p + 1] * k + tri[p + 4] * u + tri[p + 7] * v;
    const z = tri[p + 2] * k + tri[p + 5] * u + tri[p + 8] * v;
    // Nothing behind the point at all (an open sheet, or two faces back to back) is thinner than any limit.
    const d = raycast(bvh, x, y, z, -N[lo * 3], -N[lo * 3 + 1], -N[lo * 3 + 2], 1e-4);
    if (d < limit || d === Infinity) {
      thin++;
      mark[lo] = 1;
    }
  }
  const ids = [];
  for (let t = 0; t < n; t++) if (mark[t]) ids.push(t);
  return { share: thin / samples, samples, thin: Uint32Array.from(ids) };
}
