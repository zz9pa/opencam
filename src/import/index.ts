import { cleanShapes, type JoinStats } from './join';
import { finalize, type ImportOptions, type ParsedDrawing, type Shape } from './shape';

export type { ImportOptions, Shape } from './shape';
export { DEFAULT_IMPORT } from './shape';

export interface ImportReport {
  /** Plain-English lines for the user */
  notes: string[];
  fileUnits: string | null;
  scaleToMm: number;
  /** Size of everything imported, mm */
  size: { w: number; h: number } | null;
  stats: JoinStats;
  closed: number;
  open: number;
}

/** Scale, clean up (join pieces, remove duplicates) and number the shapes. Pure: runs in Node too. */
export function processImport(parsed: ParsedDrawing, opts: ImportOptions): { shapes: Shape[]; report: ImportReport } {
  const k = opts.scalePct / 100;
  const scaled = k === 1 ? parsed.shapes : parsed.shapes.map(s => ({ ...s, pts: s.pts.map(p => ({ x: p.x * k, y: p.y * k })) }));
  const { shapes: cleaned, stats } = cleanShapes(scaled, { joinTol: opts.joinTol, closeTol: opts.closeTol, dedupe: opts.dedupe });
  const shapes = finalize(cleaned);
  const notes = [...parsed.notes];
  if (stats.piecesMerged) notes.push(`Joined ${stats.piecesMerged} separate pieces into longer lines${stats.closedCreated ? `, making ${stats.closedCreated} closed outline(s)` : ''}.`);
  else if (stats.closedCreated) notes.push(`Closed ${stats.closedCreated} line(s) whose ends nearly met.`);
  if (stats.largestClosedGap > 0.05) notes.push(`Some outlines had a small gap that was closed with a straight line (the largest was ${stats.largestClosedGap.toFixed(2)} mm).`);
  if (stats.ambiguousJunctions) notes.push(`${stats.ambiguousJunctions} point(s) where 3 or more lines meet were left unjoined, because it is unclear which way the outline goes.`);
  if (stats.duplicatesRemoved) notes.push(`Removed ${stats.duplicatesRemoved} duplicate line(s) drawn on top of each other.`);
  if (stats.tinyRemoved) notes.push(`Removed ${stats.tinyRemoved} tiny speck(s).`);
  let size: ImportReport['size'] = null;
  if (shapes.length) {
    const minX = Math.min(...shapes.map(s => s.bbox.minX)), maxX = Math.max(...shapes.map(s => s.bbox.maxX));
    const minY = Math.min(...shapes.map(s => s.bbox.minY)), maxY = Math.max(...shapes.map(s => s.bbox.maxY));
    size = { w: maxX - minX, h: maxY - minY };
  }
  return {
    shapes,
    report: { notes, fileUnits: parsed.fileUnits, scaleToMm: parsed.scaleToMm * k, size, stats, closed: shapes.filter(s => s.closed).length, open: shapes.filter(s => !s.closed).length },
  };
}
