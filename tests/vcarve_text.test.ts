import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'opentype.js';
import { textToContours } from '../src/text/outline';
import { vcarve } from '../src/core/vcarve';
import { normalize } from '../src/core/geometry';
import { MATERIALS } from '../src/core/presets';
import type { Loop, Tool, Toolpath } from '../src/core/types';

const load = (path: string) => { const b = readFileSync(path); return parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer); };
const bold = load('node_modules/@fontsource/roboto/files/roboto-latin-700-normal.woff');

function inside(loops: Loop[], x: number, y: number): boolean {
  let c = false;
  for (const l of loops) for (let i = 0, j = l.length - 1; i < l.length; j = i++) {
    const a = l[i], b = l[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}
function dist(loops: Loop[], x: number, y: number): number {
  let best = Infinity;
  for (const l of loops) for (let i = 0; i < l.length; i++) {
    const a = l[i], b = l[(i + 1) % l.length], dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(x - a.x - t * dx, y - a.y - t * dy));
  }
  return best;
}
/** Deepest cone over all path samples, using a coarse spatial index so many probe points stay fast. */
function makeProbe(tp: Toolpath, tool: Tool) {
  const half = ((tool.angle ?? 60) * Math.PI) / 360, tan = Math.tan(half), tip = (tool.tipDiameter ?? 0) / 2;
  const pts: { x: number; y: number; z: number }[] = [];
  for (const c of tp.cuts) for (let i = 1; i < c.moves.length; i++) {
    const a = c.moves[i - 1], b = c.moves[i], L = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z), n = Math.max(1, Math.ceil(L / 0.15));
    for (let k = 0; k <= n; k++) pts.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n, z: -(a.z + ((b.z - a.z) * k) / n) });
  }
  const cell = 5, grid = new Map<string, typeof pts>();
  for (const p of pts) { const k = `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`; (grid.get(k) ?? grid.set(k, []).get(k)!).push(p); }
  const reach = 40;
  return (x: number, y: number) => {
    let best = 0;
    const r = Math.ceil(reach / cell);
    for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
      for (const p of grid.get(`${Math.floor(x / cell) + i},${Math.floor(y / cell) + j}`) ?? []) {
        const d = p.z - Math.max(0, Math.hypot(x - p.x, y - p.y) - tip) / tan;
        if (d > best) best = d;
      }
    }
    return best;
  };
}

describe('V-carving real text', () => {
  const v60: Tool = { type: 'vbit', diameter: 12, angle: 60, tipDiameter: 0 };
  const material = MATERIALS.softwood;
  const t = textToContours(bold, 'Hello', { capHeight: 30 });
  const letters = normalize(t.contours);

  it('carves a word quickly and produces a sensible toolpath', () => {
    const t0 = Date.now();
    const tp = vcarve(t.contours, { tool: v60, material, maxDepth: 6, direction: 'climb', wide: 'clear' });
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(8000);
    expect(tp.cuts.length).toBeGreaterThan(5);
    const len = tp.cuts.reduce((s, c) => s + c.moves.reduce((a, m, i) => (i ? a + Math.hypot(m.x - c.moves[i - 1].x, m.y - c.moves[i - 1].y) : a), 0), 0);
    expect(len).toBeLessThan(6000);       // a skeleton pass, not hundreds of contours
  });

  it('cuts nothing outside the letters and reaches the right depth inside them', () => {
    const tp = vcarve(t.contours, { tool: v60, material: { ...material, stepdown: 100 }, maxDepth: 8, direction: 'climb', wide: 'clear' });
    const probe = makeProbe(tp, v60);
    const tan = Math.tan(Math.PI / 6);
    const xs = letters.flat().map(p => p.x), ys = letters.flat().map(p => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    let outsideWorst = 0, insideShort = 0, insideTotal = 0, worstShort = 0;
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let k = 0; k < 400; k++) {
      const x = minX - 3 + rnd() * (maxX - minX + 6), y = minY - 3 + rnd() * (maxY - minY + 6);
      const d = probe(x, y);
      if (inside(letters, x, y)) {
        const ideal = Math.min(dist(letters, x, y) / tan, 8);
        insideTotal++;
        if (d < ideal - 0.25) { insideShort++; worstShort = Math.max(worstShort, ideal - d); }
      } else {
        outsideWorst = Math.max(outsideWorst, d - 0 );
      }
    }
    expect(outsideWorst).toBeLessThan(0.15);            // nothing cut outside the lettering (0.15 mm tolerance of the sampling)
    expect(insideTotal).toBeGreaterThan(40);
    expect(insideShort / insideTotal).toBeLessThan(0.05); // essentially no uncut ridges
    expect(worstShort).toBeLessThan(1.5);
  });
});
