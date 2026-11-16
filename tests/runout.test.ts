import { describe, it, expect } from 'vitest';
import { runOutToEdge, expandFreeEdge } from '../src/core/runout';
import { regionArea } from '../src/core/geometry';

const square = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 60 }, { x: 0, y: 60 }];
// a "C" shape open to the right: both ends head +x
const C = [{ x: 70, y: 20 }, { x: 30, y: 20 }, { x: 20, y: 25 }, { x: 20, y: 35 }, { x: 30, y: 40 }, { x: 70, y: 40 }];
const bulge = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 20 }, { x: 115, y: 30 }, { x: 100, y: 40 }, { x: 100, y: 60 }, { x: 0, y: 60 }];

describe('running an open line out through an outline', () => {
  it('closes the shape exactly on the outline (no overshoot in the shape itself)', () => {
    const r = runOutToEdge(C, square)!;
    expect(Math.max(...r.pts.map(p => p.x))).toBeCloseTo(100);
    expect(r.free[0]).toBe(C.length);
    expect(Math.abs(regionArea([r.pts]))).toBeGreaterThan(1500);
  });
  it('follows a bulge in the outline instead of cutting across it', () => {
    for (const edge of [bulge, [...bulge].reverse()]) {
      const r = runOutToEdge(C, edge)!;
      expect(Math.max(...r.pts.map(p => p.x))).toBeCloseTo(115);
    }
  });
  it('returns null if an end never reaches the outline', () => {
    expect(runOutToEdge([{ x: 30, y: 20 }, { x: 40, y: 20 }, { x: 50, y: 20 }], [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }])).toBeNull();
  });
  it('an end already on the outline still works', () => {
    const onEdge = [{ x: 100, y: 20 }, { x: 30, y: 20 }, { x: 20, y: 30 }, { x: 30, y: 40 }, { x: 100, y: 40 }];
    expect(runOutToEdge(onEdge, square)).not.toBeNull();
  });
});

describe('opening the free side for pocketing', () => {
  it('pushes only the free side outwards by the distance given', () => {
    for (const edge of [bulge, [...bulge].reverse()]) {
      const r = runOutToEdge(C, edge)!;
      const out = expandFreeEdge(r.pts, r.free, 3.5);
      const xs = out.flat().map(p => p.x);
      expect(Math.max(...xs)).toBeGreaterThan(117.9); // bulge tip at 115 + 3.5 (corners may add a little)
      expect(Math.min(...xs)).toBeCloseTo(20); // the closed end is unchanged
      expect(Math.min(...out.flat().filter(p => p.x < 99).map(p => p.y))).toBeGreaterThan(19.9); // the walls inside the part stay put
    }
  });
  it('does nothing without a free side', () => {
    expect(expandFreeEdge(C, [0, 0], 3)).toEqual([C]);
  });
});