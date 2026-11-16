import { minOf, maxOf } from './util';
import type { Cut, Direction, Loop, Material, Tool, Toolpath } from './types';
import { normalize, offset, reverse, signedArea } from './geometry';
import type { RampParams } from './entry';
import { linkRings } from './ringlink';
import { depthLevels, pocket, profile } from './ops';
import { maxVDepth, surfaceRadius, vcarve } from './vcarve';

/**
 * V-inlay: a recess (female) and a matching insert (male) cut with the same V-bit.
 *
 * Geometry (P = recess depth, g = glue gap, tan = tan(half the V angle)):
 *  - Female: V-carve with a flat floor at depth P. Its walls slope inward from the outline by delta = P * tan.
 *  - Male: carved on a separate blank, MIRRORED so it reads correctly once flipped over into the recess. The shapes
 *    stand up as islands: top inset by delta, widening to the outline at depth P (the inverse of the recess). The
 *    background around them is cut to depth P + g, so the insert sits proud by g and can be sanded flush after gluing.
 *  - A cut-out outline for the male blank is returned so it can be cut free with an ordinary operation.
 */
export interface InlayParams {
  /** Must be a V-bit */
  tool: Tool;
  material: Material;
  /** Recess depth, mm */
  depth: number;
  /** How far the insert sits proud of the surface when pressed home, mm */
  glueGap: number;
  /** Width of flat background cut around the lettering on the male blank, beyond the sloped wall, mm */
  moat: number;
  direction: Direction;
  ramp?: RampParams;
}

export interface InlayResult {
  toolpath: Toolpath;
  /** Outline of the male blank (the carved region), in the same frame as the mirrored male, for cutting it free */
  blank: Loop[];
  warnings: string[];
  /** The mirror line (x) used for the male */
  mirrorX: number;
}

const area = (loops: Loop[]) => loops.reduce((s, l) => s + signedArea(l), 0);

export function inlay(shapes: Loop[], p: InlayParams): InlayResult {
  const warnings: string[] = [];
  const region = normalize(shapes);
  const tan = Math.tan((((p.tool.angle ?? 60) * Math.PI) / 360));
  const empty = (): InlayResult => ({ toolpath: { name: 'Inlay', tool: p.tool, cuts: [], feed: p.material.feed, plungeFeed: p.material.plungeFeed }, blank: [], warnings, mirrorX: 0 });
  if (!region.length) return empty();

  const xs = region.flat().map(q => q.x);
  const mirrorX = (minOf(xs) + maxOf(xs)) / 2;
  const mirrored = normalize(region.map(l => l.map(q => ({ x: 2 * mirrorX - q.x, y: q.y }))));

  const P = p.depth, g = Math.max(0, p.glueGap), Pm = P + g;
  if (Pm > maxVDepth(p.tool) + 1e-9) warnings.push(`This V-bit is only ${p.tool.diameter} mm wide, so it cannot cut ${Pm.toFixed(1)} mm deep (the most is ${maxVDepth(p.tool).toFixed(1)} mm). Use a wider V-bit or a shallower recess.`);

  // ----- female: V-carve with a flat floor at depth P
  // A modest clearing step keeps the recess floor smooth enough (ridge = step / 2 / tan) for the insert to seat.
  const female = vcarve(region, { tool: p.tool, material: p.material, maxDepth: P, direction: p.direction, wide: 'clear', clearStep: 0.2, ramp: p.ramp });
  const cuts: Cut[] = female.cuts.map(c => ({ ...c, tag: 'female' }));

  // ----- male: islands = mirrored shapes inset by delta
  const delta = P * tan;
  const island = offset(mirrored, -delta);
  if (!island.length) {
    warnings.push(`Every stroke is thinner than ${(2 * delta).toFixed(1)} mm, so there is nothing left to stand up as an insert at this depth. Use a shallower recess, a narrower V angle is not the answer (a wider one is), or bolder lettering.`);
  } else {
    // Strokes thinner than 2 * delta vanish when inset: the recess would have a groove with no insert for it.
    const rebuilt = offset(island, delta);
    const lost = 1 - Math.abs(area(rebuilt)) / Math.max(1e-9, Math.abs(area(mirrored)));
    if (lost > 0.02) warnings.push(`Parts of the design are thinner than ${(2 * delta).toFixed(1)} mm and cannot be inlaid at ${P} mm depth (about ${(lost * 100).toFixed(0)}% of the area). The recess is cut there but the insert has no matching piece. Use a shallower depth or bolder shapes.`);
  }

  const male: Cut[] = [];
  if (island.length) {
    // The sloped walls: a V-bit following the outside of the island, deeper level by level. This is exactly the
    // "profile outside" operation, because the V-bit's per-depth offset puts the cone's edge on the island outline.
    const wall = profile(island, 'outside', { tool: p.tool, material: p.material, depth: Pm, direction: p.direction, ramp: p.ramp });
    male.push(...wall.cuts);
    // The flat background beyond the wall: concentric rings at each depth step, out to the moat width.
    const r0 = surfaceRadius(p.tool, Pm);
    // The background floor is only the base of the insert blank and gets sanded away, so a coarse step is fine
    // (a ridge of step / 2 / tan). Rings are linked so the bit steps across at depth instead of lifting out each time.
    const step = 0.5;
    const levels = depthLevels(Pm, p.material.stepdown);
    const reach = r0 + Math.max(0, p.moat);
    // Outside the lettering the background is cut out to the moat width. Inside a letter's hole (the counter of an O,
    // a B, an 8...) it must be cut away completely, or a bump would be left that cannot fit the recess.
    const oriented: Loop[] = [];
    for (let d = r0 + step, guard = 0; guard < 900; d += step, guard++) {
      let rings = offset(island, d);
      if (d > reach + 1e-9) rings = rings.filter(l => signedArea(l) < 0);   // only the shrinking counters remain
      if (!rings.length) break;
      for (const ring of rings) {
        const toolOutside = signedArea(ring) > 0;                           // outer loops: the tool is outside the island
        const want = toolOutside !== (p.direction === 'climb');             // climb: outside = CW, inside (counters) = CCW
        oriented.push((signedArea(ring) > 0) === want ? ring : reverse(ring));
      }
    }
    let zPrev = 0;
    for (const z of levels) {
      male.push(...linkRings(oriented, z, zPrev, { ramp: p.ramp, linkMax: step * 3 }));
      zPrev = z;
    }
    male.forEach((c, i) => { c.tag = 'male'; if (i === 0) c.pauseBefore = 'SWAP THE BOARD: the recess is finished.\nPut the MALE blank on the machine in the same position, face up, and set Z zero on its top surface.\nThe lettering is mirrored on purpose: flip the finished insert over to glue it in.'; });
  }
  cuts.push(...male);

  // The male blank: the carved region, kept just inside it so no uncut rim is left around the carving.
  const blank = island.length ? offset(island, surfaceRadius(p.tool, Pm) + Math.max(0, p.moat) - 0.2).filter(l => signedArea(l) > 0) : [];
  return {
    toolpath: { name: 'Inlay: recess then insert', tool: p.tool, cuts, feed: p.material.feed, plungeFeed: p.material.plungeFeed, meta: { recessDepth: P, insertDepth: Pm, inset: delta } },
    blank, warnings, mirrorX,
  };
}

/** How much smaller than the recess the insert is cut, so it goes in without force and leaves a hairline for glue, mm */
export const FLAT_FIT = 0.1;

export interface FlatInlayParams {
  /** A flat (or ball) bit */
  tool: Tool;
  material: Material;
  /** Recess depth, mm */
  depth: number;
  /** How far the insert stands above the surface when pressed home (the insert board is depth + proud thick), mm */
  proud: number;
  direction: Direction;
  ramp?: RampParams;
}

/**
 * Flat-bottom inlay: a pocket in the base board, then the same shape cut out of the insert board (face up, not mirrored).
 * A round bit rounds every convex corner of a pocket and every concave corner of a cut-out, so both pieces are cut to the
 * same shape: the design with convex corners rounded by the bit radius and concave corners filled to it (an opening then a
 * closing). The insert is FLAT_FIT smaller all round. Holding tabs keep the insert in its board.
 */
export function inlayFlat(shapes: Loop[], p: FlatInlayParams): { toolpath: Toolpath; warnings: string[] } {
  const warnings: string[] = [];
  const base = { name: 'Flat inlay: recess then insert', tool: p.tool, feed: p.material.feed, plungeFeed: p.material.plungeFeed };
  const region = normalize(shapes);
  const r = p.tool.diameter / 2;
  if (!region.length || !(p.depth > 0)) return { toolpath: { ...base, cuts: [] }, warnings };
  const filled = offset(offset(region, r), -r);                  // closing: the bit cannot reach into tight concave corners
  const shape = offset(offset(filled, -r), r);                   // opening: nor into the point of a convex corner
  if (!shape.length) {
    warnings.push(`Every part of the design is narrower than the ${p.tool.diameter} mm bit, so nothing can be cut. Use a smaller bit.`);
    return { toolpath: { ...base, cuts: [] }, warnings };
  }
  const lost = 1 - Math.abs(area(shape)) / Math.max(1e-9, Math.abs(area(region)));
  if (lost > 0.02) warnings.push(`Fine detail narrower than the ${p.tool.diameter} mm bit is lost (about ${(lost * 100).toFixed(0)}% of the area), and every sharp corner is rounded to the bit radius on the recess and on the insert. A smaller bit keeps more.`);
  else warnings.push(`Corners are rounded to the ${p.tool.diameter} mm bit radius on the recess and on the insert, so they fit each other.`);

  const common = { tool: p.tool, material: p.material, direction: p.direction, ramp: p.ramp };
  const recess = pocket(shape, { ...common, depth: p.depth, stepoverFraction: 0.4 });
  const cuts: Cut[] = recess.cuts.map(c => ({ ...c, tag: 'female' }));

  const insertDepth = p.depth + Math.max(0, p.proud);
  const insertShape = offset(shape, -FLAT_FIT);
  if (insertShape.length) {
    const cut = profile(insertShape, 'outside', { ...common, depth: insertDepth, tabs: { count: 3, width: 4, height: Math.min(1.5, insertDepth / 2) } });
    const male: Cut[] = cut.cuts.map(c => ({ ...c, tag: 'male' }));
    if (male.length) male[0].pauseBefore = `SWAP THE BOARD: the recess is finished.
Put the INSERT board on the machine in the same position, face up, and set Z zero on its top surface.
It must be ${+insertDepth.toFixed(2)} mm thick (recess ${p.depth} mm + ${p.proud} mm proud).`;
    cuts.push(...male);
  }
  return { toolpath: { ...base, cuts, meta: { recessDepth: p.depth, insertDepth } }, warnings };
}
