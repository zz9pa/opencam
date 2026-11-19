import { describe, it, expect } from 'vitest';
import { setupSheetHtml, bitsOf, previewSvg, startSteps, changeSummary, fmtMinutes, esc, type SheetInput } from '../src/setupsheet';
import type { Toolpath } from '../src/core/types';

const cut = (d: number, name: string, z = -3, feed = 800): Toolpath => ({
  name, tool: { type: 'flat', diameter: d }, feed, plungeFeed: 300,
  cuts: [{ moves: [{ x: 5, y: 5, z: 0 }, { x: 50, y: 5, z }, { x: 50, y: 40, z }] }],
} as unknown as Toolpath);

const input = (over: Partial<SheetInput> = {}): SheetInput => ({
  title: 'Body <A>', date: '17 November 2026', controller: 'Marlin (MPCNC default)', spindle: 'manual', rpm: 10000, arcs: false,
  bed: { x: 600, y: 600 }, warnings: [], files: [{ name: 'job.gcode', note: 'Zero at the corner.\nZ on top.', paths: [cut(6, 'Pocket'), cut(3, 'Detail'), cut(6, 'Outside')] }], ...over,
});

describe('setup sheet', () => {
  it('lists bits in order of first use and which operations use them', () => {
    const b = bitsOf(input().files[0].paths);
    expect(b.map(x => x.tool.diameter)).toEqual([6, 3]);
    expect(b[0].used).toEqual(['Pocket', 'Outside']);
  });
  it('shows the bits, the operations in order, the note and the change summary', () => {
    const h = setupSheetHtml(input());
    expect(h).toContain('6mm flat end mill');
    expect(h.indexOf('Pocket')).toBeLessThan(h.indexOf('Detail'));
    expect(h).toContain('Zero at the corner.<br>Z on top.');
    expect(h).toContain('1 bit change');
    expect(h).toContain('<svg');
    expect(h).toContain('work area 600 x 600 mm');
  });
  it('escapes names and warnings so a layer called <script> cannot break the page', () => {
    const h = setupSheetHtml(input({ title: '<script>x</script>', warnings: ['a < b & c'], files: [{ name: 'job.gcode', note: '<b>', paths: [cut(6, '"><img>')] }] }));
    expect(h).not.toContain('<script>x');
    expect(h).not.toContain('<img>');
    expect(h).toContain('a &lt; b &amp; c');
    expect(esc(`'"<>&`)).toBe('&#39;&quot;&lt;&gt;&amp;');
  });
  it('flags a file that leaves the work area', () => {
    const h = setupSheetHtml(input({ bed: { x: 30, y: 30 } }));
    expect(h).toContain('Outside your work area');
    expect(setupSheetHtml(input())).not.toContain('Outside your work area');
  });
  it('one section per file', () => {
    const f = input().files[0];
    const h = setupSheetHtml(input({ files: [{ ...f, name: 'side1.gcode' }, { ...f, name: 'side2.gcode' }] }));
    expect(h).toContain('1. side1.gcode');
    expect(h).toContain('2. side2.gcode');
  });
  it('the start steps follow the zeroing method', () => {
    const first = cut(6, 'a');
    expect(startSteps(input(), first).join(' ')).toMatch(/Set X\/Y\/Z zero by hand/);
    expect(startSteps(input(), first).join(' ')).toMatch(/switch the router on/);
    const guided = startSteps(input({ toolChange: { mode: 'probe', probeAtStart: true, probeXY: true, guided: true } }), first).join(' ');
    expect(guided).toMatch(/three times/);
    expect(guided).toMatch(/take the touch plate away/);
    expect(startSteps(input({ spindle: 'm3', rpm: 12000 }), first).join(' ')).toMatch(/12000 rpm/);
    expect(startSteps(input({ toolChange: { mode: 'probe', probeAtStart: true, probeXY: true, guided: true } }), cut(0.5, 'v')).length).toBeGreaterThan(0);
  });
  it('describes bit changes', () => {
    expect(changeSummary(undefined, 1)).toMatch(/no bit changes/);
    expect(changeSummary(undefined, 3)).toMatch(/2 bit changes\. The file pauses where it is/);
    expect(changeSummary({ mode: 'probe', liftZ: 40, home: true, x: 5, y: 6 }, 2)).toMatch(/Z 40, re-homes X and Y and goes to X5 Y6.*touch plate/);
  });
  it('thins very long paths and handles empty input', () => {
    const big = { ...cut(6, 'big'), cuts: [{ moves: Array.from({ length: 60000 }, (_, i) => ({ x: i % 300, y: Math.floor(i / 300), z: -1 })) }] } as unknown as Toolpath;
    expect((previewSvg([big]).match(/L/g) ?? []).length).toBeLessThan(25000);
    expect(previewSvg([])).toBe('');
    expect(fmtMinutes(0.2)).toBe('under a minute');
    expect(fmtMinutes(95)).toBe('1 h 35 min');
  });
});
