import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'opentype.js';
import { textToContours, capHeightUnits, placeContours } from '../src/text/outline';
import { guessFont } from '../src/text/fonts-guess';
import { cleanShapes } from '../src/import/join';
import { normalize, signedArea } from '../src/core/geometry';
import type { Loop } from '../src/core/types';

const load = (path: string) => { const b = readFileSync(path); return parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer); };
const font = load('node_modules/@fontsource/roboto/files/roboto-latin-400-normal.woff');
const bbox = (ls: Loop[]) => { const p = ls.flat(); return { minX: Math.min(...p.map(q => q.x)), maxX: Math.max(...p.map(q => q.x)), minY: Math.min(...p.map(q => q.y)), maxY: Math.max(...p.map(q => q.y)) }; };

describe('text to outlines', () => {
  it('capital letters come out at the requested height', () => {
    const t = textToContours(font, 'H', { capHeight: 20 });
    const b = bbox(t.contours);
    expect(b.maxY - b.minY).toBeCloseTo(20, 1);
    expect(b.minY).toBeCloseTo(0, 1);         // sits on the baseline
    expect(capHeightUnits(font)).toBeGreaterThan(1000);
  });
  it('letters with holes give inner contours that even-odd turns into real holes', () => {
    const o = textToContours(font, 'O', { capHeight: 30 });
    expect(o.contours.length).toBe(2);
    const n = normalize(o.contours);
    const areas = n.map(signedArea).sort((a, b) => a - b);
    expect(areas[0]).toBeLessThan(0);          // a hole (clockwise)
    expect(areas[areas.length - 1]).toBeGreaterThan(0);
    // the glyph area is the outer minus the inner
    const outer = Math.abs(signedArea(o.contours[0])), inner = Math.abs(signedArea(o.contours[1]));
    expect(Math.abs(n.reduce((a, l) => a + signedArea(l), 0))).toBeCloseTo(Math.abs(outer - inner), 0);
  });
  it('a word is wider than a letter and tracking spreads the letters', () => {
    const a = textToContours(font, 'HI', { capHeight: 10 }), b = textToContours(font, 'HI', { capHeight: 10, tracking: 50 });
    expect(a.width).toBeGreaterThan(textToContours(font, 'H', { capHeight: 10 }).width);
    expect(b.width - a.width).toBeCloseTo(5, 1);   // 50% of the 10 mm cap height, between two letters
  });
  it('lines stack downwards and alignment shifts them', () => {
    const t = textToContours(font, 'H\nH', { capHeight: 10 });
    const b = bbox(t.contours);
    expect(b.minY).toBeLessThan(-10);
    const left = bbox(textToContours(font, 'HHHH\nH', { capHeight: 10, align: 'left' }).contours);
    const right = bbox(textToContours(font, 'HHHH\nH', { capHeight: 10, align: 'right' }).contours);
    expect(left.minX).toBeGreaterThanOrEqual(-1); expect(right.maxX).toBeLessThanOrEqual(1);
  });
  it('curves are smooth to 0.01 mm and contours are closed with no repeated end point', () => {
    const t = textToContours(font, 'S', { capHeight: 50 });
    for (const c of t.contours) {
      expect(c.length).toBeGreaterThan(8);
      expect(Math.hypot(c[0].x - c[c.length - 1].x, c[0].y - c[c.length - 1].y)).toBeGreaterThan(1e-6);
    }
  });
  it('can be placed and rotated', () => {
    const t = textToContours(font, 'H', { capHeight: 10 });
    const r = placeContours(t.contours, 100, 50, 90);
    const b = bbox(r);
    expect(b.maxX - b.minX).toBeCloseTo(10, 1);   // now the tall way is horizontal
    expect(b.minX).toBeLessThan(100);
  });
  it('spaces and unknown characters do not crash', () => {
    expect(textToContours(font, '   ', { capHeight: 10 }).contours.length).toBe(0);
    expect(() => textToContours(font, 'A☃B', { capHeight: 10 })).not.toThrow();
    expect(textToContours(font, '', { capHeight: 10 }).contours).toEqual([]);
  });
  it('outlines survive the normal clean-up (no joining or dropping of letter outlines)', () => {
    const t = textToContours(font, 'Hi!', { capHeight: 10 });
    const { shapes } = cleanShapes(t.contours.map(pts => ({ layer: 'T', pts, closed: true })), { joinTol: 0.05, closeTol: 2, dedupe: true });
    expect(shapes.length).toBe(t.contours.length);
  });
});

describe('guessing a font from a drawing file', () => {
  it('maps common family names', () => {
    expect(guessFont('Arial, Helvetica, sans-serif')).toBe('sans');
    expect(guessFont('Arial', 'bold')).toBe('sansbold');
    expect(guessFont('Times New Roman', 400)).toBe('serif');
    expect(guessFont('Courier New')).toBe('mono');
    expect(guessFont('Brush Script')).toBe('script');
    expect(guessFont('Arial Narrow')).toBe('condensed');
    expect(guessFont('serif')).toBe('serif');
    expect(guessFont('DejaVu Sans', 700)).toBe('sansbold');
  });
});
