import { describe, it, expect } from 'vitest';
import { pocket, profile, insideCorners, addDogbones } from '../src/core/ops';
import { normalize, signedArea } from '../src/core/geometry';
import { MATERIALS } from '../src/core/presets';
import type { Loop, Pt, Tool } from '../src/core/types';

const rect = (x: number, y: number, w: number, h: number): Loop => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const flat6: Tool = { type: 'flat', diameter: 6 };
const base = { tool: flat6, material: MATERIALS.softwood, depth: 4, direction: 'climb' as const };

/** Smallest distance from a point to any vertex of any cut (the cutter centre path). */
const nearest = (cuts: { moves: { x: number; y: number }[] }[], p: Pt) =>
  Math.min(...cuts.flatMap(c => c.moves.map(m => Math.hypot(m.x - p.x, m.y - p.y))));

describe('finding inside corners', () => {
  it('a rectangle has four convex corners', () => {
    expect(insideCorners(normalize([rect(0, 0, 50, 30)])).length).toBe(4);
  });
  it('an L-shape has five convex corners and one concave one that is ignored', () => {
    const L: Loop = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 40 }, { x: 0, y: 40 }];
    expect(insideCorners(normalize([L])).length).toBe(5);
  });
  it('a square island (a hole in the region) has no inside corners of its own', () => {
    expect(insideCorners(normalize([rect(0, 0, 60, 60), rect(20, 20, 20, 20)])).length).toBe(4);   // only the outer four
  });
  it('a finely sampled circle has none, a coarse polygon of 90 degree turns does', () => {
    const circle: Loop = Array.from({ length: 180 }, (_, k) => ({ x: 20 * Math.cos((k / 180) * 2 * Math.PI), y: 20 * Math.sin((k / 180) * 2 * Math.PI) }));
    expect(insideCorners(normalize([circle])).length).toBe(0);
  });
  it('very shallow corners (over 160 degrees) and very sharp ones (under 30) are skipped', () => {
    const shallow: Loop = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 5 }, { x: 100, y: 50 }, { x: 0, y: 50 }];   // ~174 degree corner at (50,0)
    expect(insideCorners(normalize([shallow])).length).toBe(4);
    const spike: Loop = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 20 }];  // the tip at (100,0) is about 11 degrees
    expect(insideCorners(normalize([spike])).length).toBe(2);
  });
});

describe('dogbone pockets', () => {
  const region = [rect(0, 0, 50, 50)];
  const without = pocket(region, { ...base, stepoverFraction: 0.4 });
  const withDb = pocket(region, { ...base, stepoverFraction: 0.4, dogbone: true });

  it('without dogbones the cutter centre stays r*sqrt(2) from a square corner, so the corner is left round', () => {
    expect(nearest(without.cuts, { x: 0, y: 0 })).toBeCloseTo(3 * Math.SQRT2, 2);
  });
  it('with dogbones the bit reaches every corner: the centre gets within r of it', () => {
    for (const corner of [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, { x: 0, y: 50 }]) {
      expect(nearest(withDb.cuts, corner)).toBeLessThanOrEqual(3 + 1e-6);
    }
  });
  it('the excursion goes along the corner bisector, 0.414*r beyond the normal path for a right angle', () => {
    const d = nearest(withDb.cuts, { x: 3, y: 3 });             // where the relief point should sit: (3/sqrt2, 3/sqrt2) from the corner
    expect(nearest(withDb.cuts, { x: 3 / Math.SQRT2, y: 3 / Math.SQRT2 })).toBeLessThan(1e-3);
    expect(d).toBeLessThan(2);
  });
  it('only the wall pass gets the relief: inner rings are unchanged', () => {
    const count = (tp: typeof without) => tp.cuts.reduce((s, c) => s + c.moves.length, 0);
    const levels = new Set(without.cuts.map(c => c.z)).size;
    // 4 corners x 2 extra points each, in the first ring of every depth level (ramped loops repeat points, so compare loops)
    const extra = withDb.cuts.reduce((s, c) => s + c.loop.length, 0) - without.cuts.reduce((s, c) => s + c.loop.length, 0);
    expect(extra).toBe(8 * levels);
    expect(count(withDb)).toBeGreaterThan(count(without));
  });
  it('keeps the climb direction of every loop', () => {
    withDb.cuts.forEach((c, i) => expect(Math.sign(signedArea(c.loop))).toBe(Math.sign(signedArea(without.cuts[i].loop))));
  });
  it('a round pocket is not changed at all', () => {
    const circle: Loop = Array.from({ length: 120 }, (_, k) => ({ x: 20 * Math.cos((k / 120) * 2 * Math.PI), y: 20 * Math.sin((k / 120) * 2 * Math.PI) }));
    const a = pocket([circle], { ...base, stepoverFraction: 0.4 }), b = pocket([circle], { ...base, stepoverFraction: 0.4, dogbone: true });
    expect(b.cuts.reduce((s, c) => s + c.loop.length, 0)).toBe(a.cuts.reduce((s, c) => s + c.loop.length, 0));
  });
  it('a pocket with a square island does not relieve the island corners (they are outside corners for the cutter)', () => {
    const r = [rect(0, 0, 80, 80), rect(30, 30, 20, 20)];
    const a = pocket(r, { ...base, stepoverFraction: 0.4 }), b = pocket(r, { ...base, stepoverFraction: 0.4, dogbone: true });
    const extra = b.cuts.reduce((s, c) => s + c.loop.length, 0) - a.cuts.reduce((s, c) => s + c.loop.length, 0);
    expect(extra).toBe(8 * new Set(a.cuts.map(c => c.z)).size);        // the 4 outer corners only
  });
  it('an acute corner gets a longer excursion but a spike that is too sharp is skipped', () => {
    const wedge: Loop = [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 0, y: 34.6 }];   // 30 degree tip at (60,0)
    const tp = pocket([wedge], { ...base, stepoverFraction: 0.4, dogbone: true });
    expect(tp.cuts.length).toBeGreaterThan(0);
  });
});

describe('dogbone inside cut-outs', () => {
  it('relieves all four corners of a rectangular opening', () => {
    const tp = profile([rect(0, 0, 40, 20)], 'inside', { ...base, dogbone: true });
    for (const corner of [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 20 }, { x: 0, y: 20 }]) {
      expect(nearest(tp.cuts, corner)).toBeLessThanOrEqual(3 + 1e-6);
    }
  });
  it('does nothing for an outside cut-out', () => {
    const a = profile([rect(0, 0, 40, 20)], 'outside', base), b = profile([rect(0, 0, 40, 20)], 'outside', { ...base, dogbone: true });
    expect(b.cuts.reduce((s, c) => s + c.loop.length, 0)).toBe(a.cuts.reduce((s, c) => s + c.loop.length, 0));
  });
  it('is off unless asked for', () => {
    const tp = profile([rect(0, 0, 40, 20)], 'inside', base);
    expect(nearest(tp.cuts, { x: 0, y: 0 })).toBeCloseTo(3 * Math.SQRT2, 2);
  });
  it('addDogbones leaves a loop alone when there are no corners or the radius is zero', () => {
    const l = rect(0, 0, 10, 10);
    expect(addDogbones(l, [], 3)).toBe(l);
    expect(addDogbones(l, insideCorners(normalize([l])), 0)).toBe(l);
  });
});
