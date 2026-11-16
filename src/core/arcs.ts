import type { Pt3 } from './types';

/** One output move: a straight line, or a circular arc (G2/G3) with the centre given relative to the arc start. */
export interface Seg {
  to: Pt3;
  /** `sweep`: angle covered, radians. If `to.z` differs from the start's, the arc is a helix (Z changes evenly along it). */
  arc?: { i: number; j: number; cw: boolean; radius: number; sweep: number };
}

const MIN_RADIUS = 0.4;     // mm: tighter than this is left as short lines
const MAX_RADIUS = 2000;    // mm: flatter than this is just a line
const MAX_SWEEP = Math.PI;  // never emit more than a half circle in one arc (avoids full-circle ambiguity)
const MAX_RUN = 400;        // points considered per arc, bounds the cost

interface Circle { cx: number; cy: number; r: number }

/** Circle through three points, or null if they are (nearly) in a straight line. */
function circumcircle(a: Pt3, b: Pt3, c: Pt3): Circle | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y;
  const cx = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
  const cy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  return { cx, cy, r: Math.hypot(a.x - cx, a.y - cy) };
}

/**
 * Does the run of points p[s..e] lie on one circle (within tol), turning one way, sweeping <= half a circle, with Z either
 * constant or changing evenly with the angle (a helix, as a ramped circle makes)?
 */
function fits(p: Pt3[], s: number, e: number, tol: number): (Circle & { cw: boolean; sweep: number }) | null {
  if (p.some((m, k) => k >= s && k <= e && m.rapid)) return null;
  const mid = (s + e) >> 1;
  const c = circumcircle(p[s], p[mid], p[e]);
  if (!c || c.r < MIN_RADIUS || c.r > MAX_RADIUS) return null;
  let dir = 0, sweep = 0;
  const angles: number[] = [0];
  let prevAng = Math.atan2(p[s].y - c.cy, p[s].x - c.cx);
  for (let k = s; k <= e; k++) {
    if (Math.abs(Math.hypot(p[k].x - c.cx, p[k].y - c.cy) - c.r) > tol) return null;
    if (k === s) continue;
    const ang = Math.atan2(p[k].y - c.cy, p[k].x - c.cx);
    let d = ang - prevAng;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    if (d === 0) return null;
    const sgn = d > 0 ? 1 : -1;
    if (dir === 0) dir = sgn; else if (sgn !== dir) return null; // must keep turning the same way
    sweep += Math.abs(d);
    angles.push(sweep);
    prevAng = ang;
  }
  if (sweep > MAX_SWEEP) return null;
  // Z: constant, or a straight line against the angle turned
  const dz = p[e].z - p[s].z;
  for (let k = s; k <= e; k++) {
    const want = Math.abs(dz) < 1e-9 ? p[s].z : p[s].z + dz * (angles[k - s] / sweep);
    if (Math.abs(p[k].z - want) > Math.min(tol, 0.01) + 1e-9) return null;
  }
  return { ...c, cw: dir < 0, sweep };
}

/**
 * Turn runs of short straight moves that follow a circle into G2/G3 arcs. `p[0]` is the start point; the
 * result has one entry per move after it. Z may change along an arc only evenly (a helix); rapids are never merged.
 * Every original point stays within `tol` mm of the arc that replaces it.
 */
export function fitArcs(p: Pt3[], tol = 0.01): Seg[] {
  const out: Seg[] = [];
  let s = 0;
  while (s < p.length - 1) {
    let best: { e: number; c: Circle & { cw: boolean; sweep: number } } | null = null;
    // Grow the run while it still fits. Three points is the minimum worth replacing.
    for (let e = s + 3; e < p.length && e <= s + MAX_RUN; e++) {
      const c = fits(p, s, e, tol);
      if (!c) { if (best) break; else if (e > s + 6) break; else continue; }
      best = { e, c };
    }
    if (best) {
      const { e, c } = best;
      out.push({ to: p[e], arc: { i: c.cx - p[s].x, j: c.cy - p[s].y, cw: c.cw, radius: c.r, sweep: c.sweep } });
      s = e;
    } else {
      out.push({ to: p[s + 1] });
      s += 1;
    }
  }
  return out;
}

/** Sample an arc segment back into points (for checking accuracy and for previews). */
export function sampleArc(from: { x: number; y: number }, seg: Seg, step = 0.25): { x: number; y: number }[] {
  if (!seg.arc) return [from, seg.to];
  const { i, j, cw } = seg.arc;
  const cx = from.x + i, cy = from.y + j;
  const a0 = Math.atan2(from.y - cy, from.x - cx);
  let a1 = Math.atan2(seg.to.y - cy, seg.to.x - cx);
  let sweep = a1 - a0;
  if (cw) { while (sweep >= 0) sweep -= 2 * Math.PI; } else { while (sweep <= 0) sweep += 2 * Math.PI; }
  const r = Math.hypot(from.x - cx, from.y - cy);
  const n = Math.max(2, Math.ceil((Math.abs(sweep) * r) / step));
  return Array.from({ length: n + 1 }, (_, k) => ({ x: cx + r * Math.cos(a0 + (sweep * k) / n), y: cy + r * Math.sin(a0 + (sweep * k) / n) }));
}
