import { parseSvgRaw } from './svg';
import { parseDxf } from './import/dxf';
import { processImport, DEFAULT_IMPORT, type Shape, type ImportOptions } from './import';
import { HINTS } from './hints';
import { History, snapshotToProject, projectToSnapshot, type Snapshot } from './project';
import { kvGet, kvSet, kvDelete } from './storage';
import { loadFont, FONTS, type FontId } from './text/fonts';
import { textToContours, placeContours } from './text/outline';
import { textItemsToShapes } from './import/text';
import { joinShapes } from './import/join';
import { finalize, type RawShape } from './import/shape';
import { profile, pocket, onLine, drill } from './core/ops';
import { planDrill } from './core/holes';
import { minOf, maxOf } from './core/util';
import { runOutToEdge, expandFreeEdge } from './core/runout';
import { createGrid, simulateToolpath, autoStock, simSummary, type Stock } from './core/sim';
import { planEntries } from './core/gcode';
import { Viewer } from './sim3d';
import { vcarve, vcarveWithFlat } from './core/vcarve';
import { inlay, inlayFlat } from './core/inlay';
import { isBinaryDxf, binaryDxfToAscii } from './import/bindxf';
import { zeroOffset, stockOffset } from './core/place';
import { parseStl, orient, turnOver, heightMap, EMPTY, StlError, type Mesh, type Oriented, type Up } from './core/mesh';
import { rough3d, finish3d } from './core/mill3d';
import { unionAll, simplify as simplifyLoops } from './core/geometry';
import { toGcode, checkBounds, describeTool, arcTestGcode, estimateMinutes, type Flavor } from './core/gcode';
import { MATERIALS, resolveMaterial, materialWarnings } from './core/presets';
import { toolWarnings } from './core/tool';
import { translateToolpath, toolpathBounds } from './core/transform';
import { buildSplitJob, type SplitJob } from './core/jobs';
import type { SplitPlan } from './core/split';
import {
  alignBack, bboxCentre, bboxOf, detectMirror, dowelHole, dowelPositions, type DowelMode, flipPoint, settingsFromMatch, suggestStock, wrongFits, type Flip,
} from './core/twosided';
import type { Direction, Loop, Pt, Tool, ToolType, Toolpath } from './core/types';

type Kind = 'outside' | 'inside' | 'on' | 'drill' | 'pocket' | 'vcarve' | 'inlay' | 'inlayflat' | 'rough3d' | 'finish3d';
const KIND_NAME: Record<Kind, string> = {
  outside: 'Cut out (outside)', inside: 'Cut out (inside)', on: 'On the line', drill: 'Drill holes', pocket: 'Pocket', vcarve: 'V-carve', inlay: 'Inlay (recess + insert)', inlayflat: 'Inlay, flat bottom',
  rough3d: '3D roughing', finish3d: '3D finishing',
};
const is3d = (k: Kind) => k === 'rough3d' || k === 'finish3d';

/** 3D model placement and step settings (the model itself and its orientation are shared by all 3D operations). */
interface M3 { x: number; y: number; top: number; stepR: number; stepF: number; leave: number; zig: boolean; cross?: boolean; rest?: number; steep?: number }

interface Settings {
  m3: M3;
  kind: Kind; ttype: ToolType; diameter: number; angle: number; tip: number; depth: number; start: number;
  dir: Direction; ramp: boolean; tabs: boolean; lead: boolean; tabn: number; tabw: number; tabh: number;
  flute: number;
  /** V-carve: what to do where a shape is wider than the bit can reach at the maximum depth */
  wide: 'clear' | 'skip' | 'flat';
  /** V-carve with a flat-bit companion: diameter of the flat bit (mm) */
  vflat: number;
  /** Inlay: how far the insert stands proud of the surface (mm) and the width of flat background cut around it (mm) */
  glue: number; moat: number;
  /** Pocket and inside cut-out: relieve inside corners so square-cornered parts fit */
  dogbone: boolean;
  side: 'front' | 'back';
  /** Side-2 shapes: drawn on the front view (see-through) or in a separate back drawing. */
  frame: 'front' | 'back';
}
interface Op {
  id: number; ids: number[]; s: Settings; tp: Toolpath | null; msgs: string[];
  /** inlay: outline of the insert blank */
  blank?: Loop[];
  /** Toolpaths that run BEFORE `tp` with a different bit (V-carve's flat-bit floor clearing) */
  pre?: Toolpath[];
  /** Plain facts about what this operation will do (not problems): shown under the operation, not in the warnings list */
  info?: string[];
}
/** Every toolpath an operation produces, in the order they run. */
const tpsOf = (o: Op): Toolpath[] => [...(o.pre ?? []), ...(o.tp ? [o.tp] : [])];

/** Make text from a file (layer names, file names) safe to put into HTML. */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const inp = (id: string) => $<HTMLInputElement>(id);
const sel = (id: string) => $<HTMLSelectElement>(id);
const cv = $<HTMLCanvasElement>('cv');
const ctx = cv.getContext('2d')!;

let shapes: Shape[] = [];
const hidden = new Set<string>();
const selected = new Set<number>();
let ops: Op[] = [];
let active: Op | null = null;
let nextOp = 1;
let view = { vx: 0, vy: 0, scale: 1 };
let frontRef: number | null = null;
let backRef: number | null = null;
/** Dowel centres (drawing frame) and diameter, for drawing the preview. */
let dowelPreview: { pts: Pt[]; dia: number; axis: Pt; flip: Flip } | null = null;

const MARGIN = 5;

/** The cutting values in use: the user's own when "Advanced" is ticked, otherwise the chosen material's preset. */
function currentMaterial() {
  const custom = document.getElementById('matcustom') as HTMLInputElement | null;
  return resolveMaterial(sel('material').value, custom?.checked
    ? { feed: +inp('matfeed').value, plungeFeed: +inp('matplunge').value, stepdown: +inp('matstep').value } : null);
}
/** Fill the advanced boxes from the preset (unless the user is editing their own). */
function syncMaterialBoxes() {
  const custom = inp('matcustom').checked;
  if (!custom) {
    const m = MATERIALS[sel('material').value];
    inp('matfeed').value = String(m.feed); inp('matplunge').value = String(m.plungeFeed); inp('matstep').value = String(m.stepdown);
  }
  for (const id of ['matfeed', 'matplunge', 'matstep']) inp(id).disabled = !custom;
}

// ---------- two-sided config ----------
interface TS {
  on: boolean; flip: Flip; pre: boolean; W: number; H: number; T: number;
  dowD: number; count: 2 | 3 | 4; dist: number; gap: number; mode: DowelMode; len: number; spoilT: number; maxD: number; bit: number; flute: number;
  split: boolean; overlap: number;
}
function ts(): TS {
  return {
    on: inp('ts_on').checked, flip: sel('tsflip').value as Flip, pre: sel('tspre').value === '1',
    W: +inp('stockw').value, H: +inp('stockh').value, T: +inp('stockt').value,
    dowD: +inp('dowd').value, count: (+sel('dowc').value === 4 ? 4 : +sel('dowc').value === 2 ? 2 : 3), dist: +inp('dowdist').value, gap: +inp('dowgap').value,
    mode: sel('dowmode').value as DowelMode, len: +inp('dowlen').value, spoilT: +inp('spoilt').value, maxD: +inp('dowmax').value, bit: +inp('dowbit').value, flute: +inp('dowflute').value,
    split: inp('sp_on').checked, overlap: +inp('spoverlap').value,
  };
}
const refsOk = () => frontRef !== null && backRef !== null && !!shapes[frontRef] && !!shapes[backRef];
const twoSided = () => ts().on && refsOk();

/**
 * Side-2 geometry is expressed in the frame seen from above AFTER turning the stock over.
 * - 'front' frame: shapes are drawn on the front view (see-through): mirror them about the turn-over line.
 * - 'back' frame: shapes come from a separate back drawing: lay its outline over the front outline.
 */
function ptsOf(s: Shape, side: 'front' | 'back', frame: 'front' | 'back'): Pt[] {
  if (side === 'back' && twoSided()) {
    const t = ts();
    if (frame === 'front') {
      const fc = bboxCentre(shapes[frontRef!].pts);
      return s.pts.map(p => flipPoint(p, fc, t.flip));
    }
    return alignBack(s.pts, shapes[frontRef!].pts, shapes[backRef!].pts, t.flip, t.pre);
  }
  return s.pts;
}

/** Guess whether a selection sits on the front view (inside the front outline) or in a back drawing. */
function guessFrame(ids: number[]): 'front' | 'back' {
  if (!refsOk() || !ids.length) return 'front';
  const sb = bboxOf(ids.flatMap(i => shapes[i].pts));
  const cx = (sb.minX + sb.maxX) / 2, cy = (sb.minY + sb.maxY) / 2;
  const fb = bboxOf(shapes[frontRef!].pts);
  return cx >= fb.minX && cx <= fb.maxX && cy >= fb.minY && cy <= fb.maxY ? 'front' : 'back';
}

// ---------- settings form ----------
function readForm(): Settings {
  return {
    kind: sel('op').value as Kind, ttype: sel('ttype').value as ToolType,
    diameter: +inp('tool').value, angle: +inp('vangle').value, tip: +inp('vtip').value,
    depth: +inp('depth').value, start: +inp('start').value || 0, dir: sel('dir').value as Direction, ramp: inp('ramp').checked,
    tabs: inp('tabs').checked, lead: inp('lead').checked, tabn: +inp('tabn').value, tabw: +inp('tabw').value, tabh: +inp('tabh').value,
    flute: +inp('flute').value, wide: sel('vwide').value as 'clear' | 'skip' | 'flat', vflat: +inp('vflat').value, glue: +inp('iglue').value, moat: +inp('imoat').value, dogbone: inp('dogbone').checked,
    side: sel('side').value as 'front' | 'back', frame: sel('frame').value as 'front' | 'back',
    m3: { x: +inp('stlx').value || 0, y: +inp('stly').value || 0, top: +inp('stltop').value || 0, stepR: +inp('stlsr').value, stepF: +inp('stlsf').value, leave: +inp('stlleave').value || 0, zig: inp('stlzig').checked, cross: inp('stlcross').checked, rest: +inp('stlrest').value || 0, steep: +inp('stlsteep').value || 0 },
  };
}
function writeForm(s: Settings) {
  if (!is3d(s.kind)) sel('op').value = s.kind;
  if (s.m3) {
    inp('stlx').value = String(s.m3.x); inp('stly').value = String(s.m3.y); inp('stltop').value = String(s.m3.top);
    inp('stlsr').value = String(s.m3.stepR); inp('stlsf').value = String(s.m3.stepF); inp('stlleave').value = String(s.m3.leave); inp('stlzig').checked = s.m3.zig; inp('stlcross').checked = !!s.m3.cross; inp('stlrest').value = String(s.m3.rest ?? 0); inp('stlsteep').value = String(s.m3.steep ?? 0);
  }
  sel('ttype').value = s.ttype; inp('tool').value = String(s.diameter);
  inp('vangle').value = String(s.angle); inp('vtip').value = String(s.tip); inp('depth').value = String(s.depth); inp('start').value = String(s.start ?? 0);
  sel('dir').value = s.dir; inp('ramp').checked = s.ramp; inp('tabs').checked = s.tabs; inp('lead').checked = !!s.lead;
  inp('tabn').value = String(s.tabn); inp('tabw').value = String(s.tabw); inp('tabh').value = String(s.tabh);
  inp('flute').value = String(s.flute); sel('vwide').value = s.wide; inp('vflat').value = String(s.vflat); inp('iglue').value = String(s.glue); inp('imoat').value = String(s.moat); inp('dogbone').checked = s.dogbone;
  sel('side').value = s.side; sel('frame').value = s.frame;
  syncVisibility();
}
function syncVisibility() {
  $('vrow').classList.toggle('hidden', sel('ttype').value !== 'vbit');
  $('tabbox').classList.toggle('hidden', !['outside', 'inside'].includes(sel('op').value));
  $('vcarverow').classList.toggle('hidden', sel('op').value !== 'vcarve');
  const inl = ['inlay', 'inlayflat'].includes(sel('op').value), flatInl = sel('op').value === 'inlayflat';
  $('inlayrow').classList.toggle('hidden', !inl);
  $('flatinlaynote').classList.toggle('hidden', !flatInl); $('vinlaynote').classList.toggle('hidden', flatInl); $('moatlbl').classList.toggle('hidden', flatInl);
  $('gluelbl').textContent = flatInl ? 'Insert proud by (mm)' : 'Glue gap (mm)';
  $('vflatrow').classList.toggle('hidden', !(sel('op').value === 'vcarve' && sel('vwide').value === 'flat'));
  $('startrow').classList.toggle('hidden', ['vcarve', 'inlay', 'inlayflat'].includes(sel('op').value));
  $('dogrow').classList.toggle('hidden', !['pocket', 'inside'].includes(sel('op').value));
  const on = ts().on;
  const sp = ts().split;
  $('spbox').classList.toggle('hidden', !sp);
  $('dowbox').classList.toggle('hidden', !(on || sp));
  // A split job always uses through-holes and the keyed pin layout, so those choices are not offered.
  $('dowcrow').classList.toggle('hidden', sp);
  $('dowmoderow').classList.toggle('hidden', sp);
  $('tsbox').classList.toggle('hidden', !on);
  $('siderow').classList.toggle('hidden', !on);
  $('framerow').classList.toggle('hidden', !(on && sel('side').value === 'back'));
}

// ---------- 3D model ----------
/** The loaded STL (as read) and the same model turned/scaled/placed for milling. Saved in projects and undo steps (`Snapshot.model`). */
let stl: { name: string; mesh: Mesh } | null = null;
let model: Oriented | null = null;
let modelImg: HTMLCanvasElement | null = null;

function compile3d(op: Op, tool: Tool, material: ReturnType<typeof currentMaterial>, msgs: string[]) {
  const s = op.s;
  if (!model) { op.msgs = ['Load the 3D model (STL) to calculate this operation. Open the file in the 3D model panel.']; return; }
  if (!(s.diameter > 0)) { op.msgs = ['Enter a bit diameter.']; return; }
  if (s.ttype === 'vbit') { op.msgs = ['3D carving needs a flat or ball nose bit.']; return; }
  const m3 = s.m3;
  const step = s.kind === 'rough3d' ? m3.stepR : m3.stepF;
  if (!(step > 0)) { op.msgs = ['Enter a step-over (percent of the bit diameter).']; return; }
  // Side 2 carves the underside of the same model: the stock is turned over about the flip line, so the model is too.
  const back = ts().on && s.side === 'back';
  let mdl: Oriented = model, at = { x: m3.x, y: m3.y }, top = m3.top;
  if (back) {
    if (!refsOk()) { op.msgs = ['Side 2 needs the front and back outlines set (see Two-sided job), so the turn-over line is known.']; return; }
    const t = ts();
    if (!(t.T > 0)) { op.msgs = ['Enter the stock thickness (Two-sided job) so the model can be turned over.']; return; }
    const r2 = turnOver(model, { x: m3.x, y: m3.y, top: m3.top }, bboxCentre(shapes[frontRef!].pts), t.flip, t.T);
    mdl = r2.model; at = { x: r2.x, y: r2.y }; top = r2.top;
    msgs.push('Side 2 carves the underside of the model, so the model must be a closed solid. A model that is only a surface (no underside) gives a meaningless side 2.');
    if (top < -0.01) msgs.push(`The model is taller than the stock: its underside would stand ${+(-top).toFixed(2)} mm above the stock on side 2.`);
  }
  msgs.push(...toolWarnings(tool, mdl.h + top, 'pocket'));
  const common = { tool, material, direction: s.dir, zigzag: m3.zig, top, at, stepover: s.diameter * step / 100 };
  const r = s.kind === 'rough3d' ? rough3d(mdl, { ...common, stepdown: material.stepdown, leave: m3.leave, rest: m3.rest }) : finish3d(mdl, { ...common, cross: !!m3.cross, steep: m3.steep });
  op.tp = r.toolpath;
  if (back) op.tp.name = `SIDE 2: ${op.tp.name}`;
  msgs.push(...r.warnings);
  if (s.kind === 'finish3d' && s.ttype === 'flat') msgs.push('A flat bit leaves small steps on sloped surfaces. A ball nose bit gives a smooth finish.');
  if (s.kind === 'rough3d' && m3.leave <= 0) msgs.push('Stock left by roughing is 0, so the roughing pass cuts right to the model with no allowance for finishing.');
  if (!op.tp.cuts.length && !r.warnings.length) msgs.push('Nothing to cut.');
  op.msgs = msgs;
}

/** A shaded top view of the model for the drawing area. */
function modelPreview(m: Oriented): HTMLCanvasElement {
  const hm = heightMap(m, Math.max(m.w, m.d) / 360);
  const { nx, ny, cell, z } = hm;
  const c = document.createElement('canvas');
  c.width = nx; c.height = ny;
  const g = c.getContext('2d')!;
  const im = g.createImageData(nx, ny);
  let lo = Infinity;
  for (let k = 0; k < z.length; k++) if (z[k] > EMPTY) lo = Math.min(lo, z[k]);
  const range = Math.max(1e-6, -lo);
  const at = (i: number, j: number, fb: number) => { const v = z[Math.min(ny - 1, Math.max(0, j)) * nx + Math.min(nx - 1, Math.max(0, i))]; return v > EMPTY ? v : fb; };
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const v = z[j * nx + i];
    const o = ((ny - 1 - j) * nx + i) * 4;
    if (v <= EMPTY) { im.data[o + 3] = 0; continue; }
    const zx = (at(i + 1, j, v) - at(i - 1, j, v)) / (2 * cell), zy = (at(i, j + 1, v) - at(i, j - 1, v)) / (2 * cell);
    const len = Math.hypot(zx, zy, 1);
    const lit = Math.max(0, (zx * 0.5 - zy * 0.5 + 0.7) / len); // light from the upper left
    const t = 1 - (-v) / range; // 1 = highest
    const k = 0.35 + 0.65 * Math.min(1, lit);
    im.data[o] = (110 + 110 * t) * k; im.data[o + 1] = (85 + 100 * t) * k; im.data[o + 2] = (50 + 70 * t) * k; im.data[o + 3] = 255;
  }
  g.putImageData(im, 0, 0);
  return c;
}

function rebuildModel() {
  if (!stl) { model = null; modelImg = null; $('stlinfo').innerHTML = '<small>Load a 3D model to carve its top surface.</small>'; return; }
  model = orient(stl.mesh, { up: sel('stlup').value as Up, spin: +sel('stlspin').value, scale: +sel('stlunits').value });
  modelImg = modelPreview(model);
  const odd = model.h < 0.5 ? ' That is very shallow: is the "Top of model" choice right?' : model.w > 2000 || model.d > 2000 ? ' That is very large: check the model units.' : '';
  $('stlinfo').innerHTML = `<b>${esc(stl.name)}</b><br>${mmAndIn(model.w)} wide &times; ${mmAndIn(model.d)} deep &times; ${mmAndIn(model.h)} high.${odd}`;
}

// ---------- toolpath generation ----------
function compile(op: Op) {
  const s = op.s;
  const msgs: string[] = [];
  op.tp = null; op.pre = undefined; op.info = undefined;
  const sh = op.ids.map(i => shapes[i]).filter(Boolean);
  const tool: Tool = { type: s.ttype, diameter: s.diameter, fluteLength: s.flute > 0 ? s.flute : undefined };
  if (s.ttype === 'vbit') { tool.angle = s.angle; tool.tipDiameter = s.tip; }
  const material = currentMaterial();
  if (inp('matcustom').checked) msgs.push(...materialWarnings(material, s.diameter));
  const params = { tool, material, depth: s.depth, start: ['vcarve', 'inlay', 'inlayflat'].includes(s.kind) ? 0 : (s.start ?? 0), direction: s.dir, ramp: s.ramp ? { maxAngleDeg: 3 } : undefined };
  if (is3d(s.kind)) { compile3d(op, tool, material, msgs); return; }
  if (!(s.diameter > 0) || !(s.depth > 0)) { op.msgs = ['Enter a bit diameter and depth.']; return; }
  if (params.start >= s.depth - 1e-9) { op.msgs = [`The start depth (${params.start} mm) must be less than the depth (${s.depth} mm): there is nothing to cut.`]; return; }
  if (params.start > 0) msgs.push(`Starts ${params.start} mm down: the bit rapids down to ${params.start - 1} mm below the top, so the material above that must already be cut away at these spots (the simulation will show if not).`);
  const side = ts().on ? s.side : 'front';
  if (side === 'back' && !refsOk()) {
    op.msgs = ['Side 2 needs the front and back outlines set (see "Two-sided job").']; return;
  }
  msgs.push(...toolWarnings(tool, s.depth, s.kind === 'pocket' ? 'pocket' : s.kind === 'vcarve' || s.kind === 'inlay' ? 'vcarve' : 'profile'));
  // a shape with an open side (see Run open line out to outline): a pocket lets the bit run out past it, by the bit radius plus a little
  const closed = sh.filter(x => x.closed).flatMap(x => { const pts = ptsOf(x, side, s.frame); return x.free && s.kind === 'pocket' ? expandFreeEdge(pts, x.free, s.diameter / 2 + 0.5) : [pts]; });
  const open = sh.filter(x => !x.closed);
  if (s.kind === 'on') {
    op.tp = onLine(sh.map(x => ({ pts: ptsOf(x, side, s.frame), closed: x.closed })), params);
  } else {
    if (open.length) msgs.push(`${open.length} open line(s) skipped - only "on the line" can follow an open line.`);
    if (!closed.length) { op.msgs = [...msgs, 'No closed shapes in this selection.']; return; }
    if (s.kind === 'drill') {
      const plan = planDrill(closed, params);
      msgs.push(...plan.warnings);
      op.info = plan.info;
      op.tp = { name: '', tool, cuts: plan.cuts, feed: material.feed, plungeFeed: material.plungeFeed };
    } else if (s.kind === 'inlayflat') {
      op.blank = undefined;
      if (s.ttype === 'vbit') { op.msgs = [...msgs, 'Flat-bottom inlay needs a flat bit.']; return; }
      const r = inlayFlat(closed, { tool, material, depth: s.depth, proud: s.glue, direction: s.dir, ramp: s.ramp ? { maxAngleDeg: 3 } : undefined });
      op.tp = r.toolpath;
      msgs.push(...r.warnings);
    } else if (s.kind === 'inlay') {
      op.blank = undefined;
      if (s.ttype !== 'vbit') { op.msgs = [...msgs, 'Inlay needs a V-bit: choose "V-bit" (or pick one under Common bits).']; return; }
      const r = inlay(closed, { tool, material, depth: s.depth, glueGap: s.glue, moat: s.moat, direction: s.dir, ramp: s.ramp ? { maxAngleDeg: 3 } : undefined });
      op.tp = r.toolpath; op.blank = r.blank;
      msgs.push(...r.warnings);
    } else if (s.kind === 'vcarve') {
      if (s.ttype !== 'vbit') { op.msgs = [...msgs, 'V-carving needs a V-bit: choose "V-bit" (or pick one under Common bits).']; return; }
      if (s.wide === 'flat') {
        if (!(s.vflat > 0)) { op.msgs = [...msgs, 'Enter the diameter of the flat bit.']; return; }
        const r = vcarveWithFlat(closed, { tool, material, maxDepth: s.depth, direction: s.dir, ramp: s.ramp ? { maxAngleDeg: 3 } : undefined, flat: { type: 'flat', diameter: s.vflat } });
        op.tp = r.v; op.pre = r.flat ? [r.flat] : [];
        msgs.push(...r.warnings);
        if (r.flat) msgs.push(`This job uses two bits: the ${s.vflat} mm flat bit clears the wide floor first, then the program pauses for you to change to the V-bit.`);
      } else op.tp = vcarve(closed, { tool, material, maxDepth: s.depth, direction: s.dir, wide: s.wide, ramp: s.ramp ? { maxAngleDeg: 3 } : undefined });
      const wanted = op.tp.meta?.wantedDepth ?? 0, used = op.tp.meta?.usedCap ?? s.depth;
      if (wanted > used + 0.05 && s.wide !== 'flat') {
        msgs.push(`The widest strokes need ${wanted.toFixed(1)} mm depth for the V to reach their edges, but the maximum is ${used.toFixed(1)} mm. ` +
          (s.wide === 'clear' ? 'Those wide areas are cleared flat at the maximum depth (slower, and not a clean V). ' : 'Those wide areas are left with an uncut centre. ') +
          'For a clean V everywhere, allow a deeper maximum depth, use a wider-angle bit (90 degrees is shallower than 60), or make the lettering smaller.');
      }
      if (s.tip > 0 && s.tip / 2 > 0.5) msgs.push(`The tip of this V-bit is ${s.tip} mm wide, so strokes thinner than that are only engraved on the surface.`);
    } else if (s.kind === 'pocket') {
      op.tp = pocket(closed, { ...params, stepoverFraction: 0.4, dogbone: s.dogbone });
      if (s.dogbone && s.ttype !== 'flat') msgs.push('Dogbone corners are meant for a flat end mill. With other bits the relief is not accurate.');
    } else {
      const tabs = s.tabs ? { count: s.tabn, width: s.tabw, height: s.tabh } : undefined;
      if (tabs && tabs.height >= s.depth) msgs.push('Tab height is as tall as the cut, so no tabs would be left. Lower the tab height.');
      op.tp = profile(closed, s.kind, { ...params, tabs, dogbone: s.dogbone, lead: s.lead ? Math.min(8, Math.max(2, s.diameter)) : 0 });
      if (s.dogbone && s.kind === 'inside' && s.ttype !== 'flat') msgs.push('Dogbone corners are meant for a flat end mill. With other bits the relief is not accurate.');
    }
  }
  if (!op.tp.cuts.length) msgs.push('Nothing to cut - is the bit too big for this shape?');
  op.tp.name = `${side === 'back' ? 'SIDE 2: ' : ''}${KIND_NAME[s.kind]} - ${sh.length} shape(s)`;
  op.msgs = msgs;
}

const sideOf = (o: Op): 'front' | 'back' => (ts().on ? o.s.side : 'front');

let splitPreview: { plan: SplitPlan; pins: Pt[][]; dia: number } | null = null;

/** Build the segmented job, or null if the part fits the work area (or there is nothing to cut yet). */
function makeSplit(front: Toolpath[], back: Toolpath[], t: TS, msgs: string[]): SplitJob | null {
  splitPreview = null;
  const twoSidedJob = t.on && refsOk();
  if (twoSidedJob && t.flip === 'lr') {
    msgs.push('Splitting a long part works with a top-to-bottom turn-over (rolling it about its long axis). Choose that, or turn splitting off.');
    return null;
  }
  const sides = twoSidedJob ? [front, back] : [front];
  const ob = toolpathBounds(sides.flat());
  if (ob.empty) { $('spinfo').textContent = 'Add operations first.'; return null; }
  const axis = twoSidedJob ? bboxCentre(shapes[frontRef!].pts) : { x: (ob.minX + ob.maxX) / 2, y: (ob.minY + ob.maxY) / 2 };
  const limits = [t.flute, t.maxD].filter(v => v > 0);
  const cap = limits.length ? Math.min(...limits) : 0;
  const hole = dowelHole({ mode: 'spoilfirst', stockT: t.T, dowelLen: t.len, dowelDia: t.dowD, spoilT: t.spoilT, maxDepth: cap });
  const job = buildSplitJob({
    sides, part: ob, axis, bedX: +inp('bedx').value, bedY: +inp('bedy').value, margin: MARGIN, overlap: t.overlap,
    pin: { distance: t.dist, pairGap: t.gap, halfSpan: 10 }, dowelDia: t.dowD, stockT: t.T, spoilDepth: hole.spoilDepth,
    bit: { type: 'flat', diameter: t.bit, fluteLength: t.flute > 0 ? t.flute : undefined }, material: currentMaterial(),
  });
  const len = ob.maxX - ob.minX;
  if (job.plan.n === 1) {
    $('spinfo').textContent = `Your part is ${Math.round(len)} mm long and fits the ${Math.round(job.plan.segLen)} mm usable work area: no split needed.`;
    return null;
  }
  $('spinfo').textContent = `Part ${Math.round(len)} mm long: ${job.plan.n} segments of up to ${Math.round(job.plan.segLen)} mm, ` +
    `sliding the stock ${Math.round(job.plan.shift)} mm each time. Stock needed: about ${Math.ceil(job.stock.length)} x ${Math.ceil(job.stock.width)} mm.` +
    (twoSidedJob ? ' Pins are mirrored about the turn-over line so they also register the flip.' : '');
  msgs.push(...job.warnings);
  // Dowel fit problems (too long / too short / thin spoilboard) apply here too; the holes themselves are through-holes.
  msgs.push(...hole.warnings.filter(m => /too long|too thin|stand up/.test(m)).map(m => `Dowels: ${m}`));
  const through = t.T + 2;
  if (cap > 0 && through > cap) {
    msgs.push(`Dowels: the registration holes go right through ${t.T} mm stock and need ${Math.ceil(through)} mm, but your bit can only cut ${cap} mm. Use a longer bit or thinner stock.`);
  }
  if (cap > 0 && hole.spoilDepth > cap) msgs.push(`Dowels: the spoilboard holes need ${Math.ceil(hole.spoilDepth)} mm but your bit can only cut ${cap} mm. Use a shorter dowel.`);
  splitPreview = { plan: job.plan, pins: job.pinsDraw, dia: t.dowD };
  return job;
}

/** Where X/Y zero is: the work-area corner (default), the part's lower-left corner or the part's centre. Two-sided and split jobs always use the corner. */
function zeroMode(): 'corner' | 'part' | 'centre' {
  return ts().on || ts().split ? 'corner' : (sel('zero').value as 'corner' | 'part' | 'centre');
}
/** The box around every shape that has an operation on it (and the 3D model if there is one): what "the part" means for zero. */
function partBox(): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const boxes = [...new Set(ops.filter(o => o.tp && !is3d(o.s.kind)).flatMap(o => o.ids))].map(i => shapes[i]?.bbox).filter(Boolean);
  const o3 = ops.find(o => o.tp && is3d(o.s.kind));
  if (o3 && model) boxes.push({ minX: o3.s.m3.x, minY: o3.s.m3.y, maxX: o3.s.m3.x + model.w, maxY: o3.s.m3.y + model.d });
  if (!boxes.length) return null;
  return { minX: minOf(boxes.map(b => b.minX)), minY: minOf(boxes.map(b => b.minY)), maxX: maxOf(boxes.map(b => b.maxX)), maxY: maxOf(boxes.map(b => b.maxY)) };
}
function zeroText(): string {
  const z = zeroMode();
  return z === 'corner' ? 'Zero X/Y at the bottom-left of your work area; Z zero on the top of the material.' : z === 'part' ? 'Zero X/Y at the lower-left corner of the part; Z zero on the top of the material.' : 'Zero X/Y at the centre of the part; Z zero on the top of the material.';
}

/** Position everything in machine coordinates and split into the two setups. */
function placed(): { paths: Toolpath[]; side0: Toolpath[]; side1: Toolpath[]; side2: Toolpath[]; msgs: string[]; split: SplitJob | null } {
  const msgs: string[] = [];
  const t = ts();
  const front = ops.filter(o => o.tp && sideOf(o) === 'front').flatMap(tpsOf);
  const back = ops.filter(o => o.tp && sideOf(o) === 'back').flatMap(tpsOf);
  dowelPreview = null;
  splitPreview = null;
  if (t.split) {
    const job = makeSplit(front, back, t, msgs);
    if (job) return { paths: job.files.flatMap(f => f.paths), side0: [], side1: [], side2: [], msgs, split: job };
  }
  if (!t.on || !refsOk()) {
    const raw = [...front, ...back];
    const b = toolpathBounds(raw);
    if (b.empty) return { paths: [], side0: [], side1: [], side2: [], msgs, split: null };
    const z = zeroMode();
    const { dx, dy } = zeroOffset(z, b, z === 'corner' ? null : partBox(), MARGIN);
    const all = raw.map(p => translateToolpath(p, dx, dy));
    return { paths: all, side0: [], side1: all, side2: [], msgs, split: null };
  }
  const frontPts = shapes[frontRef!].pts;
  const fc = bboxCentre(frontPts);
  const ob = toolpathBounds([...front, ...back]);
  const fb = bboxOf(frontPts);
  const part = ob.empty ? fb : {
    minX: Math.min(ob.minX, fb.minX), minY: Math.min(ob.minY, fb.minY),
    maxX: Math.max(ob.maxX, fb.maxX), maxY: Math.max(ob.maxY, fb.maxY),
  };
  const layout = { count: t.count, distance: t.dist, pairSpacing: t.gap };
  const centres = dowelPositions(part, fc, t.flip, layout);
  // The deepest the drill may go is the smaller of the bit's cutting length and the user's own limit.
  const limits = [t.flute, t.maxD].filter(v => v > 0);
  const hole = dowelHole({
    mode: t.mode, stockT: t.T, dowelLen: t.len, dowelDia: t.dowD, spoilT: t.spoilT, maxDepth: limits.length ? Math.min(...limits) : 0,
  });
  const depth = hole.depth;
  const info = $('dowinfo');
  info.textContent = hole.summary;
  info.style.background = hole.warnings.length ? '#fdecea' : '#e8f5e9';
  const dowelTp = drill(centres, {
    tool: { type: 'flat', diameter: t.bit, fluteLength: t.flute > 0 ? t.flute : undefined }, material: currentMaterial(),
    depth, direction: 'climb', ramp: { maxAngleDeg: 3 }, holeDiameter: t.dowD,
  });
  dowelPreview = { pts: centres, dia: t.dowD, axis: fc, flip: t.flip };
  const wrong = wrongFits(centres, fc, t.flip, Math.max(1, t.dowD * 0.4));
  if (wrong.length) {
    msgs.push(`With ${t.count} dowels the stock could also be seated ${wrong.join(' or ')}. Choose "3 keyed" so it only fits one way.`);
  }
  msgs.push(...hole.warnings.map(m => `Dowel holes: ${m}`));
  if (!dowelTp.cuts.length) msgs.push('The dowel drill bit is bigger than the dowel hole.');
  // Stock suggestion and placement: stock centred on the turn-over line, part centred in the stock.
  const sg = suggestStock(part, fc, t.flip, layout, t.dowD);
  $('tsstock').textContent = `Smallest stock that fits part and dowels: ${Math.ceil(sg.width)} x ${Math.ceil(sg.height)} mm. Part is centred in the stock; zero X/Y at the stock's bottom-left corner.`;
  if (!inp('stockw').value) inp('stockw').value = String(Math.ceil(sg.width));
  if (!inp('stockh').value) inp('stockh').value = String(Math.ceil(sg.height));
  const W = +inp('stockw').value || sg.width, H = +inp('stockh').value || sg.height;
  if (W < sg.width - 0.5 || H < sg.height - 0.5) msgs.push(`Stock is too small for part plus dowels: needs ${Math.ceil(sg.width)} x ${Math.ceil(sg.height)} mm.`);
  const { dx, dy } = stockOffset(W, H, fc);
  const side1 = [dowelTp, ...front].map(p => translateToolpath(p, dx, dy));
  const side2 = back.map(p => translateToolpath(p, dx, dy));
  // Spoilboard-first: a separate job drills the empty spoilboard at the same positions, before any stock is mounted.
  const side0: Toolpath[] = [];
  if (t.mode === 'spoilfirst') {
    const spoilTp = drill(centres, {
      tool: { type: 'flat', diameter: t.bit, fluteLength: t.flute > 0 ? t.flute : undefined }, material: currentMaterial(),
      depth: hole.spoilDepth, direction: 'climb', ramp: { maxAngleDeg: 3 }, holeDiameter: t.dowD,
    });
    spoilTp.name = `STEP 0: Drill ${t.dowD}mm holes in the spoilboard`;
    side0.push(translateToolpath(spoilTp, dx, dy));
  }
  if (!back.length) msgs.push('No side 2 operations yet: select back-side shapes and set "Which side" to Side 2.');
  return { paths: [...side1, ...side2], side0, side1, side2, msgs, split: null };
}

function fmtMin(m: number): string {
  if (m < 1) return `${Math.round(m * 60)} s`;
  const h = Math.floor(m / 60), r = Math.round(m % 60);
  return h ? `${h} h ${r} min` : `${Math.round(m)} min`;
}

// Common bits: fill in the bit fields in one go.
sel('bitpreset').addEventListener('input', () => {
  const v = sel('bitpreset').value;
  if (!v) return;
  const [type, dia, a, b, c] = v.split(',');
  sel('ttype').value = type; inp('tool').value = dia;
  if (type === 'vbit') { inp('vangle').value = a; inp('vtip').value = b; inp('flute').value = c; } else inp('flute').value = a;
  sel('ttype').dispatchEvent(new Event('input', { bubbles: true }));
  sel('bitpreset').value = '';
});

function refreshUi() {
  syncVisibility();
  // ops list
  $('ops').innerHTML = ops.map((o, i) =>
    `<div class="op ${o === active ? 'active' : ''}" data-id="${o.id}"><b>${i + 1}. ${KIND_NAME[o.s.kind]}${ts().on ? ` - side ${o.s.side === 'back' ? 2 : 1}` : ''}</b><br>` +
    `<small>${is3d(o.s.kind) ? `${stl ? esc(stl.name) : 'model'}` : `${o.ids.length} shape(s)`} &middot; ${describeTool({ type: o.s.ttype, diameter: o.s.diameter, angle: o.s.angle })}${is3d(o.s.kind) ? '' : ` &middot; ${o.s.start > 0 && !['vcarve', 'inlay'].includes(o.s.kind) ? `${o.s.start} to ${o.s.depth}` : o.s.depth} mm deep`}</small>` +
    (o.info?.length ? `<br><small style="color:#37474f">${o.info.map(esc).join('<br>')}</small>` : '') + `</div>`).join('') +
    (ops.length ? '<small style="display:block;margin:4px 0;color:#546e7a">Click an operation to change its settings, move it or delete it.</small>' : '');
  $('ops').querySelectorAll<HTMLElement>('.op').forEach(el => el.addEventListener('click', () => {
    active = ops.find(o => o.id === +el.dataset.id!)!;
    selected.clear(); active.ids.forEach(i => selected.add(i));
    writeForm(active.s); refreshUi(); draw();
  }));
  $('sel').textContent = selected.size ? `${selected.size} shape(s) selected` : 'Nothing selected - click lines in the drawing';
  const si = $('selinfo');
  if (selected.size) {
    const ss = [...selected].map(i => shapes[i]).filter(Boolean);
    const w = Math.max(...ss.map(s => s.bbox.maxX)) - Math.min(...ss.map(s => s.bbox.minX));
    const h = Math.max(...ss.map(s => s.bbox.maxY)) - Math.min(...ss.map(s => s.bbox.minY));
    si.classList.remove('hidden');
    si.innerHTML = `<b>Selection</b> ${mmAndIn(w)} &times; ${mmAndIn(h)}`;
  } else si.classList.add('hidden');
  ($('addop') as HTMLButtonElement).disabled = selected.size === 0;
  ($('delop') as HTMLButtonElement).disabled = !active;
  // warnings
  const w: string[] = [];
  ops.forEach((o, i) => o.msgs.forEach(m => w.push(`Op ${i + 1}: ${m}`)));
  // 3D finishing with no roughing before it would plunge a ball nose into uncut stock
  ops.forEach((o, i) => {
    if (o.s.kind === 'finish3d' && o.tp?.cuts.length && model && model.h + o.s.m3.top > currentMaterial().stepdown * 1.5 && !ops.slice(0, i).some(r => r.s.kind === 'rough3d' && r.tp?.cuts.length)) {
      w.push(`Op ${i + 1}: there is no 3D roughing before this finishing pass. A finishing bit cannot remove a deep block of stock in one go: add a roughing operation first (and make sure it comes earlier in the list).`);
    }
  });
  const p = placed();
  w.push(...(ts().on || ts().split ? p.msgs : []));
  if (p.paths.length && zeroMode() === 'corner') w.push(...checkBounds(p.paths, { width: +inp('bedx').value, depthY: +inp('bedy').value }));
  else if (p.paths.length) {
    const bb = toolpathBounds(p.paths);
    if (bb.maxX - bb.minX > +inp('bedx').value || bb.maxY - bb.minY > +inp('bedy').value) w.push('The part is bigger than your work area.');
    w.push('With zero at the part, the program cannot check the machine limits: make sure the part fits the travel from where you set zero.');
  }
  $('zeronote').textContent =zeroText() + (zeroMode() === 'corner' ? ' Your part is placed 5 mm in from that corner.' : '');
  if (ts().on && !p.split) {
    const t = ts();
    if (t.W > +inp('bedx').value || t.H > +inp('bedy').value) w.push('Stock is bigger than your work area.');
    if (t.on && !refsOk()) w.push('Set the front and back outlines (select a shape, then use the buttons under "Two-sided job").');
  }
  $('warn').innerHTML = w.map(m => `<div>${m}</div>`).join('');
  const eta = p.split
    ? p.split.files.map(f => `${f.name.replace('.gcode', '')}: ${fmtMin(estimateMinutes(f.paths).total)}`).join(' &middot; ')
    : p.paths.length ? `about ${fmtMin(estimateMinutes(p.paths).total)} (${fmtMin(estimateMinutes(p.paths).cutting)} cutting)` : '';
  $('eta').innerHTML = eta ? `<b>Estimated run time</b> ${eta}<br><small>A guide only: real jobs run a little longer because of acceleration.</small>` : '';
  const splitting = !!p.split;
  $('dl').textContent = ts().on && refsOk() ? 'Download side 1 G-code (dowels + front)' : 'Download G-code';
  $('dl').classList.toggle('hidden', splitting);
  $('dl2').classList.toggle('hidden', splitting || !(ts().on && refsOk()));
  $('dl0').classList.toggle('hidden', splitting || !(ts().on && refsOk() && ts().mode === 'spoilfirst'));
  // One button per file of a split job, in the order they are run.
  const box = $('splitfiles');
  box.innerHTML = '';
  p.split?.files.forEach((f, i) => {
    const b = document.createElement('button');
    b.className = 'big';
    b.textContent = `${i + 1}. Download ${f.name.replace('.gcode', '')}`;
    b.addEventListener('click', () => download(f.paths, f.name, f.note));
    box.appendChild(b);
  });
}


function renderLayers() {
  const names = [...new Set(shapes.map(s => s.layer))];
  const box = $('layers');
  box.classList.toggle('hidden', !names.length);
  $('selbtns').classList.toggle('hidden', !names.length);
  const head = `<div class="layerbtns" style="display:flex;gap:4px;margin-bottom:4px"><button data-all="show">Show all</button><button data-all="hide">Hide all</button><button data-all="sel">Select all shown</button></div>`;
  box.innerHTML = head + names.map(n => {
    const c = shapes.filter(s => s.layer === n);
    const open = c.filter(s => !s.closed).length;
    return `<div class="layer"><input type="checkbox" data-l="${esc(n)}" ${hidden.has(n) ? '' : 'checked'} title="Show/hide">` +
      `<span class="n" title="${esc(n)}">${esc(n)}</span><small>${c.length}${open ? ` (${open} open)` : ''}</small>` +
      `<button data-s="${esc(n)}">Select</button></div>`;
  }).join('');
  box.querySelectorAll<HTMLButtonElement>('button[data-all]').forEach(el => el.addEventListener('click', () => {
    const what = el.dataset.all;
    if (what === 'sel') {
      shapes.filter(s => !hidden.has(s.layer)).forEach(s => selected.add(s.id));
      selectionChanged();
      return;
    }
    hidden.clear();
    if (what === 'hide') names.forEach(n => hidden.add(n));
    // a hidden shape cannot stay selected
    [...selected].forEach(i => { if (shapes[i] && hidden.has(shapes[i].layer)) selected.delete(i); });
    renderLayers(); selectionChanged(); commit();
  }));
  box.querySelectorAll<HTMLInputElement>('input[data-l]').forEach(el => el.addEventListener('change', () => {
    el.checked ? hidden.delete(el.dataset.l!) : hidden.add(el.dataset.l!);
    draw();
  }));
  box.querySelectorAll<HTMLButtonElement>('button[data-s]').forEach(el => el.addEventListener('click', () => {
    const ids = shapes.filter(s => s.layer === el.dataset.s && !hidden.has(s.layer)).map(s => s.id);
    const all = ids.every(i => selected.has(i));
    ids.forEach(i => (all ? selected.delete(i) : selected.add(i)));
    selectionChanged();
  }));
}

function selectionChanged() {
  active = null;
  refreshUi(); draw();
}

// ---------- drawing ----------
const sx = (x: number) => (x - view.vx) * view.scale;
const sy = (y: number) => cv.clientHeight - (y - view.vy) * view.scale;
const wx = (px: number) => px / view.scale + view.vx;
const wy = (py: number) => (cv.clientHeight - py) / view.scale + view.vy;

function fit() {
  const vis = shapes.filter(s => !hidden.has(s.layer));
  const boxes = vis.map(s => s.bbox);
  if (model) { const x = +inp('stlx').value || 0, y = +inp('stly').value || 0; boxes.push({ minX: x, minY: y, maxX: x + model.w, maxY: y + model.d }); }
  if (!boxes.length) return;
  const minX = Math.min(...boxes.map(b => b.minX)), maxX = Math.max(...boxes.map(b => b.maxX));
  const minY = Math.min(...boxes.map(b => b.minY)), maxY = Math.max(...boxes.map(b => b.maxY));
  const pad = 30;
  view.scale = Math.min((cv.clientWidth - 2 * pad) / (maxX - minX || 1), (cv.clientHeight - 2 * pad) / (maxY - minY || 1));
  view.vx = minX - pad / view.scale; view.vy = minY - pad / view.scale;
}

function trace(pts: { x: number; y: number }[], closed: boolean) {
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) i ? ctx.lineTo(sx(pts[i].x), sy(pts[i].y)) : ctx.moveTo(sx(pts[i].x), sy(pts[i].y));
  if (closed) ctx.closePath();
}

let drag: { x0: number; y0: number; x1: number; y1: number; box: boolean; moved: boolean } | null = null;

function draw() {
  const dpr = devicePixelRatio || 1;
  if (cv.width !== cv.clientWidth * dpr || cv.height !== cv.clientHeight * dpr) {
    cv.width = cv.clientWidth * dpr; cv.height = cv.clientHeight * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cv.clientWidth, cv.clientHeight);
  const inView = (s: Shape) => sx(s.bbox.maxX) > -10 && sx(s.bbox.minX) < cv.clientWidth + 10
    && sy(s.bbox.minY) > -10 && sy(s.bbox.maxY) < cv.clientHeight + 10;
  const used = new Set(ops.flatMap(o => o.ids));
  ctx.lineJoin = 'round';
  if (model && modelImg) {
    const mx = +inp('stlx').value || 0, my = +inp('stly').value || 0;
    ctx.save(); ctx.globalAlpha = 0.75; ctx.imageSmoothingEnabled = true;
    ctx.drawImage(modelImg, sx(mx), sy(my + model.d), model.w * view.scale, model.d * view.scale);
    ctx.restore();
  }
  for (const s of shapes) {
    if (hidden.has(s.layer) || !inView(s)) continue;
    const isSel = selected.has(s.id);
    ctx.strokeStyle = isSel ? '#e65100' : used.has(s.id) ? '#7a9fd6' : '#888';
    ctx.lineWidth = isSel ? 2.5 : 1;
    trace(s.pts, s.closed); ctx.stroke();
  }
  // toolpaths (deepest level)
  for (const o of ops) {
    // a companion pass that runs first with another bit (e.g. the flat bit clearing a V-carve floor), in green
    for (const pre of o.pre ?? []) {
      ctx.strokeStyle = '#00897b'; ctx.setLineDash([]); ctx.lineWidth = 1;
      for (const c of pre.cuts) { trace(c.loop, c.closed); ctx.stroke(); }
    }
    if (!o.tp?.cuts.length) continue;
    if (is3d(o.s.kind)) { // many thin passes: draw them as one batch
      ctx.save(); ctx.strokeStyle = sideOf(o) === 'back' ? (o.s.kind === 'rough3d' ? '#ab47bc' : '#6a1b9a') : o.s.kind === 'rough3d' ? '#ef6c00' : '#1565c0'; ctx.globalAlpha = o === active ? 0.95 : 0.55; ctx.lineWidth = 0.7; ctx.setLineDash([]);
      ctx.beginPath();
      for (const c of o.tp.cuts) c.loop.forEach((p, i) => i ? ctx.lineTo(sx(p.x), sy(p.y)) : ctx.moveTo(sx(p.x), sy(p.y)));
      ctx.stroke(); ctx.restore();
      continue;
    }
    if (o.s.kind === 'drill') { // hole markers (rings for spiralled holes)
      ctx.save(); ctx.strokeStyle = o === active ? '#b71c1c' : '#d32f2f'; ctx.lineWidth = 1.5; ctx.setLineDash([]);
      for (const c of o.tp.cuts) {
        if (c.loop.length > 3) { trace(c.loop, c.closed); ctx.stroke(); continue; }
        const p = c.loop[0], r = Math.max(3, (o.s.diameter / 2) * view.scale);
        ctx.beginPath(); ctx.arc(sx(p.x), sy(p.y), r, 0, 7); ctx.moveTo(sx(p.x) - r, sy(p.y)); ctx.lineTo(sx(p.x) + r, sy(p.y)); ctx.moveTo(sx(p.x), sy(p.y) - r); ctx.lineTo(sx(p.x), sy(p.y) + r); ctx.stroke();
      }
      ctx.restore();
      continue;
    }
    const last = o.tp.cuts[o.tp.cuts.length - 1].z;
    const tabTop = o.s.tabs ? -o.s.depth + o.s.tabh : null;
    const back = sideOf(o) === 'back';
    ctx.strokeStyle = back ? (o === active ? '#4a148c' : '#8e24aa') : (o === active ? '#0d47a1' : '#1565c0');
    ctx.setLineDash(back ? [6, 3] : []);
    ctx.lineWidth = o === active ? 2 : 1.2;
    for (const c of o.tp.cuts) {
      // V-carve passes sit at different depths along the skeleton, so draw all of them; other operations show the deepest pass.
      if (o.s.kind !== 'vcarve' && o.s.kind !== 'inlay' && o.s.kind !== 'inlayflat' && c.z !== last) continue;
      // inlay: the recess is blue, the insert (cut on a second, mirrored board) is purple and dashed
      if (c.tag === 'male') { ctx.strokeStyle = '#8e24aa'; ctx.setLineDash([5, 3]); } else if (c.tag === 'female') { ctx.strokeStyle = '#1565c0'; ctx.setLineDash([]); }
      trace(c.loop, c.closed); ctx.stroke();
      if (tabTop !== null) {
        ctx.save(); ctx.strokeStyle = '#ffb300'; ctx.lineWidth = 5; ctx.lineCap = 'round';
        for (let i = 1; i < c.moves.length; i++) {
          const a = c.moves[i - 1], b = c.moves[i];
          if (Math.abs(a.z - tabTop) < 1e-6 && Math.abs(b.z - tabTop) < 1e-6 && (a.x !== b.x || a.y !== b.y)) {
            ctx.beginPath(); ctx.moveTo(sx(a.x), sy(a.y)); ctx.lineTo(sx(b.x), sy(b.y)); ctx.stroke();
          }
        }
        ctx.restore();
      }
      if (c.loop.length > 3) {
        const a = c.loop[0], b = c.loop[3];
        ctx.save(); ctx.translate(sx(b.x), sy(b.y)); ctx.rotate(Math.atan2(-(b.y - a.y), b.x - a.x));
        ctx.fillStyle = '#d32f2f'; ctx.beginPath(); ctx.moveTo(8, 0); ctx.lineTo(-5, 5); ctx.lineTo(-5, -5); ctx.fill(); ctx.restore();
      }
    }
  }
  ctx.setLineDash([]);
  drawMeasures();
  if (splitPreview) {
    const { plan, pins, dia } = splitPreview;
    ctx.save(); ctx.lineWidth = 1.5; ctx.font = '12px system-ui';
    plan.windows.forEach((w, k) => {
      ctx.strokeStyle = k % 2 ? '#ef6c00' : '#00838f'; ctx.fillStyle = ctx.strokeStyle;
      ctx.setLineDash([8, 4]);
      for (const x of [w.x0, w.x1]) { ctx.beginPath(); ctx.moveTo(sx(x), 0); ctx.lineTo(sx(x), cv.clientHeight); ctx.stroke(); }
      ctx.setLineDash([]); ctx.fillText(`Segment ${k + 1}`, sx(w.x0) + 6, 16 + 14 * (k % 2));
    });
    ctx.strokeStyle = '#2e7d32'; ctx.fillStyle = '#2e7d3233';
    for (const set of pins) for (const p of set) {
      ctx.beginPath(); ctx.arc(sx(p.x), sy(p.y), Math.max(3, (dia / 2) * view.scale), 0, 7); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }
  if (dowelPreview && ts().on) {
    const { pts, dia, axis, flip } = dowelPreview;
    ctx.save(); ctx.strokeStyle = '#2e7d32'; ctx.fillStyle = '#2e7d3233'; ctx.lineWidth = 1.5;
    ctx.setLineDash([10, 5]); ctx.beginPath();
    if (flip === 'tb') { ctx.moveTo(0, sy(axis.y)); ctx.lineTo(cv.clientWidth, sy(axis.y)); }
    else { ctx.moveTo(sx(axis.x), 0); ctx.lineTo(sx(axis.x), cv.clientHeight); }
    ctx.stroke(); ctx.setLineDash([]);
    for (const p of pts) { ctx.beginPath(); ctx.arc(sx(p.x), sy(p.y), Math.max(3, (dia / 2) * view.scale), 0, 7); ctx.fill(); ctx.stroke(); }
    ctx.restore();
  }
  if (drag?.box && drag.moved) {
    ctx.strokeStyle = '#1565c0'; ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
    ctx.strokeRect(drag.x0, drag.y0, drag.x1 - drag.x0, drag.y1 - drag.y0); ctx.setLineDash([]);
  }
}

// ---------- hit testing ----------
function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
function pick(px: number, py: number): Shape | null {
  const tol = 7 / view.scale, x = wx(px), y = wy(py);
  let best: Shape | null = null, bd = tol;
  for (const s of shapes) {
    if (hidden.has(s.layer)) continue;
    const b = s.bbox;
    if (x < b.minX - tol || x > b.maxX + tol || y < b.minY - tol || y > b.maxY + tol) continue;
    const n = s.pts.length;
    for (let i = 0; i < (s.closed ? n : n - 1); i++) {
      const p = s.pts[i], q = s.pts[(i + 1) % n];
      const d = distToSeg(x, y, p.x, p.y, q.x, q.y);
      if (d < bd) { bd = d; best = s; }
    }
  }
  return best;
}

cv.addEventListener('pointerdown', e => {
  cv.setPointerCapture(e.pointerId);
  drag = { x0: e.offsetX, y0: e.offsetY, x1: e.offsetX, y1: e.offsetY, box: e.shiftKey, moved: false };
});
cv.addEventListener('pointermove', e => {
  if (measureOn && !drag) {
    hoverP = snapPoint(e.offsetX, e.offsetY).p;
    if (pendingA) draw();
    return;
  }
  if (!drag) return;
  const dx = e.offsetX - drag.x1, dy = e.offsetY - drag.y1;
  drag.x1 = e.offsetX; drag.y1 = e.offsetY;
  if (Math.hypot(drag.x1 - drag.x0, drag.y1 - drag.y0) > 4) drag.moved = true;
  if (drag.moved && !drag.box) { view.vx -= dx / view.scale; view.vy += dy / view.scale; }
  if (drag.moved) draw();
});
cv.addEventListener('pointerup', e => {
  if (!drag) return;
  const d = drag; drag = null;
  if (!d.moved && measureOn) {
    const p = snapPoint(e.offsetX, e.offsetY).p;
    if (!pendingA) pendingA = p;
    else { measures.push({ a: pendingA, b: p }); pendingA = null; }
    renderMeasures(); draw();
  } else if (!d.moved) {
    const s = pick(e.offsetX, e.offsetY);
    if (s) { selected.has(s.id) ? selected.delete(s.id) : selected.add(s.id); selectionChanged(); } else draw();
  } else if (d.box) {
    const x0 = wx(Math.min(d.x0, d.x1)), x1 = wx(Math.max(d.x0, d.x1));
    const y0 = wy(Math.max(d.y0, d.y1)), y1 = wy(Math.min(d.y0, d.y1));
    shapes.forEach(s => {
      if (!hidden.has(s.layer) && s.bbox.minX >= x0 && s.bbox.maxX <= x1 && s.bbox.minY >= y0 && s.bbox.maxY <= y1) selected.add(s.id);
    });
    selectionChanged();
  } else draw();
});
cv.addEventListener('wheel', e => {
  e.preventDefault();
  const f = Math.exp(-e.deltaY * 0.0015);
  const x = wx(e.offsetX), y = wy(e.offsetY);
  view.scale *= f;
  view.vx = x - e.offsetX / view.scale; view.vy = y - (cv.clientHeight - e.offsetY) / view.scale;
  draw();
}, { passive: false });

// ---------- import ----------
let loadedFile: { name: string; text: string } | null = null;

function importOptions(): ImportOptions {
  const u = sel('impunits').value;
  return {
    unitScale: u === 'auto' ? undefined : +u,
    scalePct: +inp('impscale').value || DEFAULT_IMPORT.scalePct,
    joinTol: Math.max(0, +inp('impjoin').value),
    closeTol: Math.max(0, +inp('impclose').value),
    dedupe: inp('impdedupe').checked,
  };
}

const fmt = (n: number, d = 1) => (Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(d));
const mmAndIn = (mm: number) => `${fmt(mm, 2)} mm (${(mm / 25.4).toFixed(3)} in)`;

/** (Re)read the loaded file with the current import settings. */
async function loadDrawing() {
  if (!loadedFile) return;
  const opts = importOptions();
  const hadOps = ops.length > 0;
  let result;
  try {
    const parsed = /\.dxf$/i.test(loadedFile.name) ? parseDxf(loadedFile.text, { unitScale: opts.unitScale }) : parseSvgRaw(loadedFile.text, { unitScale: opts.unitScale });
    // Text becomes outlines using our bundled fonts (loaded on first use).
    if (parsed.texts?.length) {
      const t = await textItemsToShapes(parsed.texts, loadFont);
      parsed.shapes.push(...t.shapes);
      parsed.notes.push(t.failed
        ? `${t.failed} text item(s) could not be converted.`
        : `${parsed.texts.length} text item(s) were turned into outlines using our own fonts: positions and sizes match your file, but the letter shapes may differ from the font you used. Check them before cutting.`);
    }
    result = processImport(parsed, opts);
  } catch (err) {
    $('impreport').classList.remove('hidden');
    $('impreport').innerHTML = `<span style="color:#b00020">${(err as Error).message}</span>`;
    return;
  }
  const { shapes: s, report } = result;
  shapes = s;
  hidden.clear(); selected.clear(); ops = []; active = null; frontRef = backRef = null; measures = []; pendingA = null;
  inp('stockw').value = ''; inp('stockh').value = '';
  $('impbox').classList.remove('hidden');
  $('measurebtns').classList.remove('hidden');
  $('fixbtns').classList.remove('hidden');
  const info = $('drawinfo');
  info.classList.toggle('hidden', !report.size);
  if (report.size) {
    const unitsTxt = opts.unitScale !== undefined ? 'units set by you in Import settings'
      : report.fileUnits ? `file units: ${report.fileUnits}` : 'file units: not stated';
    info.innerHTML = `<b>Drawing size</b> ${mmAndIn(report.size.w)} wide &times; ${mmAndIn(report.size.h)} high<br>` +
      `<small>${report.closed} closed shape(s), ${report.open} open line(s) &middot; ${unitsTxt}. Use <b>Measure</b> to check a known length.</small>`;
  }
  const rep = $('impreport');
  const notes = [...report.notes];
  if (hadOps) notes.unshift('Import settings changed: your operations were cleared.');
  rep.classList.toggle('hidden', !notes.length);
  rep.innerHTML = notes.map(n => `<div>&bull; ${n}</div>`).join('');
  renderLayers(); fit(); refreshUi(); renderMeasures(); draw(); commit();
}

// ---------- adding text ----------
for (const f of FONTS) { const o = document.createElement('option'); o.value = f.id; o.textContent = f.label; $('txfont').appendChild(o); }

/** Add shapes to the drawing without disturbing the existing ones (ids of old shapes stay the same). */
function addShapes(add: RawShape[]) {
  const start = shapes.length;
  shapes = finalize([...shapes.map(s => ({ layer: s.layer, pts: s.pts, closed: s.closed })), ...add]);
  selected.clear();
  add.forEach((_, j) => selected.add(start + j));
  active = null;
  $('measurebtns').classList.remove('hidden');
  $('fixbtns').classList.remove('hidden');
  renderLayers(); refreshUi(); draw(); commit();
}

$('addtext').addEventListener('click', async () => {
  const info = $('txinfo');
  const text = (document.getElementById('txt') as HTMLTextAreaElement).value;
  if (!text.trim()) { info.textContent = 'Type some text first.'; return; }
  info.textContent = 'Loading the font...';
  try {
    const font = await loadFont(sel('txfont').value as FontId);
    const t = textToContours(font, text, {
      capHeight: Math.max(0.5, +inp('txh').value), tracking: +inp('txtrack').value, lineSpacing: +inp('txline').value,
      align: sel('txalign').value as 'left' | 'center' | 'right',
    });
    if (!t.contours.length) { info.textContent = 'Nothing to draw: these characters are not in the font.'; return; }
    let x = inp('txx').value === '' ? NaN : +inp('txx').value, y = inp('txy').value === '' ? NaN : +inp('txy').value;
    if (Number.isNaN(x) || Number.isNaN(y)) {
      // default: put the text block in the middle of the view
      const cx = shapes.length ? wx(cv.clientWidth / 2) : 0, cy = shapes.length ? wy(cv.clientHeight / 2) : 0;
      const align = sel('txalign').value;
      x = Number.isNaN(x) ? cx - (align === 'left' ? t.width / 2 : align === 'right' ? -t.width / 2 : 0) : x;
      y = Number.isNaN(y) ? cy + (t.height - +inp('txh').value) / 2 - +inp('txh').value / 2 : y;
    }
    const layer = `Text: ${text.split('\n')[0].slice(0, 20)}`;
    const wasEmpty = shapes.length === 0;
    addShapes(placeContours(t.contours, x, y).map(pts => ({ layer, pts, closed: true })));
    if (wasEmpty) { fit(); draw(); }
    info.textContent = `Added ${t.contours.length} outline(s), ${t.width.toFixed(1)} mm wide. They are selected: choose what to do below.`;
  } catch (err) { info.textContent = (err as Error).message; }
});

// ---------- fixing up open lines by hand ----------
function say(msg: string) {
  const rep = $('impreport');
  rep.classList.remove('hidden');
  rep.innerHTML = `<div>&bull; ${msg}</div>` + rep.innerHTML;
}

/** Replace some shapes with others, renumbering ids and keeping operations, references and selection consistent. */
function replaceShapes(removeIds: Set<number>, add: RawShape[]) {
  const keep = shapes.filter(s => !removeIds.has(s.id));
  const map = new Map<number, number>();
  keep.forEach((s, i) => map.set(s.id, i));
  const dropped = ops.filter(o => o.ids.some(i => removeIds.has(i))).length;
  ops = ops.filter(o => !o.ids.some(i => removeIds.has(i)));
  ops.forEach(o => { o.ids = o.ids.map(i => map.get(i)!); });
  frontRef = frontRef !== null && map.has(frontRef) ? map.get(frontRef)! : null;
  backRef = backRef !== null && map.has(backRef) ? map.get(backRef)! : null;
  shapes = finalize([...keep, ...add].map(s => ({ layer: s.layer, pts: s.pts, closed: s.closed, free: s.free })));
  selected.clear();
  add.forEach((_, j) => selected.add(keep.length + j));
  active = null;
  if (dropped) say(`${dropped} operation(s) used the lines you changed and were removed. Add them again.`);
  renderLayers(); recompileAll(); commit();
}

$('closesel').addEventListener('click', () => {
  const open = [...selected].map(i => shapes[i]).filter(s => s && !s.closed && s.pts.length >= 3);
  if (!open.length) { say('Select one or more open lines first (the ones that should be outlines).'); return; }
  let longest = 0;
  for (const s of open) longest = Math.max(longest, Math.hypot(s.pts[0].x - s.pts[s.pts.length - 1].x, s.pts[0].y - s.pts[s.pts.length - 1].y));
  // Replace the shapes rather than editing them, so the change can be undone.
  const closing = new Set(open.map(s => s.id));
  shapes = shapes.map(s => (closing.has(s.id) ? { ...s, closed: true } : s));
  say(`Closed ${open.length} line(s) with a straight line from end back to start (longest closing line ${longest.toFixed(1)} mm). Check the shape in the preview.`);
  recompileAll(); commit();
});

$('runout').addEventListener('click', () => {
  const sel = [...selected].map(i => shapes[i]).filter(Boolean);
  const open = sel.filter(s => !s.closed), edge = sel.filter(s => s.closed);
  if (open.length !== 1 || edge.length !== 1) { say('Select the open line AND the closed outline it should run out through: one of each.'); return; }
  const r = runOutToEdge(open[0].pts, edge[0].pts);
  if (!r) { say('Could not do that: one end of the line never reaches that outline when it carries straight on.'); return; }
  replaceShapes(new Set([open[0].id]), [{ layer: open[0].layer, pts: r.pts, closed: true, free: r.free }]);
  say('The line now runs out to the outline and is closed along it. When you pocket it, the bit runs out past that edge automatically.');
});
$('joinsel').addEventListener('click', () => {
  const tol = Math.max(0, +inp('seljoin').value);
  const open = [...selected].map(i => shapes[i]).filter(s => s && !s.closed);
  if (open.length < 2) { say('Select two or more open lines to join.'); return; }
  const { shapes: joined } = joinShapes(open.map(s => ({ layer: s.layer, pts: s.pts, closed: false })), tol);
  if (joined.length >= open.length) { say(`Nothing to join: no selected lines have ends within ${tol} mm of each other. Raise the gap size in Import settings.`); return; }
  replaceShapes(new Set(open.map(s => s.id)), joined);
  say(`Joined ${open.length} lines into ${joined.length}${joined.some(j => j.closed) ? ' (closed outline made)' : ''}.`);
});

// ---------- measuring ----------
let measureOn = false;
let measures: { a: Pt; b: Pt }[] = [];
let pendingA: Pt | null = null;
let hoverP: Pt | null = null;

/** Snap to the nearest line vertex within a few pixels; otherwise use the raw point. */
function snapPoint(px: number, py: number): { p: Pt; snapped: boolean } {
  const tol = 10 / view.scale, x = wx(px), y = wy(py);
  let best: Pt | null = null, bd = tol;
  for (const s of shapes) {
    if (hidden.has(s.layer)) continue;
    const b = s.bbox;
    if (x < b.minX - tol || x > b.maxX + tol || y < b.minY - tol || y > b.maxY + tol) continue;
    for (const p of s.pts) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bd) { bd = d; best = p; }
    }
  }
  return best ? { p: { x: best.x, y: best.y }, snapped: true } : { p: { x, y }, snapped: false };
}

function describeMeasure(m: { a: Pt; b: Pt }) {
  const dx = m.b.x - m.a.x, dy = m.b.y - m.a.y, d = Math.hypot(dx, dy);
  return { d, dx, dy, text: `${d.toFixed(2)} mm | ${(d / 25.4).toFixed(3)} in | ${(d / 25.4 * 96).toFixed(1)} px` };
}

function renderMeasures() {
  $('measures').innerHTML = measures.map((m, i) => {
    const r = describeMeasure(m);
    return `<div style="margin:3px 0">#${i + 1}: <b>${r.text}</b><br><small style="color:#666">&Delta;x ${r.dx.toFixed(2)} mm, &Delta;y ${r.dy.toFixed(2)} mm (px = at 96 per inch)</small></div>`;
  }).join('') + (measureOn ? `<small style="color:#c2185b">${pendingA ? 'Click the second point (Esc cancels).' : 'Click the first point. Points snap to line corners and ends.'}</small>` : '');
  $('measure').style.background = measureOn ? '#f8bbd0' : '';
  cv.style.cursor = measureOn ? 'cell' : 'crosshair';
}

function setMeasure(on: boolean) {
  measureOn = on; pendingA = null; hoverP = null;
  renderMeasures(); draw();
}

function drawMeasures() {
  ctx.save();
  ctx.lineWidth = 1.5; ctx.font = '12px system-ui';
  const all = [...measures, ...(pendingA && hoverP ? [{ a: pendingA, b: hoverP }] : [])];
  all.forEach((m, i) => {
    const live = i >= measures.length;
    ctx.strokeStyle = '#c2185b'; ctx.fillStyle = '#c2185b';
    ctx.setLineDash(live ? [5, 4] : []);
    ctx.beginPath(); ctx.moveTo(sx(m.a.x), sy(m.a.y)); ctx.lineTo(sx(m.b.x), sy(m.b.y)); ctx.stroke();
    ctx.setLineDash([]);
    for (const p of [m.a, m.b]) { ctx.beginPath(); ctx.arc(sx(p.x), sy(p.y), 4, 0, 7); ctx.fill(); }
    const r = describeMeasure(m);
    const label = `${r.d.toFixed(2)} mm  ${(r.d / 25.4).toFixed(3)} in  ${(r.d / 25.4 * 96).toFixed(0)} px`;
    const mx = (sx(m.a.x) + sx(m.b.x)) / 2, my = (sy(m.a.y) + sy(m.b.y)) / 2;
    const w = ctx.measureText(label).width + 10;
    ctx.fillStyle = '#fffe'; ctx.fillRect(mx - w / 2, my - 20, w, 18);
    ctx.strokeStyle = '#c2185b'; ctx.lineWidth = 1; ctx.strokeRect(mx - w / 2, my - 20, w, 18);
    ctx.fillStyle = '#880e4f'; ctx.fillText(label, mx - w / 2 + 5, my - 7);
  });
  ctx.restore();
}

$('measure').addEventListener('click', () => setMeasure(!measureOn));
$('clearmeasure').addEventListener('click', () => { measures = []; pendingA = null; renderMeasures(); draw(); });
addEventListener('keydown', e => {
  const t = e.target as HTMLElement;
  if (t && ['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName)) return;
  if (e.key === 'm' || e.key === 'M') setMeasure(!measureOn);
  if (e.key === 'Escape') { if (pendingA) { pendingA = null; renderMeasures(); draw(); } else if (measureOn) setMeasure(false); }
});

// ---------- wiring ----------
inp('file').addEventListener('change', async e => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  const bytes = new Uint8Array(await f.arrayBuffer());
  let text: string;
  if (isBinaryDxf(bytes)) {
    try { text = binaryDxfToAscii(bytes); } catch (err) { say((err as Error).message); return; }
    say(`${f.name} is a binary DXF file: it was converted to text and read.`);
  } else text = new TextDecoder().decode(bytes);
  loadedFile = { name: f.name, text };
  sel('impunits').value = 'auto'; inp('impscale').value = '100';
  loadDrawing();
});
['impunits', 'impscale', 'impjoin', 'impclose', 'impdedupe'].forEach(id => $(id).addEventListener('change', loadDrawing));
$('clearsel').addEventListener('click', () => { selected.clear(); selectionChanged(); });
$('fit').addEventListener('click', () => { fit(); draw(); });
$('addop').addEventListener('click', () => {
  const ids = [...selected];
  const form = readForm();
  if (ts().on && form.side === 'back') { form.frame = guessFrame(ids); sel('frame').value = form.frame; }
  const op: Op = { id: nextOp++, ids, s: form, tp: null, msgs: [] };
  compile(op); ops.push(op);
  // Inlay: put the outline of the insert blank into the drawing so it can be cut free with an ordinary cut-out operation.
  if (op.blank?.length) {
    addShapes(op.blank.map(pts => ({ layer: 'Inlay insert blank', pts, closed: true })));
    say('Inlay added. The outline of the insert blank is now in the drawing (layer "Inlay insert blank", selected): add a cut-out operation with a flat bit to cut it free after carving.');
  }
  // Nothing stays "active" after adding: otherwise changing the bit or depth for the NEXT operation would silently change this one.
  active = null;
  refreshUi(); draw(); commit();
});
$('delop').addEventListener('click', () => {
  if (!active) return;
  ops = ops.filter(o => o !== active); active = null; refreshUi(); draw(); commit();
});
function moveOp(by: -1 | 1) {
  if (!active) return;
  const i = ops.indexOf(active), j = i + by;
  if (j < 0 || j >= ops.length) return;
  [ops[i], ops[j]] = [ops[j], ops[i]];
  refreshUi(); draw(); commit();
}
$('opup').addEventListener('click', () => moveOp(-1));
$('opdown').addEventListener('click', () => moveOp(1));
function recompileAll() { ops.forEach(compile); refreshUi(); draw(); }

function setRef(which: 'front' | 'back') {
  const ids = [...selected].filter(i => shapes[i]?.closed);
  const status = $('tsrefs');
  if (ids.length !== 1) { status.textContent = 'Select exactly one closed outline shape first, then click the button.'; return; }
  if (which === 'front') frontRef = ids[0]; else backRef = ids[0];
  const parts = [`Front outline: ${frontRef !== null ? shapes[frontRef].layer : 'not set'}`, `back outline: ${backRef !== null ? shapes[backRef].layer : 'not set'}.`];
  if (refsOk()) {
    const r = detectMirror(shapes[frontRef!].pts, shapes[backRef!].pts);
    const s = settingsFromMatch(r.match);
    sel('tsflip').value = s.flip; sel('tspre').value = s.preMirrored ? '1' : '0';
    const how = { flipY: 'flipped top-to-bottom', flipX: 'flipped left-to-right', same: 'drawn the same way round as the front', rot180: 'rotated 180 degrees' }[r.match];
    parts.push(`Detected: the back outline is ${how}, so I set the turn-over and mirroring options to match (you can change them).`);
    if (r.match === 'rot180') parts.push('A 180 degree turn is ambiguous - check the options.');
    const second = Object.entries(r.dist).sort((a, b) => a[1] - b[1])[1][1];
    if (r.dist[r.match] > 0.02 || r.dist[r.match] > second * 0.5) parts.push('The match is weak: check these are really the same part.');
  }
  status.textContent = parts.join(' ');
  recompileAll(); commit();
}
$('setfront').addEventListener('click', () => setRef('front'));
$('setback').addEventListener('click', () => setRef('back'));
['sp_on', 'spoverlap', 'ts_on', 'tsflip', 'tspre', 'stockw', 'stockh', 'stockt', 'dowd', 'dowc', 'dowdist', 'dowgap', 'dowmode', 'dowlen', 'spoilt', 'dowmax', 'dowbit', 'dowflute']
  .forEach(id => $(id).addEventListener('input', recompileAll));

// Choosing V-carve while a flat bit is selected switches to a typical 60 degree V-bit and a shallow depth.
sel('op').addEventListener('input', () => {
  if (sel('op').value === 'inlayflat' && sel('ttype').value === 'vbit') { sel('ttype').value = 'flat'; inp('tool').value = '6'; syncVisibility(); }
  if (['vcarve', 'inlay'].includes(sel('op').value) && sel('ttype').value !== 'vbit') {
    sel('ttype').value = 'vbit'; inp('tool').value = '6.35'; inp('vangle').value = '60'; inp('vtip').value = '0.2'; inp('flute').value = '15';
    if (+inp('depth').value > 6 || !(+inp('depth').value > 0)) inp('depth').value = '3';
  }
});

['op', 'side', 'frame', 'ttype', 'tool', 'flute', 'vangle', 'vtip', 'vwide', 'depth', 'start', 'dir', 'ramp', 'tabs', 'lead', 'tabn', 'tabw', 'tabh', 'dogbone', 'iglue', 'imoat', 'vflat', 'stlx', 'stly', 'stltop', 'stlsr', 'stlsf', 'stlleave', 'stlzig', 'stlcross', 'stlrest', 'stlsteep'].forEach(id =>
  $(id).addEventListener('input', () => {
    syncVisibility();
    if (active) { const kind = active.s.kind; active.s = readForm(); if (is3d(kind)) active.s.kind = kind; compile(active); refreshUi(); draw(); }
    else if (id.startsWith('stl')) draw();
  }));

// ---------- 3D model wiring ----------
inp('stlfile').addEventListener('change', async e => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  try {
    const first = !model;
    stl = { name: f.name, mesh: parseStl(await f.arrayBuffer()) };
    rebuildModel();
    ops.filter(o => is3d(o.s.kind)).forEach(compile);
    if (first && !shapes.length) fit();
    refreshUi(); draw(); commit();
    say(`Loaded ${f.name}. Choose a flat bit for roughing or a ball nose for finishing, then use "Add 3D roughing" / "Add 3D finishing".`);
  } catch (err) {
    $('stlinfo').textContent = err instanceof StlError ? err.message : 'Could not read that file.';
  }
});
['stlup', 'stlspin', 'stlunits'].forEach(id => $(id).addEventListener('input', () => {
  if (!stl) return;
  rebuildModel();
  ops.filter(o => is3d(o.s.kind)).forEach(compile);
  refreshUi(); draw();
}));
function add3d(kind: 'rough3d' | 'finish3d') {
  if (!model) { say('Load a 3D model (STL) first.'); return; }
  const form = readForm();
  form.kind = kind;
  if (kind === 'rough3d' && form.ttype === 'vbit') { form.ttype = 'flat'; sel('ttype').value = 'flat'; }
  if (kind === 'finish3d' && form.ttype === 'flat') { form.ttype = 'ball'; sel('ttype').value = 'ball'; }
  const op: Op = { id: nextOp++, ids: [], s: form, tp: null, msgs: [] };
  compile(op); ops.push(op); active = null; // see the note under "Add operation"
  refreshUi(); draw(); commit();
}
$('add3r').addEventListener('click', () => add3d('rough3d'));
$('add3f').addEventListener('click', () => add3d('finish3d'));
$('stloutline').addEventListener('click', () => {
  if (!model) { say('Load a 3D model (STL) first.'); return; }
  const loops: Loop[] = [];
  const t = model.tri, ox = +inp('stlx').value || 0, oy = +inp('stly').value || 0;
  for (let k = 0; k < t.length; k += 9) {
    const a = { x: t[k] + ox, y: t[k + 1] + oy }, b = { x: t[k + 3] + ox, y: t[k + 4] + oy }, c = { x: t[k + 6] + ox, y: t[k + 7] + oy };
    const area = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
    if (Math.abs(area) < 1e-9) continue;
    loops.push(area > 0 ? [a, b, c] : [a, c, b]);
  }
  const out = simplifyLoops(unionAll(loops), 0.05);
  if (!out.length) { say('The model has no outline to add.'); return; }
  addShapes(out.map(pts => ({ layer: '3D model outline', pts, closed: true })));
  say('Added the outline of the model to the drawing (layer "3D model outline"). Select it and add a cut-out operation to cut the part free.');
});
sel('material').addEventListener('input', () => { syncMaterialBoxes(); ops.forEach(compile); refreshUi(); draw(); });
['matcustom', 'matfeed', 'matplunge', 'matstep'].forEach(id => $(id).addEventListener('input', () => {
  syncMaterialBoxes();
  $('matinfo').innerHTML = inp('matcustom').checked ? materialWarnings(currentMaterial(), +inp('tool').value).map(w => `<span style="color:#b00020">${w}</span>`).join('<br>') || 'Using your own values.' : 'Starts from the chosen material. Tick the box, then change the numbers for a material that is not listed.';
  ops.forEach(compile); refreshUi(); draw();
}));
syncMaterialBoxes();
['flavor', 'bedx', 'bedy', 'zero'].forEach(id => $(id).addEventListener('input', refreshUi));

// Arcs: GRBL always understands G2/G3, so it starts switched on; Marlin only if it was built with ARC_SUPPORT, so it starts off.
function arcInfo() {
  const grbl = sel('flavor').value === 'grbl';
  $('arcinfo').innerHTML = sel('arcs').value === 'off'
    ? (grbl ? 'GRBL always understands arcs, so turning them on is safe.' : 'Switch on only after the arc test below runs correctly on your machine.')
    : (grbl ? 'Arcs are on. GRBL supports G2/G3.' : '<b>Marlin only runs arcs if it was built with <code>ARC_SUPPORT</code>.</b> Run the arc test file first (spindle off). If it stops or draws straight lines, switch arcs back off.');
}
sel('flavor').addEventListener('input', () => { sel('arcs').value = sel('flavor').value === 'grbl' ? 'on' : 'off'; arcInfo(); });
sel('arcs').addEventListener('input', arcInfo);
$('arctest').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([arcTestGcode(sel('flavor').value as Flavor)], { type: 'text/plain' }));
  a.download = 'arc_test_air_cut.gcode'; a.click();
});
arcInfo();
addEventListener('resize', draw);

function download(paths: Toolpath[], name: string, note: string) {
  if (!paths.length) return;
  const text = toGcode(paths, { flavor: sel('flavor').value as Flavor, spindle: 'manual', safeZ: 5, decimals: 3, arcs: sel('arcs').value === 'on' })
    .replace(/; Units: mm, absolute\. Work zero:.*\n/, '; Units: mm, absolute.\n') // the notes below say where zero is; avoid a conflicting generic line
    .replace('\n', `\n${note.split('\n').map(l => '; ' + l).join('\n')}\n`);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = name; a.click();
}
$('dl').addEventListener('click', () => {
  const p = placed();
  if (ts().on && refsOk()) {
    const t = ts();
    const common = 'Stock centred on the turn-over line; zero X/Y at the stock bottom-left corner, Z zero on the top surface.';
    const note = t.mode === 'spoilfirst'
      ? `SIDE 1 (run step 0 first, with no stock): drills shallow blind dowel holes in the top of the stock, then cuts the front.\n${common}\nPut the stock roughly in place against your corner stops; its exact position does not matter for the flip.\nAfter side 1: lift the stock, push a dowel into each spoilboard hole, turn the stock over and lower it onto the dowels.`
      : `SIDE 1: drills the dowel holes first, then cuts the front.\n${common}\nAfter drilling, press a dowel into each hole so it stands in the spoilboard and pokes up into the stock.\nFor side 2, lift the stock, turn it over and drop it back onto the same dowels.`;
    download(p.side1, 'side1.gcode', note);
  } else download(p.paths, 'job.gcode', zeroText());
});
$('dl0').addEventListener('click', () => {
  const p = placed();
  download(p.side0, 'step0_spoilboard.gcode',
    'STEP 0: NO STOCK ON THE MACHINE. Drills the dowel holes in the spoilboard only.\nZero X/Y at the stock bottom-left corner position (where the stock will sit). Z zero on the TOP SURFACE OF THE SPOILBOARD.\nDo this before side 1. Leave the dowels out until after side 1.');
});
$('dl2').addEventListener('click', () => {
  const p = placed();
  download(p.side2, 'side2.gcode',
    `SIDE 2: turn the stock over ${ts().flip === 'tb' ? 'top-to-bottom' : 'left-to-right'} onto the same dowels.\nSame X/Y zero as side 1; set Z zero on the NEW top surface.`);
});

// ---------- help: hover hints, "?" buttons and the side drawer ----------
for (const [id, text] of Object.entries(HINTS)) {
  const el = document.getElementById(id);
  if (el) { el.title = text; const l = el.closest('label'); if (l) l.title = text; }
}
const drawer = $('helpdrawer');
function openHelp(anchor?: string) {
  const url = `help.html?embed=1${anchor ? `#${anchor}` : ''}`;
  const frame = $<HTMLIFrameElement>('helpframe');
  frame.src = url;
  $<HTMLAnchorElement>('helpfull').href = `help.html${anchor ? `#${anchor}` : ''}`;
  drawer.classList.remove('hidden');
}
document.querySelectorAll<HTMLElement>('[data-help]').forEach(el => {
  const b = document.createElement('button');
  b.className = 'helpbtn'; b.textContent = '?'; b.title = 'Help on this section';
  b.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); openHelp(el.dataset.help); });
  el.appendChild(b);
});
$('helpclose').addEventListener('click', () => drawer.classList.add('hidden'));
addEventListener('keydown', e => {
  const t = e.target as HTMLElement;
  if (e.key === 'Escape' && !drawer.classList.contains('hidden')) { drawer.classList.add('hidden'); return; }
  if (t && ['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName)) return;
  if (e.key === 'F1' || e.key === '?') { e.preventDefault(); openHelp(); }
});

// ---------- undo / redo, project files and the automatic backup ----------
const history = new History(100);
let restoring = false;
let commitTimer: number | undefined;
let autosaveTimer: number | undefined;
let backupOffered = false;       // the "restore your last session" bar is showing: the backup is paused until the user chooses

/** Every setting in the side panel, by element id (not the file pickers). */
function captureForm(): Record<string, string | boolean> {
  const f: Record<string, string | boolean> = {};
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('aside input[id], aside select[id], aside textarea[id]').forEach(el => {
    if ((el as HTMLInputElement).type === 'file') return;
    f[el.id] = (el as HTMLInputElement).type === 'checkbox' ? (el as HTMLInputElement).checked : el.value;
  });
  return f;
}

function snapshot(): Snapshot {
  return {
    source: loadedFile, model: stl ? { name: stl.name, tri: stl.mesh.tri } : null, shapes, hidden: [...hidden],
    ops: ops.map(o => ({ id: o.id, ids: [...o.ids], s: { ...o.s } as unknown as Record<string, unknown>, blank: o.blank })),
    nextOp, frontRef, backRef, form: captureForm(),
  };
}

/** Show a drawing-size summary for shapes that did not come straight from an import. */
function updateDrawInfo() {
  const info = $('drawinfo');
  if (!shapes.length) { info.classList.add('hidden'); return; }
  const minX = Math.min(...shapes.map(s => s.bbox.minX)), maxX = Math.max(...shapes.map(s => s.bbox.maxX));
  const minY = Math.min(...shapes.map(s => s.bbox.minY)), maxY = Math.max(...shapes.map(s => s.bbox.maxY));
  info.classList.remove('hidden');
  info.innerHTML = `<b>Drawing size</b> ${mmAndIn(maxX - minX)} wide &times; ${mmAndIn(maxY - minY)} high<br>` +
    `<small>${shapes.filter(s => s.closed).length} closed shape(s), ${shapes.filter(s => !s.closed).length} open line(s). Use <b>Measure</b> to check a known length.</small>`;
}

function applySnapshot(s: Snapshot) {
  restoring = true;
  try {
    for (const [id, v] of Object.entries(s.form)) {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (!el || el.type === 'file') continue;
      if (el.type === 'checkbox') el.checked = !!v; else el.value = String(v);
    }
    loadedFile = s.source;
    // the same triangles are shared with the undo history, so keep the same object while the model is unchanged
    if (s.model?.tri !== stl?.mesh.tri) stl = s.model ? { name: s.model.name, mesh: { tri: s.model.tri } } : null;
    rebuildModel();
    shapes = s.shapes;
    hidden.clear(); s.hidden.forEach(h => hidden.add(h));
    // settings missing from an older project take the current panel values
    const defaults = readForm();
    ops = s.ops.map(o => ({ id: o.id, ids: [...o.ids], s: { ...defaults, ...(o.s as unknown as Partial<Settings>) } as Settings, tp: null, msgs: [], blank: o.blank }));
    nextOp = s.nextOp; frontRef = s.frontRef; backRef = s.backRef;
    selected.clear(); active = null; measures = []; pendingA = null;
    syncVisibility(); syncMaterialBoxes(); arcInfo();
    ops.forEach(compile);
    const any = shapes.length > 0;
    $('measurebtns').classList.toggle('hidden', !any);
    $('fixbtns').classList.toggle('hidden', !any);
    $('impbox').classList.toggle('hidden', !loadedFile);
    updateDrawInfo(); renderLayers(); refreshUi(); renderMeasures(); draw();
  } finally { restoring = false; }
}

function updateHistoryButtons() {
  ($('undo') as HTMLButtonElement).disabled = !history.canUndo;
  ($('redo') as HTMLButtonElement).disabled = !history.canRedo;
}

/** Record the current document as an undo step (does nothing if nothing changed). */
function commit() {
  if (restoring) return;
  clearTimeout(commitTimer);
  if (history.commit(snapshot())) { updateHistoryButtons(); scheduleAutosave(); }
}
/** Settings changes are recorded once typing pauses, so one edit is one undo step. */
function scheduleCommit() {
  if (restoring) return;
  clearTimeout(commitTimer);
  commitTimer = window.setTimeout(commit, 600);
}
function undo() { commit(); const s = history.undo(); if (s) { applySnapshot(s); updateHistoryButtons(); scheduleAutosave(); } }
function redo() { commit(); const s = history.redo(); if (s) { applySnapshot(s); updateHistoryButtons(); scheduleAutosave(); } }

document.querySelector('aside')!.addEventListener('input', scheduleCommit);
document.querySelector('aside')!.addEventListener('change', scheduleCommit);
$('undo').addEventListener('click', undo);
$('redo').addEventListener('click', redo);
addEventListener('keydown', e => {
  const t = e.target as HTMLElement;
  if (t && ['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName)) return;      // let text fields keep their own undo
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const k = e.key.toLowerCase();
  if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
  else if (k === 's') { e.preventDefault(); saveProject(); }
});

// ----- project files
function saveProject() {
  commit();
  const text = snapshotToProject(snapshot());
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = `${(loadedFile?.name ?? 'project').replace(/\.[^.]+$/, '')}.opencam.json`;
  a.click();
  say(`Project saved (${(text.length / 1024).toFixed(0)} KB). Open it later with "Open project".`);
}
$('saveproj').addEventListener('click', saveProject);
$('openproj').addEventListener('click', () => $<HTMLInputElement>('projfile').click());
$('projfile').addEventListener('change', async e => {
  const f = (e.target as HTMLInputElement).files?.[0];
  (e.target as HTMLInputElement).value = '';
  if (!f) return;
  try {
    const { snapshot: s } = projectToSnapshot(await f.text());
    applySnapshot(s); history.reset(snapshot()); updateHistoryButtons(); fit(); draw(); scheduleAutosave();
    say(`Opened project "${f.name}": ${s.shapes.length} shape(s), ${s.ops.length} operation(s).`);
  } catch (err) {
    const rep = $('impreport');
    rep.classList.remove('hidden');
    rep.innerHTML = `<div style="color:#b00020">&bull; ${(err as Error).message}</div>` + rep.innerHTML;
  }
});

// ----- automatic backup (so a closed tab or crash does not lose your work)
function scheduleAutosave() {
  if (backupOffered) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(async () => {
    try {
      if (!shapes.length && !ops.length) await kvDelete('autosave');
      else await kvSet('autosave', snapshotToProject(snapshot()));
    } catch { /* private browsing or storage full: the backup is a bonus, not essential */ }
  }, 3000);
}

async function offerBackup() {
  try {
    const text = await kvGet('autosave');
    if (!text) return;
    const { snapshot: s, savedAt } = projectToSnapshot(text);
    if (!s.shapes.length && !s.ops.length) return;
    backupOffered = true;
    const when = savedAt ? new Date(savedAt).toLocaleString() : 'earlier';
    const bar = $('restorebar');
    bar.classList.remove('hidden');
    $('restoretext').textContent = `Your last session was backed up (${s.source?.name ?? 'untitled'}, ${when}).`;
    $('restoreyes').onclick = () => { applySnapshot(s); history.reset(snapshot()); updateHistoryButtons(); fit(); draw(); bar.classList.add('hidden'); backupOffered = false; scheduleAutosave(); };
    $('restoreno').onclick = async () => { bar.classList.add('hidden'); backupOffered = false; try { await kvDelete('autosave'); } catch { /* ignore */ } };
  } catch { /* nothing usable to offer */ }
}

// Dev-only hook for inspecting state from the browser console / automated checks.
if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__app = { get shapes() { return shapes; }, get ops() { return ops; }, history, undo, redo, snapshot, applySnapshot, select: (ids: number[]) => { selected.clear(); ids.forEach(i => selected.add(i)); selectionChanged(); } };

syncVisibility(); refreshUi(); draw();
history.reset(snapshot()); updateHistoryButtons();
void offerBackup();

// ---------- 3D simulation ----------
let viewer: Viewer | null = null;
let simRun = 0;

/** The separate runs of the job that can be simulated (each starts from a fresh block of stock). */
function simSources(): { label: string; paths: Toolpath[] }[] {
  const p = placed();
  if (p.split) return p.split.files.map(f => ({ label: f.name.replace('.gcode', ''), paths: f.paths }));
  const out: { label: string; paths: Toolpath[] }[] = [];
  if (ts().on && refsOk()) {
    if (p.side0.length) out.push({ label: 'Step 0: spoilboard holes', paths: p.side0 });
    out.push({ label: 'Side 1', paths: p.side1 }, { label: 'Side 2', paths: p.side2 });
  } else out.push({ label: 'Whole job', paths: p.paths });
  return out.filter(s => s.paths.length);
}

/** Give the page a chance to repaint between batches. A hidden tab does not run animation frames, so use a message there. */
function nextTurn(): Promise<void> {
  if (!document.hidden) return new Promise(r => requestAnimationFrame(() => r()));
  return new Promise(r => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });
}

async function runSim() {
  const my = ++simRun;
  const status = $('simstatus');
  const srcs = simSources();
  if (!srcs.length) { status.textContent = 'Add an operation first.'; return; }
  const src = srcs[Math.min(+sel('simsel').value || 0, srcs.length - 1)];
  let stock: Stock;
  if (ts().on && refsOk() && sel('simstock').value === 'auto') { const t = ts(); stock = { x0: 0, y0: 0, w: t.W, h: t.H, t: t.T }; }
  else if (sel('simstock').value === 'custom') {
    const w = +inp('simw').value, h = +inp('simh').value, t = +inp('simt').value;
    const b = toolpathBounds(src.paths);
    const corner = zeroMode() === 'corner';
    stock = { x0: corner ? 0 : (b.minX + b.maxX) / 2 - w / 2, y0: corner ? 0 : (b.minY + b.maxY) / 2 - h / 2, w, h, t };
  } else stock = autoStock(src.paths, 5);
  const g = createGrid(stock, 0.5);
  let done = 0;
  const entries = planEntries(src.paths);
  const total = src.paths.reduce((s, tp) => s + tp.cuts.reduce((q, c) => q + c.moves.length, 0), 0) || 1;
  for (const tp of src.paths) {
    let last = 0;
    for (const n of simulateToolpath(g, tp, 2000, entries)) {
      if (my !== simRun) return;
      status.textContent = `Simulating ${Math.round(100 * (done + n) / total)}% ...`;
      last = n;
      await nextTurn();
    }
    done += last;
  }
  if (my !== simRun || !viewer) return;
  viewer.setGrid(g);
  const warn = simSummary(g);
  status.innerHTML = `Stock ${Math.round(stock.w)} x ${Math.round(stock.h)} x ${+stock.t.toFixed(1)} mm${sel('simstock').value === 'auto' ? ' (automatic)' : ''}.` +
    (warn.length ? warn.map(w => `<div style="color:#b00020">${w}</div>`).join('') : ' <span style="color:#2e7d32">No problems found.</span>')
    + (sel('simstock').value === 'auto' && !(ts().on && refsOk()) && minOf(g.z) <= -stock.t + 0.01 ? `<div style="color:#546e7a">Automatic stock is exactly as thick as the deepest cut, so this cannot show whether a through-cut goes into your spoilboard. Choose <b>My own size</b> and enter your real thickness to check that.</div>` : '');
}

$('simbtn').addEventListener('click', () => {
  const srcs = simSources();
  if (!srcs.length) { say('Add an operation first, then simulate it.'); return; }
  $('simdlg').classList.remove('hidden');
  // a fresh canvas each time: the old one takes its mouse listeners and GL context with it
  const oldCv = $<HTMLCanvasElement>('simcv'), freshCv = oldCv.cloneNode(false) as HTMLCanvasElement;
  oldCv.replaceWith(freshCv);
  try { viewer = new Viewer(freshCv); } catch (e) { $('simstatus').textContent = (e as Error).message; return; }
  sel('simsel').innerHTML = srcs.map((s, i) => `<option value="${i}">${s.label}</option>`).join('');
  void runSim();
});
$('simclose').addEventListener('click', () => { simRun++; viewer?.dispose(); viewer = null; $('simdlg').classList.add('hidden'); });
['simsel', 'simw', 'simh', 'simt'].forEach(id => $(id).addEventListener('change', () => void runSim()));
sel('simstock').addEventListener('change', () => { $('simsize').classList.toggle('hidden', sel('simstock').value !== 'custom'); void runSim(); });
sel('simz').addEventListener('change', () => viewer?.setZScale(+sel('simz').value));
$('simtop').addEventListener('click', () => viewer?.setView('top'));
$('simiso').addEventListener('click', () => viewer?.setView('iso'));
$('simfront').addEventListener('click', () => viewer?.setView('front'));