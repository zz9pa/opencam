import { describe, it, expect } from 'vitest';
import { parseStl, orient, heightMap, DEFAULT_ORIENT, EMPTY, StlError, type Mesh } from '../src/core/mesh';
import { rough3d, finish3d, simplify3 } from '../src/core/mill3d';
import type { Tool, Material, Pt3 } from '../src/core/types';

/** A height field z = f(x, y) over [x0,x1] x [y0,y1] as a triangle mesh (top surface only). */
function field(f: (x: number, y: number) => number, x0: number, x1: number, y0: number, y1: number, step: number): Mesh {
  const t: number[] = [];
  const tri = (a: number[], b: number[], c: number[]) => t.push(...a, ...b, ...c);
  const P = (x: number, y: number) => [x, y, f(x, y)];
  for (let x = x0; x < x1 - 1e-9; x += step) for (let y = y0; y < y1 - 1e-9; y += step) {
    tri(P(x, y), P(x + step, y), P(x + step, y + step));
    tri(P(x, y), P(x + step, y + step), P(x, y + step));
  }
  return { tri: Float32Array.from(t) };
}
const Rs = 20;
const dome = (x: number, y: number) => Math.sqrt(Math.max(0, Rs * Rs - x * x - y * y)) - Rs;
const domeModel = () => orient(field(dome, -20, 20, -20, 20, 0.5), DEFAULT_ORIENT);
const mat: Material = { feed: 1000, plungeFeed: 300, stepdown: 2 };
const ball3: Tool = { type: 'ball', diameter: 6 };
const flat6: Tool = { type: 'flat', diameter: 6 };

describe('STL reading', () => {
  it('reads a binary STL', () => {
    const buf = new ArrayBuffer(84 + 50);
    const dv = new DataView(buf);
    dv.setUint32(80, 1, true);
    [0, 0, 0, 10, 0, 0, 0, 10, 5].forEach((v, k) => dv.setFloat32(84 + 12 + k * 4, v, true));
    const m = parseStl(buf);
    expect(m.tri.length).toBe(9);
    expect(m.tri[7]).toBe(10);
  });
  it('reads an ASCII STL', () => {
    const txt = 'solid x\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 4 0 0\nvertex 0 4 2\nendloop\nendfacet\nendsolid x\n';
    const m = parseStl(new TextEncoder().encode(txt).buffer.slice(0) as ArrayBuffer);
    expect(Array.from(m.tri)).toEqual([0, 0, 0, 4, 0, 0, 0, 4, 2]);
  });
  it('refuses anything else with a plain message', () => {
    const junk = new TextEncoder().encode('hello this is not a model file at all, it is just text that is long enough to pass the size check.....').buffer as ArrayBuffer;
    expect(() => parseStl(junk)).toThrow(StlError);
    expect(() => parseStl(new ArrayBuffer(10))).toThrow(StlError);
  });
});

describe('orientation', () => {
  const box: Mesh = { tri: Float32Array.from([0, 0, 0, 10, 0, 0, 0, 20, 30]) };
  it('puts the lower-left corner at 0,0 and the highest point at Z=0', () => {
    const o = orient({ tri: Float32Array.from([5, 5, 5, 15, 5, 5, 5, 25, 35]) }, DEFAULT_ORIENT);
    expect(o.w).toBe(10); expect(o.d).toBe(20); expect(o.h).toBe(30);
    expect(Math.max(...[2, 5, 8].map(i => o.tri[i]))).toBe(0);
    expect(Math.min(o.tri[0], o.tri[3], o.tri[6])).toBe(0);
  });
  it('turns a chosen side up without mirroring', () => {
    const o = orient(box, { ...DEFAULT_ORIENT, up: '+y' }); // the Y axis becomes height
    expect(o.h).toBeCloseTo(20); expect(o.d).toBeCloseTo(30);
    const s = orient(box, { ...DEFAULT_ORIENT, scale: 25.4 });
    expect(s.w).toBeCloseTo(254);
    const sp = orient(box, { ...DEFAULT_ORIENT, spin: 90 });
    expect(sp.w).toBeCloseTo(20); expect(sp.d).toBeCloseTo(10);
  });
});

describe('height map', () => {
  it('samples the top surface', () => {
    const m = orient(field((x, y) => 0.5 * x, 0, 10, 0, 10, 1), DEFAULT_ORIENT); // slope up in X
    const hm = heightMap(m, 0.5);
    const at = (x: number, y: number) => hm.z[Math.floor(y / hm.cell) * hm.nx + Math.floor(x / hm.cell)];
    expect(at(8, 5) - at(2, 5)).toBeCloseTo(3, 0);
    expect(at(9.8, 5)).toBeLessThanOrEqual(0.01);
  });
  it('marks cells with no model as empty', () => {
    const hm = heightMap(orient({ tri: Float32Array.from([0, 0, 0, 10, 0, 0, 0, 10, 0]) }, DEFAULT_ORIENT), 1);
    expect(hm.z[hm.nx * (hm.ny - 1) + hm.nx - 1]).toBe(EMPTY);
  });
});

/** True if the bit, sitting at p, would dig into the model anywhere. Worst penetration in mm (positive = gouge). */
function gouge(p: Pt3, tool: Tool, f: (x: number, y: number) => number, at = { x: 0, y: 0 }, ox = 20, oy = 20): number {
  const R = tool.diameter / 2;
  let worst = -Infinity;
  for (let dx = -R; dx <= R; dx += 0.25) for (let dy = -R; dy <= R; dy += 0.25) {
    const d = Math.hypot(dx, dy);
    if (d > R) continue;
    const mx = p.x - at.x - ox + dx, my = p.y - at.y - oy + dy; // model frame (the dome is centred on 0,0)
    if (Math.hypot(mx, my) > 17) continue; // the rim is a vertical cliff: sampling noise there says nothing
    const bottom = p.z + (tool.type === 'ball' ? R - Math.sqrt(R * R - d * d) : 0);
    worst = Math.max(worst, f(mx, my) - bottom);
  }
  return worst;
}
const sample = (moves: Pt3[], every = 1.5): Pt3[] => {
  const out: Pt3[] = [];
  for (let k = 1; k < moves.length; k++) {
    const a = moves[k - 1], b = moves[k];
    if (b.rapid) continue;
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / every));
    for (let s = 0; s <= n; s++) out.push({ x: a.x + (b.x - a.x) * s / n, y: a.y + (b.y - a.y) * s / n, z: a.z + (b.z - a.z) * s / n });
  }
  return out;
};
const common = { material: mat, stepover: 1, direction: 'climb' as const, zigzag: false, top: 0, at: { x: 0, y: 0 } };

describe('3D finishing', () => {
  const r = finish3d(domeModel(), { ...common, tool: ball3 });
  it('follows the exact offset of the surface', () => {
    // ball centre lies on a sphere of radius Rs + r; the tip is r below the centre
    const moves = r.toolpath.cuts.map(c => c.moves).flat().filter(m => Math.hypot(m.x - 20, m.y - 20) < 14);
    expect(moves.length).toBeGreaterThan(50);
    let worst = 0;
    for (const m of moves) { const rho = Math.hypot(m.x - 20, m.y - 20); worst = Math.max(worst, Math.abs(m.z - (Math.sqrt(23 * 23 - rho * rho) - 23))); }
    expect(worst).toBeLessThan(0.1);
  });
  it('never digs into the model', () => {
    let worst = -Infinity;
    for (const c of r.toolpath.cuts) for (const p of sample(c.moves, 2)) worst = Math.max(worst, gouge(p, ball3, dome));
    expect(worst).toBeLessThan(0.08);
  });
  it('touches the surface (does not float above it)', () => {
    let close = 0, n = 0;
    for (const c of r.toolpath.cuts) for (const p of sample(c.moves, 3)) { n++; if (gouge(p, ball3, dome) > -0.2) close++; }
    expect(close / n).toBeGreaterThan(0.6);
  });
  it('keeps the point count modest and every pass runs the same way for climb', () => {
    const pts = r.toolpath.cuts.reduce((s, c) => s + c.moves.length, 0);
    expect(pts).toBeLessThan(15000);
    for (const c of r.toolpath.cuts) expect(c.moves[c.moves.length - 1].x).toBeLessThan(c.moves[0].x); // climb: right to left, rows stepping +Y (material on the right)
  });
  it('conventional runs the other way, and zigzag chains the passes', () => {
    const cv = finish3d(domeModel(), { ...common, tool: ball3, direction: 'conventional' });
    for (const c of cv.toolpath.cuts) expect(c.moves[c.moves.length - 1].x).toBeGreaterThan(c.moves[0].x);
    const zz = finish3d(domeModel(), { ...common, tool: ball3, zigzag: true });
    expect(zz.toolpath.cuts.length).toBeLessThan(r.toolpath.cuts.length / 3);
    let worst = -Infinity;
    for (const c of zz.toolpath.cuts) for (const p of sample(c.moves, 2)) worst = Math.max(worst, gouge(p, ball3, dome));
    expect(worst).toBeLessThan(0.08);
  });
  it('warns about detail the bit cannot reach, and stays quiet on a smooth surface', () => {
    const smooth = orient(field((x, y) => 3 * Math.sin(x / 8), 0, 30, 0, 30, 0.5), DEFAULT_ORIENT);
    expect(finish3d(smooth, { ...common, tool: ball3 }).warnings.join(' ')).not.toMatch(/cannot be reached/);
    const slot = orient(field((x, y) => (Math.abs(x - 15) < 0.75 ? -6 : 0), 0, 30, 0, 30, 0.25), DEFAULT_ORIENT); // a 1.5 mm wide, 6 mm deep slot
    const w = finish3d(slot, { ...common, tool: ball3 });
    expect(w.warnings.join(' ')).toMatch(/cannot be reached/);
  });
  it('warns when the bit is too coarse for the surface', () => {
    const big = finish3d(domeModel(), { ...common, tool: { type: 'ball', diameter: 6 }, stepover: 3 });
    expect(big.warnings.join(' ')).toMatch(/Ridges/);
  });
});

describe('3D roughing', () => {
  const r = rough3d(domeModel(), { ...common, tool: flat6, stepdown: 4, leave: 0.5 });
  it('works in flat levels no deeper than the stepdown and ends at the deepest point', () => {
    const zs = [...new Set(r.toolpath.cuts.map(c => +c.z.toFixed(3)))].sort((a, b) => b - a);
    expect(zs[0]).toBeCloseTo(-4);
    for (let k = 1; k < zs.length; k++) expect(zs[k - 1] - zs[k]).toBeLessThanOrEqual(4 + 1e-6);
    expect(zs[zs.length - 1]).toBeLessThanOrEqual(-19);
    expect(zs[zs.length - 1]).toBeGreaterThan(-21);
  });
  it('never digs into the model and leaves the requested stock', () => {
    let worst = -Infinity, minGap = Infinity;
    for (const c of r.toolpath.cuts) for (const p of sample(c.moves, 2)) {
      worst = Math.max(worst, gouge(p, flat6, dome));
      minGap = Math.min(minGap, -gouge(p, flat6, dome));
    }
    expect(worst).toBeLessThan(0.0);
    expect(minGap).toBeGreaterThan(0.2); // 0.5 mm left, less quantisation
  });
  it('drops in at the previous level, not from the top', () => {
    const deep = r.toolpath.cuts.find(c => c.z < -8)!;
    expect(deep.moves[0].rapid).toBe(true);
    expect(deep.moves[0].z).toBeLessThanOrEqual(deep.zStart + 1 + 1e-9);
    expect(deep.moves[0].z).toBeLessThan(0);
  });
  it('can chain passes into one path', () => {
    const zz = rough3d(domeModel(), { ...common, tool: flat6, stepdown: 4, leave: 0.5, zigzag: true });
    expect(zz.toolpath.cuts.length).toBeLessThan(r.toolpath.cuts.length * 0.85);
    let worst = -Infinity;
    for (const c of zz.toolpath.cuts) for (const p of sample(c.moves, 2)) worst = Math.max(worst, gouge(p, flat6, dome));
    expect(worst).toBeLessThan(0.0);
  });
  it('reports nothing to do for a flat-topped model', () => {
    const flat = orient(field(() => 0, 0, 10, 0, 10, 1), DEFAULT_ORIENT);
    const n = rough3d(flat, { ...common, tool: flat6, stepdown: 2, leave: 0 });
    expect(n.toolpath.cuts.length).toBe(0);
  });
});

describe('3D path helpers', () => {
  it('simplify3 drops points on a straight line but keeps the bend', () => {
    const pts: Pt3[] = [0, 1, 2, 3, 4].map(x => ({ x, y: 0, z: -x * 0.5 })).concat([5, 6].map(x => ({ x, y: 0, z: -2 + (x - 4) * 3 })));
    const s = simplify3(pts, 0.01);
    expect(s.length).toBe(3);
  });
});

import { turnOver, heightMap as hmap, type Oriented as Ori } from '../src/core/mesh';

describe('turnOver (side 2 of a two-sided 3D job)', () => {
  // A 10 x 10 x 4 block with a 2 mm bump on top at the low-X half (z is 0 = top; bump is the top).
  const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): number[] => {
    const q = (a: number[], b: number[], c: number[], d: number[]) => [...a, ...b, ...c, ...a, ...c, ...d];
    return [
      ...q([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]),
      ...q([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]),
    ];
  };
  // Underside (z=-4) is flat; top has a high half (z=0) at x<5 and a low half (z=-2) at x>=5.
  const m: Ori = { tri: new Float32Array([...box(0, 5, 0, 10, -4, 0), ...box(5, 10, 0, 10, -4, -2)]), w: 10, d: 10, h: 4 };

  it('flips Y about the axis and puts the old underside on top', () => {
    const r = turnOver(m, { x: 0, y: 0, top: 0 }, { x: 5, y: 5 }, 'tb', 4);
    expect(r.x).toBeCloseTo(0); expect(r.y).toBeCloseTo(0);
    // the underside is flat at the bottom of a 4 mm stock, so it is now the top surface: 0 below the stock top
    expect(r.top).toBeCloseTo(0);
    expect(r.model.h).toBeCloseTo(4);
  });
  it('a model thinner than the stock leaves waste above its underside', () => {
    const r = turnOver(m, { x: 0, y: 0, top: 0 }, { x: 5, y: 5 }, 'tb', 10);
    expect(r.top).toBeCloseTo(6); // underside is 4 deep, stock 10 thick: 6 mm of stock above it after the flip
  });
  it('left-to-right flips X: the deep underside moves to the other side', () => {
    // underside is at z=-4 for x<5 and at z=-3 for x>5
    const m2: Ori = { tri: new Float32Array([...box(0, 5, 0, 10, -4, 0), ...box(5, 10, 0, 10, -3, 0)]), w: 10, d: 10, h: 4 };
    const r = turnOver(m2, { x: 0, y: 0, top: 0 }, { x: 5, y: 5 }, 'lr', 4);
    const hm = hmap(r.model, 0.5);
    const at = (x: number) => hm.z[Math.floor(2 / 0.5) * hm.nx + Math.floor(x / 0.5)];
    expect(at(1)).toBeCloseTo(-1, 3); // was the x>5 side: its underside is 1 mm above the stock bottom
    expect(at(9)).toBeCloseTo(0, 3);  // was the x<5 side: underside on the bottom of the stock, so top of side 2
  });
  it('a model placed lower on side 1 is deeper on side 2 by the same amount', () => {
    const a = turnOver(m, { x: 0, y: 0, top: 0 }, { x: 5, y: 5 }, 'tb', 10);
    const b = turnOver(m, { x: 0, y: 0, top: 3 }, { x: 5, y: 5 }, 'tb', 10);
    expect(b.top - a.top).toBeCloseTo(-3); // sunk 3 mm on side 1 means 3 mm closer to the new top
  });
});

import { clipToolpath } from '../src/core/split';

describe('3D passes in a split job', () => {
  it('clipping a 3D toolpath into overlapping windows keeps every cut, with Z unchanged', () => {
    const r = finish3d(domeModel(), { tool: ball3, material: mat, direction: 'climb', zigzag: false, top: 0, at: { x: 0, y: 0 }, stepover: 2 });
    const pts = r.toolpath.cuts.flatMap(c => c.moves);
    const a = clipToolpath(r.toolpath, 0, 25).cuts.flatMap(c => c.moves);
    const b = clipToolpath(r.toolpath, 20, 40).cuts.flatMap(c => c.moves);
    expect(a.length + b.length).toBeGreaterThanOrEqual(pts.length);
    for (const m of [...a, ...b]) expect(m.x).toBeGreaterThanOrEqual(-1e-6);
    // every original point lies in one of the windows, at the same height
    for (const p of pts.filter((_, i) => i % 50 === 0)) {
      expect([...a, ...b].some(q => Math.abs(q.x - p.x) < 1e-6 && Math.abs(q.y - p.y) < 1e-6 && Math.abs(q.z - p.z) < 1e-6)).toBe(true);
    }
  });
});

describe('finishing in both directions', () => {
  // a ridge along X: a steep wall that runs parallel to the X passes
  const wall = () => orient(field((x, y) => (y > 0 ? 0 : -8), -10, 10, -10, 10, 0.5), DEFAULT_ORIENT);
  const run = (cross: boolean) => finish3d(wall(), { tool: ball3, material: mat, direction: 'climb', zigzag: false, top: 0, at: { x: 0, y: 0 }, stepover: 1, cross });
  it('adds a second set of passes that run along Y', () => {
    const one = run(false), two = run(true);
    const alongY = (tp: typeof one.toolpath) => tp.cuts.filter(c => { const xs = c.moves.map(m => m.x), ys = c.moves.map(m => m.y); return Math.max(...ys) - Math.min(...ys) > 5 * (Math.max(...xs) - Math.min(...xs) + 0.01); }).length;
    expect(alongY(one.toolpath)).toBe(0);
    expect(alongY(two.toolpath)).toBeGreaterThan(5);
    expect(two.toolpath.cuts.length).toBeGreaterThan(one.toolpath.cuts.length);
  });
  it('the Y passes sit at the same heights over the same points', () => {
    const two = run(true);
    const pts = two.toolpath.cuts.flatMap(c => c.moves);
    for (const q of pts) expect(q.z).toBeLessThanOrEqual(0.0001);
    // wall edge: low side of the wall (y<=0) is cut deep, high side shallow, in both sets
    expect(pts.some(q => q.y < 7 && q.z < -7)).toBe(true);
  });
  it('climb stays climb: the Y passes run towards -Y while stepping +X', () => {
    const two = run(true);
    const ycuts = two.toolpath.cuts.filter(c => { const xs = c.moves.map(m => m.x), ys = c.moves.map(m => m.y); return Math.max(...ys) - Math.min(...ys) > 5 * (Math.max(...xs) - Math.min(...xs) + 0.01); });
    const first = ycuts[0].moves, last = ycuts[ycuts.length - 1].moves;
    expect(first[first.length - 1].y).toBeLessThan(first[0].y);
    expect(last[0].x).toBeGreaterThan(first[0].x);
  });
});

describe('rest roughing', () => {
  // a walled pit 10 x 10 (floor 6 deep) with a 3 x 3 slot sunk 6 mm further into the middle of the floor
  const pit = () => orient(field((x, y) => (Math.abs(x) > 5 || Math.abs(y) > 5 ? 0 : Math.abs(x) < 1.5 && Math.abs(y) < 1.5 ? -12 : -6), -10, 10, -10, 10, 0.5), DEFAULT_ORIENT);
  const small: Tool = { type: 'flat', diameter: 2 };
  const base = { tool: small, material: mat, direction: 'climb' as const, zigzag: false, top: 0, at: { x: 0, y: 0 }, stepover: 1, stepdown: 2, leave: 0 };
  it('only cuts where the bigger bit stayed above the level', () => {
    const full = rough3d(pit(), base), rest = rough3d(pit(), { ...base, rest: 4 });
    const n = (r: typeof full) => r.toolpath.cuts.reduce((s, c) => s + c.moves.reduce((q, m, i) => q + (i && !m.rapid ? Math.hypot(m.x - c.moves[i - 1].x, m.y - c.moves[i - 1].y) : 0), 0), 0);
    expect(n(rest)).toBeGreaterThan(0);
    expect(n(rest)).toBeLessThan(n(full) * 0.6);
    // the slot (deeper than the floor the big bit can reach) is still cut in full, and so is the corner the big bit rounds off
    expect(Math.min(...rest.toolpath.cuts.flatMap(c => c.moves.map(m => m.z)))).toBeLessThan(-11.5);
    expect(rest.toolpath.cuts.some(c => c.moves.some(m => Math.hypot(m.x - 5.2, m.y - 5.2) < 2 && m.z < -5.9))).toBe(true);
  });
  it('an earlier bit that is not bigger is ignored, with a warning', () => {
    const r = rough3d(pit(), { ...base, rest: 2 });
    expect(r.warnings.join(' ')).toMatch(/nothing to rest/);
    expect(r.toolpath.cuts.length).toBe(rough3d(pit(), base).toolpath.cuts.length);
  });
});

import { contours } from '../src/core/mill3d';
describe('steep walls as contours', () => {
  // flat at 0 for x > 11, a 1 mm wide ramp (slope 8 = 83 degrees) down to -8 for x < 10
  const cliff = () => orient(field((x, y) => (x > 1 ? 0 : x < 0 ? -8 : -8 + 8 * x), -10, 20, -10, 10, 0.25), DEFAULT_ORIENT);
  const run = (steep: number, dir: 'climb' | 'conventional' = 'climb') => finish3d(cliff(), { tool: ball3, material: mat, direction: dir, zigzag: false, top: 0, at: { x: 0, y: 0 }, stepover: 1, steep });
  it('level contour passes follow the wall; the raster leaves the wall alone', () => {
    const off = run(0), on = run(45);
    const level = (tp: typeof on.toolpath) => tp.cuts.filter(c => c.moves.length >= 2 && c.moves.every(m => Math.abs(m.z - c.moves[0].z) < 1e-6) && Math.max(...c.moves.map(m => m.y)) - Math.min(...c.moves.map(m => m.y)) > 10);
    expect(level(off.toolpath).length).toBe(0);
    const lv = level(on.toolpath);
    expect(lv.length).toBeGreaterThan(4);
    // they run up the wall: x stays within the ramp (plus the ball radius), and the levels differ
    for (const c of lv) for (const m of c.moves) expect(m.x).toBeGreaterThan(6.5);
    expect(new Set(lv.map(c => +c.moves[0].z.toFixed(3))).size).toBeGreaterThan(4);
  });
  it('climb keeps the wall (the high ground) on the right of travel; conventional on the left', () => {
    const dirY = (tp: ReturnType<typeof run>['toolpath']) => { const c = tp.cuts.find(q => q.moves.length >= 2 && q.moves.every(m => Math.abs(m.z - q.moves[0].z) < 1e-6) && Math.abs(q.moves[q.moves.length - 1].y - q.moves[0].y) > 10)!; return c.moves[c.moves.length - 1].y - c.moves[0].y; };
    // the high ground is at +X; heading +Y has +X on its right
    expect(dirY(run(45, 'climb').toolpath)).toBeGreaterThan(0);
    expect(dirY(run(45, 'conventional').toolpath)).toBeLessThan(0);
  });
  it('no steep area means no contours (a gentle dome with a 70 degree limit)', () => {
    const r = finish3d(domeModel(), { tool: ball3, material: mat, direction: 'climb', zigzag: false, top: 0, at: { x: 0, y: 0 }, stepover: 2, steep: 80 });
    const plain = finish3d(domeModel(), { tool: ball3, material: mat, direction: 'climb', zigzag: false, top: 0, at: { x: 0, y: 0 }, stepover: 2 });
    expect(r.toolpath.cuts.length).toBeGreaterThanOrEqual(plain.toolpath.cuts.length - 2);
  });
  it('contours of a cone are circles', () => {
    const cone = orient(field((x, y) => -Math.hypot(x, y), -10, 10, -10, 10, 0.25), DEFAULT_ORIENT);
    const hm = heightMap(cone, 0.25);
    const S = new Float32Array(hm.z);
    const sq = Int32Array.from({ length: (hm.nx - 1) * (hm.ny - 1) }, (_, q) => Math.floor(q / (hm.nx - 1)) * hm.nx + (q % (hm.nx - 1)));
    const lines = contours(hm, S, sq, -5, true, { x: 0, y: 0 });
    expect(lines.length).toBe(1);
    const c = lines[0];
    expect(Math.hypot(c[0].x - c[c.length - 1].x, c[0].y - c[c.length - 1].y)).toBeLessThan(1e-6);
    const cx = hm.nx * hm.cell / 2, cy = hm.ny * hm.cell / 2;
    const radii = c.map(q => Math.hypot(q.x - cx, q.y - cy));
    expect(Math.max(...radii) - Math.min(...radii)).toBeLessThan(0.3);
    // higher ground (the apex) is to the right of travel: a clockwise loop seen from above
    let a = 0; for (let i = 0; i + 1 < c.length; i++) a += c[i].x * c[i + 1].y - c[i + 1].x * c[i].y;
    expect(a).toBeLessThan(0);
  });
});
