import { describe, it, expect } from 'vitest';
import { History, ProjectError, projectToSnapshot, sameSnapshot, snapshotToProject, type Snapshot } from '../src/project';
import { finalize } from '../src/import/shape';

const shapes = (n = 2) => finalize(Array.from({ length: n }, (_, i) => ({
  layer: i ? 'B' : 'A', closed: true,
  pts: [{ x: i, y: 0 }, { x: i + 10.123456, y: 0 }, { x: i + 10, y: 5.55555 }],
})));
const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  source: { name: 'a.svg', text: '<svg/>' }, shapes: shapes(), hidden: ['B'],
  ops: [{ id: 1, ids: [0, 1], s: { kind: 'outside', depth: 12, tabs: true }, blank: [[{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }]] }],
  nextOp: 2, frontRef: 0, backRef: 1, form: { bedx: '600', ramp: true, flavor: 'marlin' }, ...over,
});

describe('project files', () => {
  it('round-trips a document', () => {
    const s = snap();
    const { snapshot, savedAt } = projectToSnapshot(snapshotToProject(s, new Date('2026-01-02T03:04:05Z')));
    expect(savedAt).toBe('2026-01-02T03:04:05.000Z');
    expect(snapshot.shapes.length).toBe(2);
    expect(snapshot.shapes[0].layer).toBe('A'); expect(snapshot.shapes[1].layer).toBe('B');
    expect(snapshot.shapes[0].closed).toBe(true);
    expect(snapshot.hidden).toEqual(['B']);
    expect(snapshot.ops[0].ids).toEqual([0, 1]);
    expect(snapshot.ops[0].s).toEqual({ kind: 'outside', depth: 12, tabs: true });
    expect(snapshot.ops[0].blank![0].length).toBe(3);
    expect(snapshot.nextOp).toBe(2); expect(snapshot.frontRef).toBe(0); expect(snapshot.backRef).toBe(1);
    expect(snapshot.form).toEqual({ bedx: '600', ramp: true, flavor: 'marlin' });
    expect(snapshot.source).toEqual({ name: 'a.svg', text: '<svg/>' });
  });
  it('rounds points to 0.001 mm and rebuilds ids and bounding boxes', () => {
    const { snapshot } = projectToSnapshot(snapshotToProject(snap()));
    expect(snapshot.shapes[0].pts[1].x).toBeCloseTo(10.123, 6);
    expect(snapshot.shapes[1].id).toBe(1);
    expect(snapshot.shapes[0].bbox.maxX).toBeCloseTo(10.123, 6);
    expect(snapshot.shapes[0].bbox.maxY).toBeCloseTo(5.556, 6);
  });
  it('is a reasonably compact format (flat number arrays)', () => {
    const many = finalize([{ layer: 'L', closed: true, pts: Array.from({ length: 2000 }, (_, i) => ({ x: i * 0.5, y: Math.sin(i) * 10 })) }]);
    const txt = snapshotToProject(snap({ shapes: many, ops: [], frontRef: null, backRef: null }));
    expect(txt.length).toBeLessThan(2000 * 2 * 9 + 2000);
  });
  it('rejects things that are not projects, with a plain message', () => {
    expect(() => projectToSnapshot('not json')).toThrow(ProjectError);
    expect(() => projectToSnapshot('{"hello":1}')).toThrow(/not an open-cam project/);
    expect(() => projectToSnapshot(JSON.stringify({ app: 'open-cam', version: 99, shapes: [], ops: [] }))).toThrow(/newer version/);
    expect(() => projectToSnapshot(JSON.stringify({ app: 'open-cam', version: 1, ops: [] }))).toThrow(/damaged/);
  });
  it('rejects damaged shapes and operations instead of loading garbage', () => {
    const base = JSON.parse(snapshotToProject(snap()));
    const bad1 = { ...base, shapes: [{ layer: 'A', closed: true, pts: [0, 1, 'x', 3] }] };
    expect(() => projectToSnapshot(JSON.stringify(bad1))).toThrow(/bad coordinates/);
    const bad2 = { ...base, ops: [{ id: 1, ids: [0, 99], s: {} }] };
    expect(() => projectToSnapshot(JSON.stringify(bad2))).toThrow(/missing shape/);
    const bad3 = { ...base, ops: [{ id: 'x', ids: [], s: {} }] };
    expect(() => projectToSnapshot(JSON.stringify(bad3))).toThrow(/not valid/);
  });
  it('ignores references to shapes that do not exist and tolerates missing optional parts', () => {
    const base = JSON.parse(snapshotToProject(snap()));
    const odd = { ...base, frontRef: 50, backRef: -1, source: 5, hidden: 'x', form: { a: 1, b: 'ok' } };
    const { snapshot } = projectToSnapshot(JSON.stringify(odd));
    expect(snapshot.frontRef).toBeNull(); expect(snapshot.backRef).toBeNull();
    expect(snapshot.source).toBeNull(); expect(snapshot.hidden).toEqual([]);
    expect(snapshot.form).toEqual({ b: 'ok' });
  });
});

describe('undo and redo history', () => {
  const a = snap(), b = snap({ nextOp: 3 }), c = snap({ nextOp: 4 });
  it('walks back and forward', () => {
    const h = new History(); h.reset(a);
    expect(h.commit(b)).toBe(true); expect(h.commit(c)).toBe(true);
    expect(h.canUndo).toBe(true); expect(h.canRedo).toBe(false);
    expect(h.undo()).toBe(b); expect(h.undo()).toBe(a); expect(h.undo()).toBeNull();
    expect(h.canRedo).toBe(true);
    expect(h.redo()).toBe(b); expect(h.redo()).toBe(c); expect(h.redo()).toBeNull();
  });
  it('a new change after undoing throws away what could have been redone', () => {
    const h = new History(); h.reset(a); h.commit(b); h.commit(c);
    h.undo(); h.undo();
    const d = snap({ nextOp: 9 });
    h.commit(d);
    expect(h.canRedo).toBe(false);
    expect(h.undo()).toBe(a);
  });
  it('does not record a state identical to the current one', () => {
    const h = new History(); h.reset(a);
    expect(h.commit(snap({ shapes: a.shapes }))).toBe(false);          // same shapes, same everything else
    expect(h.size).toBe(1); expect(h.canUndo).toBe(false);
  });
  it('notices every kind of change', () => {
    expect(sameSnapshot(a, snap({ form: { bedx: '601', ramp: true, flavor: 'marlin' } }))).toBe(false);
    expect(sameSnapshot(a, snap({ hidden: [] }))).toBe(false);
    expect(sameSnapshot(a, snap({ shapes: shapes() }))).toBe(false);            // new shape objects = a change
    expect(sameSnapshot(a, snap({ shapes: a.shapes }))).toBe(true);
    expect(sameSnapshot(a, snap({ frontRef: null, shapes: a.shapes }))).toBe(false);
  });
  it('keeps only the most recent states when the limit is reached', () => {
    const h = new History(3); h.reset(snap({ nextOp: 1 }));
    for (let i = 2; i <= 6; i++) h.commit(snap({ nextOp: i }));
    expect(h.size).toBe(3);
    expect(h.current!.nextOp).toBe(6);
    h.undo(); h.undo();
    expect(h.current!.nextOp).toBe(4);
    expect(h.canUndo).toBe(false);
  });
});
