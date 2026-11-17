import type { Cut, Direction, Line, Loop, Material, Pt, Pt3, Tool, Toolpath } from './types';
import { insideRegion, normalize, offset, reverse, signedArea, simplify, simplifyOpen, subtract } from './geometry';
import { buildMoves, buildOpenMoves, leadMoves, type RampParams, type TabParams } from './entry';
import { radiusAt } from './tool';

export interface CutParams {
  tool: Tool;
  material: Material;
  /** Total depth, positive mm below top of stock */
  depth: number;
  /**
   * Start depth, positive mm below the top of the stock: the material above it is already gone (for example the floor of
   * a pocket that this operation sits in), so the cutting starts there and the bit rapids down through the air.
   */
  start?: number;
  direction: Direction;
  ramp?: RampParams;
}

/** Depth levels (negative Z) from `start` below the top of stock (default 0) down to -depth. Empty if start is not above depth. */
export function depthLevels(depth: number, stepdown: number, start = 0): number[] {
  const span = depth - start;
  if (span <= 1e-9) return [];
  const n = Math.max(1, Math.ceil(span / stepdown - 1e-9));
  return Array.from({ length: n }, (_, i) => -(start + ((i + 1) * span) / n));
}
/** Marks the first pass of an operation with a start depth so the G-code can rapid down to it. */
const airTo = (start: number | undefined, zStart: number) => (start && start > 0 && Math.abs(zStart + start) < 1e-9 ? { airTo: 1 - start } : {});

/**
 * Spindle is assumed CW seen from above (standard router).
 * Climb milling = the uncut material is on the RIGHT of the direction of travel (the tooth then moves with the work, and the
 * cutting force pulls the tool forward). So loops where the tool is OUTSIDE the enclosed region travel CW and loops where the
 * tool is INSIDE (pocket walls, hole walls) travel CCW. Conventional is the reverse.
 */
function orient(loop: Loop, wantCCW: boolean): Loop {
  return (signedArea(loop) > 0) === wantCCW ? loop : reverse(loop);
}

export type ProfileSide = 'outside' | 'inside';

export interface ProfileParams extends CutParams {
  tabs?: TabParams;
  /** Inside cut-outs only: relieve inside corners so square-cornered parts fit */
  dogbone?: boolean;
  /**
   * Radius of the lead-in / lead-out arcs, mm (0 or unset = none). The first depth arrives along a curve that does the descent and
   * the last leaves along one, both bending into the waste, so there is no plunge mark on the finished edge. Arcs that do not fit
   * (small holes, tight gaps) are made smaller, then dropped.
   */
  lead?: number;
}

/**
 * Cut around shapes. 'outside' keeps the shape (tool outside outer edges,
 * inside holes); 'inside' cuts the shape out of the material interior.
 */
export function profile(shapes: Loop[], side: ProfileSide, p: ProfileParams): Toolpath {
  const norm = normalize(shapes);
  const climb = p.direction === 'climb';
  const tabTopZ = p.tabs ? -p.depth + p.tabs.height : undefined;
  const cuts: Cut[] = [];
  let zStart = -(p.start ?? 0);
  // Inside cut-out: the removed region is the shape itself (interior on the left of every edge after normalisation).
  const corners = p.dogbone && side === 'inside' ? insideCorners(norm) : [];
  const levels = depthLevels(p.depth, p.material.stepdown, p.start);
  levels.forEach((z, li) => {
    const r = radiusAt(p.tool, z);
    const rings = offset(norm, side === 'outside' ? r : -r);
    for (const raw of rings) {
      const l = corners.length ? addDogbones(raw, corners, r) : raw;
      const isOuter = signedArea(raw) > 0; // Clipper: outers +, holes -
      const toolOutside = side === 'outside' ? isOuter : !isOuter;
      const loop = orient(l, toolOutside !== climb);
      const lead = { in: li === 0, out: li === levels.length - 1 };
      let moves: Pt3[] | null = null;
      if (p.lead && p.lead > 0) {
        // the arcs must stay on the waste side of the finished edge: outside the ring for an outside cut, inside it for an inside cut
        const clear = (q: Pt) => (side === 'outside' ? !insideRegion(rings, q.x, q.y) : insideRegion(rings, q.x, q.y));
        const body = lead.in ? buildMoves(loop, z, z, 2 * r, { tabs: p.tabs, tabTopZ }) : buildMoves(loop, zStart, z, 2 * r, { ramp: p.ramp, tabs: p.tabs, tabTopZ });
        moves = leadMoves(body, zStart, z, p.lead, climb, lead, clear);
      }
      cuts.push({
        loop, z, zStart, closed: true, ...airTo(p.start, zStart),
        moves: moves ?? buildMoves(loop, zStart, z, 2 * r, { ramp: p.ramp, tabs: p.tabs, tabTopZ }),
      });
    }
    zStart = z;
  });
  return { name: `Profile (${side})`, tool: p.tool, cuts, feed: p.material.feed, plungeFeed: p.material.plungeFeed };
}

export interface PocketParams extends CutParams {
  /** Fraction of tool diameter between passes, 0-1 */
  stepoverFraction: number;
  /** Relieve inside corners so square-cornered parts fit */
  dogbone?: boolean;
  /**
   * Radius of lead-in / lead-out arcs, mm (0 or unset = none), for the pass along the pocket wall only (the inner passes
   * leave nothing to protect). The first depth arrives along a curve into the pocket and the last leaves along one, so
   * the wall has no plunge or dwell mark. Arcs that do not fit are made smaller, then dropped.
   */
  lead?: number;
  /**
   * Rest machining: diameter (mm) of an earlier, bigger flat bit that already pocketed this same shape. Only the corners and
   * narrow parts that bit could not reach are cut (plus a margin of a bit diameter, so the new passes run out into the cleared
   * area and the bit has room to reach right into the corner). Ignored when it is not bigger than this bit.
   */
  rest?: number;
}

/**
 * What a flat bit of diameter `big` leaves in a pocket: the places its centre can never reach. The result is those leftovers
 * grown by `margin` and trimmed to the pocket, ready to be pocketed by the smaller bit.
 */
export function restRegion(full: Loop[], big: number, margin: number): Loop[] {
  const reached = offset(offset(full, -big / 2), big / 2);
  const left = normalize(subtract(full, offset(reached, 0.05))).filter(l => Math.abs(signedArea(l)) > 0.01);
  if (!left.length) return [];
  return normalize(subtract(full, subtract(full, offset(left, margin))));
}

/** The same closed loop, restarted at the middle of its longest edge (a lead arc needs a straight run to arrive along, not a corner). */
function startMidEdge(loop: Loop): Loop {
  let bi = 0, bl = -1;
  for (let i = 0; i < loop.length; i++) {
    const l = Math.hypot(loop[(i + 1) % loop.length].x - loop[i].x, loop[(i + 1) % loop.length].y - loop[i].y);
    if (l > bl) { bl = l; bi = i; }
  }
  const a = loop[bi], b = loop[(bi + 1) % loop.length];
  return [{ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, ...loop.slice(bi + 1), ...loop.slice(0, bi + 1)];
}

/** Distance from a point to the nearest edge of a set of loops. */
function edgeDist(loops: Loop[], x: number, y: number): number {
  let best = Infinity;
  for (const l of loops) for (let i = 0; i < l.length; i++) {
    const a = l[i], b = l[(i + 1) % l.length];
    const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy)));
  }
  return best;
}

/** Clear the interior of shapes with concentric contour-parallel passes. */
export function pocket(shapes: Loop[], p: PocketParams): Toolpath {
  const full = normalize(shapes);
  const region = p.rest && p.rest > p.tool.diameter ? restRegion(full, p.rest, p.tool.diameter + 0.5) : full;
  const climb = p.direction === 'climb';
  const cuts: Cut[] = [];
  let zStart = -(p.start ?? 0);
  const corners = p.dogbone ? insideCorners(full) : [];
  const levels = depthLevels(p.depth, p.material.stepdown, p.start);
  for (const [li, z] of levels.entries()) {
    const r = radiusAt(p.tool, z);
    const step = 2 * r * p.stepoverFraction;
    for (let d = r, guard = 0; guard < 2000; d += step, guard++) {
      const ring = offset(region, -d);
      if (ring.length === 0) break;
      for (const raw of ring) {
        // Only the pass along the wall (the first ring) reaches the corners, so only it gets the relief.
        const l = corners.length && guard === 0 ? addDogbones(raw, corners, r) : raw;
        // Tool is inside outer boundaries and outside islands.
        const toolOutside = signedArea(raw) < 0;
        const oriented = orient(l, toolOutside !== climb);
        const wantLead = !!p.lead && p.lead > 0 && guard === 0;
        const loop = wantLead ? startMidEdge(oriented) : oriented; // same start at every depth, so the later depths rapid into the kerf
        const lead = { in: li === 0, out: li === levels.length - 1 };
        let moves: Pt3[] | null = null;
        if (wantLead && p.lead && (lead.in || lead.out)) {
          // the arcs bend into the pocket: they must stay where the bit centre may go (inside the wall pass; the boundary itself counts)
          const clear = (q: Pt) => insideRegion(ring, q.x, q.y) || edgeDist(ring, q.x, q.y) < 1e-6;
          const body = lead.in ? buildMoves(loop, z, z, 2 * r, {}) : buildMoves(loop, zStart, z, 2 * r, { ramp: p.ramp });
          moves = leadMoves(body, zStart, z, p.lead, climb, lead, clear);
        }
        cuts.push({ loop, z, zStart, closed: true, ...airTo(p.start, zStart), moves: moves ?? buildMoves(loop, zStart, z, 2 * r, { ramp: p.ramp }) });
      }
    }
    zStart = z;
  }
  return { name: 'Pocket', tool: p.tool, cuts, feed: p.material.feed, plungeFeed: p.material.plungeFeed };
}

/** Follow lines exactly (no offset), e.g. engraving or fret slots. Closed lines keep their drawn direction. */
export function onLine(lines: Line[], p: CutParams): Toolpath {
  const cuts: Cut[] = [];
  let zStart = -(p.start ?? 0);
  for (const z of depthLevels(p.depth, p.material.stepdown, p.start)) {
    for (const raw of lines) {
      if (raw.pts.length < 2) continue;
      const pts = raw.closed ? (simplify([raw.pts])[0] ?? raw.pts) : simplifyOpen(raw.pts);
      const moves = raw.closed
        ? buildMoves(pts, zStart, z, p.tool.diameter, { ramp: p.ramp })
        : buildOpenMoves(pts, zStart, z, p.ramp);
      cuts.push({ loop: pts, z, zStart, closed: raw.closed, ...airTo(p.start, zStart), moves });
    }
    zStart = z;
  }
  return { name: 'On the line', tool: p.tool, cuts, feed: p.material.feed, plungeFeed: p.material.plungeFeed };
}

export interface DrillParams extends CutParams {
  /** Finished hole diameter, mm */
  holeDiameter: number;
}

/**
 * Drill round holes. A bit the same size as the hole plunges in pecks; a smaller bit
 * spirals the hole out with a circular pocket. Holes smaller than the bit are impossible.
 */
export function drill(centres: { x: number; y: number }[], p: DrillParams): Toolpath {
  const d = p.tool.diameter, D = p.holeDiameter;
  const s0 = p.start ?? 0;
  const levels = depthLevels(p.depth, p.material.stepdown, s0);
  const base = { name: `Drill ${D}mm holes`, tool: p.tool, feed: p.material.feed, plungeFeed: p.material.plungeFeed };
  if (D < d - 0.2 || !levels.length) return { ...base, cuts: [] };
  if (D - d < 0.2) {
    // Peck drilling: a short retract after every cut breaks the chip; every ~one hole diameter of
    // progress the bit comes fully out of the hole to clear chips, then rapids back down to 1 mm
    // above the bottom (through the open hole) before cutting on.
    const fullEvery = Math.max(2 * p.material.stepdown, D);
    const cuts: Cut[] = centres.map(c => {
      const moves: { x: number; y: number; z: number; rapid?: boolean }[] = [{ x: c.x, y: c.y, z: -s0 }];
      let sinceFull = 0, prevZ = -s0;
      levels.forEach((z, i) => {
        moves.push({ x: c.x, y: c.y, z });
        sinceFull += prevZ - z;
        prevZ = z;
        if (i === levels.length - 1) return;
        if (sinceFull >= fullEvery - 1e-9) {
          moves.push({ x: c.x, y: c.y, z: 1, rapid: true }, { x: c.x, y: c.y, z: z + 1, rapid: true });
          sinceFull = 0;
        } else moves.push({ x: c.x, y: c.y, z: z + 1, rapid: true });
      });
      return { loop: [{ x: c.x, y: c.y }, { x: c.x, y: c.y }], z: levels[levels.length - 1], zStart: -s0, closed: false, ...airTo(s0, -s0), moves };
    });
    return { ...base, cuts };
  }
  const circles = centres.map(c => Array.from({ length: 48 }, (_, i) => ({
    x: c.x + (D / 2) * Math.cos((2 * Math.PI * i) / 48), y: c.y + (D / 2) * Math.sin((2 * Math.PI * i) / 48),
  })));
  const tp = pocket(circles, { ...p, stepoverFraction: 0.4 });
  return { ...tp, name: base.name };
}

// ---------------------------------------------------------------------------------------------------------------
// Dogbone corners

/** A convex corner of the region being cut, i.e. an inside corner that a round bit cannot reach. */
export interface Corner { c: Pt; b: Pt; half: number }

/**
 * Convex corners of the cut region (interior angle between about 30 and 160 degrees). `region` must be normalised so
 * the cut region lies to the LEFT of every edge (outer loops counter-clockwise, holes clockwise). A turn to the left
 * there means the region is locally convex. Curves sampled into many tiny turns are ignored: only real corners count.
 */
export function insideCorners(region: Loop[]): Corner[] {
  const out: Corner[] = [];
  for (const l of region) {
    const n = l.length;
    for (let i = 0; i < n; i++) {
      const p = l[(i + n - 1) % n], v = l[i], q = l[(i + 1) % n];
      const ax = p.x - v.x, ay = p.y - v.y, bx = q.x - v.x, by = q.y - v.y;
      const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
      if (la < 1e-9 || lb < 1e-9) continue;
      const cross = (v.x - p.x) * (q.y - v.y) - (v.y - p.y) * (q.x - v.x);
      if (cross <= 0) continue;                                   // right turn or straight: not a convex corner of the region
      const cos = (ax * bx + ay * by) / (la * lb);
      const interior = Math.acos(Math.max(-1, Math.min(1, cos))); // angle between the two edges, 0..PI
      if (interior > (160 * Math.PI) / 180 || interior < (30 * Math.PI) / 180) continue;
      const ux = ax / la + bx / lb, uy = ay / la + by / lb, ul = Math.hypot(ux, uy);
      out.push({ c: v, b: { x: ux / ul, y: uy / ul }, half: interior / 2 });
    }
  }
  return out;
}

/**
 * Add a short excursion into each inside corner so the bit's edge just reaches the corner (a "dogbone"):
 * the tool-centre path reaches the corner point T = C + b * r / sin(half) and the relief goes to D = C + b * r, where
 * a circle of radius r centred on D passes through the corner C. The loop must be the cutter's centre path at radius r.
 */
export function addDogbones(loop: Loop, corners: Corner[], r: number): Loop {
  if (!corners.length || !(r > 0)) return loop;
  const out: Loop = [];
  for (const v of loop) {
    out.push(v);
    for (const k of corners) {
      const t = { x: k.c.x + (k.b.x * r) / Math.sin(k.half), y: k.c.y + (k.b.y * r) / Math.sin(k.half) };
      if (Math.hypot(v.x - t.x, v.y - t.y) > Math.max(0.05, 0.02 * r)) continue;
      const d = { x: k.c.x + k.b.x * r, y: k.c.y + k.b.y * r };
      if (Math.hypot(t.x - d.x, t.y - d.y) > 3 * r) continue;          // too sharp: the excursion would be huge
      out.push(d, { x: v.x, y: v.y });
      break;
    }
  }
  return out;
}
