import { describe, it, expect } from 'vitest';
import { profile, pocket } from '../src/core/ops';
import { toGcode, estimateMinutes, planEntries } from '../src/core/gcode';
import { MATERIALS } from '../src/core/presets';
import type { Loop } from '../src/core/types';

const rect = (x: number, y: number, w: number, h: number): Loop => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const base = { tool: { type: 'flat' as const, diameter: 6 }, material: { ...MATERIALS.softwood, stepdown: 3 }, depth: 9, direction: 'climb' as const };

describe('dropping in on later depths', () => {
  const tp = profile([rect(0, 0, 50, 50)], 'outside', base);
  it('the first pass feeds in from the top, later passes rapid down through the air the earlier pass cut', () => {
    expect(tp.cuts.length).toBe(3);
    const plan = planEntries([tp]);
    expect(plan.has(tp.cuts[0])).toBe(false);
    expect(plan.get(tp.cuts[1])).toBeCloseTo(tp.cuts[1].moves[0].z + 1);
    expect(plan.get(tp.cuts[2])).toBeCloseTo(tp.cuts[2].moves[0].z + 1);
  });
  it('the G-code has a G0 down to 1 mm above the pass start, then a short G1', () => {
    const lines = toGcode([tp], { flavor: 'grbl', spindle: 'manual', safeZ: 5, decimals: 3 }).split('\n');
    const z1 = lines.reduce<number[]>((acc, l, k) => (l === 'G0 Z1' ? [...acc, k] : acc), []);
    expect(z1.length).toBe(3);
    expect(lines[z1[0] + 1]).toMatch(/^G1 Z0/);           // first pass: feed in from the top
    expect(lines[z1[1] + 1]).toMatch(/^G0 Z-/);          // second pass: rapid through the first pass's cut
    expect(lines[z1[1] + 2]).toMatch(/^G1 Z-/);
  });
  it('is not used when a different bit made the earlier cut', () => {
    const other = profile([rect(0, 0, 50, 50)], 'outside', { ...base, tool: { type: 'flat', diameter: 3 }, depth: 3 });
    const plan = planEntries([other, tp]);
    expect(plan.has(tp.cuts[0])).toBe(false);
  });
  it('the time estimate is shorter with the rapid drops', () => {
    const withPlan = estimateMinutes([tp]).total;
    const lone = (c: typeof tp.cuts[number]) => estimateMinutes([{ ...tp, cuts: [c] }]).total; // each pass alone: no earlier pass, so no rapid drop
    expect(withPlan).toBeLessThan(tp.cuts.reduce((s, c) => s + lone(c), 0));
  });
});

describe('fast moves on Marlin', () => {
  const tp = pocket([rect(0, 0, 40, 40)], { ...base, depth: 3, stepoverFraction: 0.4 });
  it('state a feed on every G0 (Marlin would otherwise reuse the plunge or cutting feed)', () => {
    const g0 = toGcode([tp]).split('\n').filter(l => l.startsWith('G0 '));
    expect(g0.length).toBeGreaterThan(3);
    expect(g0.every(l => / F\d+$/.test(l))).toBe(true);
  });
  it('and the next G1 restates its own feed afterwards', () => {
    const lines = toGcode([tp]).split('\n');
    const first = lines.findIndex(l => l.startsWith('G1 '));
    expect(lines[first]).toMatch(/ F\d+$/);
    // find any G1 right after a G0: it must carry an F word
    lines.forEach((l, k) => { if (l.startsWith('G1 ') && lines[k - 1]?.startsWith('G0 ')) expect(l).toMatch(/ F\d+$/); });
  });
  it('GRBL gets plain G0 lines', () => {
    const g0 = toGcode([tp], { flavor: 'grbl', spindle: 'manual', safeZ: 5, decimals: 3 }).split('\n').filter(l => l.startsWith('G0 '));
    expect(g0.every(l => !/ F\d+/.test(l))).toBe(true);
  });
});

import { drill, depthLevels } from '../src/core/ops';
import { MPCNC_MAKITA } from '../src/core/gcode';

describe('start depth', () => {
  const mat = { feed: 800, plungeFeed: 300, stepdown: 2 };
  const flat6 = { type: 'flat' as const, diameter: 6 };
  const sq = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }];
  it('levels begin at the start depth and still end exactly at the depth', () => {
    expect(depthLevels(10, 2, 4)).toEqual([-6, -8, -10]);
    expect(depthLevels(10, 4, 4)).toEqual([-7, -10]);
    expect(depthLevels(10, 2, 10)).toEqual([]);
    expect(depthLevels(10, 2)).toEqual([-2, -4, -6, -8, -10]);
  });
  it('nothing is cut above the start depth, for every operation', () => {
    const p = { tool: flat6, material: mat, depth: 12, start: 5, direction: 'climb' as const };
    for (const tp of [profile([sq], 'outside', p), pocket([sq], { ...p, stepoverFraction: 0.5 }), drill([{ x: 10, y: 10 }], { ...p, holeDiameter: 6 }), drill([{ x: 10, y: 10 }], { ...p, holeDiameter: 12 })]) {
      expect(tp.cuts.length).toBeGreaterThan(0);
      for (const c of tp.cuts) for (const m of c.moves) expect(m.z).toBeLessThanOrEqual(-5 + 1e-9);
      expect(Math.min(...tp.cuts.map(c => c.z))).toBeCloseTo(-12);
    }
  });
  it('the first pass rapids down through the air to 1 mm above the start depth, then feeds', () => {
    const tp = drill([{ x: 10, y: 10 }], { tool: flat6, material: mat, depth: 12, start: 8, direction: 'climb', holeDiameter: 6 });
    const g = toGcode([tp], MPCNC_MAKITA).split('\n');
    const i = g.findIndex(l => /^G0 Z-7(\.0+)?\b/.test(l));
    expect(i).toBeGreaterThan(0);
    const next = g.slice(i + 1).find(l => /^G1/.test(l))!;
    expect(next).toMatch(/Z-8|Z-10/);
  });
  it('without a start depth nothing changes', () => {
    const a = drill([{ x: 10, y: 10 }], { tool: flat6, material: mat, depth: 6, direction: 'climb', holeDiameter: 6 });
    expect(a.cuts[0].airTo).toBeUndefined();
  });
});
