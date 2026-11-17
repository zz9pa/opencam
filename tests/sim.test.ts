import { describe, it, expect } from 'vitest';
import { createGrid, cutSegment, heightAt, simulateToolpath, autoStock, simSummary } from '../src/core/sim';
import type { Toolpath, Pt3 } from '../src/core/types';

const stock = { x0: 0, y0: 0, w: 100, h: 100, t: 10 };
const flat6 = { type: 'flat' as const, diameter: 6 };
const tp = (moves: Pt3[], tool = flat6): Toolpath => ({ name: 't', tool, feed: 1000, plungeFeed: 300, cuts: [{ loop: [], z: -3, zStart: 0, closed: false, moves }] });
const run = (g: ReturnType<typeof createGrid>, t: Toolpath) => { for (const _ of simulateToolpath(g, t)); };

describe('material removal simulation', () => {
  it('a flat bit cuts a slot of its own width at the right depth', () => {
    const g = createGrid(stock, 0.25);
    cutSegment(g, flat6, { x: 20, y: 50, z: -3 }, { x: 80, y: 50, z: -3 });
    expect(heightAt(g, 50, 50)).toBeCloseTo(-3, 3);
    expect(heightAt(g, 50, 52.5)).toBeCloseTo(-3, 3);
    expect(heightAt(g, 50, 54)).toBe(0); // 4 mm from the centre: outside a 6 mm bit
    expect(heightAt(g, 10, 50)).toBe(0);
  });
  it('a ball nose leaves a round-bottomed groove', () => {
    const g = createGrid(stock, 0.2);
    cutSegment(g, { type: 'ball', diameter: 6 }, { x: 20, y: 50, z: -3 }, { x: 80, y: 50, z: -3 });
    expect(heightAt(g, 50, 50)).toBeCloseTo(-3, 2);
    expect(heightAt(g, 50, 52)).toBeCloseTo(-3 + (3 - Math.sqrt(9 - 4)), 1); // 2 mm out from the centre
  });
  it('a V-bit is deeper in the middle than at the sides', () => {
    const g = createGrid(stock, 0.2);
    cutSegment(g, { type: 'vbit', diameter: 10, angle: 90, tipDiameter: 0 }, { x: 20, y: 50, z: -2 }, { x: 80, y: 50, z: -2 });
    expect(heightAt(g, 50, 50)).toBeCloseTo(-2, 2);
    expect(heightAt(g, 50, 51)).toBeCloseTo(-1, 1); // 90 degree V: 1 mm out is 1 mm up
  });
  it('never cuts below the bottom of the stock, and reports it', () => {
    const g = createGrid(stock, 0.5);
    run(g, tp([{ x: 50, y: 50, z: -12 }]));
    expect(heightAt(g, 50, 50)).toBeCloseTo(-10, 3);
    expect(simSummary(g).join(' ')).toMatch(/below the bottom/);
  });
  it('flags fast moves that go down into uncut stock, but not ones through a cut hole', () => {
    const g = createGrid(stock, 0.5);
    run(g, tp([{ x: 50, y: 50, z: -6, rapid: true }]));
    expect(g.warnings.crashes.length).toBe(1);
    const g2 = createGrid(stock, 0.5);
    run(g2, tp([{ x: 50, y: 50, z: -6 }, { x: 50, y: 50, z: -4, rapid: true }]));
    expect(g2.warnings.crashes.length).toBe(0);
  });
  it('a plunge from the first move is cut (starts 1 mm above the top)', () => {
    const g = createGrid(stock, 0.5);
    run(g, tp([{ x: 50, y: 50, z: -4 }]));
    expect(heightAt(g, 50, 50)).toBeCloseTo(-4, 3);
  });
  it('auto stock wraps the cuts with a margin and is as thick as the deepest cut', () => {
    const s = autoStock([tp([{ x: 10, y: 20, z: -2 }, { x: 40, y: 60, z: -7 }])], 5);
    expect(s.x0).toBeCloseTo(10 - 3 - 5); expect(s.w).toBeCloseTo(30 + 6 + 10);
    expect(s.t).toBeCloseTo(7);
  });
});

describe('the simulation checks the G-code entry drops', () => {
  it('flags a planned fast drop into material that was not really cleared', () => {
    const g = createGrid(stock, 0.5);
    const t = tp([{ x: 50, y: 50, z: -6 }]);
    run(g, { ...t, cuts: [{ ...t.cuts[0], moves: [{ x: 50, y: 50, z: -6 }] }] });
    const c2 = { loop: [], z: -9, zStart: -6, closed: false, moves: [{ x: 50, y: 50, z: -6 }, { x: 50, y: 50, z: -9 }] };
    const g2 = createGrid(stock, 0.5);
    for (const _ of simulateToolpath(g2, { ...t, cuts: [c2] }, 2000, new Map([[c2, -2]]))) void _; // claims -2 is clear; nothing was cut yet
    expect(g2.warnings.crashes.length).toBe(1);
  });
  it('a detail window of a bigger job matches the same area of the whole run, and the cap allows large stock', () => {
    const slot = tp([{ x: 10, y: 50, z: -3 }, { x: 90, y: 50, z: -3 }]);
    const whole = createGrid(stock, 0.25), win = createGrid({ x0: 40, y0: 40, w: 20, h: 20, t: 10 }, 0.25);
    run(whole, slot); run(win, slot);
    for (const [x, y] of [[50, 50], [45, 52], [55, 54.5], [41, 41], [59, 59]]) expect(heightAt(win, x, y)).toBeCloseTo(heightAt(whole, x, y), 6);
    // a guitar-sized stock keeps cells under 0.7 mm now
    expect(createGrid({ x0: 0, y0: 0, w: 906, h: 1470, t: 40 }, 0.5).cell).toBeLessThan(0.7);
  });
});
