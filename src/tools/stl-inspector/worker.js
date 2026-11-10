// Holds the mesh of the file being inspected and does all heavy work off the main thread.
// Commands run one after another: load, scale, repair, revert, thin, export.
import { parseMesh, writeSTL, writeOBJ, write3MF } from '../../lib/mesh-io.js';
import { analyze, repair, verdict, thinWalls } from '../../lib/mesh-analyze.js';

// Above this many triangles the 3D view is skipped: the copy for the page plus the GPU buffer cost
// about 72 bytes per triangle on top of the analysis itself. Measured: 3 million triangles display fine,
// 10 million are analysed in about 10 s without the view.
const VIEW_LIMIT = 5_000_000;
// The ray-casting tree costs about 100 bytes per triangle; 3 million triangles took about 4 s in the browser.
const THIN_LIMIT = 4_000_000;
const HL_MAX = 200_000;

let S = null; // { fid, orig, cur, objects, a, file, box }
let chain = Promise.resolve();

function report(a, file) {
  const { flags, flip, ...r } = a;
  return { ...r, ...file, verdict: verdict(a, file), viewLimit: VIEW_LIMIT, thinLimit: THIN_LIMIT };
}

function send(type, extra = {}) {
  const view = S.cur.length / 9 <= VIEW_LIMIT ? S.cur.slice() : null;
  postMessage({ type, fid: S.fid, kept: true, report: report(S.a, S.file), view, ...extra }, view ? [view.buffer] : []);
}

async function run(m) {
  if (m.cmd === 'load') {
    if (m.keep) S = null; // free the previous mesh before reading the next one
    const mesh = await parseMesh(m.file, {
      name: m.file.name,
      allowTruncated: true, // a cut-off file is reported as a problem, not refused
      onProgress: (p) => postMessage({ type: 'progress', fid: m.fid, stage: 'read', p }),
    });
    postMessage({ type: 'progress', fid: m.fid, stage: 'analyze' });
    const a = analyze(mesh.triangles);
    const file = { format: mesh.format, bad: mesh.bad, truncated: mesh.truncated };
    if (!m.keep) return postMessage({ type: 'report', cmd: 'load', fid: m.fid, report: { ...report(a, file), hl: null, holes: [] } });
    S = { fid: m.fid, orig: mesh.triangles, cur: mesh.triangles, objects: mesh.objects, a, file, box: { min: a.min, max: a.max } };
    return send('report', { cmd: 'load' });
  }
  if (!S) return;
  if (m.cmd === 'scale') {
    const scaled = (src) => src.map((x) => x * m.factor);
    const same = S.cur === S.orig;
    S.orig = scaled(S.orig);
    S.cur = same ? S.orig : scaled(S.cur); // repairs already made are kept
    S.a = analyze(S.cur);
    const ends = [S.box.min, S.box.max].map((v) => v.map((x) => x * m.factor)); // still the box of the file as loaded
    S.box = { min: ends[0].map((x, k) => Math.min(x, ends[1][k])), max: ends[0].map((x, k) => Math.max(x, ends[1][k])) };
    send('report');
  } else if (m.cmd === 'revert') {
    S.cur = S.orig;
    S.a = analyze(S.cur);
    send('report');
  } else if (m.cmd === 'repair') {
    const { hl, holes, ...before } = report(S.a, S.file);
    const done = repair(S.cur, S.a, m.opts);
    if (!done.tri.length) throw Object.assign(new Error('the repair would remove every triangle'), { code: 'rep_empty' });
    S.cur = done.tri;
    S.a = analyze(S.cur);
    // proof: how far did any side of the bounding box move from the file as loaded?
    const delta = Math.max(...[0, 1, 2].flatMap((k) => [Math.abs(S.a.min[k] - S.box.min[k]), Math.abs(S.a.max[k] - S.box.max[k])]));
    send('repaired', { before, done: { capped: done.capped, merged: done.merged, removed: done.removed, flipped: done.flipped }, delta });
  } else if (m.cmd === 'thin') {
    if (S.cur.length / 9 > THIN_LIMIT) return postMessage({ type: 'thin', fid: S.fid, skipped: true });
    const r = thinWalls(S.cur, S.a.flip, m.limit);
    const tris = new Float32Array(Math.min(r.thin.length, HL_MAX) * 9);
    for (let i = 0; i < tris.length / 9; i++) tris.set(S.cur.subarray(r.thin[i] * 9, r.thin[i] * 9 + 9), i * 9);
    postMessage({ type: 'thin', fid: S.fid, share: r.share, samples: r.samples, tris }, [tris.buffer]);
  } else if (m.cmd === 'export') {
    const blob =
      m.format === 'stl' ? writeSTL(S.cur) : m.format === 'obj' ? writeOBJ(S.cur) : write3MF(S.cur, S.cur === S.orig ? S.objects : undefined);
    postMessage({ type: 'file', fid: S.fid, blob, format: m.format });
  }
}

onmessage = ({ data }) => {
  chain = chain.then(() => run(data)).catch((e) => {
    // Errors lose their custom fields when posted, so send the parts ui.errorText needs.
    const code = e instanceof RangeError ? 'too_large' : e.code; // RangeError = an array too big for this device
    postMessage({ type: 'error', cmd: data.cmd, fid: data.fid ?? S?.fid, error: { code, data: e.data, message: e.message } });
  });
};
