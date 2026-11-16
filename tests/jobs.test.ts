import { describe, it, expect } from 'vitest';
import { buildSplitJob } from '../src/core/jobs';
import { profile } from '../src/core/ops';
import { registrationPins, planSplit, junctionCentreX } from '../src/core/split';
import { wrongFits, flipPoint } from '../src/core/twosided';
import { toGcode } from '../src/core/gcode';
import { MATERIALS } from '../src/core/presets';
import type { Loop } from '../src/core/types';

const rect = (x: number, y: number, w: number, h: number): Loop => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const mk = (r: Loop) => profile([r], 'outside', { tool: { type: 'flat', diameter: 6 }, material: MATERIALS.softwood, depth: 10, direction: 'climb' });
const common = {
  bedX: 600, bedY: 600, margin: 5, overlap: 40, pin: { distance: 15, pairGap: 30, halfSpan: 10 }, dowelDia: 6, stockT: 20,
  spoilDepth: 16, bit: { type: 'flat' as const, diameter: 6 }, material: MATERIALS.softwood,
};
const part = { minX: -3, minY: -3, maxX: 1003, maxY: 43 };

describe('single-sided split job', () => {
  const job = buildSplitJob({ ...common, sides: [[mk(rect(0, 0, 1000, 40))]], part, axis: { x: 500, y: 20 } });
  it('makes a step 0 file and one file per segment', () => {
    expect(job.plan.n).toBe(2);
    expect(job.files.map(f => f.name)).toEqual(['step0_spoilboard.gcode', 'segment1.gcode', 'segment2.gcode']);
  });
  it('every move in every file stays inside the work area', () => {
    for (const f of job.files) for (const tp of f.paths) for (const c of tp.cuts) for (const m of c.moves) {
      expect(m.x).toBeGreaterThanOrEqual(-1e-6); expect(m.x).toBeLessThanOrEqual(600 + 1e-6);
      expect(m.y).toBeGreaterThanOrEqual(-1e-6); expect(m.y).toBeLessThanOrEqual(600 + 1e-6);
    }
  });
  it('registration holes are drilled through the stock at the end of segment 1 only', () => {
    const s1 = job.files[1].paths[0], s2 = job.files[2].paths[0];
    expect(s1.name).toMatch(/registration holes/);
    expect(s1.cuts.length).toBe(3);
    expect(s2.name).not.toMatch(/registration holes/);
    expect(Math.min(...s1.cuts[0].moves.map(m => m.z))).toBeCloseTo(-22); // T + 2
  });
  it('step 0 holes are exactly one slide-length left of where segment 1 drills', () => {
    const r = job.files[1].paths[0].cuts.map(c => c.moves[0]).sort((a, b) => a.x - b.x || a.y - b.y);
    const l = job.files[0].paths[0].cuts.map(c => c.moves[0]).sort((a, b) => a.x - b.x || a.y - b.y);
    l.forEach((p, i) => { expect(r[i].x - p.x).toBeCloseTo(job.plan.shift); expect(r[i].y).toBeCloseTo(p.y); });
  });
  it('the part is cut across both segments with the overlap present in each', () => {
    const xs = (k: number) => job.files[k + 1].paths.filter(p => !/hole/.test(p.name)).flatMap(p => p.cuts.flatMap(c => c.moves.map(m => m.x)));
    expect(Math.max(...xs(0))).toBeGreaterThan(590 - 1);
    expect(Math.min(...xs(1))).toBeLessThan(10);
  });
  it('produces valid G-code', () => {
    for (const f of job.files) expect(toGcode(f.paths)).toMatch(/G21/);
  });
});

describe('split + turn-over job', () => {
  const axis = { x: 500, y: 20 };
  const job = buildSplitJob({ ...common, sides: [[mk(rect(0, 0, 1000, 40))], [mk(rect(0, 5, 1000, 30))]], part, axis });
  it('has step 0 plus both sides for every segment', () => {
    expect(job.files.map(f => f.name)).toEqual(['step0_spoilboard.gcode', 'side1_segment1.gcode', 'side1_segment2.gcode', 'side2_segment1.gcode', 'side2_segment2.gcode']);
  });
  it('step 0 drills both the left and right pin sets (12 holes)', () => {
    expect(job.files[0].paths[0].cuts.length).toBe(12);
  });
  it('the 6 pins at a junction land on themselves after the flip but fit no other way', () => {
    const pins = job.pinsDraw[0];
    expect(pins.length).toBe(6);
    for (const p of pins) {
      const q = flipPoint(p, axis, 'tb');
      expect(pins.some(r => Math.hypot(r.x - q.x, r.y - q.y) < 1e-9)).toBe(true);
    }
    expect(wrongFits(pins, { x: pins[0].x, y: axis.y }, 'tb', 2)).toEqual([]);
  });
  it('only side 1 drills registration holes', () => {
    const drills = (i: number) => job.files[i].paths.some(p => /registration holes/.test(p.name));
    expect([drills(1), drills(2), drills(3), drills(4)]).toEqual([true, false, false, false]);
  });
  it('stays inside the work area', () => {
    for (const f of job.files) for (const tp of f.paths) for (const c of tp.cuts) for (const m of c.moves) {
      expect(m.y).toBeGreaterThanOrEqual(-1e-6); expect(m.y).toBeLessThanOrEqual(600 + 1e-6);
    }
  });
});

describe('pins mirrored for a flip are still keyed', () => {
  it('same junction pins at every junction', () => {
    const plan = planSplit({ minX: 0, maxX: 2000, bedX: 600, margin: 5, overlap: 40 });
    const l = { distance: 15, pairGap: 30, halfSpan: 10 };
    const a = registrationPins(junctionCentreX(plan, 0), 40, l, 20).map(p => p.x - plan.windows[0].x0);
    const b = registrationPins(junctionCentreX(plan, 1), 40, l, 20).map(p => p.x - plan.windows[1].x0);
    a.forEach((x, i) => expect(x).toBeCloseTo(b[i]));
  });
});

describe('a part that fits is not split', () => {
  it('returns no files', () => {
    const j = buildSplitJob({ ...common, sides: [[mk(rect(0, 0, 400, 40))]], part: { minX: -3, minY: -3, maxX: 403, maxY: 43 }, axis: { x: 200, y: 20 } });
    expect(j.plan.n).toBe(1);
    expect(j.files).toEqual([]);
  });
});
