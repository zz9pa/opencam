export interface Box { minX: number; minY: number; maxX: number; maxY: number }
export type ZeroMode = 'corner' | 'part' | 'centre';

/**
 * How far to move a single-sided job so X/Y zero is where the user wants it.
 * - corner: the toolpath's own lower-left sits `margin` mm in from the work-area corner.
 * - part: zero at the lower-left corner of the part (`part`, or the toolpath bounds `path` if there is no part box).
 * - centre: zero at the centre of the part.
 * `part` is the box round the shapes being cut, not the path the bit's edge takes round them.
 */
export function zeroOffset(mode: ZeroMode, path: Box, part: Box | null, margin: number): { dx: number; dy: number } {
  const ref = (mode === 'corner' ? null : part) ?? path;
  return {
    dx: mode === 'corner' ? margin - path.minX : mode === 'part' ? -ref.minX : -(ref.minX + ref.maxX) / 2,
    dy: mode === 'corner' ? margin - path.minY : mode === 'part' ? -ref.minY : -(ref.minY + ref.maxY) / 2,
  };
}

/** Two-sided jobs: the stock is centred on the turn-over line, so the front outline's centre goes to the stock's centre. */
export function stockOffset(stockW: number, stockH: number, flipCentre: { x: number; y: number }): { dx: number; dy: number } {
  return { dx: stockW / 2 - flipCentre.x, dy: stockH / 2 - flipCentre.y };
}
