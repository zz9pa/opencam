import { describe, it, expect } from 'vitest';
import { medialAxis, vcarve, depthForRadius, surfaceRadius } from '../src/core/vcarve';
import { MATERIALS } from '../src/core/presets';
import type { Loop, Tool, Toolpath } from '../src/core/types';

const rect = (x: number, y: number, w: number, h: number): Loop => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const circle = (cx: number, cy: number, r: number, n = 180, rev = false): Loop => {
  const p = Array.from({ length: n }, (_, k) => ({ x: cx + r * Math.cos((k / n) * 2 * Math.PI), y: cy + r * Math.sin((k / n) * 2 * Math.PI) }));
  return rev ? p.reverse() : p;
};
const v60: Tool = { type: 'vbit', diameter: 12, angle: 60, tipDiameter: 0 };
const v90: Tool = { type: 'vbit', diameter: 12, angle: 90, tipDiameter: 0 };

describe('V-bit geometry helpers', () => {
  it('depth and cone radius are inverses', () => {
    for (const t of [v60, v90, { ...v60, tipDiameter: 0.4 }]) {
      for (const d of [0.5, 1, 3]) expect(depthForRadius(t, surfaceRadius(t, d))).toBeCloseTo(d, 9);
    }
  });
  it('a 90 degree V goes as deep as the half-width; a 60 degree V deeper', () => {
    expect(depthForRadius(v90, 2)).toBeCloseTo(2);
    expect(depthForRadius(v60, 2)).toBeCloseTo(2 / Math.tan(Math.PI / 6));
  });
  it('a flat tip means the first part of the half-width needs no depth', () => {
    expect(depthForRadius({ ...v90, tipDiameter: 1 }, 0.4)).toBe(0);
    expect(depthForRadius({ ...v90, tipDiameter: 1 }, 2)).toBeCloseTo(1.5);
  });
});

describe('medial axis', () => {
  it('a long strip has its axis down the middle with radius = half the width', () => {
    const ax = medialAxis([rect(0, 0, 60, 6)], 0.3);
    const mid = ax.nodes.filter(n => n.x > 10 && n.x < 50);
    expect(mid.length).toBeGreaterThan(10);
    for (const n of mid) { expect(n.y).toBeCloseTo(3, 1); expect(n.r).toBeCloseTo(3, 1); }
  });
  it('every axis point is inside the shape and its radius is the distance to the outline', () => {
    const shape = [circle(0, 0, 20), circle(0, 0, 8, 120, true)]; // a ring: outer 20, hole 8
    const ax = medialAxis(shape, 0.4);
    expect(ax.nodes.length).toBeGreaterThan(50);
    for (const n of ax.nodes) {
      const rho = Math.hypot(n.x, n.y);
      expect(rho).toBeGreaterThan(8 - 0.2); expect(rho).toBeLessThan(20 + 0.2);
      const dist = Math.min(20 - rho, rho - 8);
      expect(Math.abs(n.r - dist)).toBeLessThan(0.15);
    }
  });
  it('a ring has a closed circular axis halfway between the walls', () => {
    const ax = medialAxis([circle(0, 0, 20), circle(0, 0, 8, 120, true)], 0.4);
    const mean = ax.nodes.reduce((s, n) => s + Math.hypot(n.x, n.y), 0) / ax.nodes.length;
    expect(mean).toBeCloseTo(14, 0);
    const deg = new Map<number, number>();
    ax.edges.forEach(([a, b]) => { deg.set(a, (deg.get(a) ?? 0) + 1); deg.set(b, (deg.get(b) ?? 0) + 1); });
    expect([...deg.values()].filter(v => v === 1).length).toBe(0);   // a closed loop has no dead ends
  });
  it('an L-shape has an axis that follows both arms', () => {
    const L: Loop = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 8 }, { x: 8, y: 8 }, { x: 8, y: 40 }, { x: 0, y: 40 }];
    const ax = medialAxis([L], 0.3);
    // within one half-width (4 mm) of an arm's end the axis forks towards the two corners, so check the straight part only
    const arm1 = ax.nodes.filter(n => n.x > 20 && n.x < 34), arm2 = ax.nodes.filter(n => n.y > 20 && n.y < 34);
    for (const n of arm1) expect(Math.abs(n.y - 4)).toBeLessThan(0.3);
    for (const n of arm2) expect(Math.abs(n.x - 4)).toBeLessThan(0.3);
    expect(arm1.length).toBeGreaterThan(5); expect(arm2.length).toBeGreaterThan(5);
  });
  it('handles nothing and tiny input without crashing', () => {
    expect(medialAxis([], 0.3).nodes).toEqual([]);
    expect(() => medialAxis([rect(0, 0, 1, 1)], 0.5)).not.toThrow();
  });
});

/**
 * Simulate the carve: how deep does the cutter actually go at a point? (deepest cone over all path samples)
 * and compare with the ideal V roof: depth = distance to the outline / tan(half angle).
 */
function achievedDepth(tp: Toolpath, tool: Tool, x: number, y: number): number {
  const half = ((tool.angle ?? 60) * Math.PI) / 360, tan = Math.tan(half), tip = (tool.tipDiameter ?? 0) / 2;
  let best = 0;
  for (const c of tp.cuts) {
    for (let i = 1; i < c.moves.length; i++) {
      const a = c.moves[i - 1], b = c.moves[i];
      const L = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z), n = Math.max(1, Math.ceil(L / 0.1));
      for (let k = 0; k <= n; k++) {
        const t = k / n, px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t, pz = -(a.z + (b.z - a.z) * t); // tip depth (positive)
        const s = Math.hypot(x - px, y - py);
        const d = pz - Math.max(0, s - tip) / tan;       // depth of the cone surface at this distance from the tip axis
        if (d > best) best = d;
      }
    }
  }
  return best;
}
function distToLoops(loops: Loop[], x: number, y: number): number {
  let best = Infinity;
  for (const l of loops) for (let i = 0; i < l.length; i++) {
    const a = l[i], b = l[(i + 1) % l.length], dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(x - a.x - t * dx, y - a.y - t * dy));
  }
  return best;
}
const deepestOf = (tp: Toolpath) => -Math.min(...tp.cuts.flatMap(c => c.moves.map(m => m.z)));

describe('V-carve toolpath', () => {
  const material = MATERIALS.softwood;
  const params = (tool: Tool, maxDepth = 10) => ({ tool, material, maxDepth, direction: 'climb' as const, wide: 'clear' as const });

  it('carves a strip to the right depth and the sloped walls reach the outline (no uncut ridge, no overcut)', () => {
    const shape = [rect(0, 0, 50, 6)];
    const tp = vcarve(shape, params(v90));
    expect(tp.cuts.length).toBeGreaterThan(0);
    expect(deepestOf(tp)).toBeCloseTo(3, 1);          // half width / tan(45 degrees)
    for (const [x, y] of [[25, 3], [25, 1.5], [25, 0.5], [10, 2], [40, 4.5]]) {
      const ideal = distToLoops(shape, x, y) / Math.tan(Math.PI / 4);
      expect(achievedDepth(tp, v90, x, y)).toBeGreaterThan(ideal - 0.06);
      expect(achievedDepth(tp, v90, x, y)).toBeLessThan(ideal + 0.06);
    }
    for (const [x, y] of [[25, -0.5], [25, 6.5], [-1, 3]]) expect(achievedDepth(tp, v90, x, y)).toBeLessThan(0.02);
  });

  it('a 60 degree bit goes deeper for the same stroke', () => {
    expect(deepestOf(vcarve([rect(0, 0, 50, 6)], params(v60)))).toBeGreaterThan(deepestOf(vcarve([rect(0, 0, 50, 6)], params(v90))));
    expect(deepestOf(vcarve([rect(0, 0, 50, 6)], params(v60)))).toBeCloseTo(3 / Math.tan(Math.PI / 6), 1);
  });

  it('a stroke of varying width: depth follows the local half-width', () => {
    const wedge: Loop = [{ x: 0, y: 0 }, { x: 60, y: -3 }, { x: 60, y: 9 }, { x: 0, y: 6 }]; // 6 wide at left, 12 wide at right
    const tp = vcarve([wedge], params(v90, 20));
    for (const x of [8, 25, 45]) {
      const yMid = 3 - (x / 60) * 0;            // centre line runs at y = 3 for this symmetric wedge
      const hw = distToLoops([wedge], x, yMid);
      expect(achievedDepth(tp, v90, x, yMid)).toBeGreaterThan(hw - 0.1);
      expect(achievedDepth(tp, v90, x, yMid)).toBeLessThan(hw + 0.1);
    }
  });

  it('caps the depth and clears the wide middle flat when the shape is wider than the bit can reach', () => {
    const shape = [rect(0, 0, 40, 20)];        // half-width 10
    const capped = vcarve(shape, params(v90, 4));
    expect(deepestOf(capped)).toBeCloseTo(4, 6);
    expect(achievedDepth(capped, v90, 20, 10)).toBeGreaterThan(3.9);
    const skipped = vcarve(shape, { ...params(v90, 4), wide: 'skip' });
    expect(skipped.cuts.length).toBeLessThan(capped.cuts.length);
  });

  it('never cuts outside the outline, even with a wide clear', () => {
    const tp = vcarve([rect(0, 0, 40, 20)], params(v90, 4));
    for (const [x, y] of [[-0.5, 10], [40.5, 10], [20, -0.5], [20, 20.5], [-0.2, -0.2]]) expect(achievedDepth(tp, v90, x, y)).toBeLessThan(0.1);
  });

  it('letters with holes (a ring) are carved around the ring, leaving the middle alone', () => {
    const tp = vcarve([circle(0, 0, 12), circle(0, 0, 6, 120, true)], params(v90));   // ring 6 mm wide
    expect(achievedDepth(tp, v90, 9, 0)).toBeGreaterThan(2.8);
    expect(achievedDepth(tp, v90, 0, 0)).toBeLessThan(0.02);
    expect(achievedDepth(tp, v90, 14, 0)).toBeLessThan(0.05);
  });

  it('multiple passes step down by the depth per pass, and chains start at the shallow end', () => {
    const tp = vcarve([rect(0, 0, 50, 10)], { ...params(v90, 10), material: { ...material, stepdown: 2 } });
    const zs = [...new Set(tp.cuts.map(c => +c.z.toFixed(2)))].sort((a, b) => b - a);
    expect(zs.length).toBeGreaterThanOrEqual(2);
    const c = tp.cuts[tp.cuts.length - 1];
    expect(Math.abs(c.moves[0].z)).toBeLessThanOrEqual(Math.abs(c.moves[c.moves.length - 1].z) + 1e-6);
  });

  it('a flat-tipped bit carves less deep than a pointed one', () => {
    const pointed = deepestOf(vcarve([rect(0, 0, 50, 6)], params(v90)));
    const flat = deepestOf(vcarve([rect(0, 0, 50, 6)], params({ ...v90, tipDiameter: 1 })));
    expect(flat).toBeCloseTo(pointed - 0.5, 1);
  });

  it('empty input gives an empty toolpath rather than an error', () => {
    expect(vcarve([], params(v90)).cuts).toEqual([]);
  });
});

import { vcarveWithFlat } from '../src/core/vcarve';

/** Deepest a FLAT bit of radius r reaches at (x, y): any path sample within r of the point. */
function flatAchieved(tp: Toolpath, r: number, x: number, y: number): number {
  let best = 0;
  for (const c of tp.cuts) for (let i = 1; i < c.moves.length; i++) {
    const a = c.moves[i - 1], b = c.moves[i], L = Math.hypot(b.x - a.x, b.y - a.y), n = Math.max(1, Math.ceil(L / 0.2));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      if (Math.hypot(x - (a.x + (b.x - a.x) * t), y - (a.y + (b.y - a.y) * t)) <= r) best = Math.max(best, -(a.z + (b.z - a.z) * t));
    }
  }
  return best;
}

describe('V-carve with a flat-bit companion', () => {
  const flat6: Tool = { type: 'flat', diameter: 6 };
  const mat = MATERIALS.softwood;
  const p = (maxDepth: number, tool = v90) => ({ tool, material: mat, maxDepth, direction: 'climb' as const, flat: flat6 });
  const wide = [rect(0, 0, 40, 20)];        // half-width 10: wider than the 90 degree V reaches at 4 mm

  it('a design that fits the V needs no flat bit', () => {
    const r = vcarveWithFlat([rect(0, 0, 50, 6)], p(10));
    expect(r.flat).toBeNull();
    expect(r.v.cuts.length).toBeGreaterThan(0);
  });

  it('wide areas: the flat bit clears the floor at the maximum depth and the V-bit only cuts the walls', () => {
    const r = vcarveWithFlat(wide, p(4));
    expect(r.flat).not.toBeNull();
    expect(r.flat!.tool.type).toBe('flat');
    expect(-Math.min(...r.flat!.cuts.flatMap(c => c.moves.map(m => m.z)))).toBeCloseTo(4, 6);
    // the V-bit does far less than when it clears the floor itself
    const lone = vcarve(wide, { tool: v90, material: mat, maxDepth: 4, direction: 'climb', wide: 'clear' });
    const len = (tp: Toolpath) => tp.cuts.reduce((s, c) => s + c.moves.reduce((a, m, i) => (i ? a + Math.hypot(m.x - c.moves[i - 1].x, m.y - c.moves[i - 1].y) : a), 0), 0);
    expect(len(r.v)).toBeLessThan(len(lone) / 2);
  });

  it('together they make the ideal V: sloped walls to the outline, flat floor at the maximum depth', () => {
    const r = vcarveWithFlat(wide, p(4));
    const combined = (x: number, y: number) => Math.max(achievedDepthOf(r.v, v90, x, y), flatAchieved(r.flat!, 3, x, y));
    // ideal depth = min(distance to the outline / tan(45), 4)
    for (const [x, y, ideal] of [[20, 10, 4], [12, 10, 4], [20, 2, 2], [20, 3, 3], [20, 17, 3], [8, 10, 4], [35, 10, 4]] as const) {
      expect(Math.abs(combined(x, y) - ideal)).toBeLessThan(0.2);
    }
  });

  it('nothing is cut outside the outline', () => {
    const r = vcarveWithFlat(wide, p(4));
    for (const [x, y] of [[-0.5, 10], [40.5, 10], [20, -0.5], [20, 20.5], [-0.3, -0.3]]) {
      expect(Math.max(achievedDepthOf(r.v, v90, x, y), flatAchieved(r.flat!, 3, x, y))).toBeLessThan(0.1);
    }
  });

  it('the flat floor is truly flat: no ridges where the V-bit used to leave them', () => {
    const r = vcarveWithFlat(wide, p(4));
    for (const [x, y] of [[15, 8], [18, 10.7], [22, 9.3], [25, 12], [14, 11.4]]) expect(flatAchieved(r.flat!, 3, x, y)).toBeCloseTo(4, 1);
  });

  it('when the flat bit is too wide for the floor, the V-bit clears it instead and says so: nothing is left uncut', () => {
    // 16 x 12 shape, 90 degree V at 4 mm: floor = 8 x 4, narrower than a 6 mm flat bit
    const shape = [rect(0, 0, 16, 12)];
    const r = vcarveWithFlat(shape, { ...p(4), flat: flat6 });
    expect(r.flat).toBeNull();
    expect(r.warnings.some(w => /cannot help|wider than the floor/.test(w))).toBe(true);
    // the floor is carved to the full depth by the V-bit
    for (const [x, y] of [[8, 6], [6, 6], [10, 5.5]]) expect(achievedDepthOf(r.v, v90, x, y)).toBeGreaterThan(3.6);
  });

  it('a floor the flat bit can only partly reach: the V-bit clears the rest, so the whole floor reaches depth', () => {
    // a big square joined to a narrow neck: the flat bit clears the square, the V-bit the neck's floor
    const shape: Loop[] = [rect(0, 0, 40, 40), rect(40, 14, 30, 12)];          // neck 12 wide: floor 4 wide (90 degrees, 4 mm)
    const r = vcarveWithFlat(shape, p(4));
    expect(r.flat).not.toBeNull();
    expect(r.warnings.some(w => /clears about/.test(w))).toBe(true);
    const combined = (x: number, y: number) => Math.max(achievedDepthOf(r.v, v90, x, y), r.flat ? flatAchieved(r.flat, 3, x, y) : 0);
    expect(combined(20, 20)).toBeGreaterThan(3.8);        // inside the square
    expect(combined(55, 20)).toBeGreaterThan(3.6);        // along the neck, out of the flat bit's reach
    expect(combined(55, 18.5)).toBeGreaterThan(3.6);                  // the floor edge of the neck
    expect(Math.abs(combined(55, 16) - 2)).toBeLessThan(0.2);          // 2 mm from the edge: on the sloped wall, depth 2
    // and still nothing outside
    expect(Math.max(achievedDepthOf(r.v, v90, 55, 12.5), flatAchieved(r.flat!, 3, 55, 12.5))).toBeLessThan(0.1);
  });

  it('a design with both thin strokes and a wide part: thin strokes keep their V-carved skeleton, the wide part gets the companion', () => {
    const shape: Loop[] = [rect(0, 0, 60, 4), rect(60, -8, 20, 20)];       // a thin bar joined to a big square
    const r = vcarveWithFlat(shape, p(4));
    expect(r.flat).not.toBeNull();
    const combined = (x: number, y: number) => Math.max(achievedDepthOf(r.v, v90, x, y), r.flat ? flatAchieved(r.flat, 3, x, y) : 0);
    expect(combined(30, 2)).toBeGreaterThan(1.8);          // the thin bar's axis is cut to its half-width (2 mm)
    expect(combined(70, 2)).toBeGreaterThan(3.8);          // the square's floor
  });
});

/** Same cone simulation as the main V-carve tests, usable on any toolpath. */
function achievedDepthOf(tp: Toolpath, tool: Tool, x: number, y: number): number {
  const tan = Math.tan((((tool.angle ?? 60) * Math.PI) / 360)), tip = (tool.tipDiameter ?? 0) / 2;
  let best = 0;
  for (const c of tp.cuts) for (let i = 1; i < c.moves.length; i++) {
    const a = c.moves[i - 1], b = c.moves[i], L = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z), n = Math.max(1, Math.ceil(L / 0.1));
    for (let k = 0; k <= n; k++) {
      const t = k / n, d = -(a.z + (b.z - a.z) * t) - Math.max(0, Math.hypot(x - (a.x + (b.x - a.x) * t), y - (a.y + (b.y - a.y) * t)) - tip) / tan;
      if (d > best) best = d;
    }
  }
  return best;
}
