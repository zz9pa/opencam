/**
 * Material removal simulation on a height grid.
 *
 * The stock starts as a flat block with its top at Z=0. Every cutting move sweeps the bit's shape through it and lowers the
 * surface wherever the bit reaches. This is the same top-down model the 3D carving uses, so it shows exactly what a router
 * cutting from above can make (undercuts are not possible from above anyway).
 */
import type { Cut, Pt3, Tool, Toolpath } from './types';

export interface Stock { x0: number; y0: number; w: number; h: number; t: number }
export interface SimGrid { stock: Stock; nx: number; ny: number; cell: number; z: Float32Array; warnings: SimWarnings }
export interface SimWarnings {
  /** fast (G0) moves that go down into uncut material */
  crashes: { x: number; y: number; z: number }[];
  /** deepest the bit went below the bottom of the stock (into the spoilboard), mm */
  belowBottom: number;
  /** cutting outside the stock area */
  outside: number;
}

export const SIM_MAX_CELLS = 4_000_000;

export function createGrid(stock: Stock, cell: number): SimGrid {
  let c = Math.max(cell, 0.05);
  while ((stock.w / c) * (stock.h / c) > SIM_MAX_CELLS) c *= 1.15;
  const nx = Math.max(1, Math.ceil(stock.w / c)), ny = Math.max(1, Math.ceil(stock.h / c));
  return { stock, nx, ny, cell: c, z: new Float32Array(nx * ny), warnings: { crashes: [], belowBottom: 0, outside: 0 } };
}

interface Kernel { di: Int32Array; dj: Int32Array; prof: Float32Array; rc: number }
const kernels = new Map<string, Kernel>();

/** Offsets and heights of the bit's shape above its tip, for each grid cell under the bit. */
function kernelFor(tool: Tool, cell: number): Kernel {
  const key = `${tool.type}|${tool.diameter}|${tool.angle ?? ''}|${tool.tipDiameter ?? ''}|${cell}`;
  const hit = kernels.get(key);
  if (hit) return hit;
  const R = tool.diameter / 2, rc = Math.ceil(R / cell);
  const half = tool.type === 'vbit' ? Math.tan(((tool.angle ?? 60) / 2) * Math.PI / 180) : 1;
  const tipR = (tool.tipDiameter ?? 0) / 2;
  const di: number[] = [], dj: number[] = [], pr: number[] = [];
  for (let b = -rc; b <= rc; b++) for (let a = -rc; a <= rc; a++) {
    const d = Math.hypot(a, b) * cell;
    if (d > R + cell * 0.35) continue; // include cells whose centre is just outside, so thin bits still touch a cell
    const dd = Math.min(d, R);
    let p = 0;
    if (tool.type === 'ball') p = R - Math.sqrt(Math.max(0, R * R - dd * dd));
    else if (tool.type === 'vbit') p = Math.max(0, dd - tipR) / half;
    di.push(a); dj.push(b); pr.push(p);
  }
  const k = { di: Int32Array.from(di), dj: Int32Array.from(dj), prof: Float32Array.from(pr), rc };
  kernels.set(key, k);
  return k;
}

function stamp(g: SimGrid, k: Kernel, x: number, y: number, z: number) {
  const { nx, ny, cell, z: H, stock } = g;
  const ci = Math.floor((x - stock.x0) / cell), cj = Math.floor((y - stock.y0) / cell);
  const floor = -stock.t;
  if (z < floor - 1e-6) g.warnings.belowBottom = Math.max(g.warnings.belowBottom, floor - z);
  // a bit centred well outside the grid (a detail window of a bigger job) cannot touch it: skip the whole stamp
  if (ci < -k.rc || cj < -k.rc || ci >= nx + k.rc || cj >= ny + k.rc) { g.warnings.outside++; return; }
  let touched = false;
  for (let n = 0; n < k.di.length; n++) {
    const i = ci + k.di[n], j = cj + k.dj[n];
    if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
    touched = true;
    const v = Math.max(z + k.prof[n], floor);
    const idx = j * nx + i;
    if (v < H[idx]) H[idx] = v;
  }
  if (!touched) g.warnings.outside++;
}

/** Remove material along a straight move of the bit tip from a to b. */
export function cutSegment(g: SimGrid, tool: Tool, a: Pt3, b: Pt3) {
  const k = kernelFor(tool, g.cell);
  const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  const n = Math.max(1, Math.ceil(len / (g.cell * 0.5)));
  for (let s = 0; s <= n; s++) {
    const t = s / n;
    stamp(g, k, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
  }
}

/** Surface height under a point, or +Infinity outside the stock. */
export function heightAt(g: SimGrid, x: number, y: number): number {
  const i = Math.floor((x - g.stock.x0) / g.cell), j = Math.floor((y - g.stock.y0) / g.cell);
  if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) return -Infinity;
  return g.z[j * g.nx + i];
}

function checkRapid(g: SimGrid, a: Pt3, b: Pt3) {
  const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  const n = Math.max(1, Math.ceil(len / g.cell));
  for (let s = 0; s <= n; s++) {
    const t = s / n, x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t, z = a.z + (b.z - a.z) * t;
    if (heightAt(g, x, y) > z + 0.15) { if (g.warnings.crashes.length < 50) g.warnings.crashes.push({ x, y, z }); return; }
  }
}

/** Run one toolpath through the stock the way the G-code does: rapid to the start, down to 1 mm above the top (or, if entry says an earlier pass cleared the way, rapid on down), then the moves in order. Yields after a batch of moves so a page can stay responsive. */
export function* simulateToolpath(g: SimGrid, tp: Toolpath, batch = 2000, entry?: Map<Cut, number>): Generator<number> {
  let count = 0;
  for (const c of tp.cuts) {
    const first = c.moves[0];
    if (!first) continue;
    let prev: Pt3 = { x: first.x, y: first.y, z: 1 };
    const drop = entry?.get(c); // the G-code drops in fast through air an earlier pass cut: check that it really is air
    if (drop !== undefined) { const to = { x: first.x, y: first.y, z: drop }; checkRapid(g, prev, to); prev = to; }
    for (const m of c.moves) {
      if (m.rapid) checkRapid(g, prev, m); else cutSegment(g, tp.tool, prev, m);
      prev = m;
      if (++count % batch === 0) yield count;
    }
  }
  yield count;
}

/** The stock that just contains the toolpaths: a margin of `margin` mm around the cuts, as thick as the deepest cut (at least `minT`). */
export function autoStock(paths: Toolpath[], margin = 5, minT = 1): Stock {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, minZ = 0;
  for (const tp of paths) {
    const r = tp.tool.diameter / 2;
    for (const c of tp.cuts) for (const m of c.moves) {
      if (m.rapid) continue;
      minX = Math.min(minX, m.x - r); maxX = Math.max(maxX, m.x + r);
      minY = Math.min(minY, m.y - r); maxY = Math.max(maxY, m.y + r);
      minZ = Math.min(minZ, m.z);
    }
  }
  if (!(minX < Infinity)) return { x0: 0, y0: 0, w: 100, h: 100, t: 10 };
  return { x0: minX - margin, y0: minY - margin, w: maxX - minX + 2 * margin, h: maxY - minY + 2 * margin, t: Math.max(minT, -minZ) };
}

/** Plain-language findings from a finished simulation. */
export function simSummary(g: SimGrid): string[] {
  const w = g.warnings, out: string[] = [];
  if (w.crashes.length) {
    const c = w.crashes[0];
    out.push(`${w.crashes.length >= 50 ? '50 or more' : w.crashes.length} fast move(s) go down into uncut material (first at X ${c.x.toFixed(1)}, Y ${c.y.toFixed(1)}, Z ${c.z.toFixed(1)}). That could snap the bit.`);
  }
  if (w.belowBottom > 0.05) out.push(`The bit goes ${w.belowBottom.toFixed(1)} mm below the bottom of the stock (into your spoilboard).`);
  if (w.outside > 0) out.push('Some cutting is outside the stock area. Check the stock size and where zero is.');
  return out;
}
