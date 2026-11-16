import { describe, it, expect } from 'vitest';
import { joinShapes, dedupeShapes, cleanShapes, dropTiny, pathLength } from '../src/import/join';
import type { RawShape } from '../src/import/shape';

const line = (layer: string, ...pts: [number, number][]): RawShape => ({ layer, pts: pts.map(([x, y]) => ({ x, y })), closed: false });
const area = (s: RawShape) => {
  let a = 0;
  for (let i = 0; i < s.pts.length; i++) { const p = s.pts[i], q = s.pts[(i + 1) % s.pts.length]; a += p.x * q.y - q.x * p.y; }
  return Math.abs(a / 2);
};

describe('joining open pieces', () => {
  const sides = [line('L', [0, 0], [10, 0]), line('L', [10, 0], [10, 5]), line('L', [10, 5], [0, 5]), line('L', [0, 5], [0, 0])];
  it('joins four sides into one closed rectangle', () => {
    const { shapes, stats } = joinShapes(sides, 0.05);
    expect(shapes.length).toBe(1);
    expect(shapes[0].closed).toBe(true);
    expect(area(shapes[0])).toBeCloseTo(50);
    expect(shapes[0].pts.length).toBe(4);
    expect(stats.closedCreated).toBe(1);
    expect(stats.piecesMerged).toBe(4);
  });
  it('does not care about order or direction of the pieces', () => {
    const shuffled = [line('L', [10, 5], [10, 0]), line('L', [0, 5], [10, 5]), line('L', [0, 0], [0, 5]), line('L', [10, 0], [0, 0])];
    const { shapes } = joinShapes(shuffled, 0.05);
    expect(shapes.length).toBe(1);
    expect(shapes[0].closed).toBe(true);
    expect(area(shapes[0])).toBeCloseTo(50);
  });
  it('joins across tiny gaps but not big ones', () => {
    const gappy = [line('L', [0, 0], [10, 0]), line('L', [10.03, 0.01], [10, 5]), line('L', [10, 5], [0, 5]), line('L', [0, 5], [0, 0.02])];
    expect(joinShapes(gappy, 0.05).shapes.length).toBe(1);
    // with a tiny tolerance only the pieces that meet exactly are joined (2 chains, nothing closed)
    const strict = joinShapes(gappy, 0.001).shapes;
    expect(strict.length).toBe(2);
    expect(strict.some(s => s.closed)).toBe(false);
  });
  it('keeps an unfinished chain open but still merges it', () => {
    const { shapes } = joinShapes([line('L', [0, 0], [5, 0]), line('L', [5, 0], [5, 5]), line('L', [5, 5], [9, 9])], 0.05);
    expect(shapes.length).toBe(1);
    expect(shapes[0].closed).toBe(false);
    expect(shapes[0].pts.length).toBe(4);
    expect(pathLength(shapes[0].pts, false)).toBeCloseTo(5 + 5 + Math.hypot(4, 4));
  });
  it('merges a chain whose only free end is its tail (pieces given tail-first)', () => {
    const { shapes } = joinShapes([line('L', [5, 5], [9, 9]), line('L', [0, 0], [5, 0]), line('L', [5, 0], [5, 5])], 0.05);
    expect(shapes.length).toBe(1);
    expect(shapes[0].pts.length).toBe(4);
  });
  it('never joins across layers', () => {
    const { shapes } = joinShapes([line('A', [0, 0], [5, 0]), line('B', [5, 0], [5, 5])], 0.05);
    expect(shapes.length).toBe(2);
  });
  it('at a T-junction the outline continues straight through and the stem stays separate', () => {
    const t = [line('L', [0, 0], [5, 0]), line('L', [5, 0], [10, 0]), line('L', [5, 0], [5, 5])];
    const { shapes, stats } = joinShapes(t, 0.05);
    expect(shapes.length).toBe(2);
    const long = shapes.find(s => pathLength(s.pts, false) > 9)!;
    expect(long.pts[0].x === 0 || long.pts[0].x === 10).toBe(true); // the two horizontals became one line
    expect(pathLength(long.pts, false)).toBeCloseTo(10);
    expect(stats.ambiguousJunctions).toBe(0);
  });
  it('a smooth outline with a line ending on it still closes (the real-world case)', () => {
    // circle in two halves, plus a chord ending exactly where the halves meet
    const half = (a0: number): [number, number][] => Array.from({ length: 31 }, (_, i) => { const a = a0 + (i / 30) * Math.PI; return [10 * Math.cos(a), 10 * Math.sin(a)]; });
    const stem = line('L', [10, 0], [0, 0]);
    const { shapes } = joinShapes([line('L', ...half(0)), line('L', ...half(Math.PI)), stem], 0.05);
    const closed = shapes.filter(s => s.closed);
    expect(closed.length).toBe(1);
    expect(area(closed[0])).toBeGreaterThan(300);
    expect(shapes.filter(s => !s.closed).length).toBe(1); // the stem
  });
  it('leaves a star of lines (no clear straight-through pair) unjoined and counts it', () => {
    const star = [0, 120, 240].map(a => { const r = (a * Math.PI) / 180; return line('L', [0, 0], [10 * Math.cos(r), 10 * Math.sin(r)]); });
    const { shapes, stats } = joinShapes(star, 0.05);
    expect(shapes.length).toBe(3);
    expect(stats.ambiguousJunctions).toBe(1);
  });
  it('closes a single piece whose ends meet', () => {
    const { shapes } = cleanShapes([line('L', [0, 0], [10, 0], [10, 5], [0, 5], [0.02, 0.01])], { joinTol: 0.05, dedupe: true });
    expect(shapes.length).toBe(1);
    expect(shapes[0].closed).toBe(true);
  });
  it('leaves real open lines (centre lines) open and separate', () => {
    const { shapes } = joinShapes([line('L', [0, 0], [100, 0]), line('L', [0, 20], [100, 20])], 0.05);
    expect(shapes.length).toBe(2);
    expect(shapes.every(s => !s.closed)).toBe(true);
  });
  it('passes closed shapes through untouched', () => {
    const closed: RawShape = { layer: 'L', pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], closed: true };
    expect(joinShapes([closed], 0.05).shapes).toEqual([closed]);
  });
  it('handles a big outline made of many small arcs-as-polylines in random order', () => {
    // 40 pieces of a circle, shuffled and half reversed
    const pieces: RawShape[] = [];
    const N = 40, per = 6;
    for (let k = 0; k < N; k++) {
      const pts: [number, number][] = [];
      for (let j = 0; j <= per; j++) { const a = ((k * per + j) / (N * per)) * 2 * Math.PI; pts.push([50 * Math.cos(a), 50 * Math.sin(a)]); }
      pieces.push(line('L', ...(k % 2 ? pts.reverse() : pts)));
    }
    pieces.sort((a, b) => Math.sin(a.pts[0].x * 7.3 + a.pts[0].y) - Math.sin(b.pts[0].x * 7.3 + b.pts[0].y));
    const { shapes, stats } = joinShapes(pieces, 0.05);
    expect(shapes.length).toBe(1);
    expect(shapes[0].closed).toBe(true);
    expect(stats.piecesMerged).toBe(N);
    expect(area(shapes[0])).toBeGreaterThan(0.99 * Math.PI * 2500 * 0.99);
  });
});

describe('duplicates and specks', () => {
  const circle = (start: number, rev: boolean): RawShape => {
    const pts = Array.from({ length: 36 }, (_, i) => { const a = start + (i / 36) * 2 * Math.PI; return { x: 10 * Math.cos(a), y: 10 * Math.sin(a) }; });
    return { layer: 'L', pts: rev ? pts.reverse() : pts, closed: true };
  };
  it('removes the same outline drawn twice (different start, opposite direction)', () => {
    const stats = { piecesMerged: 0, closedCreated: 0, ambiguousJunctions: 0, duplicatesRemoved: 0, tinyRemoved: 0, largestClosedGap: 0 };
    const r = dedupeShapes([circle(0, false), circle(1.1, true)], stats);
    expect(r.length).toBe(1);
    expect(stats.duplicatesRemoved).toBe(1);
  });
  it('keeps different shapes', () => {
    const big = circle(0, false);
    const small: RawShape = { ...circle(0, false), pts: circle(0, false).pts.map(p => ({ x: p.x / 2, y: p.y / 2 })) };
    expect(dedupeShapes([big, small]).length).toBe(2);
  });
  it('keeps the same outline on a different layer', () => {
    const a = circle(0, false), b = { ...circle(0, false), layer: 'M' };
    expect(dedupeShapes([a, b]).length).toBe(2);
  });
  it('drops specks shorter than the limit', () => {
    expect(dropTiny([line('L', [0, 0], [0.001, 0]), line('L', [0, 0], [5, 0])], 0.01).length).toBe(1);
  });
});

describe('closing nearly-closed outlines', () => {
  // a 100 x 100 square drawn as one line that stops 0.87 mm short of its start
  const sq = line('L', [0, 0], [100, 0], [100, 100], [0, 100], [0, 0.87]);
  it('closes a big loop with a small gap when the close tolerance allows', () => {
    const { shapes, stats } = cleanShapes([sq], { joinTol: 0.05, closeTol: 2, dedupe: true });
    expect(shapes[0].closed).toBe(true);
    expect(stats.largestClosedGap).toBeCloseTo(0.87);
    expect(shapes[0].pts.length).toBe(5); // the closing segment spans the gap
  });
  it('leaves it open when the close tolerance is smaller than the gap', () => {
    expect(cleanShapes([sq], { joinTol: 0.05, closeTol: 0.5, dedupe: true }).shapes[0].closed).toBe(false);
  });
  it('never closes a short line just because its ends are close (gap must be tiny compared with the length)', () => {
    const hook = line('L', [0, 0], [3, 0], [3, 1], [0.5, 1.5]); // ~7 mm long, ends ~1.6 mm apart
    expect(cleanShapes([hook], { joinTol: 0.05, closeTol: 2, dedupe: true }).shapes[0].closed).toBe(false);
  });
  it('does nothing when close tolerance is 0', () => {
    expect(cleanShapes([sq], { joinTol: 0.05, closeTol: 0, dedupe: true }).shapes[0].closed).toBe(false);
  });
});
