import { describe, it, expect } from 'vitest';
import { inlayFlat, FLAT_FIT } from '../src/core/inlay';
import { offset, regionArea } from '../src/core/geometry';
import type { Loop } from '../src/core/types';

const mat = { feed: 800, plungeFeed: 300, stepdown: 2 };
const tool = { type: 'flat' as const, diameter: 4 };
const rect = (w: number, h: number): Loop => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
const params = { tool, material: mat, depth: 3, proud: 1, direction: 'climb' as const };

describe('flat-bottom inlay', () => {
  const r = inlayFlat([rect(40, 20)], params);
  const female = r.toolpath.cuts.filter(c => c.tag === 'female'), male = r.toolpath.cuts.filter(c => c.tag === 'male');
  it('pockets the recess first, then pauses for the insert board, then cuts the insert out', () => {
    expect(female.length).toBeGreaterThan(0); expect(male.length).toBeGreaterThan(0);
    expect(r.toolpath.cuts.indexOf(male[0])).toBeGreaterThan(r.toolpath.cuts.indexOf(female[female.length - 1]));
    expect(male[0].pauseBefore).toMatch(/4 mm thick/);
    expect(Math.min(...female.map(c => c.z))).toBeCloseTo(-3);
    expect(Math.min(...male.map(c => c.z))).toBeCloseTo(-4);
    expect(male.every(c => !c.pauseBefore || c === male[0])).toBe(true);
  });
  it('the insert is FLAT_FIT smaller than the recess all round', () => {
    // tool-centre loop of the insert cut: the insert is that loop pulled in by the bit radius
    const insertPath = male[male.length - 1].loop;
    const insertArea = Math.abs(regionArea(offset([insertPath], -2)));
    expect(insertArea).toBeLessThan(800);
    // 40 x 20 with corners rounded by r = 2: area is 800 - (4 - pi) * 4; the perimeter strip is about 0.1 wide
    const rounded = 800 - (4 - Math.PI) * 4;
    const perim = 2 * (40 + 20) - (8 - 2 * Math.PI) * 2;
    expect(insertArea).toBeCloseTo(rounded - FLAT_FIT * perim, 0);
  });
  it('rounds the corners and says so', () => {
    expect(r.warnings.join(' ')).toMatch(/rounded to the 4 mm bit radius/);
  });
  it('a design narrower than the bit cannot be cut', () => {
    const t = inlayFlat([rect(40, 3)], params);
    expect(t.toolpath.cuts.length).toBe(0);
    expect(t.warnings.join(' ')).toMatch(/narrower than the 4 mm bit/);
  });
  it('lost detail is reported', () => {
    const star: Loop = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 20 }, { x: 21, y: 20 }, { x: 20, y: 40 }, { x: 19, y: 20 }, { x: 0, y: 20 }];
    expect(inlayFlat([star], params).warnings.join(' ')).toMatch(/Fine detail/);
  });
});
