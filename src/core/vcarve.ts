import { minOf, maxOf } from './util';
import Delaunator from 'delaunator';
import type { Cut, Direction, Loop, Material, Pt3, Tool, Toolpath } from './types';
import { normalize, offset, reverse, signedArea, subtract, regionArea, insideRegion } from './geometry';
import type { RampParams } from './entry';
import { linkRings } from './ringlink';
import { buildMoves } from './entry';
import { pocket } from './ops';

/** A skeleton node: a point on the medial axis and the radius of the largest circle that fits there. */
export interface AxisNode { x: number; y: number; r: number }
export interface MedialAxis { nodes: AxisNode[]; edges: [number, number][] }

const d2 = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

/** Even spacing along every edge of every loop, keeping all the original corners. */
function resample(loops: Loop[], spacing: number): { pts: { x: number; y: number }[]; loopOf: number[]; indexInLoop: number[]; loopStart: number[]; loopLen: number[] } {
  const pts: { x: number; y: number }[] = [], loopOf: number[] = [], indexInLoop: number[] = [], loopStart: number[] = [], loopLen: number[] = [];
  loops.forEach((l, li) => {
    loopStart.push(pts.length);
    let k = 0;
    for (let i = 0; i < l.length; i++) {
      const a = l[i], b = l[(i + 1) % l.length];
      const n = Math.max(1, Math.round(d2(a, b) / spacing));
      for (let s = 0; s < n; s++) {
        pts.push({ x: a.x + ((b.x - a.x) * s) / n, y: a.y + ((b.y - a.y) * s) / n });
        loopOf.push(li); indexInLoop.push(k++);
      }
    }
    loopLen.push(k);
  });
  return { pts, loopOf, indexInLoop, loopStart, loopLen };
}

/**
 * Medial axis (the "skeleton" down the middle of every stroke) of a polygon with holes, from the Voronoi diagram
 * of a densely sampled outline. For each skeleton point it also gives the radius of the largest inscribed circle,
 * which is what decides how deep a V-bit must go there.
 *
 * `spacing` is how finely the outline is sampled; it should be well below the thinnest stroke.
 */
export function medialAxis(shapes: Loop[], spacing: number): MedialAxis {
  const loops = normalize(shapes).filter(l => l.length >= 3);
  if (!loops.length) return { nodes: [], edges: [] };
  const { pts, loopOf, indexInLoop, loopStart, loopLen } = resample(loops, spacing);
  const n = pts.length;
  if (n < 3) return { nodes: [], edges: [] };

  // After normalisation outer loops run CCW and holes CW, so the inside is always on the LEFT of a boundary edge.
  const next = (i: number) => { const l = loopOf[i]; return loopStart[l] + ((indexInLoop[i] + 1) % loopLen[l]); };
  const boundaryDir = new Set<number>(); // directed i->i+1, encoded i * n + j
  for (let i = 0; i < n; i++) boundaryDir.add(i * n + next(i));
  const isBoundary = (u: number, v: number) => boundaryDir.has(u * n + v) || boundaryDir.has(v * n + u);

  const coords = new Float64Array(2 * n);
  pts.forEach((p, i) => { coords[2 * i] = p.x; coords[2 * i + 1] = p.y; });
  const del = new Delaunator(coords);
  const tri = del.triangles, half = del.halfedges;
  const T = tri.length / 3;

  // Orient each triangle counter-clockwise so "left of an edge" means inside the triangle.
  const verts: [number, number, number][] = [];
  for (let t = 0; t < T; t++) {
    let a = tri[3 * t], b = tri[3 * t + 1], c = tri[3 * t + 2];
    const cross = (pts[b].x - pts[a].x) * (pts[c].y - pts[a].y) - (pts[b].y - pts[a].y) * (pts[c].x - pts[a].x);
    if (cross < 0) [b, c] = [c, b];
    verts.push([a, b, c]);
  }
  /** Which triangle (and which of its edges) lies across the edge u-v from triangle t */
  const edgeKeyToTri = new Map<number, number>();
  const ek = (u: number, v: number) => u * n + v;
  verts.forEach(([a, b, c], t) => { edgeKeyToTri.set(ek(a, b), t); edgeKeyToTri.set(ek(b, c), t); edgeKeyToTri.set(ek(c, a), t); });

  // Label triangles inside / outside: a boundary edge has the inside on its left, and the label flips across it.
  const label = new Int8Array(T).fill(-1); // 1 inside, 0 outside, -1 unknown
  const queue: number[] = [];
  verts.forEach(([a, b, c], t) => {
    for (const [u, v] of [[a, b], [b, c], [c, a]] as const) {
      if (boundaryDir.has(ek(u, v))) { if (label[t] < 0) { label[t] = 1; queue.push(t); } }
      else if (boundaryDir.has(ek(v, u))) { if (label[t] < 0) { label[t] = 0; queue.push(t); } }
    }
  });
  while (queue.length) {
    const t = queue.pop()!;
    const [a, b, c] = verts[t];
    for (const [u, v] of [[a, b], [b, c], [c, a]] as const) {
      const other = edgeKeyToTri.get(ek(v, u));
      if (other === undefined || label[other] >= 0) continue;
      label[other] = isBoundary(u, v) ? 1 - label[t] : label[t];
      queue.push(other);
    }
  }
  void half;

  // Circumcentres of inside triangles are the Voronoi vertices, i.e. medial-axis nodes.
  const nodeOf = new Int32Array(T).fill(-1);
  const nodes: AxisNode[] = [];
  for (let t = 0; t < T; t++) {
    if (label[t] !== 1) continue;
    const [a, b, c] = verts[t];
    const A = pts[a], B = pts[b], C = pts[c];
    const dd = 2 * (A.x * (B.y - C.y) + B.x * (C.y - A.y) + C.x * (A.y - B.y));
    if (Math.abs(dd) < 1e-12) continue;
    const a2 = A.x * A.x + A.y * A.y, b2 = B.x * B.x + B.y * B.y, c2 = C.x * C.x + C.y * C.y;
    const cx = (a2 * (B.y - C.y) + b2 * (C.y - A.y) + c2 * (A.y - B.y)) / dd;
    const cy = (a2 * (C.x - B.x) + b2 * (A.x - C.x) + c2 * (B.x - A.x)) / dd;
    // An obtuse triangle whose longest side is a piece of the outline has its centre outside the shape.
    const lab = [d2(B, C), d2(C, A), d2(A, B)]; // opposite a, b, c
    const longest = lab.indexOf(Math.max(...lab));
    const [lu, lv] = longest === 0 ? [b, c] : longest === 1 ? [c, a] : [a, b];
    const obtuse = Math.max(...lab) ** 2 > lab.reduce((s, x) => s + x * x, 0) - Math.max(...lab) ** 2 + 1e-12;
    if (obtuse && isBoundary(lu, lv)) continue;
    nodeOf[t] = nodes.length;
    nodes.push({ x: cx, y: cy, r: Math.hypot(cx - A.x, cy - A.y) });
  }

  // Voronoi edges: a chord between two inside triangles. Chords between sites that are neighbours along the outline
  // are sampling noise (they just point at the outline), so they are skipped.
  const sepFor = (u: number, v: number) => {
    if (loopOf[u] !== loopOf[v]) return Infinity;
    const L = loopLen[loopOf[u]], g = Math.abs(indexInLoop[u] - indexInLoop[v]);
    return Math.min(g, L - g);
  };
  const edges: [number, number][] = [];
  const seen = new Set<number>();
  verts.forEach(([a, b, c], t) => {
    if (nodeOf[t] < 0) return;
    for (const [u, v] of [[a, b], [b, c], [c, a]] as const) {
      if (isBoundary(u, v)) continue;
      const other = edgeKeyToTri.get(ek(v, u));
      if (other === undefined || nodeOf[other] < 0 || other === t) continue;
      if (sepFor(u, v) <= 2) continue;
      const i = nodeOf[t], j = nodeOf[other];
      const key = Math.min(i, j) * (nodes.length + 1) + Math.max(i, j);
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push([i, j]);
    }
  });
  return pruneAxis({ nodes, edges }, spacing * 3);
}

/** Drop short dead-end branches (hairs caused by the sampling) and nodes that are no longer used. */
export function pruneAxis(ax: MedialAxis, hairLength: number): MedialAxis {
  let edges = ax.edges.slice();
  for (let pass = 0; pass < 3; pass++) {
    const deg = new Map<number, number>();
    for (const [a, b] of edges) { deg.set(a, (deg.get(a) ?? 0) + 1); deg.set(b, (deg.get(b) ?? 0) + 1); }
    const adj = new Map<number, number[]>();
    edges.forEach(([a, b], k) => { (adj.get(a) ?? adj.set(a, []).get(a)!).push(k); (adj.get(b) ?? adj.set(b, []).get(b)!).push(k); });
    const drop = new Set<number>();
    // Follow each dead end back to a junction; if that branch is short, remove it.
    for (const [node, dg] of deg) {
      if (dg !== 1) continue;
      let cur = node, len = 0;
      const branch: number[] = [];
      let prevEdge = -1;
      for (let guard = 0; guard < edges.length + 2; guard++) {
        const k = (adj.get(cur) ?? []).find(e => e !== prevEdge && !drop.has(e));
        if (k === undefined) break;
        branch.push(k);
        const [a, b] = edges[k];
        const nxt = a === cur ? b : a;
        len += d2(ax.nodes[a], ax.nodes[b]);
        prevEdge = k; cur = nxt;
        if ((deg.get(cur) ?? 0) !== 2) break;
      }
      if ((deg.get(cur) ?? 0) >= 3 && len < hairLength) branch.forEach(k => drop.add(k));
    }
    if (!drop.size) break;
    edges = edges.filter((_, k) => !drop.has(k));
  }
  const used = new Map<number, number>();
  const nodes: AxisNode[] = [];
  const idx = (i: number) => { if (!used.has(i)) { used.set(i, nodes.length); nodes.push(ax.nodes[i]); } return used.get(i)!; };
  const out: [number, number][] = edges.map(([a, b]) => [idx(a), idx(b)]);
  return { nodes, edges: out };
}

// ---------------------------------------------------------------------------------------------------------------

export interface VCarveParams {
  /** Must be a V-bit */
  tool: Tool;
  material: Material;
  /** Deepest the tip may go, mm (the "flat depth" cap) */
  maxDepth: number;
  direction: Direction;
  /**
   * What to do where a shape is wider than the V can reach at max depth: 'clear' them flat with the V-bit, 'skip' them,
   * or 'walls' (another bit clears the floor: the V-bit only cuts the sloped walls and the strokes it can fully carve).
   */
  wide: 'clear' | 'skip' | 'walls';
  /** Distance between the concentric clearing passes for wide areas, mm. Smaller leaves a smoother floor but takes longer. */
  clearStep?: number;
  /** Ramp into the clearing passes instead of plunging straight down */
  ramp?: RampParams;
  /** With wide 'walls': also clear the floor with V-bit rings, but only where it touches this region (what a flat bit could not reach) */
  ringsWithin?: Loop[];
}

/** Radius of the cone at the surface when the tip is `depth` below it. */
export function surfaceRadius(tool: Tool, depth: number): number {
  const half = ((tool.angle ?? 60) * Math.PI) / 360;
  return (tool.tipDiameter ?? 0) / 2 + depth * Math.tan(half);
}
/** How deep the tip must go so the cone just reaches a point `r` from the tip axis at the surface. */
export function depthForRadius(tool: Tool, r: number): number {
  const half = ((tool.angle ?? 60) * Math.PI) / 360;
  return Math.max(0, (r - (tool.tipDiameter ?? 0) / 2) / Math.tan(half));
}

/** The deepest a V-bit can carve: past this the cone is wider than the bit itself. */
export function maxVDepth(tool: Tool): number {
  return depthForRadius(tool, tool.diameter / 2);
}

/** Chains of node indices running between junctions and dead ends. */
function chains(ax: MedialAxis): number[][] {
  const adj = new Map<number, number[]>();
  ax.edges.forEach(([a, b], k) => { (adj.get(a) ?? adj.set(a, []).get(a)!).push(k); (adj.get(b) ?? adj.set(b, []).get(b)!).push(k); });
  const used = new Set<number>();
  const out: number[][] = [];
  const walk = (start: number, firstEdge: number) => {
    const c = [start];
    let cur = start, e = firstEdge;
    for (let guard = 0; guard <= ax.edges.length; guard++) {
      used.add(e);
      const [a, b] = ax.edges[e];
      cur = a === cur ? b : a;
      c.push(cur);
      const nexts = (adj.get(cur) ?? []).filter(k => !used.has(k));
      if ((adj.get(cur) ?? []).length !== 2 || !nexts.length) break;
      e = nexts[0];
    }
    out.push(c);
  };
  // Start at dead ends and junctions first, then pick up any closed loops.
  for (const [node, list] of adj) if (list.length !== 2) for (const e of list) if (!used.has(e)) walk(node, e);
  for (const [node, list] of adj) for (const e of list) if (!used.has(e)) walk(node, e);
  return out;
}

/** Ramer-Douglas-Peucker in (x, y, depth) so slopes survive as well as outlines. */
function simplify3(p: Pt3[], eps: number): Pt3[] {
  if (p.length <= 2) return p;
  const keep = new Array(p.length).fill(false);
  keep[0] = keep[p.length - 1] = true;
  const stack: [number, number][] = [[0, p.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const a = p[s], b = p[e];
    const vx = b.x - a.x, vy = b.y - a.y, vz = b.z - a.z, l2 = vx * vx + vy * vy + vz * vz;
    let worst = -1, wi = -1;
    for (let i = s + 1; i < e; i++) {
      const t = l2 ? Math.max(0, Math.min(1, ((p[i].x - a.x) * vx + (p[i].y - a.y) * vy + (p[i].z - a.z) * vz) / l2)) : 0;
      const dist = Math.hypot(p[i].x - a.x - t * vx, p[i].y - a.y - t * vy, p[i].z - a.z - t * vz);
      if (dist > worst) { worst = dist; wi = i; }
    }
    if (worst > eps && wi >= 0) { keep[wi] = true; stack.push([s, wi], [wi, e]); }
  }
  return p.filter((_, i) => keep[i]);
}

/**
 * V-carve: run the V-bit along the medial axis of each shape, at the depth where the cone's edge just meets the outline.
 * Several passes (limited by the material's depth per pass) are used for deep carving. Where the shape is wider than the
 * bit can reach at `maxDepth`, 'clear' removes the rest with concentric passes at max depth.
 */
export function vcarve(shapes: Loop[], p: VCarveParams): Toolpath {
  const base = { name: 'V-carve', tool: p.tool, feed: p.material.feed, plungeFeed: p.material.plungeFeed };
  const region = normalize(shapes);
  if (!region.length) return { ...base, cuts: [] };
  const minHalf = Math.max((p.tool.tipDiameter ?? 0) / 2, 0.05);
  // Sample finely enough for the thinnest strokes we can usefully carve.
  const spacing = Math.min(0.5, Math.max(0.1, minHalf + 0.1));
  const ax = medialAxis(region, spacing);
  const tan = Math.tan((((p.tool.angle ?? 60) * Math.PI) / 360));
  void tan;
  const need = (nd: AxisNode) => depthForRadius(p.tool, nd.r);
  const cap = Math.min(p.maxDepth, maxVDepth(p.tool));   // the cone cannot be wider than the bit
  const cuts: Cut[] = [];

  let cs = chains(ax);
  if (p.wide === 'walls') {
    // The wide floor is cleared by another bit: the V-bit keeps only the stretches of skeleton it can fully carve.
    const keep = (c: number[]) => {
      const out: number[][] = [];
      let cur: number[] = [];
      for (const i of c) {
        if (need(ax.nodes[i]) <= cap + 1e-6) cur.push(i);
        else { if (cur.length >= 2) out.push(cur); cur = []; }
      }
      if (cur.length >= 2) out.push(cur);
      return out;
    };
    cs = cs.flatMap(keep);
  }
  // Orient every chain to start at its shallow end, and order them by nearest neighbour to keep travel short.
  const oriented = cs.map(c => (need(ax.nodes[c[0]]) <= need(ax.nodes[c[c.length - 1]]) ? c : [...c].reverse()));
  const order: number[][] = [];
  let at = { x: 0, y: 0 };
  const left = oriented.slice();
  while (left.length) {
    let bi = 0, bd = Infinity;
    left.forEach((c, i) => { const s = ax.nodes[c[0]]; const dd = d2(s, at); if (dd < bd) { bd = dd; bi = i; } });
    const c = left.splice(bi, 1)[0];
    order.push(c);
    at = ax.nodes[c[c.length - 1]];
  }

  const wanted = Math.max(0, ...ax.nodes.map(need));       // how deep the widest stroke would like to go
  const deepest = Math.min(cap, wanted);
  const nLevels = deepest > 0 ? Math.max(1, Math.ceil(deepest / p.material.stepdown - 1e-9)) : 0;
  const levels: number[] = Array.from({ length: nLevels }, (_, i) => ((i + 1) * deepest) / nLevels);
  let zPrev = 0;
  for (const limit of levels) {
    for (const c of order) {
      const raw: Pt3[] = c.map(i => ({ x: ax.nodes[i].x, y: ax.nodes[i].y, z: -Math.min(need(ax.nodes[i]), cap, limit) }));
      if (raw.every(m => m.z > -1e-6)) continue;           // nothing to cut on this stretch at this depth
      const moves = simplify3(raw, 0.02);
      if (moves.length >= 2) cuts.push({ loop: moves.map(m => ({ x: m.x, y: m.y })), z: minOf(moves.map(m => m.z)), zStart: zPrev, closed: false, moves });
    }
    zPrev = -limit;
  }

  // Wide areas handled by another (flat) bit: the V-bit only cuts the sloped wall, as one contour where its cone just
  // reaches the outline at the surface with the tip at the floor depth.
  if (p.wide === 'walls') {
    const rWall = surfaceRadius(p.tool, cap);
    for (const ring of offset(region, -rWall)) {
      const toolOutside = signedArea(ring) < 0;
      const want = toolOutside !== (p.direction === 'climb');
      const loop = (signedArea(ring) > 0) === want ? ring : reverse(ring);
      cuts.push({ loop, z: -cap, zStart: 0, closed: true, moves: buildMoves(loop, 0, -cap, 0, { ramp: p.ramp ?? { maxAngleDeg: 3 } }) });
    }
    // Floor the flat bit could not reach: the V-bit clears it with concentric rings, keeping only rings that touch it.
    if (p.ringsWithin?.length) {
      const within = p.ringsWithin;
      // finer than the default so the floor the V-bit leaves is nearly as flat as the flat bit's (ridge = step / 2 / tan)
      const step = p.clearStep ?? Math.max(0.1, Math.min(0.3, rWall * 0.15));
      const keepRings: Loop[] = [];
      for (let d = rWall + step, guard = 0; guard < 1500; d += step, guard++) {
        const rings = offset(region, -d);
        if (!rings.length) break;
        for (const ring of rings) {
          // keep a ring if a good share of its points lie in the leftover region (sample every few points)
          const stride = Math.max(1, Math.floor(ring.length / 40));
          let hit = 0, tot = 0;
          for (let i = 0; i < ring.length; i += stride) { tot++; if (insideRegion(within, ring[i].x, ring[i].y)) hit++; }
          if (tot && hit / tot >= 0.15) {
            const toolOutside = signedArea(ring) < 0;
            const want = toolOutside !== (p.direction === 'climb');
            keepRings.push((signedArea(ring) > 0) === want ? ring : reverse(ring));
          }
        }
      }
      cuts.push(...linkRings(keepRings, -cap, 0, { ramp: p.ramp ?? { maxAngleDeg: 3 }, linkMax: step * 3 }));
    }
  }

  // Wide areas: where the V cannot reach the outline even at max depth, clear them flat at max depth.
  if (p.wide === 'clear') {
    const rCap = surfaceRadius(p.tool, cap);
    const step = p.clearStep ?? Math.max(0.1, Math.min(0.5, rCap * 0.15));
    const oriented: Loop[] = [];
    for (let d = rCap, guard = 0; guard < 1500; d += step, guard++) {
      const rings = offset(region, -d);
      if (!rings.length) break;
      for (const ring of rings) {
        // the tool is inside outer boundaries and outside islands, as for a pocket
        const toolOutside = signedArea(ring) < 0;
        const want = toolOutside !== (p.direction === 'climb');
        oriented.push((signedArea(ring) > 0) === want ? ring : reverse(ring));
      }
    }
    // Rings are linked so the bit steps across at depth rather than lifting out between each one.
    if (p.ramp) cuts.push(...linkRings(oriented, -cap, 0, { ramp: p.ramp, linkMax: step * 3 }));
    else cuts.push(...linkRings(oriented, -cap, 0, { linkMax: step * 3 }));
  }
  return { ...base, cuts, meta: { wantedDepth: wanted, usedCap: cap } };
}

export interface VCarveFlatParams extends Omit<VCarveParams, 'wide'> {
  /** The flat end mill that clears the wide floor */
  flat: Tool;
}

export interface VCarveFlatResult {
  /** Runs first. Null when no part of the design is too wide for the V-bit, so no flat bit is needed. */
  flat: Toolpath | null;
  /** The V-bit's work: sloped walls of the wide areas and the strokes it can carve in full */
  v: Toolpath;
  warnings: string[];
}

/**
 * V-carve with a flat-bit companion. Where a shape is wider than the V can reach at the maximum depth, a flat end mill
 * first clears the floor to that depth (inside the line where the V-bit's wall will meet it), then the V-bit cuts the
 * sloped walls and the thinner strokes. The floor is flat and clean, and quicker than clearing it with the V-bit.
 */
export function vcarveWithFlat(shapes: Loop[], p: VCarveFlatParams): VCarveFlatResult {
  const warnings: string[] = [];
  const region = normalize(shapes);
  const v = vcarve(shapes, { ...p, wide: 'walls' });
  const wanted = v.meta?.wantedDepth ?? 0, cap = v.meta?.usedCap ?? p.maxDepth;
  if (!region.length || wanted <= cap + 0.05) return { flat: null, v, warnings };   // nothing too wide: the V-bit does it all

  // The sloped wall meets the flat floor this far inside the outline (independent of the tip width).
  const delta = cap * Math.tan((((p.tool.angle ?? 60) * Math.PI) / 360));
  const floor = offset(region, -delta);
  if (!floor.length) return { flat: null, v, warnings };

  // What the flat bit can reach: its centre stays inside the floor by its radius, so it clears the floor "opened" by that radius.
  const rf = p.flat.diameter / 2;
  const reachable = offset(offset(floor, -rf), rf);
  const total = regionArea(floor);
  const leftover = subtract(floor, reachable);
  const leftArea = regionArea(leftover);
  const needsV = leftArea > Math.max(1, 0.02 * total);           // more than 2% of the floor (and over 1 mm2) is out of the flat bit's reach

  let flat: Toolpath | null = null;
  if (reachable.length && regionArea(reachable) > 1) {
    flat = pocket(floor, { tool: p.flat, material: p.material, depth: cap, direction: p.direction, stepoverFraction: 0.4, ramp: p.ramp });
    flat.name = 'V-carve: clear the wide floor (flat bit)';
    if (!flat.cuts.length) flat = null;
  }
  // Anything the flat bit cannot reach is cleared by the V-bit, so no floor is ever silently left uncut.
  const vFinal = needsV || !flat ? vcarve(shapes, { ...p, wide: 'walls', ringsWithin: flat ? leftover : floor }) : v;
  if (!flat) {
    warnings.push(`The flat bit (${p.flat.diameter} mm) is wider than the floor to be cleared, so it cannot help here: the V-bit clears the floor instead. Use a smaller flat bit to speed this up.`);
  } else if (needsV) {
    warnings.push(`The flat bit (${p.flat.diameter} mm) clears about ${Math.round((1 - leftArea / total) * 100)}% of the floor; the V-bit clears the narrow parts and corners it cannot reach. A smaller flat bit would leave less for the V-bit.`);
  }
  return { flat, v: vFinal, warnings };
}
