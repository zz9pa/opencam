import { describe, it, expect } from 'vitest';
import { circleOf, nearestOrder } from '../src/core/holes';
import { drill } from '../src/core/ops';

const circle = (cx: number, cy: number, r: number, n = 48) => Array.from({ length: n }, (_, i) => ({ x: cx + r * Math.cos(2 * Math.PI * i / n), y: cy + r * Math.sin(2 * Math.PI * i / n) }));

describe('hole detection', () => {
  it('finds the centre and diameter of a circle', () => {
    const c = circleOf(circle(10, 20, 3))!;
    expect(c.x).toBeCloseTo(10); expect(c.y).toBeCloseTo(20); expect(c.d).toBeCloseTo(6, 1);
  });
  it('rejects squares and ovals', () => {
    expect(circleOf([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 }, { x: 2, y: 0 }, { x: 5, y: 2 }, { x: 3, y: 5 }, { x: 0, y: 3 }])).toBeNull();
    expect(circleOf(circle(0, 0, 3).map(p => ({ x: p.x * 1.3, y: p.y })))).toBeNull();
  });
  it('orders holes by nearest neighbour', () => {
    const o = nearestOrder([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 10, y: 0 }, { x: 90, y: 0 }]);
    expect(o.map(p => p.x)).toEqual([0, 10, 90, 100]);
  });
  it('drill: same-size bit pecks, smaller bit spirals, bigger bit cuts nothing', () => {
    const mat = { feed: 800, plungeFeed: 300, stepdown: 2 };
    const c = [{ x: 10, y: 10 }];
    expect(drill(c, { tool: { type: 'flat', diameter: 6 }, material: mat, depth: 6, direction: 'climb', holeDiameter: 6 }).cuts[0].moves.length).toBeGreaterThan(3);
    expect(drill(c, { tool: { type: 'flat', diameter: 3 }, material: mat, depth: 6, direction: 'climb', holeDiameter: 6 }).cuts.length).toBeGreaterThan(0);
    expect(drill(c, { tool: { type: 'flat', diameter: 8 }, material: mat, depth: 6, direction: 'climb', holeDiameter: 6 }).cuts.length).toBe(0);
  });
});

import { planDrill } from '../src/core/holes';
import { MATERIALS } from '../src/core/presets';

describe('planDrill', () => {
  const mat = MATERIALS.softwood;
  const params = (d: number) => ({ tool: { type: 'flat' as const, diameter: d }, material: mat, depth: 6, direction: 'climb' as const });
  const circles = [circle(10, 10, 7.14), circle(40, 10, 7.14), circle(70, 10, 3), circle(100, 10, 1)];
  it('groups by size, describes what the bit does, and warns about holes it cannot make', () => {
    const r = planDrill([...circles, [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 }, { x: 1, y: 0 }, { x: 4, y: 0 }, { x: 5, y: 2 }, { x: 0, y: 3 }]], params(6));
    expect(r.cuts.length).toBeGreaterThan(0);
    expect(r.info.join(' ')).toMatch(/2 hole\(s\) of 14.28 mm: spiralled out by the 6 mm bit/);
    expect(r.warnings.join(' ')).toMatch(/1 selected shape\(s\) are not round/);
    expect(r.warnings.join(' ')).toMatch(/hole\(s\) are smaller than the 6 mm bit/);
  });
  it('a hole a hair smaller than the bit is drilled bit-sized, and says so', () => {
    const r = planDrill([circle(20, 20, 1.475)], params(3)) // a 2.95 mm circle and a 3 mm bit;
    expect(r.cuts.length).toBeGreaterThan(0);
    expect(r.warnings.join(' ')).toMatch(/slightly smaller than the 3 mm bit/);
  });
  it('a hole exactly the bit size is pecked without a warning', () => {
    const r = planDrill([circle(20, 20, 3)], params(6));
    expect(r.warnings.length).toBe(0);
    expect(r.info.join(' ')).toMatch(/drilled straight down in pecks/);
  });
});
