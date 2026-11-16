import type { Toolpath } from './types';

export function translateToolpath(tp: Toolpath, dx: number, dy: number): Toolpath {
  return {
    ...tp,
    cuts: tp.cuts.map(c => ({
      ...c,
      loop: c.loop.map(p => ({ x: p.x + dx, y: p.y + dy })),
      moves: c.moves.map(m => ({ ...m, x: m.x + dx, y: m.y + dy })), // keep flags such as `rapid`
    })),
  };
}

export function toolpathBounds(paths: Toolpath[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const tp of paths) for (const c of tp.cuts) for (const m of c.moves) {
    minX = Math.min(minX, m.x); maxX = Math.max(maxX, m.x);
    minY = Math.min(minY, m.y); maxY = Math.max(maxY, m.y);
  }
  return { minX, minY, maxX, maxY, empty: minX === Infinity };
}
