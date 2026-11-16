import { describe, it, expect } from 'vitest';
import { profile } from '../src/core/ops';
import { buildMoves } from '../src/core/entry';
import { toGcode, MPCNC_MAKITA } from '../src/core/gcode';
import type { Loop } from '../src/core/types';

const mat = { feed: 800, plungeFeed: 300, stepdown: 2 };
const tool = { type: 'flat' as const, diameter: 6 };
const sq = (s: number): Loop => [{ x: 0, y: 0 }, { x: s, y: 0 }, { x: s, y: s }, { x: 0, y: s }];
const base = { tool, material: mat, depth: 6, direction: 'climb' as const };
/** Distance from a point to the filled square [0,s]^2 (0 if inside) and the signed distance to its edge (negative inside). */
const sd = (x: number, y: number, s: number) => { const dx = Math.max(-x, x - s), dy = Math.max(-y, y - s); return dx > 0 && dy > 0 ? Math.hypot(dx, dy) : Math.max(dx, dy); };

describe('lead-in and lead-out', () => {
  it('outside cut: the first depth arrives along an arc in the waste and does the descent, the last leaves along one', () => {
    const tp = profile([sq(40)], 'outside', { ...base, lead: 6 });
    const first = tp.cuts[0], last = tp.cuts[tp.cuts.length - 1];
    expect(first.moves[0].z).toBeCloseTo(0);
    // every lead point stays at least the bit radius away from the part, so the arc cannot cut into it
    const lead = first.moves.slice(0, 13);
    for (const m of lead) expect(sd(m.x, m.y, 40)).toBeGreaterThanOrEqual(3 - 1e-6);
    // descends smoothly to the depth of the pass over the arc
    expect(lead[lead.length - 1].z).toBeCloseTo(first.z);
    for (let i = 1; i < lead.length; i++) expect(lead[i].z).toBeLessThanOrEqual(lead[i - 1].z + 1e-9);
    // the lead-out leaves at full depth into the waste
    const out = last.moves.slice(-12);
    for (const m of out) { expect(sd(m.x, m.y, 40)).toBeGreaterThanOrEqual(3 - 1e-6); expect(m.z).toBeCloseTo(last.z); }
    // the path itself is the usual one: the middle of the moves are the plain loop at depth
    expect(last.moves.length).toBeGreaterThan(buildMoves(last.loop, last.zStart, last.z, 6, {}).length);
  });
  it('the arcs meet the path tangentially (no corner where the bit joins the wall)', () => {
    const tp = profile([sq(40)], 'outside', { ...base, lead: 6, depth: 2 });
    const mv = tp.cuts[0].moves;
    const dir = (a: typeof mv[0], b: typeof mv[0]) => { const l = Math.hypot(b.x - a.x, b.y - a.y); return { x: (b.x - a.x) / l, y: (b.y - a.y) / l }; };
    const k = 12; // end of the lead-in arc = start of the loop
    const a = dir(mv[k - 1], mv[k]), b = dir(mv[k], mv[k + 1]);
    expect(a.x * b.x + a.y * b.y).toBeGreaterThan(0.99);
  });
  it('conventional puts the arcs on the waste side too', () => {
    const tp = profile([sq(40)], 'outside', { ...base, lead: 6, direction: 'conventional' });
    for (const m of tp.cuts[0].moves.slice(0, 13)) expect(sd(m.x, m.y, 40)).toBeGreaterThanOrEqual(3 - 1e-6);
  });
  it('inside cut: the arcs stay inside the shape, clear of its wall', () => {
    const tp = profile([sq(40)], 'inside', { ...base, lead: 6 });
    for (const m of tp.cuts[0].moves.slice(0, 13)) expect(sd(m.x, m.y, 40)).toBeLessThanOrEqual(-3 + 1e-6);
  });
  it('shrinks the arc where there is little room, and drops it if nothing fits', () => {
    const roomy = profile([sq(40)], 'inside', { ...base, lead: 6 }).cuts[0].moves;
    const small = profile([sq(10)], 'inside', { ...base, lead: 6 }).cuts[0].moves; // 4 mm square of tool path
    const none = profile([sq(6.2)], 'inside', { ...base, lead: 6 });
    const plain = profile([sq(6.2)], 'inside', base);
    expect(roomy.length).toBeGreaterThan(small.length - 1);
    expect(none.cuts[0].moves.length).toBe(plain.cuts[0].moves.length);
  });
  it('without a lead nothing changes, and the G-code starts each pass above the wall', () => {
    const a = profile([sq(40)], 'outside', base), b = profile([sq(40)], 'outside', { ...base, lead: 0 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const g = toGcode([profile([sq(40)], 'outside', { ...base, lead: 6 })], MPCNC_MAKITA);
    expect(g).toMatch(/G1 X.* Y.* Z-/);
  });
  it('middle depths carry no lead and still rapid into the kerf', () => {
    const tp = profile([sq(40)], 'outside', { ...base, lead: 6 });
    expect(tp.cuts.length).toBe(3);
    const mid = tp.cuts[1];
    expect(mid.moves[0].x).toBeCloseTo(mid.moves[mid.moves.length - 1].x);
    expect(mid.moves.length).toBe(buildMoves(mid.loop, mid.zStart, mid.z, 6, {}).length);
  });
});
