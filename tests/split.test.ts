import { describe, it, expect } from 'vitest';
import { planSplit, clipMoves, clipToolpath, registrationPins, junctionCentreX } from '../src/core/split';
import { wrongFits } from '../src/core/twosided';
import { profile } from '../src/core/ops';
import { MATERIALS } from '../src/core/presets';
import type { Pt3 } from '../src/core/types';

describe('split plan', () => {
  const base = { margin: 5, overlap: 40 };
  it('does not split a part that fits', () => {
    const p = planSplit({ ...base, minX: 0, maxX: 500, bedX: 600 });
    expect(p.n).toBe(1);
    expect(p.windows).toEqual([{ x0: 0, x1: 500 }]);
  });
  it('splits a long part into overlapping equal windows that cover everything', () => {
    const p = planSplit({ ...base, minX: 10, maxX: 1010, bedX: 600 }); // 1000 mm long, 590 mm windows
    expect(p.n).toBe(2 + 0);
    expect(p.segLen).toBe(590);
    expect(p.shift).toBe(550);
    expect(p.windows[0].x0).toBe(10);
    expect(p.windows[p.n - 1].x1).toBeGreaterThanOrEqual(1010);
    for (let k = 0; k + 1 < p.n; k++) {
      expect(p.windows[k].x1 - p.windows[k + 1].x0).toBeCloseTo(40); // overlap
      expect(p.windows[k + 1].x0 - p.windows[k].x0).toBeCloseTo(p.shift);
    }
  });
  it('uses more segments for longer parts', () => {
    expect(planSplit({ ...base, minX: 0, maxX: 2000, bedX: 600 }).n).toBeGreaterThanOrEqual(4);
  });
});

describe('clipping moves', () => {
  const line: Pt3[] = [{ x: 0, y: 0, z: -5 }, { x: 100, y: 10, z: -5 }];
  it('keeps the inside part of a straight move and interpolates y', () => {
    const r = clipMoves(line, 20, 60);
    expect(r.length).toBe(1);
    expect(r[0][0].x).toBeCloseTo(20); expect(r[0][0].y).toBeCloseTo(2);
    expect(r[0][1].x).toBeCloseTo(60); expect(r[0][1].y).toBeCloseTo(6);
  });
  it('interpolates z along a ramp', () => {
    const ramp: Pt3[] = [{ x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: -10 }];
    const r = clipMoves(ramp, 50, 100);
    expect(r[0][0].z).toBeCloseTo(-5);
  });
  it('splits a path that leaves and re-enters the window', () => {
    const v: Pt3[] = [{ x: 10, y: 0, z: -1 }, { x: 80, y: 0, z: -1 }, { x: 80, y: 5, z: -1 }, { x: 10, y: 5, z: -1 }];
    const r = clipMoves(v, 0, 50);
    expect(r.length).toBe(2);
    expect(r[0][r[0].length - 1].x).toBeCloseTo(50);
    expect(r[1][0].x).toBeCloseTo(50);
  });
  it('a move wholly outside is dropped', () => {
    expect(clipMoves(line, 200, 300)).toEqual([]);
  });
  it('a move that crosses the whole window gives one run across it', () => {
    const r = clipMoves(line, 30, 40);
    expect(r.length).toBe(1);
    expect(r[0][0].x).toBeCloseTo(30); expect(r[0][1].x).toBeCloseTo(40);
  });
  it('windows together cover all the cutting length of a toolpath (nothing lost, overlap counted twice)', () => {
    const rect = [{ x: 0, y: 0 }, { x: 900, y: 0 }, { x: 900, y: 40 }, { x: 0, y: 40 }];
    const tp = profile([rect], 'outside', { tool: { type: 'flat', diameter: 6 }, material: MATERIALS.softwood, depth: 4, direction: 'climb' });
    const plan = planSplit({ minX: -3, maxX: 903, bedX: 600, margin: 5, overlap: 40 });
    const len = (t: typeof tp) => t.cuts.reduce((s, c) => s + c.moves.reduce((a, m, i) => i ? a + Math.hypot(m.x - c.moves[i - 1].x, m.y - c.moves[i - 1].y) : a, 0), 0);
    const total = len(tp);
    const parts = plan.windows.map(w => len(clipToolpath(tp, w.x0, w.x1)));
    const covered = parts.reduce((a, b) => a + b, 0);
    expect(covered).toBeGreaterThanOrEqual(total - 1e-6);   // nothing lost
    // double-counted length is only the overlap strips: at most 2 long edges (+ ends) x overlap x levels
    expect(covered - total).toBeLessThanOrEqual((plan.n - 1) * 2 * 40 * 1.2 * 4 + 50);
  });
  it('clipped runs are open cuts that begin at depth they were cut', () => {
    const rect = [{ x: 0, y: 0 }, { x: 900, y: 0 }, { x: 900, y: 40 }, { x: 0, y: 40 }];
    const tp = profile([rect], 'outside', { tool: { type: 'flat', diameter: 6 }, material: MATERIALS.softwood, depth: 4, direction: 'climb' });
    const c = clipToolpath(tp, 100, 400);
    expect(c.cuts.length).toBeGreaterThan(0);
    expect(c.cuts.every(k => !k.closed)).toBe(true);
    for (const k of c.cuts) for (const m of k.moves) { expect(m.x).toBeGreaterThanOrEqual(100 - 1e-6); expect(m.x).toBeLessThanOrEqual(400 + 1e-6); }
  });
});

describe('registration pins', () => {
  const l = { distance: 15, pairGap: 30, halfSpan: 10 };
  const plan = planSplit({ minX: 0, maxX: 1500, bedX: 600, margin: 5, overlap: 40 });
  it('sit in the overlap, above the part', () => {
    for (let k = 0; k + 1 < plan.n; k++) {
      const xc = junctionCentreX(plan, k);
      for (const p of registrationPins(xc, 60, l)) {
        expect(p.x).toBeGreaterThan(plan.windows[k + 1].x0);
        expect(p.x).toBeLessThan(plan.windows[k].x1);
        expect(p.y).toBeGreaterThan(60 + l.distance - 1e-9);
      }
    }
  });
  it('sliding the stock by `shift` puts the pins from the end of one segment at the start of the next', () => {
    const wx = (k: number, x: number) => x - plan.windows[k].x0; // machine x before margin
    const right0 = registrationPins(junctionCentreX(plan, 0), 60, l).map(p => wx(0, p.x));
    const left1 = registrationPins(junctionCentreX(plan, 0), 60, l).map(p => wx(1, p.x));
    right0.forEach((x, i) => expect(x - left1[i]).toBeCloseTo(plan.shift));
    // and every junction uses the same machine positions
    const j1 = registrationPins(junctionCentreX(plan, 1), 60, l).map(p => wx(1, p.x));
    right0.forEach((x, i) => expect(x).toBeCloseTo(j1[i]));
  });
  it('are keyed: cannot be seated rotated or flipped even if the stock is slid around', () => {
    const pins = registrationPins(0, 60, l);
    const cx = pins.reduce((s, p) => s + p.x, 0) / 3, cy = pins.reduce((s, p) => s + p.y, 0) / 3;
    expect(wrongFits(pins, { x: cx, y: cy }, 'tb', 2)).toEqual([]);
  });
});
