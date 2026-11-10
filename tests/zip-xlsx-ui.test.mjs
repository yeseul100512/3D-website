import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { zipStore, readZip, crc32 } from '../src/assets/lib/zip.js';
import { writeXLSX, toCSV } from '../src/assets/lib/xlsx.js';
import { esc, fmt, num, bytes, duration, checkNumber, errorText } from '../src/assets/lib/ui.js';
import { MeshError } from '../src/assets/lib/mesh-io.js';

const enc = (s) => new TextEncoder().encode(s);
const dec = (u8) => new TextDecoder().decode(u8);

test('zip: store-only writer round trips through the reader', async () => {
  const blob = zipStore([
    { name: 'a.txt', data: 'hello' },
    { name: '폴더/b.bin', data: [new Uint8Array([1, 2, 3]), 'tail'] },
  ]);
  const zip = readZip(await blob.arrayBuffer());
  assert.deepEqual(zip.names, ['a.txt', '폴더/b.bin']);
  assert.equal(dec(await zip.read('a.txt')), 'hello');
  assert.deepEqual([...(await zip.read('폴더/b.bin'))], [1, 2, 3, ...enc('tail')]);
  assert.equal(zip.size('a.txt'), 5);
  assert.equal(await zip.read('missing'), null);
});

// One deflated entry, built by hand (what slicers write into .3mf / .gcode.3mf).
function deflatedZip(name, text) {
  const raw = enc(text);
  const data = deflateRawSync(raw);
  const n = enc(name);
  const local = new DataView(new ArrayBuffer(30));
  local.setUint32(0, 0x04034b50, true);
  local.setUint16(8, 8, true);
  local.setUint32(14, crc32(raw), true);
  local.setUint32(18, data.length, true);
  local.setUint32(22, raw.length, true);
  local.setUint16(26, n.length, true);
  const cd = new DataView(new ArrayBuffer(46));
  cd.setUint32(0, 0x02014b50, true);
  cd.setUint16(10, 8, true);
  cd.setUint32(20, data.length, true);
  cd.setUint32(24, raw.length, true);
  cd.setUint16(28, n.length, true);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(10, 1, true);
  end.setUint32(12, 46 + n.length, true);
  end.setUint32(16, 30 + n.length + data.length, true);
  return Buffer.concat([local, n, data, cd, n, end].map((p) => new Uint8Array(p.buffer ?? p, p.byteOffset ?? 0, p.byteLength)));
}

test('zip: reads deflated entries; damaged archives throw code bad_zip', async () => {
  const text = 'G1 X10 Y10 E0.5\n'.repeat(5000);
  const file = deflatedZip('Metadata/plate_1.gcode', text);
  assert.ok(file.length < text.length / 10);
  const zip = readZip(file);
  assert.equal(dec(await zip.read('Metadata/plate_1.gcode')), text);
  assert.throws(() => readZip(enc('not a zip at all, just some text')), { code: 'bad_zip' });
  assert.throws(() => readZip(file.subarray(0, file.length - 30)), { code: 'bad_zip' });
  const broken = Uint8Array.from(file);
  broken.fill(0xff, 60, 90);
  await assert.rejects(readZip(broken).read('Metadata/plate_1.gcode'), { code: 'bad_zip' });
});

test('xlsx: a real workbook with strings, numbers and escaped text', async () => {
  const blob = writeXLSX([['이름', 'g', 'note'], ['<PLA> & "PETG"', 12.5, null], ['bad', NaN, '']], '무게/weight');
  const zip = readZip(await blob.arrayBuffer());
  assert.ok(zip.names.includes('[Content_Types].xml') && zip.names.includes('xl/workbook.xml'));
  const sheet = dec(await zip.read('xl/worksheets/sheet1.xml'));
  assert.match(sheet, /<c r="A1" t="inlineStr"><is><t xml:space="preserve">이름<\/t>/);
  assert.match(sheet, /<c r="B2"><v>12.5<\/v><\/c>/);
  assert.match(sheet, /&lt;PLA&gt; &amp; &quot;PETG&quot;/);
  assert.doesNotMatch(sheet, /NaN|r="C2"|r="B3"/);
  assert.match(dec(await zip.read('xl/workbook.xml')), /<sheet name="무게 weight"/);
});

test('csv: BOM, quoting, no NaN', () => {
  const csv = toCSV([['a', 'b,c', 'say "hi"'], [1.5, NaN, '줄\n바꿈']]);
  assert.equal(csv, '﻿a,"b,c","say ""hi"""\r\n1.5,,"줄\n바꿈"\r\n');
});

test('ui: escaping and templates', () => {
  assert.equal(esc(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  assert.equal(fmt('{name}: {n} / {missing}', { name: 'a.stl', n: 0 }), 'a.stl: 0 / {missing}');
});

test('ui: formatters never print NaN or Infinity', () => {
  globalThis.T = { lang: 'en', js_unit_h: 'h', js_unit_m: 'm', js_unit_s: 's' };
  assert.equal(num(1234.5678), '1,234.57');
  assert.equal(num(NaN), '–');
  assert.equal(num(Infinity), '–');
  assert.equal(num(undefined), '–');
  assert.equal(bytes(1536), '1.5 KB');
  assert.equal(bytes(499969684), '476.8 MB');
  assert.equal(bytes(NaN), '–');
  assert.equal(duration(3725), '1h 2m');
  assert.equal(duration(45), '45s');
  assert.equal(duration(-1), '–');
});

test('ui: number validation with translated messages', () => {
  globalThis.T = { js_num_required: '값을 입력해 주세요.', js_num_invalid: '숫자가 아닙니다.', js_num_min: '{min} 이상', js_num_max: '{max} 이하' };
  assert.deepEqual(checkNumber('12.5', { min: 0, max: 100 }), { value: 12.5, error: '' });
  assert.deepEqual(checkNumber('', {}), { value: null, error: '값을 입력해 주세요.' });
  assert.deepEqual(checkNumber('', { required: false }), { value: null, error: '' });
  assert.deepEqual(checkNumber('abc', {}), { value: null, error: '숫자가 아닙니다.' });
  assert.deepEqual(checkNumber('', { badInput: true }), { value: null, error: '숫자가 아닙니다.' });
  assert.deepEqual(checkNumber('Infinity', {}), { value: null, error: '숫자가 아닙니다.' });
  assert.deepEqual(checkNumber('-1', { min: 0 }), { value: null, error: '0 이상' });
  assert.deepEqual(checkNumber('101', { max: 100 }), { value: null, error: '100 이하' });
});

test('ui: error text for typed errors', () => {
  globalThis.T = { js_err_truncated: '{name}: {present}/{declared}', js_err_not_mesh: '{name}?', js_err_unknown: 'oops {detail}' };
  assert.equal(errorText(new MeshError('truncated', { declared: 12, present: 7 }), 'a.stl'), 'a.stl: 7/12');
  assert.equal(errorText(Object.assign(new Error('x'), { code: 'bad_zip' }), 'a.3mf'), 'a.3mf?');
  assert.equal(errorText(new Error('boom')), 'oops boom');
});

test('csv: text that a spreadsheet would run as a formula is defused, numbers are not', () => {
  const csv = toCSV([['=HYPERLINK("http://x","a")', '+1+1', '@x', '-cmd', '-12.5', -3, 'a=b']]);
  assert.equal(csv, '\ufeff"\'=HYPERLINK(""http://x"",""a"")",\'+1+1,\'@x,\'-cmd,-12.5,-3,a=b\r\n');
});

test('num: a small negative that rounds to zero is "0", never "-0"', () => {
  assert.equal(num(-0.001), '0');
  assert.equal(num(-0.004), '0');
  assert.equal(num(-0), '0');
  assert.equal(num(-0.006), '-0.01');
  assert.equal(num(-1234.5), '-1,234.5');
});
