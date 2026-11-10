// Minimal .xlsx (one sheet, strings and numbers) and CSV writers.
// rows: array of rows; a cell is a string, a number, or null/undefined (empty).
import { zipStore } from './zip.js';

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const esc = (s) =>
  String(s)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/g, '')
    .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function col(i) {
  let s = '';
  for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

/** @returns {Blob} a real .xlsx workbook */
export function writeXLSX(rows, sheetName = 'Sheet1') {
  const name = esc(sheetName.replace(/[\[\]:*?\/\\]/g, ' ').slice(0, 31) || 'Sheet1');
  const sheet = [`${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`];
  rows.forEach((row, r) => {
    let s = `<row r="${r + 1}">`;
    row.forEach((v, c) => {
      const ref = col(c) + (r + 1);
      if (typeof v === 'number') {
        if (Number.isFinite(v)) s += `<c r="${ref}"><v>${v}</v></c>`; // NaN/Infinity become empty cells
      } else if (v != null && v !== '') {
        s += `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
      }
    });
    sheet.push(s + '</row>');
  });
  sheet.push('</sheetData></worksheet>');

  const pkg = 'http://schemas.openxmlformats.org/package/2006';
  const doc = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const ct = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
  return zipStore(
    [
      {
        name: '[Content_Types].xml',
        data: `${XML}<Types xmlns="${pkg}/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${ct}.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="${ct}.worksheet+xml"/></Types>`,
      },
      {
        name: '_rels/.rels',
        data: `${XML}<Relationships xmlns="${pkg}/relationships"><Relationship Id="rId1" Type="${doc}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      },
      {
        name: 'xl/workbook.xml',
        data: `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${doc}"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        data: `${XML}<Relationships xmlns="${pkg}/relationships"><Relationship Id="rId1" Type="${doc}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      },
      { name: 'xl/worksheets/sheet1.xml', data: sheet },
    ],
    `${ct}.sheet`,
  );
}

/** @returns {string} CSV with a UTF-8 BOM so Excel opens Korean/Japanese/Chinese text correctly */
export function toCSV(rows) {
  const cell = (v) => {
    if (v == null || (typeof v === 'number' && !Number.isFinite(v))) return '';
    let s = String(v);
    // Text that a spreadsheet would run as a formula (a file or printer name starting with = + - @) gets a
    // leading apostrophe; a string that is just a number stays as it is.
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s) && !Number.isFinite(Number(s))) s = "'" + s;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '\ufeff' + rows.map((r) => r.map(cell).join(',') + '\r\n').join('');
}
