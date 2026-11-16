import type { Loop, Pt3 } from './types';

export interface TabParams {
  count: number;
  /** Width of the bridge left in the material, mm */
  width: number;
  /** Height of the bridge above the cut bottom, mm */
  height: number;
}

export interface RampParams {
  /** Maximum ramp angle in degrees (gentle for flexible machines). */
  maxAngleDeg: number;
}

interface Seg { a: Pt3; b: Pt3 }

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(b.x - a.x, b.y - a.y);

export function perimeter(loop: Loop): number {
  let s = 0;
  for (let i = 0; i < loop.length; i++) s += dist(loop[i], loop[(i + 1) % loop.length]);
  return s;
}

/** Tab spans as [s0, s1] arc-length intervals along the loop (tool-centre path). */
export function tabSpans(loop: Loop, toolDia: number, tabs: TabParams): [number, number][] {
  const per = perimeter(loop);
  const span = tabs.width + toolDia;
  // Skip tabs on loops too small to hold them sensibly.
  const count = Math.min(tabs.count, Math.floor(per / (span * 2)));
  const spans: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    const c = ((i + 0.5) / count) * per;
    spans.push([c - span / 2, c + span / 2]);
  }
  return spans;
}

/**
 * Build the 3D move list for one closed loop being cut down to `z`.
 * - ramp: descend gradually from zStart to z over one or more laps, then a flat lap.
 * - tabs: where the tool would be below `tabTopZ` inside a tab span, hold at tabTopZ.
 * Returns points starting and ending at the loop start.
 */
export function buildMoves(
  loop: Loop, zStart: number, z: number, toolDia: number,
  opts: { ramp?: RampParams; tabs?: TabParams; tabTopZ?: number },
): Pt3[] {
  const per = perimeter(loop);
  const dz = zStart - z;
  const MAX_LAPS = 8;
  let laps = 0;
  if (opts.ramp && dz > 1e-9 && per > 0) {
    const rampLen = dz / Math.tan((opts.ramp.maxAngleDeg * Math.PI) / 180);
    laps = Math.min(MAX_LAPS, Math.max(1, Math.ceil(rampLen / per)));
  }
  const spans = opts.tabs && opts.tabTopZ !== undefined && z < opts.tabTopZ
    ? tabSpans(loop, toolDia, opts.tabs) : [];
  const tabTop = opts.tabTopZ ?? z;
  const inTab = (s: number) => spans.some(([a, b]) => s > a && s < b);

  // Per-lap vertex list with extra vertices at every tab boundary.
  const cuts = [...new Set(spans.flatMap(([a, b]) => [a, b].filter(v => v > 0 && v < per)))].sort((a, b) => a - b);
  const lapSegs: { p: Pt3; q: Pt3; s0: number; s1: number }[] = [];
  let acc = 0;
  const at = (s: number): Pt3 => {
    let r = s;
    for (let i = 0; i < loop.length; i++) {
      const p = loop[i], q = loop[(i + 1) % loop.length];
      const l = dist(p, q);
      if (r <= l + 1e-12) { const t = l ? r / l : 0; return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t, z }; }
      r -= l;
    }
    return { ...loop[0], z };
  };
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i], q = loop[(i + 1) % loop.length];
    const l = dist(p, q);
    const inner = cuts.filter(c => c > acc + 1e-9 && c < acc + l - 1e-9);
    let prevS = acc;
    for (const c of [...inner, acc + l]) {
      lapSegs.push({ p: i === 0 && prevS === 0 ? { ...p, z } : at(prevS), q: at(c), s0: prevS, s1: c });
      prevS = c;
    }
    acc += l;
  }

  const out: Pt3[] = [];
  const total = (laps + 1) * per;
  const rampEnd = laps * per;
  const zAt = (S: number) => (laps === 0 || S >= rampEnd ? z : zStart - dz * (S / rampEnd));
  const push = (x: number, y: number, zz: number) => {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - x) < 1e-9 && Math.abs(last.y - y) < 1e-9 && Math.abs(last.z - zz) < 1e-9) return;
    out.push({ x, y, z: zz });
  };
  if (laps === 0) push(loop[0].x, loop[0].y, zStart);
  else push(loop[0].x, loop[0].y, zStart);
  for (let lap = 0; lap <= laps; lap++) {
    for (const sg of lapSegs) {
      const raised = inTab((sg.s0 + sg.s1) / 2);
      const za = Math.max(zAt(lap * per + sg.s0), raised ? tabTop : -Infinity);
      const zb = Math.max(zAt(lap * per + sg.s1), raised ? tabTop : -Infinity);
      push(sg.p.x, sg.p.y, za); // vertical step if tab edge
      push(sg.q.x, sg.q.y, zb);
    }
  }
  void total;
  return out;
}

/**
 * Moves for an OPEN polyline cut down to z. With ramping, the tool descends
 * along the line (going back and forth if the line is short), then finishes
 * flat so the whole line ends up at full depth.
 */
export function buildOpenMoves(pts: Loop, zStart: number, z: number, ramp?: RampParams): Pt3[] {
  if (pts.length < 2) return [];
  const dz = zStart - z;
  const segLen: number[] = [];
  for (let i = 0; i + 1 < pts.length; i++) segLen.push(dist(pts[i], pts[i + 1]));
  const total = segLen.reduce((a, b) => a + b, 0);
  const out: Pt3[] = [{ x: pts[0].x, y: pts[0].y, z: zStart }];
  const push = (p: { x: number; y: number }, zz: number) => out.push({ x: p.x, y: p.y, z: zz });
  if (!ramp || dz < 1e-9 || total < 1e-9) {
    push(pts[0], z);
    for (let i = 1; i < pts.length; i++) push(pts[i], z);
    return out;
  }
  const rampLen = dz / Math.tan((ramp.maxAngleDeg * Math.PI) / 180);
  let travelled = 0;
  let forward = true;
  let guard = 0;
  const zAt = (s: number) => zStart - dz * Math.min(1, s / rampLen);
  // Ramp phase: walk back and forth until the ramp length is used up.
  while (travelled < rampLen - 1e-9 && guard++ < 50) {
    const order = forward ? pts.map((_, i) => i) : pts.map((_, i) => pts.length - 1 - i);
    for (let k = 1; k < order.length; k++) {
      const l = forward ? segLen[order[k] - 1] : segLen[order[k]];
      const a = pts[order[k - 1]], b = pts[order[k]];
      if (travelled + l >= rampLen) {
        // Ramp finishes inside this segment: split it.
        const t = (rampLen - travelled) / l;
        const m = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        push(m, z);
        push(b, z);
        travelled = rampLen;
      } else {
        travelled += l;
        push(b, zAt(travelled));
      }
    }
    if (travelled < rampLen - 1e-9) forward = !forward;
    else {
      // Ramp ended; finish the rest of this traversal flat (already pushed), then return flat.
      const back = forward ? [...pts].reverse() : [...pts];
      for (let i = 1; i < back.length; i++) push(back[i], z);
      return out;
    }
  }
  return out;
}
