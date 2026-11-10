import { recommend } from './rules.js';
import { fmt, notice } from '../../lib/ui.js';

const T = window.T;
const $ = (id) => document.getElementById(id);
const form = $('q');
let text = '';

const range = ({ lo, hi }, unit = '') => (lo === hi ? `${lo}${unit}` : `${lo}–${hi}${unit}`);
// "25–40% · start at 25%"; a single value needs no starting point
const value = (r, unit = '') => (r.lo === r.hi ? range(r, unit) : `${range(r, unit)} · ${fmt(T.js_start, { v: r.start + unit })}`);

function list(ul, prefix, keys) {
  ul.replaceChildren(...keys.map((k) => Object.assign(document.createElement('li'), { textContent: T[prefix + k] })));
  return keys.map((k) => `- ${T[prefix + k]}`);
}

function render() {
  const a = Object.fromEntries(['use', 'load', 'material', 'priority', 'size'].map((k) => [k, form.elements[k].value]));
  const r = recommend({ ...a, topQuality: $('topq').checked });
  const cells = [
    [T['js_p_' + r.pattern], T['js_why_' + r.pattern]],
    [value(r.density, '%'), T.js_r_density],
    [value(r.walls), a.priority === 'strength' ? T.js_r_walls_strength : T.js_r_walls],
    [value(r.top), r.top.extra ? T.js_r_top_extra : T.js_r_top],
    [value(r.bottom), T.js_r_bottom],
    r.topPattern ? [T.js_monotonic, T.js_r_monotonic] : [T.js_default, T.js_r_default],
  ];
  const lines = [T.js_copy_title, ''];
  for (const el of form.querySelectorAll('select')) lines.push(`${el.labels[0].textContent}: ${el.selectedOptions[0].textContent}`);
  if ($('topq').checked) lines.push($('topq').labels[0].textContent.trim());
  lines.push('');
  [...$('rows').rows].forEach((row, i) => {
    const [val, why] = cells[i];
    const strong = Object.assign(document.createElement('strong'), { textContent: val });
    const small = Object.assign(document.createElement('small'), { textContent: why });
    small.style.cssText = 'display:block;color:var(--muted)';
    row.cells[1].replaceChildren(strong, small);
    lines.push(`${row.cells[0].textContent}: ${val}`, `  ${why}`);
  });
  const alt = fmt(T.js_alt, { name: T['js_p_' + r.alt], why: T['js_why_' + r.alt] });
  $('alt').textContent = alt;
  lines.push($('path').textContent, '', alt);
  $('notes-box').hidden = !r.notes.length;
  const notes = list($('notes'), 'js_n_', r.notes);
  if (notes.length) lines.push('', $('notes-box').firstChild.textContent, ...notes);
  lines.push('', $('fixes').previousElementSibling.textContent, ...list($('fixes'), 'js_f_', r.fixes));
  text = lines.join('\n');
  notice($('msg'), 'info', '');
  $('out').hidden = false;
}

form.addEventListener('change', render);
form.addEventListener('submit', (e) => e.preventDefault());
$('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(text);
    notice($('msg'), 'info', T.js_copied);
  } catch {
    notice($('msg'), 'error', T.js_copy_failed);
  }
});
render();
