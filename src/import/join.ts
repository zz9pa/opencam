import type { Loop, Pt } from '../core/types';
import type { RawShape } from './shape';

export interface JoinStats {
  /** How many open pieces were merged into longer shapes */
  piecesMerged: number;
  /** How many closed outlines were created (by joining pieces, or by closing a near-closed line) */
  closedCreated: number;
  /** Points where 3 or more line ends meet: left alone because it is unclear which way the outline goes */
  ambiguousJunctions: number;
  duplicatesRemoved: number;
  tinyRemoved: number;
  /** Largest straight closing segment added to a nearly-closed line, mm (0 if none) */
  largestClosedGap: number;
}

export const emptyStats = (): JoinStats => ({ piecesMerged: 0, closedCreated: 0, ambiguousJunctions: 0, duplicatesRemoved: 0, tinyRemoved: 0, largestClosedGap: 0 });

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

export function pathLength(pts: Loop, closed: boolean): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]);
  if (closed && pts.length > 1) s += dist(pts[pts.length - 1], pts[0]);
  return s;
}

/**
 * Join open pieces that meet end to end (within `tol` mm) into longer lines, and close any that return
 * to their start. Only pieces on the same layer are joined.
 *
 * End points within `tol` of each other form a "node". A node with exactly two ends is a clean join.
 * A node with three or more ends (a T-junction or a star) is ambiguous, so none of its ends are joined.
 */
export function joinShapes(shapes: RawShape[], tol: number, stats: JoinStats = emptyStats()): { shapes: RawShape[]; stats: JoinStats } {
  const out: RawShape[] = [];
  for (const layer of [...new Set(shapes.map(s => s.layer))]) {
    const here = shapes.filter(s => s.layer === layer);
    out.push(...here.filter(s => s.closed || s.pts.length < 2));
    out.push(...joinLayer(layer, here.filter(s => !s.closed && s.pts.length >= 2), tol, stats));
  }
  return { shapes: out, stats };
}

function joinLayer(layer: string, pieces: RawShape[], tol: number, stats: JoinStats): RawShape[] {
  const n = pieces.length;
  if (!n) return [];
  // End id: 2*i = start of piece i, 2*i+1 = end of piece i.
  const endPt = (e: number): Pt => (e & 1 ? pieces[e >> 1].pts[pieces[e >> 1].pts.length - 1] : pieces[e >> 1].pts[0]);

  // Cluster end points into nodes (union-find over a spatial grid).
  const cell = Math.max(tol, 1e-3) * 2;
  const grid = new Map<string, number[]>();
  const cellOf = (p: Pt) => [Math.floor(p.x / cell), Math.floor(p.y / cell)] as const;
  for (let e = 0; e < 2 * n; e++) {
    const [cx, cy] = cellOf(endPt(e));
    const k = `${cx},${cy}`;
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(e);
  }
  const parent = Array.from({ length: 2 * n }, (_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (let e = 0; e < 2 * n; e++) {
    const p = endPt(e);
    const [cx, cy] = cellOf(p);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      for (const o of grid.get(`${cx + i},${cy + j}`) ?? []) {
        if (o > e && dist(p, endPt(o)) <= tol) parent[find(o)] = find(e);
      }
    }
  }
  const nodeEnds = new Map<number, number[]>();
  for (let e = 0; e < 2 * n; e++) (nodeEnds.get(find(e)) ?? nodeEnds.set(find(e), []).get(find(e))!).push(e);

  /** Unit direction leaving the node along the piece that owns end `e`. */
  const dirOut = (e: number): Pt => {
    const pts = pieces[e >> 1].pts;
    const seq = e & 1 ? [...pts].reverse() : pts;
    const o = seq[0];
    const far = Math.max(tol * 4, 0.3);
    let q = seq[seq.length - 1];
    for (let i = 1; i < seq.length; i++) if (dist(o, seq[i]) >= far) { q = seq[i]; break; }
    const l = dist(o, q) || 1;
    return { x: (q.x - o.x) / l, y: (q.y - o.y) / l };
  };

  // Which end each end is joined to. Two ends meeting = a clean join. Three or more (a line ending on an
  // outline, or a crossing) = continue straight through: pair the ends that run most nearly in line, and
  // leave the rest free. If nothing is clearly straight (a star, a sharp corner) leave them all unjoined.
  const STRAIGHT = -0.9; // cosine of the angle between the two outgoing directions (-1 = dead straight)
  const pairOf = new Map<number, number>();
  for (const ends of nodeEnds.values()) {
    if (ends.length === 2) { pairOf.set(ends[0], ends[1]); pairOf.set(ends[1], ends[0]); continue; }
    if (ends.length < 3) continue;
    const dirs = new Map(ends.map(e => [e, dirOut(e)] as const));
    const cands: { a: number; b: number; dot: number }[] = [];
    for (let i = 0; i < ends.length; i++) for (let j = i + 1; j < ends.length; j++) {
      if (ends[i] >> 1 === ends[j] >> 1) continue; // never pair a piece with itself here
      const u = dirs.get(ends[i])!, v = dirs.get(ends[j])!;
      cands.push({ a: ends[i], b: ends[j], dot: u.x * v.x + u.y * v.y });
    }
    cands.sort((p, q) => p.dot - q.dot);
    const taken = new Set<number>();
    let any = false;
    for (const c of cands) {
      if (c.dot > STRAIGHT || taken.has(c.a) || taken.has(c.b)) continue;
      pairOf.set(c.a, c.b); pairOf.set(c.b, c.a);
      taken.add(c.a); taken.add(c.b);
      any = true;
    }
    if (!any) stats.ambiguousJunctions++;
  }

  /** The end this end is joined to, if any. */
  const mate = (e: number): number | null => pairOf.get(e) ?? null;

  const visited = new Array<boolean>(n).fill(false);
  const result: RawShape[] = [];

  /** Walk from piece `i`, leaving by its end `outEnd`, appending joined pieces. Returns the points and whether it came back round. */
  const walk = (i: number, startReversed: boolean): { pts: Pt[]; count: number; closed: boolean } => {
    visited[i] = true;
    let pts: Pt[] = startReversed ? [...pieces[i].pts].reverse() : [...pieces[i].pts];
    let count = 1;
    let outEnd = startReversed ? 2 * i : 2 * i + 1;
    for (let guard = 0; guard <= n; guard++) {
      const m = mate(outEnd);
      if (m === null) return { pts, count, closed: false };
      const p = m >> 1;
      if (p === i) {
        // Back at the start piece: the line has gone round into a loop.
        return { pts, count, closed: pts.length >= 3 };
      }
      if (visited[p]) return { pts, count, closed: false };
      visited[p] = true;
      count++;
      const enteringAtStart = (m & 1) === 0;
      const seg = enteringAtStart ? pieces[p].pts : [...pieces[p].pts].reverse();
      pts = [...pts, ...seg.slice(1)]; // seg[0] coincides with the point we are leaving
      outEnd = enteringAtStart ? 2 * p + 1 : 2 * p;
    }
    return { pts, count, closed: false };
  };

  const emit = (r: { pts: Pt[]; count: number; closed: boolean }) => {
    if (r.count > 1) stats.piecesMerged += r.count;
    if (r.closed) {
      stats.closedCreated++;
      // The last point repeats the first (they were within tol): drop it.
      const pts = dist(r.pts[0], r.pts[r.pts.length - 1]) <= tol ? r.pts.slice(0, -1) : r.pts;
      result.push({ layer, pts, closed: true });
    } else result.push({ layer, pts: r.pts, closed: false });
  };

  // 1) Lines with a free (or ambiguous) end: start there so every chain is taken from one end to the other.
  for (let i = 0; i < n; i++) {
    if (visited[i]) continue;
    const headFree = mate(2 * i) === null, tailFree = mate(2 * i + 1) === null;
    if (!headFree && !tailFree) continue;
    // Leave by the end opposite the free one: if only the tail is free, reverse the piece first.
    emit(walk(i, tailFree && !headFree));
  }

  // 2) Anything left is part of a loop.
  for (let i = 0; i < n; i++) if (!visited[i]) emit(walk(i, false));
  return result;
}

/** Remove shapes too short to matter (stray specks). */
export function dropTiny(shapes: RawShape[], minLength: number, stats: JoinStats = emptyStats()): RawShape[] {
  return shapes.filter(s => {
    const keep = pathLength(s.pts, s.closed) >= minLength;
    if (!keep) stats.tinyRemoved++;
    return keep;
  });
}

/** Remove shapes drawn twice on top of each other (same layer, same outline, either direction, any start point). */
export function dedupeShapes(shapes: RawShape[], stats: JoinStats = emptyStats()): RawShape[] {
  const q = (v: number) => Math.round(v / 0.01);
  const seen = new Set<string>();
  const out: RawShape[] = [];
  for (const s of shapes) {
    let key: string;
    const len = pathLength(s.pts, s.closed);
    if (s.closed) {
      let a = 0, cx = 0, cy = 0;
      for (let i = 0; i < s.pts.length; i++) {
        const p = s.pts[i], r = s.pts[(i + 1) % s.pts.length];
        const c = p.x * r.y - r.x * p.y;
        a += c; cx += (p.x + r.x) * c; cy += (p.y + r.y) * c;
      }
      a /= 2;
      key = a === 0 ? `z|${q(len)}` : `c|${q(Math.abs(a))}|${q(cx / (6 * a))}|${q(cy / (6 * a))}|${q(len)}`;
    } else {
      const e = [s.pts[0], s.pts[s.pts.length - 1]].map(p => `${q(p.x)},${q(p.y)}`).sort();
      key = `o|${e[0]}|${e[1]}|${q(len)}`;
    }
    key = `${s.layer}|${key}`;
    if (seen.has(key)) { stats.duplicatesRemoved++; continue; }
    seen.add(key);
    out.push(s);
  }
  return out;
}

/** Run the whole clean-up: tiny specks, joining, duplicates. */
export function cleanShapes(shapes: RawShape[], opts: { joinTol: number; closeTol?: number; dedupe: boolean }): { shapes: RawShape[]; stats: JoinStats } {
  const stats = emptyStats();
  let s = dropTiny(shapes, 0.01, stats);
  if (opts.dedupe) s = dedupeShapes(s, stats);
  if (opts.joinTol > 0) s = joinShapes(s, opts.joinTol, stats).shapes;
  // A line whose own ends nearly meet becomes a closed shape: either within the join tolerance, or within the
  // (larger) close tolerance when the gap is tiny compared with the line (at most 2% of its length).
  const closeTol = opts.closeTol ?? 0;
  s = s.map(sh => {
    if (sh.closed || sh.pts.length < 3) return sh;
    const gap = dist(sh.pts[0], sh.pts[sh.pts.length - 1]);
    const loopLike = gap <= closeTol && gap <= 0.02 * pathLength(sh.pts, false);
    if ((opts.joinTol > 0 && gap <= opts.joinTol) || loopLike) {
      stats.closedCreated++;
      stats.largestClosedGap = Math.max(stats.largestClosedGap, gap);
      // Drop the last point only if it duplicates the first; otherwise the closing segment spans the gap.
      return { ...sh, pts: gap < 1e-6 ? sh.pts.slice(0, -1) : sh.pts, closed: true };
    }
    return sh;
  });
  if (opts.dedupe) s = dedupeShapes(s, stats); // joining can reveal new duplicates
  return { shapes: s, stats };
}
