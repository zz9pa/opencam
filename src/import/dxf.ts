import DxfParser from 'dxf-parser';
import type { IDxf, IEntity, IPoint } from 'dxf-parser';
import type { Loop, Pt } from '../core/types';
import type { ParsedDrawing, RawShape, TextItem } from './shape';

/** mm per drawing unit for the DXF $INSUNITS codes we understand. */
const UNIT_MM: Record<number, [string, number]> = {
  1: ['inches', 25.4], 2: ['feet', 304.8], 4: ['millimetres', 1], 5: ['centimetres', 10], 6: ['metres', 1000],
  8: ['microinches', 0.0000254], 9: ['mils', 0.0254], 10: ['yards', 914.4], 13: ['microns', 0.001], 14: ['decimetres', 100],
};

/** 2D affine transform [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f. */
type Mat = [number, number, number, number, number, number];
const IDENT: Mat = [1, 0, 0, 1, 0, 0];
const mul = (m: Mat, n: Mat): Mat => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m: Mat, p: { x: number; y: number }): Pt => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });
const scaleOf = (m: Mat) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;

/** Largest chord error allowed when straightening curves, in mm. */
const TOL_MM = 0.01;

function arcSteps(r: number, sweep: number, tol: number): number {
  if (r <= tol) return 4;
  const step = 2 * Math.acos(Math.max(0, 1 - tol / r));
  return Math.min(4000, Math.max(4, Math.ceil(Math.abs(sweep) / Math.max(step, 1e-3))));
}

function arcPoints(cx: number, cy: number, r: number, a0: number, sweep: number, tol: number): Pt[] {
  const n = arcSteps(r, sweep, tol);
  return Array.from({ length: n + 1 }, (_, i) => ({ x: cx + r * Math.cos(a0 + (sweep * i) / n), y: cy + r * Math.sin(a0 + (sweep * i) / n) }));
}

/** Points along the bulge arc from p0 to p1 (DXF bulge = tan(sweep / 4); positive = counter-clockwise). */
function bulgePoints(p0: Pt, p1: Pt, bulge: number, tol: number): Pt[] {
  const dx = p1.x - p0.x, dy = p1.y - p0.y, c = Math.hypot(dx, dy);
  if (!c || Math.abs(bulge) < 1e-9) return [p0, p1];
  const theta = 4 * Math.atan(bulge);
  const r = Math.abs(c / (2 * Math.sin(theta / 2)));
  // Centre lies on the perpendicular bisector; side depends on the sign of the bulge.
  const off = (c / 2) / Math.tan(theta / 2);
  const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
  const cx = mx + (-dy / c) * off, cy = my + (dx / c) * off;
  const a0 = Math.atan2(p0.y - cy, p0.x - cx);
  return arcPoints(cx, cy, r, a0, theta, tol);
}

/** NURBS point by de Boor's algorithm (non-rational: weights are not exposed by the parser). */
function deBoor(k: number, degree: number, t: number, knots: number[], ctrl: IPoint[]): Pt {
  const d = ctrl.slice(k - degree, k + 1).map(p => ({ x: p.x, y: p.y }));
  for (let r = 1; r <= degree; r++) {
    for (let j = degree; j >= r; j--) {
      const den = knots[j + 1 + k - r] - knots[j + k - degree];
      const a = den === 0 ? 0 : (t - knots[j + k - degree]) / den;
      d[j] = { x: (1 - a) * d[j - 1].x + a * d[j].x, y: (1 - a) * d[j - 1].y + a * d[j].y };
    }
  }
  return d[degree];
}

function splinePoints(e: any, tol: number): { pts: Pt[]; closed: boolean } | null {
  const ctrl: IPoint[] | undefined = e.controlPoints;
  const knots: number[] | undefined = e.knotValues;
  const degree: number = e.degreeOfSplineCurve ?? 3;
  if (ctrl && ctrl.length > degree && knots && knots.length >= ctrl.length + degree + 1) {
    const t0 = knots[degree], t1 = knots[ctrl.length];
    // Sample finely enough that the chords follow the curve: base it on the control polygon length.
    let len = 0;
    for (let i = 1; i < ctrl.length; i++) len += Math.hypot(ctrl[i].x - ctrl[i - 1].x, ctrl[i].y - ctrl[i - 1].y);
    const n = Math.min(4000, Math.max(24, Math.ceil(len / Math.max(tol * 20, 0.05))));
    const pts: Pt[] = [];
    let k = degree;
    for (let i = 0; i <= n; i++) {
      const t = t0 + ((t1 - t0) * i) / n;
      while (k < ctrl.length - 1 && t >= knots[k + 1]) k++;
      pts.push(deBoor(k, degree, Math.min(t, t1 - 1e-12), knots, ctrl));
    }
    return { pts, closed: !!e.closed };
  }
  const fit: IPoint[] | undefined = e.fitPoints;
  if (fit && fit.length >= 2) return { pts: fit.map(p => ({ x: p.x, y: p.y })), closed: !!e.closed };
  return null;
}

export function parseDxf(text: string, opts: { unitScale?: number } = {}): ParsedDrawing {
  const notes: string[] = [];
  let dxf: IDxf | null = null;
  try {
    dxf = new DxfParser().parseSync(text);
  } catch (err) {
    throw new Error(`This DXF file could not be read (${(err as Error).message}). Try saving it again as an ASCII DXF (R12 or 2000).`);
  }
  if (!dxf) throw new Error('This DXF file is empty or not a DXF.');

  // Units
  const ins = Number(dxf.header?.['$INSUNITS']);
  const known = UNIT_MM[ins];
  const scaleToMm = opts.unitScale ?? (known ? known[1] : 1);
  const fileUnits = known ? known[0] : null;
  if (opts.unitScale === undefined && !known) notes.push('The file does not say what units it uses, so millimetres are assumed. Check the size shown below, and change Units if it is wrong.');

  const hiddenLayers = new Set<string>();
  const layerTable = dxf.tables?.layer?.layers ?? {};
  for (const [name, l] of Object.entries(layerTable)) if (l.visible === false || l.frozen) hiddenLayers.add(name);

  const shapes: RawShape[] = [];
  const texts: TextItem[] = [];
  const ignored: Record<string, number> = {};
  const skipped = { hidden: 0, unreadable: 0 };

  const push = (layer: string, pts: Loop, closed: boolean, m: Mat) => {
    if (pts.length < 2) return;
    const t = pts.map(p => apply(m, p)).map(p => ({ x: p.x * scaleToMm, y: p.y * scaleToMm }));
    shapes.push({ layer: layer || '0', pts: t, closed: closed && t.length >= 3 });
  };

  const handle = (e: IEntity & Record<string, any>, m: Mat, layerOverride: string | null, depth: number) => {
    const layer = layerOverride && (e.layer === '0' || !e.layer) ? layerOverride : (e.layer || '0');
    if (hiddenLayers.has(layer)) { skipped.hidden++; return; }
    // tolerance in the entity's own units, so curves are accurate after scaling
    const tol = TOL_MM / (scaleToMm * scaleOf(m));
    switch (e.type) {
      case 'LINE': {
        const v = e.vertices as IPoint[];
        if (v?.length >= 2) push(layer, [v[0], v[1]], false, m);
        break;
      }
      case 'LWPOLYLINE':
      case 'POLYLINE': {
        if (e.type === 'POLYLINE' && (e.isPolyfaceMesh || e.is3dPolygonMesh)) { ignored['3D meshes'] = (ignored['3D meshes'] ?? 0) + 1; break; }
        const v = (e.vertices ?? []) as (IPoint & { bulge?: number })[];
        if (v.length < 2) break;
        const closed = !!e.shape;
        const pts: Pt[] = [{ x: v[0].x, y: v[0].y }];
        const segs = closed ? v.length : v.length - 1;
        for (let i = 0; i < segs; i++) {
          const a = v[i], b = v[(i + 1) % v.length];
          const arc = bulgePoints({ x: a.x, y: a.y }, { x: b.x, y: b.y }, a.bulge ?? 0, tol);
          pts.push(...arc.slice(1));
        }
        if (closed) pts.pop(); // last point repeats the first
        push(layer, pts, closed, m);
        break;
      }
      case 'CIRCLE': {
        const pts = arcPoints(e.center.x, e.center.y, e.radius, 0, 2 * Math.PI, tol);
        pts.pop();
        push(layer, pts, true, m);
        break;
      }
      case 'ARC': {
        let a0 = e.startAngle, a1 = e.endAngle;
        while (a1 <= a0) a1 += 2 * Math.PI;
        push(layer, arcPoints(e.center.x, e.center.y, e.radius, a0, a1 - a0, tol), false, m);
        break;
      }
      case 'ELLIPSE': {
        const maj = e.majorAxisEndPoint as IPoint, ratio = e.axisRatio as number;
        const mx = maj.x, my = maj.y, nx = -my * ratio, ny = mx * ratio;
        let t0 = e.startAngle ?? 0, t1 = e.endAngle ?? 2 * Math.PI;
        while (t1 <= t0) t1 += 2 * Math.PI;
        const full = Math.abs(t1 - t0 - 2 * Math.PI) < 1e-6;
        const r = Math.max(Math.hypot(mx, my), Math.hypot(nx, ny));
        const n = arcSteps(r, t1 - t0, tol);
        const pts = Array.from({ length: n + 1 }, (_, i) => {
          const t = t0 + ((t1 - t0) * i) / n;
          return { x: e.center.x + Math.cos(t) * mx + Math.sin(t) * nx, y: e.center.y + Math.cos(t) * my + Math.sin(t) * ny };
        });
        if (full) pts.pop();
        push(layer, pts, full, m);
        break;
      }
      case 'SPLINE': {
        const s = splinePoints(e, tol);
        if (!s) { skipped.unreadable++; break; }
        const pts = s.pts;
        const closed = s.closed || Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < tol;
        push(layer, closed ? pts.slice(0, -1) : pts, closed, m);
        break;
      }
      case 'INSERT': {
        if (depth > 6) break;
        const block = dxf!.blocks?.[e.name];
        if (!block) { skipped.unreadable++; break; }
        const rot = ((e.rotation ?? 0) * Math.PI) / 180;
        const cos = Math.cos(rot), sin = Math.sin(rot);
        const sx = e.xScale ?? 1, sy = e.yScale ?? 1;
        const base = block.position ?? { x: 0, y: 0 };
        const rows = Math.max(1, e.rowCount ?? 1), cols = Math.max(1, e.columnCount ?? 1);
        for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
          const ox = c * (e.columnSpacing ?? 0), oy = r * (e.rowSpacing ?? 0);
          // block coordinates -> (minus base point) -> scale -> rotate -> move to insert position (+ array offset)
          const local: Mat = [cos * sx, sin * sx, -sin * sy, cos * sy, 0, 0];
          const place: Mat = [1, 0, 0, 1, e.position.x + cos * ox - sin * oy, e.position.y + sin * ox + cos * oy];
          const unbase: Mat = [1, 0, 0, 1, -base.x, -base.y];
          const mm = mul(m, mul(place, mul(local, unbase)));
          for (const sub of block.entities ?? []) handle(sub as IEntity & Record<string, any>, mm, layer, depth + 1);
        }
        break;
      }
      case 'TEXT': {
        // Left-aligned text starts at startPoint; centred/right-aligned text is anchored at the alignment point (endPoint).
        const h = e.halign ?? 0;
        const at: IPoint = h === 1 || h === 2 ? e.endPoint ?? e.startPoint : e.startPoint;
        const q = apply(m, at);
        texts.push({
          layer, text: dxfText(e.text), x: q.x * scaleToMm, y: q.y * scaleToMm,
          size: (e.textHeight ?? 0) * scaleOf(m) * scaleToMm, sizeIs: 'cap',
          rotation: (e.rotation ?? 0) + (Math.atan2(m[1], m[0]) * 180) / Math.PI,
          anchor: h === 1 ? 'middle' : h === 2 ? 'end' : 'start', family: 'sans-serif', weight: 400,
        });
        break;
      }
      case 'MTEXT': {
        // MTEXT is positioned at its attachment corner: move down to the first baseline for top attachments.
        const ap: number = e.attachmentPoint ?? 1;
        const height = (e.height ?? 0);
        const dyBase = ap <= 3 ? -height : ap <= 6 ? -height / 2 : 0;
        const rot = (e.rotation ?? 0);
        const r = (rot * Math.PI) / 180;
        // the vertical offset (0, dyBase) rotated by the text's own rotation
        const q = apply(m, { x: e.position.x - Math.sin(r) * dyBase, y: e.position.y + Math.cos(r) * dyBase });
        texts.push({
          layer, text: dxfText(e.text), x: q.x * scaleToMm, y: q.y * scaleToMm,
          size: height * scaleOf(m) * scaleToMm, sizeIs: 'cap',
          rotation: rot + (Math.atan2(m[1], m[0]) * 180) / Math.PI,
          anchor: [2, 5, 8].includes(ap) ? 'middle' : [3, 6, 9].includes(ap) ? 'end' : 'start', family: 'sans-serif', weight: 400,
        });
        break;
      }
      case 'ATTDEF': break;
      case 'DIMENSION': ignored['dimensions'] = (ignored['dimensions'] ?? 0) + 1; break;
      case 'POINT': break;
      default: ignored[`${e.type} items`] = (ignored[`${e.type} items`] ?? 0) + 1;
    }
  };

  for (const e of dxf.entities ?? []) handle(e as IEntity & Record<string, any>, IDENT, null, 0);

  if (ignored['dimensions']) notes.push(`${ignored['dimensions']} dimension(s) were ignored.`);
  if (ignored['3D meshes']) notes.push(`${ignored['3D meshes']} 3D mesh(es) were ignored: only 2D lines are imported.`);
  for (const [k, v] of Object.entries(ignored)) if (!['text', 'dimensions', '3D meshes'].includes(k)) notes.push(`${v} ${String(k).replace(/[<>&"]/g, '')} were ignored.`);
  if (skipped.hidden) notes.push(`${skipped.hidden} item(s) on hidden or frozen layers were skipped.`);
  if (skipped.unreadable) notes.push(`${skipped.unreadable} item(s) could not be read and were skipped.`);
  if (!shapes.length && !texts.length) notes.push('No lines were found in this file.');
  return { shapes, texts, notes, fileUnits, scaleToMm };
}

/** Plain text from a DXF TEXT/MTEXT string: drop formatting codes, turn \P into a new line, expand the %% symbols. */
export function dxfText(s: string | undefined): string {
  return (s ?? '')
    .replace(/\\P/g, '\n').replace(/\\~/g, ' ')
    .replace(/\\[ACcFfHhQqTtWw][^;]*;/g, '')       // font, colour, height, width, ... settings: \Farial|b0;
    .replace(/\\[LlOoKk]/g, '')                    // underline, overline, strike-through switches
    .replace(/\\S([^^;]*)\^([^;]*);/g, '$1/$2')    // stacked fractions
    .replace(/\\\\/g, '\\').replace(/[{}]/g, '')
    .replace(/%%[dD]/g, '\u00b0').replace(/%%[pP]/g, '\u00b1').replace(/%%[cC]/g, '\u00d8');
}
