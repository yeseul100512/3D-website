// STL/3MF/OBJ inspector page: files go to a Worker (parse, diagnose, repair, export); this script only
// shows what comes back. All user-facing text comes from window.T.
import { dropzone, notice, errorText, fmt, num, download, readNumber } from '../../lib/ui.js';
import { bedFit, unitHint } from '../../lib/mesh-analyze.js';
import { writeXLSX, toCSV } from '../../lib/xlsx.js';

const T = window.T;
const $ = (id) => document.getElementById(id);
const all = (sel) => [...document.querySelectorAll(sel)];
const PANELS = ['p-summary', 'p-bed', 'p-problems', 'p-thin', 'p-repair', 'p-export'];
const KINDS = ['open', 'nonManifold', 'flipped', 'degenerate', 'duplicate', 'bad', 'truncated'];

let worker = null;
let files = []; // { file, report, error }
let active = -1; // index of the file whose mesh the worker holds
let pending = 0; // load jobs not answered yet
let cur = null; // report of the active file as it is now (after scaling / repairs)
let viewer = null; // false = unavailable (no WebGL, or the 3D library could not be downloaded)
let viewerP = null;
let viewSeq = 0;
let hasView = false;
let thinTris = null;
let hlOn = null;
let modified = false;
let scale = 1;

const mm = (v) => `${num(v)} mm`;
const dims = (s) => `${s.map((v) => num(v)).join(' × ')} mm`;
const post = (m) => worker.postMessage(m);
const busy = (on) => all('.act').forEach((b) => (b.disabled = on));

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    // private mode: the choice just is not remembered
  }
  return null;
}

// ---- files ----------------------------------------------------------------------------------------

function start(list) {
  worker?.terminate(); // new files cancel whatever was running
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    // An answer to scale / repair / thin / export for a file the user has left meanwhile: drop it.
    if (data.cmd !== 'load' && data.type !== 'progress' && data.fid !== active) return;
    handlers[data.type](data);
  };
  worker.onerror = (e) => {
    pending = 0;
    busy(false);
    notice($('msg'), 'error', errorText(e, files[active]?.file.name ?? ''));
  };
  files = list.map((file) => ({ file, report: null, error: '' }));
  active = -1;
  pending = files.length;
  hideDetail();
  notice($('errs'), 'error', '');
  $('p-files').hidden = true;
  notice($('msg'), 'info', fmt(T.js_reading, { name: files[0].file.name, percent: 0 }));
  files.forEach((f, fid) => post({ cmd: 'load', fid, file: f.file, keep: fid === 0 }));
}

function select(fid) {
  if (fid === active || pending) return;
  // Scaling and repairs are not kept when another file is opened: the table goes back to the file as loaded.
  if (active >= 0) files[active].report = files[active].loaded;
  hideDetail();
  active = -1;
  pending = 1;
  notice($('msg'), 'info', fmt(T.js_reading, { name: files[fid].file.name, percent: 0 }));
  post({ cmd: 'load', fid, file: files[fid].file, keep: true });
}

function loaded() {
  renderFiles();
  notice($('errs'), 'error', files.map((f) => f.error).filter(Boolean).join('\n'));
  if (--pending > 0) return;
  notice($('msg'), 'info', '');
  if (active < 0) {
    const first = files.findIndex((f) => f.report);
    if (first >= 0) select(first); // the first file failed: show the first one that loaded
  }
}

function hideDetail() {
  for (const id of PANELS) $(id).hidden = true;
  cur = null;
  for (const id of ['rep-weld', 'rep-clean', 'rep-normals']) $(id).checked = false; // repairs are chosen per file, never carried over
  modified = false;
  scale = 1;
  showMesh(null);
  $('viewer-msg').textContent = T.js_viewer_empty;
}

const handlers = {
  progress({ fid, stage, p }) {
    const name = files[fid].file.name;
    notice($('msg'), 'info', stage === 'read' ? fmt(T.js_reading, { name, percent: Math.round(p * 100) }) : fmt(T.js_analyzing, { name }));
  },
  error({ cmd, fid, error }) {
    const text = errorText(error, files[fid]?.file.name ?? '');
    busy(false);
    if (cmd === 'load') {
      files[fid].error = text;
      loaded();
    } else {
      notice($({ repair: 'rep-msg', revert: 'rep-msg', thin: 'thin-result', export: 'exp-msg' }[cmd] || 'msg'), 'error', text);
    }
  },
  report({ fid, cmd, kept, report, view }) {
    files[fid].report = report;
    if (cmd === 'load') files[fid].loaded = report;
    if (kept) {
      active = fid;
      showDetail(report, view);
    }
    if (cmd === 'load') loaded();
    else renderFiles(); // answer to scale / revert
    busy(false);
  },
  repaired({ fid, report, view, before, done, delta }) {
    files[fid].report = report;
    modified = true;
    showDetail(report, view);
    renderFiles();
    busy(false);
    notice($('rep-msg'), 'info', fmt(T.js_rep_done, Object.fromEntries(Object.entries(done).map(([k, v]) => [k, num(v, 0)]))));
    const same = delta <= 0.001;
    notice($('rep-proof'), same ? 'info' : 'warn', fmt(same ? T.js_bbox_same : T.js_bbox_changed, { size: dims(report.size), delta: num(delta, 4) }));
    if (same) $('rep-proof').classList.add('good');
    const rows = [
      [T.js_row_triangles, 'triangles'], [T.js_prob_open, 'openEdges'], [T.js_row_holes, 'holesTotal'], [T.js_prob_nonmanifold, 'nonManifold'],
      [T.js_prob_flipped, 'flipped'], [T.js_prob_degenerate, 'degenerate'], [T.js_prob_duplicate, 'duplicate'], [T.js_row_shells, 'shells'],
    ];
    $('rep-table').tBodies[0].replaceChildren(
      ...rows.map(([label, k]) => tr([label, num(before[k], 0), num(report[k], 0)], 1)),
      tr([T.js_row_volume, volumeText(before), volumeText(report)], 1),
    );
    $('rep-table').hidden = false;
  },
  thin({ skipped, share, samples, tris }) {
    busy(false);
    if (skipped) return notice($('thin-result'), 'warn', fmt(T.js_thin_skipped, { n: num(cur.thinLimit, 0) }));
    thinTris = tris;
    notice($('thin-result'), share > 0.05 ? 'warn' : 'info', fmt(T.js_thin_result, { percent: num(share * 100, 1), limit: num(lastLimit), samples: num(samples, 0) }));
    $('thin-show').hidden = !tris.length || !hasView;
  },
  file({ fid, blob, format }) {
    busy(false);
    const base = files[fid].file.name.replace(/\.[^.]*$/, '');
    const name = `${base}${modified ? '-repaired' : ''}${scale !== 1 ? '-scaled' : ''}.${format}`;
    download(blob, name);
    notice($('exp-msg'), 'info', fmt(T.js_exp_done, { name }));
  },
};

// ---- detail of the active file ----------------------------------------------------------------------

function tr(cells, numFrom = Infinity) {
  const row = document.createElement('tr');
  cells.forEach((c, i) => {
    const cell = document.createElement(i ? 'td' : 'th');
    if (!i) cell.scope = 'row';
    if (i >= numFrom) cell.className = 'num';
    cell.append(c);
    row.append(cell);
  });
  return row;
}

const volumeText = (r) => `${num(r.volume / 1000)} cm³${r.watertight ? '' : ` (${T.js_volume_unreliable})`}`;

function problemCount(r, k) {
  if (k === 'open') return r.openEdges ? fmt(T.js_n_open, { edges: num(r.openEdges, 0), holes: num(r.holesTotal, 0) }) : '';
  if (k === 'truncated') {
    if (!r.truncated) return '';
    const v = { present: num(r.truncated.present, 0), declared: num(r.truncated.declared, 0) };
    return fmt(r.truncated.declared == null ? T.js_n_truncated_unknown : T.js_n_truncated, v);
  }
  return r[k] ? num(r[k], 0) : '';
}

function issuesText(r) {
  const names = { open: T.js_prob_open, nonManifold: T.js_prob_nonmanifold, flipped: T.js_prob_flipped, degenerate: T.js_prob_degenerate, duplicate: T.js_prob_duplicate, bad: T.js_prob_bad, truncated: T.js_prob_truncated };
  const list = KINDS.filter((k) => problemCount(r, k)).map((k) => `${names[k]} ${k === 'open' ? num(r.openEdges, 0) : k === 'truncated' ? '' : num(r[k], 0)}`.trim());
  return list.join(', ') || T.js_none;
}

function showDetail(r, view) {
  const f = files[active];
  cur = r;
  thinTris = null;
  $('s-name').textContent = f.file.name;
  $('s-verdict').className = `notice ${{ ok: 'good', auto: '', attention: 'warn' }[r.verdict]}`;
  $('s-verdict').textContent = T[`js_verdict_${r.verdict}`];
  $('s-size').textContent = dims(r.size);
  $('s-tris').textContent = num(r.triangles, 0);
  $('s-volume').textContent = `${num(r.volume, 1)} mm³ · ${volumeText(r)}`;
  $('s-area').textContent = `${num(r.area / 100)} cm²`;
  $('s-shells').textContent = num(r.shells, 0);
  $('s-format').textContent = T[`js_fmt_${r.format.replace('-', '_')}`];

  const hint = unitHint(r.size);
  notice($('s-unit'), 'warn', hint ? fmt(T[`js_hint_${hint}`], { size: mm(Math.max(...r.size)) }) : '');
  if (hint) $('s-scale').open = true;
  $('s-scaled').hidden = scale === 1;
  $('s-scaled').textContent = fmt(T.js_scaled, { factor: num(scale, 6) });

  for (const k of KINDS) {
    const li = $(`pr-${k}`);
    const n = problemCount(r, k);
    li.classList.toggle('none', !n);
    li.querySelector('strong').textContent = n || T.js_none;
  }

  // holes: nothing is selected until the user chooses
  $('holes-info').textContent = !r.holesTotal
    ? T.js_holes_none
    : r.holesTotal > r.holes.length
      ? fmt(T.js_holes_more, { shown: num(r.holes.length, 0), total: num(r.holesTotal, 0) })
      : T.js_holes_pick;
  $('holes-tools').hidden = !r.holes.length;
  $('hole-list').replaceChildren(
    ...r.holes.map((h, i) => {
      const li = document.createElement('li');
      const label = document.createElement('label');
      label.className = 'check';
      const box = Object.assign(document.createElement('input'), { type: 'checkbox', value: i, disabled: !h.cappable });
      label.append(box, ` ${fmt(T.js_hole, { i: i + 1, edges: num(h.edges, 0), size: mm(h.size) })}${h.cappable ? '' : ` – ${T.js_hole_uncappable}`}`);
      const show = Object.assign(document.createElement('button'), { type: 'button', className: 'button secondary', textContent: T.js_show });
      show.dataset.hole = i;
      show.setAttribute('aria-label', `${T.js_show}: ${fmt(T.js_hole, { i: i + 1, edges: num(h.edges, 0), size: mm(h.size) })}`);
      li.append(label, show);
      return li;
    }),
  );

  for (const id of ['rep-msg', 'rep-proof', 'thin-result', 'exp-msg']) notice($(id), 'info', '');
  $('rep-table').hidden = true;
  $('thin-show').hidden = true;
  $('rep-undo').hidden = !modified;
  $('exp-what').textContent = modified ? T.js_exp_repaired : T.js_exp_original;
  for (const id of PANELS) $(id).hidden = false;

  hasView = !!view;
  notice($('view-note'), 'warn', '');
  if (view) showMesh(view);
  else {
    showMesh(null);
    $('viewer-msg').textContent = fmt(T.js_view_skipped, { n: num(r.viewLimit, 0) });
    notice($('view-note'), 'warn', $('viewer-msg').textContent);
  }
  all('[data-hl], [data-hole]').forEach((b) => (b.disabled = !view));
  updateBed();
}

// ---- 3D view ----------------------------------------------------------------------------------------

async function showMesh(positions) {
  const seq = ++viewSeq;
  setPressed(null);
  $('canvas').hidden = $('view-reset').hidden = !positions;
  $('viewer-msg').hidden = !!positions;
  if (!positions) return viewer && viewer.setMesh(null);
  viewerP ??= import('./viewer.js').then((m) => m.create($('canvas'))).catch(() => false);
  viewer = await viewerP;
  if (seq !== viewSeq) return; // another file took over while the 3D library was loading
  if (!viewer) {
    hasView = false;
    $('canvas').hidden = $('view-reset').hidden = true;
    $('viewer-msg').hidden = false;
    $('viewer-msg').textContent = T.js_view_failed;
    notice($('view-note'), 'warn', T.js_view_failed);
    all('[data-hl], [data-hole]').forEach((b) => (b.disabled = true));
    return;
  }
  viewer.setMesh(positions);
  updateBed();
}

function setPressed(key) {
  hlOn = key;
  all('[data-hl]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.hl === key)));
}

function highlight(key, positions, kind) {
  if (!viewer || !hasView) return;
  const off = hlOn === key;
  setPressed(off ? null : key);
  viewer.highlight(off ? null : positions, kind);
  if (off) viewer.reset();
  else $('viewer').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ---- build volume -----------------------------------------------------------------------------------

function bedSize() {
  if ($('bed').value !== 'custom') return $('bed').value.split(',').map(Number);
  const size = ['bed-x', 'bed-y', 'bed-z'].map((id) => readNumber($(id)));
  return size.includes(null) ? null : size;
}

function updateBed() {
  $('bed-custom').hidden = $('bed').value !== 'custom';
  if (!cur) return;
  const bed = bedSize();
  $('bed-cut').hidden = true;
  if (viewer && hasView) viewer.setBed(bed);
  if (!bed) return notice($('bed-result'), 'info', '');
  const r = bedFit(cur.size, bed);
  if (r.fit === 'too_big') {
    const over = r.over.map((v, k) => (v > 0 ? `${'XYZ'[k]} +${mm(v)}` : '')).filter(Boolean).join(', ');
    notice($('bed-result'), 'warn', fmt(T.js_bed_too_big, { over }));
    $('bed-cut').hidden = false;
  } else {
    notice($('bed-result'), 'info', r.fit === 'as_is' ? T.js_bed_fits : T.js_bed_rotated);
    if (r.fit === 'as_is') $('bed-result').classList.add('good');
  }
}

// ---- table of all files -----------------------------------------------------------------------------

function renderFiles() {
  $('p-files').hidden = !files.some((f) => f.report || f.error);
  $('files').tBodies[0].replaceChildren(
    ...files.map((f, fid) => {
      const name = Object.assign(document.createElement('button'), { type: 'button', className: 'name', textContent: f.file.name });
      name.dataset.fid = fid;
      const r = f.report;
      let row;
      if (r) row = tr([name, ...r.size.map((v) => num(v)), num(r.volume / 1000), num(r.triangles, 0), issuesText(r)], 1);
      else {
        row = tr([f.file.name, f.error || T.js_working]);
        row.lastChild.colSpan = 6;
        if (f.error) row.lastChild.className = 'err';
      }
      if (r) row.lastChild.className = '';
      if (fid === active) row.setAttribute('aria-current', 'true');
      return row;
    }),
  );
}

function tableRows() {
  const round = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);
  return [
    [T.js_col_name, 'X (mm)', 'Y (mm)', 'Z (mm)', T.js_col_volume, T.js_col_triangles, T.js_col_issues],
    ...files.map((f) =>
      f.report
        ? [f.file.name, ...f.report.size.map(round), round(f.report.volume / 1000), f.report.triangles, issuesText(f.report)]
        : [f.file.name, null, null, null, null, null, f.error],
    ),
  ];
}

// ---- events -----------------------------------------------------------------------------------------

dropzone($('drop'), start, (message) => {
  worker?.terminate();
  pending = 0;
  hideDetail();
  $('p-files').hidden = true;
  notice($('msg'), 'info', '');
  notice($('errs'), 'error', message);
});

document.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || b.disabled) return;
  if (b.dataset.hl === 'thin') highlight('thin', thinTris, 'tris');
  else if (b.dataset.hl) highlight(b.dataset.hl, cur.hl[b.dataset.hl], ['flipped', 'duplicate'].includes(b.dataset.hl) ? 'tris' : 'lines');
  else if (b.dataset.hole) {
    const h = cur.holes[b.dataset.hole];
    const pts = new Float32Array(h.pts.length + (h.closed ? 3 : 0));
    pts.set(h.pts);
    if (h.closed) pts.set(h.pts.subarray(0, 3), h.pts.length);
    hlOn = null; // each press shows that hole again
    highlight(`hole${b.dataset.hole}`, pts, 'strip');
  } else if (b.dataset.fid) select(+b.dataset.fid);
  else if (b.dataset.scale) {
    busy(true);
    scale *= +b.dataset.scale;
    post({ cmd: 'scale', factor: +b.dataset.scale });
  } else if (b.dataset.export) {
    busy(true);
    notice($('exp-msg'), 'info', T.js_working);
    post({ cmd: 'export', format: b.dataset.export });
  }
});

$('view-reset').onclick = () => {
  if (!viewer) return;
  setPressed(null);
  viewer.highlight(null);
  viewer.reset();
};
$('bed').onchange = () => {
  store('bench.bed', $('bed').value);
  updateBed();
};
for (const id of ['bed-x', 'bed-y', 'bed-z']) {
  $(id).oninput = () => {
    store('bench.bedCustom', ['bed-x', 'bed-y', 'bed-z'].map((i) => $(i).value).join(','));
    updateBed();
  };
}
{
  const saved = store('bench.bed');
  if (saved && [...$('bed').options].some((o) => o.value === saved)) $('bed').value = saved;
  (store('bench.bedCustom') || '').split(',').forEach((v, i) => {
    if (v && Number.isFinite(+v)) $(['bed-x', 'bed-y', 'bed-z'][i]).value = v;
  });
  updateBed();
}

let lastLimit = 0.8;
$('thin-run').onclick = () => {
  const nozzle = readNumber($('nozzle'));
  if (nozzle == null) return;
  lastLimit = nozzle * 2;
  busy(true);
  $('thin-show').hidden = true;
  if (hlOn === 'thin') highlight('thin');
  notice($('thin-result'), 'info', T.js_working);
  post({ cmd: 'thin', limit: lastLimit });
};

$('hole-pick').onclick = () => {
  const max = readNumber($('hole-max'));
  if (max == null) return;
  all('#hole-list input').forEach((box) => (box.checked = !box.disabled && cur.holes[box.value].size < max));
};
$('hole-clear').onclick = () => all('#hole-list input').forEach((box) => (box.checked = false));

$('rep-apply').onclick = () => {
  const tol = $('rep-weld').checked ? readNumber($('rep-tol')) : 0;
  if (tol == null) return;
  const opts = { tol, clean: $('rep-clean').checked, normals: $('rep-normals').checked, holes: all('#hole-list input:checked').map((box) => +box.value) };
  notice($('rep-proof'), 'info', '');
  $('rep-table').hidden = true;
  if (!opts.tol && !opts.clean && !opts.normals && !opts.holes.length) return notice($('rep-msg'), 'warn', T.js_rep_nothing);
  busy(true);
  notice($('rep-msg'), 'info', T.js_working);
  post({ cmd: 'repair', opts });
};
$('rep-undo').onclick = () => {
  busy(true);
  modified = false;
  notice($('rep-msg'), 'info', T.js_working);
  post({ cmd: 'revert' });
};

$('dl-xlsx').onclick = () => download(writeXLSX(tableRows(), 'STL'), 'mesh-check.xlsx');
$('dl-csv').onclick = () => download(toCSV(tableRows()), 'mesh-check.csv', 'text/csv');
