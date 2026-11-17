import { describe, it, expect } from 'vitest';
import { pocket, restRegion } from '../src/core/ops';
import { regionArea } from '../src/core/geometry';
import type { Loop } from '../src/core/types';

const mat = { feed: 800, plungeFeed: 300, stepdown: 2 };
const tool = { type: 'flat' as const, diameter: 6 };
const sq = (s: number): Loop => [{ x: 0, y: 0 }, { x: s, y: 0 }, { x: s, y: s }, { x: 0, y: s }];
const base = { tool, material: mat, depth: 6, direction: 'climb' as const, stepoverFraction: 0.4 };
const length = (ms: { x: number; y: number }[]) => ms.slice(1).reduce((s, m, i) => s + Math.hypot(m.x - ms[i].x, m.y - ms[i].y), 0);
const total = (tp: ReturnType<typeof pocket>) => tp.cuts.reduce((s, c) => s + length(c.moves), 0);

describe('pocket lead-in and lead-out', () => {
  it('the wall pass of the first depth arrives along an arc inside the pocket, doing the descent', () => {
    const tp = pocket([sq(40)], { ...base, lead: 6 });
    const first = tp.cuts[0];
    const lead = first.moves.slice(0, 13);
    expect(lead[0].z).toBeCloseTo(0);
    expect(lead[12].z).toBeCloseTo(first.z);
    for (const m of lead) { expect(m.x).toBeGreaterThanOrEqual(3 - 1e-6); expect(m.x).toBeLessThanOrEqual(37 + 1e-6); expect(m.y).toBeGreaterThanOrEqual(3 - 1e-6); expect(m.y).toBeLessThanOrEqual(37 + 1e-6); }
    // it starts away from the wall pass: a real arc, not a point
    expect(Math.hypot(lead[0].x - lead[12].x, lead[0].y - lead[12].y)).toBeGreaterThan(3);
  });
  it('the last depth leaves along an arc at full depth, middle depths and inner rings are plain', () => {
    const lead = pocket([sq(40)], { ...base, lead: 6 }), plain = pocket([sq(40)], base);
    expect(lead.cuts.length).toBe(plain.cuts.length);
    const idx = (tp: typeof lead, z: number) => tp.cuts.map((c, i) => [c, i] as const).filter(([c]) => Math.abs(c.z - z) < 1e-9).map(([, i]) => i);
    const lastZ = lead.cuts[lead.cuts.length - 1].z;
    const wall = idx(lead, lastZ)[0];
    expect(length(lead.cuts[wall].moves)).toBeGreaterThan(length(plain.cuts[wall].moves) + 5);
    expect(lead.cuts[wall].moves.slice(-12).every(m => Math.abs(m.z - lastZ) < 1e-9)).toBe(true);
    const midZ = lead.cuts[Math.floor(lead.cuts.length / 2)].z;
    for (const i of idx(lead, midZ)) expect(length(lead.cuts[i].moves)).toBeCloseTo(length(plain.cuts[i].moves), 6);
    // inner rings (not the first of a depth) never get arcs
    const inner = idx(lead, lastZ).slice(1);
    for (const i of inner) expect(length(lead.cuts[i].moves)).toBeCloseTo(length(plain.cuts[i].moves), 6);
  });
  it('without a lead nothing changes', () => {
    expect(JSON.stringify(pocket([sq(40)], { ...base, lead: 0 }))).toBe(JSON.stringify(pocket([sq(40)], base)));
  });
  it('a pocket with no room for an arc is left plain', () => {
    const a = pocket([sq(6.4)], { ...base, lead: 6 }), b = pocket([sq(6.4)], base);
    expect(length(a.cuts[0].moves)).toBeCloseTo(length(b.cuts[0].moves), 6);
  });
});

describe('rest machining of pockets', () => {
  it('finds only the corners a bigger bit cannot reach', () => {
    const left = restRegion([sq(40)], 12, 3.5);
    expect(left.length).toBe(4);
    for (const l of left) { const c = l.reduce((s, p) => ({ x: s.x + p.x / l.length, y: s.y + p.y / l.length }), { x: 0, y: 0 }); expect(Math.min(c.x, 40 - c.x)).toBeLessThan(8); expect(Math.min(c.y, 40 - c.y)).toBeLessThan(8); }
    expect(regionArea(left)).toBeLessThan(regionArea([sq(40)]) / 4);
  });
  it('cuts far less than the whole pocket yet still reaches into the corners', () => {
    const full = pocket([sq(40)], base), rest = pocket([sq(40)], { ...base, rest: 12 });
    expect(rest.cuts.length).toBeGreaterThan(0);
    expect(total(rest)).toBeLessThan(total(full) / 2);
    const pts = rest.cuts.flatMap(c => c.moves);
    for (const [cx, cy] of [[3, 3], [37, 3], [37, 37], [3, 37]]) expect(Math.min(...pts.map(m => Math.hypot(m.x - cx, m.y - cy)))).toBeLessThan(0.05);
    // the bit never leaves the pocket
    for (const m of pts) { expect(m.x).toBeGreaterThanOrEqual(3 - 1e-6); expect(m.x).toBeLessThanOrEqual(37 + 1e-6); expect(m.y).toBeGreaterThanOrEqual(3 - 1e-6); expect(m.y).toBeLessThanOrEqual(37 + 1e-6); }
  });
  it('a pocket narrower than the big bit is all left over; a big bit that is not bigger changes nothing', () => {
    const narrow: Loop = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 8 }, { x: 0, y: 8 }];
    expect(total(pocket([narrow], { ...base, rest: 12 }))).toBeCloseTo(total(pocket([narrow], base)), 3);
    expect(JSON.stringify(pocket([sq(40)], { ...base, rest: 6 }))).toBe(JSON.stringify(pocket([sq(40)], base)));
  });
  it('a pocket the big bit clears completely leaves nothing (a circle)', () => {
    const circle: Loop = Array.from({ length: 96 }, (_, i) => ({ x: 20 + 20 * Math.cos((2 * Math.PI * i) / 96), y: 20 + 20 * Math.sin((2 * Math.PI * i) / 96) }));
    expect(pocket([circle], { ...base, rest: 12 }).cuts.length).toBe(0);
  });
});
