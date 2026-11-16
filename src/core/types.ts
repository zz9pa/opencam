export interface Pt { x: number; y: number }
/** A 3D move target. `rapid` marks a G0 move through already-cleared space (e.g. back down inside a drilled hole). */
export interface Pt3 { x: number; y: number; z: number; rapid?: boolean }
/** A closed polygon (last point implicitly connects to first). */
export type Loop = Pt[];

/** A drawn line: closed outline or open polyline. */
export interface Line { pts: Loop; closed: boolean }

export type Direction ='climb' | 'conventional';

export type ToolType = 'flat' | 'ball' | 'vbit';

export interface Tool {
  type: ToolType;
  /** Max cutting diameter in mm (shank-side diameter for a V-bit) */
  diameter: number;
  /** V-bit included angle in degrees (e.g. 60, 90) */
  angle?: number;
  /** V-bit flat tip diameter in mm (0 = sharp point) */
  tipDiameter?: number;
  /** Length of the cutting flutes, mm. Cutting deeper than this rubs the shank. */
  fluteLength?: number;
}

export interface Material {
  /** Recommended cutting feed, mm/min */
  feed: number;
  plungeFeed: number;
  /** Max depth per pass, mm */
  stepdown: number;
}

/** One closed cutting pass at a depth. */
export interface Cut {
  loop: Loop;
  /** Target depth (negative, 0 = top of stock) */
  z: number;
  /** Depth the pass starts from (previous pass depth) */
  zStart: number;
  closed: boolean;
  /** Full 3D move list (ramp / tabs applied) */
  moves: Pt3[];
  /** If set, the program stops here with this message before the pass (e.g. "swap in the second board") */
  pauseBefore?: string;
  /** The material above this depth (Z, negative) is already gone at the start point (a start depth was set): the bit rapids down to this Z (1 mm above the start depth) instead of feeding down from the top */
  airTo?: number;
  /** Marks a pass that belongs to a particular part of a multi-part operation (e.g. the inlay insert) for colouring */
  tag?: string;
}

export interface Toolpath {
  name: string;
  /** Extra facts about how the path was made (used for warnings), e.g. the depth V-carving would like to reach */
  meta?: Record<string, number>;
  tool: Tool;
  cuts: Cut[];
  feed: number;
  plungeFeed: number;
}
