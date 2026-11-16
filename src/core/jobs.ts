import type { Pt, Tool, Toolpath, Material } from './types';
import { drill } from './ops';
import { translateToolpath } from './transform';
import { clipToolpath, junctionCentreX, planSplit, registrationPins, type PinLayout, type SplitPlan } from './split';

export interface JobFile {
  /** Suggested file name */
  name: string;
  /** Plain-English instructions written into the top of the G-code */
  note: string;
  paths: Toolpath[];
}

export interface SplitJobInput {
  /** Toolpaths in the drawing frame. sides[0] = side 1; sides[1] (optional) = side 2 in the post-flip frame. */
  sides: Toolpath[][];
  /** Extent of everything to be cut, drawing frame */
  part: { minX: number; minY: number; maxX: number; maxY: number };
  /** Centre of the turn-over line, drawing frame (used when sides.length > 1) */
  axis: Pt;
  bedX: number; bedY: number; margin: number;
  overlap: number;
  pin: PinLayout;
  dowelDia: number;
  stockT: number;
  /** Depth to drill the spoilboard in step 0 */
  spoilDepth: number;
  bit: Tool;
  material: Material;
}

export interface SplitJob {
  plan: SplitPlan;
  files: JobFile[];
  /** Registration pin positions in the drawing frame, one set per junction (for the preview) */
  pinsDraw: Pt[][];
  /** Stock size needed (X length, Y width), mm */
  stock: { length: number; width: number };
  warnings: string[];
}

const THROUGH_EXTRA = 2; // mm the stock holes break into the spoilboard so they are clean all the way through

/** Break one job into segments that each fit the work area, with registration pins for sliding (and flipping). */
export function buildSplitJob(i: SplitJobInput): SplitJob {
  const warnings: string[] = [];
  const twoSided = i.sides.length > 1;
  const plan = planSplit({ minX: i.part.minX, maxX: i.part.maxX, bedX: i.bedX, margin: i.margin, overlap: i.overlap });
  const axisY = twoSided ? i.axis.y : undefined;

  // The pins sit in the waste margin beyond the part. With two sides, measure from the turn-over line so the margins match.
  const halfH = twoSided ? Math.max(i.part.maxY - i.axis.y, i.axis.y - i.part.minY) : 0;
  const yEdge = twoSided ? i.axis.y + halfH : i.part.maxY;
  const pinsDraw = Array.from({ length: Math.max(0, plan.n - 1) }, (_, k) => registrationPins(junctionCentreX(plan, k), yEdge, i.pin, axisY));
  const pinReach = i.pin.distance + i.pin.pairGap + i.dowelDia / 2 + 5;

  // Y frame of the machine: the part sits `margin` from the front edge, or (two-sided) centred on the turn-over line.
  let dy: number, widthNeeded: number;
  if (twoSided) {
    const half = halfH + pinReach;
    widthNeeded = 2 * half;
    dy = widthNeeded / 2 - i.axis.y;
  } else {
    widthNeeded = i.part.maxY - i.part.minY + pinReach;
    dy = i.margin - i.part.minY;
  }
  if (widthNeeded + (twoSided ? 0 : i.margin) > i.bedY + 1e-6) {
    warnings.push(`The job needs ${Math.ceil(widthNeeded)} mm across the work area (Y) including registration pins, but the work area is ${i.bedY} mm.`);
  }
  const lengthNeeded = i.part.maxX - i.part.minX + 2 * 5;

  const toMachine = (tp: Toolpath, k: number) => translateToolpath(tp, i.margin - plan.windows[k].x0, dy);
  const tool = i.bit;
  const drillAt = (pts: Pt[], depth: number, name: string): Toolpath => {
    const tp = drill(pts, { tool, material: i.material, depth, direction: 'climb', ramp: { maxAngleDeg: 3 }, holeDiameter: i.dowelDia });
    tp.name = name;
    return tp;
  };

  const files: JobFile[] = [];
  if (plan.n === 1) return { plan, files, pinsDraw, stock: { length: lengthNeeded, width: widthNeeded }, warnings };

  // Machine positions of the pins: R = at the end of a segment (junction k, in segment k's frame); L = at the start of the next.
  const rM = pinsDraw[0].map(p => ({ x: p.x - plan.windows[0].x0 + i.margin, y: p.y + dy }));
  const lM = pinsDraw[0].map(p => ({ x: p.x - plan.windows[1].x0 + i.margin, y: p.y + dy }));

  // Step 0: pre-drill the spoilboard so the dowels have somewhere to go. Both sets if the stock is also turned over.
  const step0Pts = twoSided ? [...lM, ...rM] : lM;
  files.push({
    name: 'step0_spoilboard.gcode',
    note: `STEP 0: NO STOCK ON THE MACHINE. Drills ${step0Pts.length} dowel holes in the spoilboard only.\nZero X/Y at the work-area corner; Z zero on the TOP SURFACE OF THE SPOILBOARD.\nRun this first. Leave the dowels out until after segment 1.`,
    paths: [drillAt(step0Pts, i.spoilDepth, `STEP 0: drill ${i.dowelDia}mm holes in the spoilboard`)],
  });

  const nSides = i.sides.length;
  for (let s = 0; s < nSides; s++) {
    for (let k = 0; k < plan.n; k++) {
      const w = plan.windows[k];
      const cut = i.sides[s]
        .map(tp => clipToolpath(tp, w.x0, w.x1))
        .filter(tp => tp.cuts.length)
        .map(tp => toMachine(tp, k));
      const paths: Toolpath[] = [];
      // Side 1 drills the through-holes that the next segment (and the flip) register on.
      if (s === 0 && k < plan.n - 1) {
        paths.push(drillAt(rM, i.stockT + THROUGH_EXTRA, `Drill ${i.dowelDia}mm registration holes (through the stock)`));
      }
      paths.push(...cut);
      const side = nSides > 1 ? ` of side ${s + 1}` : '';
      const lines: string[] = [`SEGMENT ${k + 1} of ${plan.n}${side}.`];
      if (s === 0 && k === 0) {
        lines.push('Place the stock against your stops so the left end of the part is near X=' + i.margin + '. Its exact position does not matter after this.');
      } else if (s === 0) {
        lines.push(`Slide the stock along so its registration holes drop onto the dowels in the spoilboard holes at the LEFT end (the "L" holes from step 0).`);
      } else if (k === 0) {
        lines.push(`Turn the stock over (about its long axis), then lower it so its holes drop onto the dowels in the "R" holes at the RIGHT end.`);
      } else {
        lines.push(`Move the dowels to the "L" holes, slide the stock along so its holes drop onto them.`);
      }
      lines.push('Zero X/Y at the work-area corner; Z zero on the top surface of the stock.');
      if (s === 0 && k < plan.n - 1) lines.push('This file drills the registration holes for the next segment first, then cuts. Put the dowels in after this segment finishes.');
      lines.push(`Each segment re-cuts the last ${i.overlap} mm of the previous one, so small alignment errors don't leave a step.`);
      files.push({ name: `${nSides > 1 ? `side${s + 1}_` : ''}segment${k + 1}.gcode`, note: lines.join('\n'), paths });
    }
  }
  return { plan, files, pinsDraw, stock: { length: lengthNeeded, width: widthNeeded }, warnings };
}
