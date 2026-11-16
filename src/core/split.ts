import { minOf, maxOf } from './util';
import type { Cut, Pt, Pt3, Toolpath } from './types';

/**
 * Splitting a job that is longer than the work area into segments along X.
 *
 * Each segment has a window [x0, x1] in drawing coordinates. Consecutive windows overlap by `overlap` mm and
 * every window is shifted by the same `shift` = segLen - overlap, so after the stock is slid by `shift` the
 * registration pins always sit at the same two sets of machine positions.
 */
export interface SplitPlan {
  /** Number of segments (1 = the part fits and no split is needed) */
  n: number;
  /** Width of each window, mm */
  segLen: number;
  /** How far the stock slides between segments, mm */
  shift: number;
  overlap: number;
  windows: { x0: number; x1: number }[];
}

export function planSplit(p: { minX: number; maxX: number; bedX: number; margin: number; overlap: number }): SplitPlan {
  const length = p.maxX - p.minX;
  const segLen = p.bedX - 2 * p.margin;
  if (segLen <= p.overlap * 2) {
    return { n: 1, segLen, shift: 0, overlap: p.overlap, windows: [{ x0: p.minX, x1: p.maxX }] };
  }
  if (length <= segLen) return { n: 1, segLen, shift: 0, overlap: p.overlap, windows: [{ x0: p.minX, x1: p.maxX }] };
  const shift = segLen - p.overlap;
  const n = Math.ceil((length - p.overlap) / shift);
  const windows = Array.from({ length: n }, (_, k) => ({ x0: p.minX + k * shift, x1: p.minX + k * shift + segLen }));
  return { n, segLen, shift, overlap: p.overlap, windows };
}

/**
 * Cut a 3D polyline to the X window. Returns the pieces inside the window; Z is interpolated where a
 * move crosses the edge. A piece that starts or ends at the edge is an open run.
 */
export function clipMoves(moves: Pt3[], x0: number, x1: number): Pt3[][] {
  const runs: Pt3[][] = [];
  let cur: Pt3[] = [];
  const inside = (p: Pt3) => p.x >= x0 - 1e-9 && p.x <= x1 + 1e-9;
  const cross = (a: Pt3, b: Pt3, x: number): Pt3 => {
    const t = (x - a.x) / (b.x - a.x);
    return { x, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
  };
  const flush = () => { if (cur.length > 1) runs.push(cur); cur = []; };
  for (let i = 0; i < moves.length; i++) {
    const b = moves[i];
    const a = i > 0 ? moves[i - 1] : null;
    if (!a) { if (inside(b)) cur.push({ ...b }); continue; }
    const ai = inside(a), bi = inside(b);
    if (ai && bi) {
      if (!cur.length) cur.push({ ...a });
      cur.push({ ...b });
    } else if (ai && !bi) {
      if (!cur.length) cur.push({ ...a });
      const edge = b.x > x1 ? x1 : x0;
      cur.push(cross(a, b, edge));
      flush();
    } else if (!ai && bi) {
      const edge = a.x < x0 ? x0 : x1;
      cur = [cross(a, b, edge), { ...b }];
    } else if ((a.x < x0 && b.x > x1) || (a.x > x1 && b.x < x0)) {
      // passes straight through the whole window
      const e0 = a.x < b.x ? x0 : x1, e1 = a.x < b.x ? x1 : x0;
      runs.push([cross(a, b, e0), cross(a, b, e1)]);
    }
  }
  flush();
  return runs;
}

/** The part of a toolpath that lies inside the window, as open runs. */
export function clipToolpath(tp: Toolpath, x0: number, x1: number): Toolpath {
  const cuts: Cut[] = [];
  for (const c of tp.cuts) {
    for (const run of clipMoves(c.moves, x0, x1)) {
      // skip runs that are just a point
      if (run.every(m => Math.abs(m.x - run[0].x) < 1e-9 && Math.abs(m.y - run[0].y) < 1e-9 && Math.abs(m.z - run[0].z) < 1e-9)) continue;
      cuts.push({ loop: run.map(m => ({ x: m.x, y: m.y })), z: minOf(run.map(m => m.z)), zStart: c.zStart, closed: false, moves: run });
    }
  }
  return { ...tp, cuts };
}

export interface PinLayout {
  /** Gap between the part's top edge (max Y) and the nearest pin, mm */
  distance: number;
  /** Gap between the two pins of the pair, mm */
  pairGap: number;
  /** Half the distance in X between the single pin and the pair, mm */
  halfSpan: number;
}

/**
 * A keyed triangle of registration pins, centred on `xc` in the waste margin above the part:
 * one pin on the left and a pair on the right. Only one orientation matches, so the stock can't be slid on
 * rotated or the wrong way round.
 */
export function registrationPins(xc: number, partMaxY: number, l: PinLayout, axisY?: number): Pt[] {
  const yc = partMaxY + l.distance + l.pairGap / 2;
  const top: Pt[] = [
    { x: xc - l.halfSpan, y: yc },
    { x: xc + l.halfSpan, y: yc - l.pairGap / 2 },
    { x: xc + l.halfSpan, y: yc + l.pairGap / 2 },
  ];
  if (axisY === undefined) return top;
  // Two-sided: add the mirror image below the turn-over line so the whole set lands on itself after the flip,
  // yet is still keyed (rotating or flipping the other way round doesn't fit).
  return [...top, ...top.map(p => ({ x: p.x, y: 2 * axisY - p.y }))];
}

/** Where the pins drilled at the end of segment k sit in the drawing frame: centred in that overlap. */
export function junctionCentreX(plan: SplitPlan, k: number): number {
  return plan.windows[k + 1].x0 + plan.overlap / 2;
}
