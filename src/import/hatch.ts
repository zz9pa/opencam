import type { Pt } from '../core/types';

/**
 * HATCH entities (filled areas) from an ASCII DXF. The DXF library used for everything else does not read them, so they are read
 * here from the raw group codes. Only their boundary outlines are returned, as closed loops in drawing units: a hatch pattern
 * inside is not a cutting path. Spline edges are not read (the boundary is then reported as unreadable).
 */
export interface HatchResult { layer: string; loops: Pt[][]; unreadable: number }

type Pair = [number, string];

export function readPairs(text: string): Pair[] {
  const lines = text.split(/\r?\n/);
  const out: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const c = parseInt(lines[i].trim(), 10);
    if (Number.isNaN(c)) continue;
    out.push([c, lines[i + 1].trim()]);
  }
  return out;
}

const deg = (a: number) => (a * Math.PI) / 180;

function arcPts(cx: number, cy: number, r: number, a0: number, a1: number, ccw: boolean): Pt[] {
  let sweep = a1 - a0;
  if (ccw) { while (sweep <= 0) sweep += 2 * Math.PI; } else { while (sweep >= 0) sweep -= 2 * Math.PI; }
  const n = Math.max(8, Math.min(2000, Math.ceil((Math.abs(sweep) * r) / 0.2)));
  return Array.from({ length: n + 1 }, (_, i) => ({ x: cx + r * Math.cos(a0 + (sweep * i) / n), y: cy + r * Math.sin(a0 + (sweep * i) / n) }));
}

function bulgePts(a: Pt, b: Pt, bulge: number): Pt[] {
  const dx = b.x - a.x, dy = b.y - a.y, c = Math.hypot(dx, dy);
  if (!c || Math.abs(bulge) < 1e-9) return [a, b];
  const th = 4 * Math.atan(bulge), r = Math.abs(c / (2 * Math.sin(th / 2))), off = c / 2 / Math.tan(th / 2);
  const cx = (a.x + b.x) / 2 + (-dy / c) * off, cy = (a.y + b.y) / 2 + (dx / c) * off;
  return arcPts(cx, cy, r, Math.atan2(a.y - cy, a.x - cx), Math.atan2(a.y - cy, a.x - cx) + th, th > 0);
}

export function parseHatches(text: string): HatchResult[] {
  const pairs = readPairs(text);
  const results: HatchResult[] = [];
  // the ENTITIES section only
  let s = pairs.findIndex((p, i) => p[0] === 2 && p[1] === 'ENTITIES' && pairs[i - 1]?.[0] === 0 && pairs[i - 1][1] === 'SECTION');
  if (s < 0) return results;
  s++;
  for (let i = s; i < pairs.length; i++) {
    if (pairs[i][0] === 0 && pairs[i][1] === 'ENDSEC') break;
    if (!(pairs[i][0] === 0 && pairs[i][1] === 'HATCH')) continue;
    let e = i + 1;
    while (e < pairs.length && pairs[e][0] !== 0) e++;
    const g = pairs.slice(i + 1, e);
    i = e - 1;
    const layer = g.find(p => p[0] === 8)?.[1] ?? '0';
    const res: HatchResult = { layer, loops: [], unreadable: 0 };
    // walk the boundary paths: they start after group 91 and each begins with a group 92
    let k = g.findIndex(p => p[0] === 91);
    if (k < 0) continue;
    const nPaths = parseInt(g[k][1], 10) || 0;
    k++;
    const num = (code: number, at: number) => (g[at] && g[at][0] === code ? parseFloat(g[at][1]) : NaN);
    for (let path = 0; path < nPaths; path++) {
      while (k < g.length && g[k][0] !== 92) k++;
      if (k >= g.length) break;
      const flags = parseInt(g[k][1], 10) || 0;
      k++;
      let pts: Pt[] = [];
      let ok = true;
      if (flags & 2) {                                         // a polyline boundary
        let hasBulge = false, n = 0;
        while (k < g.length && g[k][0] !== 93) { if (g[k][0] === 72) hasBulge = g[k][1] === '1'; k++; }
        n = parseInt(g[k]?.[1] ?? '0', 10) || 0; k++;
        const v: { p: Pt; b: number }[] = [];
        for (let q = 0; q < n && k < g.length; q++) {
          const x = num(10, k), y = num(20, k + 1);
          if (Number.isNaN(x) || Number.isNaN(y)) { ok = false; break; }
          k += 2;
          let b = 0;
          if (hasBulge && g[k]?.[0] === 42) { b = parseFloat(g[k][1]); k++; }
          v.push({ p: { x, y }, b });
        }
        for (let q = 0; q < v.length; q++) {
          const a = v[q], b = v[(q + 1) % v.length];
          pts.push(...bulgePts(a.p, b.p, a.b).slice(0, -1));
        }
      } else {                                                 // edges: lines, arcs, ellipses (splines are not read)
        while (k < g.length && g[k][0] !== 93) k++;
        const ne = parseInt(g[k]?.[1] ?? '0', 10) || 0; k++;
        for (let q = 0; q < ne && k < g.length; q++) {
          if (g[k][0] !== 72) { ok = false; break; }
          const type = parseInt(g[k][1], 10); k++;
          const val: Record<number, number> = {};
          const start = k;
          while (k < g.length && g[k][0] !== 72 && g[k][0] !== 97 && !(g[k][0] === 92) && !(g[k][0] === 75)) {
            // a spline carries its own 72-free block of counts and points: stop reading edges
            if (type === 4) break;
            val[g[k][0] * 10 + (val[g[k][0] * 10] !== undefined ? 1 : 0)] = parseFloat(g[k][1]);
            k++;
          }
          void start;
          if (type === 1) pts.push({ x: val[100], y: val[200] }, { x: val[110], y: val[210] });
          else if (type === 2) {
            const ccw = val[730] !== 0;
            pts.push(...arcPts(val[100], val[200], val[400], deg(val[500]), deg(val[510]), ccw));
          } else if (type === 3) {
            const mx = val[110], my = val[210], ratio = val[400];
            const nx = -my * ratio, ny = mx * ratio;
            let t0 = deg(val[500]), t1 = deg(val[510]);
            if (val[730] === 0) { const t = t0; t0 = t1; t1 = t; }
            while (t1 <= t0) t1 += 2 * Math.PI;
            const r = Math.max(Math.hypot(mx, my), Math.hypot(nx, ny)), n = Math.max(12, Math.min(2000, Math.ceil(((t1 - t0) * r) / 0.2)));
            for (let u = 0; u <= n; u++) { const t = t0 + ((t1 - t0) * u) / n; pts.push({ x: val[100] + Math.cos(t) * mx + Math.sin(t) * nx, y: val[200] + Math.cos(t) * my + Math.sin(t) * ny }); }
          } else { ok = false; break; }
        }
      }
      pts = pts.filter((p, i) => !i || Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) > 1e-9);
      if (pts.length > 1 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < 1e-6) pts.pop();
      if (ok && pts.length >= 3 && pts.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))) res.loops.push(pts); else res.unreadable++;
    }
    if (res.loops.length || res.unreadable) results.push(res);
  }
  return results;
}
