# Build contract

Everything under `src/` is source. `python src/build.py` (Python 3.9+, standard library only) writes the
whole site into the repo root, which GitHub Pages serves as-is. **Never edit generated files**
(`index.html`, `404.html`, `sitemap.xml`, `robots.txt`, and everything in `assets/`, `tools/`, `en/`, `ja/`, `zh/`):
those five folders are deleted and rebuilt on every run.

```
python src/build.py      # build; exits 1 and lists every problem if something is missing
node --test tests/       # unit tests (Node 22+; test files must be named tests/*.test.mjs)
python -m http.server 8765 --bind 127.0.0.1    # then open http://127.0.0.1:8765/
```

## Layout

```
src/build.py                 the generator (BASE url, LANGS, TOOLS list)
src/site.json                strings shared by every page (headings, privacy note, shared js_* messages)
src/layout/base.html         <head>, header, language switcher, footer
src/layout/tool.html         tool page shell: h1, intro, tool UI, text sections, other tools, privacy note
src/hub/page.html, i18n.json the hub
src/assets/site.css          the one stylesheet            -> assets/site.css
src/assets/lib/*.js          shared ES modules             -> assets/lib/*.js
src/tools/<slug>/page.html   the tool's UI markup (required)
src/tools/<slug>/i18n.json   every string of the tool (required)
src/tools/<slug>/main.js     entry script (optional)       -> assets/tools/<slug>/main.js
src/tools/<slug>/*           any other file (worker.js …)  -> assets/tools/<slug>/
tests/*.test.mjs             node:test files
```

Output URLs: Korean at `/`, others at `/en/`, `/ja/`, `/zh/`; a tool is at `<lang>/tools/<slug>/`.
To add a tool, create the folder and add its slug to `TOOLS` in `build.py` (the order is the hub order).
A tool owner changes only `src/tools/<slug>/` and `tests/<slug>*.test.mjs`. Need a new shared string or CSS
class? Prefer keeping it in your own folder; shared files have other users.

## i18n.json

Flat object, one entry per key:

```json
{
  "title": { "ko": "…", "en": "…", "ja": "…", "zh": "…" },
  "formats": "STL · 3MF",
  "limit_2": { "ko": "<a href=\"…\">…</a>", "en": "…", "ja": "…", "zh": "…", "html": true }
}
```

- All four languages are required and must be non-empty, or the build fails. A plain string means
  "identical in every language" (file extensions, product names).
- The `{name}` placeholders of a string must be the same in all four languages, and a string must not
  contain control characters; the build fails on either.
- Text is HTML-escaped when inserted. Add `"html": true` to an entry to insert it as raw HTML
  (you are then responsible for escaping). JSON-LD gets the text with tags stripped.
- Tool keys override `site.json` keys of the same name.

Required keys:

| key | used for |
| --- | --- |
| `title` | `<title>` (the build appends ` \| BENCH`; must be unique per language) |
| `description` | meta description, Open Graph, JSON-LD |
| `h1`, `intro` | page heading and the paragraph under it |
| `name`, `card`, `formats` | hub card and "other tools" links: short name, one sentence, input formats |
| `what_1`, `what_2`, … | "What this tool does" paragraphs |
| `how_1`, `how_2`, … | "How to use it" numbered steps |
| `limit_1`, `limit_2`, … | "Limits and caveats" bullet list (be honest) |
| `faq_1_q` + `faq_1_a`, … | optional FAQ (`<details>` on the page and `FAQPage` JSON-LD) |

Numbered keys must be consecutive from 1. Any other key is yours: use it in `page.html` as `{{key}}`.
Keys that start with `js_` are also given to your script (next section).

## page.html

Only the markup of the tool UI: no `<html>`, `<head>`, `<h1>`, no text sections. Placeholders:

- `{{key}}`: a string from your `i18n.json` or from `site.json`, in the page's language.
- `{{root}}`: relative path to the site root (`../../` or `../../../`). All URLs must be relative so the
  site works both at `/` locally and under `/3D-website/`. An unknown placeholder fails the build.

The shell adds the header, `<main>`, the single `<h1>`, intro, a `<noscript>` notice, the text sections,
links to the other tools and the "files never leave your browser" line.

## Scripts, window.T, workers

- If `main.js` exists, the page loads it with `<script type="module" src="…/assets/tools/<slug>/main.js">`.
  Nothing else to declare. Import your other files relatively (`./math.js`).
- Before it, the build injects `window.T = { lang: "ko" | "en" | "ja" | "zh-Hans", js_…: "…" }` with every
  `js_*` key of `site.json` and of your `i18n.json`, in the page's language. One script serves all four
  languages: never hard-code user-facing text in JS. Substitute values with `fmt(T.js_x, { n: 3 })`
  (placeholders in strings look like `{n}`).
- Shared libs: `import { … } from '../../lib/mesh-io.js'` (that is the path in the built site:
  `assets/tools/<slug>/` -> `assets/lib/`).
- Worker: `new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })`. The worker may import
  the shared libs the same way. Workers have no `window.T`: post data back and build messages on the page.
  Errors lose custom fields when posted, so send `{ code, data, message }` (see the example).
- Third-party code only when truly needed, lazy-loaded with an exact version, e.g.
  `await import('https://cdn.jsdelivr.net/npm/three@0.182.0/+esm')`.
- Unit tests: a module with no DOM at top level can be tested from `tests/<slug>.test.mjs`. Import it from
  the **built** copy (`../assets/tools/<slug>/x.js`, so its `../../lib/` imports resolve) and run the build first.

Shared `js_*` strings already in `site.json`: `js_err_empty`, `js_err_wrong_type`, `js_err_not_mesh`,
`js_err_truncated`, `js_err_truncated_unknown`, `js_err_too_large`, `js_err_no_triangles`, `js_err_unknown`
(`{name}`, `{detail}`), `js_load_partial` (button label), `js_bad_triangles` (`{n}`), `js_reading`
(`{name}`, `{percent}`), `js_working`, `js_num_required`, `js_num_invalid`, `js_num_min`, `js_num_max`,
`js_unit_h`, `js_unit_m`, `js_unit_s`.

## Shared libs (`src/assets/lib/`)

All are plain ES modules without DOM access at import time; they run in a window, a Worker and Node.

**mesh-io.js**
- `await parseMesh(input, { name, allowTruncated, onProgress })`: `input` is a `File`/`Blob` (preferred: a
  binary STL is then read in 50 MB slices), `ArrayBuffer` or `Uint8Array`. Detects binary STL, ASCII STL, OBJ
  and 3MF from the content. Returns `{ format, triangles, count, objects, bad, truncated, unit }`:
  `triangles` is a `Float32Array` with 9 floats per triangle, always in millimetres, and `triangles.buffer`
  holds exactly that data (safe to transfer); `objects` is `[{ name, start, count }]` in triangles;
  `bad` counts triangles with NaN/Infinity coordinates or invalid indices, which are left out (tell the user:
  `js_bad_triangles`); `truncated` is `null` or `{ declared, present }`.
- Throws `MeshError` with `.code` and `.data`: `empty`, `not_mesh`, `truncated` (`{ declared, present }`;
  call again with `allowTruncated: true` to load the intact part), `too_large`, `no_triangles`.
- `bounds(triangles)` -> `{ min: [x,y,z], max: [x,y,z] }`. `weld(triangles)` -> `{ vertices, indices }`
  (exact-match vertex merge). `writeSTL(triangles)`, `writeOBJ(triangles)`, `write3MF(triangles, objects?)`
  -> `Blob`.

**zip.js**: `zipStore([{ name, data }], type?)` -> `Blob` (`data`: string, `Uint8Array` or an array of them;
no compression). `readZip(buffer)` -> `{ names, size(name), read(name) }` (`await read()` gives a
`Uint8Array`, or `null` if absent; stored and deflated entries). Throws an `Error` with `code: 'bad_zip'`.
No ZIP64.

**xlsx.js**: `writeXLSX(rows, sheetName?)` -> `Blob` (one sheet; cells are strings or numbers; NaN and
null become empty cells). `toCSV(rows)` -> string with a UTF-8 BOM.

**ui.js**
- `dropzone(zoneEl, onFiles, onError)`: wires a `<label class="dropzone">` that contains an
  `<input type="file">`. Click and keyboard are native; this adds drag-and-drop, enforces the input's
  `accept` extensions and `multiple`, and rejects 0-byte files. `onError` receives a translated message.
- `notice(el, 'info' | 'warn' | 'error', text)`: shows text (never HTML) in an element; empty text hides it.
- `errorText(err, fileName)`: translated message for a `MeshError`, a zip error or anything else thrown.
- `readNumber(inputEl)`: validates an `<input type="number">` against its own `min` / `max` / `required`,
  shows the translated message under it, returns the number or `null`. `checkNumber(raw, rule)` is the
  DOM-free core.
- `download(blobOrText, filename, type?)`, `esc(text)`, `fmt(template, vars)`,
  `num(n, digits = 2)` / `bytes(n)` / `duration(seconds)`: these three print `–` instead of NaN/Infinity.

## CSS classes (`assets/site.css`)

| class | use |
| --- | --- |
| `tool-grid` > `viewer` + `controls` | tool with a 3D view: viewer on top on phones, side by side from 900 px. Without a viewer just stack `panel`s. |
| `viewer` | the 3D area (4:3 on phones, 520 px tall on desktop). Put a `<canvas>` in it; with three.js call `renderer.setSize(w, h, false)` so the CSS keeps control of the size. |
| `panel` | a card; children are spaced automatically. `panel` + `panel` get a gap. |
| `field` | `<div class="field"><label for="x">…</label><input id="x" …><small>hint</small></div>`; `fields` wraps several in a responsive row. Every input needs a real `<label>`. |
| `check` | `<label class="check"><input type="checkbox"> text</label>` |
| `button`, `button secondary` | on `<button>` or `<a>` |
| `dropzone` | `<label class="dropzone" id="drop"><input type="file" accept=".stl,.3mf"><strong>title</strong><span>hint</span></label>` |
| `notice`, `notice warn`, `notice error` | messages; start with `hidden` and use `notice()` |
| `result` | result `<table>` (`<caption>`, `<th scope="row">`, `class="num"` right-aligns). Wrap wide tables in `<div class="table-scroll">`. |
| `cards` / `card`, `lead`, `privacy`, `doc`, `visually-hidden` | used by the layout |

`[hidden]` always wins (`display: none !important`). Colour tokens are at the top of `site.css`; for text use
only `--text`, `--muted`, `--link`, `--danger`, `--warn`, `--ok` (each is at least 4.5:1 on `--bg` and
`--surface`). Controls are at least 44 px tall; keep that for anything you add.

## Worked example

`src/tools/stl-inspector/` is a complete, small example (it is the placeholder its owner will replace):
drop a file -> parse in a module Worker with progress text -> fill a result table, or show a translated
error; a cut-off STL offers "load the intact part"; results of the previous file are hidden first.

`i18n.json` (required keys omitted here):
```json
{
  "drop_title": { "ko": "STL 파일을 끌어다 놓거나 눌러서 선택해 주세요", "en": "Drop an STL file here, or click to choose", "ja": "…", "zh": "…" },
  "row_count": { "ko": "삼각형 수", "en": "Triangles", "ja": "…", "zh": "…" }
}
```

`page.html`:
```html
<div class="panel">
<label class="dropzone" id="drop">
<input type="file" id="file" accept=".stl,.3mf,.obj">
<strong>{{drop_title}}</strong>
</label>
<p class="notice" id="msg" hidden></p>
<table class="result" id="result" hidden>
<tbody><tr><th scope="row">{{row_count}}</th><td id="r-count"></td></tr></tbody>
</table>
</div>
```

`main.js`:
```js
import { dropzone, notice, errorText, fmt, num } from '../../lib/ui.js';
const T = window.T;
const $ = (id) => document.getElementById(id);
let worker;

dropzone($('drop'), ([file]) => {
  worker?.terminate();                      // a new file cancels the previous job
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  $('result').hidden = true;                // no stale numbers
  notice($('msg'), 'info', fmt(T.js_reading, { name: file.name, percent: 0 }));
  worker.onerror = (e) => notice($('msg'), 'error', errorText(e, file.name));
  worker.onmessage = ({ data }) => {
    if (data.progress != null) return notice($('msg'), 'info', fmt(T.js_reading, { name: file.name, percent: Math.round(data.progress * 100) }));
    if (data.error) return notice($('msg'), 'error', errorText(data.error, file.name));
    notice($('msg'), 'info', '');
    $('r-count').textContent = num(data.count, 0);
    $('result').hidden = false;
  };
  worker.postMessage({ file });
}, (message) => { $('result').hidden = true; notice($('msg'), 'error', message); });
```

`worker.js`:
```js
import { parseMesh } from '../../lib/mesh-io.js';
onmessage = async ({ data: { file } }) => {
  try {
    const mesh = await parseMesh(file, { name: file.name, onProgress: (progress) => postMessage({ progress }) });
    postMessage({ count: mesh.count });
  } catch (e) {
    postMessage({ error: { code: e.code, data: e.data, message: e.message } });
  }
};
```

## What the build checks

Missing language for any key, missing required key, `faq_N_q` without `faq_N_a`, unknown `{{placeholder}}`,
empty title/description, duplicate `<title>` within a language. Translation problems are reported before
anything is deleted, so a failed build leaves the previous output in place.

Every page gets: `<html lang>`, title ending in the site name, meta description, canonical, hreflang for
ko / en / ja / zh-Hans + x-default (-> `/en/`), Open Graph, JSON-LD (`WebApplication` + `FAQPage` for tools,
`WebSite` + `ItemList` for the hub), favicon, header with language links to the same page, and the text
sections in static HTML.
