#!/usr/bin/env node
'use strict';

/*
 * Security report builder for the security-scanner agent.
 *
 *   node build-report.js <findings.json> <output.docx>
 *
 * Reads a findings JSON file (schema: see example-findings.json) and writes a
 * styled Word report: title block, executive summary with severity counts,
 * scope & methodology, findings overview, one section per finding (CVSS,
 * OWASP, CWE, evidence, impact, recommendation, suggested fix), a remediation
 * roadmap, controls already in place, and limitations.
 */

const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
  WidthType, ShadingType, AlignmentType, BorderStyle, LevelFormat, Header, Footer,
  PageNumber, TableLayoutType,
} = require('docx');

/* ---------- constants ---------- */

const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Informational'];
const SEVERITY_STYLE = {
  Critical:      { fill: '7F1D1D', text: 'FFFFFF' },
  High:          { fill: 'C2410C', text: 'FFFFFF' },
  Medium:        { fill: 'FEF3C7', text: '7C2D12' },
  Low:           { fill: 'DBEAFE', text: '1E3A8A' },
  Informational: { fill: 'F1F5F9', text: '334155' },
};
const BRAND = '9A3412';
const CONTENT_WIDTH = 9026; // A4 width 11906 DXA minus 2 x 1440 margins
const FONT = 'Calibri';
const MONO = 'Consolas';

/* ---------- input handling ---------- */

// Characters that are illegal in XML 1.0 would corrupt the document.
function clean(value) {
  return String(value == null ? '' : value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');
}

function fail(message) {
  console.error(`build-report: ${message}`);
  process.exit(1);
}

function loadReport(file) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`cannot read ${file}: ${err.message}`);
  }
  for (const key of ['project', 'date', 'summary', 'findings']) {
    if (data[key] == null) fail(`missing required field "${key}"`);
  }
  if (!Array.isArray(data.findings)) fail('"findings" must be an array');
  data.findings.forEach((f, i) => {
    for (const key of ['id', 'title', 'severity', 'description', 'recommendation']) {
      if (!f[key]) fail(`finding #${i + 1} is missing "${key}"`);
    }
    if (!SEVERITIES.includes(f.severity)) {
      fail(`finding ${f.id}: severity must be one of ${SEVERITIES.join(', ')}`);
    }
  });
  data.findings.sort((a, b) =>
    SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) ||
    ((b.cvss && b.cvss.score) || 0) - ((a.cvss && a.cvss.score) || 0) ||
    String(a.id).localeCompare(String(b.id)));
  return data;
}

/* ---------- building blocks ---------- */

function run(text, { mono, ...rest } = {}) {
  return new TextRun({ text: clean(text), font: mono ? MONO : FONT, ...rest });
}

function para(text, { run: runOpts = {}, ...rest } = {}) {
  const runs = Array.isArray(text) ? text : [run(text, runOpts)];
  return new Paragraph({ children: runs, spacing: { after: 120 }, ...rest });
}

function heading(text, level) {
  // keepNext: a heading never sits alone at the bottom of a page.
  return new Paragraph({ text: clean(text), heading: level, keepNext: true, keepLines: true, spacing: { before: 240, after: 120 } });
}

function bullets(items) {
  return (items || []).map((item) => new Paragraph({
    children: [run(item)],
    numbering: { reference: 'bullets', level: 0 },
    spacing: { after: 60 },
  }));
}

// Multi-line text → one paragraph per line (never embed \n in a run).
function codeBlock(text) {
  const lines = clean(text).replace(/\r\n?/g, '\n').split('\n');
  return lines.map((line, i) => new Paragraph({
    children: [run(line.length ? line : ' ', { mono: true, size: 18 })],
    shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'F5F5F4' },
    spacing: { after: i === lines.length - 1 ? 160 : 0, line: 260 },
    indent: { left: 120, right: 120 },
  }));
}

function textBlock(text) {
  return clean(text).replace(/\r\n?/g, '\n').split(/\n{2,}/).map((chunk) => para(chunk.replace(/\n/g, ' ')));
}

const CELL_BORDER = { style: BorderStyle.SINGLE, size: 4, color: 'D6C8BB' };

function cell(content, width, opts = {}) {
  const children = Array.isArray(content)
    ? content
    : [new Paragraph({
        children: [run(content, { bold: opts.bold, color: opts.color, size: opts.size || 20, mono: opts.mono })],
        alignment: opts.align || AlignmentType.LEFT,
      })];
  return new TableCell({
    children,
    width: { size: width, type: WidthType.DXA },
    shading: opts.fill ? { type: ShadingType.CLEAR, color: 'auto', fill: opts.fill } : undefined,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    borders: { top: CELL_BORDER, bottom: CELL_BORDER, left: CELL_BORDER, right: CELL_BORDER },
  });
}

function table(columnWidths, header, rows) {
  const total = columnWidths.reduce((a, b) => a + b, 0);
  const headRow = new TableRow({
    tableHeader: true,
    children: header.map((h, i) => cell(h, columnWidths[i], { bold: true, color: 'FFFFFF', fill: BRAND })),
  });
  const bodyRows = rows.map((r) => new TableRow({
    children: r.map((c, i) => (c instanceof TableCell ? c : cell(c, columnWidths[i]))),
  }));
  return new Table({
    width: { size: total, type: WidthType.DXA },
    columnWidths,
    layout: TableLayoutType.FIXED,
    rows: [headRow, ...bodyRows],
  });
}

function severityCell(severity, width) {
  const s = SEVERITY_STYLE[severity];
  return cell(severity, width, { bold: true, color: s.text, fill: s.fill });
}

function spacer() {
  return new Paragraph({ children: [], spacing: { after: 120 } });
}

/* ---------- sections ---------- */

function titleBlock(r) {
  const counts = severityCounts(r.findings);
  const meta = [
    ['Target', r.target || 'n/a'],
    ['Repository', r.repo || 'n/a'],
    ['Commit', r.commit || 'n/a'],
    ['Assessment date', r.date],
    ['Assessed by', r.scanner || 'security-scanner agent'],
    ['Overall risk', r.overallRisk || overallRisk(counts)],
  ];
  return [
    new Paragraph({ children: [run('Security Assessment Report', { bold: true, size: 44, color: BRAND })], spacing: { after: 80 } }),
    new Paragraph({ children: [run(r.project, { size: 28, color: '44403C' })], spacing: { after: 240 } }),
    new Table({
      width: { size: CONTENT_WIDTH, type: WidthType.DXA },
      columnWidths: [2400, CONTENT_WIDTH - 2400],
      layout: TableLayoutType.FIXED,
      rows: meta.map(([k, v]) => new TableRow({
        children: [cell(k, 2400, { bold: true, fill: 'FFEDD5' }), cell(v, CONTENT_WIDTH - 2400)],
      })),
    }),
    spacer(),
  ];
}

function severityCounts(findings) {
  const counts = {};
  SEVERITIES.forEach((s) => { counts[s] = 0; });
  findings.forEach((f) => { counts[f.severity] += 1; });
  return counts;
}

function overallRisk(counts) {
  if (counts.Critical) return 'Critical';
  if (counts.High) return 'High';
  if (counts.Medium) return 'Medium';
  if (counts.Low) return 'Low';
  return 'Informational';
}

function executiveSummary(r) {
  const counts = severityCounts(r.findings);
  const rows = SEVERITIES.map((s) => [severityCell(s, 4513), cell(String(counts[s]), 4513, { align: AlignmentType.CENTER, bold: true })]);
  rows.push([cell('Total', 4513, { bold: true }), cell(String(r.findings.length), 4513, { align: AlignmentType.CENTER, bold: true })]);
  return [
    heading('1. Executive summary', HeadingLevel.HEADING_1),
    ...textBlock(r.summary),
    para([run('Overall risk rating: ', { bold: true }), run(r.overallRisk || overallRisk(counts), { bold: true, color: BRAND })]),
    table([4513, 4513], ['Severity', 'Findings'], rows),
    spacer(),
  ];
}

function scopeSection(r) {
  return [
    heading('2. Scope and methodology', HeadingLevel.HEADING_1),
    heading('Scope', HeadingLevel.HEADING_2),
    ...bullets(r.scope),
    heading('Methodology', HeadingLevel.HEADING_2),
    ...bullets(r.methodology),
    heading('Classification', HeadingLevel.HEADING_2),
    para('Each finding is rated Critical, High, Medium, Low or Informational using a CVSS v3.1 base score '
      + '(Critical 9.0–10.0, High 7.0–8.9, Medium 4.0–6.9, Low 0.1–3.9, Informational 0.0 / best practice), '
      + 'adjusted for the deployment context, and mapped to the OWASP Top 10 (2021) category and CWE weakness ID.'),
  ];
}

function overviewSection(r) {
  const widths = [900, 3076, 1500, 1650, 1000, 900];
  const rows = r.findings.map((f) => [
    cell(f.id, widths[0], { bold: true }),
    cell(f.title, widths[1]),
    severityCell(f.severity, widths[2]),
    cell(f.owasp || '—', widths[3], { size: 18 }),
    cell(f.cwe || '—', widths[4], { size: 18 }),
    cell(f.priority || '—', widths[5], { size: 18 }),
  ]);
  return [
    heading('3. Findings overview', HeadingLevel.HEADING_1),
    r.findings.length
      ? table(widths, ['ID', 'Finding', 'Severity', 'OWASP', 'CWE', 'Priority'], rows)
      : para('No vulnerabilities were identified within the scope of this assessment.'),
    spacer(),
  ];
}

function findingSection(f) {
  const label = 2200;
  const value = CONTENT_WIDTH - label;
  const cvss = f.cvss ? `${f.cvss.score != null ? f.cvss.score : '—'}  ${f.cvss.vector || ''}`.trim() : '—';
  const attrs = [
    ['Severity', severityCell(f.severity, value)],
    ['CVSS v3.1', cvss],
    ['OWASP Top 10', f.owasp || '—'],
    ['CWE', f.cwe || '—'],
    ['Category', f.category || '—'],
    ['Location', f.location || '—'],
    ['Fix effort', f.effort || '—'],
    ['Priority', f.priority || '—'],
    ['Status', f.status || 'Open'],
  ];
  const out = [
    heading(`${f.id} — ${f.title}`, HeadingLevel.HEADING_2),
    new Table({
      width: { size: CONTENT_WIDTH, type: WidthType.DXA },
      columnWidths: [label, value],
      layout: TableLayoutType.FIXED,
      rows: attrs.map(([k, v]) => new TableRow({
        children: [cell(k, label, { bold: true, fill: 'FFF7ED' }), v instanceof TableCell ? v : cell(v, value, { mono: k === 'Location' || k === 'CVSS v3.1', size: 18 })],
      })),
    }),
    heading('Description', HeadingLevel.HEADING_3),
    ...textBlock(f.description),
  ];
  if (f.evidence) out.push(heading('Evidence', HeadingLevel.HEADING_3), ...codeBlock(f.evidence));
  if (f.impact) out.push(heading('Impact', HeadingLevel.HEADING_3), ...textBlock(f.impact));
  out.push(heading('Recommendation', HeadingLevel.HEADING_3), ...textBlock(f.recommendation));
  if (f.fix) out.push(heading('Suggested fix', HeadingLevel.HEADING_3), ...codeBlock(f.fix));
  if (f.references && f.references.length) out.push(heading('References', HeadingLevel.HEADING_3), ...bullets(f.references));
  return out;
}

function roadmapSection(r) {
  const rm = r.roadmap || {};
  return [
    heading('5. Remediation roadmap', HeadingLevel.HEADING_1),
    heading('Immediate (before next release)', HeadingLevel.HEADING_2),
    ...(rm.immediate && rm.immediate.length ? bullets(rm.immediate) : [para('None.')]),
    heading('Short term (within 30 days)', HeadingLevel.HEADING_2),
    ...(rm.shortTerm && rm.shortTerm.length ? bullets(rm.shortTerm) : [para('None.')]),
    heading('Long term / hardening', HeadingLevel.HEADING_2),
    ...(rm.longTerm && rm.longTerm.length ? bullets(rm.longTerm) : [para('None.')]),
  ];
}

/* ---------- document ---------- */

function buildDocument(r) {
  const children = [
    ...titleBlock(r),
    ...executiveSummary(r),
    ...scopeSection(r),
    ...overviewSection(r),
    heading('4. Detailed findings', HeadingLevel.HEADING_1),
    ...(r.findings.length ? r.findings.flatMap(findingSection) : [para('No findings.')]),
    ...roadmapSection(r),
    heading('6. Security controls already in place', HeadingLevel.HEADING_1),
    ...(r.positives && r.positives.length ? bullets(r.positives) : [para('None recorded.')]),
    heading('7. Limitations', HeadingLevel.HEADING_1),
    ...(r.limitations && r.limitations.length ? bullets(r.limitations) : [para('None recorded.')]),
  ];

  return new Document({
    creator: clean(r.scanner || 'security-scanner agent'),
    title: clean(`Security Assessment Report — ${r.project}`),
    description: 'Security vulnerability assessment with classified findings and recommended fixes.',
    styles: {
      default: { document: { run: { font: FONT, size: 22, color: '1C1917' } } },
      paragraphStyles: [
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { size: 32, bold: true, color: BRAND, font: FONT }, paragraph: { spacing: { before: 360, after: 160 }, outlineLevel: 0 } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { size: 26, bold: true, color: '7C2D12', font: FONT }, paragraph: { spacing: { before: 280, after: 120 }, outlineLevel: 1 } },
        { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { size: 22, bold: true, color: '44403C', font: FONT }, paragraph: { spacing: { before: 200, after: 80 }, outlineLevel: 2 } },
      ],
    },
    numbering: {
      config: [{
        reference: 'bullets',
        levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 540, hanging: 270 } } } }],
      }],
    },
    sections: [{
      properties: { page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
      headers: {
        default: new Header({ children: [new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [run(`Security Assessment — ${r.project} — CONFIDENTIAL`, { size: 16, color: '78716C' })],
        })] }),
      },
      footers: {
        default: new Footer({ children: [new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new TextRun({ children: ['Page ', PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES], size: 16, color: '78716C', font: FONT }),
          ],
        })] }),
      },
      children,
    }],
  });
}

async function main() {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) fail('usage: node build-report.js <findings.json> <output.docx>');
  const report = loadReport(input);
  const buffer = await Packer.toBuffer(buildDocument(report));
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(output, buffer);
  const counts = severityCounts(report.findings);
  console.log(`Wrote ${output} (${buffer.length} bytes): ` + SEVERITIES.map((s) => `${s} ${counts[s]}`).join(', '));
}

main().catch((err) => fail(err.stack || err.message));
