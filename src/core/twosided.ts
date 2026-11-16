import { minOf, maxOf } from './util';
import type { Loop, Pt } from './types';

/**
 * How the stock is turned over between side 1 and side 2.
 * 'tb' = top-to-bottom (rotate about a horizontal X-direction axis; Y is mirrored)
 * 'lr' = left-to-right (rotate about a vertical axis; X is mirrored)
 */
export type Flip = 'tb' | 'lr';

export function bboxOf(pts: Pt[]) {
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  return { minX: minOf(xs), minY: minOf(ys), maxX: maxOf(xs), maxY: maxOf(ys) };
}
export function bboxCentre(pts: Pt[]): Pt {
  const b = bboxOf(pts);
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
}

export type MirrorMatch = 'same' | 'flipX' | 'flipY' | 'rot180';

function sample(pts: Pt[], n = 80): Pt[] {
  const step = Math.max(1, Math.floor(pts.length / n));
  return pts.filter((_, i) => i % step === 0);
}
function normalised(pts: Pt[], fx: boolean, fy: boolean): Pt[] {
  const b = bboxOf(pts);
  const w = b.maxX - b.minX || 1, h = b.maxY - b.minY || 1;
  return sample(pts).map(p => {
    const u = (p.x - b.minX) / w, v = (p.y - b.minY) / h;
    return { x: fx ? 1 - u : u, y: fy ? 1 - v : v };
  });
}
function chamfer(a: Pt[], b: Pt[]): number {
  let t = 0;
  for (const p of a) {
    let m = Infinity;
    for (const q of b) m = Math.min(m, Math.hypot(p.x - q.x, p.y - q.y));
    t += m;
  }
  return t / a.length;
}

/**
 * Compare a front outline to a back outline and say how the back is oriented relative to the front.
 * 'flipY' (top-to-bottom mirror) is what a part turned over top-to-bottom looks like.
 */
export function detectMirror(front: Loop, back: Loop): { match: MirrorMatch; dist: Record<MirrorMatch, number> } {
  const f = normalised(front, false, false);
  const dist: Record<MirrorMatch, number> = {
    same: chamfer(f, normalised(back, false, false)),
    flipX: chamfer(f, normalised(back, true, false)),
    flipY: chamfer(f, normalised(back, false, true)),
    rot180: chamfer(f, normalised(back, true, true)),
  };
  const match = (Object.keys(dist) as MirrorMatch[]).reduce((a, k) => (dist[k] < dist[a] ? k : a));
  return { match, dist };
}

/** The flip direction and "already mirrored?" implied by a detected match. */
export function settingsFromMatch(m: MirrorMatch): { flip: Flip; preMirrored: boolean } {
  switch (m) {
    case 'flipY': return { flip: 'tb', preMirrored: true };
    case 'flipX': return { flip: 'lr', preMirrored: true };
    default: return { flip: 'tb', preMirrored: false };
  }
}

/**
 * Move back-side geometry into the front drawing's frame so it lines up with the front
 * once the stock has been turned over.
 * - preMirrored: the back drawing is already what you see from above after flipping.
 * - otherwise it is mirrored about the back outline's own centre first.
 * The back outline's centre is then laid over the front outline's centre
 * (both centres are on the flip axis by definition).
 */
export function alignBack(pts: Loop, frontRef: Loop, backRef: Loop, flip: Flip, preMirrored: boolean): Loop {
  const fc = bboxCentre(frontRef), bc = bboxCentre(backRef);
  return pts.map(p => {
    let x = p.x, y = p.y;
    if (!preMirrored) {
      if (flip === 'tb') y = 2 * bc.y - y; else x = 2 * bc.x - x;
    }
    return { x: x + (fc.x - bc.x), y: y + (fc.y - bc.y) };
  });
}

export interface DowelLayout {
  /**
   * 3 = keyed: one dowel at one end of the turn-over line, a pair at the other end. It only fits
   * one way round. 2 and 4 are symmetric and can be fitted rotated or flipped the wrong way.
   */
  count: 2 | 3 | 4;
  /** Gap between the part's extent and the nearest dowel centre-line, mm */
  distance: number;
  /** Distance between a pair of dowels (count 4), mm */
  pairSpacing: number;
}

/**
 * Dowel centres on both sides of the part, symmetric about the flip axis so each hole lands on
 * another hole after turning the stock over. `axis` is the centre of the flip axis in the same frame.
 */
export function dowelPositions(part: { minX: number; minY: number; maxX: number; maxY: number }, axis: Pt, flip: Flip, l: DowelLayout): Pt[] {
  const out: Pt[] = [];
  const h = l.pairSpacing / 2;
  if (l.count === 3) {
    // Isosceles triangle: apex on the axis at the low end, a mirrored pair at the high end.
    if (flip === 'tb') {
      out.push({ x: part.minX - l.distance, y: axis.y }, { x: part.maxX + l.distance, y: axis.y - h }, { x: part.maxX + l.distance, y: axis.y + h });
    } else {
      out.push({ x: axis.x, y: part.minY - l.distance }, { x: axis.x - h, y: part.maxY + l.distance }, { x: axis.x + h, y: part.maxY + l.distance });
    }
    return out;
  }
  const offs = l.count === 2 ? [0] : [-h, h];
  if (flip === 'tb') {
    for (const o of offs) {
      out.push({ x: part.minX - l.distance, y: axis.y + o }, { x: part.maxX + l.distance, y: axis.y + o });
    }
  } else {
    for (const o of offs) {
      out.push({ x: axis.x + o, y: part.minY - l.distance }, { x: axis.x + o, y: part.maxY + l.distance });
    }
  }
  return out;
}

/** Where a point goes when the stock is turned over about the axis. */
export function flipPoint(p: Pt, axis: Pt, flip: Flip): Pt {
  return flip === 'tb' ? { x: p.x, y: 2 * axis.y - p.y } : { x: 2 * axis.x - p.x, y: p.y };
}

/** Smallest stock (centred on the axis) that holds the part and the dowels. */
export function suggestStock(part: { minX: number; minY: number; maxX: number; maxY: number }, axis: Pt, flip: Flip, l: DowelLayout, dowelDia: number, edge = 10) {
  // Dowels sit beyond the part along the axis direction; pairs also spread sideways.
  const along = l.distance + dowelDia / 2;
  const across = l.count >= 3 ? l.pairSpacing / 2 + dowelDia / 2 : 0;
  const halfW = Math.max(axis.x - part.minX, part.maxX - axis.x) + (flip === 'tb' ? along : across) + edge;
  const halfH = Math.max(axis.y - part.minY, part.maxY - axis.y) + (flip === 'tb' ? across : along) + edge;
  return { width: 2 * halfW, height: 2 * halfH };
}

/**
 * Wrong ways the stock could still be seated on the dowels, even allowing it to be slid around:
 * turned over about the wrong axis, or spun 180 degrees flat. Empty means the layout is keyed.
 * (Putting the stock back on without turning it over can't be detected from hole positions:
 * mark the top face of the stock before side 1.)
 */
export function wrongFits(dowels: Pt[], axis: Pt, flip: Flip, tol: number): string[] {
  const out: string[] = [];
  const wrongFlip = (p: Pt): Pt => flipPoint(p, axis, flip === 'tb' ? 'lr' : 'tb');
  const rot180 = (p: Pt): Pt => ({ x: 2 * axis.x - p.x, y: 2 * axis.y - p.y });
  const fits = (map: (p: Pt) => Pt): boolean => {
    const t = dowels.map(map);
    return dowels.some(target => {
      const dx = target.x - t[0].x, dy = target.y - t[0].y;
      return t.every(p => dowels.some(q => Math.hypot(q.x - (p.x + dx), q.y - (p.y + dy)) < tol));
    });
  };
  if (fits(wrongFlip)) out.push(`turned over about the ${flip === 'tb' ? 'vertical' : 'horizontal'} line instead`);
  if (fits(rot180)) out.push('spun 180 degrees without turning it over');
  return out;
}

export type DowelMode = 'spoil' | 'spoilfirst' | 'blind';

export interface DowelHoleInput {
  /**
   * 'spoil': holes go through the stock and into the spoilboard in one go.
   * 'spoilfirst': for thick stock. Shallow holes are drilled in the empty spoilboard first (step 0), then shallow
   *   blind holes in the top of the stock (side 1); the dowels go in the spoilboard after side 1, before the flip.
   * 'blind': half the dowel goes in each of two mating pieces (e.g. a neck joint).
   */
  mode: DowelMode;
  stockT: number;
  dowelLen: number;
  dowelDia: number;
  spoilT: number;
  /** Deepest the drill can go (bit cutting length / Z travel), mm. 0 = no limit known. */
  maxDepth: number;
}

export interface DowelHole {
  /** Depth to drill in the STOCK during side 1 (capped by maxDepth), mm */
  depth: number;
  /** Depth to drill in the empty spoilboard in step 0 (spoilfirst mode only, else 0), mm */
  spoilDepth: number;
  /** Depth the dowel really needs for the stock holes, mm */
  wanted: number;
  capped: boolean;
  /** How far the dowel sits in the spoilboard */
  intoSpoil: number;
  /** How far the dowel stands up into the stock (or sits in this piece, blind mode) */
  intoStock: number;
  /** Gap between the dowel top and the stock top surface (spoil mode) */
  topGap: number;
  warnings: string[];
  summary: string;
}

const BOTTOM_CLEARANCE = 1;   // mm of extra hole below the dowel for dust
const TOP_GAP = 3;            // mm the dowel top must stay below the stock top so the router never touches it
const SPOIL_FLOOR = 3;        // mm of spoilboard left under the hole

/**
 * Work out how deep to drill the dowel holes.
 * The dowel sits about half in the spoilboard and half up in the stock, sinking further into the spoilboard if
 * the stock is too thin to hide the top half.
 */
export function dowelHole(i: DowelHoleInput): DowelHole {
  const warnings: string[] = [];
  const minEngage = Math.max(8, 1.5 * i.dowelDia);
  const cap = i.maxDepth > 0 ? i.maxDepth : Infinity;
  const f = (n: number) => String(Math.round(n * 10) / 10);
  let wanted: number, intoSpoil = 0, intoStock: number, topGap = 0, spoilDepth = 0;

  if (i.mode === 'blind') {
    intoStock = i.dowelLen / 2;
    wanted = intoStock + BOTTOM_CLEARANCE;
    if (wanted > i.stockT - TOP_GAP) warnings.push(`These holes (${Math.ceil(wanted)} mm) nearly go right through ${i.stockT} mm stock. Use a shorter dowel.`);
    if (intoStock < minEngage - 1e-9) warnings.push(`Only ${intoStock.toFixed(0)} mm of the dowel sits in each piece; aim for at least ${Math.ceil(minEngage)} mm.`);
    const depth = Math.min(wanted, cap), capped = wanted > cap + 1e-9;
    if (capped) warnings.push(`The holes need to be ${Math.ceil(wanted)} mm deep but your bit can only cut ${cap} mm. They are limited to ${cap} mm: use a shorter dowel.`);
    const lead = capped ? `Needs ${f(wanted)} mm (half of the ${f(i.dowelLen)} mm dowel + ${BOTTOM_CLEARANCE} clearance) but limited to ${f(depth)} mm.`
      : `Holes ${f(depth)} mm deep: half of the ${f(i.dowelLen)} mm dowel (${f(intoStock)} mm) in each piece + ${BOTTOM_CLEARANCE} clearance.`;
    return { depth, spoilDepth: 0, wanted, capped, intoSpoil: 0, intoStock, topGap: 0, warnings, summary: lead };
  }

  const spoilMax = i.spoilT - SPOIL_FLOOR;
  let s = Math.min(Math.max(i.dowelLen / 2, minEngage), spoilMax);
  let p = i.dowelLen - s;
  if (p > i.stockT - TOP_GAP) { p = i.stockT - TOP_GAP; s = i.dowelLen - p; }
  if (s > spoilMax + 1e-9) {
    const maxLen = i.stockT - TOP_GAP + spoilMax;
    warnings.push(`A ${i.dowelLen} mm dowel is too long for ${i.stockT} mm stock on ${i.spoilT} mm of spoilboard (the most it fits is ${Math.max(0, Math.floor(maxLen))} mm). Use a shorter dowel or a thicker spoilboard.`);
  } else if (spoilMax < minEngage) {
    warnings.push(`The spoilboard is too thin to hold a dowel: it needs at least ${Math.ceil(minEngage + SPOIL_FLOOR)} mm.`);
  }
  if (p < minEngage - 1e-9) {
    warnings.push(`Only ${Math.max(0, Math.round(p))} mm of the dowel would stand up into the stock; it should be at least ${Math.ceil(minEngage)} mm to hold it properly. Use a longer dowel.`);
  }
  intoSpoil = s; intoStock = p; topGap = i.stockT - p;

  if (i.mode === 'spoil') {
    wanted = i.stockT + s + BOTTOM_CLEARANCE;
    const depth = Math.min(wanted, cap), capped = wanted > cap + 1e-9;
    if (capped) {
      warnings.push(`The holes need to be ${Math.ceil(wanted)} mm deep but your bit can only cut ${cap} mm. They are limited to ${cap} mm and will ${cap < i.stockT ? 'not even go through the stock' : 'NOT reach the spoilboard'}, so the dowels will not hold. Use a longer drill, thinner stock, a shorter dowel, or switch to "spoilboard first".`);
    }
    const parts = `${f(i.stockT)} through the stock + ${f(s)} into the spoilboard + ${BOTTOM_CLEARANCE} clearance`;
    const lead = capped ? `Needs ${f(wanted)} mm (${parts}) but limited to ${f(depth)} mm.` : `Holes ${f(depth)} mm deep: ${parts}.`;
    return { depth, spoilDepth: 0, wanted, capped, intoSpoil, intoStock, topGap,
      warnings, summary: `${lead} A ${f(i.dowelLen)} mm dowel stands ${f(p)} mm up into the stock, ${f(topGap)} mm below its top surface.` };
  }

  // spoilfirst: two shallow drilling jobs instead of one deep one.
  spoilDepth = s + BOTTOM_CLEARANCE;
  wanted = p + BOTTOM_CLEARANCE;                     // blind hole in the stock
  const depth = Math.min(wanted, cap);
  const capped = wanted > cap + 1e-9 || spoilDepth > cap + 1e-9;
  if (wanted > cap + 1e-9) warnings.push(`The holes in the stock need to be ${Math.ceil(wanted)} mm deep but your bit can only cut ${cap} mm. Use a shorter dowel.`);
  if (spoilDepth > cap + 1e-9) warnings.push(`The spoilboard holes need to be ${Math.ceil(spoilDepth)} mm deep but your bit can only cut ${cap} mm. Use a shorter dowel.`);
  const sd = Math.min(spoilDepth, cap);
  const summary = `Step 0 (empty spoilboard): holes ${f(sd)} mm deep. Side 1 (stock): blind holes ${f(depth)} mm deep. ` +
    `Dowel ${f(i.dowelLen)} mm: ${f(s)} mm in the spoilboard, ${f(p)} mm standing up into the stock.`;
  return { depth, spoilDepth: sd, wanted, capped, intoSpoil, intoStock, topGap, warnings, summary };
}
