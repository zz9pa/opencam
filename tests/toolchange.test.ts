import { describe, it, expect } from 'vitest';
import { toGcode, type Post } from '../src/core/gcode';
import { loadMachine, MACHINE_KEY, type KV } from '../src/machine';
import type { Toolpath } from '../src/core/types';

const tool = (d: number) => ({ type: 'flat' as const, diameter: d });
const path = (d: number, x: number, y: number): Toolpath => ({
  name: `cut ${d}`, tool: tool(d), feed: 800, plungeFeed: 300,
  cuts: [{ loop: [], z: -1, zStart: 0, closed: false, moves: [{ x, y, z: 0 }, { x: x + 10, y, z: -1 }] }],
});
const jobs = [path(6, 5, 5), path(3, 40, 30)];
const post = (tc?: Post['toolChange'], flavor: Post['flavor'] = 'marlin'): Post => ({ flavor, spindle: 'manual', safeZ: 5, decimals: 3, toolChange: tc });
const lines = (p: Post) => toGcode(jobs, p).split('\n');

describe('tool change help', () => {
  it('plain pause is unchanged', () => {
    const a = toGcode(jobs, post()), b = toGcode(jobs, post({ mode: 'pause' }));
    expect(b).toBe(a);
    expect(a).toContain('CHANGE BIT to 3mm flat end mill');
  });
  it('move: lifts, goes to the spot over the piece, then pauses; the next cut still starts from its own position', () => {
    const g = lines(post({ mode: 'move', liftZ: 40, x: 100, y: 80 }));
    const i = g.findIndex(l => l.startsWith('; CHANGE BIT'));
    expect(g[i - 2]).toMatch(/^G0 Z40/);
    expect(g[i - 1]).toMatch(/^G0 X100 Y80/);
    expect(g.slice(i, i + 4).some(l => l.startsWith('M0'))).toBe(true);
    const after = g.slice(i + 1).find(l => /^G0 X/.test(l))!;
    expect(after).toMatch(/^G0 X40 Y30/);
  });
  it('with no spot given it goes to the start of the next cut', () => {
    const g = lines(post({ mode: 'move' }));
    const i = g.findIndex(l => l.startsWith('; CHANGE BIT'));
    expect(g[i - 1]).toMatch(/^G0 X40 Y30/);
    expect(g[i - 2]).toMatch(/^G0 Z30/);
  });
  it('re-homing X/Y only on Marlin, and before going to the spot', () => {
    const m = lines(post({ mode: 'move', home: true, x: 10, y: 10 }));
    const i = m.findIndex(l => l.startsWith('G28 X Y'));
    expect(i).toBeGreaterThan(0);
    expect(m[i + 1]).toMatch(/^G0 X10 Y10/);
    expect(lines(post({ mode: 'move', home: true, x: 10, y: 10 }, 'grbl')).some(l => l.startsWith('G28'))).toBe(false);
  });
  it('probe: pause for the swap, probe down, set Z to the plate thickness, lift, ask for the plate to be removed', () => {
    const g = lines(post({ mode: 'probe', plate: 12.5, probeDepth: 20, probeFeed: 50, liftZ: 35, x: 60, y: 60 }));
    const pr = g.findIndex(l => l.startsWith('G38.2'));
    expect(g[pr]).toBe('G38.2 Z-20 F50');
    expect(g[pr + 1]).toMatch(/^G92 Z12.5( |$)/);
    expect(g[pr + 2]).toMatch(/^G0 Z35/);
    expect(g[pr + 3]).toMatch(/^M117 Remove plate/);
    expect(g[pr + 4]).toMatch(/^M0/);
    // the swap pause comes before the probe, and only one probe (no probe at the start unless asked)
    expect(g.findIndex(l => l.startsWith('M0 ; change the bit'))).toBeLessThan(pr);
    expect(g.filter(l => l.startsWith('G38.2')).length).toBe(1);
  });
  it('probe without a plate only asks for the router to be started after the change', () => {
    const g = lines(post({ mode: 'probe', plate: 0, x: 20, y: 20 }));
    expect(g.some(l => l.includes('touch plate, switch'))).toBe(false);
    const pr = g.findIndex(l => l.startsWith('G38.2'));
    expect(g[pr + 1]).toMatch(/^G92 Z0( |$)/);
    expect(g.slice(pr + 2, pr + 5).some(l => l.startsWith('M0 ; switch the router on'))).toBe(true);
  });
  it('start probe happens before the router is started, with the router off', () => {
    const g = lines(post({ mode: 'probe', plate: 5, probeAtStart: true }));
    const z = g.findIndex(l => l.startsWith('G38.2')), start = g.findIndex(l => l.startsWith('M0 ; start the router'));
    expect(z).toBeGreaterThan(0);
    expect(z).toBeLessThan(start);
    expect(g[z - 1]).toMatch(/^G92 Z0/);
    expect(g[z + 1]).toMatch(/^G92 Z5/);
    expect(g.slice(z, start).some(l => l.startsWith('M0 ; remove the touch plate'))).toBe(true);
  });
  it('X/Y probing finds the corner from the recess walls: wall inset plus the bit radius', () => {
    const g = lines(post({ mode: 'probe', plate: 5, probeAtStart: true, probeXY: true, wallX: 10, wallY: 10, xyTravel: 18, probeFeed: 40 }));
    const x = g.findIndex(l => l.startsWith('G38.2 X')), y = g.findIndex(l => l.startsWith('G38.2 Y'));
    expect(g[x - 1]).toBe('G92 X0 Y0');
    expect(g[x]).toBe('G38.2 X-18 F40');
    expect(g[x + 1]).toBe('G92 X13'); // 10 + 6 mm bit / 2
    expect(g[x + 2]).toMatch(/^G0 X16/);
    expect(g[y]).toBe('G38.2 Y-18 F40');
    expect(g[y + 1]).toBe('G92 Y13');
    // a V-bit is not probed sideways
    const v = toGcode([{ ...path(6, 5, 5), tool: { type: 'vbit', diameter: 6, angle: 60 } }], post({ mode: 'probe', probeAtStart: true, probeXY: true }));
    expect(v).not.toContain('G38.2 X');
    expect(v).toContain('X/Y probing is skipped');
  });
  it('the same bit twice in a row has no tool change at all', () => {
    const g = toGcode([path(6, 5, 5), path(6, 40, 30)], post({ mode: 'probe', plate: 10 }));
    expect(g).not.toContain('G38.2');
  });
});

describe('saved tool-change settings', () => {
  const kv = (v: unknown): KV => ({ getItem: () => JSON.stringify({ toolChange: v }), setItem: () => {}, removeItem: () => {} });
  it('loads valid settings and drops bad ones', () => {
    expect(loadMachine(kv({ mode: 'probe', plate: 10, x: 5, y: 6, probeDepth: -3, liftZ: 'x', home: true, probeXY: true, wallX: 10, xyTravel: 0, dirX: 1, dirY: 7, zeroWith: 'g10', probeCmd: 'G38.3' })).toolChange)
      .toEqual({ mode: 'probe', plate: 10, x: 5, y: 6, home: true, probeXY: true, wallX: 10, dirX: 1, zeroWith: 'g10', probeCmd: 'G38.3' });
    expect(loadMachine(kv({ mode: 'fly' })).toolChange).toBeUndefined();
    expect(loadMachine(kv({ mode: 'custom', macro: 'G92 Z0', startMacro: '  ' })).toolChange).toEqual({ mode: 'custom', macro: 'G92 Z0' });
    expect(loadMachine(kv({ mode: 'move', x: 5 })).toolChange).toEqual({ mode: 'move' });
    void MACHINE_KEY;
  });

  it('other plate shapes: walls on the other side, different insets, G10 and G38.3', () => {
    const g = lines(post({ mode: 'probe', plate: 3, probeAtStart: true, probeXY: true, wallX: 6, wallY: 8, dirX: 1, dirY: -1, xyLift: 4, backoff: 2, zeroWith: 'g10', probeCmd: 'G38.3', xyTravel: 15 }, 'grbl'));
    const z = g.findIndex(l => l.startsWith('G38.3 Z'));
    expect(g[z - 1]).toMatch(/^G10 L20 P1 Z0/);
    expect(g[z + 1]).toMatch(/^G10 L20 P1 Z3/);
    expect(g[z + 2]).toBe('G0 Z7'); // 3 + 4
    const x = g.findIndex(l => l.startsWith('G38.3 X'));
    expect(g[x - 1]).toMatch(/^G10 L20 P1 X0 Y0/);
    expect(g[x]).toBe('G38.3 X15 F60'); // towards higher X
    expect(g[x + 1]).toMatch(/^G10 L20 P1 X3\b/); // wall at 6, bit on the low side: 6 - radius 3
    expect(g[x + 2]).toBe('G0 X1'); // back off 2 towards lower X
    const y = g.findIndex(l => l.startsWith('G38.3 Y'));
    expect(g[y]).toBe('G38.3 Y-15 F60');
    expect(g[y + 1]).toMatch(/^G10 L20 P1 Y11\b/); // wall at 8, bit on the high side: 8 + 3
    expect(g[y + 2]).toBe('G0 Y13');
  });

  it('custom mode runs your lines after the swap with the bit size filled in, then asks for the router', () => {
    const g = lines(post({ mode: 'custom', liftZ: 20, plate: 5, x: 30, y: 30, macro: 'G38.2 Z-{lift} F40\nG92 Z{plate}\n; radius {r} diameter {d}' }));
    const i = g.findIndex(l => l.startsWith('; --- your zeroing G-code ---'));
    expect(g[i - 1]).toMatch(/^M0 ; change the bit/);
    expect(g.slice(i + 1, i + 4)).toEqual(['G38.2 Z-20 F40', 'G92 Z5', '; radius 1.5 diameter 3']);
    expect(g.slice(i + 5, i + 8).some(l => l.startsWith('M0 ; switch the router on'))).toBe(true);
  });
  it('a start macro runs once before the router start, in any mode', () => {
    const g = lines(post({ mode: 'pause', startMacro: 'G92 X0 Y0\nG38.2 Z-{d}' }));
    const i = g.findIndex(l => l === 'G92 X0 Y0'), start = g.findIndex(l => l.startsWith('M0 ; start the router'));
    expect(g[i + 1]).toBe('G38.2 Z-6'); // first bit is 6 mm
    expect(i).toBeLessThan(start);
    expect(g.filter(l => l === 'G92 X0 Y0').length).toBe(1);
  });

  it('guided probing pauses before each touch: X, then Y, then Z, with your plate numbers', () => {
    const g = lines(post({ mode: 'probe', plate: 5.1, probeAtStart: true, probeXY: true, guided: true, wallX: 10, wallY: 5, dirX: 1, dirY: 1, backoff: 2 }));
    const x = g.findIndex(l => l.startsWith('G38.2 X')), y = g.findIndex(l => l.startsWith('G38.2 Y')), z = g.findIndex(l => l.startsWith('G38.2 Z'));
    expect(x).toBeLessThan(y); expect(y).toBeLessThan(z);
    expect(g[x - 1]).toMatch(/^G92 X0/);
    expect(g[x - 2]).toMatch(/^M0 ; jog the bit to the lower X side/);
    expect(g[x]).toBe('G38.2 X20 F60');
    expect(g[x + 1]).toMatch(/^G92 X7( |$)/); // face at 10, bit comes from the low side: 10 - 3
    expect(g[x + 2]).toMatch(/^G0 X5/);
    expect(g[y - 2]).toMatch(/^M0 ; jog the bit to the lower Y side/);
    expect(g[y]).toBe('G38.2 Y20 F60');
    expect(g[y + 1]).toMatch(/^G92 Y2( |$)/); // face at 5: 5 - 3
    expect(g[z - 2]).toMatch(/^M0 ; jog the bit over the plate/);
    expect(g[z - 1]).toMatch(/^G92 Z0/);
    expect(g[z + 1]).toMatch(/^G92 Z5.1/);
    // all of it before the router is started
    expect(z).toBeLessThan(g.findIndex(l => l.startsWith('M0 ; start the router')));
  });
});

