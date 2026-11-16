// opentype.js ships no type definitions; declare the small part we use.
declare module 'opentype.js' {
  export interface PathCommand { type: 'M' | 'L' | 'Q' | 'C' | 'Z'; x?: number; y?: number; x1?: number; y1?: number; x2?: number; y2?: number }
  export interface OTPath { commands: PathCommand[] }
  export interface OTGlyph {
    advanceWidth?: number;
    index: number;
    getPath(x: number, y: number, fontSize: number): OTPath;
    getBoundingBox(): { x1: number; y1: number; x2: number; y2: number };
  }
  export interface OTFont {
    unitsPerEm: number;
    charToGlyph(c: string): OTGlyph;
    getKerningValue(a: OTGlyph, b: OTGlyph): number;
  }
  export function parse(buffer: ArrayBuffer): OTFont;
}
