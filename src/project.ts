import type { Loop } from './core/types';
import { finalize, type Shape } from './import/shape';

/**
 * The state of a document, as captured for undo and saved in project files.
 * Toolpaths are NOT stored: they are recomputed from the shapes, operations and settings when the state is applied.
 */
export interface OpSnap { id: number; ids: number[]; s: Record<string, unknown>; blank?: Loop[] }

/** The 3D model (STL triangles as read: nine numbers per triangle). Compared by identity; never edited. */
export interface ModelSnap { name: string; tri: Float32Array }

export interface Snapshot {
  /** The file the drawing was imported from (kept so import settings can be changed later), if any */
  source: { name: string; text: string } | null;
  /** The loaded 3D model, if any (stored in the project so it need not be loaded again) */
  model: ModelSnap | null;
  shapes: Shape[];
  hidden: string[];
  ops: OpSnap[];
  nextOp: number;
  frontRef: number | null;
  backRef: number | null;
  /** Every settings control in the side panel, by element id */
  form: Record<string, string | boolean>;
}

export const PROJECT_APP = 'open-cam';
export const PROJECT_VERSION = 1;

/** Float32 numbers as base64 text (little-endian, as every browser machine is). */
export function floatsToBase64(a: Float32Array): string {
  const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
export function base64ToFloats(t: string): Float32Array {
  const s = atob(t);
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  if (b.length % 36 !== 0) throw new ProjectError('This project file is damaged (the 3D model is not valid).');
  const f = new Float32Array(b.buffer);
  for (let i = 0; i < f.length; i++) if (!Number.isFinite(f[i])) throw new ProjectError('This project file is damaged (the 3D model is not valid).');
  return f;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const flat = (l: Loop) => { const o: number[] = []; for (const p of l) o.push(round3(p.x), round3(p.y)); return o; };
const unflat = (a: number[]): Loop => { const o: Loop = []; for (let i = 0; i + 1 < a.length; i += 2) o.push({ x: a[i], y: a[i + 1] }); return o; };

/** Two snapshots describe the same document (shapes compared by identity: they are only ever replaced, not edited). */
export function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  if (a.shapes.length !== b.shapes.length) return false;
  for (let i = 0; i < a.shapes.length; i++) if (a.shapes[i] !== b.shapes[i]) return false;
  if (a.model !== b.model) return false;
  if (a.source?.name !== b.source?.name || a.source?.text !== b.source?.text) return false;
  return a.nextOp === b.nextOp && a.frontRef === b.frontRef && a.backRef === b.backRef
    && JSON.stringify(a.ops) === JSON.stringify(b.ops) && JSON.stringify(a.hidden) === JSON.stringify(b.hidden)
    && JSON.stringify(a.form) === JSON.stringify(b.form);
}

/** The text of a project file. Points are rounded to 0.001 mm and stored flat to keep the file small. */
export function snapshotToProject(s: Snapshot, now = new Date()): string {
  return JSON.stringify({
    app: PROJECT_APP, version: PROJECT_VERSION, savedAt: now.toISOString(),
    source: s.source,
    model: s.model ? { name: s.model.name, tri: floatsToBase64(s.model.tri) } : null,
    shapes: s.shapes.map(sh => ({ layer: sh.layer, closed: sh.closed, pts: flat(sh.pts), ...(sh.free ? { free: sh.free } : {}) })),
    hidden: s.hidden,
    ops: s.ops.map(o => ({ ...o, blank: o.blank?.map(flat) })),
    nextOp: s.nextOp, frontRef: s.frontRef, backRef: s.backRef, form: s.form,
  });
}

export class ProjectError extends Error {}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Read a project file. Throws a ProjectError with a plain-English message if it is not a usable project. */
export function projectToSnapshot(text: string): { snapshot: Snapshot; savedAt: string | null } {
  let d: any;
  try { d = JSON.parse(text); } catch { throw new ProjectError('This is not a project file (it could not be read).'); }
  if (!d || d.app !== PROJECT_APP) throw new ProjectError('This is not an open-cam project file.');
  if (!isNum(d.version) || d.version > PROJECT_VERSION) throw new ProjectError('This project was saved by a newer version of open-cam and cannot be opened here.');
  if (!Array.isArray(d.shapes) || !Array.isArray(d.ops)) throw new ProjectError('This project file is damaged (shapes or operations are missing).');
  const raw: { layer: string; pts: Loop; closed: boolean; free?: [number, number] }[] = [];
  for (const sh of d.shapes) {
    if (!sh || typeof sh.layer !== 'string' || !Array.isArray(sh.pts) || sh.pts.length < 4 || !sh.pts.every(isNum)) {
      throw new ProjectError('This project file is damaged (a shape has bad coordinates).');
    }
    raw.push({ layer: sh.layer, closed: !!sh.closed, pts: unflat(sh.pts), ...(Array.isArray(sh.free) && sh.free.length === 2 && sh.free.every(isNum) ? { free: [sh.free[0], sh.free[1]] as [number, number] } : {}) });
  }
  const shapes = finalize(raw);
  const ops: OpSnap[] = d.ops.map((o: any) => {
    if (!o || !isNum(o.id) || !Array.isArray(o.ids) || typeof o.s !== 'object' || !o.s) throw new ProjectError('This project file is damaged (an operation is not valid).');
    // an operation can only refer to shapes that exist
    if (!o.ids.every((i: unknown) => isNum(i) && i >= 0 && i < shapes.length)) throw new ProjectError('This project file is damaged (an operation refers to a missing shape).');
    return { id: o.id, ids: o.ids, s: o.s, blank: Array.isArray(o.blank) ? o.blank.map(unflat) : undefined };
  });
  const ref = (v: unknown) => (isNum(v) && v >= 0 && v < shapes.length ? v : null);
  const form: Record<string, string | boolean> = {};
  if (d.form && typeof d.form === 'object') for (const [k, v] of Object.entries(d.form)) if (typeof v === 'string' || typeof v === 'boolean') form[k] = v;
  let model: ModelSnap | null = null;
  if (d.model && typeof d.model.name === 'string' && typeof d.model.tri === 'string') {
    try { model = { name: d.model.name, tri: base64ToFloats(d.model.tri) }; } catch (e) { if (e instanceof ProjectError) throw e; throw new ProjectError('This project file is damaged (the 3D model is not valid).'); }
  }
  const src = d.source && typeof d.source.name === 'string' && typeof d.source.text === 'string' ? { name: d.source.name, text: d.source.text } : null;
  return {
    savedAt: typeof d.savedAt === 'string' ? d.savedAt : null,
    snapshot: {
      source: src, model, shapes, ops, hidden: Array.isArray(d.hidden) ? d.hidden.filter((x: unknown) => typeof x === 'string') : [],
      nextOp: isNum(d.nextOp) ? d.nextOp : ops.reduce((m, o) => Math.max(m, o.id), 0) + 1,
      frontRef: ref(d.frontRef), backRef: ref(d.backRef), form,
    },
  };
}

/** Undo/redo history: a list of snapshots with a cursor. */
export class History {
  private items: Snapshot[] = [];
  private at = -1;
  constructor(private readonly limit = 100) {}
  get canUndo() { return this.at > 0; }
  get canRedo() { return this.at >= 0 && this.at < this.items.length - 1; }
  get current(): Snapshot | null { return this.items[this.at] ?? null; }
  get size() { return this.items.length; }
  /** Start a fresh history from this state (for example when a new file or project is opened). */
  reset(s: Snapshot) { this.items = [s]; this.at = 0; }
  /** Record a new state. Does nothing if it is the same as the current one. Drops anything that could have been redone. */
  commit(s: Snapshot): boolean {
    const cur = this.current;
    if (cur && sameSnapshot(cur, s)) return false;
    this.items.length = this.at + 1;
    this.items.push(s);
    if (this.items.length > this.limit) this.items.shift();
    this.at = this.items.length - 1;
    return true;
  }
  undo(): Snapshot | null { if (!this.canUndo) return null; this.at--; return this.items[this.at]; }
  redo(): Snapshot | null { if (!this.canRedo) return null; this.at++; return this.items[this.at]; }
}
