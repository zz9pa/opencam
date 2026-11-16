import type { Cut, Loop, Pt } from './types';
import { drill, type DrillParams } from './ops';

/** If the closed shape is a circle (within `tol` of constant radius), its centre and diameter; otherwise null. */
export function circleOf(pts: Loop, tol = 0.03): { x: number; y: number; d: number } | null {
  if (pts.length < 8) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  const w = maxX - minX, h = maxY - minY;
  if (w <= 0 || Math.abs(w - h) > Math.max(tol * 2, 0.02 * Math.max(w, h))) return null;
  const x = (minX + maxX) / 2, y = (minY + maxY) / 2;
  const r = (w + h) / 4;
  let worst = 0;
  for (const p of pts) worst = Math.max(worst, Math.abs(Math.hypot(p.x - x, p.y - y) - r));
  return worst <= Math.max(tol, 0.01 * r) ? { x, y, d: 2 * r } : null;
}

/** Order points to keep travel short (nearest neighbour from the first). */
export function nearestOrder(pts: Pt[]): Pt[] {
  const left = pts.slice(), out: Pt[] = [];
  if (!left.length) return out;
  let cur = left.shift()!;
  out.push(cur);
  while (left.length) {
    let bi = 0, bd = Infinity;
    left.forEach((p, i) => { const d = Math.hypot(p.x - cur.x, p.y - cur.y); if (d < bd) { bd = d; bi = i; } });
    cur = left.splice(bi, 1)[0];
    out.push(cur);
  }
  return out;
}

export interface DrillPlan {
  cuts: Cut[];
  /** Plain facts about what will happen to each size of hole */
  info: string[];
  /** Things that need the user's attention */
  warnings: string[];
}

/**
 * Drill every round shape in `closed`: group by diameter (0.01 mm), visit the holes in a short order, and describe
 * what the bit will do for each size. Holes smaller than the bit are skipped; shapes that are not round are ignored.
 */
export function planDrill(closed: Loop[], p: Omit<DrillParams, 'holeDiameter'>): DrillPlan {
  const groups = new Map<number, Pt[]>();
  let notRound = 0;
  for (const pts of closed) {
    const c = circleOf(pts);
    if (!c) { notRound++; continue; }
    const key = Math.round(c.d * 100) / 100;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({ x: c.x, y: c.y });
  }
  const bit = p.tool.diameter;
  const cuts: Cut[] = [], info: string[] = [], warnings: string[] = [];
  let tooSmall = 0;
  for (const d of [...groups.keys()].sort((a, b) => a - b)) {
    const centres = nearestOrder(groups.get(d)!);
    const t = drill(centres, { ...p, holeDiameter: d });
    if (!t.cuts.length) { tooSmall += centres.length; continue; }
    cuts.push(...t.cuts);
    if (d - bit < 0.2) {
      info.push(`${centres.length} hole(s) of ${d} mm: drilled straight down in pecks by the ${bit} mm bit.`);
      if (d < bit - 0.005) warnings.push(`The ${d} mm hole(s) are slightly smaller than the ${bit} mm bit and will come out ${bit} mm.`);
    } else info.push(`${centres.length} hole(s) of ${d} mm: spiralled out by the ${bit} mm bit.`);
  }
  if (notRound) warnings.push(`${notRound} selected shape(s) are not round and were skipped. Use Pocket or Cut out (inside) for other shapes.`);
  if (tooSmall) warnings.push(`${tooSmall} hole(s) are smaller than the ${bit} mm bit and were skipped. Choose a smaller bit.`);
  return { cuts, info, warnings };
}