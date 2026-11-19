/**
 * Machine definitions: one small JSON file per controller (src/core/machines/*.json). Drop a new file in that folder and the
 * controller appears in the list. No code change needed.
 *
 * The file layout follows PureCutCNC's machine definitions (https://github.com/PureCutCNC/purecutcnc, Apache-2.0, see NOTICE.md),
 * so their files, and what their post-processor converter produces, can be used here. Only the parts open-cam needs are read; the
 * rest (rotary, plasma, canned cycles, coolant...) is ignored. Settings that only open-cam has live under "openCam".
 *
 * One deliberate difference: a definition's own pause command (their "pauseCommand", M1 for Mach3) is NOT used. M1 only stops when
 * "optional stop" is switched on, and a bit change must always stop, so open-cam always writes M0.
 */

export interface MachineDef {
  id: string;
  name: string;
  description: string;
  /** File extension for downloads, without the dot. */
  extension: string;
  /** Lines at the very top (placeholders {programName} {unitsCommand} {wcsCommand} {date}); null = open-cam's built-in G21 G90 G17. */
  header: string[] | null;
  /** Lines at the very end, before the program-end command. */
  footer: string[];
  commentPrefix: string;
  commentSuffix: string;
  lineNumbers: boolean;
  lineStep: number;
  units: string;
  /** Work coordinate system select (G54...), or null. */
  wcs: string | null;
  /** Whether G2/G3 arcs can be assumed to work (the default for the Arcs switch). */
  arcs: boolean;
  spindleOn: string;
  spindleOff: string;
  /** The speed word, S. */
  rpmWord: string;
  /** Lines for a bit change, with {toolNumber} and {toolName}; null = the plain M0 pause. */
  toolChange: string[] | null;
  /** Written at the very end, e.g. M2 or M30; null = nothing. */
  end: string | null;
  /** 'manual': pause so you can switch the router on. 'm3': the program switches it on. */
  spindle: 'manual' | 'm3';
  /** Marlin: fast moves need a feed word, or they crawl at the last cutting feed. */
  rapidWithFeed: boolean;
  /** Command that shows a message on the controller's screen (Marlin M117), or null. */
  display: string | null;
  /** Command that re-homes X and Y on the stops (Marlin G28 X Y), or null. */
  home: string | null;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);
const strs = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every(x => typeof x === 'string') ? (v as string[]) : undefined);

/** Reads one definition. Throws a plain-language error when it cannot be used. */
export function parseMachine(raw: unknown): MachineDef {
  const r = obj(raw);
  const id = str(r.id), name = str(r.name);
  if (!id || !/^[a-z0-9_-]+$/i.test(id)) throw new Error('A machine definition needs an "id" (letters, digits, - or _).');
  if (!name) throw new Error(`Machine "${id}" needs a "name".`);
  const program = obj(r.program), motion = obj(r.motion), feed = obj(r.feedSpeed), tc = obj(r.toolChange), stop = obj(r.stop);
  const wcs = obj(r.workCoordinates), units = obj(r.units), mine = obj(r.openCam);

  let header = strs(program.header)?.map(l => l.trimEnd()).filter(l => l.trim() !== '') ?? null;
  if (header && !header.length) header = null;
  if (header) { // never leave out the two things that make the numbers mean something
    if (!header.some(l => /\{unitsCommand\}|\bG2[01]\b/.test(l))) header.push('{unitsCommand}');
    if (!header.some(l => /\bG90\b/.test(l))) header.push('G90');
  }
  const prefix = str(program.commentPrefix) ?? ';';
  const lineStep = typeof program.lineNumberIncrement === 'number' && program.lineNumberIncrement >= 1 ? Math.round(program.lineNumberIncrement) : 10;
  const commands = strs(tc.commands)?.filter(l => l.trim() !== '');
  return {
    id, name,
    description: str(r.description) ?? '',
    extension: (str(r.fileExtension) ?? 'gcode').replace(/^\./, ''),
    header,
    footer: strs(program.footer)?.filter(l => l.trim() !== '') ?? [],
    commentPrefix: prefix,
    commentSuffix: str(program.commentSuffix) ?? '',
    lineNumbers: program.lineNumbers === true,
    lineStep,
    units: str(units.mmCommand) ?? 'G21',
    wcs: str(wcs.selectCommand) ?? null,
    arcs: motion.arcInterpolation === true,
    spindleOn: str(feed.spindleOnCW) ?? 'M3',
    spindleOff: str(feed.spindleOff) ?? 'M5',
    rpmWord: str(feed.rpmCommand) ?? 'S',
    toolChange: commands && commands.length ? commands : null,
    end: str(stop.programEndCommand) ?? null,
    spindle: mine.spindle === 'm3' ? 'm3' : 'manual',
    rapidWithFeed: mine.rapidWithFeed === true,
    display: str(mine.display) ?? null,
    home: str(mine.home) ?? null,
  };
}

const found = import.meta.glob('./machines/*.json', { eager: true, import: 'default' }) as Record<string, unknown>;
const all: MachineDef[] = Object.entries(found).map(([file, raw]) => {
  try { return parseMachine(raw); } catch (e) { throw new Error(`${file}: ${(e as Error).message}`); }
});
const rank = (m: MachineDef) => (m.id === 'marlin' ? 0 : m.id === 'grbl' ? 1 : 2);
all.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));

/** Every available controller: Marlin and GRBL first, then the rest by name. */
export const MACHINES: readonly MachineDef[] = all;

export const hasMachine = (id: string) => all.some(m => m.id === id);

/** The definition for an id; an unknown id gives Marlin, so a project or saved profile from a newer version still works. */
export function machineDef(id: string): MachineDef {
  return all.find(m => m.id === id) ?? all.find(m => m.id === 'marlin') ?? all[0];
}
