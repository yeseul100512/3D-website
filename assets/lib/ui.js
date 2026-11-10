// Small UI helpers shared by every tool page. Translated strings come from window.T
// (injected by the build). Nothing here touches the DOM at import time.

const T = () => globalThis.T || {};

/** Escape text for use inside HTML. */
export const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** fmt('{n} files', {n: 3}) -> '3 files'. Unknown names are left as they are. */
export const fmt = (template, vars = {}) => String(template).replace(/\{(\w+)\}/g, (all, k) => (k in vars ? vars[k] : all));

/** Localised number; '–' instead of NaN/Infinity/null. */
export function num(n, digits = 2) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '–';
  // signDisplay 'negative': a small negative that rounds to zero reads "0", not "-0"
  return n.toLocaleString(T().lang || 'en', { maximumFractionDigits: digits, signDisplay: 'negative' });
}

/** 1536 -> '1.5 KB' */
export function bytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '–';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  for (; n >= 1024 && i < 3; i++) n /= 1024;
  return `${num(n, i ? 1 : 0)} ${units[i]}`;
}

/** 3725 -> '1h 2m' (units from T.js_unit_h / _m / _s); under a minute -> '45s'. */
export function duration(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '–';
  const t = T();
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (!h && !m) return `${s}${t.js_unit_s || 's'}`;
  return [h && `${h}${t.js_unit_h || 'h'}`, `${m}${t.js_unit_m || 'm'}`].filter(Boolean).join(' ');
}

/**
 * Validate the text of a number field.
 * @param {string} raw
 * @param {{min?: number, max?: number, required?: boolean, badInput?: boolean}} rule
 * @returns {{value: number | null, error: string}} error is a translated message, '' when valid.
 *   An empty optional field gives {value: null, error: ''}.
 */
export function checkNumber(raw, { min = -Infinity, max = Infinity, required = true, badInput = false } = {}) {
  const t = T();
  const text = String(raw ?? '').trim();
  const value = Number(text);
  let error = '';
  if (badInput || (text !== '' && !Number.isFinite(value))) error = t.js_num_invalid || 'Enter a number.';
  else if (text === '') error = required ? t.js_num_required || 'Enter a value.' : '';
  else if (value < min) error = fmt(t.js_num_min || 'Enter {min} or more.', { min });
  else if (value > max) error = fmt(t.js_num_max || 'Enter {max} or less.', { max });
  return { value: error || text === '' ? null : value, error };
}

/**
 * Read an <input type="number"> using its own min / max / required attributes. Shows the translated
 * message under the field (inside its .field) and sets aria-invalid. Returns the number, or null if invalid.
 */
export function readNumber(input) {
  const { value, error } = checkNumber(input.value, {
    min: input.min === '' ? undefined : Number(input.min),
    max: input.max === '' ? undefined : Number(input.max),
    required: input.required,
    badInput: input.validity?.badInput,
  });
  let msg = document.getElementById(input.id + '-error');
  if (!msg && error) {
    msg = document.createElement('small');
    msg.id = input.id + '-error';
    msg.className = 'field-error';
    input.after(msg);
  }
  if (msg) msg.textContent = error;
  input.setAttribute('aria-invalid', String(!!error));
  if (error) input.setAttribute('aria-describedby', msg.id);
  else input.removeAttribute('aria-describedby');
  return value;
}

/**
 * Show a message in a container (plain text, never HTML). kind: 'info' | 'warn' | 'error'.
 * Pass an empty message to clear and hide it.
 */
export function notice(el, kind, message) {
  el.className = kind === 'info' ? 'notice' : `notice ${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.textContent = message || '';
  el.hidden = !message;
}

/**
 * Wire a <label class="dropzone"> that contains an <input type="file">. Click and keyboard are native;
 * this adds drag-and-drop and checks. The input's accept (".stl,.3mf") and multiple attributes are the rules.
 * @param {HTMLElement} zone
 * @param {(files: File[]) => void} onFiles called with at least one non-empty file of an accepted type
 * @param {(message: string) => void} onError called with a translated message (wrong type, empty file)
 */
export function dropzone(zone, onFiles, onError) {
  const input = zone.querySelector('input[type=file]');
  const exts = input.accept.toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  const take = (list) => {
    const t = T();
    let files = [...list];
    input.value = ''; // so picking the same file again fires change
    if (!files.length) return;
    if (!input.multiple) files = files.slice(0, 1);
    const wrong = files.find((f) => exts.length && !exts.some((e) => f.name.toLowerCase().endsWith(e)));
    if (wrong) return onError(fmt(t.js_err_wrong_type || '{name}: unsupported file type ({types}).', { name: wrong.name, types: exts.join(', ') }));
    const empty = files.find((f) => !f.size);
    if (empty) return onError(fmt(t.js_err_empty || '{name} is empty.', { name: empty.name }));
    onFiles(files);
  };
  input.addEventListener('change', () => take(input.files));
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('drag');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drag');
    take(e.dataTransfer.files);
  });
}

/** Save a Blob (or text) as a file. */
export function download(data, filename, type = 'application/octet-stream') {
  const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Translated message for anything thrown while loading a file: a MeshError from mesh-io.js
 * (js_err_<code>), a zip error, or an unexpected exception (js_err_unknown).
 */
export function errorText(err, name = '') {
  const t = T();
  let key = err?.code === 'bad_zip' ? 'js_err_not_mesh' : `js_err_${err?.code}`;
  if (err?.code === 'truncated' && err.data?.declared == null) key = 'js_err_truncated_unknown'; // ASCII STL declares no count
  const data = Object.fromEntries(Object.entries(err?.data || {}).map(([k, v]) => [k, typeof v === 'number' ? num(v, 0) : v]));
  return fmt(t[key] || t.js_err_unknown || 'Something went wrong: {detail}', { name, detail: err?.message || String(err), ...data });
}
