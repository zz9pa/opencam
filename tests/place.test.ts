import { describe, it, expect } from 'vitest';
import { zeroOffset, stockOffset } from '../src/core/place';

const path = { minX: 8, minY: 3, maxX: 68, maxY: 53 };   // the bit's path, 3 mm outside the part
const part = { minX: 11, minY: 6, maxX: 65, maxY: 50 };

describe('zeroOffset', () => {
  it('corner: path starts margin mm in from the corner', () => expect(zeroOffset('corner', path, part, 5)).toEqual({ dx: -3, dy: 2 }));
  it('part: the part (not the path) sits at 0,0', () => expect(zeroOffset('part', path, part, 5)).toEqual({ dx: -11, dy: -6 }));
  it('centre: the part centre is 0,0', () => expect(zeroOffset('centre', path, part, 5)).toEqual({ dx: -38, dy: -28 }));
  it('falls back to the path when there is no part box', () => expect(zeroOffset('part', path, null, 5)).toEqual({ dx: -8, dy: -3 }));
});
describe('stockOffset', () => {
  it('moves the turn-over centre to the middle of the stock', () => expect(stockOffset(300, 200, { x: 50, y: 40 })).toEqual({ dx: 100, dy: 60 }));
});
