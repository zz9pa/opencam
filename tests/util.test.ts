import { describe, it, expect } from 'vitest';
import { minOf, maxOf } from '../src/core/util';
import { finalize } from '../src/import/shape';

describe('min/max of long lists', () => {
  it('copes with a few hundred thousand values (Math.min(...list) would overflow the stack)', () => {
    const a = Array.from({ length: 400000 }, (_, i) => (i * 7919) % 1000 - 500);
    expect(minOf(a)).toBe(-500);
    expect(maxOf(a)).toBe(499);
  });
  it('a shape with a huge number of points still gets a bounding box', () => {
    const pts = Array.from({ length: 300000 }, (_, i) => ({ x: i, y: -i }));
    const [s] = finalize([{ layer: 'L', pts, closed: false }]);
    expect([s.bbox.minX, s.bbox.maxX, s.bbox.minY]).toEqual([0, 299999, -299999]);
    expect(s.bbox.maxY).toBeCloseTo(0);
  });
});
