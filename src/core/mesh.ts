/**
 * Triangle meshes (STL) and the height map used for 3D milling.
 *
 * Milling here is "2.5D surfacing": the model is reduced to a height map (the highest surface at every X/Y position,
 * seen from above). Anything hidden under an overhang cannot be cut by a router from above, so it is ignored.
 */

/** Triangles as a flat list: x1 y1 z1 x2 y2 z2 x3 y3 z3 per triangle. */
export interface Mesh { tri: Float32Array }

export class StlError extends Error {}

/** Read a binary or ASCII STL file. Throws StlError with a plain message if it is not one. */
export function parseStl(buf: ArrayBuffer): Mesh {
  if (buf.byteLength < 84) throw new StlError('This file is too small to be an STL model.');
  const dv = new DataView(buf);
  const n = dv.getUint32(80, true);
  if (84 + n * 50 === buf.byteLength && n > 0) { // binary
    const tri = new Float32Array(n * 9);
    for (let t = 0; t < n; t++) {
      const o = 84 + t * 50 + 12; // skip the normal
      for (let k = 0; k < 9; k++) tri[t * 9 + k] = dv.getFloat32(o + k * 4, true);
    }
    return check({ tri });
  }
  const text = new TextDecoder().decode(buf);
  if (!/^\s*solid/i.test(text)) throw new StlError('This does not look like an STL file (it is not binary or ASCII STL).');
  const nums: number[] = [];
  const re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) nums.push(+m[1], +m[2], +m[3]);
  if (nums.length < 9 || nums.length % 9) throw new StlError('The STL file has no complete triangles.');
  return check({ tri: Float32Array.from(nums) });
}

function check(m: Mesh): Mesh {
  for (let i = 0; i < m.tri.length; i++) if (!Number.isFinite(m.tri[i])) throw new StlError('The STL file contains invalid numbers.');
  return m;
}

export type Up = '+z' | '-z' | '+y' | '-y' | '+x' | '-x';
export interface OrientOpts {
  /** Which direction of the model should face up (towards the cutter) */
  up: Up;
  /** Turn about the vertical axis, degrees anticlockwise from above: 0, 90, 180 or 270 */
  spin: number;
  /** Multiply all sizes (e.g. 25.4 if the file is in inches) */
  scale: number;
}
export const DEFAULT_ORIENT: OrientOpts = { up: '+z', spin: 0, scale: 1 };

export interface Oriented {
  tri: Float32Array;
  /** Size of the model in mm: width (X), depth (Y), height (Z) */
  w: number; d: number; h: number;
}

/**
 * Turn the model so the chosen face is up (rotations only, never mirroring), then place it with its
 * lower-left corner at X=0, Y=0 and its highest point at Z=0 (the top of the stock).
 */
export function orient(m: Mesh, o: OrientOpts): Oriented {
  const tri = new Float32Array(m.tri.length);
  const spin = ((Math.round(o.spin / 90) % 4) + 4) % 4;
  const s = o.scale > 0 ? o.scale : 1;
  let minX = Infinity, minY = Infinity, maxZ = -Infinity, maxX = -Infinity, maxY = -Infinity, minZ = Infinity;
  for (let i = 0; i < m.tri.length; i += 3) {
    const x = m.tri[i], y = m.tri[i + 1], z = m.tri[i + 2];
    let a: number, b: number, c: number;
    switch (o.up) {
      case '+z': a = x; b = y; c = z; break;
      case '-z': a = x; b = -y; c = -z; break;
      case '+y': a = x; b = -z; c = y; break;
      case '-y': a = x; b = z; c = -y; break;
      case '+x': a = -z; b = y; c = x; break;
      default: a = z; b = y; c = -x; break; // '-x'
    }
    for (let k = 0; k < spin; k++) { const t = a; a = -b; b = t; }
    a *= s; b *= s; c *= s;
    tri[i] = a; tri[i + 1] = b; tri[i + 2] = c;
    minX = Math.min(minX, a); maxX = Math.max(maxX, a); minY = Math.min(minY, b); maxY = Math.max(maxY, b);
    minZ = Math.min(minZ, c); maxZ = Math.max(maxZ, c);
  }
  for (let i = 0; i < tri.length; i += 3) { tri[i] -= minX; tri[i + 1] -= minY; tri[i + 2] -= maxZ; }
  return { tri, w: maxX - minX, d: maxY - minY, h: maxZ - minZ };
}

/**
 * The model as side 2 sees it: the stock (and the model inside it) turned over about a line through `axis`.
 * A turn-over is a rotation of 180 degrees about that line, so nothing is mirrored; what was the underside is now the top.
 * `place` is where the model sits on side 1 (X, Y of its lower-left corner; `top` = how far its top is below the stock top).
 * Returns the model re-based like any other (lower-left at 0,0, top at Z 0) with where to put it on side 2.
 * With a model thinner than the stock, side 2's top surface is the model's underside, `top` below the new stock top.
 */
export function turnOver(m: Oriented, place: { x: number; y: number; top: number }, axis: { x: number; y: number }, flip: 'tb' | 'lr', stockT: number):
  { model: Oriented; x: number; y: number; top: number } {
  const tri = new Float32Array(m.tri.length);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < m.tri.length; i += 3) {
    let x = m.tri[i] + place.x, y = m.tri[i + 1] + place.y;
    const z = -stockT - (m.tri[i + 2] - place.top);
    if (flip === 'tb') y = 2 * axis.y - y; else x = 2 * axis.x - x;
    tri[i] = x; tri[i + 1] = y; tri[i + 2] = z;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  for (let i = 0; i < tri.length; i += 3) { tri[i] -= minX; tri[i + 1] -= minY; tri[i + 2] -= maxZ; }
  return { model: { tri, w: maxX - minX, d: maxY - minY, h: maxZ - minZ }, x: minX, y: minY, top: -maxZ };
}

/** Marks a height-map cell with no model above it. */
export const EMPTY = -1e9;

export interface HeightMap {
  nx: number; ny: number;
  /** Cell size, mm. Cell (i, j) is centred at ((i + 0.5) * cell, (j + 0.5) * cell). */
  cell: number;
  /** Surface height per cell (row-major, j * nx + i), or EMPTY */
  z: Float32Array;
}

/** Largest height map built, in cells (keeps memory and time in check). */
export const MAX_CELLS = 4_000_000;

/** Highest surface of the model above each cell. The cell size is enlarged if needed to stay within MAX_CELLS. */
export function heightMap(m: Oriented, cell: number): HeightMap {
  let c = Math.max(cell, 0.02);
  const cells = (cs: number) => (Math.ceil(m.w / cs) + 1) * (Math.ceil(m.d / cs) + 1);
  while (cells(c) > MAX_CELLS) c *= 1.2;
  const nx = Math.max(1, Math.ceil(m.w / c)), ny = Math.max(1, Math.ceil(m.d / c));
  const z = new Float32Array(nx * ny).fill(EMPTY);
  const t = m.tri;
  const eps = 1e-7;
  for (let k = 0; k < t.length; k += 9) {
    const x0 = t[k], y0 = t[k + 1], z0 = t[k + 2], x1 = t[k + 3], y1 = t[k + 4], z1 = t[k + 5], x2 = t[k + 6], y2 = t[k + 7], z2 = t[k + 8];
    const den = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
    if (Math.abs(den) < 1e-12) continue; // edge-on (vertical) triangle: covers no area
    const i0 = Math.max(0, Math.floor(Math.min(x0, x1, x2) / c - 0.5)), i1 = Math.min(nx - 1, Math.ceil(Math.max(x0, x1, x2) / c - 0.5));
    const j0 = Math.max(0, Math.floor(Math.min(y0, y1, y2) / c - 0.5)), j1 = Math.min(ny - 1, Math.ceil(Math.max(y0, y1, y2) / c - 0.5));
    for (let j = j0; j <= j1; j++) {
      const py = (j + 0.5) * c;
      for (let i = i0; i <= i1; i++) {
        const px = (i + 0.5) * c;
        const a = ((y1 - y2) * (px - x2) + (x2 - x1) * (py - y2)) / den;
        const b = ((y2 - y0) * (px - x2) + (x0 - x2) * (py - y2)) / den;
        const g = 1 - a - b;
        if (a < -eps || b < -eps || g < -eps) continue;
        const h = a * z0 + b * z1 + g * z2;
        if (h > z[j * nx + i]) z[j * nx + i] = h;
      }
    }
  }
  return { nx, ny, cell: c, z };
}

/** Number of cells with model above them. */
export function coveredCells(hm: HeightMap): number {
  let n = 0;
  for (let i = 0; i < hm.z.length; i++) if (hm.z[i] > EMPTY) n++;
  return n;
}
