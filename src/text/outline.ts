import type { OTFont } from 'opentype.js';
import type { Loop, Pt } from '../core/types';

export interface TextOptions {
  /** Height of capital letters in mm (what people mean by "text height") */
  capHeight: number;
  /** Extra space between letters, as a percentage of the capital height (can be negative) */
  tracking?: number;
  /** Distance between lines as a percentage of the font's natural line gap (100 = normal) */
  lineSpacing?: number;
  align?: 'left' | 'center' | 'right';
}

export interface TextShape { contours: Loop[]; width: number; height: number }

/** Largest chord error allowed when straightening letter curves, mm */
const TOL = 0.01;

function curvePoints(p0: Pt, ctrl: Pt[], tol: number): Pt[] {
  // Number of steps from the control polygon length: enough that the chord error stays under tol.
  let len = 0, prev = p0;
  for (const c of ctrl) { len += Math.hypot(c.x - prev.x, c.y - prev.y); prev = c; }
  const n = Math.min(64, Math.max(4, Math.ceil(Math.sqrt(len / tol) * 0.6)));
  const out: Pt[] = [];
  for (let k = 1; k <= n; k++) {
    const t = k / n, u = 1 - t;
    if (ctrl.length === 2) {
      out.push({ x: u * u * p0.x + 2 * u * t * ctrl[0].x + t * t * ctrl[1].x, y: u * u * p0.y + 2 * u * t * ctrl[0].y + t * t * ctrl[1].y });
    } else {
      out.push({
        x: u * u * u * p0.x + 3 * u * u * t * ctrl[0].x + 3 * u * t * t * ctrl[1].x + t * t * t * ctrl[2].x,
        y: u * u * u * p0.y + 3 * u * u * t * ctrl[0].y + 3 * u * t * t * ctrl[1].y + t * t * t * ctrl[2].y,
      });
    }
  }
  return out;
}

/** Height of a capital letter in font units, measured from the letter H. */
export function capHeightUnits(font: OTFont): number {
  const bb = font.charToGlyph('H').getBoundingBox();
  return bb.y2 > 0 ? bb.y2 : font.unitsPerEm * 0.7;
}

/**
 * Turn text into closed outlines in mm, Y up. The origin is the left end of the first line's baseline
 * (for centre/right alignment: the middle/right end). Letters with holes (O, B, 8...) give extra inner contours;
 * the importer's even-odd fill turns those into proper holes.
 */
export function textToContours(font: OTFont, text: string, opts: TextOptions): TextShape {
  const s = opts.capHeight / capHeightUnits(font);          // font units -> mm
  const em = font.unitsPerEm * s;                           // size of one em in mm
  const tracking = ((opts.tracking ?? 0) / 100) * opts.capHeight;
  const lineStep = em * 1.2 * ((opts.lineSpacing ?? 100) / 100);
  const lines = text.replace(/\r/g, '').split('\n');
  const contours: Loop[] = [];
  let maxW = 0;

  // First pass: width of each line, for alignment.
  const widths = lines.map(line => {
    let x = 0, prev = null as ReturnType<OTFont['charToGlyph']> | null;
    for (const ch of line) {
      const g = font.charToGlyph(ch);
      if (prev) x += font.getKerningValue(prev, g) * s;
      x += (g.advanceWidth ?? 0) * s + tracking;
      prev = g;
    }
    return line.length ? x - tracking : 0;
  });
  maxW = Math.max(0, ...widths);

  lines.forEach((line, row) => {
    const baseline = -row * lineStep;
    const offset = opts.align === 'center' ? -widths[row] / 2 : opts.align === 'right' ? -widths[row] : 0;
    let x = offset, prev = null as ReturnType<OTFont['charToGlyph']> | null;
    for (const ch of line) {
      const g = font.charToGlyph(ch);
      if (prev) x += font.getKerningValue(prev, g) * s;
      // glyph.getPath scales to `em` mm and flips Y (down is positive): we flip it back
      const cmds = g.getPath(x, 0, em).commands;
      let cur: Loop = [], pos: Pt = { x: 0, y: 0 }, start: Pt = { x: 0, y: 0 };
      const flush = () => { if (cur.length >= 3) contours.push(cur); cur = []; };
      for (const c of cmds) {
        if (c.type === 'M') { flush(); pos = start = { x: c.x!, y: -c.y! + baseline }; cur = [pos]; }
        else if (c.type === 'L') { pos = { x: c.x!, y: -c.y! + baseline }; cur.push(pos); }
        else if (c.type === 'Q') {
          const pts = curvePoints(pos, [{ x: c.x1!, y: -c.y1! + baseline }, { x: c.x!, y: -c.y! + baseline }], TOL);
          cur.push(...pts); pos = pts[pts.length - 1];
        } else if (c.type === 'C') {
          const pts = curvePoints(pos, [{ x: c.x1!, y: -c.y1! + baseline }, { x: c.x2!, y: -c.y2! + baseline }, { x: c.x!, y: -c.y! + baseline }], TOL);
          cur.push(...pts); pos = pts[pts.length - 1];
        } else if (c.type === 'Z') { flush(); pos = start; }
      }
      flush();
      x += (g.advanceWidth ?? 0) * s + tracking;
      prev = g;
    }
  });
  // Drop the repeated closing point some glyphs have.
  for (const c of contours) {
    const a = c[0], b = c[c.length - 1];
    if (c.length > 3 && Math.hypot(a.x - b.x, a.y - b.y) < 1e-6) c.pop();
  }
  return { contours, width: maxW, height: opts.capHeight + (lines.length - 1) * lineStep };
}

/** Rotate by `deg` (counter-clockwise) and move by (dx, dy). */
export function placeContours(contours: Loop[], dx: number, dy: number, deg = 0): Loop[] {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return contours.map(l => l.map(p => ({ x: p.x * c - p.y * s + dx, y: p.x * s + p.y * c + dy })));
}
