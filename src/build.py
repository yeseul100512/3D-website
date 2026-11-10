#!/usr/bin/env python3
"""Build the whole static site into the repo root. Standard library only.

    python src/build.py

The contract for tool authors is in src/README.md. Exits 1 with a list of
problems when a translation is missing, has other {placeholders} than its
siblings or holds a control character, a {{placeholder}} is unknown, or a page
has no title/description. Never edit the generated files by hand.
"""
import datetime
import html
import json
import re
import shutil
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parent
ROOT = SRC.parent
BASE = 'https://yeseul100512.github.io/3D-website/'
# code: (url prefix, <html lang> / hreflang, og:locale, name in the language switcher)
LANGS = {
    'ko': ('', 'ko', 'ko_KR', '한국어'),
    'en': ('en/', 'en', 'en_US', 'English'),
    'ja': ('ja/', 'ja', 'ja_JP', '日本語'),
    'zh': ('zh/', 'zh-Hans', 'zh_CN', '简体中文'),
}
X_DEFAULT = 'en'
# Tools in hub order. To add a tool: create src/tools/<slug>/ and add the slug here.
TOOLS = ['stl-inspector', 'stl-cutter', 'print-cost-calculator', 'gcode-analyzer', 'infill-recommender']
TOOL_KEYS = ['title', 'description', 'h1', 'intro', 'name', 'card', 'formats', 'what_1', 'how_1', 'limit_1']
HUB_KEYS = ['title', 'description', 'h1', 'intro']
GENERATED = ['assets', 'tools', 'en', 'ja', 'zh']  # deleted and rebuilt on every run

errors = []
esc = lambda s: html.escape(s, quote=True)


def fail():
    problems = list(dict.fromkeys(errors))
    print(f'BUILD FAILED: {len(problems)} problem(s)', file=sys.stderr)
    for e in problems:
        print('  - ' + e, file=sys.stderr)
    sys.exit(1)


def load(path, required=()):
    """i18n file -> {key: {ko, en, ja, zh, html?}}. A plain string means "same in every language"."""
    where = path.relative_to(ROOT).as_posix()
    try:
        data = json.loads(path.read_text('utf-8'))
    except (OSError, ValueError) as e:
        errors.append(f'{where}: cannot read ({e})')
        return {}
    for key, value in data.items():
        if isinstance(value, str):
            data[key] = value = {lang: value for lang in LANGS}
        missing = [lang for lang in LANGS if not str(value.get(lang, '')).strip()]
        if missing:
            errors.append(f'{where}: "{key}" has no text for: {", ".join(missing)}')
            continue
        texts = [str(value[lang]) for lang in LANGS]
        if len({frozenset(re.findall(r'\{(\w+)\}', t)) for t in texts}) > 1:
            errors.append(f'{where}: "{key}" does not have the same {{placeholders}} in every language')
        if any(ord(c) < 32 and c not in '\n\t' for t in texts for c in t):
            errors.append(f'{where}: "{key}" contains a control character')
    errors.extend(f'{where}: required key "{key}" is missing' for key in required if key not in data)
    return data


def text(strings, key, lang):
    """Translated string as HTML (escaped unless the entry says "html": true)."""
    entry = strings.get(key, {})
    value = str(entry.get(lang, ''))
    return value if entry.get('html') else esc(value)


def plain(strings, key, lang):
    """Translated string as plain text (tags removed), for JSON-LD."""
    entry = strings.get(key, {})
    value = str(entry.get(lang, ''))
    return html.unescape(re.sub(r'<[^>]+>', '', value)) if entry.get('html') else value


def render(template, strings, lang, extra, where):
    def one(m):
        key = m.group(1)
        if key in extra:
            return extra[key]
        if key in strings:
            return text(strings, key, lang)
        errors.append(f'{where}: unknown placeholder {{{{{key}}}}}')
        return ''
    return re.sub(r'\{\{\s*([\w.-]+)\s*\}\}', one, template)


def numbered(strings, prefix, suffix=''):
    """Keys prefix_1, prefix_2, ... (with an optional suffix) for as long as they exist."""
    keys = []
    while f'{prefix}_{len(keys) + 1}{suffix}' in strings:
        keys.append(f'{prefix}_{len(keys) + 1}{suffix}')
    return keys


def script_json(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/')


def write(rel, content):
    out = ROOT / rel
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(content, 'utf-8', newline='\n')


def cards(tools, lang, root, heading, skip=None):
    items = []
    for slug, s in tools.items():
        if slug == skip:
            continue
        items.append(
            f'<li><a class="card" href="{root}{LANGS[lang][0]}tools/{slug}/">'
            f'<{heading}>{text(s, "name", lang)}</{heading}>'
            f'<p>{text(s, "card", lang)}</p>'
            f'<p class="formats">{text(s, "formats_label", lang)} · {text(s, "formats", lang)}</p></a></li>')
    return '\n'.join(items)


def page(layout, strings, lang, path, body, ld, scripts=''):
    """Wrap a body in the shared shell and return the finished HTML. path: '' (hub) or 'tools/<slug>/'."""
    prefix, tag, locale, _ = LANGS[lang]
    root = '../' * (prefix + path).count('/') or './'
    url = lambda l: BASE + LANGS[l][0] + path
    title = f'{plain(strings, "title", lang)} | {plain(strings, "site_name", lang)}'
    description = plain(strings, 'description', lang)
    if not plain(strings, 'title', lang).strip() or not description.strip():
        errors.append(f'{prefix}{path}: page has no title or description')
    alternates = ''.join(f'<link rel="alternate" hreflang="{LANGS[l][1]}" href="{url(l)}">\n' for l in LANGS)
    alternates += f'<link rel="alternate" hreflang="x-default" href="{url(X_DEFAULT)}">'
    og = ''.join(f'<meta property="og:{k}" content="{esc(v)}">\n' for k, v in [
        ('type', 'website'), ('site_name', plain(strings, 'site_name', lang)), ('title', title),
        ('description', description), ('url', url(lang)), ('locale', locale)]).strip()
    switch = '\n'.join(
        f'<a href="{root}{LANGS[l][0]}{path}" lang="{LANGS[l][1]}" hreflang="{LANGS[l][1]}"'
        + (' aria-current="page"' if l == lang else '') + f'>{LANGS[l][3]}</a>' for l in LANGS)
    out = render(layout, strings, lang, {
        'lang': tag, 'root': root, 'home': root + prefix, 'page_title': esc(title),
        'canonical': url(lang), 'alternates': alternates, 'og': og, 'switch': switch,
        'jsonld': script_json({'@context': 'https://schema.org', '@graph': ld}),
        'body': body, 'scripts': scripts,
    }, 'src/layout/base.html')
    if '{{' in out:
        errors.append(f'{prefix}{path}: unresolved "{{{{" left in the page')
    write(f'{prefix}{path}index.html', out)
    return title


def main():
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(errors='replace')  # a cp949 / cp1252 console must not crash an error report
    site = load(SRC / 'site.json')
    base = (SRC / 'layout/base.html').read_text('utf-8')
    shell = (SRC / 'layout/tool.html').read_text('utf-8')
    hub = {**site, **load(SRC / 'hub/i18n.json', HUB_KEYS)}
    tools = {slug: {**site, **load(SRC / 'tools' / slug / 'i18n.json', TOOL_KEYS)} for slug in TOOLS}

    if errors:
        fail()  # translations are incomplete: leave the previous build untouched

    for name in GENERATED:
        shutil.rmtree(ROOT / name, ignore_errors=True)
    # dirs_exist_ok: on Windows a just-emptied folder can outlive rmtree for a moment
    shutil.copytree(SRC / 'assets', ROOT / 'assets', dirs_exist_ok=True)
    for slug in TOOLS:
        for f in (SRC / 'tools' / slug).iterdir():
            if f.is_file() and f.name not in ('page.html', 'i18n.json'):
                (ROOT / 'assets/tools' / slug).mkdir(parents=True, exist_ok=True)
                shutil.copy(f, ROOT / 'assets/tools' / slug / f.name)

    titles = {}
    for lang, (prefix, tag, _, _) in LANGS.items():
        # Hub
        root = '../' * prefix.count('/') or './'
        where = 'src/hub/page.html'
        body = render((SRC / 'hub/page.html').read_text('utf-8'), hub, lang,
                      {'root': root, 'cards': cards(tools, lang, root, 'h2')}, where)
        ld = [{'@type': 'WebSite', 'name': plain(hub, 'site_name', lang), 'url': BASE + prefix,
               'description': plain(hub, 'description', lang), 'inLanguage': tag},
              {'@type': 'ItemList', 'itemListElement': [
                  {'@type': 'ListItem', 'position': i + 1, 'name': plain(s, 'name', lang),
                   'url': f'{BASE}{prefix}tools/{slug}/'} for i, (slug, s) in enumerate(tools.items())]}]
        titles.setdefault((lang, page(base, hub, lang, '', body, ld)), []).append('hub')

        # Tools
        for slug, s in tools.items():
            path = f'tools/{slug}/'
            root = '../' * (prefix + path).count('/')
            where = f'src/tools/{slug}/page.html'
            faq = numbered(s, 'faq', '_q')
            for q in faq:
                if q[:-1] + 'a' not in s:
                    errors.append(f'src/tools/{slug}/i18n.json: "{q}" has no matching "{q[:-1]}a"')
            body = render(shell, s, lang, {
                'root': root, 'home': root + prefix,
                'page': render((SRC / 'tools' / slug / 'page.html').read_text('utf-8'), s, lang, {'root': root}, where),
                'what': '\n'.join(f'<p>{text(s, k, lang)}</p>' for k in numbered(s, 'what')),
                'how': '\n'.join(f'<li>{text(s, k, lang)}</li>' for k in numbered(s, 'how')),
                'limits': '\n'.join(f'<li>{text(s, k, lang)}</li>' for k in numbered(s, 'limit')),
                'faq': f'<section class="doc"><h2>{text(s, "faq_heading", lang)}</h2>\n' + '\n'.join(
                    f'<details><summary>{text(s, q, lang)}</summary><p>{text(s, q[:-1] + "a", lang)}</p></details>'
                    for q in faq) + '\n</section>' if faq else '',
                'others': cards(tools, lang, root, 'h3', skip=slug),
            }, 'src/layout/tool.html')
            ld = [{'@type': 'WebApplication', 'name': plain(s, 'h1', lang), 'url': BASE + prefix + path,
                   'description': plain(s, 'description', lang), 'inLanguage': tag,
                   'applicationCategory': 'UtilitiesApplication', 'operatingSystem': 'Any',
                   'browserRequirements': 'Requires JavaScript', 'isAccessibleForFree': True,
                   'offers': {'@type': 'Offer', 'price': '0', 'priceCurrency': 'USD'}}]
            if faq:
                ld.append({'@type': 'FAQPage', 'mainEntity': [
                    {'@type': 'Question', 'name': plain(s, q, lang),
                     'acceptedAnswer': {'@type': 'Answer', 'text': plain(s, q[:-1] + 'a', lang)}} for q in faq]})
            # window.T: every js_* string of this page (site-wide ones included) plus the language tag.
            t = {k: str(v.get(lang, '')) for k, v in s.items() if k.startswith('js_')}
            scripts = f'<script>window.T={script_json({"lang": tag, **t})}</script>'
            if (SRC / 'tools' / slug / 'main.js').exists():
                scripts += f'\n<script type="module" src="{root}assets/tools/{slug}/main.js"></script>'
            titles.setdefault((lang, page(base, s, lang, path, body, ld, scripts)), []).append(slug)

    for (lang, title), pages in titles.items():
        if len(pages) > 1:
            errors.append(f'[{lang}] the same <title> "{title}" is used by: {", ".join(pages)}')

    # 404 (GitHub Pages serves it at any depth, so its links are absolute), sitemap, robots
    home = '/' + BASE.split('/', 3)[3]
    lines = '\n'.join(
        f'<p lang="{tag}"><a href="{home}{prefix}">{text(site, "nf_title", lang)} — {text(site, "nf_link", lang)}</a></p>'
        for lang, (prefix, tag, _, _) in LANGS.items())
    write('404.html', f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>404 | {plain(site, "site_name", "en")}</title>
<link rel="icon" href="{home}assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="{home}assets/site.css">
</head>
<body>
<main>
<h1>404</h1>
{lines}
</main>
</body>
</html>
''')
    today = datetime.date.today().isoformat()
    urls = []
    for path in [''] + [f'tools/{slug}/' for slug in TOOLS]:
        links = ''.join(f'<xhtml:link rel="alternate" hreflang="{LANGS[l][1]}" href="{BASE}{LANGS[l][0]}{path}"/>'
                        for l in LANGS)
        links += f'<xhtml:link rel="alternate" hreflang="x-default" href="{BASE}{LANGS[X_DEFAULT][0]}{path}"/>'
        urls += [f'<url><loc>{BASE}{LANGS[l][0]}{path}</loc><lastmod>{today}</lastmod>{links}</url>' for l in LANGS]
    write('sitemap.xml', '<?xml version="1.0" encoding="UTF-8"?>\n'
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n'
          + '\n'.join(urls) + '\n</urlset>\n')
    write('robots.txt', f'User-agent: *\nAllow: /\n\nSitemap: {BASE}sitemap.xml\n')

    if errors:
        fail()
    print(f'Built {len(titles)} pages ({len(TOOLS)} tools x {len(LANGS)} languages + hubs), sitemap.xml, robots.txt, 404.html')


if __name__ == '__main__':
    main()
