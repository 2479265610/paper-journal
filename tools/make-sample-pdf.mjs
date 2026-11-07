#!/usr/bin/env node
/**
 * 生成一本 2 页的最小合法 PDF（自检用），写入 js/vendor/sample-2p.pdf
 * xref 偏移由程序精确计算，pdf.js 可正常解析渲染。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'js', 'vendor', 'sample-2p.pdf');

function mkPage(num, text, fontRef, contentRef) {
  return {
    obj: `${num} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontRef} 0 R >> >> /Contents ${contentRef} 0 R >>\nendobj\n`,
    content: `${contentRef} 0 obj\n<< /Length ${Buffer.byteLength(text, 'latin1')} >>\nstream\n${text}endstream\nendobj\n`
  };
}

const p1Text = 'BT /F1 34 Tf 60 760 Td (Paper Journal - Page 1) Tj ET\nBT /F1 16 Tf 60 700 Td (Self-test sample PDF.) Tj ET\n';
const p2Text = 'BT /F1 34 Tf 60 760 Td (Page 2) Tj ET\nBT /F1 16 Tf 60 700 Td (Import test.) Tj ET\n';

const page1 = mkPage(3, p1Text, 8, 4);
const page2 = mkPage(5, p2Text, 8, 6);

const objects = [
  '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
  '2 0 obj\n<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>\nendobj\n',
  page1.obj,
  page1.content,
  page2.obj,
  page2.content,
  '',
  '8 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n'
];

let pdf = '%PDF-1.4\n';
const offsets = [];
for (let i = 0; i < objects.length; i++) {
  const objNum = i + 1;
  if (objects[i] === '') { offsets[objNum] = 0; continue; }
  offsets[objNum] = Buffer.byteLength(pdf, 'latin1');
  pdf += objects[i];
}

const xrefPos = Buffer.byteLength(pdf, 'latin1');
pdf += 'xref\n0 9\n';
pdf += '0000000000 65535 f \n';
for (let n = 1; n <= 8; n++) {
  pdf += String(offsets[n] || 0).padStart(10, '0') + ' 00000 n \n';
}
pdf += 'trailer\n<< /Size 9 /Root 1 0 R >>\nstartxref\n' + xrefPos + '\n%%EOF\n';

fs.writeFileSync(out, Buffer.from(pdf, 'latin1'));
console.log(`✓ js/vendor/sample-2p.pdf  ${fs.statSync(out).size} bytes  (2 pages)`);
