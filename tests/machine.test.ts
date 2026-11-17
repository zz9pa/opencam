import { describe, it, expect } from 'vitest';
import { loadMachine, saveMachine, forgetMachine, MACHINE_KEY, type KV } from '../src/machine';
import { toGcode } from '../src/core/gcode';
import type { Toolpath } from '../src/core/types';

function fake(): KV & { d: Map<string, string> } {
  const d = new Map<string, string>();
  return { d, getItem: k => d.get(k) ?? null, setItem: (k, v) => { d.set(k, v); }, removeItem: k => { d.delete(k); } };
}
const tp: Toolpath = {
  name: 't', tool: { type: 'flat', diameter: 6 }, feed: 800, plungeFeed: 300,
  cuts: [{ moves: [{ x: 1, y: 1, z: 0 }, { x: 10, y: 1, z: -1 }] }],
} as unknown as Toolpath;

describe('machine defaults', () => {
  it('round-trips a profile', () => {
    const s = fake();
    const p = { flavor: 'grbl' as const, arcs: true, bedX: 500, bedY: 400, startGcode: 'M3 S12000', endGcode: 'M5\nG0 X0 Y0' };
    expect(saveMachine(s, p)).toBe(true);
    expect(loadMachine(s)).toEqual(p);
  });
  it('ignores damaged or missing data', () => {
    const s = fake();
    expect(loadMachine(s)).toEqual({});
    s.d.set(MACHINE_KEY, '{not json');
    expect(loadMachine(s)).toEqual({});
    s.d.set(MACHINE_KEY, JSON.stringify({ flavor: 'x', bedX: -5, bedY: 300, startGcode: 4 }));
    expect(loadMachine(s)).toEqual({ bedY: 300 });
    expect(loadMachine(undefined)).toEqual({});
  });
  it('forgets, and survives a refusing store', () => {
    const s = fake();
    saveMachine(s, { flavor: 'marlin', arcs: false, bedX: 600, bedY: 600, startGcode: '', endGcode: '' });
    forgetMachine(s);
    expect(loadMachine(s)).toEqual({});
    const bad: KV = { getItem: () => null, setItem: () => { throw new Error('full'); }, removeItem: () => { throw new Error('x'); } };
    expect(saveMachine(bad, { flavor: 'marlin', arcs: false, bedX: 600, bedY: 600, startGcode: '', endGcode: '' })).toBe(false);
    expect(() => forgetMachine(bad)).not.toThrow();
  });
});

describe('custom start / end G-code', () => {
  it('replaces the built-in start and end lines', () => {
    const g = toGcode([tp], { flavor: 'marlin', spindle: 'manual', safeZ: 5, decimals: 3, startGcode: 'M3 S12000\r\n\r\nG4 P2', endGcode: 'M5\nG0 X0 Y0\n' }).split('\n');
    const i = g.indexOf('M3 S12000');
    expect(g.slice(0, i)).toContain('G17');
    expect(g[i + 1]).toBe('G4 P2');
    expect(g.join('\n')).not.toContain('Start the router');
    expect(g.join('\n')).not.toContain('Stop the router');
    const e = g.indexOf('; --- your end G-code ---');
    expect(g.slice(e + 1, e + 3)).toEqual(['M5', 'G0 X0 Y0']);
    expect(g.slice(0, e).some(l => l.startsWith('G0 Z5'))).toBe(true);
    expect(g.slice(e + 3).filter(Boolean)).toEqual([]);
  });
  it('blank text keeps the built-in lines', () => {
    const g = toGcode([tp], { flavor: 'grbl', spindle: 'manual', safeZ: 5, decimals: 3, startGcode: '  \n ', endGcode: '' });
    expect(g).toContain('; Start the router now');
    expect(g.trimEnd().endsWith('M2')).toBe(true);
  });
});
