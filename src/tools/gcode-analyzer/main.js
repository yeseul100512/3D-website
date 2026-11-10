// Drop G-code files -> analyse each in a Worker -> one card per file/plate, totals, export.
import { dropzone, notice, errorText, download, esc, fmt, num, duration } from '../../lib/ui.js';
import { writeXLSX, toCSV } from '../../lib/xlsx.js';

const T = window.T;
const $ = (id) => document.getElementById(id);
const metres = (mm) => `${num(mm / 1000)} m`;
const amount = (t) => [t.g != null && `${num(t.g)} g`, metres(t.mm), `${num(t.cm3)} cm³`].filter(Boolean).join(' · ');
const title = (r) => (r.plate ? `${r.name} · ${fmt(T.js_plate, { n: r.plate })}` : r.name);
const feature = (f) => T[`js_feat_${f.key}`] || f.name;
const round = (v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : null);

let worker;
let results = []; // analyzeGcode() results plus { name }

function table(caption, head, body) {
  const cells = (row, tag) => row.map((c, i) => `<${tag}${i && typeof c === 'object' ? ' class="num"' : ''}>${typeof c === 'object' ? c.html : esc(c)}</${tag}>`).join('');
  return `<div class="table-scroll"><table class="result"><caption>${esc(caption)}</caption>${
    head ? `<thead><tr>${head.map((h, i) => `<th scope="col"${i ? ' class="num"' : ''}>${esc(h)}</th>`).join('')}</tr></thead>` : ''
  }<tbody>${body.map((row) => `<tr>${head ? cells(row, 'td') : `<th scope="row">${esc(row[0])}</th><td>${esc(row[1] ?? T.js_unknown)}</td>`}</tr>`).join('')}</tbody></table></div>`;
}
const n = (text) => ({ html: esc(text) }); // right-aligned cell

function card(r) {
  const t = r.total;
  const diff = t.fromHeader && t.mm ? ` (${fmt(T.js_esum_diff, { diff: num(((t.measuredMm - t.mm) / t.mm) * 100, 3) })})` : '';
  const warnings = r.warnings
    .map(({ code, data = {} }) => fmt(T[`js_warn_${code}`], { ...data, header: metres(data.header), measured: metres(data.measured) }))
    .join('\n');
  const summary = [
    [T.js_slicer, r.slicer && `${r.slicer.name} ${r.slicer.version}`],
    [T.js_printer, r.printer],
    [T.js_time, r.time && duration(r.time.seconds) + (r.time.model ? ` (${fmt(T.js_time_model, { t: duration(r.time.model) })})` : '')],
    [T.js_filament, amount(t)],
    [T.js_esum, metres(t.measuredMm) + diff],
    [T.js_layers, num(r.layers, 0) + (r.layersFrom === 'z' ? ` (${T.js_layers_z})` : '')],
    [T.js_layer_height, r.layerHeight && `${num(r.layerHeight)} mm`],
    [T.js_max_z, `${num(r.maxZ)} mm`],
    [T.js_nozzle, r.nozzleTemp && `${num(r.nozzleTemp, 0)} °C`],
    [T.js_bed, r.bedTemp && `${num(r.bedTemp, 0)} °C`],
    [T.js_changes, num(r.filamentChanges, 0)],
  ];
  if (r.sliceInfo) summary.push([T.js_slice_info, `${num(r.sliceInfo.g)} g · ${duration(r.sliceInfo.seconds)}`]);
  const filaments = r.filaments.map((f) => [
    String(f.slot),
    f.type || '–',
    // f.colour was checked against /^#hex$/ by the parser
    { html: f.colour ? `<span style="display:inline-block;width:12px;height:12px;border:1px solid var(--edge);border-radius:3px;background:${f.colour}"></span> ${esc(f.colour)}` : '–' },
    n(metres(f.mm)),
    n(`${num(f.cm3)} cm³`),
    n(f.g != null ? `${num(f.g)} g` : '–'),
    n(metres(f.measuredMm)),
  ]);
  const features = r.features.map((f) => [feature(f), n(metres(f.mm)), n(t.g != null ? `${num(t.g * f.share)} g` : '–'), n(`${num(f.share * 100, 1)} %`)]);
  return `<section class="panel"><h2>${esc(title(r))}</h2>${
    warnings ? `<p class="notice warn" role="status" style="white-space:pre-line">${esc(warnings)}</p>` : ''
  }${table(T.js_summary, null, summary)}${table(T.js_fil_caption, [T.js_slot, T.js_type, T.js_colour, T.js_length, T.js_volume, T.js_weight, T.js_esum], filaments)}${
    features.length > 1 ? table(T.js_feat_caption, [T.js_feature, T.js_length, T.js_weight, T.js_share], features) : ''
  }</section>`;
}

function totals() {
  const sum = { g: 0, mm: 0, cm3: 0, seconds: 0 };
  for (const r of results) {
    sum.g = sum.g == null || r.total.g == null ? null : sum.g + r.total.g;
    sum.mm += r.total.mm;
    sum.cm3 += r.total.cm3;
    sum.seconds = sum.seconds == null || !r.time ? null : sum.seconds + r.time.seconds;
  }
  return sum;
}

function render() {
  $('out').innerHTML = results.map(card).join('');
  $('actions').hidden = !results.length;
  if (!results.length) return;
  const sum = totals();
  $('totals').innerHTML =
    results.length > 1
      ? table(fmt(T.js_total_caption, { n: results.length }), null, [
          [T.js_time, sum.seconds != null ? duration(sum.seconds) : T.js_total_partial],
          [T.js_filament, amount(sum)],
        ])
      : '';
  // Values go in the fragment, so they are never sent to a server.
  const q = new URLSearchParams(sum.g != null ? { g: sum.g.toFixed(2) } : { cm3: sum.cm3.toFixed(2) });
  if (sum.seconds) q.set('h', (sum.seconds / 3600).toFixed(2));
  $('cost').href = `../print-cost-calculator/#${q}`;
}

function rows() {
  const out = [
    [T.js_file, T.js_slicer, T.js_printer, `${T.js_time} (s)`, `${T.js_weight} (g)`, `${T.js_length} (m)`, `${T.js_volume} (cm³)`, `${T.js_esum} (m)`,
      T.js_layers, `${T.js_layer_height} (mm)`, `${T.js_max_z} (mm)`, `${T.js_nozzle} (°C)`, `${T.js_bed} (°C)`, T.js_changes],
  ];
  for (const r of results) {
    out.push([title(r), r.slicer && `${r.slicer.name} ${r.slicer.version}`, r.printer, round(r.time?.seconds), round(r.total.g), round(r.total.mm / 1000),
      round(r.total.cm3), round(r.total.measuredMm / 1000), r.layers, r.layerHeight, round(r.maxZ), r.nozzleTemp, r.bedTemp, r.filamentChanges]);
  }
  out.push([], [T.js_file, T.js_slot, T.js_type, T.js_colour, `${T.js_weight} (g)`, `${T.js_length} (m)`, `${T.js_volume} (cm³)`, `${T.js_esum} (m)`]);
  for (const r of results) {
    for (const f of r.filaments) out.push([title(r), f.slot, f.type, f.colour, round(f.g), round(f.mm / 1000), round(f.cm3), round(f.measuredMm / 1000)]);
  }
  out.push([], [T.js_file, T.js_feature, `${T.js_length} (m)`, `${T.js_share} (%)`]);
  for (const r of results) for (const f of r.features) out.push([title(r), feature(f), round(f.mm / 1000), round(f.share * 100)]);
  return out;
}

function clear() {
  results = [];
  render();
  notice($('errors'), 'error', '');
  notice($('copied'), 'info', '');
}

function run(files) {
  worker?.terminate(); // a new drop cancels the previous job
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  clear();
  const errors = [];
  let i = 0;
  const status = (percent) => notice($('msg'), 'info', fmt(T.js_status, { name: files[i].name, percent, i: i + 1, n: files.length }));
  const next = () => {
    if (i < files.length) {
      status(0);
      return worker.postMessage({ file: files[i] });
    }
    worker.terminate();
    notice($('msg'), 'info', '');
    notice($('errors'), 'error', errors.join('\n'));
  };
  const fail = (err) => {
    errors.push(errorText(err, files[i].name));
    i++;
    next();
  };
  worker.onerror = fail;
  worker.onmessage = ({ data }) => {
    if (data.progress != null) return status(data.progress);
    if (data.error) return fail(data.error);
    for (const plate of data.plates) results.push({ name: files[i].name, ...plate });
    render();
    i++;
    next();
  };
  next();
}

dropzone($('drop'), run, (message) => {
  worker?.terminate();
  clear();
  notice($('msg'), 'info', '');
  notice($('errors'), 'error', message);
});

$('csv').onclick = () => download(toCSV(rows()), 'gcode-analysis.csv', 'text/csv');
$('xlsx').onclick = () => download(writeXLSX(rows(), 'G-code'), 'gcode-analysis.xlsx');
$('copy').onclick = async () => {
  const text = rows().map((r) => r.map((c) => c ?? '').join('\t')).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    notice($('copied'), 'info', T.js_copied);
  } catch {
    notice($('copied'), 'error', T.js_copy_failed);
  }
};
