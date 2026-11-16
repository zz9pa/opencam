import { inflatePathsD, ramerDouglasPeuckerPathsD, unionD, differenceD, FillRule, JoinType, EndType } from 'clipper2-ts';
import type { Loop, Pt } from './types';

const toPath = (l: Loop) => l.map(p => ({ x: p.x, y: p.y }));
const fromPath = (p: Pt[]): Loop => p.map(q => ({ x: q.x, y: q.y }));

/** Signed area; positive = counter-clockwise (Y up). */
export function signedArea(l: Loop): number {
  let a = 0;
  for (let i = 0; i < l.length; i++) {
    const p = l[i], q = l[(i + 1) % l.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/**
 * Normalise arbitrary input: even-odd union so outers are CCW (+area)
 * and holes are CW (-area).
 */
export function normalize(loops: Loop[]): Loop[] {
  return unionD(loops.map(toPath), [], FillRule.EvenOdd).map(fromPath);
}

/** Union of overlapping loops that all wind the same way (non-zero fill): the combined outline, outers CCW and holes CW. */
export function unionAll(loops: Loop[]): Loop[] {
  return unionD(loops.map(toPath), [], FillRule.NonZero).map(fromPath);
}

/** Offset by delta mm (positive grows outward, negative shrinks). */
export function offset(loops: Loop[], delta: number): Loop[] {
  if (delta === 0) return loops;
  return simplify(inflatePathsD(loops.map(toPath), delta, JoinType.Round, EndType.Polygon, 2, 4, 0.02).map(fromPath));
}

/** Drop points that deviate less than `eps` mm: cuts G-code size several-fold with no visible loss. */
export function simplify(loops: Loop[], eps = 0.01): Loop[] {
  return ramerDouglasPeuckerPathsD(loops.map(toPath), eps).map(fromPath).filter(l => l.length >= 3);
}

/** Same for an open polyline (endpoints preserved). */
export function simplifyOpen(pts: Loop, eps = 0.01): Loop {
  const r = ramerDouglasPeuckerPathsD([toPath(pts)], eps)[0];
  return r && r.length >= 2 ? fromPath(r) : pts;
}

export const reverse = (l: Loop): Loop => [...l].reverse();

/** Region `a` with region `b` cut out of it (both even-odd regions). Used to find what one bit cannot reach. */
export function subtract(a: Loop[], b: Loop[]): Loop[] {
  if (!a.length) return [];
  if (!b.length) return a;
  return differenceD(a.map(toPath), b.map(toPath), FillRule.EvenOdd).map(fromPath);
}

/** Total area of a normalised region (outer loops positive, holes negative). */
export function regionArea(loops: Loop[]): number {
  return loops.reduce((s, l) => s + signedArea(l), 0);
}

/** Is the point inside the (even-odd) region? */
export function insideRegion(loops: Loop[], x: number, y: number): boolean {
  let c = false;
  for (const l of loops) for (let i = 0, j = l.length - 1; i < l.length; j = i++) {
    const a = l[i], b = l[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}
