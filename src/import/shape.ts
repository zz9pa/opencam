import type { Loop } from '../core/types';
import { minOf, maxOf } from '../core/util';

/** A line as read from a file, before ids are assigned. Coordinates in mm, Y up. */
export interface RawShape {
  layer: string; pts: Loop; closed: boolean;
  /** Point index range [from, to) along a closed shape that is not a real wall but an open side (e.g. where a recess runs out through the edge of a part). A pocket lets the bit run out past it. */
  free?: [number, number];
}

export interface Shape extends RawShape {
  id: number;
  /** Bounding box in mm (drawing frame, Y up) */
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
}

export function finalize(raw: RawShape[]): Shape[] {
  return raw.map((s, id) => {
    const xs = s.pts.map(p => p.x), ys = s.pts.map(p => p.y);
    return { ...s, id, bbox: { minX: minOf(xs), minY: minOf(ys), maxX: maxOf(xs), maxY: maxOf(ys) } };
  });
}

export interface ImportOptions {
  /** mm per drawing unit. Undefined = read it from the file. */
  unitScale?: number;
  /** Extra uniform scale, percent (100 = unchanged) */
  scalePct: number;
  /** Join open pieces whose ends are within this many mm */
  joinTol: number;
  /**
   * Close a single line whose own two ends are within this many mm, provided the gap is also tiny
   * compared with the line's length (so a short open line is never closed by accident).
   */
  closeTol: number;
  dedupe: boolean;
}

/** A piece of text found in a drawing file, to be turned into outlines with one of our bundled fonts. */
export interface TextItem {
  layer: string;
  text: string;
  /** Anchor point in mm (drawing frame, Y up): the baseline start, or middle/end depending on `anchor` */
  x: number;
  y: number;
  /** Letter size in mm. `em` = the font size as drawing programs state it; `cap` = height of capital letters */
  size: number;
  sizeIs: 'em' | 'cap';
  /** Counter-clockwise degrees */
  rotation: number;
  anchor: 'start' | 'middle' | 'end';
  family: string;
  weight: string | number;
}

export interface ParsedDrawing {
  shapes: RawShape[];
  /** Text to convert to outlines (done by the app, which loads the fonts) */
  texts?: TextItem[];
  /** Things the user should know (ignored items, assumptions) */
  notes: string[];
  /** What the file said its units were, or null if it didn't say */
  fileUnits: string | null;
  /** mm per drawing unit actually used */
  scaleToMm: number;
}

export const DEFAULT_IMPORT: ImportOptions = { scalePct: 100, joinTol: 0.05, closeTol: 2, dedupe: true };
