import { describe, it, expect } from 'vitest';
import { detectMirror, settingsFromMatch, alignBack, dowelPositions, flipPoint, suggestStock, bboxOf, bboxCentre } from '../src/core/twosided';
import { drill } from '../src/core/ops';
import { toGcode } from '../src/core/gcode';
import { MATERIALS } from '../src/core/presets';
import type { Loop } from '../src/core/types';

// An asymmetric L-ish shape so every flip looks different.
const L: Loop = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 30 }, { x: 0, y: 30 }];
const flipY = (l: Loop, cy = 15): Loop => l.map(p => ({ x: p.x, y: 2 * cy - p.y }));
const flipX = (l: Loop, cx = 20): Loop => l.map(p => ({ x: 2 * cx - p.x, y: p.y }));
const shift = (l: Loop, dx: number, dy: number): Loop => l.map(p => ({ x: p.x + dx, y: p.y + dy }));

describe('mirror detection', () => {
  it('finds a top-to-bottom mirror wherever the back is placed', () => {
    const back = shift(flipY(L), 3, 100);
    const r = detectMirror(L, back);
    expect(r.match).toBe('flipY');
    expect(settingsFromMatch(r.match)).toEqual({ flip: 'tb', preMirrored: true });
  });
  it('finds a left-to-right mirror', () => {
    expect(detectMirror(L, shift(flipX(L), 50, 0)).match).toBe('flipX');
  });
  it('same orientation means the back is not pre-mirrored', () => {
    const r = detectMirror(L, shift(L, 5, 70));
    expect(r.match).toBe('same');
    expect(settingsFromMatch(r.match).preMirrored).toBe(false);
  });
});

describe('aligning the back to the front', () => {
  it('pre-mirrored back outline lands exactly on the front outline', () => {
    const back = shift(flipY(L), 7, 80);
    const a = alignBack(back, L, back, 'tb', true);
    const bf = bboxOf(L), ba = bboxOf(a);
    expect(ba.minX).toBeCloseTo(bf.minX); expect(ba.maxY).toBeCloseTo(bf.maxY);
    // and every vertex matches the front's mirrored shape
    const expected = flipY(L);
    a.forEach((p, i) => { expect(p.x).toBeCloseTo(expected[i].x); expect(p.y).toBeCloseTo(expected[i].y); });
  });
  it('unmirrored back is mirrored by the app about the flip axis', () => {
    const back = shift(L, 7, 80);
    const a = alignBack(back, L, back, 'tb', false);
    const expected = flipY(L);
    a.forEach((p, i) => { expect(p.x).toBeCloseTo(expected[i].x); expect(p.y).toBeCloseTo(expected[i].y); });
  });
  it('a cavity on the back sits where it would be seen through the part', () => {
    // front outline L, back outline = flipY(L) placed elsewhere; a cavity at front (5,5) appears on the back at (5, 25).
    const backOutline = shift(flipY(L), 0, 200);
    const cavityBack = [{ x: 5, y: 200 + 25 }, { x: 6, y: 200 + 25 }, { x: 6, y: 200 + 26 }];
    const a = alignBack(cavityBack, L, backOutline, 'tb', true);
    expect(a[0].x).toBeCloseTo(5); expect(a[0].y).toBeCloseTo(25);
  });
});

describe('dowels', () => {
  const part = { minX: 0, minY: 0, maxX: 100, maxY: 60 };
  const axis = { x: 50, y: 30 };
  it('each dowel lands on another dowel after the flip (both flip directions, 2 and 4)', () => {
    for (const flip of ['tb', 'lr'] as const) for (const count of [2, 4] as const) {
      const d = dowelPositions(part, axis, flip, { count, distance: 15, pairSpacing: 30 });
      expect(d.length).toBe(count === 2 ? 2 : 4);
      for (const p of d) {
        const q = flipPoint(p, axis, flip);
        expect(d.some(r => Math.hypot(r.x - q.x, r.y - q.y) < 1e-9)).toBe(true);
      }
    }
  });
  it('dowels sit outside the part', () => {
    const d = dowelPositions(part, axis, 'tb', { count: 2, distance: 15, pairSpacing: 30 });
    expect(d.every(p => p.x < part.minX || p.x > part.maxX)).toBe(true);
  });
  it('suggested stock holds part and dowels', () => {
    const s = suggestStock(part, axis, 'tb', { count: 2, distance: 15, pairSpacing: 30 }, 6);
    expect(s.width).toBeGreaterThanOrEqual(100 + 2 * (15 + 3));
    expect(s.height).toBeGreaterThanOrEqual(60);
  });
  void bboxCentre;
});

describe('drilling', () => {
  const tool = { type: 'flat' as const, diameter: 6 };
  const p = { tool, material: MATERIALS.softwood, depth: 20, direction: 'climb' as const };
  it('bit equal to hole size pecks straight down to full depth', () => {
    const tp = drill([{ x: 10, y: 10 }], { ...p, holeDiameter: 6 });
    expect(tp.cuts.length).toBe(1);
    expect(Math.min(...tp.cuts[0].moves.map(m => m.z))).toBeCloseTo(-20);
    expect(tp.cuts[0].moves.every(m => m.x === 10 && m.y === 10)).toBe(true);
  });
  it('larger hole is spiralled out and stays inside the hole', () => {
    const tp = drill([{ x: 0, y: 0 }], { ...p, holeDiameter: 10 });
    expect(tp.cuts.length).toBeGreaterThan(0);
    for (const c of tp.cuts) for (const m of c.moves) expect(Math.hypot(m.x, m.y)).toBeLessThanOrEqual(2 + 1e-6);
  });
  it('hole smaller than the bit makes no toolpath', () => {
    expect(drill([{ x: 0, y: 0 }], { ...p, holeDiameter: 3 }).cuts).toEqual([]);
  });
  it('pecks retract with a rapid', () => {
    const g = toGcode([drill([{ x: 10, y: 10 }], { ...p, holeDiameter: 6 })]);
    expect(g).toMatch(/G0 Z-/);
  });
});

import { wrongFits } from '../src/core/twosided';

describe('keyed dowels', () => {
  const part = { minX: 0, minY: 0, maxX: 100, maxY: 60 };
  const axis = { x: 50, y: 30 };
  for (const flip of ['tb', 'lr'] as const) {
    it(`3 dowels (${flip}) fit only one way, even if the stock is slid around`, () => {
      const d = dowelPositions(part, axis, flip, { count: 3, distance: 15, pairSpacing: 30 });
      expect(d.length).toBe(3);
      expect(wrongFits(d, axis, flip, 2)).toEqual([]);
      // still lands on itself after the CORRECT flip
      for (const p of d) {
        const q = flipPoint(p, axis, flip);
        expect(d.some(r => Math.hypot(r.x - q.x, r.y - q.y) < 1e-9)).toBe(true);
      }
    });
    it(`2 and 4 dowels (${flip}) are ambiguous`, () => {
      for (const count of [2, 4] as const) {
        const d = dowelPositions(part, axis, flip, { count, distance: 15, pairSpacing: 30 });
        expect(wrongFits(d, axis, flip, 2).length).toBeGreaterThan(0);
      }
    });
  }
});

import { toolWarnings } from '../src/core/tool';

describe('safer deep drilling', () => {
  const tool = { type: 'flat' as const, diameter: 6, fluteLength: 25 };
  const p = { tool, material: MATERIALS.softwood, depth: 48, direction: 'climb' as const };
  it('warns when the hole is deeper than the flutes', () => {
    expect(toolWarnings(tool, 48, 'pocket').some(m => /only cuts 25/.test(m))).toBe(true);
    expect(toolWarnings(tool, 20, 'pocket')).toEqual([]);
  });
  it('comes fully out of the hole periodically to clear chips', () => {
    const m = drill([{ x: 0, y: 0 }], { ...p, holeDiameter: 6 }).cuts[0].moves;
    const fullRetracts = m.filter(v => v.rapid && v.z === 1).length;
    expect(fullRetracts).toBeGreaterThanOrEqual(5);
  });
  it('rapids back down only into already-cut hole, never into fresh material', () => {
    const m = drill([{ x: 0, y: 0 }], { ...p, holeDiameter: 6 }).cuts[0].moves;
    let deepest = 0;
    for (const v of m) {
      if (v.rapid && v.z < 0) expect(v.z).toBeGreaterThanOrEqual(deepest - 1e-9); // never below what's been cut
      else if (!v.rapid) deepest = Math.min(deepest, v.z);
    }
    expect(deepest).toBeCloseTo(-48);
  });
  it('emits G0 for rapids and G1 only for cutting moves', () => {
    const g = toGcode([drill([{ x: 0, y: 0 }], { ...p, holeDiameter: 6 })]);
    const lines = g.split('\n');
    expect(lines.filter(l => l.startsWith('G0 Z1')).length).toBeGreaterThanOrEqual(5);
    // after a full retract the next descent is a rapid to a depth above the previous bottom, never G1 from the surface
    const firstCut = lines.findIndex(l => /^G1 Z-/.test(l));
    const i = lines.findIndex((l, k) => k > firstCut && /^G0 Z1( F\d+)?$/.test(l));
    expect(i).toBeGreaterThan(firstCut);
    expect(lines[i + 1]).toMatch(/^G0 Z-/);
    expect(lines[i + 2]).toMatch(/^G1 Z-/);
  });
});

import { translateToolpath } from '../src/core/transform';

describe('placing toolpaths in the stock', () => {
  it('keeps rapid flags so retracts and re-entry stay G0 after translation', () => {
    const tool = { type: 'flat' as const, diameter: 6 };
    const tp = drill([{ x: 0, y: 0 }], { tool, material: MATERIALS.softwood, depth: 30, direction: 'climb', holeDiameter: 6 });
    const moved = translateToolpath(tp, 100, 50);
    expect(moved.cuts[0].moves.filter(m => m.rapid).length).toBe(tp.cuts[0].moves.filter(m => m.rapid).length);
    const lines = toGcode([moved]).split('\n');
    const firstCut = lines.findIndex(l => /^G1 Z-/.test(l));
    const i = lines.findIndex((l, k) => k > firstCut && /^G0 Z1( F\d+)?$/.test(l));
    expect(lines[i + 1]).toMatch(/^G0 Z-/);
  });
});

import { dowelHole } from '../src/core/twosided';

describe('dowel hole depth is calculated', () => {
  const base = { mode: 'spoil' as const, stockT: 20, dowelLen: 30, dowelDia: 6, spoilT: 18, maxDepth: 40 };
  it('through stock + half the dowel into spoilboard + clearance', () => {
    const h = dowelHole(base);
    expect(h.intoSpoil).toBeCloseTo(15);
    expect(h.intoStock).toBeCloseTo(15);
    expect(h.depth).toBeCloseTo(20 + 15 + 1);
    expect(h.capped).toBe(false);
    expect(h.warnings).toEqual([]);
  });
  it('dowel top always stays below the stock surface', () => {
    for (const T of [12, 20, 30, 40]) for (const L of [20, 30, 40, 50]) {
      const h = dowelHole({ ...base, stockT: T, dowelLen: L, spoilT: 30, maxDepth: 0 });
      if (h.warnings.length === 0) expect(h.topGap).toBeGreaterThanOrEqual(3 - 1e-9);
    }
  });
  it('thin stock sinks the dowel deeper into the spoilboard', () => {
    const h = dowelHole({ ...base, stockT: 12, dowelLen: 30, spoilT: 30, maxDepth: 0 });
    expect(h.intoStock).toBeCloseTo(9);
    expect(h.intoSpoil).toBeCloseTo(21);
  });
  it('warns when the dowel is too long for stock plus spoilboard', () => {
    const h = dowelHole({ ...base, stockT: 12, dowelLen: 30, spoilT: 18, maxDepth: 0 });
    expect(h.warnings.some(w => /too long/.test(w))).toBe(true);
  });
  it('warns when the dowel is too short to stand up into the stock', () => {
    const h = dowelHole({ ...base, dowelLen: 16 }); // 9 mm in the spoilboard leaves only 7 mm standing
    expect(h.warnings.some(w => /at least/.test(w))).toBe(true);
    expect(dowelHole({ ...base, dowelLen: 20 }).warnings).toEqual([]); // 10 mm is enough
  });
  it('caps the depth at the bit limit and says the dowels will not hold', () => {
    const h = dowelHole({ ...base, stockT: 40, dowelLen: 40, maxDepth: 25 });
    expect(h.wanted).toBeCloseTo(56);
    expect(h.depth).toBe(25);
    expect(h.capped).toBe(true);
    expect(h.warnings.some(w => /not even go through/.test(w))).toBe(true);
  });
  it('blind holes take half the dowel plus clearance', () => {
    const h = dowelHole({ ...base, mode: 'blind', dowelLen: 30 });
    expect(h.depth).toBeCloseTo(16);
    expect(h.warnings).toEqual([]);
  });
  it('blind holes warn when nearly through the stock', () => {
    const h = dowelHole({ ...base, mode: 'blind', stockT: 15, dowelLen: 30 });
    expect(h.warnings.some(w => /nearly go right through/.test(w))).toBe(true);
  });
});

describe('spoilboard-first mode', () => {
  const base = { mode: 'spoilfirst' as const, stockT: 40, dowelLen: 30, dowelDia: 6, spoilT: 18, maxDepth: 25 };
  it('splits the job into two shallow drillings that fit a normal bit', () => {
    const h = dowelHole(base);
    expect(h.intoSpoil).toBeCloseTo(15);
    expect(h.spoilDepth).toBeCloseTo(16);   // into the empty spoilboard
    expect(h.depth).toBeCloseTo(16);        // blind hole in the stock
    expect(h.capped).toBe(false);
    expect(h.warnings).toEqual([]);
  });
  it('works for stock far thicker than the bit can cut through', () => {
    // The one-pass mode would need 56 mm here and fail; this mode never goes past ~16 mm.
    expect(dowelHole({ ...base, mode: 'spoil' }).capped).toBe(true);
    for (const T of [40, 60, 80]) expect(dowelHole({ ...base, stockT: T }).capped).toBe(false);
  });
  it('stock hole depth does not depend on stock thickness (blind, shallow)', () => {
    expect(dowelHole({ ...base, stockT: 40 }).depth).toBeCloseTo(dowelHole({ ...base, stockT: 80 }).depth);
  });
  it('warns when a long dowel makes a hole deeper than the bit', () => {
    const h = dowelHole({ ...base, dowelLen: 60, maxDepth: 20 });
    expect(h.capped).toBe(true);
    expect(h.warnings.some(w => /only cut 20/.test(w))).toBe(true);
  });
  it('still sinks the dowel into the spoilboard when the stock is thin', () => {
    const h = dowelHole({ ...base, stockT: 12, spoilT: 30, maxDepth: 0 });
    expect(h.intoStock).toBeCloseTo(9);
    expect(h.spoilDepth).toBeCloseTo(h.intoSpoil + 1);
  });
});
