import { dropzone, notice, errorText, readNumber, download, fmt, num, duration } from '../../lib/ui.js';
import { writeSTL } from '../../lib/mesh-io.js';
import { plan, jointFor, pieceLabel, pieceColor, mapSVG, COLORS, MAX_PIECES } from './cut-plan.js';

const T = window.T;
const $ = (id) => document.getElementById(id);
const radio = (name) => document.querySelector(`input[name=${name}]:checked`).value;
const dimsText = (v) => v.map((x) => num(x, 1)).join(' × ');

let model = null; // { name, base, triangles, size, volume, open }: only ever a fully loaded file
let result = null; // { pieces, n, dims, base }: pieces of the current model
let worker = null;
let timer = 0;

// ---- 3D view (three.js is fetched when the first model arrives) -------------------------------------
const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.182.0/+esm';
const ORBIT_URL = 'https://cdn.jsdelivr.net/npm/three@0.182.0/examples/jsm/controls/OrbitControls.js/+esm';
let view;
const getView = () => (view ||= (async () => {
  const [THREE, { OrbitControls }] = await Promise.all([import(THREE_URL), import(ORBIT_URL)]);
  const el = $('viewer');
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x232532);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1e6);
  camera.up.set(0, 0, 1); // Z up, as in a slicer
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(1, 2, 3);
  camera.add(sun); // the light follows the camera
  scene.add(camera, new THREE.HemisphereLight(0xffffff, 0x444444, 1.4));
  const group = new THREE.Group();
  scene.add(group);
  const orbit = new OrbitControls(camera, renderer.domElement);
  const render = () => renderer.render(scene, camera);
  orbit.addEventListener('change', render);
  new ResizeObserver(() => {
    renderer.setSize(el.clientWidth, el.clientHeight, false);
    camera.aspect = el.clientWidth / el.clientHeight || 1;
    camera.updateProjectionMatrix();
    render();
  }).observe(el);
  renderer.domElement.setAttribute('aria-hidden', 'true');
  el.append(renderer.domElement);
  return {
    /** parts: [{ triangles, color }]; an empty list clears the view. */
    show(parts) {
      for (const m of group.children) {
        m.geometry.dispose();
        m.material.dispose();
      }
      group.clear();
      const box = new THREE.Box3();
      for (const { triangles, color } of parts) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(triangles, 3));
        g.computeBoundingBox();
        box.union(g.boundingBox);
        group.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color, flatShading: true, side: THREE.DoubleSide, metalness: 0.1, roughness: 0.6 })));
      }
      renderer.domElement.hidden = !parts.length;
      $('viewer-empty').hidden = !!parts.length;
      if (parts.length) {
        const c = box.getCenter(new THREE.Vector3());
        const d = Math.max(...box.getSize(new THREE.Vector3()).toArray()) || 1;
        this.center = c;
        camera.position.set(c.x + d * 0.9, c.y - d * 1.3, c.z + d * 0.9);
        camera.near = d / 100;
        camera.far = d * 100;
        camera.updateProjectionMatrix();
        orbit.target.copy(c);
        orbit.update();
      }
      render();
    },
    explode(on) {
      for (const m of group.children) {
        m.position.copy(on ? m.geometry.boundingBox.getCenter(new THREE.Vector3()).sub(this.center).multiplyScalar(0.5) : new THREE.Vector3());
      }
      render();
    },
  };
})());

/** Draw parts, or say why there is no preview. The tool itself keeps working without one. */
async function show(parts) {
  try {
    (await getView()).show(parts);
  } catch (e) {
    view = null;
    $('viewer-empty').hidden = false;
    $('viewer-empty').textContent = T.js_viewer_fail;
    $('explode-row').hidden = true; // nothing to spread apart without a view
  }
}

// ---- jobs ---------------------------------------------------------------------------------------------
function stop() {
  worker?.terminate();
  worker = null;
  clearInterval(timer);
  $('cancel').hidden = true;
  $('run').disabled = !model;
  $('zip').disabled = false;
}

/** Start a worker job. `status(data)` returns the progress text for a message, or undefined to keep the old one. */
function start(el, job, transfer, status, onDone) {
  stop();
  $('cancel').hidden = false;
  $('run').disabled = true;
  const began = Date.now();
  let text = T.js_working;
  const tick = () => notice(el, 'info', `${text} · ${duration((Date.now() - began) / 1000)}`);
  timer = setInterval(tick, 1000);
  const fail = (err) => {
    stop();
    onDone(null, err);
  };
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onerror = (e) => fail({ code: 'lib', message: e.message || '' }); // the worker script itself did not load or crashed
  worker.onmessage = ({ data }) => {
    if (data.error) return fail(data.error);
    if (data.loaded || data.pieces || data.zip) {
      stop();
      return onDone(data);
    }
    text = status(data) ?? text;
    tick();
  };
  tick();
  worker.postMessage(job, transfer);
}

function clearResult() {
  result = null;
  $('out').hidden = true;
  $('rows').replaceChildren();
  $('map').replaceChildren();
  notice($('status'), 'info', '');
  notice($('warn'), 'info', '');
}

/** Forget the model: nothing can be cut or downloaded until a file loads completely. */
function clearModel() {
  stop();
  model = null;
  clearResult();
  $('run').disabled = true;
  $('partial').hidden = true;
  $('info').hidden = true;
  $('open').hidden = true;
  notice($('msg'), 'info', '');
  if (view) show([]);
}

function load(file, allowTruncated = false) {
  clearModel();
  start($('msg'), { cmd: 'load', file, allowTruncated }, [], (d) => fmt(T.js_reading, { name: file.name, percent: Math.round((d.progress || 0) * 100) }), (data, err) => {
    if (err) {
      notice($('msg'), 'error', errorText(err, file.name));
      if (err.code === 'truncated') {
        $('partial').hidden = false;
        $('partial').onclick = () => load(file, true);
      }
      return;
    }
    const m = data.loaded;
    model = { ...m, name: file.name, base: file.name.replace(/\.[^.]+$/, '') };
    $('run').disabled = false;
    const notes = [];
    if (m.truncated) notes.push(errorText({ code: 'truncated', data: m.truncated }, file.name));
    if (m.bad) notes.push(fmt(T.js_bad_triangles, { n: num(m.bad, 0) }));
    notice($('msg'), 'warn', notes.join(' '));
    $('info').textContent = fmt(T.js_model_info, { name: file.name, size: dimsText(m.size), n: num(m.count, 0) });
    $('info').hidden = false;
    $('open-text').textContent = fmt(T.js_open_warn, { n: num(m.open, 0) });
    $('open').hidden = !m.open;
    show([{ triangles: m.triangles, color: COLORS[0] }]);
  });
}

function settings() {
  const read = (ids) => ids.map((id) => readNumber($(id)));
  const flat = radio('joint') === 'flat';
  const manual = radio('count') === 'manual';
  const values = [...read(['bed-x', 'bed-y', 'bed-z', 'margin']), ...(flat ? [0, 0, 0] : read(['tooth-w', 'tooth-d', 'tooth-gap'])), ...(manual ? read(['n-x', 'n-y', 'n-z']) : [])];
  if (values.includes(null)) return null;
  const [x, y, z, margin, width, depth, gap, ...counts] = values;
  if (counts.some((c) => !Number.isInteger(c))) return T.js_err_count_int;
  const eff = [x, y, z].map((v) => v - 2 * margin);
  if (eff.some((v) => v <= 0)) return T.js_err_margin;
  const tooth = width > 0 ? { width, depth, gap } : null; // width 0 means a flat cut, and is reported as one
  const opts = { rotate: radio('orient') === 'auto', manual: manual ? counts : null };
  const p = plan(model.size, eff, tooth ? depth : 0, opts);
  // Not even flat cuts fit: the model is far too large for the printer (wrong unit?), not a tooth problem.
  if (!Number.isFinite(p.total)) return Number.isFinite(plan(model.size, eff, 0, opts).total) ? T.js_err_no_fit : T.js_err_too_long;
  if (p.total > MAX_PIECES) return fmt(T.js_err_too_many, { n: num(p.total, 0), max: MAX_PIECES });
  const joints = p.n.map((n, axis) => (n > 1 ? jointFor(p.dims, axis, tooth, p.n) : null));
  for (const [axis, j] of joints.entries()) {
    if (!j) continue;
    if (p.dims[j.comb] / j.segs - 2 * gap < 0.5) return T.js_err_tooth_small;
    if (p.dims[axis] / p.n[axis] < 2 * depth + 1) return T.js_err_tooth_deep;
  }
  // A side too short for two teeth is cut flat, so "finger joints" is only reported when some joint has teeth.
  const noTeeth = joints.every((j) => !j);
  return { ...p, eff, joints, flat: noTeeth, zeroWidth: !flat && !tooth, tooShort: !!tooth && noTeeth };
}

function run() {
  if (!model) return;
  if (result) show([{ triangles: model.triangles, color: COLORS[0] }]); // back to the uncut model
  clearResult(); // pieces made with other settings must not sit under a new message
  const s = settings();
  if (!s || typeof s === 'string') return notice($('status'), 'error', s || T.js_err_fields);
  const base = model.base;
  const stages = { lib: T.js_stage_lib, prep: T.js_stage_prep };
  // The soup is copied to the worker (not transferred) so the model stays loaded for another run.
  start($('status'), { cmd: 'cut', triangles: model.triangles, perm: s.perm, n: s.n, joints: s.joints }, [],
    (d) => (d.stage === 'cut' ? fmt(T.js_stage_cut, { done: d.done + 1, total: d.total }) : stages[d.stage]),
    (data, err) => {
      if (err) return notice($('status'), 'error', errorText(err, model.name));
      if (!data.pieces.length) return notice($('status'), 'error', T.js_err_no_pieces);
      notice($('status'), 'info', '');
      result = { pieces: data.pieces, n: s.n, dims: data.dims, base };
      render(s);
    });
}

function render(s) {
  const { pieces, n, dims, base } = result;
  const axes = 'XYZ';
  const lines = [];
  const fitsBed = (p) => p.max.every((v, i) => v - p.min[i] <= s.eff[i] + 0.01);
  // Manual 1×1×1 on a too-big model is not "no cut needed": the warning below says what is wrong.
  if (s.total === 1) pieces.every(fitsBed) && lines.push(T.js_sum_nocut);
  else lines.push(fmt(T.js_sum_grid, { total: num(pieces.length, 0), x: n[0], y: n[1], z: n[2], mode: s.flat ? T.js_mode_flat : T.js_mode_teeth }));
  if (s.zeroWidth && s.total > 1) lines.push(T.js_flat_zero);
  if (s.tooShort && s.total > 1) lines.push(T.js_flat_short);
  if (s.perm.join() !== '0,1,2') lines.push(fmt(T.js_sum_rotated, { x: axes[s.perm[0]], y: axes[s.perm[1]], z: axes[s.perm[2]] }));
  lines.push(fmt(T.js_sum_usable, { size: dimsText(s.eff) }));
  $('summary').textContent = lines.join(' ');

  let tooBig = 0;
  $('rows').replaceChildren(...pieces.map((p) => {
    const size = p.max.map((v, i) => v - p.min[i]);
    const fits = fitsBed(p);
    if (!fits) tooBig++;
    const tr = document.createElement('tr');
    const name = tr.insertCell();
    const swatch = Object.assign(document.createElement('span'), { className: 'cut-swatch' });
    swatch.style.background = pieceColor(p.index, n);
    name.append(swatch, pieceLabel(p.index, n));
    tr.insertCell().textContent = dimsText(size);
    const fit = tr.insertCell();
    fit.textContent = fits ? `✓ ${T.js_fit_yes}` : `✗ ${T.js_fit_no}`;
    fit.className = fits ? 'fit-ok' : 'fit-no';
    const button = Object.assign(document.createElement('button'), { className: 'button secondary', type: 'button', textContent: 'STL' });
    button.setAttribute('aria-label', `${pieceLabel(p.index, n)} STL`);
    button.onclick = () => download(writeSTL(p.triangles), fileName(p));
    tr.insertCell().append(button);
    return tr;
  }));

  const warns = [];
  if (tooBig) warns.push(fmt(T.js_warn_nofit, { n: tooBig }));
  // The joint clearance removes material on purpose: at most 2 x gap x depth x thickness per tooth and cut plane.
  const cleared = s.joints.reduce((v, j, axis) => v + (j ? (n[axis] - 1) * j.segs * 2 * j.gap * j.depth * dims[3 - axis - j.comb] : 0), 0);
  const whole = Math.abs(model.volume);
  const lost = whole - pieces.reduce((a, p) => a + p.volume, 0);
  if (model.open === 0 && (lost > 0.01 * whole + cleared || lost < -0.01 * whole)) warns.push(fmt(T.js_warn_volume, { percent: num((Math.abs(lost) / whole) * 100, 1) }));
  if (model.open) warns.push(T.js_warn_open_result);
  notice($('warn'), 'warn', warns.join(' '));

  $('map').innerHTML = mapSVG(dims, n, pieces); // built from numbers only
  $('explode').checked = false;
  $('explode-row').hidden = pieces.length < 2;
  $('zip').hidden = pieces.length < 2;
  $('out').hidden = false;
  show(pieces.map((p) => ({ triangles: p.triangles, color: pieceColor(p.index, n) })));
}

const fileName = (p) => `${result.base}_${pieceLabel(p.index, result.n)}.stl`;
const mapFile = () => new Blob([mapSVG(result.dims, result.n, result.pieces)], { type: 'image/svg+xml' });

// ---- wiring -------------------------------------------------------------------------------------------
dropzone($('drop'), ([file]) => load(file), (message) => {
  clearModel(); // a rejected file must not leave the previous model ready to cut
  notice($('msg'), 'error', message);
});
$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  run();
});
$('cancel').onclick = () => {
  const loading = !model;
  stop();
  notice(loading ? $('msg') : $('status'), 'info', T.js_cancelled);
};
$('form').addEventListener('change', () => {
  $('manual').hidden = radio('count') !== 'manual';
  $('teeth').hidden = radio('joint') !== 'teeth';
});
$('explode').onchange = () => view?.then((v) => v.explode($('explode').checked), () => {});
$('map-save').onclick = () => download(mapFile(), `${result.base}_assembly-map.svg`);
$('zip').onclick = () => {
  // Packed in the worker (the checksum of a few hundred MB would freeze the page); the pieces are copied to it.
  const name = `${result.base}_parts.zip`;
  const files = [
    ...result.pieces.map((p) => ({ name: fileName(p), triangles: p.triangles })),
    { name: `${result.base}_assembly-map.svg`, data: mapSVG(result.dims, result.n, result.pieces) },
  ];
  start($('status'), { cmd: 'zip', files }, [], () => undefined, (data, err) => {
    if (err) return notice($('status'), 'error', errorText(err, name));
    notice($('status'), 'info', '');
    download(data.zip, name);
  });
  $('zip').disabled = true; // until the job ends or is cancelled (stop() turns it back on)
};
