// Cross-page checks over the BUILT site (run `python src/build.py` first). Regex parsing is enough here:
// the build emits regular, attribute-quoted HTML.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://yeseul100512.github.io/3D-website/';
const LANGS = { '': 'ko', en: 'en', ja: 'ja', zh: 'zh-Hans' };
const HREFLANGS = ['en', 'ja', 'ko', 'x-default', 'zh-Hans'];

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel)) && fs.statSync(path.join(ROOT, rel)).isFile();
function walk(dir, keep, out = []) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) walk(rel, keep, out);
    else if (keep(e.name)) out.push(rel);
  }
  return out;
}
// "en/tools/x/index.html" -> "en/tools/x/"
const urlPath = (file) => file.replace(/index\.html$/, '');
const fileOf = (url) => (url.endsWith('/') || url === '' ? url + 'index.html' : url);

const files = ['index.html', ...['tools', 'en', 'ja', 'zh'].flatMap((d) => walk(d, (n) => n === 'index.html'))];
const pages = files.map((file) => {
  const html = read(file);
  const all = (re) => [...html.matchAll(re)].map((m) => m[1]);
  return {
    file,
    html,
    lang: LANGS[file.split('/')[0]] ?? 'ko',
    title: all(/<title>([^<]*)<\/title>/g),
    description: all(/<meta name="description" content="([^"]*)">/g),
    canonical: all(/<link rel="canonical" href="([^"]*)">/g),
    alternates: Object.fromEntries([...html.matchAll(/<link rel="alternate" hreflang="([^"]*)" href="([^"]*)">/g)].map((m) => [m[1], m[2]])),
  };
});
const byUrl = new Map(pages.map((p) => [BASE + urlPath(p.file), p]));

test('the site has every expected page', () => {
  assert.equal(pages.length, 24);
});

test('every page: one h1, lang, title, description, canonical', () => {
  for (const p of pages) {
    assert.equal((p.html.match(/<h1[\s>]/g) || []).length, 1, `${p.file}: exactly one h1`);
    assert.equal((p.html.match(/<main[\s>]/g) || []).length, 1, `${p.file}: one main`);
    assert.ok(p.html.includes(`<html lang="${p.lang}">`), `${p.file}: html lang ${p.lang}`);
    assert.equal(p.title.length, 1, `${p.file}: one title`);
    assert.ok(p.title[0].endsWith(' | BENCH') && p.title[0].length > 10, `${p.file}: title ends with the site name`);
    assert.equal(p.description.length, 1, `${p.file}: one description`);
    assert.ok(p.description[0].length >= 50, `${p.file}: description is a real sentence`);
    assert.deepEqual(p.canonical, [BASE + urlPath(p.file)], `${p.file}: canonical is its own URL`);
    assert.ok(!/\{\{|\}\}|\bundefined\b/.test(p.html.replace(/<script[\s\S]*?<\/script>/g, '')), `${p.file}: no template leftovers`);
  }
  for (const key of ['title', 'description']) {
    const seen = new Map();
    for (const p of pages) {
      assert.ok(!seen.has(p[key][0]), `${key} of ${p.file} repeats ${seen.get(p[key][0])}`);
      seen.set(p[key][0], p.file);
    }
  }
});

test('hreflang: five links, existing targets, reciprocal, x-default is English', () => {
  for (const p of pages) {
    assert.deepEqual(Object.keys(p.alternates).sort(), HREFLANGS, p.file);
    assert.equal(p.alternates[p.lang], p.canonical[0], `${p.file}: links to itself`);
    assert.equal(p.alternates['x-default'], p.alternates.en, p.file);
    for (const [lang, url] of Object.entries(p.alternates)) {
      const target = byUrl.get(url);
      assert.ok(target, `${p.file}: hreflang ${lang} -> ${url} is not a page`);
      assert.deepEqual(target.alternates, p.alternates, `${p.file} <-> ${target.file} are not reciprocal`);
      if (lang !== 'x-default') assert.equal(target.lang, lang, `${p.file}: hreflang ${lang} points at a ${target.lang} page`);
    }
  }
});

test('every internal href/src resolves to a file; the language switcher links the same page', () => {
  for (const p of [...pages, { file: '404.html', html: read('404.html') }]) {
    const dir = path.posix.dirname(p.file);
    const body = p.html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, '');
    for (const [, url] of body.matchAll(/\s(?:href|src)="([^"]*)"/g)) {
      if (/^(https?:|mailto:|data:|#)/.test(url)) {
        // absolute links to this site (canonical, alternates, og:url) must exist too
        if (url.startsWith(BASE)) assert.ok(exists(fileOf(url.slice(BASE.length).split('#')[0])), `${p.file}: ${url}`);
        continue;
      }
      // 404.html is served at any depth, so it must use root-absolute paths
      const clean = url.split('#')[0].split('?')[0];
      const rel = url.startsWith('/') ? clean.replace(/^\/3D-website\//, '') : path.posix.normalize(path.posix.join(dir, clean));
      assert.ok(!rel.startsWith('..'), `${p.file}: ${url} leaves the site`);
      assert.ok(exists(fileOf(rel === '.' ? '' : rel)), `${p.file}: ${url} -> ${rel} does not exist`);
    }
    if (!p.lang) continue;
    const nav = p.html.match(/<nav class="langs"[\s\S]*?<\/nav>/)[0];
    const links = [...nav.matchAll(/<a href="([^"]*)" lang="([^"]*)"/g)];
    assert.equal(links.length, 4, `${p.file}: four language links`);
    for (const [, href, lang] of links) {
      const target = path.posix.normalize(path.posix.join(dir, href, 'index.html'));
      assert.equal(BASE + urlPath(target === 'index.html' ? '' : target), p.alternates[lang], `${p.file}: switcher ${lang}`);
    }
  }
});

test('sitemap lists exactly the pages, with alternates; robots points at it', () => {
  const xml = read('sitemap.xml');
  const urls = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((m) => m[1]);
  const locs = urls.map((u) => u.match(/<loc>([^<]*)<\/loc>/)[1]);
  assert.deepEqual([...locs].sort(), [...byUrl.keys()].sort());
  for (const u of urls) {
    assert.match(u, /<lastmod>\d{4}-\d\d-\d\d<\/lastmod>/);
    const alts = Object.fromEntries([...u.matchAll(/<xhtml:link rel="alternate" hreflang="([^"]*)" href="([^"]*)"\/>/g)].map((m) => [m[1], m[2]]));
    assert.deepEqual(alts, byUrl.get(u.match(/<loc>([^<]*)<\/loc>/)[1]).alternates);
  }
  assert.ok(read('robots.txt').includes(`Sitemap: ${BASE}sitemap.xml`));
});

test('no Korean in en/ja/zh pages outside the language switcher, no kana in en/zh', () => {
  for (const p of pages) {
    if (p.lang === 'ko') continue;
    const text = p.html.replace(/<nav class="langs"[\s\S]*?<\/nav>/, '');
    const hangul = text.match(/[ᄀ-ᇿ㄰-㆏가-힯]+/);
    assert.ok(!hangul, `${p.file}: Korean text "${hangul}"`);
    if (p.lang !== 'ja') {
      const kana = text.match(/[぀-ヺー-ヿ]+/); // U+30FB (middle dot) is also used in Chinese
      assert.ok(!kana, `${p.file}: Japanese text "${kana}"`);
    }
  }
});

test('every form control has a label', () => {
  for (const p of pages) {
    const html = p.html.replace(/<script[\s\S]*?<\/script>/g, '');
    const labelled = new Set([...html.matchAll(/<label[^>]*\sfor="([^"]*)"/g)].map((m) => m[1]));
    for (const m of html.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
      if (/type="hidden"/.test(m[2])) continue;
      const id = (m[2].match(/\sid="([^"]*)"/) || [])[1];
      const before = html.slice(0, m.index);
      const wrapped = before.lastIndexOf('<label') > before.lastIndexOf('</label>');
      assert.ok(wrapped || labelled.has(id), `${p.file}: <${m[1]}${m[2]}> has no <label>`);
    }
  }
});

test('JSON-LD parses and describes the page', () => {
  for (const p of pages) {
    const blocks = [...p.html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    assert.equal(blocks.length, 1, p.file);
    const graph = JSON.parse(blocks[0][1])['@graph'];
    const tool = p.file.includes('tools/');
    assert.ok(graph.some((g) => g['@type'] === (tool ? 'WebApplication' : 'WebSite') && g.url === p.canonical[0]), `${p.file}: main entity`);
    const faqs = (p.html.match(/<details/g) || []).length;
    const faq = graph.find((g) => g['@type'] === 'FAQPage');
    if (tool && faq) assert.ok(faq.mainEntity.length > 0 && faq.mainEntity.length <= faqs, `${p.file}: FAQ entries are on the page`);
  }
});

test('nothing forbidden is referenced; CDN imports are pinned jsDelivr URLs', () => {
  const shipped = [...files, '404.html', ...walk('assets', (n) => /\.(js|css|svg)$/.test(n))];
  for (const f of shipped) {
    const s = read(f);
    assert.ok(!/fonts\.(googleapis|gstatic)|unpkg|phosphor|@font-face|google-analytics|googletagmanager|gtag\(/i.test(s), `${f}: forbidden reference`);
    assert.ok(!/claude|anthropic/i.test(s), `${f}: forbidden name`);
    for (const [url] of s.matchAll(/https?:\/\/[^\s'"`)<]+/g)) {
      if (!/\.(js|css)$/.test(f) || /^https?:\/\/(www\.w3\.org|schemas\.|yeseul100512\.github\.io)/.test(url)) continue;
      assert.match(url, /^https:\/\/cdn\.jsdelivr\.net\/npm\/[a-z0-9-]+@\d+\.\d+\.\d+\//, `${f}: ${url}`);
    }
  }
});

test('window.T: no control characters, and the same {placeholders} as the English page', () => {
  const strings = (p) => JSON.parse(/<script>window\.T=(.*?)<\/script>/s.exec(p.html)?.[1].replaceAll('<\\/', '</') ?? '{}');
  const names = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
  for (const p of pages) {
    const mine = strings(p);
    const en = strings(byUrl.get(p.alternates.en));
    for (const [key, text] of Object.entries(mine)) {
      assert.ok(!/[\x00-\x08\x0b-\x1f]/.test(text), `${p.file}: ${key} holds a control character`);
      assert.equal(names(text), names(en[key]), `${p.file}: ${key}`);
    }
  }
});
