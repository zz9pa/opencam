import { describe, it, expect } from 'vitest';
import { isBinaryDxf, binaryDxfToAscii } from '../src/import/bindxf';
import { parseDxf } from '../src/import/dxf';

type Rec = [number, string | number];
const STR = new Set([0, 1, 2, 3, 8, 9, 100]);
const F64 = new Set([10, 11, 20, 21, 30, 31, 40, 41, 50, 51]);
const I16 = new Set([70, 71, 72, 73, 62]);
const I32 = new Set([90, 91, 92, 93]);

/** Write records the way AutoCAD does in a binary DXF: wide = two-byte group codes (R13 and later), else one byte (R12). */
function toBinary(recs: Rec[], wide: boolean): Uint8Array {
  const parts: number[] = [...'AutoCAD Binary DXF\r\n\x1a\x00'].map(c => c.charCodeAt(0));
  const f64 = (v: number) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, true); return [...b]; };
  const i16 = (v: number) => [v & 255, (v >> 8) & 255];
  const i32 = (v: number) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >> 24) & 255];
  for (const [c, v] of recs) {
    if (wide) parts.push(...i16(c)); else if (c < 255) parts.push(c); else parts.push(255, ...i16(c));
    if (STR.has(c)) parts.push(...[...String(v)].map(ch => ch.charCodeAt(0)), 0);
    else if (F64.has(c)) parts.push(...f64(+v));
    else if (I16.has(c)) parts.push(...i16(+v));
    else if (I32.has(c)) parts.push(...i32(+v));
    else throw new Error('test helper: unknown group ' + c);
  }
  return Uint8Array.from(parts);
}

const doc: Rec[] = [
  [0, 'SECTION'], [2, 'HEADER'], [9, '$INSUNITS'], [70, 4], [0, 'ENDSEC'],
  [0, 'SECTION'], [2, 'ENTITIES'],
  [0, 'LWPOLYLINE'], [8, 'CUT'], [90, 4], [70, 1], [10, 0], [20, 0], [10, 30.5], [20, 0], [10, 30.5], [20, 12.25], [10, 0], [20, 12.25],
  [0, 'CIRCLE'], [8, 'HOLES'], [10, 15], [20, 6], [30, 0], [40, 2.5],
  [0, 'ENDSEC'], [0, 'EOF'],
];

describe('binary DXF', () => {
  for (const wide of [true, false]) {
    it(`is recognised and read the same as the text version (${wide ? 'two-byte' : 'one-byte'} group codes)`, () => {
      const bin = toBinary(doc, wide);
      expect(isBinaryDxf(bin)).toBe(true);
      const text = binaryDxfToAscii(bin);
      const r = parseDxf(text);
      expect(r.shapes.length).toBe(2);
      const poly = r.shapes.find(s => s.layer === 'CUT')!, hole = r.shapes.find(s => s.layer === 'HOLES')!;
      expect(poly.closed).toBe(true);
      expect(Math.max(...poly.pts.map(p => p.x))).toBeCloseTo(30.5, 6);
      expect(Math.max(...poly.pts.map(p => p.y))).toBeCloseTo(12.25, 6);
      expect(Math.max(...hole.pts.map(p => p.x)) - Math.min(...hole.pts.map(p => p.x))).toBeCloseTo(5, 1);
    });
  }
  it('a text DXF is not mistaken for binary', () => {
    expect(isBinaryDxf(new TextEncoder().encode('  0\nSECTION\n  2\nHEADER\n  0\nENDSEC\n  0\nEOF\n'))).toBe(false);
  });
  it('a truncated file gives a plain message instead of garbage', () => {
    const bin = toBinary(doc, true);
    expect(() => binaryDxfToAscii(bin.subarray(0, bin.length - 40))).toThrow(/ends unexpectedly/);
  });
  it('values keep their full precision', () => {
    const t = binaryDxfToAscii(toBinary([[0, 'SECTION'], [10, 0.1 + 0.2], [0, 'EOF']], true));
    expect(t).toContain('0.30000000000000004');
  });
});
