import type { Cut, Toolpath } from './types';
import { fitArcs, type Seg } from './arcs';

export type Flavor = 'marlin' | 'grbl';

export interface Post {
  flavor: Flavor;
  /**
   * Write circular arcs as G2/G3 instead of many short G1 lines. GRBL always supports them. Marlin only does if it
   * was built with ARC_SUPPORT, so this is opt-in: run the arc test file first.
   */
  arcs?: boolean;
  /** Largest deviation allowed when replacing lines with arcs, mm */
  arcTol?: number;
  /** MPCNC + Makita router has no spindle control: use 'manual'. */
  spindle: 'manual' | 'm3';
  spindleRpm?: number;
  safeZ: number;
  decimals: number;
  /** Marlin treats G0 like G1 and keeps the last feed rate, so fast moves would crawl at the last cutting or plunge feed. Marlin output therefore states this feed (mm/min) on every G0; the firmware still limits each axis to its own maximum. */
  rapidFeed?: number;
  /** Your own start lines. When not blank they REPLACE the built-in "start the router" lines (they go right after G21 G90 G17). */
  startGcode?: string;
  /** Your own end lines. When not blank they REPLACE the built-in "stop the router / go to X0 Y0 / M2" lines (they go after the final lift to safe Z). */
  endGcode?: string;
  /** Help with bit changes; leave out for a plain pause. */
  toolChange?: ToolChange;
}

/**
 * What to do when the job needs another bit. A tool change on a router machine means taking the router out, changing the bit,
 * putting it back and finding Z zero again, so the program can help with the awkward parts.
 */
export interface ToolChange {
  /** 'pause': stop where it is (the plain behaviour). 'move': lift, go to a spot over the piece, stop. 'probe': as 'move', then find Z zero with a touch plate (G38.2). */
  mode: 'pause' | 'move' | 'probe' | 'custom';
  /**
   * 'custom' mode: your own lines, run after the bit has been swapped (the router is still off). For any probe or routine the
   * built-in 'probe' mode does not fit. Placeholders: {d} bit diameter, {r} bit radius, {plate}, {lift}, {safe} (all in mm).
   */
  macro?: string;
  /** Your own lines run once at the start, BEFORE the router-start pause (so a live touch plate is safe). Same placeholders. Works in every mode. */
  startMacro?: string;
  /** Lift to this Z (work coordinates) before anything else, so the router can be lifted out, mm. Default 30. */
  liftZ?: number;
  /** Re-home X and Y to the stops (G28 X Y) before going to the spot. Marlin only, and only right if the stops are where your work X/Y zero is. */
  home?: boolean;
  /** The spot (work coordinates) to go to for the change / for Z zero. Leave both out to use the start of the next cut. */
  x?: number; y?: number;
  /** Probe mode: thickness of the touch plate (zero if the bit touches the material itself), mm. Z is set to this where the bit stops. */
  plate?: number;
  /** Probe mode: how far below Z zero the bit may travel looking for the plate, mm. Default 25. */
  probeDepth?: number;
  /** Probe mode: probing speed, mm/min. Default 60. */
  probeFeed?: number;
  /** Probe mode: also find Z zero at the very start of the job (the first bit is already fitted). */
  probeAtStart?: boolean;
  /** With probeAtStart: also find X and Y zero by touching two walls with the side of the bit (see wallX, wallY, dirX, dirY). The bit is jogged into position first. */
  probeXY?: boolean;
  /** Where the X wall is, measured from the zero you want X to become (the workpiece corner), mm. Signed. The bit radius is added for you. Default 10. */
  wallX?: number;
  /** The same for the Y wall. Default 10. */
  wallY?: number;
  /** Which way the bit moves to reach the X wall: -1 (towards lower X, so the wall is at lower X than the bit) or 1. Default -1. */
  dirX?: -1 | 1;
  /** The same for Y. Default -1. */
  dirY?: -1 | 1;
  /** How far the bit may travel sideways looking for a wall, mm. Default 20. */
  xyTravel?: number;
  /**
   * Guided (start-of-job probing with `probeXY`): instead of one jogged position and a fixed route, the program stops before each
   * touch so YOU move the bit: beside the X face, then beside the Y face, then over the plate for Z. The order is X, Y, Z.
   */
  guided?: boolean;
  /** Before touching the walls the bit rises this far above where Z was found, mm. Default 2.5. */
  xyLift?: number;
  /** After touching a wall the bit backs off this far, mm. Default 3. */
  backoff?: number;
  /** How a position is declared: G92 (default, Marlin and GRBL) or 'g10' for G10 L20 P1 (the GRBL / LinuxCNC way). */
  zeroWith?: 'g92' | 'g10';
  /** The probing command: G38.2 (default: error if nothing is touched) or G38.3 (no error). */
  probeCmd?: 'G38.2' | 'G38.3';
}

const customLines = (s?: string) => (s ?? '').replace(/\r/g, '').split('\n').map(l => l.trimEnd()).filter(l => l.trim() !== '');

export const MPCNC_MAKITA: Post = { flavor: 'marlin', spindle: 'manual', safeZ: 5, decimals: 3 };

const RAPID_FEED = 3000;
const toolKey = (t: Toolpath['tool']) => `${t.type}|${t.diameter}|${t.angle ?? ''}|${t.tipDiameter ?? ''}`;

/**
 * Where a cut can drop in quickly. When an earlier pass with the same bit already cut the full depth at exactly this cut's start
 * point (the usual case for the second and later depths of a profile, pocket ring or hole), the bit may rapid down through that air
 * to 1 mm above this pass's start depth instead of feeding all the way from Z1 at plunge speed. Returns cut -> rapid-to Z.
 */
export function planEntries(paths: Toolpath[], safeZ = 5): Map<Cut, number> {
  const plan = new Map<Cut, number>();
  const cleared = new Map<string, number>();
  const top = Math.min(safeZ, 1);
  for (const tp of paths) {
    const tk = toolKey(tp.tool);
    for (const c of tp.cuts) {
      const first = c.moves[0], last = c.moves[c.moves.length - 1];
      if (!first || c.pauseBefore) { if (c.pauseBefore) cleared.clear(); continue; }
      const key = `${tk}|${first.x.toFixed(3)},${first.y.toFixed(3)}`;
      const below = cleared.get(key);
      if (c.airTo !== undefined && c.airTo < top - 1e-9 && !first.rapid) plan.set(c, c.airTo);
      if (!first.rapid && below !== undefined && below <= first.z + 1e-6 && first.z + 1 < top - 1e-9) plan.set(c, first.z + 1);
      if (c.moves.length > 1 && !last.rapid && Math.abs(last.x - first.x) < 1e-6 && Math.abs(last.y - first.y) < 1e-6) {
        cleared.set(key, Math.min(below ?? Infinity, last.z));
      }
    }
  }
  return plan;
}
export function toGcode(paths: Toolpath[], post: Post = MPCNC_MAKITA): string {
  const f = (n: number) => String(+n.toFixed(post.decimals));
  const entry = planEntries(paths, post.safeZ);
  const rapidFeed = post.rapidFeed ?? RAPID_FEED;
  const out: string[] = [
    '; Generated by open-cam',
    '; Units: mm, absolute. Work zero: X/Y at your chosen origin, Z=0 at TOP of stock.',
    ...(post.arcs ? ['; Uses G2/G3 arcs: your firmware must support them (run the arc test file first).'] : []),
    'G21', 'G90', 'G17',
  ];
  let lastF = -1;
  // Fast moves: Marlin needs the feed stated (see Post.rapidFeed), and that changes the modal feed, so the next G1 restates its own.
  const g0 = (s: string) => { if (post.flavor === 'marlin') { lastF = -1; return `G0 ${s} F${f(rapidFeed)}`; } return `G0 ${s}`; };
  const say = (t: string) => (post.flavor === 'marlin' ? [`M117 ${t.slice(0, 40)}`] : []);
  const tc = post.toolChange;
  const firstMove = (tp: Toolpath) => tp.cuts.find(c => c.moves.length)?.moves[0];
  /** Your own lines with the placeholders filled in for the bit about to be used. */
  const fill = (text: string | undefined, tool: Toolpath['tool']) => customLines(text).map(l => l
    .replace(/\{d\}/g, f(tool.diameter)).replace(/\{r\}/g, f(tool.diameter / 2))
    .replace(/\{plate\}/g, f(tc?.plate ?? 0)).replace(/\{lift\}/g, f(Math.max(tc?.liftZ ?? 30, post.safeZ))).replace(/\{safe\}/g, f(post.safeZ)));
  const probe = tc?.probeCmd === 'G38.3' ? 'G38.3' : 'G38.2';
  /** Declare the current position of some axes: "X13", "X0 Y0" ... */
  const declare = (words: string, note = '') => (tc?.zeroWith === 'g10' ? `G10 L20 P1 ${words}` : `G92 ${words}`) + (note ? ` ; ${note}` : '');
  const probeZ = () => [
    `${probe} Z${f(-(tc?.probeDepth ?? 25))} F${f(tc?.probeFeed ?? 60)}`, declare(`Z${f(tc?.plate ?? 0)}`, "the bit is on the plate: Z is the plate's thickness"),
  ];
  /** The lift / go-to-the-spot / (probe) steps. `change`: a bit has to be swapped first (stop for it). */
  const changeSteps = (next: Toolpath, change: boolean) => {
    const L: string[] = [];
    const lift = Math.max(tc?.liftZ ?? 30, post.safeZ), mode = tc?.mode ?? 'pause';
    L.push(g0(`Z${f(lift)}`));
    if (tc?.home && post.flavor === 'marlin') L.push('G28 X Y ; re-home X and Y on the stops (needs X/Y zero to be at the stops)');
    const m = firstMove(next);
    const spot = tc?.x !== undefined && tc?.y !== undefined ? { x: tc.x, y: tc.y } : m ? { x: m.x, y: m.y } : null;
    if (spot) L.push(g0(`X${f(spot.x)} Y${f(spot.y)}`));
    if (change) {
      L.push(`; CHANGE BIT to ${describeTool(next.tool)}${mode === 'probe' || mode === 'custom' ? ': Z zero is found with the touch plate afterwards' : ' and set Z zero on top of the material'}`, ...say(`Change bit: ${describeTool(next.tool)}`));
      L.push(mode === 'probe' || mode === 'custom' ? 'M0 ; change the bit, refit the router (leave it OFF), set up your touch plate, then resume' : 'M0');
    }
    if (mode === 'custom') {
      const mine = fill(tc?.macro, next.tool);
      L.push('; --- your zeroing G-code ---', ...mine, '; --- end of your zeroing G-code ---', ...say('Start the router'), 'M0 ; switch the router on, then resume');
    }
    if (mode === 'probe') {
      const plate = tc?.plate ?? 0;
      L.push('; finding Z zero: the bit lowers until it touches the plate', ...probeZ(), g0(`Z${f(lift)}`),
        ...say(plate > 0 ? 'Remove plate, start router' : 'Start the router'),
        plate > 0 ? 'M0 ; remove the touch plate, switch the router on, then resume' : 'M0 ; switch the router on, then resume');
    }
    return L;
  };
  /**
   * At the start: find Z (and optionally X and Y) with the touch plate. The router is still OFF here (the plate is live copper),
   * and the bit was jogged by hand into the plate's recess. X/Y probing sets zero at the workpiece corner: the recess walls are
   * `wall` mm in from the plate's corner, the bit touches a wall with its side, so its centre is `wall` plus its radius away.
   */
  const startProbe = (first: Toolpath) => {
    const feed = f(tc?.probeFeed ?? 60), plate = tc?.plate ?? 0, lift = Math.max(tc?.liftZ ?? 30, post.safeZ);
    if (tc?.guided && tc.probeXY && first.tool.type !== 'vbit') {
      const r = first.tool.diameter / 2, travel = tc.xyTravel ?? 20, back = tc.backoff ?? 3;
      const dx = tc.dirX === 1 ? 1 : -1, dy = tc.dirY === 1 ? 1 : -1;
      const wx = tc.wallX ?? 10, wy = tc.wallY ?? 10, ax = wx - dx * r, ay = wy - dy * r;
      const side = (ax_: string, d: number) => `${d > 0 ? 'lower' : 'higher'} ${ax_}`;
      const G: string[] = ['; Guided zeroing, router OFF. The program stops before each touch so you can move the bit.'];
      const pause = (msg: string, comment: string) => G.push(...say(msg), `M0 ; ${comment}`);
      pause('Jog bit beside X face', `jog the bit to the ${side('X', dx)} side of the plate, at a height where its side meets the plate, then resume`);
      G.push(declare('X0'), `${probe} X${f(dx * travel)} F${feed}`, declare(`X${f(ax)}`, `touching the plate face at X ${f(wx)}: bit radius ${f(r)}`), g0(`X${f(ax - dx * back)}`));
      pause('Jog bit beside Y face', `jog the bit to the ${side('Y', dy)} side of the plate, clear of it, at the same kind of height, then resume`);
      G.push(declare('Y0'), `${probe} Y${f(dy * travel)} F${feed}`, declare(`Y${f(ay)}`, `touching the plate face at Y ${f(wy)}: bit radius ${f(r)}`), g0(`Y${f(ay - dy * back)}`));
      pause('Jog bit over the plate', 'jog the bit over the plate, a few mm above it, then resume');
      G.push(declare('Z0', 'the bit height now counts as 0 for the probe'), ...probeZ(), g0(`Z${f(lift)}`), ...say('Remove the touch plate'), 'M0 ; remove the touch plate, then resume');
      return G;
    }
    const L = ['; Before starting: the router is OFF. Jog the bit into the plate recess, a few mm above its floor and clear of the walls.',
      declare('Z0', 'the bit height now counts as 0 for the probe'), ...probeZ()];
    if (tc?.probeXY && first.tool.type !== 'vbit') {
      const r = first.tool.diameter / 2, travel = tc.xyTravel ?? 20, back = tc.backoff ?? 3;
      const dx = tc.dirX === 1 ? 1 : -1, dy = tc.dirY === 1 ? 1 : -1;
      const wx = tc.wallX ?? 10, wy = tc.wallY ?? 10;
      const ax = wx - dx * r, ay = wy - dy * r; // the bit is on the open side of the wall, one radius away from it
      L.push(g0(`Z${f(plate + (tc.xyLift ?? 2.5))}`), `; X and Y: the bit's side touches a wall at X ${f(wx)} and one at Y ${f(wy)} (bit radius ${f(r)})`,
        declare('X0 Y0'), `${probe} X${f(dx * travel)} F${feed}`, declare(`X${f(ax)}`), g0(`X${f(ax - dx * back)}`),
        `${probe} Y${f(dy * travel)} F${feed}`, declare(`Y${f(ay)}`), g0(`Y${f(ay - dy * back)}`));
    } else if (tc?.probeXY) L.push('; (X/Y probing is skipped for a V-bit: its side is not a reliable edge)');
    L.push(g0(`Z${f(lift)}`), ...say('Remove the touch plate'), 'M0 ; remove the touch plate, then resume');
    return L;
  };
  if (tc?.mode === 'probe' && tc.probeAtStart && paths.length) out.push('; --- find zero with the touch plate ---', ...startProbe(paths[0]));
  if (customLines(tc?.startMacro).length && paths.length) out.push('; --- your zeroing G-code (router still off) ---', ...fill(tc?.startMacro, paths[0].tool), '; --- end of your zeroing G-code ---');
  const startLines = customLines(post.startGcode);
  if (startLines.length) out.push('; --- your start G-code ---', ...startLines, '; --- end of your start G-code ---');
  else if (post.spindle === 'm3') out.push(`M3 S${post.spindleRpm ?? 10000}`);
  else if (post.flavor === 'marlin') out.push('M117 Start the router', 'M0 ; start the router, then resume');
  else out.push('; Start the router now, then cycle start', 'M0');
  out.push(g0(`Z${f(post.safeZ)}`));
  let prevTool: Toolpath['tool'] | null = null;
  for (const tp of paths) {
    if (prevTool && !sameTool(prevTool, tp.tool)) {
      if (tc && tc.mode !== 'pause') out.push('; --- tool change ---', ...changeSteps(tp, true));
      else {
        out.push(g0(`Z${f(post.safeZ)}`), `; CHANGE BIT to ${describeTool(tp.tool)} and set Z zero on top of the material`);
        if (post.flavor === 'marlin') out.push(`M117 Change bit: ${describeTool(tp.tool)}`);
        out.push('M0');
      }
    }
    prevTool = tp.tool;
    out.push(`; --- ${tp.name} (${tp.tool.type} ${tp.tool.diameter}mm) ---`);
    for (const c of tp.cuts) {
      const first = c.moves[0];
      if (!first) continue;
      if (c.pauseBefore) {
        out.push(g0(`Z${f(post.safeZ)}`), ...c.pauseBefore.split('\n').map(l => `; ${l}`));
        if (post.flavor === 'marlin') out.push(`M117 ${c.pauseBefore.split('\n')[0].slice(0, 40)}`);
        out.push('M0');
      }
      out.push(g0(`Z${f(post.safeZ)}`), g0(`X${f(first.x)} Y${f(first.y)}`));
      out.push(g0(`Z${f(Math.min(post.safeZ, 1))}`));
      let prev = { x: first.x, y: first.y, z: Math.min(post.safeZ, 1) };
      const drop = entry.get(c); // the same spot was already cut deeper by an earlier pass: rapid down through that air
      if (drop !== undefined) { out.push(g0(`Z${f(drop)}`)); prev = { ...prev, z: drop }; }
      // With arcs on, runs of short moves that follow a circle become single G2/G3 moves.
      const rest: Seg[] = post.arcs ? fitArcs(c.moves, post.arcTol ?? 0.01) : c.moves.slice(1).map(to => ({ to }));
      for (const item of [{ to: first } as Seg, ...rest]) {
        const m = item.to;
        const vertical = Math.hypot(m.x - prev.x, m.y - prev.y) < 1e-9;
        if (item.arc && !vertical) {
          const dzA = prev.z - m.z;   // a helix goes down (or up) while it turns: Z word, and plunge speed when descending
          const feedA = dzA > 1e-9 ? moveFeed(tp.feed, tp.plungeFeed, item.arc.radius * item.arc.sweep, dzA) : tp.feed;
          const fWordA = feedA !== lastF ? ` F${f(feedA)}` : '';
          lastF = feedA;
          const g = (n: number) => String(+n.toFixed(post.decimals + 1)); // centre offsets a little finer than positions
          out.push(`${item.arc.cw ? 'G2' : 'G3'} X${f(m.x)} Y${f(m.y)}${Math.abs(dzA) > 1e-9 ? ` Z${f(m.z)}` : ''} I${g(item.arc.i)} J${g(item.arc.j)}${fWordA}`);
          prev = m;
          continue;
        }
        if (vertical && Math.abs(m.z - prev.z) < 1e-9) continue;
        if (m.rapid) { // travelling through space already cleared (e.g. back down a drilled hole)
          out.push(g0(vertical ? `Z${f(m.z)}` : `X${f(m.x)} Y${f(m.y)} Z${f(m.z)}`));
          prev = m;
          continue;
        }
        // Any move with a downward component is limited to the slower plunge feed.
        const feed = moveFeed(tp.feed, tp.plungeFeed, Math.hypot(m.x - prev.x, m.y - prev.y), prev.z - m.z);
        if (vertical && m.z > prev.z + 1e-9) { // moving straight up inside an existing cut: rapid
          out.push(g0(`Z${f(m.z)}`));
          prev = m;
          continue;
        }
        const fWord = feed !== lastF ? ` F${f(feed)}` : '';
        lastF = feed;
        out.push(vertical ? `G1 Z${f(m.z)}${fWord}` : `G1 X${f(m.x)} Y${f(m.y)} Z${f(m.z)}${fWord}`);
        prev = m;
      }
    }
  }
  out.push(g0(`Z${f(post.safeZ)}`));
  const endLines = customLines(post.endGcode);
  if (endLines.length) out.push('; --- your end G-code ---', ...endLines);
  else {
    if (post.spindle === 'm3') out.push('M5');
    else out.push('; Stop the router now');
    out.push(g0('X0 Y0'));
    if (post.flavor === 'grbl') out.push('M2');
  }
  return out.join('\n') + '\n';
}

export interface Bed { width: number; depthY: number }

/** Warn about moves outside the machine's work area (zero at a bed corner). */
export function checkBounds(paths: Toolpath[], bed: Bed): string[] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const tp of paths) for (const c of tp.cuts) for (const m of c.moves) {
    minX = Math.min(minX, m.x); maxX = Math.max(maxX, m.x);
    minY = Math.min(minY, m.y); maxY = Math.max(maxY, m.y);
  }
  const w: string[] = [];
  if (minX < -1e-6 || minY < -1e-6) w.push('Part extends below zero on X or Y: move the drawing or set zero further out.');
  if (maxX > bed.width + 1e-6 || maxY > bed.depthY + 1e-6) {
    w.push(`Toolpath (${maxX.toFixed(0)} x ${maxY.toFixed(0)} mm) is bigger than your work area (${bed.width} x ${bed.depthY} mm). Split the job or use a smaller design.`);
  }
  return w;
}

function sameTool(a: Toolpath['tool'], b: Toolpath['tool']) {
  return a.type === b.type && a.diameter === b.diameter && a.angle === b.angle && a.tipDiameter === b.tipDiameter;
}
export function describeTool(t: Toolpath['tool']) {
  return t.type === 'vbit' ? `${t.angle}deg V-bit` : `${t.diameter}mm ${t.type === 'ball' ? 'ball nose' : 'flat end mill'}`;
}

/**
 * A short, safe program for checking that the controller really runs arcs. It stays 10 mm above the Z zero
 * the whole time (an air cut) and draws a circle and four quarter arcs. If the machine stops, complains about
 * G2/G3, or moves in straight lines, the firmware has no arc support and arcs should stay off.
 */
export function arcTestGcode(flavor: Flavor, centre = { x: 60, y: 60 }, radius = 25): string {
  const z = 10;
  const { x, y } = centre;
  const L = [
    '; open-cam ARC TEST (air cut)',
    '; Set X/Y zero at the work-area corner and Z zero on the top of your material (or anywhere: the tool never goes below Z=10).',
    '; The machine should draw ONE full circle (clockwise), then FOUR quarter arcs back the other way (counter-clockwise).',
    '; If the machine stops, shows an error about G2/G3, or moves in straight lines or odd shapes, your firmware cannot do arcs:',
    '; leave "Arcs" switched off in open-cam.',
    'G21', 'G90', 'G17',
    flavor === 'marlin' ? 'M117 Arc test: spindle OFF' : '; spindle OFF',
    `G0 Z${z}`,
    `G0 X${x + radius} Y${y}`,
    `G1 Z${z} F600`,
    '; full circle, clockwise (centre is 25 mm to the left of the start)',
    `G2 X${x + radius} Y${y} I${-radius} J0 F600`,
    '; four quarter arcs, counter-clockwise',
    `G3 X${x} Y${y + radius} I${-radius} J0`,
    `G3 X${x - radius} Y${y} I0 J${-radius}`,
    `G3 X${x} Y${y - radius} I${radius} J0`,
    `G3 X${x + radius} Y${y} I0 J${radius}`,
    `G0 Z${z}`,
    'G0 X0 Y0',
  ];
  if (flavor === 'grbl') L.push('M2');
  return L.join('\n') + '\n';
}

/**
 * Rough run time in minutes: cutting moves at their feed rates plus rapid travel between cuts.
 * It ignores acceleration, so real jobs take somewhat longer; it is meant for planning, not for scheduling.
 */
export function estimateMinutes(paths: Toolpath[], rapidFeed = 3000, safeZ = 5): { cutting: number; travel: number; total: number } {
  let cut = 0, travel = 0;
  let x = 0, y = 0;
  const entry = planEntries(paths, safeZ);
  for (const tp of paths) {
    for (const c of tp.cuts) {
      const first = c.moves[0];
      if (!first) continue;
      const z0 = Math.min(safeZ, 1);
      travel += (Math.hypot(first.x - x, first.y - y) + 2 * safeZ) / rapidFeed;
      let prev = { x: first.x, y: first.y, z: z0 }; // the bit comes down from 1 mm above the top, so the first move is a real descent
      const drop = entry.get(c);
      if (drop !== undefined) { travel += (z0 - drop) / rapidFeed; prev = { ...prev, z: drop }; }
      for (const m of c.moves) {
        const d = Math.hypot(m.x - prev.x, m.y - prev.y, m.z - prev.z);
        const up = Math.abs(m.x - prev.x) < 1e-9 && Math.abs(m.y - prev.y) < 1e-9 && m.z > prev.z;
        if (m.rapid || up) travel += d / rapidFeed;
        else cut += d / moveFeed(tp.feed, tp.plungeFeed, Math.hypot(m.x - prev.x, m.y - prev.y), prev.z - m.z);
        prev = m;
      }
      x = prev.x; y = prev.y;
    }
  }
  return { cutting: cut, travel, total: cut + travel };
}

/**
 * Feed for a move, from how steeply it descends. A straight plunge (or anything steeper than 45 degrees) uses the
 * slow plunge feed; a shallow ramp (under about 6 degrees) is really a cutting move and uses the full cutting feed;
 * in between it blends. Moves that go up or stay level use the cutting feed. The result is rounded to 25 mm/min so
 * a sloping path does not need a new feed word on every line.
 */
export function moveFeed(cutFeed: number, plungeFeed: number, dxy: number, drop: number): number {
  if (drop <= 1e-9) return cutFeed;                 // level or rising
  const slope = dxy < 1e-9 ? Infinity : drop / dxy; // rise over run of the descent
  const t = Math.min(1, Math.max(0, (slope - 0.1) / (1 - 0.1)));   // 0 at <= ~6 degrees, 1 at >= 45 degrees
  const f = cutFeed + (Math.min(plungeFeed, cutFeed) - cutFeed) * t;
  return Math.max(1, Math.round(f / 25) * 25);
}
