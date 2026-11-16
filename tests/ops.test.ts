import { describe, it, expect } from 'vitest';
import { profile, pocket, depthLevels } from '../src/core/ops';
import { signedArea, insideRegion } from '../src/core/geometry';
import { toGcode, checkBounds } from '../src/core/gcode';
import { radiusAt, toolWarnings } from '../src/core/tool';
import { MATERIALS } from '../src/core/presets';
import type { Loop, Tool } from '../src/core/types';

const rect = (x: number, y: number, w: number, h: number): Loop =>
  [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const flat: Tool = { type: 'flat', diameter: 6 };
const base = { tool: flat, material: MATERIALS.softwood, depth: 5 };

describe('cut direction (spindle CW)', () => {
  it('climb outside profile is CW (uncut material on the right of travel)', () => {
    const tp = profile([rect(0, 0, 50, 50)], 'outside', { ...base, direction: 'climb' });
    expect(tp.cuts.every(c => signedArea(c.loop) < 0)).toBe(true);
  });
  it('conventional outside profile is CCW', () => {
    const tp = profile([rect(0, 0, 50, 50)], 'outside', { ...base, direction: 'conventional' });
    expect(tp.cuts.every(c => signedArea(c.loop) > 0)).toBe(true);
  });
  it('climb: hole in a part is cut CCW, outer edge CW', () => {
    const tp = profile([rect(0, 0, 50, 50), rect(15, 15, 20, 20)], 'outside', { ...base, direction: 'climb' });
    for (const c of tp.cuts) {
      const big = Math.abs(signedArea(c.loop)) > 1000;
      expect(signedArea(c.loop) > 0).toBe(!big);
    }
  });
  it('climb pocket boundary is CCW; island is CW', () => {
    const tp = pocket([rect(0, 0, 60, 60), rect(25, 25, 10, 10)], { ...base, direction: 'climb', stepoverFraction: 0.4 });
    const outer = tp.cuts.filter(c => Math.abs(signedArea(c.loop)) > 1000);
    expect(outer.length).toBeGreaterThan(0);
    expect(outer.every(c => signedArea(c.loop) > 0)).toBe(true);
    expect(tp.cuts.some(c => signedArea(c.loop) < 0)).toBe(true);
  });
});

describe('geometry', () => {
  it('outside profile offsets by tool radius', () => {
    const tp = profile([rect(0, 0, 50, 50)], 'outside', { ...base, direction: 'climb' });
    const xs = tp.cuts[0].loop.map(p => p.x);
    expect(Math.min(...xs)).toBeCloseTo(-3, 1);
    expect(Math.max(...xs)).toBeCloseTo(53, 1);
  });
  it('depth levels respect stepdown', () => {
    const lv = depthLevels(5, 2);
    expect(lv.length).toBe(3);
    expect(lv[2]).toBeCloseTo(-5);
  });
});

describe('ramped entry', () => {
  const tp = profile([rect(0, 0, 100, 100)], 'outside', { ...base, direction: 'climb', ramp: { maxAngleDeg: 3 } });
  it('never descends steeper than the max angle and never goes up', () => {
    for (const c of tp.cuts) {
      for (let i = 1; i < c.moves.length; i++) {
        const a = c.moves[i - 1], b = c.moves[i];
        const dxy = Math.hypot(b.x - a.x, b.y - a.y);
        expect(b.z).toBeLessThanOrEqual(a.z + 1e-9);
        if (dxy > 1e-6) expect((a.z - b.z) / dxy).toBeLessThanOrEqual(Math.tan((3 * Math.PI) / 180) + 1e-6);
      }
      expect(c.moves[c.moves.length - 1].z).toBeCloseTo(c.z);
    }
  });
  it('ramp ends at the target depth then finishes a flat lap', () => {
    const c = tp.cuts[0];
    const flatPts = c.moves.filter(m => Math.abs(m.z - c.z) < 1e-9);
    expect(flatPts.length).toBeGreaterThan(4);
  });
  it('tiny loops use several laps rather than plunging', () => {
    const t = profile([rect(0, 0, 8, 8)], 'outside', { ...base, direction: 'climb', ramp: { maxAngleDeg: 3 } });
    const c = t.cuts[0];
    const maxVert = Math.max(...c.moves.slice(1).map((m, i) => (c.moves[i].z - m.z)));
    expect(maxVert).toBeLessThan(1);
  });
});

describe('tabs', () => {
  const tabs = { count: 4, width: 6, height: 3 };
  const tp = profile([rect(0, 0, 100, 100)], 'outside', { ...base, depth: 12, direction: 'climb', tabs });
  it('final pass is held at tab height on spans and at full depth elsewhere', () => {
    const last = tp.cuts[tp.cuts.length - 1];
    const zs = new Set(last.moves.map(m => +m.z.toFixed(3)));
    expect(zs.has(-9)).toBe(true);
    expect(zs.has(-12)).toBe(true);
    expect(Math.min(...last.moves.map(m => m.z))).toBeCloseTo(-12);
    const raised = last.moves.filter(m => Math.abs(m.z + 9) < 1e-6).length;
    expect(raised).toBeGreaterThanOrEqual(4);
  });
  it('passes above the tab top are unaffected', () => {
    expect(tp.cuts[0].moves.every(m => m.z >= tp.cuts[0].z - 1e-9)).toBe(true);
  });
});

describe('bit geometry', () => {
  const v: Tool = { type: 'vbit', diameter: 12, angle: 60, tipDiameter: 0.2 };
  it('V-bit radius widens with depth and caps at full diameter', () => {
    expect(radiusAt(v, 0)).toBeCloseTo(0.1);
    expect(radiusAt(v, -2)).toBeCloseTo(0.1 + 2 * Math.tan(Math.PI / 6));
    expect(radiusAt(v, -50)).toBeCloseTo(6);
  });
  it('flat and ball bits use full diameter at any depth', () => {
    expect(radiusAt({ type: 'ball', diameter: 4 }, -1)).toBe(2);
  });
  it('warns about V-bits for cut-outs', () => {
    expect(toolWarnings(v, 3, 'profile').length).toBeGreaterThan(0);
    expect(toolWarnings(flat, 3, 'profile')).toEqual([]);
  });
  it('V-bit profile offset grows per level', () => {
    const tp = profile([rect(0, 0, 50, 50)], 'outside', { tool: v, material: MATERIALS.softwood, depth: 4, direction: 'climb' });
    const minX = (c: typeof tp.cuts[0]) => Math.min(...c.loop.map(p => p.x));
    expect(minX(tp.cuts[tp.cuts.length - 1])).toBeLessThan(minX(tp.cuts[0]));
  });
});

describe('gcode', () => {
  const tp = profile([rect(0, 0, 20, 20)], 'outside', { ...base, direction: 'climb' });
  it('marlin: manual router, pause, no spindle commands', () => {
    const g = toGcode([tp]);
    expect(g).not.toMatch(/M3|M5/);
    expect(g).toMatch(/M0/);
    expect(g).not.toMatch(/M2/);
  });
  it('grbl ends with M2 and keeps comments after M0 on their own line', () => {
    const g = toGcode([tp], { flavor: 'grbl', spindle: 'manual', safeZ: 5, decimals: 3 });
    expect(g.trimEnd().endsWith('M2')).toBe(true);
    expect(g).toMatch(/^M0$/m);
  });
  it('descending moves use plunge feed', () => {
    const t = profile([rect(0, 0, 60, 60)], 'outside', { ...base, direction: 'climb', ramp: { maxAngleDeg: 3 } });
    const lines = toGcode([t]).split('\n').filter(l => l.startsWith('G1'));
    expect(lines.some(l => l.includes('F300'))).toBe(true);
    expect(lines.some(l => l.includes('F1000'))).toBe(true);
  });
  it('bounds check flags oversize parts', () => {
    const big = profile([rect(0, 0, 700, 100)], 'outside', { ...base, direction: 'climb' });
    expect(checkBounds([big], { width: 600, depthY: 600 }).length).toBeGreaterThan(0);
    const ok = profile([rect(10, 10, 100, 100)], 'outside', { ...base, direction: 'climb' });
    expect(checkBounds([ok], { width: 600, depthY: 600 })).toEqual([]);
  });
});

import { onLine } from '../src/core/ops';

describe('on the line', () => {
  const line = { pts: [{ x: 0, y: 0 }, { x: 50, y: 0 }], closed: false };
  const p = { tool: flat, material: MATERIALS.softwood, depth: 4, direction: 'climb' as const };
  it('plunges to depth and covers the whole open line at full depth (no ramp)', () => {
    const tp = onLine([line], p);
    expect(tp.cuts.length).toBe(2);
    const m = tp.cuts[1].moves;
    expect(m[m.length - 1]).toEqual({ x: 50, y: 0, z: -4 });
  });
  it('ramped open line never descends steeper than the angle and ends at depth', () => {
    const tp = onLine([line], { ...p, ramp: { maxAngleDeg: 3 } });
    for (const c of tp.cuts) {
      for (let i = 1; i < c.moves.length; i++) {
        const a = c.moves[i - 1], b = c.moves[i];
        const d = Math.hypot(b.x - a.x, b.y - a.y);
        if (d > 1e-6) expect((a.z - b.z) / d).toBeLessThanOrEqual(Math.tan((3 * Math.PI) / 180) + 1e-6);
        expect(b.z).toBeLessThanOrEqual(a.z + 1e-9);
      }
      expect(c.moves[c.moves.length - 1].z).toBeCloseTo(c.z);
      const xs = c.moves.filter(m => Math.abs(m.z - c.z) < 1e-9).map(m => m.x);
      expect(Math.min(...xs)).toBeLessThan(1);
      expect(Math.max(...xs)).toBeGreaterThan(49);
    }
  });
  it('short lines are cut back and forth instead of plunging', () => {
    const short = { pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }], closed: false };
    const tp = onLine([short], { ...p, ramp: { maxAngleDeg: 3 } });
    const c = tp.cuts[0];
    const maxDrop = Math.max(...c.moves.slice(1).map((m, i) => c.moves[i].z - m.z));
    expect(maxDrop).toBeLessThan(1);
  });
  it('tool change inserts a bit-change pause', () => {
    const a = onLine([line], p);
    const b = onLine([line], { ...p, tool: { type: 'vbit', diameter: 12, angle: 60 } });
    const g = toGcode([a, b]);
    expect(g).toMatch(/CHANGE BIT to 60deg V-bit/);
  });
});

import { resolveMaterial, materialWarnings, MATERIALS as MAT } from '../src/core/presets';

describe('materials', () => {
  it('has a foam preset that is faster and takes deeper passes than wood', () => {
    expect(MAT.foam.feed).toBeGreaterThan(MAT.softwood.feed);
    expect(MAT.foam.stepdown).toBeGreaterThan(MAT.softwood.stepdown);
  });
  it('custom values override the preset, bad ones fall back', () => {
    expect(resolveMaterial('foam', { feed: 1234, plungeFeed: 400, stepdown: 3 })).toEqual({ feed: 1234, plungeFeed: 400, stepdown: 3 });
    expect(resolveMaterial('softwood', { feed: NaN, plungeFeed: -5, stepdown: 0 })).toEqual(MAT.softwood);
    expect(resolveMaterial('nonsense')).toEqual(MAT.softwood);
    expect(resolveMaterial('foam', null)).toEqual(MAT.foam);
  });
  it('custom depth per pass changes the number of passes', () => {
    const p = { tool: { type: 'flat' as const, diameter: 6 }, depth: 12, direction: 'climb' as const };
    const sq = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }];
    const a = profile([sq], 'outside', { ...p, material: resolveMaterial('softwood', { stepdown: 6 }) });
    const b = profile([sq], 'outside', { ...p, material: resolveMaterial('softwood', { stepdown: 3 }) });
    expect(new Set(a.cuts.map(c => c.z)).size).toBe(2);
    expect(new Set(b.cuts.map(c => c.z)).size).toBe(4);
  });
  it('warns about risky hand-entered values', () => {
    expect(materialWarnings({ feed: 500, plungeFeed: 900, stepdown: 1 }, 6).some(w => /Plunge/.test(w))).toBe(true);
    expect(materialWarnings({ feed: 1000, plungeFeed: 300, stepdown: 20 }, 6).some(w => /twice the bit/.test(w))).toBe(true);
    expect(materialWarnings({ feed: 9000, plungeFeed: 300, stepdown: 2 }, 6).some(w => /6000/.test(w))).toBe(true);
    expect(materialWarnings(MAT.foam, 6)).toEqual([]);
  });
});

describe('climb really is climb (physics check, independent of the winding convention)', () => {
  // Clockwise spindle seen from above. Material on the RIGHT of travel => the tooth at the contact point moves the same way as
  // the work moves relative to the tool => climb. Check each emitted path: for the cut edge, the uncut material is on the right.
  const sideOfMaterial = (loop: { x: number; y: number }[], material: { x: number; y: number }) => {
    // sign of cross(direction of the first segment, vector to the material point): negative = material on the right
    const a = loop[0], b = loop[1];
    return Math.sign((b.x - a.x) * (material.y - a.y) - (b.y - a.y) * (material.x - a.x));
  };
  it('outside cut of a square: the part (material) is on the right of travel', () => {
    const tp = profile([rect(0, 0, 50, 50)], 'outside', { ...base, direction: 'climb' });
    expect(sideOfMaterial(tp.cuts[0].loop, { x: 25, y: 25 })).toBe(-1);
  });
  it('conventional puts it on the left', () => {
    const tp = profile([rect(0, 0, 50, 50)], 'outside', { ...base, direction: 'conventional' });
    expect(sideOfMaterial(tp.cuts[0].loop, { x: 25, y: 25 })).toBe(1);
  });
  it('a pocket: the wall (outside the ring) is on the right of travel when climbing, and on the left when conventional', () => {
    const rightIsOutside = (dir: 'climb' | 'conventional') => {
      const tp = pocket([rect(0, 0, 60, 60)], { ...base, direction: dir, stepoverFraction: 0.4 });
      const ring = tp.cuts[0].loop; // the outermost ring runs along the wall
      const a = ring[0], b = ring[1], l = Math.hypot(b.x - a.x, b.y - a.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const right = { x: mid.x + ((b.y - a.y) / l) * 0.5, y: mid.y - ((b.x - a.x) / l) * 0.5 }; // 0.5 mm to the right of travel
      return !insideRegion([ring], right.x, right.y);
    };
    expect(rightIsOutside('climb')).toBe(true);
    expect(rightIsOutside('conventional')).toBe(false);
  });
});