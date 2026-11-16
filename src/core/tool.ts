import type { Tool } from './types';

/**
 * Radius of the cutter's footprint at depth z (z <= 0, 0 = top of stock).
 * Flat and ball end mills cut a vertical wall at full diameter; a V-bit's
 * radius grows with depth from its tip up to its max diameter.
 */
export function radiusAt(tool: Tool, z: number): number {
  const full = tool.diameter / 2;
  if (tool.type !== 'vbit') return full;
  const tip = (tool.tipDiameter ?? 0) / 2;
  const half = ((tool.angle ?? 60) * Math.PI) / 360;
  return Math.min(full, tip + Math.abs(z) * Math.tan(half));
}

/** Depth at which a V-bit reaches its full diameter (Infinity for other bits). */
export function vFullDepth(tool: Tool): number {
  if (tool.type !== 'vbit') return Infinity;
  const half = ((tool.angle ?? 60) * Math.PI) / 360;
  return (tool.diameter / 2 - (tool.tipDiameter ?? 0) / 2) / Math.tan(half);
}

/** Plain-English warnings about using this bit for a through-cut or pocket. */
export function toolWarnings(tool: Tool, depth: number, op: 'profile' | 'pocket' | 'vcarve'): string[] {
  const w: string[] = [];
  if (tool.fluteLength && depth > tool.fluteLength + 1e-9) {
    w.push(`This cut is ${depth} mm deep but the bit only cuts ${tool.fluteLength} mm. The bare shank would rub and burn. Use a longer bit, or cut it from both sides.`);
  }
  if (tool.type === 'vbit') {
    if (op !== 'vcarve') w.push('V-bits are meant for engraving and chamfers. The cut width changes with depth, so cut-outs and pockets are slow and rough. Use a flat end mill for cutting out.');
    if (depth > vFullDepth(tool)) {
      w.push(op === 'vcarve'
        ? `This V-bit is only ${tool.diameter} mm wide, so it cannot carve deeper than ${vFullDepth(tool).toFixed(1)} mm. Deeper than that it is limited to ${vFullDepth(tool).toFixed(1)} mm. Use a wider V-bit for wide, deep carving.`
        : 'Depth is deeper than the V-bit can cut (it would rub on the shank).');
    }
  }
  if (tool.type === 'ball' && op === 'profile') {
    w.push('Ball-nose bits leave a rounded bottom edge; a flat end mill gives a cleaner cut-out.');
  }
  return w;
}
