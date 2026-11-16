import { describe, it, expect } from 'vitest';
import { inlay } from '../src/core/inlay';
import { toGcode } from '../src/core/gcode';
import { MATERIALS } from '../src/core/presets';
import type { Cut, Loop, Tool } from '../src/core/types';

const rect = (x: number, y: number, w: number, h: number): Loop => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const v90: Tool = { type: 'vbit', diameter: 12, angle: 90, tipDiameter: 0 };
const v60: Tool = { type: 'vbit', diameter: 12, angle: 60, tipDiameter: 0 };
const material = MATERIALS.softwood;
const base = (tool: Tool, depth: number, glueGap = 0.3) => ({ tool, material, depth, glueGap, moat: 4, direction: 'climb' as const });

/** Deepest the cutter reaches at a point, from a set of cuts. */
function achieved(cuts: Cut[], tool: Tool, x: number, y: number): number {
  const tan = Math.tan((((tool.angle ?? 60) * Math.PI) / 360)), tip = (tool.tipDiameter ?? 0) / 2;
  let best = 0;
  for (const c of cuts) for (let i = 1; i < c.moves.length; i++) {
    const a = c.moves[i - 1], b = c.moves[i], L = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z), n = Math.max(1, Math.ceil(L / 0.1));
    for (let k = 0; k <= n; k++) {
      const t = k / n, px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t, pz = -(a.z + (b.z - a.z) * t);
      const d = pz - Math.max(0, Math.hypot(x - px, y - py) - tip) / tan;
      if (d > best) best = d;
    }
  }
  return best;
}

describe('V-inlay geometry: the insert fits the recess', () => {
  // A long strip, so a cross-section at x = 30 is a clean 1D profile. Symmetric about its own mirror line.
  for (const [name, tool, P, a] of [['90 degree V', v90, 2, 4], ['60 degree V', v60, 3, 4]] as const) {
    it(`${name}: recess depth equals insert height minus the glue gap across the whole stroke`, () => {
      const g = 0.3;
      const r = inlay([rect(0, 0, 60, 2 * a)], base(tool, P, g));
      const female = r.toolpath.cuts.filter(c => c.tag === 'female'), male = r.toolpath.cuts.filter(c => c.tag === 'male');
      expect(female.length).toBeGreaterThan(0); expect(male.length).toBeGreaterThan(0);
      const Pm = P + g;
      let worst = 0;
      for (let k = 0; k <= 20; k++) {
        const y = a + (-a + (2 * a * k) / 20);                        // across the stroke, centre y = a
        const f = achieved(female, tool, 30, y);                      // depth of the recess here
        const m = achieved(male, tool, 30, y);                        // depth carved away on the male here
        const h = Pm - m;                                             // height of the insert here (0 at the moat)
        worst = Math.max(worst, Math.abs(f - (h - g)));
        // the insert never goes below the recess floor (it would not fit), and never leaves a big gap
        // allow the small ridge a V-bit leaves on a cleared floor (about step / 2 / tan = 0.13 mm at worst)
        expect(h - g).toBeLessThan(f + 0.2);
        expect(h - g).toBeGreaterThan(f - 0.2);
      }
      expect(worst).toBeLessThan(0.2);
    });
  }

  it('the insert is mirrored about the middle of the design (so it reads right once flipped)', () => {
    const L: Loop = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 30 }, { x: 0, y: 30 }];  // an L: not symmetric
    const r = inlay([L], base(v90, 2));
    expect(r.mirrorX).toBeCloseTo(20);
    const female = r.toolpath.cuts.filter(c => c.tag === 'female').flatMap(c => c.moves);
    const male = r.toolpath.cuts.filter(c => c.tag === 'male').flatMap(c => c.moves);
    // the L's tall arm is on the left (x near 0..10) for the recess and on the right (x near 30..40) for the insert
    const tallArm = (ms: typeof male, left: boolean) => ms.filter(m => (left ? m.x < 10 : m.x > 30) && m.y > 18 && m.z > -2.4).length;
    expect(tallArm(female, true)).toBeGreaterThan(0);
    expect(tallArm(female, false)).toBe(0);
    expect(tallArm(male, false)).toBeGreaterThan(0);
  });

  it('the first insert pass stops the program so the board can be swapped; the recess passes do not', () => {
    const r = inlay([rect(0, 0, 40, 8)], base(v90, 2));
    const cuts = r.toolpath.cuts;
    const idx = cuts.findIndex(c => c.pauseBefore);
    expect(idx).toBeGreaterThan(0);
    expect(cuts.slice(0, idx).every(c => c.tag === 'female')).toBe(true);
    expect(cuts.slice(idx).every(c => c.tag === 'male')).toBe(true);
    expect(cuts.filter(c => c.pauseBefore).length).toBe(1);
    const g = toGcode([r.toolpath]);
    expect(g).toMatch(/SWAP THE BOARD/);
    expect(g.indexOf('SWAP THE BOARD')).toBeLessThan(g.lastIndexOf('G1'));
    expect(g).toMatch(/\nM0\n/);
  });

  it('the insert is cut deeper than the recess by the glue gap', () => {
    const r = inlay([rect(0, 0, 40, 8)], base(v90, 2, 0.4));
    const deepest = (tag: string) => -Math.min(...r.toolpath.cuts.filter(c => c.tag === tag).flatMap(c => c.moves.map(m => m.z)));
    expect(deepest('female')).toBeCloseTo(2, 1);
    expect(deepest('male')).toBeCloseTo(2.4, 1);
  });

  it('nothing is cut outside the blank outline, which surrounds the carving', () => {
    const r = inlay([rect(0, 0, 40, 8)], base(v90, 2));
    expect(r.blank.length).toBe(1);
    const xs = r.blank[0].map(p => p.x), ys = r.blank[0].map(p => p.y);
    const male = r.toolpath.cuts.filter(c => c.tag === 'male').flatMap(c => c.moves);
    // the blank outline is kept 0.2 mm inside the outermost tip ring, so no uncut rim is left around the carving
    expect(Math.min(...male.map(m => m.x))).toBeGreaterThan(Math.min(...xs) - 0.25);
    expect(Math.max(...male.map(m => m.x))).toBeLessThan(Math.max(...xs) + 0.25);
    expect(Math.max(...male.map(m => m.y))).toBeLessThan(Math.max(...ys) + 0.25);
    expect(Math.min(...male.map(m => m.y))).toBeGreaterThan(Math.min(...ys) - 0.25);
    // and the blank really surrounds the lettering with room to spare
    expect(Math.min(...xs)).toBeLessThan(-3); expect(Math.max(...xs)).toBeGreaterThan(43);
  });

  it('warns about strokes too thin to inlay at this depth, and when the bit is too narrow', () => {
    const thin = inlay([rect(0, 0, 40, 1.5)], base(v90, 2));                 // 1.5 mm wide < 2 * delta = 4
    expect(thin.warnings.some(w => /thinner|nothing left/.test(w))).toBe(true);
    const narrowBit = inlay([rect(0, 0, 40, 30)], base({ ...v60, diameter: 3 }, 3));
    expect(narrowBit.warnings.some(w => /only 3 mm wide/.test(w))).toBe(true);
    expect(inlay([rect(0, 0, 40, 8)], base(v90, 2)).warnings).toEqual([]);
  });

  it('letters with holes keep the hole as part of the island (nothing missing, nothing extra)', () => {
    const ring = [
      Array.from({ length: 120 }, (_, k) => ({ x: 20 * Math.cos((k / 120) * 2 * Math.PI), y: 20 * Math.sin((k / 120) * 2 * Math.PI) })),
      Array.from({ length: 80 }, (_, k) => ({ x: 8 * Math.cos((k / 80) * 2 * Math.PI), y: 8 * Math.sin((k / 80) * 2 * Math.PI) })).reverse(),
    ];
    const r = inlay(ring, base(v90, 2));
    const male = r.toolpath.cuts.filter(c => c.tag === 'male');
    // the island is the ring wall inset by 2 mm: the middle of the ring (radius 14) stays uncut on the insert
    expect(achieved(male, v90, 14, 0)).toBeLessThan(0.05);
    // and the hole's centre (radius 0) is carved away to the full insert depth
    // (the background floor is cleared with a coarse step, so allow the ridge it leaves: at most 0.25 mm of the 2.3)
    expect(achieved(male, v90, 0, 0)).toBeGreaterThan(2.0);
  });

  it('empty input gives an empty result', () => {
    const r = inlay([], base(v90, 2));
    expect(r.toolpath.cuts).toEqual([]);
  });
});
