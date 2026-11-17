/**
 * Machine defaults kept in the browser (localStorage), so every new project starts with your machine's firmware, work
 * area and your own start/end G-code. They are not stored in project files: a project moves between machines, the
 * machine stays with the browser.
 */
export interface MachineProfile {
  flavor: 'marlin' | 'grbl';
  arcs: boolean;
  bedX: number;
  bedY: number;
  startGcode: string;
  endGcode: string;
}

export const MACHINE_KEY = 'open-cam.machine';

export interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

/** Reads the saved profile; anything missing or damaged is left out, so the caller keeps its own default for it. */
export function loadMachine(store: KV | undefined): Partial<MachineProfile> {
  if (!store) return {};
  let raw: unknown;
  try { raw = JSON.parse(store.getItem(MACHINE_KEY) ?? 'null'); } catch { return {}; }
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<MachineProfile> = {};
  if (r.flavor === 'marlin' || r.flavor === 'grbl') out.flavor = r.flavor;
  if (typeof r.arcs === 'boolean') out.arcs = r.arcs;
  if (typeof r.bedX === 'number' && r.bedX >= 10) out.bedX = r.bedX;
  if (typeof r.bedY === 'number' && r.bedY >= 10) out.bedY = r.bedY;
  if (typeof r.startGcode === 'string') out.startGcode = r.startGcode;
  if (typeof r.endGcode === 'string') out.endGcode = r.endGcode;
  return out;
}

/** Returns false when the browser refuses (private mode, storage full). */
export function saveMachine(store: KV | undefined, p: MachineProfile): boolean {
  if (!store) return false;
  try { store.setItem(MACHINE_KEY, JSON.stringify(p)); return true; } catch { return false; }
}

export function forgetMachine(store: KV | undefined): void {
  try { store?.removeItem(MACHINE_KEY); } catch { /* nothing to forget */ }
}
