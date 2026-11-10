// Weight (from G-code, from the analyzer's link, from a model estimate, or typed) -> cost breakdown.
import { dropzone, notice, errorText, readNumber, download, esc, fmt, num, duration } from '../../lib/ui.js';
import { writeXLSX, toCSV } from '../../lib/xlsx.js';
import { shellWeight, computeCost } from './calc.js';

const T = window.T;
const $ = (id) => document.getElementById(id);

// [density g/cm³, typical street price per kg in USD]. Typical manufacturer values, shown as editable defaults.
const MATERIALS = {
  PLA: [1.24, 20], PETG: [1.27, 20], ABS: [1.04, 20], ASA: [1.07, 25], TPU: [1.21, 30],
  PA: [1.14, 40], PC: [1.2, 40], 'PLA-CF': [1.22, 35], 'PETG-CF': [1.25, 35], PVA: [1.23, 80],
};
// The currency only sets the symbol and decimals. The factor scales the default price, nothing else.
const CURRENCIES = { KRW: 1000, USD: 1, EUR: 1, JPY: 150, CNY: 5, GBP: 1 };
const KEY = 'bench.print-cost.v1';
const SAVED = ['wall', 'infill', 'watts', 'kwh', 'wear', 'fail', 'labour-rate', 'labour-min', 'margin', 'fee'];
const fresh = () => ({ material: 'PLA', currency: { ko: 'KRW', ja: 'JPY', 'zh-Hans': 'CNY' }[T.lang] || 'USD', density: {}, price: {}, fields: {} });

let state = fresh();
try {
  const saved = JSON.parse(localStorage.getItem(KEY));
  if (saved && MATERIALS[saved.material] && CURRENCIES[saved.currency]) state = { ...state, ...saved };
} catch {
  // private mode or damaged data: start from the defaults
}
const save = () => {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // storage unavailable: the page still works, settings just are not remembered
  }
};

let source = null; // { kind: 'gcode', g, cm3, seconds } | { kind: 'mesh', volumeCm3, areaCm2 } | null (typed by hand)
let worker;
let exportRows = [];

const money = (v) => (Number.isFinite(v) ? new Intl.NumberFormat(T.lang, { style: 'currency', currency: state.currency }).format(v) : '–');

function showSettings() {
  $('material').value = state.material;
  $('currency').value = state.currency;
  const [density, usd] = MATERIALS[state.material];
  $('density').value = state.density[state.material] ?? density;
  $('price').value = state.price[state.material] ?? usd * CURRENCIES[state.currency];
  for (const id of SAVED) $(id).value = state.fields[id] ?? $(id).defaultValue;
}

function update() {
  let ok = true;
  const read = (id) => {
    const v = readNumber($(id));
    if ($(id).getAttribute('aria-invalid') === 'true') ok = false;
    return v;
  };
  const density = read('density');
  if (source) {
    let g = null;
    if (source.kind === 'gcode') g = source.g ?? (density ? source.cm3 * density : null);
    else {
      const wall = read('wall');
      const infill = read('infill');
      if (ok) g = shellWeight(source.volumeCm3, source.areaCm2, wall, infill, density);
    }
    $('weight').value = g == null ? '' : +g.toFixed(2);
  }
  const grams = read('weight');
  const v = Object.fromEntries(['price', 'hours', ...SAVED.slice(2)].map((id) => [id, read(id) ?? 0]));
  const show = ok && grams != null;
  $('result').hidden = !show;
  $('empty').hidden = show;
  $('csv').disabled = $('xlsx').disabled = !show;
  $('need-hours').hidden = !(show && !v.hours && ((v.watts && v.kwh) || v.wear));
  if (!show) return;

  const c = computeCost({
    grams, pricePerKg: v.price, hours: v.hours, watts: v.watts, kwhPrice: v.kwh, wearPerHour: v.wear,
    failPct: v.fail, labourRate: v['labour-rate'], labourMin: v['labour-min'], marginPct: v.margin, feePct: v.fee,
  });
  const rows = [
    [T.js_row_filament, `${num(grams)} g × ${money(v.price)}/kg`, c.filament],
    c.electricity && [T.js_row_electricity, `${num(v.watts, 0)} W × ${num(v.hours)} h × ${money(v.kwh)}/kWh`, c.electricity],
    c.wear && [T.js_row_wear, `${num(v.hours)} h × ${money(v.wear)}/h`, c.wear],
    c.failure && [T.js_row_failure, `${num(v.fail)} %`, c.failure],
    c.labour && [T.js_row_labour, `${num(v['labour-min'])} min × ${money(v['labour-rate'])}/h`, c.labour],
    [T.js_row_total, '', c.total, true],
    ...(v.margin || v.fee
      ? [[T.js_row_margin, `${num(v.margin)} %`, c.margin], [T.js_row_fee, `${num(v.fee)} %`, c.fee], [T.js_row_price, '', c.price, true]]
      : []),
  ].filter(Boolean);
  const head = [T.js_col_item, T.js_col_basis, T.js_col_amount];
  $('result').innerHTML = `<table class="result"><thead><tr>${head.map((h, i) => `<th scope="col"${i === 2 ? ' class="num"' : ''}>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows
    .map(([item, basis, value, strong]) => `<tr><th scope="row">${strong ? `<strong style="color:var(--text)">${esc(item)}</strong>` : esc(item)}</th><td>${esc(basis)}</td><td class="num">${strong ? `<strong>${esc(money(value))}</strong>` : esc(money(value))}</td></tr>`)
    .join('')}</tbody></table>`;
  exportRows = [[head[0], head[1], `${head[2]} (${state.currency})`], ...rows.map(([item, basis, value]) => [item, basis, Math.round(value * 100) / 100])];
}

function load(file) {
  worker?.terminate(); // a new file cancels the previous one
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  source = null; // nothing of the previous file stays on screen
  $('weight').value = $('hours').value = '';
  $('estimate').hidden = $('open-mesh').hidden = true;
  update();
  const reading = (percent) => notice($('msg'), 'info', fmt(T.js_reading, { name: file.name, percent }));
  const fail = (err) => notice($('msg'), 'error', errorText(err, file.name));
  reading(0);
  worker.onerror = fail;
  worker.onmessage = ({ data }) => {
    if (data.progress != null) return reading(data.progress);
    worker.terminate();
    if (data.error) return fail(data.error);
    if (data.kind === 'mesh' && !data.watertight) {
      notice($('msg'), 'info', '');
      $('open-mesh').hidden = false; // no volume-based number for an open mesh
      return;
    }
    source = data;
    $('estimate').hidden = data.kind !== 'mesh';
    if (data.kind === 'mesh') {
      notice($('msg'), 'info', fmt(T.js_from_mesh, { name: file.name, volume: num(data.volumeCm3), area: num(data.areaCm2) }));
    } else {
      if (data.seconds) $('hours').value = +(data.seconds / 3600).toFixed(2);
      notice($('msg'), 'info', fmt(data.g != null ? T.js_from_gcode : T.js_from_gcode_volume, {
        name: file.name, volume: num(data.cm3), time: data.seconds ? duration(data.seconds) : T.js_no_time,
      }));
    }
    update();
  };
  worker.postMessage({ file });
}

dropzone($('drop'), ([file]) => load(file), (message) => {
  worker?.terminate();
  source = null;
  $('weight').value = $('hours').value = '';
  $('estimate').hidden = $('open-mesh').hidden = true;
  update();
  notice($('msg'), 'error', message);
});

$('material').append(...Object.keys(MATERIALS).map((name) => new Option(name)));
showSettings();
for (const d of document.querySelectorAll('.tool details')) d.open = [...d.querySelectorAll('input')].some((i) => i.value);

// Numbers handed over by the analyzer travel in the URL fragment (never sent to a server).
const hash = new URLSearchParams(location.hash.slice(1));
const given = (k) => {
  const n = Number(hash.get(k));
  return hash.get(k) && Number.isFinite(n) && n >= 0 ? n : null;
};
if (given('g') != null || given('cm3') != null) {
  source = { kind: 'gcode', g: given('g'), cm3: given('cm3') ?? 0 };
  if (given('h') != null) $('hours').value = given('h');
  notice($('msg'), 'info', T.js_from_analyzer);
}
update();

$('weight').addEventListener('input', () => {
  source = null; // typed by hand from here on
  $('estimate').hidden = $('open-mesh').hidden = true;
  notice($('msg'), 'info', '');
});
for (const id of ['density', 'price']) {
  $(id).addEventListener('input', () => {
    const v = readNumber($(id));
    if (v != null) state[id][state.material] = v;
  });
}
for (const id of SAVED) $(id).addEventListener('input', () => (state.fields[id] = $(id).value));
// 'input' (not 'change') so these run before the shared listener below recalculates
$('material').addEventListener('input', () => {
  state.material = $('material').value;
  showSettings();
});
$('currency').addEventListener('input', () => {
  state.currency = $('currency').value;
  showSettings();
});
document.querySelector('.tool').addEventListener('input', () => {
  save();
  update();
});
$('reset').onclick = () => {
  state = fresh();
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing was stored
  }
  showSettings();
  update();
};
$('csv').onclick = () => download(toCSV(exportRows), 'print-cost.csv', 'text/csv');
$('xlsx').onclick = () => download(writeXLSX(exportRows, 'Cost'), 'print-cost.xlsx');
