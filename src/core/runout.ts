import type { Loop, Pt } from './types';
import { signedArea, unionAll } from './geometry';

/** Direction a line is heading as it leaves `from`, using the last few mm of the line (candidates nearest first). */
function heading(from: Pt, others: Pt[]): Pt | null {
  for (const p of others) {
    const d = Math.hypot(from.x - p.x, from.y - p.y);
    if (d >= 2) return { x: (from.x - p.x) / d, y: (from.y - p.y) / d };
  }
  return null;
}

interface Hit { p: Pt; seg: number; u: number }

/** Where the ray from `o` in direction `d` first crosses the closed outline. An end on the outline, or up to 1.5 mm past it, counts as reaching it. */
function rayHit(o: Pt, d: Pt, edge: Loop): Hit | null {
  let best: { t: number; seg: number; u: number } | null = null;
  for (let i = 0; i < edge.length; i++) {
    const a = edge[i], b = edge[(i + 1) % edge.length];
    const ex = b.x - a.x, ey = b.y - a.y;
    const den = d.x * ey - d.y * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((a.x - o.x) * ey - (a.y - o.y) * ex) / den; // along the ray
    const u = ((a.x - o.x) * d.y - (a.y - o.y) * d.x) / den; // along the edge segment
    if (t > -1.5 && u >= -1e-9 && u <= 1 + 1e-9 && (best === null || t < best.t)) best = { t, seg: i, u };
  }
  if (!best) return null;
  const a = edge[best.seg], b = edge[(best.seg + 1) % edge.length];
  return { p: { x: a.x + (b.x - a.x) * best.u, y: a.y + (b.y - a.y) * best.u }, seg: best.seg, u: best.u };
}

/** Outline points from hit `a` to hit `b` in the direction the outline is stored (forward) or against it. Both hit points included. */
function walk(edge: Loop, a: Hit, b: Hit, forward: boolean): Pt[] {
  const n = edge.length, out: Pt[] = [a.p];
  if (forward) {
    if (!(b.seg === a.seg && b.u >= a.u)) {
      let i = a.seg;
      do { i = (i + 1) % n; out.push(edge[i]); } while (i !== b.seg);
    }
  } else if (!(b.seg === a.seg && b.u <= a.u)) {
    let i = a.seg;
    out.push(edge[i]);
    while (i !== (b.seg + 1) % n) { i = (i - 1 + n) % n; if (i !== (b.seg + 1) % n) out.push(edge[i]); }
  }
  out.push(b.p);
  return out;
}

const pathLen = (p: Pt[]) => p.reduce((s, q, i) => (i ? s + Math.hypot(q.x - p[i - 1].x, q.y - p[i - 1].y) : 0), 0);

/**
 * Turn an open line into a closed shape that runs OUT through an outline (for example a pocket that opens out of the edge
 * of a part). Each end carries on in the direction it was heading until it meets `edge`; the shape is closed by following
 * the outline (the shorter way round) between those two points. `free` marks the points of that outline-following side, which
 * is an open side rather than a real wall: see expandFreeEdge. Returns null if an end never reaches the outline.
 */
export function runOutToEdge(line: Loop, edge: Loop): { pts: Loop; free: [number, number] } | null {
  if (line.length < 3 || edge.length < 3) return null;
  const end = line[line.length - 1], start = line[0];
  const he = heading(end, [...line].reverse().slice(1));
  const hs = heading(start, line.slice(1));
  if (!he || !hs) return null;
  const hitE = rayHit(end, he, edge), hitS = rayHit(start, hs, edge);
  if (!hitE || !hitS) return null;
  const fwd = walk(edge, hitE, hitS, true), back = walk(edge, hitE, hitS, false);
  const arc = pathLen(fwd) <= pathLen(back) ? fwd : back;
  return { pts: [...line, ...arc], free: [line.length, line.length + arc.length] };
}

/**
 * The shape as a region for pocketing, with its open side pushed outwards by `d` mm so a bit of radius up to d can clear
 * right out to and through the edge. Returns the combined outline(s).
 */
export function expandFreeEdge(pts: Loop, free: [number, number], d: number): Loop[] {
  const [a, b] = free;
  if (!(b - a >= 2) || b > pts.length) return [pts];
  const ccw = signedArea(pts) > 0 ? 1 : -1;
  const arc = pts.slice(a, b);
  const pushed = arc.map((p, i) => {
    const q = arc[Math.max(0, i - 1)], n = arc[Math.min(arc.length - 1, i + 1)]; // along the open side only
    const tx = n.x - q.x, ty = n.y - q.y, l = Math.hypot(tx, ty);
    if (l < 1e-9) return p;
    return { x: p.x + (ty / l) * ccw * d, y: p.y + (-tx / l) * ccw * d }; // outside is to the right of travel when counter-clockwise
  });
  let ring = [...arc, ...pushed.reverse()];
  if ((signedArea(ring) > 0 ? 1 : -1) !== ccw) ring = ring.reverse();
  const base = ccw > 0 ? pts : [...pts].reverse();
  const strip = ccw > 0 ? ring : [...ring].reverse();
  return unionAll([base, strip]);
}