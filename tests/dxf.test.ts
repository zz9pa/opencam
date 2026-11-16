import { describe, it, expect } from 'vitest';
import { parseDxf } from '../src/import/dxf';
import { cleanShapes } from '../src/import/join';
import type { RawShape } from '../src/import/shape';

/** Build a tiny ASCII DXF. Each pair is [group code, value]. */
function dxf(entities: [number, string | number][][], opts: { units?: number; blocks?: string } = {}): string {
  const g = (code: number, v: string | number) => `${String(code).padStart(3, ' ')}\n${v}\n`;
  let s = g(0, 'SECTION') + g(2, 'HEADER');
  if (opts.units !== undefined) s += g(9, '$INSUNITS') + g(70, opts.units);
  s += g(0, 'ENDSEC');
  if (opts.blocks) s += g(0, 'SECTION') + g(2, 'BLOCKS') + opts.blocks + g(0, 'ENDSEC');
  s += g(0, 'SECTION') + g(2, 'ENTITIES');
  for (const e of entities) for (const [c, v] of e) s += g(c, v);
  s += g(0, 'ENDSEC') + g(0, 'EOF');
  return s;
}
const bbox = (s: RawShape) => {
  const xs = s.pts.map(p => p.x), ys = s.pts.map(p => p.y);
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), minX: Math.min(...xs), minY: Math.min(...ys) };
};
const area = (s: RawShape) => { let a = 0; for (let i = 0; i < s.pts.length; i++) { const p = s.pts[i], q = s.pts[(i + 1) % s.pts.length]; a += p.x * q.y - q.x * p.y; } return Math.abs(a / 2); };
const LINE = (x0: number, y0: number, x1: number, y1: number, layer = '0'): [number, string | number][] =>
  [[0, 'LINE'], [8, layer], [10, x0], [20, y0], [30, 0], [11, x1], [21, y1], [31, 0]];

describe('DXF import', () => {
  it('reads lines on layers, in millimetres', () => {
    const r = parseDxf(dxf([LINE(0, 0, 10, 0, 'CUT'), LINE(10, 0, 10, 5, 'CUT')], { units: 4 }));
    expect(r.shapes.length).toBe(2);
    expect(r.shapes[0].layer).toBe('CUT');
    expect(r.fileUnits).toBe('millimetres');
    expect(r.scaleToMm).toBe(1);
  });
  it('converts inches to millimetres from the header', () => {
    const r = parseDxf(dxf([LINE(0, 0, 2, 0)], { units: 1 }));
    expect(r.scaleToMm).toBe(25.4);
    expect(bbox(r.shapes[0]).w).toBeCloseTo(50.8);
  });
  it('assumes mm and says so when the file has no units; a user override wins', () => {
    const r = parseDxf(dxf([LINE(0, 0, 2, 0)]));
    expect(r.fileUnits).toBeNull();
    expect(r.notes.some(n => /millimetres are assumed/.test(n))).toBe(true);
    expect(parseDxf(dxf([LINE(0, 0, 2, 0)]), { unitScale: 25.4 }).shapes[0].pts[1].x).toBeCloseTo(50.8);
  });
  it('turns four separate lines into one closed outline after clean-up', () => {
    const r = parseDxf(dxf([LINE(0, 0, 40, 0), LINE(40, 0, 40, 20), LINE(40, 20, 0, 20), LINE(0, 20, 0, 0)], { units: 4 }));
    const { shapes } = cleanShapes(r.shapes, { joinTol: 0.05, dedupe: true });
    expect(shapes.length).toBe(1);
    expect(shapes[0].closed).toBe(true);
    expect(area(shapes[0])).toBeCloseTo(800);
  });
  it('reads a circle as a closed, accurate polygon', () => {
    const r = parseDxf(dxf([[[0, 'CIRCLE'], [8, '0'], [10, 5], [20, 5], [30, 0], [40, 10]]], { units: 4 }));
    expect(r.shapes.length).toBe(1);
    expect(r.shapes[0].closed).toBe(true);
    const b = bbox(r.shapes[0]);
    expect(b.w).toBeCloseTo(20, 1);
    // an inscribed polygon with 0.01 mm chord error is within about 0.2% of the true area
    expect(area(r.shapes[0])).toBeGreaterThan(Math.PI * 100 * 0.997);
    // every point lies within the 0.01 mm tolerance of the true circle
    for (const p of r.shapes[0].pts) expect(Math.abs(Math.hypot(p.x - 5, p.y - 5) - 10)).toBeLessThan(0.011);
  });
  it('reads an arc counter-clockwise from start to end angle (degrees in the file)', () => {
    const r = parseDxf(dxf([[[0, 'ARC'], [8, '0'], [10, 0], [20, 0], [30, 0], [40, 10], [50, 0], [51, 90]]], { units: 4 }));
    const pts = r.shapes[0].pts;
    expect(pts[0].x).toBeCloseTo(10); expect(pts[0].y).toBeCloseTo(0);
    expect(pts[pts.length - 1].x).toBeCloseTo(0); expect(pts[pts.length - 1].y).toBeCloseTo(10);
    expect(r.shapes[0].closed).toBe(false);
  });
  it('an arc that wraps past 360 degrees goes the long way correctly', () => {
    const r = parseDxf(dxf([[[0, 'ARC'], [8, '0'], [10, 0], [20, 0], [30, 0], [40, 10], [50, 270], [51, 90]]], { units: 4 }));
    const pts = r.shapes[0].pts;
    expect(pts[0].y).toBeCloseTo(-10); expect(pts[pts.length - 1].y).toBeCloseTo(10);
    expect(Math.max(...pts.map(p => p.x))).toBeCloseTo(10, 1); // passes through angle 0
  });
  it('closed polyline with a bulge gets a rounded side', () => {
    // 20x10 rectangle whose right side bulges into a half circle (bulge = 1 means a semicircle)
    const e: [number, string | number][] = [[0, 'LWPOLYLINE'], [8, '0'], [90, 4], [70, 1],
      [10, 0], [20, 0], [10, 20], [20, 0], [42, 1], [10, 20], [20, 10], [10, 0], [20, 10]];
    // vertices: (0,0) -> (20,0) with bulge 1 would bulge the bottom; use explicit order instead
    const poly: [number, string | number][] = [[0, 'LWPOLYLINE'], [8, '0'], [90, 4], [70, 1],
      [10, 0], [20, 0], [10, 20], [20, 0], [10, 20], [20, 10], [42, 0], [10, 0], [20, 10]];
    void e;
    const r = parseDxf(dxf([poly], { units: 4 }));
    expect(r.shapes[0].closed).toBe(true);
    expect(area(r.shapes[0])).toBeCloseTo(200, 0);
    const semi: [number, string | number][] = [[0, 'LWPOLYLINE'], [8, '0'], [90, 2], [70, 1], [10, 0], [20, 0], [42, 1], [10, 10], [20, 0]];
    const s = parseDxf(dxf([semi], { units: 4 }));
    // two vertices joined by a semicircle (bulge 1) and a straight line: a half-disc of radius 5
    expect(area(s.shapes[0])).toBeCloseTo((Math.PI * 25) / 2, 0);
  });
  it('flattens a spline smoothly through its control polygon', () => {
    // clamped cubic B-spline with 4 control points: a Bezier curve
    const e: [number, string | number][] = [[0, 'SPLINE'], [8, '0'], [70, 8], [71, 3], [72, 8], [73, 4],
      [40, 0], [40, 0], [40, 0], [40, 0], [40, 1], [40, 1], [40, 1], [40, 1],
      [10, 0], [20, 0], [10, 10], [20, 20], [10, 20], [20, 20], [10, 30], [20, 0]];
    const r = parseDxf(dxf([e], { units: 4 }));
    const pts = r.shapes[0].pts;
    expect(pts[0].x).toBeCloseTo(0); expect(pts[0].y).toBeCloseTo(0);
    expect(pts[pts.length - 1].x).toBeCloseTo(30, 1); expect(pts[pts.length - 1].y).toBeCloseTo(0, 1);
    // the midpoint of this Bezier is at (15, 15)
    const mid = pts[Math.floor(pts.length / 2)];
    expect(mid.x).toBeCloseTo(15, 0); expect(mid.y).toBeCloseTo(15, 0);
  });
  it('places block inserts with scale, rotation and position', () => {
    const blocks = '  0\nBLOCK\n  8\n0\n  2\nSQ\n 70\n0\n 10\n0\n 20\n0\n 30\n0\n' +
      '  0\nLINE\n  8\n0\n 10\n0\n 20\n0\n 11\n10\n 21\n0\n  0\nENDBLK\n  8\n0\n';
    const ins: [number, string | number][] = [[0, 'INSERT'], [8, 'PARTS'], [2, 'SQ'], [10, 100], [20, 50], [30, 0], [41, 2], [42, 2], [50, 90]];
    const r = parseDxf(dxf([ins], { units: 4, blocks }));
    expect(r.shapes.length).toBe(1);
    expect(r.shapes[0].layer).toBe('PARTS');
    // the 10 mm line, scaled x2 and rotated 90 degrees about the insert point, runs from (100,50) to (100,70)
    const p = r.shapes[0].pts;
    expect(p[0].x).toBeCloseTo(100); expect(p[0].y).toBeCloseTo(50);
    expect(p[1].x).toBeCloseTo(100, 3); expect(p[1].y).toBeCloseTo(70, 3);
  });
  it('collects text for conversion to outlines instead of dropping it', () => {
    const txt: [number, string | number][] = [[0, 'TEXT'], [8, 'LABELS'], [10, 10], [20, 20], [30, 0], [40, 5], [1, 'hello'], [50, 90]];
    const r = parseDxf(dxf([txt, LINE(0, 0, 5, 5)], { units: 4 }));
    expect(r.shapes.length).toBe(1);
    expect(r.texts!.length).toBe(1);
    const t = r.texts![0];
    expect(t.text).toBe('hello'); expect(t.layer).toBe('LABELS');
    expect(t.x).toBeCloseTo(10); expect(t.y).toBeCloseTo(20);
    expect(t.size).toBeCloseTo(5); expect(t.sizeIs).toBe('cap'); expect(t.rotation).toBeCloseTo(90);
  });
  it('scales text with the units, strips formatting codes and anchors MTEXT at its first baseline', () => {
    const mt: [number, string | number][] = [[0, 'MTEXT'], [8, '0'], [10, 1], [20, 2], [30, 0], [40, 0.5], [1, '{\\Farial|b0;Line one}\\PLine two %%c10'], [71, 1]];
    const r = parseDxf(dxf([mt], { units: 1 }));
    const t = r.texts![0];
    expect(t.text).toBe('Line one\nLine two Ø10');
    expect(t.size).toBeCloseTo(12.7);                  // 0.5 inch tall
    expect(t.x).toBeCloseTo(25.4);
    expect(t.y).toBeCloseTo((2 - 0.5) * 25.4, 3);      // top-left attachment: the baseline is one text height lower
  });
  it('gives a clear error for garbage', () => {
    expect(() => parseDxf('this is not a dxf')).toThrow();
  });
});

describe('DXF hatches', () => {
  type P = [number, string | number][];
  const HATCH_POLY = (pts: [number, number][], layer = 'H', bulges: number[] = []): P => [
    [0, 'HATCH'], [8, layer], [2, 'SOLID'], [70, 1], [71, 0], [91, 1], [92, 7], [72, bulges.length ? 1 : 0], [73, 1], [93, pts.length],
    ...pts.flatMap(([x, y], i) => [[10, x], [20, y], ...(bulges.length ? [[42, bulges[i]]] : [])] as P),
    [97, 0], [75, 0], [76, 1], [98, 0],
  ];
  const HATCH_EDGES = (edges: P[]): P => [
    [0, 'HATCH'], [8, 'E'], [2, 'SOLID'], [70, 1], [71, 0], [91, 1], [92, 1], [93, edges.length], ...edges.flat(), [97, 0], [75, 0], [76, 1], [98, 0],
  ];
  it('reads a polyline-bounded hatch as a closed outline', () => {
    const r = parseDxf(dxf([HATCH_POLY([[0, 0], [20, 0], [20, 10], [0, 10]])], { units: 4 }));
    expect(r.shapes.length).toBe(1);
    expect(r.shapes[0].closed).toBe(true);
    expect(area(r.shapes[0])).toBeCloseTo(200, 3);
    expect(r.shapes[0].layer).toBe('H');
    expect(r.notes.join(' ')).toMatch(/1 hatched area/);
  });
  it('reads a hatch bounded by lines and an arc', () => {
    // a half disc of radius 10: arc from 0 to 180 degrees (counter-clockwise), closed by a line
    const r = parseDxf(dxf([HATCH_EDGES([
      [[72, 2], [10, 0], [20, 0], [40, 10], [50, 0], [51, 180], [73, 1]],
      [[72, 1], [10, -10], [20, 0], [11, 10], [21, 0]],
    ])], { units: 4 }));
    expect(r.shapes.length).toBe(1);
    expect(area(r.shapes[0])).toBeCloseTo(Math.PI * 100 / 2, 0);
  });
  it('bulged polyline boundaries give circles', () => {
    // two bulge-1 half circles make a circle of diameter 20
    const r = parseDxf(dxf([HATCH_POLY([[0, 0], [20, 0]], 'C', [1, 1])], { units: 4 }));
    expect(area(r.shapes[0])).toBeCloseTo(Math.PI * 100, 0);
  });
  it('does not duplicate an outline that is already drawn (two identical loops would cancel out)', () => {
    const box = (layer: string): P => [[0, 'LWPOLYLINE'], [8, layer], [90, 4], [70, 1], [10, 0], [20, 0], [10, 20], [20, 0], [10, 20], [20, 10], [10, 0], [20, 10]];
    const r = parseDxf(dxf([box('A'), HATCH_POLY([[0, 0], [20, 0], [20, 10], [0, 10]])], { units: 4 }));
    expect(r.shapes.length).toBe(1);
    expect(r.notes.join(' ')).not.toMatch(/hatched area/);
  });
  it('a hatch inside a hole keeps it as a hole (nested loops are separate shapes)', () => {
    const r = parseDxf(dxf([HATCH_POLY([[0, 0], [40, 0], [40, 40], [0, 40]]), HATCH_POLY([[10, 10], [30, 10], [30, 30], [10, 30]])], { units: 4 }));
    expect(r.shapes.length).toBe(2);
  });
  it('spline-edged hatches are reported, not guessed', () => {
    const r = parseDxf(dxf([HATCH_EDGES([[[72, 4], [94, 3], [73, 0], [74, 0], [95, 8], [96, 4]]])], { units: 4 }));
    expect(r.shapes.length).toBe(0);
    expect(r.notes.join(' ')).toMatch(/could not be read/);
  });
  it('inches are scaled', () => {
    const r = parseDxf(dxf([HATCH_POLY([[0, 0], [1, 0], [1, 1], [0, 1]])], { units: 1 }));
    expect(area(r.shapes[0])).toBeCloseTo(25.4 * 25.4, 2);
  });
});
