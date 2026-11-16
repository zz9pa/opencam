/**
 * 3D surfacing from a height map: roughing (flat terraces, stepping down) and finishing (a raster that follows the surface).
 *
 * The central idea is the "tool surface": the height the TIP of the bit may sit at, at every X/Y position, without
 * the bit touching the model anywhere under its footprint. Every cut is then just a line along that surface, so by
 * construction the bit never gouges the model.
 */
import { EMPTY, heightMap, type HeightMap, type Oriented } from './mesh';
import type { Cut, Direction, Material, Pt, Pt3, Tool, Toolpath } from './types';

/** Surface actually left after tracing `S` (the tool-tip surface) with `tool`: min over the footprint of (S + bit profile): the lowest the bit reaches at each point. Where this is above the model, stock remains. */
export function cutSurface(hm: HeightMap, S: Float32Array, tool: Tool): Float32Array {
  const { nx, ny, cell, z } = hm;
  const { di, dj, prof } = kernel(tool, cell);
  const out = new Float32Array(nx * ny).fill(EMPTY);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (z[j * nx + i] <= EMPTY) continue;
    let best = Infinity;
    for (let k = 0; k < di.length; k++) {
      const ii = i + di[k], jj = j + dj[k];
      if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
      const s = S[jj * nx + ii];
      if (s <= EMPTY) continue;
      const v = s + prof[k];
      if (v < best) best = v;
    }
    out[j * nx + i] = best;
  }
  return out;
}

function kernel(tool: Tool, cell: number) {
  const R = tool.diameter / 2;
  const rc = Math.floor(R / cell);
  const di: number[] = [], dj: number[] = [], prof: number[] = [];
  const half = tool.type === 'vbit' ? Math.tan(((tool.angle ?? 60) / 2) * Math.PI / 180) : 1;
  const tipR = (tool.tipDiameter ?? 0) / 2;
  for (let b = -rc; b <= rc; b++) for (let a = -rc; a <= rc; a++) {
    const d = Math.hypot(a, b) * cell;
    if (d > R + 1e-9) continue;
    let p = 0;
    if (tool.type === 'ball') p = R - Math.sqrt(Math.max(0, R * R - d * d));
    else if (tool.type === 'vbit') p = Math.max(0, d - tipR) / half;
    di.push(a); dj.push(b); prof.push(p);
  }
  return { di, dj, prof };
}

/** The tool-tip surface for `tool` over the model: max over the footprint of (model height - bit profile). */
export function toolSurface(hm: HeightMap, tool: Tool): Float32Array {
  const { nx, ny, cell, z } = hm;
  const R = tool.diameter / 2;
  void R;
  const { di, dj, prof } = kernel(tool, cell);
  const K = di.length;
  const out = new Float32Array(nx * ny).fill(EMPTY);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (z[j * nx + i] <= EMPTY) continue;
      let best = -Infinity;
      for (let k = 0; k < K; k++) {
        const ii = i + di[k], jj = j + dj[k];
        if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
        const h = z[jj * nx + ii];
        if (h <= EMPTY) continue;
        const v = h - prof[k];
        if (v > best) best = v;
      }
      out[j * nx + i] = best;
    }
  }
  return out;
}

interface Run { j: number; i0: number; i1: number; used?: boolean }
interface Row { j: number; runs: Run[] }

export interface Mill3Common {
  tool: Tool;
  material: Material;
  /** Distance between neighbouring passes, mm */
  stepover: number;
  /** Climb or conventional: sets which way each pass runs */
  direction: Direction;
  /** Join neighbouring passes into one continuous back-and-forth path (faster, but every second pass is the other cutting direction) */
  zigzag: boolean;
  /** How far the top of the model sits below the top of the stock, mm */
  top: number;
  /** Where the model's lower-left corner goes in the drawing, mm */
  at: Pt;
}
export interface RoughParams extends Mill3Common {
  stepdown: number;
  /** Stock left on the surface for the finishing pass, mm */
  leave: number;
}
export interface FinishParams extends Mill3Common {
  /** Finish a second time along Y as well as X, so surfaces that run along the first passes (steep walls) are cut cleanly too */
  cross?: boolean;
}

export interface Mill3Result { toolpath: Toolpath; warnings: string[]; stats: { cells: number; cell: number; rows: number; unreachable: number } }

const world = (hm: HeightMap, at: Pt, i: number, j: number): Pt => ({ x: at.x + (i + 0.5) * hm.cell, y: at.y + (j + 0.5) * hm.cell });

/** Rows to run: every `rs`-th row, plus the last row if it would otherwise be left more than half a stride from the end. */
function strideRows(ny: number, rs: number): number[] {
  const js: number[] = [];
  for (let j = 0; j < ny; j += rs) js.push(j);
  if (ny - 1 - js[js.length - 1] > rs / 2) js.push(ny - 1);
  return js;
}

/** Runs of consecutive cells in row j for which `ok` holds. */
function rowRuns(nx: number, j: number, ok: (i: number) => boolean): Run[] {
  const runs: Run[] = [];
  let s = -1;
  for (let i = 0; i <= nx; i++) {
    const on = i < nx && ok(i);
    if (on && s < 0) s = i;
    if (!on && s >= 0) { runs.push({ j, i0: s, i1: i - 1 }); s = -1; }
  }
  return runs;
}

/**
 * Turn runs into passes. Without zigzag every run is its own pass, started from the end that gives `dir`
 * (climb: right to left, with the passes stepping towards +Y so the uncut material is on the right of travel; conventional: left to right).
 * With zigzag, a run is chained to a run in the next row that contains the same X, entering at its nearer end.
 */
interface Link { run: Run; fwd: boolean; via?: number }
function chain(rows: Row[], zigzag: boolean, plusX: boolean, canLink: (i: number, j0: number, j1: number) => boolean, near: number): Link[][] {
  const out: Link[][] = [];
  for (let r = 0; r < rows.length; r++) {
    for (const run of rows[r].runs) {
      if (run.used) continue;
      run.used = true;
      let cur: Link = { run, fwd: plusX };
      const ch = [cur];
      if (zigzag) {
        for (let q = r + 1; q < rows.length; q++) {
          const endI = cur.fwd ? cur.run.i1 : cur.run.i0;
          const nxt = rows[q].runs.find(n => !n.used && n.i0 <= endI && endI <= n.i1);
          if (!nxt || !canLink(endI, cur.run.j, nxt.j)) break;
          const dl = endI - nxt.i0, dr = nxt.i1 - endI;
          if (Math.min(dl, dr) > near) break;
          nxt.used = true;
          cur = { run: nxt, fwd: dl <= dr, via: endI };
          ch.push(cur);
        }
      }
      out.push(ch);
    }
  }
  return out;
}

function toCut(moves: Pt3[], z: number, zStart: number): Cut {
  return { loop: moves.map(m => ({ x: m.x, y: m.y })), z, zStart, closed: false, moves };
}

/** Roughing: cuts the stock away in flat levels, stepping down, leaving `leave` mm on the model surface. */
export function rough3d(model: Oriented, p: RoughParams): Mill3Result {
  const warnings: string[] = [];
  const R = p.tool.diameter / 2 + p.leave;
  const hm = heightMap(model, Math.min(1.5, Math.max(0.3, R / 8)));
  // The stock allowance is kept all round the bit, not just underneath: use a bit leave mm bigger on every side, then lift by leave.
  const raw = toolSurface(hm, { ...p.tool, diameter: p.tool.diameter + 2 * p.leave });
  const { nx, ny, cell } = hm;
  const S = new Float32Array(raw.length);
  let zmin = Infinity;
  for (let k = 0; k < raw.length; k++) {
    if (raw[k] <= EMPTY) { S[k] = EMPTY; continue; }
    S[k] = raw[k] - p.top + p.leave;
    zmin = Math.min(zmin, S[k]);
  }
  const tp: Toolpath = { name: '3D roughing', tool: p.tool, cuts: [], feed: p.material.feed, plungeFeed: p.material.plungeFeed };
  const stats = { cells: nx * ny, cell, rows: 0, unreachable: 0 };
  if (!(zmin < Infinity)) return { toolpath: tp, warnings: ['The model has no surface to cut.'], stats };
  if (zmin >= -1e-6) { return { toolpath: tp, warnings: ['Nothing to rough: the model fills the stock height.'], stats }; }
  const rs = Math.max(1, Math.round(p.stepover / cell));
  const js = strideRows(ny, rs);
  const nearest = (j: number) => js.reduce((b, c) => Math.abs(c - j) < Math.abs(b - j) ? c : b, js[0]);
  const near = new Int32Array(ny);
  for (let j = 0; j < ny; j++) near[j] = nearest(j);
  const isStride = new Uint8Array(ny);
  for (const j of js) isStride[j] = 1;
  // level depths
  const levels: number[] = [];
  for (let k = 1; ; k++) {
    const zl = -k * p.stepdown;
    if (zl <= zmin) { levels.push(zmin); break; }
    levels.push(zl);
  }
  let zPrev = 0;
  for (const z of levels) {
    const ok = (i: number, j: number) => { const v = S[j * nx + i]; return v > EMPTY && v <= z + 1e-6; };
    const rows: Row[] = js.map(j => ({ j, runs: rowRuns(nx, j, i => ok(i, j)) }));
    const extra: Row[] = [];
    for (let j = 0; j < ny; j++) {
      if (isStride[j]) continue;
      const nj = near[j];
      const runs = rowRuns(nx, j, i => ok(i, j) && !ok(i, nj));
      if (runs.length) extra.push({ j, runs });
    }
    const canLink = (i: number, j0: number, j1: number) => { for (let j = j0; j <= j1; j++) if (!ok(i, j)) return false; return true; };
    const chains = [...chain(rows, p.zigzag, p.direction === 'conventional', canLink, 3 * rs), ...chain(extra, false, p.direction === 'conventional', canLink, 0)];
    for (const ch of chains) {
      const mv: Pt3[] = [];
      let first = true;
      for (const { run, fwd, via } of ch) {
        const a = world(hm, p.at, fwd ? run.i0 : run.i1, run.j), b = world(hm, p.at, fwd ? run.i1 : run.i0, run.j);
        if (first) { mv.push({ ...a, z: Math.min(zPrev + 1, 1), rapid: true }, { ...a, z }); first = false; }
        else {
          const v = world(hm, p.at, via!, run.j);
          mv.push({ x: v.x, y: v.y, z }, { ...a, z });
        }
        mv.push({ ...b, z });
      }
      tp.cuts.push(toCut(mv, z, zPrev));
    }
    zPrev = z;
  }
  stats.rows = js.length;
  if (p.stepover > p.tool.diameter) warnings.push('The step-over is wider than the bit, so ridges of uncut stock will be left.');
  return { toolpath: tp, warnings, stats };
}

/** Remove points that lie within `tol` mm of the straight line between their neighbours (3D Ramer-Douglas-Peucker). */
export function simplify3(pts: Pt3[], tol: number): Pt3[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const A = pts[a], B = pts[b];
    const dx = B.x - A.x, dy = B.y - A.y, dz = B.z - A.z;
    const L2 = dx * dx + dy * dy + dz * dz;
    let worst = -1, wi = -1;
    for (let i = a + 1; i < b; i++) {
      const P = pts[i];
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((P.x - A.x) * dx + (P.y - A.y) * dy + (P.z - A.z) * dz) / L2)) : 0;
      const d = Math.hypot(P.x - (A.x + t * dx), P.y - (A.y + t * dy), P.z - (A.z + t * dz));
      if (d > worst) { worst = d; wi = i; }
    }
    if (worst > tol) { keep[wi] = 1; stack.push([a, wi], [wi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/** The model with X and Y swapped (a mirror about the diagonal: nothing else changes). */
function transpose(m: Oriented): Oriented {
  const tri = new Float32Array(m.tri.length);
  for (let i = 0; i < tri.length; i += 3) { tri[i] = m.tri[i + 1]; tri[i + 1] = m.tri[i]; tri[i + 2] = m.tri[i + 2]; }
  return { tri, w: m.d, d: m.w, h: m.h };
}
const swapXY = (c: Cut): Cut => ({ ...c, loop: c.loop.map(q => ({ x: q.y, y: q.x })), moves: c.moves.map(m => ({ ...m, x: m.y, y: m.x })) });

/**
 * Finishing: passes along X (stepping in Y) with the bit tip following the tool surface. With `cross`, a second set of
 * passes along Y follows (the model is turned about the diagonal, finished the same way and turned back). A mirror keeps
 * climb as climb: the uncut side is still on the right of travel.
 */
export function finish3d(model: Oriented, p: FinishParams, tol = 0.01): Mill3Result {
  const first = finishOnce(model, p, tol);
  if (!p.cross || !first.toolpath.cuts.length) return first;
  const second = finishOnce(transpose(model), { ...p, at: { x: p.at.y, y: p.at.x } }, tol);
  first.toolpath.cuts.push(...second.toolpath.cuts.map(swapXY));
  first.stats.rows += second.stats.rows;
  first.warnings = [...new Set([...first.warnings, ...second.warnings])];
  return first;
}

function finishOnce(model: Oriented, p: FinishParams, tol: number): Mill3Result {
  const warnings: string[] = [];
  const rs0 = Math.max(1, Math.round(p.stepover / 0.35));
  const hm = heightMap(model, p.stepover / rs0);
  const S = toolSurface(hm, p.tool);
  const { nx, ny, cell, z: H } = hm;
  const tp: Toolpath = { name: '3D finishing', tool: p.tool, cuts: [], feed: p.material.feed, plungeFeed: p.material.plungeFeed };
  const stats = { cells: nx * ny, cell, rows: 0, unreachable: 0 };
  const rs = Math.max(1, Math.round(p.stepover / cell));
  const js = strideRows(ny, rs);
  const cov = (i: number, j: number) => S[j * nx + i] > EMPTY;
  const rows: Row[] = js.map(j => ({ j, runs: rowRuns(nx, j, i => cov(i, j)) }));
  if (!rows.some(r => r.runs.length)) return { toolpath: tp, warnings: ['The model has no surface to cut.'], stats };
  const canLink = (i: number, j0: number, j1: number) => { for (let j = j0; j <= j1; j++) if (!cov(i, j)) return false; return true; };
  const zAt = (i: number, j: number) => S[j * nx + i] - p.top;
  for (const ch of chain(rows, p.zigzag, p.direction === 'conventional', canLink, 3 * rs)) {
    const mv: Pt3[] = [];
    const put = (i: number, j: number) => mv.push({ ...world(hm, p.at, i, j), z: zAt(i, j) });
    let prev: Run | null = null;
    for (const { run, fwd, via } of ch) {
      const start = fwd ? run.i0 : run.i1, end = fwd ? run.i1 : run.i0;
      let from = start;
      if (prev && via !== undefined) {
        // step across to the next row along the surface, then along that row to the end where this pass starts
        for (let j = prev.j + 1; j <= run.j; j++) put(via, j);
        const dir = start >= via ? 1 : -1;
        for (let i = via + dir; dir > 0 ? i <= start : i >= start; i += dir) put(i, run.j);
        from = start + (end >= start ? 1 : -1);
        if (start === end) from = end + 1;
      } else put(start, run.j);
      const dir = end >= start ? 1 : -1;
      if (start !== end) for (let i = from; dir > 0 ? i <= end : i >= end; i += dir) put(i, run.j);
      prev = run;
    }
    const pts = simplify3(mv, tol);
    if (pts.length < 2) continue;
    let zlo = 0;
    for (const q of pts) if (q.z < zlo) zlo = q.z; // (a loop: spreading tens of thousands of points into Math.min overflows the call stack)
    tp.cuts.push(toCut(pts, zlo, 0));
  }
  // where the bit cannot get into the surface, stock is left standing above the model
  const left = cutSurface(hm, S, p.tool);
  let reach = 0, covered = 0;
  const m = Math.ceil(p.tool.diameter / 2 / cell); // cells near the model's edge have fewer places the bit can sit: leave them out
  for (let j = m; j < ny - m; j++) for (let i = m; i < nx - m; i++) { const k = j * nx + i; if (H[k] > EMPTY) { covered++; if (left[k] - H[k] > 0.05) reach++; } }
  stats.unreachable = covered ? reach / covered : 0;
  stats.rows = js.length;
  if (stats.unreachable > 0.02) warnings.push(`About ${Math.round(stats.unreachable * 100)}% of the surface cannot be reached by a ${p.tool.diameter} mm bit (tight inside curves and narrow grooves). A smaller bit would cut closer to the model there.`);
  if (p.stepover > p.tool.diameter) warnings.push('The step-over is wider than the bit, so ridges of uncut stock will be left.');
  if (p.tool.type === 'ball') {
    const R = p.tool.diameter / 2, s = Math.min(p.stepover / 2, R);
    const scallop = R - Math.sqrt(R * R - s * s);
    if (scallop > 0.1) warnings.push(`Ridges between passes will be about ${scallop.toFixed(2)} mm high on flat areas. Use a smaller step-over for a smoother surface.`);
  }
  return { toolpath: tp, warnings, stats };
}
