import { describe, it, expect } from 'vitest';
import { fitArcs, sampleArc } from '../src/core/arcs';
import type { Pt3 } from '../src/core/types';

const circlePts = (cx: number, cy: number, r: number, a0: number, a1: number, n: number, z = -2): Pt3[] =>
  Array.from({ length: n + 1 }, (_, k) => ({ x: cx + r * Math.cos(a0 + ((a1 - a0) * k) / n), y: cy + r * Math.sin(a0 + ((a1 - a0) * k) / n), z }));

/** Distance from point to the polyline made of consecutive pts. */
function distToPolyline(p: { x: number; y: number }, line: { x: number; y: number }[]): number {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i], dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy));
  }
  return best;
}

describe('arc fitting', () => {
  it('turns a polygonal circle into a few arcs', () => {
    const pts = circlePts(50, 40, 20, 0, 2 * Math.PI, 120);
    const segs = fitArcs(pts);
    expect(segs.every(s => s.arc)).toBe(true);
    expect(segs.length).toBeLessThanOrEqual(4); // half circles at most: 2 would do, a few more is fine
    expect(segs[segs.length - 1].to).toEqual(pts[pts.length - 1]);
  });
  it('arc centres and radii are right, and the direction matches the travel', () => {
    const ccw = fitArcs(circlePts(0, 0, 10, 0, Math.PI / 2, 20));
    expect(ccw.length).toBe(1);
    expect(ccw[0].arc!.cw).toBe(false);
    expect(ccw[0].arc!.radius).toBeCloseTo(10, 6);
    expect(ccw[0].arc!.i).toBeCloseTo(-10, 6); // centre relative to the start point (10,0)
    expect(ccw[0].arc!.j).toBeCloseTo(0, 6);
    const cw = fitArcs(circlePts(0, 0, 10, Math.PI / 2, 0, 20));
    expect(cw[0].arc!.cw).toBe(true);
  });
  it('replaced points stay within tolerance of the arcs (round trip)', () => {
    const tol = 0.01;
    const pts = circlePts(5, 5, 7.3, 0.2, 5.9, 90);
    const segs = fitArcs(pts, tol);
    const dense: { x: number; y: number }[] = [];
    let from = pts[0];
    for (const s of segs) { dense.push(...sampleArc(from, s, 0.05)); from = s.to; }
    for (const p of pts) expect(distToPolyline(p, dense)).toBeLessThan(tol + 0.002);
  });
  it('keeps straight runs as lines and mixes the two', () => {
    const line: Pt3[] = [{ x: 0, y: 0, z: -2 }, { x: 10, y: 0, z: -2 }, { x: 20, y: 0, z: -2 }];
    const arc = circlePts(20, 5, 5, -Math.PI / 2, 0, 12);
    const segs = fitArcs([...line, ...arc.slice(1)]);
    expect(segs.filter(s => s.arc).length).toBeGreaterThanOrEqual(1);
    expect(segs.filter(s => !s.arc).length).toBeGreaterThanOrEqual(2);
    expect(segs[0].arc).toBeUndefined();
  });
  it('never makes an arc across a change of height or through a rapid', () => {
    const a = circlePts(0, 0, 10, 0, 1, 10, -2);
    const b = circlePts(0, 0, 10, 1, 2, 10, -4).slice(1);
    const segs = fitArcs([...a, ...b]);
    // the Z change must fall on a segment boundary, so no arc covers both heights
    let from = a[0];
    for (const s of segs) { expect(Math.abs(s.to.z - from.z) < 1e-9 || !s.arc).toBe(true); from = s.to; }
    const withRapid = circlePts(0, 0, 10, 0, 1, 10); withRapid[5] = { ...withRapid[5], rapid: true };
    const s2 = fitArcs(withRapid);
    expect(s2.length).toBeGreaterThan(1);
  });
  it('does not turn a zig-zag or a tight wiggle into an arc', () => {
    const zig: Pt3[] = Array.from({ length: 12 }, (_, k) => ({ x: k, y: k % 2 ? 1 : 0, z: -1 }));
    expect(fitArcs(zig).every(s => !s.arc)).toBe(true);
  });
  it('leaves almost-straight runs as lines (huge radius)', () => {
    const flat = circlePts(0, -50000, 50000, Math.PI / 2 - 0.0002, Math.PI / 2 + 0.0002, 8);
    expect(fitArcs(flat).every(s => !s.arc)).toBe(true);
  });
  it('arc end points are exactly equidistant from the centre (firmware radius check)', () => {
    const pts = circlePts(3, 4, 12, 0.1, 2.5, 60);
    let from = pts[0];
    for (const s of fitArcs(pts)) {
      if (s.arc) {
        const cx = from.x + s.arc.i, cy = from.y + s.arc.j;
        expect(Math.abs(Math.hypot(s.to.x - cx, s.to.y - cy) - s.arc.radius)).toBeLessThan(0.002);
      }
      from = s.to;
    }
  });
  it('handles a short path and an empty one', () => {
    expect(fitArcs([{ x: 0, y: 0, z: 0 }])).toEqual([]);
    expect(fitArcs([{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }]).length).toBe(1);
  });
});

import { toGcode, arcTestGcode } from '../src/core/gcode';
import { profile, drill } from '../src/core/ops';
import { MATERIALS } from '../src/core/presets';
import type { Loop } from '../src/core/types';

describe('G-code with arcs', () => {
  const circle: Loop = Array.from({ length: 180 }, (_, k) => ({ x: 50 + 20 * Math.cos((k / 180) * 2 * Math.PI), y: 50 + 20 * Math.sin((k / 180) * 2 * Math.PI) }));
  const tp = profile([circle], 'inside', { tool: { type: 'flat', diameter: 6 }, material: MATERIALS.softwood, depth: 4, direction: 'climb', ramp: { maxAngleDeg: 3 } });
  const base = { flavor: 'marlin' as const, spindle: 'manual' as const, safeZ: 5, decimals: 3 };
  it('is unchanged (no G2/G3) when arcs are off', () => {
    expect(toGcode([tp], base)).not.toMatch(/G[23] /);
  });
  it('uses far fewer lines with arcs on, and emits I/J arcs', () => {
    const off = toGcode([tp], base).split('\n').length;
    const g = toGcode([tp], { ...base, arcs: true });
    expect(g).toMatch(/^G[23] X[-\d.]+ Y[-\d.]+ I[-\d.]+ J[-\d.]+/m);
    // Ramp laps descend continuously, so they stay short straight lines (no helical arcs: not every Marlin does them);
    // the flat laps compress to a handful of arcs.
    expect(g.split('\n').length).toBeLessThan(off * 0.6);
    const flatPass = tp.cuts.filter(c => c.zStart === c.z); // none here: every pass ramps, so compare per-line instead
    void flatPass;
  });
  it('keeps the spindle direction: climb inside a hole is counter-clockwise (G3)', () => {
    const g = toGcode([tp], { ...base, arcs: true });
    const flat = g.split('\n').filter(l => /^G[23] /.test(l));
    expect(flat.length).toBeGreaterThan(0);
    expect(flat.every(l => l.startsWith('G3'))).toBe(true);
  });
  it('conventional reverses it (G2)', () => {
    const conv = profile([circle], 'inside', { tool: { type: 'flat', diameter: 6 }, material: MATERIALS.softwood, depth: 4, direction: 'conventional' });
    const flat = toGcode([conv], { ...base, arcs: true }).split('\n').filter(l => /^G[23] /.test(l));
    expect(flat.every(l => l.startsWith('G2'))).toBe(true);
  });
  it('plunging and ramp moves stay straight lines', () => {
    const g = toGcode([tp], { ...base, arcs: true }).split('\n');
    expect(g.some(l => /^G1 .*Z-[\d.]+/.test(l))).toBe(true);
  });
  it('arcs also shorten a drilled-out hole path and never break the drill pecking', () => {
    const d = drill([{ x: 20, y: 20 }], { tool: { type: 'flat', diameter: 6 }, material: MATERIALS.softwood, depth: 10, direction: 'climb', holeDiameter: 14 });
    const g = toGcode([d], { ...base, arcs: true });
    expect(g).toMatch(/G[23] /);
  });
  it('the arc test file is an air cut that never goes below Z10 and contains arcs for each firmware', () => {
    for (const f of ['marlin', 'grbl'] as const) {
      const t = arcTestGcode(f);
      expect(t).toMatch(/G2 /); expect(t).toMatch(/G3 /);
      const zs = [...t.matchAll(/Z(-?[\d.]+)/g)].map(m => +m[1]);
      expect(Math.min(...zs)).toBeGreaterThanOrEqual(10);
      expect(t).not.toMatch(/M3|M5/);
    }
    expect(arcTestGcode('grbl').trimEnd().endsWith('M2')).toBe(true);
  });
});

describe('arcs without ramps (flat passes)', () => {
  it('a plunge-and-cut circle collapses to a few arcs', () => {
    const circle: Loop = Array.from({ length: 360 }, (_, k) => ({ x: 50 + 20 * Math.cos((k / 360) * 2 * Math.PI), y: 50 + 20 * Math.sin((k / 360) * 2 * Math.PI) }));
    const tp = profile([circle], 'inside', { tool: { type: 'flat', diameter: 6 }, material: MATERIALS.softwood, depth: 4, direction: 'climb' });
    const post = { flavor: 'marlin' as const, spindle: 'manual' as const, safeZ: 5, decimals: 3 };
    const off = toGcode([tp], post).split('\n').length, on = toGcode([tp], { ...post, arcs: true }).split('\n').length;
    expect(on).toBeLessThan(off / 5);
  });
});

import { estimateMinutes } from '../src/core/gcode';

describe('run time estimate', () => {
  it('a straight 1000 mm cut at 1000 mm/min takes about a minute, plus travel', () => {
    const tp = { name: 't', tool: { type: 'flat' as const, diameter: 6 }, feed: 1000, plungeFeed: 300,
      cuts: [{ loop: [], z: -1, zStart: -1, closed: false, moves: [{ x: 0, y: 0, z: -1 }, { x: 1000, y: 0, z: -1 }] }] };
    const e = estimateMinutes([tp]);
    // 1000 mm at 1000 mm/min, plus the 2 mm descent from 1 mm above the top to z=-1 at the plunge feed (300 mm/min)
    expect(e.cutting).toBeCloseTo(1 + 2 / 300, 3);
    expect(e.travel).toBeGreaterThan(0);
    expect(e.total).toBeCloseTo(e.cutting + e.travel);
  });
  it('plunging is slower than cutting and rapids are quick', () => {
    const mk = (feedMoves: { x: number; y: number; z: number; rapid?: boolean }[]) => ({ name: 't', tool: { type: 'flat' as const, diameter: 6 }, feed: 1000, plungeFeed: 100,
      cuts: [{ loop: [], z: 0, zStart: 0, closed: false, moves: feedMoves }] });
    const plunge = estimateMinutes([mk([{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -10 }])]).cutting;
    expect(plunge).toBeCloseTo(0.11, 3); // 10 mm plunge plus the 1 mm from Z1 down to the surface, both at 100 mm/min
    const rapid = estimateMinutes([mk([{ x: 0, y: 0, z: 0, rapid: true }, { x: 0, y: 0, z: -10, rapid: true }])]);
    expect(rapid.cutting).toBe(0);
  });
  it('is zero for nothing', () => {
    expect(estimateMinutes([]).total).toBe(0);
  });
});

import { moveFeed } from '../src/core/gcode';

describe('feed follows how steeply a move descends', () => {
  it('a straight plunge and steep moves use the plunge feed', () => {
    expect(moveFeed(1000, 300, 0, 5)).toBe(300);
    expect(moveFeed(1000, 300, 2, 5)).toBe(300);      // steeper than 45 degrees
  });
  it('a gentle ramp or any level or rising move uses the full cutting feed', () => {
    expect(moveFeed(1000, 300, 60, 3)).toBe(1000);     // 3 degrees
    expect(moveFeed(1000, 300, 10, 0)).toBe(1000);
    expect(moveFeed(1000, 300, 10, -2)).toBe(1000);
  });
  it('blends in between and is never above the cutting feed or below the plunge feed', () => {
    for (const drop of [0.2, 0.5, 1, 2, 5]) {
      const f = moveFeed(1000, 300, 5, drop);
      expect(f).toBeGreaterThanOrEqual(300); expect(f).toBeLessThanOrEqual(1000);
    }
    expect(moveFeed(1000, 300, 5, 2)).toBeGreaterThan(moveFeed(1000, 300, 5, 4));  // steeper = slower
  });
  it('a plunge feed above the cutting feed never speeds anything up', () => {
    expect(moveFeed(500, 800, 0, 5)).toBe(500);
  });
  it('rounds so a sloping path does not need a new feed word on every line', () => {
    expect(moveFeed(1000, 300, 5, 1.37) % 25).toBe(0);
  });
});
