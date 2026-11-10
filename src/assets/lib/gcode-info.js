// Reads what a slicer wrote into a G-code file (time, filament, settings) and independently sums the
// E moves per extruder and per feature. Works on plain .gcode text (streamed) and Bambu/Orca .gcode.3mf.
// No DOM: runs in a Worker and in Node.
import { readZip } from './zip.js';

/** code: 'not_text' | 'bgcode' | 'no_moves' | 'no_plate' (a 3MF without sliced G-code) */
export class GcodeError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

// Slicer feature names -> one key per kind of extrusion. Unknown names are kept as they are.
const FEATURES = {
  outer_wall: ['outer wall', 'external perimeter', 'wall-outer'],
  inner_wall: ['inner wall', 'perimeter', 'wall-inner'],
  overhang_wall: ['overhang wall', 'overhang perimeter'],
  sparse_infill: ['sparse infill', 'internal infill', 'infill', 'fill'],
  solid_infill: ['internal solid infill', 'solid infill', 'floating vertical shell'],
  top_surface: ['top surface', 'top solid infill'],
  bottom_surface: ['bottom surface'],
  skin: ['skin'],
  bridge: ['bridge', 'bridge infill', 'internal bridge'],
  gap_infill: ['gap infill', 'gap fill'],
  support: ['support', 'support material', 'support transition'],
  support_interface: ['support interface', 'support material interface', 'support-interface'],
  skirt_brim: ['skirt', 'brim', 'skirt/brim', 'skirt-brim'],
  prime_tower: ['prime tower', 'wipe tower', 'prime-tower'],
  ironing: ['ironing'],
  custom: ['custom'],
};
const FEATURE_KEY = new Map(Object.entries(FEATURES).flatMap(([key, names]) => names.map((n) => [n, key])));

const SLICER_NAMES = { BambuStudio: 'Bambu Studio', Cura_SteamEngine: 'Cura' };
const UNIT = { d: 86400, h: 3600, m: 60, s: 1 };

/** '1d 2h 3m 4s' -> seconds, or null when there is no duration in the text. */
export function parseDuration(text) {
  let seconds = 0;
  let hit = false;
  for (const [, n, u] of String(text).matchAll(/(\d+(?:\.\d+)?)\s*([dhms])/g)) {
    seconds += n * UNIT[u];
    hit = true;
  }
  return hit ? seconds : null;
}

const numbers = (v) => (v == null ? [] : v.split(/[,;]/).map((x) => parseFloat(x)));
const strings = (v) => (v == null ? [] : v.split(/[;,]/).map((x) => x.trim().replace(/^"|"$/g, '')));
const first = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};
const isDigit = (c) => c >= 48 && c <= 57;

// Comment keys worth keeping (lower case). Everything else in the (often 600-line) config block is skipped.
const KEEP = new Set([
  'model printing time', 'total estimated time', 'estimated printing time (normal mode)', 'time', 'time_elapsed',
  'total layer number', 'total layers count', 'layer_count', 'layer_height', 'layer height', 'max_z_height',
  'total filament length [mm]', 'total filament volume [cm^3]', 'total filament weight [g]',
  'filament used [mm]', 'filament used [cm3]', 'filament used [g]', 'filament used', 'filament',
  'filament_density', 'filament_diameter', 'filament_type', 'filament_colour', 'filament_cost',
  'nozzle_temperature', 'temperature', 'printer_model', 'target_machine.name',
]);

/**
 * Line-by-line G-code reader. Feed decoded text with push() in chunks of any size, then call end().
 * @returns {{push(text: string): void, end(): object}}
 */
export function createScanner() {
  const meta = {};
  let slicer = null;
  let carry = '';
  let moves = 0;
  // E axis: explicit M82/M83 wins; otherwise E follows G90/G91 (Marlin behaviour).
  let eMode = null;
  let relative = false;
  let lastE = 0;
  let tool = 0;
  const tools = []; // per extruder: { pos, max } - filament counts only when pos passes its high-water mark,
  let extruded = false; //                 so retract/unretract pairs add nothing
  let toolChanges = 0;
  let pauses = 0;
  const features = new Map();
  let feature = null;
  const setFeature = (name) => {
    const key = FEATURE_KEY.get(name.toLowerCase()) || name;
    feature = features.get(key);
    if (!feature) features.set(key, (feature = { key, name, mm: 0 }));
  };
  setFeature('unlabelled');
  let typed = false;
  let layerMarks = 0;
  let zLayers = 0;
  let z = 0;
  let printZ = NaN;
  let maxZ = 0;
  let nozzleNow = 0;
  let bedNow = 0;
  let nozzle = null;
  let bed = null;

  function move(l) {
    const c = l.indexOf(';');
    if (c >= 0) l = l.slice(0, c);
    moves++;
    const zi = l.indexOf('Z');
    if (zi > 0) {
      const v = parseFloat(l.slice(zi + 1));
      if (Number.isFinite(v)) z = relative ? z + v : v;
    }
    const ei = l.indexOf('E');
    if (ei < 0) return;
    const v = parseFloat(l.slice(ei + 1));
    if (!Number.isFinite(v)) return;
    const abs = eMode ? eMode === 'abs' : !relative;
    const t = (tools[tool] ??= { pos: 0, max: 0 });
    t.pos += abs ? v - lastE : v;
    lastE = abs ? v : lastE + v; // a relative move also advances the position the next absolute move starts from
    if (t.pos <= t.max) return;
    feature.mm += t.pos - t.max;
    t.max = t.pos;
    if (l.indexOf('X') < 0 && l.indexOf('Y') < 0) return;
    if (!extruded) {
      extruded = true;
      nozzle = nozzleNow || null;
      bed = bedNow || null;
    }
    if (z !== printZ) {
      printZ = z;
      zLayers++;
      if (z > maxZ) maxZ = z;
    }
  }

  function comment(l) {
    const body = l.replace(/^;\s*/, '');
    if (!slicer) {
      const m =
        /^(BambuStudio|OrcaSlicer) (\d\S*)/.exec(body) ||
        /generated (?:by|with) (.+?) (?:version )?v?(\d[\w.+-]*)/i.exec(body) ||
        /^Sliced by (.+?) v?(\d[\w.+-]*)/i.exec(body);
      if (m) slicer = { name: SLICER_NAMES[m[1]] || m[1], version: m[2] };
    }
    if (body === 'LAYER_CHANGE' || body === 'CHANGE_LAYER') return void layerMarks++;
    const m = /^([\w .\[\]^()]+?)\s*[:=]\s*(.*)$/.exec(body);
    if (!m || m[1] === 'LAYER_HEIGHT') return; // Bambu's per-layer marker, not the layer_height setting
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'type' || key === 'feature') {
      typed = true;
      setFeature(value);
    } else if (key === 'layer') layerMarks++;
    else if (KEEP.has(key)) meta[key] = value;
  }

  function line(l) {
    let c = l.charCodeAt(0);
    if (c === 32 || c === 9) {
      l = l.trimStart();
      c = l.charCodeAt(0);
    }
    if (c === 59) return comment(l); // ;
    if (c === 71) { // G
      const c1 = l.charCodeAt(1);
      if (!isDigit(l.charCodeAt(2))) {
        if (c1 >= 48 && c1 <= 51) move(l); // G0-G3
        return;
      }
      const code = l.slice(1, 3);
      if (code === '90') relative = false;
      else if (code === '91') relative = true;
      else if (code === '92' && !isDigit(l.charCodeAt(3))) {
        const args = l.split(';')[0].slice(3);
        const e = /E\s*(-?[\d.]+)/.exec(args);
        if (e) lastE = parseFloat(e[1]);
        else if (!/[A-Z]/.test(args)) lastE = 0;
      } else if (c1 === 48) move(l); // G00-G03
      return;
    }
    if (c === 77) { // M
      const m = /^M(\d+)\b/.exec(l);
      if (!m) return;
      const code = +m[1];
      if (code === 82) eMode = 'abs';
      else if (code === 83) eMode = 'rel';
      else if (code === 600) pauses++;
      else if (code === 104 || code === 109 || code === 140 || code === 190) {
        const s = /S(\d+(?:\.\d+)?)/.exec(l.split(';')[0]);
        if (!s || !+s[1]) return;
        if (code < 110) nozzleNow = +s[1];
        else bedNow = +s[1];
      }
      return;
    }
    if (c === 84) { // T
      const m = /^T(\d+)\s*(?:;|$)/.exec(l);
      if (!m || +m[1] > 63) return; // Bambu uses T255 / T1000 / T65535 for other things
      if (+m[1] !== tool && extruded) toolChanges++;
      tool = +m[1];
    }
  }

  function push(text) {
    text = carry + text;
    let start = 0;
    for (let nl; (nl = text.indexOf('\n', start)) >= 0; start = nl + 1) {
      line(text.charCodeAt(nl - 1) === 13 ? text.slice(start, nl - 1) : text.slice(start, nl));
    }
    carry = text.slice(start);
  }

  function end() {
    if (carry) line(carry);
    carry = '';
    if (!moves) throw new GcodeError('no_moves');
    const warnings = [];

    // Time, as the slicer wrote it.
    let time = null;
    const bambu = meta['model printing time']; // "10h 39m 6s; total estimated time: 10h 46m 8s"
    const total = meta['total estimated time'] ?? /total estimated time\s*[:=]\s*(.*)/.exec(bambu || '')?.[1];
    if (total != null && parseDuration(total) != null) {
      time = { seconds: parseDuration(total), model: bambu ? parseDuration(bambu.split(';')[0]) : null };
    } else if (parseDuration(meta['estimated printing time (normal mode)'] || '') != null) {
      time = { seconds: parseDuration(meta['estimated printing time (normal mode)']), model: null };
    } else if (meta.time != null) {
      const header = first(meta.time);
      const elapsed = first(meta.time_elapsed); // CuraEngine writes the running total after every layer
      // 6666 is what CuraEngine leaves in ;TIME: when nothing fills in the header afterwards.
      if (header === 6666 || !header) {
        warnings.push({ code: 'time_placeholder', data: { value: header } });
        if (elapsed) time = { seconds: elapsed, model: null };
      } else time = { seconds: header, model: null };
    }
    if (!time) warnings.push({ code: 'no_time' });

    // Filament: header values per slot, next to what the E moves add up to.
    // Bambu's totals list only the slots in use: "; filament: 1,3" names them. Without that line the slots
    // are the extruders that pushed filament, when there are exactly as many of them as values.
    const ids = numbers(meta.filament).map((id) => id - 1);
    const used = tools.flatMap((t, i) => (t.max > 0 ? [i] : []));
    const perSlot = (list) => {
      const slots = ids.length === list.length ? ids : used.length === list.length ? used : null;
      const out = [];
      list.forEach((v, i) => (out[slots ? slots[i] : i] = v));
      return out;
    };
    const cura = /m\s*$/i.test(meta['filament used'] || '') ? numbers(meta['filament used']).map((m) => m * 1000) : [];
    const headMm = perSlot(numbers(meta['total filament length [mm]'] ?? meta['filament used [mm]']).concat(cura));
    // Bambu labels this line cm^3 but writes mm^3.
    const headCm3 = meta['total filament volume [cm^3]']
      ? perSlot(numbers(meta['total filament volume [cm^3]']).map((v) => v / 1000))
      : perSlot(numbers(meta['filament used [cm3]']));
    const headG = perSlot(numbers(meta['total filament weight [g]'] ?? meta['filament used [g]']));
    const density = numbers(meta.filament_density);
    const diameter = numbers(meta.filament_diameter);
    const type = strings(meta.filament_type);
    const colour = strings(meta.filament_colour);
    const cost = numbers(meta.filament_cost);
    const temps = numbers(meta.nozzle_temperature ?? meta.temperature);

    const filaments = [];
    const sum = { mm: 0, cm3: 0, g: 0, measuredMm: 0, headerMm: 0 };
    for (let i = 0; i < Math.max(tools.length, headMm.length, headG.length); i++) {
      const measuredMm = tools[i]?.max || 0;
      const ok = (v) => (v > 0 ? v : null);
      const header = { mm: ok(headMm[i]), cm3: ok(headCm3[i]), g: ok(headG[i]) };
      if (!measuredMm && !header.mm && !header.g) continue;
      const d = diameter[i] > 0 ? diameter[i] : 1.75;
      const rho = density[i] > 0 ? density[i] : null;
      const area = (Math.PI * d * d) / 4;
      const mm = header.mm ?? (header.cm3 ? (header.cm3 * 1000) / area : measuredMm);
      const cm3 = header.cm3 ?? (mm * area) / 1000;
      const g = header.g ?? (rho ? cm3 * rho : null);
      filaments.push({
        slot: i + 1,
        type: type[i] || null,
        colour: /^#[0-9a-f]{6,8}$/i.test(colour[i] || '') ? colour[i] : null,
        density: rho,
        diameter: d,
        costPerKg: cost[i] > 0 ? cost[i] : null,
        nozzleTemp: temps[i] > 0 ? temps[i] : null,
        mm,
        cm3,
        g,
        measuredMm,
        fromHeader: header.mm != null || header.g != null,
      });
      sum.mm += mm;
      sum.cm3 += cm3;
      sum.g = sum.g == null || g == null ? null : sum.g + g;
      sum.measuredMm += measuredMm;
      sum.headerMm += header.mm || 0;
    }

    const list = [...features.values()].filter((f) => f.mm > 0).sort((a, b) => b.mm - a.mm);
    for (const f of list) f.share = f.mm / sum.measuredMm;
    if (!typed) warnings.push({ code: 'no_features' });
    if (sum.g == null) warnings.push({ code: 'no_density' });

    // Cross-check. Slicers do not count the purge line of the start G-code, so the header may be anywhere
    // between "everything except start/end G-code" and "everything"; 5 % tolerance on both sides.
    const startEnd = (features.get('custom')?.mm || 0) + (typed ? features.get('unlabelled').mm : 0);
    const headerGiven = headMm.length > 0 || headG.length > 0;
    if (headerGiven && !sum.headerMm && !headG.some((v) => v > 0) && sum.measuredMm > 1) {
      warnings.push({ code: 'filament_placeholder' });
    } else if (sum.headerMm && (sum.headerMm < (sum.measuredMm - startEnd) * 0.95 || sum.headerMm > sum.measuredMm * 1.05)) {
      warnings.push({ code: 'mismatch', data: { header: sum.headerMm, measured: sum.measuredMm } });
    }

    const headerLayers = first(meta['total layer number'] ?? meta['total layers count'] ?? meta.layer_count);
    return {
      slicer,
      printer: meta.printer_model || meta['target_machine.name'] || null,
      time,
      layers: headerLayers || layerMarks || zLayers,
      layersFrom: headerLayers ? 'header' : layerMarks ? 'markers' : 'z',
      layerHeight: first(meta.layer_height ?? meta['layer height']),
      maxZ,
      nozzleTemp: filaments.find((f) => f.nozzleTemp)?.nozzleTemp ?? nozzle,
      bedTemp: bed,
      filamentChanges: toolChanges + pauses,
      filaments,
      total: { mm: sum.mm, cm3: sum.cm3, g: sum.g, measuredMm: sum.measuredMm, fromHeader: filaments.some((f) => f.fromHeader) },
      features: list,
      warnings,
      moves,
    };
  }

  return { push, end };
}

const CHUNK = 1 << 20;

/** Scan one G-code given as chunks of bytes (async iterable or array of Uint8Array). */
async function scan(chunks) {
  const scanner = createScanner();
  const decoder = new TextDecoder();
  let checked = false;
  for await (const bytes of chunks) {
    if (!checked) {
      checked = true;
      const head = bytes.subarray(0, 4096);
      if (head[0] === 71 && head[1] === 67 && head[2] === 68 && head[3] === 69) throw new GcodeError('bgcode'); // "GCDE"
      if (head.includes(0)) throw new GcodeError('not_text');
    }
    scanner.push(decoder.decode(bytes, { stream: true }));
  }
  scanner.push(decoder.decode());
  return scanner.end();
}

/** What Bambu/Orca wrote in Metadata/slice_info.config, per plate index. */
export function parseSliceInfo(xml) {
  const attr = (tag, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
  const plates = {};
  for (const [, body] of xml.matchAll(/<plate>([\s\S]*?)<\/plate>/g)) {
    const meta = {};
    for (const [tag] of body.matchAll(/<metadata [^>]*>/g)) meta[attr(tag, 'key')] = attr(tag, 'value');
    plates[meta.index] = {
      seconds: first(meta.prediction),
      g: first(meta.weight),
      filaments: [...body.matchAll(/<filament [^>]*>/g)].map(([tag]) => ({
        slot: +attr(tag, 'id'),
        type: attr(tag, 'type') || null,
        colour: attr(tag, 'color') || null,
        mm: first(attr(tag, 'used_m')) * 1000,
        g: first(attr(tag, 'used_g')),
      })),
    };
  }
  return plates;
}

/**
 * Analyse a .gcode text file or a .gcode.3mf. The kind is decided by the content, not the file name.
 * @param {Blob} file
 * @param {{onProgress?: (fraction: number) => void}} [options]
 * @returns {Promise<object[]>} one result per plate (a plain .gcode gives one, with plate: null);
 *   each is what createScanner().end() returns plus { plate, sliceInfo }.
 * @throws {GcodeError} or the 'bad_zip' error of zip.js
 */
export async function analyzeGcode(file, { onProgress = () => {} } = {}) {
  const magic = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (magic[0] !== 0x50 || magic[1] !== 0x4b) {
    let done = 0;
    const reader = file.stream().getReader();
    const chunks = (async function* () {
      for (;;) {
        const { value, done: finished } = await reader.read();
        if (finished) return;
        done += value.length;
        onProgress(done / file.size);
        yield value;
      }
    })();
    try {
      return [{ plate: null, sliceInfo: null, ...(await scan(chunks)) }];
    } finally {
      reader.cancel().catch(() => {});
    }
  }

  const zip = readZip(await file.arrayBuffer());
  const names = zip.names
    .map((name) => ({ name, plate: +/^Metadata\/plate_(\d+)\.gcode$/.exec(name)?.[1] }))
    .filter((e) => e.plate)
    .sort((a, b) => a.plate - b.plate);
  if (!names.length) throw new GcodeError('no_plate');
  const config = await zip.read('Metadata/slice_info.config');
  const info = config ? parseSliceInfo(new TextDecoder().decode(config)) : {};
  const results = [];
  for (const [i, { name, plate }] of names.entries()) {
    const bytes = await zip.read(name);
    const chunks = (function* () {
      for (let o = 0; o < bytes.length; o += CHUNK) {
        onProgress((i + o / bytes.length) / names.length);
        yield bytes.subarray(o, o + CHUNK);
      }
    })();
    results.push({ plate, sliceInfo: info[plate] || null, ...(await scan(chunks)) });
  }
  return results;
}
