import type { Cut, Loop, Pt3 } from './types';
import { buildMoves, type RampParams } from './entry';

/**
 * Turn a list of concentric clearing rings (already oriented for climb/conventional) into as few cuts as possible.
 * The first ring of a chain ramps in; each following ring that starts within `linkMax` mm of where the last one ended
 * is joined to it with a short move at depth, so the bit steps across instead of lifting out and ramping in again.
 * All rings are cut at the one depth `z`.
 */
export function linkRings(rings: Loop[], z: number, zStart: number, opts: { ramp?: RampParams; linkMax: number }): Cut[] {
  const chains: { moves: Pt3[] }[] = [];
  let end: { x: number; y: number } | null = null;
  for (const loop of rings) {
    if (loop.length < 3) continue;
    const cur = chains[chains.length - 1];
    if (cur && end) {
      let bi = 0, bd = Infinity;
      loop.forEach((p, i) => { const d = Math.hypot(p.x - end!.x, p.y - end!.y); if (d < bd) { bd = d; bi = i; } });
      if (bd <= opts.linkMax) {
        const rot = [...loop.slice(bi), ...loop.slice(0, bi)];
        cur.moves.push(...[...rot, rot[0]].map(q => ({ x: q.x, y: q.y, z })));
        end = rot[0];
        continue;
      }
    }
    chains.push({ moves: buildMoves(loop, zStart, z, 0, { ramp: opts.ramp }) });
    end = loop[0];
  }
  return chains.map(c => ({ loop: c.moves.map(m => ({ x: m.x, y: m.y })), z, zStart, closed: false, moves: c.moves }));
}
