import type { Material } from './types';

/** Conservative defaults for an MPCNC + Makita router; tune per machine. */
export const MATERIALS: Record<string, Material> = {
  softwood: { feed: 1000, plungeFeed: 300, stepdown: 2 },
  hardwood: { feed: 700, plungeFeed: 250, stepdown: 1.5 },
  mdf: { feed: 1000, plungeFeed: 300, stepdown: 2 },
  // Rigid foam cuts with very little force. Cutting fast keeps it from melting and gumming the bit.
  foam: { feed: 2000, plungeFeed: 800, stepdown: 8 },
};

/** The material to use: the user's own numbers when given and valid, otherwise the named preset. */
export function resolveMaterial(key: string, custom?: Partial<Material> | null): Material {
  const base = MATERIALS[key] ?? MATERIALS.softwood;
  if (!custom) return base;
  const ok = (v: number | undefined) => typeof v === 'number' && Number.isFinite(v) && v > 0;
  return {
    feed: ok(custom.feed) ? custom.feed! : base.feed,
    plungeFeed: ok(custom.plungeFeed) ? custom.plungeFeed! : base.plungeFeed,
    stepdown: ok(custom.stepdown) ? custom.stepdown! : base.stepdown,
  };
}

/** Plain-English cautions about hand-entered cutting values. */
export function materialWarnings(m: Material, toolDiameter: number): string[] {
  const w: string[] = [];
  if (m.plungeFeed > m.feed) w.push('Plunge speed is faster than cutting speed. Plunging is normally slower than cutting.');
  if (toolDiameter > 0 && m.stepdown > 2 * toolDiameter) w.push(`Depth per pass (${m.stepdown} mm) is more than twice the bit diameter (${toolDiameter} mm): risky except in very soft materials such as foam.`);
  if (m.feed > 6000) w.push('Cutting speed above 6000 mm/min is beyond what most hobby machines can follow.');
  return w;
}
