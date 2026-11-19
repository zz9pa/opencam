/**
 * The setup sheet: a printable page for the shop floor. Which bit goes in when, where zero is, what to do before pressing start,
 * how long each file should take, and a picture of the cuts. One page per G-code file.
 *
 * The idea (a per-operation report to take to the machine) comes from PureCutCNC's operation booklet
 * (https://github.com/PureCutCNC/purecutcnc, Apache-2.0, see NOTICE.md). The code here is open-cam's own.
 */
import type { Toolpath } from './core/types';
import { describeTool, estimateMinutes, type ToolChange } from './core/gcode';

export interface SheetFile {
  /** File name as downloaded, e.g. job.gcode */
  name: string;
  /** The "where is zero / what to do first" text for this file (lines separated by \n) */
  note: string;
  paths: Toolpath[];
}

export interface SheetInput {
  title: string;
  /** Shown under the title, already formatted */
  date: string;
  controller: string;
  /** 'manual': the router is switched on by hand */
  spindle: 'manual' | 'm3';
  rpm: number;
  arcs: boolean;
  bed: { x: number; y: number };
  toolChange?: ToolChange;
  warnings: string[];
  files: SheetFile[];
}

export const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

export function fmtMinutes(m: number): string {
  if (m < 1) return 'under a minute';
  const h = Math.floor(m / 60), r = Math.round(m % 60);
  return h ? `${h} h ${r} min` : `${Math.round(m)} min`;
}

const sameTool = (a: Toolpath['tool'], b: Toolpath['tool']) => a.type === b.type && a.diameter === b.diameter && a.angle === b.angle && a.tipDiameter === b.tipDiameter;

/** The distinct bits of a file in order of first use (this is also the tool number order in G-code for controllers that use one). */
export function bitsOf(paths: Toolpath[]): { tool: Toolpath['tool']; used: string[] }[] {
  const out: { tool: Toolpath['tool']; used: string[] }[] = [];
  for (const tp of paths) {
    let b = out.find(x => sameTool(x.tool, tp.tool));
    if (!b) out.push(b = { tool: tp.tool, used: [] });
    if (!b.used.includes(tp.name)) b.used.push(tp.name);
  }
  return out;
}

function extents(paths: Toolpath[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, minZ = Infinity;
  for (const tp of paths) for (const c of tp.cuts) for (const m of c.moves) {
    if (m.x < minX) minX = m.x; if (m.x > maxX) maxX = m.x;
    if (m.y < minY) minY = m.y; if (m.y > maxY) maxY = m.y;
    if (!m.rapid && m.z < minZ) minZ = m.z;
  }
  return minX === Infinity ? null : { minX, minY, maxX, maxY, minZ: minZ === Infinity ? 0 : minZ };
}

const COLOURS = ['#0e6b72', '#d9560b', '#6a4c93', '#2e7d32', '#b3261e', '#8a6d00'];

/** A top view of the cutting moves, one colour per bit. Long paths are thinned so the page stays light. */
export function previewSvg(paths: Toolpath[], size = 360): string {
  const e = extents(paths);
  if (!e) return '';
  const pad = 6, w = Math.max(e.maxX - e.minX, 1), h = Math.max(e.maxY - e.minY, 1);
  const k = (size - 2 * pad) / Math.max(w, h);
  const W = Math.round(w * k + 2 * pad), H = Math.round(h * k + 2 * pad);
  let total = 0;
  for (const tp of paths) for (const c of tp.cuts) total += c.moves.length;
  const step = Math.max(1, Math.ceil(total / 20000));
  const bits = bitsOf(paths);
  const lines: string[] = [];
  for (const tp of paths) {
    const colour = COLOURS[bits.findIndex(b => sameTool(b.tool, tp.tool)) % COLOURS.length];
    const d: string[] = [];
    for (const c of tp.cuts) {
      const pts = c.moves.filter((m, i) => !m.rapid && (i % step === 0 || i === c.moves.length - 1));
      if (pts.length < 2) continue;
      d.push('M' + pts.map(m => `${((m.x - e.minX) * k + pad).toFixed(1)} ${(H - ((m.y - e.minY) * k + pad)).toFixed(1)}`).join('L'));
    }
    if (d.length) lines.push(`<path d="${d.join('')}" fill="none" stroke="${colour}" stroke-width="0.8" stroke-linejoin="round"/>`);
  }
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Top view of the cuts">` +
    `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" fill="#f8f8f5" stroke="#9aa3a8"/>${lines.join('')}</svg>`;
}

/** What the program does about zeroing, in the order the operator meets it. */
export function startSteps(i: SheetInput, first: Toolpath | undefined): string[] {
  const tc = i.toolChange, L: string[] = [];
  if (first) L.push(`Fit the first bit: ${describeTool(first.tool)}.`);
  if (tc?.startMacro?.trim()) L.push('The file runs your own zeroing G-code first, with the router off.');
  if (tc?.mode === 'probe' && tc.probeAtStart) {
    if (tc.probeXY && tc.guided && first?.tool.type !== 'vbit') {
      L.push('Router OFF. Put the touch plate on the material. The file pauses three times and you jog the bit each time: beside the X face of the plate (then resume, it touches and sets X), beside the Y face (resume, it sets Y), then over the plate (resume, it sets Z).');
    } else if (tc.probeXY && first?.tool.type !== 'vbit') {
      L.push('Router OFF. Put the touch plate on the material and jog the bit into its recess, a few mm above the floor and clear of the walls. The file finds Z, then X and Y.');
    } else {
      L.push('Router OFF. Put the touch plate under the bit. The file finds Z zero by touching it.');
    }
    L.push('When asked, take the touch plate away.');
  } else if (!tc?.startMacro?.trim()) {
    L.push('Set X/Y/Z zero by hand as described in the notes below.');
  }
  L.push(i.spindle === 'm3' ? `The controller starts the router (${i.rpm} rpm). Be ready at the stop button.` : 'When the file pauses ("start the router"), switch the router on, then resume.');
  return L;
}

/** How bit changes will go, in a line. */
export function changeSummary(tc: ToolChange | undefined, bits: number): string {
  if (bits < 2) return 'One bit: no bit changes.';
  const m = tc?.mode ?? 'pause';
  const how = m === 'pause' ? 'The file pauses where it is.'
    : `The file lifts to Z ${tc?.liftZ ?? 30}${tc?.home ? ', re-homes X and Y' : ''} and goes to ${tc?.x !== undefined && tc?.y !== undefined ? `X${tc.x} Y${tc.y}` : 'the start of the next cut'}, then pauses.`
      + (m === 'probe' ? ' After the swap it finds Z zero with the touch plate again.' : m === 'custom' ? ' After the swap it runs your own zeroing G-code.' : ' Set Z zero on the material after the swap.');
  return `${bits - 1} bit change${bits > 2 ? 's' : ''}. ${how}`;
}

function fileSection(f: SheetFile, i: SheetInput, n: number): string {
  const e = extents(f.paths), bits = bitsOf(f.paths), t = estimateMinutes(f.paths);
  const rows = f.paths.map((tp, k) => {
    const depth = extents([tp])?.minZ ?? 0, pm = estimateMinutes([tp]).total;
    return `<tr><td>${k + 1}</td><td>${esc(tp.name)}</td><td>${bits.findIndex(b => sameTool(b.tool, tp.tool)) + 1}</td><td>${tp.feed}</td><td>${tp.plungeFeed}</td><td>${depth.toFixed(2)}</td><td>${tp.cuts.length}</td><td>${fmtMinutes(pm)}</td></tr>`;
  }).join('');
  const bitRows = bits.map((b, k) => `<tr><td>${k + 1}</td><td><span class="sw" style="background:${COLOURS[k % COLOURS.length]}"></span>${esc(describeTool(b.tool))}</td><td>${esc(b.used.join(', '))}</td></tr>`).join('');
  const fits = e ? (e.maxX <= i.bed.x + 1e-6 && e.maxY <= i.bed.y + 1e-6 && e.minX >= -1e-6 && e.minY >= -1e-6) : true;
  return `<section class="file">
  <h2>${n}. ${esc(f.name)}</h2>
  <div class="cols">
    <div>
      <p><b>Run time</b> about ${fmtMinutes(t.total)} (${fmtMinutes(t.cutting)} cutting). A guide only.</p>
      ${e ? `<p><b>Travel</b> X ${e.minX.toFixed(1)} to ${e.maxX.toFixed(1)}, Y ${e.minY.toFixed(1)} to ${e.maxY.toFixed(1)}, deepest Z ${e.minZ.toFixed(2)} mm. ${fits ? '' : '<b class="bad">Outside your work area.</b>'}</p>` : ''}
      <h3>Before you start</h3>
      <ol class="check">${startSteps(i, f.paths[0]).map(s => `<li>${esc(s)}</li>`).join('')}</ol>
      ${f.note.trim() ? `<h3>Notes for this file</h3><p class="note">${esc(f.note).replace(/\n/g, '<br>')}</p>` : ''}
    </div>
    <div class="pic">${previewSvg(f.paths)}<div class="cap">Top view. Colours match the bits below.</div></div>
  </div>
  <h3>Bits, in the order they are used</h3>
  <table><tr><th>#</th><th>Bit</th><th>Used by</th></tr>${bitRows}</table>
  <p>${esc(changeSummary(i.toolChange, bits.length))}</p>
  <h3>Operations, in order</h3>
  <table><tr><th>#</th><th>Operation</th><th>Bit</th><th>Feed mm/min</th><th>Plunge mm/min</th><th>Deepest Z</th><th>Passes</th><th>Time</th></tr>${rows}</table>
</section>`;
}

const CSS = `
:root{color-scheme:light}
body{font:13px/1.4 "Segoe UI",system-ui,sans-serif;color:#1e2429;margin:0;background:#eceeea}
.page{max-width:900px;margin:0 auto;padding:18px 24px;background:#fff}
.bar{position:sticky;top:0;background:#1e2429;color:#fff;padding:8px 24px;display:flex;gap:12px;align-items:center}
.bar button{font:inherit;padding:5px 14px;border:0;background:#d9560b;color:#fff;cursor:pointer}
h1{font-size:22px;margin:0 0 2px}h2{font-size:17px;margin:20px 0 6px;border-bottom:2px solid #0e6b72;padding-bottom:2px}h3{font-size:13px;margin:12px 0 4px;text-transform:uppercase;letter-spacing:.04em;color:#0e6b72}
.sub{color:#5a666e;margin:0 0 8px}
.cols{display:flex;flex-wrap:wrap;gap:18px;align-items:flex-start}.cols>div:first-child{flex:1 1 280px}.pic{flex:0 1 360px;max-width:100%}.pic svg{max-width:100%;height:auto}.cap{font-size:11px;color:#5a666e}
table{border-collapse:collapse;width:100%;margin:4px 0}th,td{border:1px solid #c9cdc8;padding:3px 6px;text-align:left}th{background:#eceeea}
.check{list-style:none;padding:0;margin:0}.check li{padding-left:22px;position:relative;margin:3px 0}.check li:before{content:"";position:absolute;left:0;top:3px;width:12px;height:12px;border:1.5px solid #1e2429}
.sw{display:inline-block;width:10px;height:10px;margin-right:6px}.note{background:#f8f8f5;padding:6px 8px;border-left:3px solid #d9560b}.bad{color:#b3261e}
.warn{background:#fff3e0;border-left:3px solid #d9560b;padding:6px 8px;margin:8px 0}.lines{height:90px;background:repeating-linear-gradient(#fff,#fff 21px,#c9cdc8 22px)}
.file{break-inside:avoid;page-break-after:always}.file:last-of-type{page-break-after:auto}
@media print{body{background:#fff}.bar{display:none}.page{padding:0;max-width:none}}
`;

/** The whole page as HTML. */
export function setupSheetHtml(i: SheetInput): string {
  const warn = i.warnings.length ? `<div class="warn"><b>Check before you cut</b><ul>${i.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Setup sheet: ${esc(i.title)}</title><style>${CSS}</style></head><body>
<div class="bar"><button onclick="print()">Print or save as PDF</button><span>Setup sheet</span></div>
<div class="page">
<h1>${esc(i.title)}</h1>
<p class="sub">${esc(i.date)} &middot; ${esc(i.controller)} &middot; work area ${i.bed.x} x ${i.bed.y} mm &middot; arcs ${i.arcs ? 'on' : 'off'} &middot; made with open-cam</p>
${warn}
${i.files.map((f, k) => fileSection(f, i, k + 1)).join('')}
<h3>Notes</h3><div class="lines"></div>
</div></body></html>`;
}
