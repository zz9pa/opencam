/**
 * Machine defaults kept in the browser (localStorage), so every new project starts with your machine's firmware, work
 * area and your own start/end G-code. They are not stored in project files: a project moves between machines, the
 * machine stays with the browser.
 */
import type { ToolChange } from './core/gcode';

export interface MachineProfile {
  flavor: 'marlin' | 'grbl';
  arcs: boolean;
  bedX: number;
  bedY: number;
  startGcode: string;
  endGcode: string;
  toolChange?: ToolChange;
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
  if (r.toolChange && typeof r.toolChange === 'object') {
    const t = r.toolChange as Record<string, unknown>;
    if (t.mode === 'pause' || t.mode === 'move' || t.mode === 'probe' || t.mode === 'custom') {
      const tc: ToolChange = { mode: t.mode };
      const num = (k: string) => (typeof t[k] === 'number' && Number.isFinite(t[k] as number) ? (t[k] as number) : undefined);
      const wallX = num('wallX'), wallY = num('wallY'), travel = num('xyTravel'), xyLift = num('xyLift'), backoff = num('backoff'), lift = num('liftZ'), x = num('x'), y = num('y'), plate = num('plate'), depth = num('probeDepth'), feed = num('probeFeed');
      if (lift !== undefined && lift >= 0) tc.liftZ = lift;
      if (x !== undefined && y !== undefined) { tc.x = x; tc.y = y; }
      if (plate !== undefined && plate >= 0) tc.plate = plate;
      if (depth !== undefined && depth > 0) tc.probeDepth = depth;
      if (feed !== undefined && feed > 0) tc.probeFeed = feed;
      if (wallX !== undefined) tc.wallX = wallX;
      if (wallY !== undefined) tc.wallY = wallY;
      if (xyLift !== undefined && xyLift >= 0) tc.xyLift = xyLift;
      if (backoff !== undefined && backoff >= 0) tc.backoff = backoff;
      if (t.dirX === 1 || t.dirX === -1) tc.dirX = t.dirX;
      if (t.dirY === 1 || t.dirY === -1) tc.dirY = t.dirY;
      if (t.zeroWith === 'g92' || t.zeroWith === 'g10') tc.zeroWith = t.zeroWith;
      if (t.probeCmd === 'G38.2' || t.probeCmd === 'G38.3') tc.probeCmd = t.probeCmd;
      if (travel !== undefined && travel > 0) tc.xyTravel = travel;
      if (t.probeXY === true) tc.probeXY = true;
      if (t.guided === true) tc.guided = true;
      if (typeof t.macro === 'string' && t.macro.trim()) tc.macro = t.macro;
      if (typeof t.startMacro === 'string' && t.startMacro.trim()) tc.startMacro = t.startMacro;
      if (t.home === true) tc.home = true;
      if (t.probeAtStart === true) tc.probeAtStart = true;
      out.toolChange = tc;
    }
  }
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
