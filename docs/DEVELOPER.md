# open-cam: developer notes

Living document. **Update it whenever behaviour changes** (the unit tests are the source of truth for numbers; this file explains *why*). Last major update: split jobs + turn-over registration.

## What it is

A free, client-side (static site, no server, no upload) CAM tool that turns SVG drawings into G-code for hobby CNC routers. Priorities: friendly for beginners, safe defaults, always keep the spindle direction right (climb vs conventional), good registration tools for multi-setup jobs. 3D milling (STL, top-surface height-map carving) is built: see the 3D section below. Also built: V-carve, inlay, drilling, simulation, undo/projects.

Primary machine it is tuned for: a flexible 3-axis gantry router with a manual-speed spindle (no `M3`/`M5`), Marlin firmware, ~600 x 600 mm work area. All of that is configurable (GRBL flavour, bed size).

## Commands (Windows, PowerShell)

Node is installed (`winget install OpenJS.NodeJS.LTS --source winget`). A fresh shell may need PATH refreshed:

```powershell
$env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User")
npm run dev        # Vite dev server, http://localhost:5173
npx vitest run     # unit tests
npx tsc            # typecheck (strict)
npx vite build     # production build into dist/
```

Gotchas in this environment: there is no `python3`; long here-docs with `node -e` break in Git Bash, so write files with the editor tools instead; the preview server is configured in `.claude/launch.json`.

## Stack

TypeScript (strict), Vite, Vitest, `clipper2-ts` (pure-TS Clipper2 port: polygon offset/union/simplify), `marked` (renders the in-app help). Plain DOM UI (no framework). Canvas 2D for the preview.

## Source map

| File | Responsibility |
|---|---|
| `src/core/types.ts` | `Pt`, `Pt3` (with optional `rapid` flag), `Loop`, `Line`, `Tool`, `Material`, `Cut`, `Toolpath` |
| `src/core/geometry.ts` | `signedArea`, `normalize` (even-odd union), `offset` (Clipper, round joins), `simplify`/`simplifyOpen` (RDP, 0.01 mm) |
| `src/core/tool.ts` | `radiusAt(tool, z)` (V-bit widens with depth), `toolWarnings` (flute length, V-bit/ball cautions) |
| `src/core/entry.ts` | `buildMoves` (closed loops: ramp laps + tabs), `buildOpenMoves` (open lines: ramp back and forth), `tabSpans` |
| `src/core/ops.ts` | `profile` (outside/inside), `pocket`, `onLine`, `drill`, `depthLevels` |
| `src/core/gcode.ts` | `toGcode`, `checkBounds`, `Post` (Marlin/GRBL flavour), bit-change pauses |
| `src/core/transform.ts` | `translateToolpath` (**must keep `...m` so flags like `rapid` survive**), `toolpathBounds` |
| `src/core/twosided.ts` | turn-over registration: `detectMirror`, `alignBack`, `dowelPositions`, `wrongFits`, `dowelHole`, `suggestStock` |
| `src/core/place.ts` | `zeroOffset` (corner / part / centre zero) and `stockOffset` (two-sided stock placement) |
| `src/core/split.ts` | long-part splitting: `planSplit`, `clipMoves`/`clipToolpath`, `registrationPins`, `junctionCentreX` |
| `src/project.ts` | document snapshots, project file format + validation, undo `History` (pure) |
| `src/storage.ts` | IndexedDB key-value store for the automatic backup |
| `src/core/inlay.ts` | V-inlay: recess + mirrored insert + blank outline |
| `src/core/ringlink.ts` | link concentric clearing rings into long chains |
| `src/core/vcarve.ts` | medial axis (delaunator) + V-carve toolpaths, depth/radius helpers |
| `src/core/arcs.ts` | `fitArcs` (lines -> G2/G3), `sampleArc` |
| `src/text/outline.ts` | text to outline contours (pure); `fonts.ts` loads bundled fonts; `fonts-guess.ts` maps font names |
| `src/import/text.ts` | convert imported `TextItem`s to shapes |
| `src/core/jobs.ts` | `buildSplitJob`: assembles step 0 + per-segment (and per-side) files with instructions |
| `src/core/presets.ts` | material feed/plunge/stepdown defaults (conservative, flexible machine) |
| `src/svg.ts` | SVG import (browser only): layers (`inkscape:label`), per-subpath shapes, open vs closed, units, `<use>`, hidden items |
| `src/import/shape.ts` | `RawShape`, `Shape` (id + bbox), `ImportOptions`, `ParsedDrawing` |
| `src/import/dxf.ts` | DXF import (pure; `dxf-parser` + our own flattening) |
| `src/import/join.ts` | join open pieces, close, dedupe, drop specks |
| `src/import/index.ts` | `processImport` + `ImportReport` |
| `src/hints.ts` | hover hints for fields |
| `src/main.ts` | UI state, operations list, selection, preview drawing, downloads |
| `src/help.ts`, `help.html` | in-app help page rendering `docs/USER_GUIDE.md` |
| `tests/*.test.ts` | unit tests for everything under `src/core` |

`src/core` is pure (no DOM) so it is fully unit-testable in Node.

## Conventions and frames (read before changing anything geometric)

- Units: millimetres. Drawing frame: Y up (SVG Y is flipped at import). Z: 0 = top of stock, cuts are negative.
- SVG import (`src/svg.ts`): uses a hidden DOM and `getPointAtLength`; 0.5 mm sampling (cap 4000 points); size from `width`/`viewBox` (mm/cm/in/px, px = 1/96 in). Path `d` is split at `M`/`m` into subpaths. A shape is *closed* if its end is within 0.01 mm of its start, ends in `z`, or is a rect/circle/ellipse/polygon. Open shapes stay open (they can only be cut "on the line"). Layers come from the nearest ancestor `inkscape:label`, else group id, else "Drawing".
- Machine frame: for single-sided jobs everything is translated so the toolpath bounding box starts at `MARGIN` = 5 mm from X0/Y0. Two-sided: part centred in the stock, stock bottom-left = zero, turn-over line at stock mid-height/width. Split jobs: `x_machine = x_drawing - window.x0 + margin`.
- Side 2 geometry is expressed in the frame seen from above **after** turning the stock over. `ptsOf` in `main.ts` converts: shapes drawn on the front view (see-through) are mirrored about the turn-over line; shapes in a separate back drawing are aligned with `alignBack` using the two outline references.

## Materials

`core/presets.ts`: `MATERIALS` (softwood, hardwood, mdf, foam: feed, plunge, stepdown), `resolveMaterial(key, custom)` (a custom value must be a finite positive number, else the preset value is used) and `materialWarnings` (plunge > feed, stepdown > 2x bit diameter, feed > 6000). In `main.ts`, `currentMaterial()` is the single source used by `compile` and the dowel/spoilboard/split drilling; the "Advanced: my own speeds" boxes mirror the preset until "Use my own values" is ticked. Foam = 2000/800 mm/min, 8 mm passes (fast cutting avoids melting).

## Cutting rules

- **Spindle assumed clockwise from above.** Climb milling = the uncut material is on the RIGHT of the direction of travel (the tooth moves with the work; the cutting force pulls the tool forward; the same as G41 with M3). So loops where the tool is *outside* the enclosed region run **CW**; loops where the tool is *inside* (pocket walls, hole walls) run **CCW**. Conventional is the opposite. **Corrected 2026-11-16: versions before that had it the wrong way round** (the default Climb produced conventional cuts). 3D raster: climb runs right to left with rows stepping +Y. Implemented by `orient()` in `ops.ts` using Clipper's guarantee that after even-odd normalisation outers are CCW (+area) and holes CW (-area). Tests assert the signed area of every emitted loop. Zig-zag is not used for pockets (they are concentric rings), so direction is always consistent.
- Profiles: outside = tool outside outer edges and inside holes; inside = the reverse. Offset by `radiusAt(tool, z)` *per depth level*, so V-bits widen correctly.
- Pocket: contour-parallel rings inward from `radius`, step `2r * 0.4`, until empty (guard 2000). Island handling falls out of even-odd. No rest machining / adaptive clearing yet.
- Depth levels: `ceil(depth / stepdown)` equal steps.
- Ramps (`buildMoves`): descend at max 3 degrees along the loop, as many laps as needed (cap 8, then steeper), then a flat lap. Open lines (`buildOpenMoves`) descend while travelling back and forth, then run flat in both directions so the whole line is at depth.
- Tabs: spans along the tool-centre perimeter (`width + tool diameter` long, evenly spaced); where the pass is below `tabTopZ` the tool holds at `tabTopZ`. Loops too small to hold tabs get fewer or none.
- Path simplification: Ramer-Douglas-Peucker 0.01 mm after offset (cuts G-code size ~5x).
- Drill: bit == hole (within 0.2 mm) pecks straight down (2 mm cuts, 1 mm chip-break retract, full retract about every `max(2*stepdown, D)` mm, then **rapid** back down to 1 mm above the bottom through the open hole, flagged `rapid: true`). Larger holes are spiralled using the pocket on a 48-gon. Smaller than the bit = no toolpath + warning.
- Feeds: any move with a downward component, or a pure vertical move, uses plunge feed; others cut feed. Upward vertical moves and `rapid` moves are `G0`.

## G-code

`toGcode(paths, post)`: header comment, `G21 G90 G17`, then for a manual-speed router a pause (`M117 ...` + `M0` on Marlin, bare `M0` on GRBL) so the user starts the router; ends with `G0 X0 Y0` (+ `M2` on GRBL). Bit changes between consecutive toolpaths insert a pause with a "change bit and re-zero Z" message. No arcs (G2/G3) yet; everything is G1 polylines. `main.ts` `download()` swaps the generic zero line for a job-specific note so files never contradict themselves.

## Two-sided jobs (turn-over)

1. User picks a front outline shape and a back outline shape. `detectMirror` compares normalised outlines (chamfer distance over 4 transforms) and sets flip direction (`tb` = top-to-bottom, `lr` = left-to-right) and "already mirrored".
2. Each side-2 operation has a `frame` ('front' see-through vs 'back' drawing), guessed from whether the selection's centre lies inside the front outline's bounding box.
3. **Dowel layouts** (`dowelPositions`): 3 = keyed (one dowel at one end of the turn-over line, a mirrored pair at the other); 2 and 4 are symmetric. `wrongFits` tests whether the pattern would also seat when the stock is flipped the wrong way or spun 180 degrees *even if slid around*; the 3-dowel triangle never does, 2 and 4 always do (the UI warns). Not turning the stock over at all cannot be detected from holes: the docs tell users to mark the top face.
4. **Dowel hole depth is calculated** (`dowelHole`): the dowel sits about half in the spoilboard (min engagement `max(8, 1.5 D)`, spoilboard keeps 3 mm floor), the rest stands up into the stock but stays 3 mm below its top surface; +1 mm bottom clearance. Modes: `spoil` (through stock + into spoilboard, one pass; deepest), `spoilfirst` (step 0 drills the empty spoilboard, side 1 drills shallow blind holes in the stock: works for thick stock because every hole is shallow), `blind` (half the dowel in each of two mating pieces). Depth is capped at min(bit flute length, user max depth) and loudly warned when capped.
5. Why spoilfirst registers correctly without precise stock placement: stock holes and front cuts are both made in machine coordinates in side 1; after the flip the stock seats on the dowels at the same machine positions, so alignment depends only on the dowel positions (which lie on the turn-over line, so they are mirror-invariant), not on where the stock sat in side 1.
6. Files: `side1.gcode` (dowel drilling first), optional `step0_spoilboard.gcode`, `side2.gcode`.

## Split jobs (parts longer than the work area)

`planSplit`: usable window `segLen = bedX - 2*margin`; every window shifts by `segLen - overlap` so registration pins always occupy the same two sets of machine positions: **R** (drilled at the end of segment k) and **L** (where those holes sit after the stock slides by `shift`, one set of spoilboard dowel holes). `clipToolpath` clips every move polyline to the window (Z interpolated at edges); each clipped run becomes an open `Cut`, so ramps/tabs survive; runs start with a plunge. Overlap is cut twice on purpose.

`registrationPins`: keyed triangle (single pin left, pair right) in the waste margin above the part, centred in each overlap. For two-sided split jobs the mirror image is added below the turn-over line (6 pins) so the same pins register both the slide and the flip and remain keyed (tests: invariant under the correct flip; `wrongFits` empty).

Registration holes in the stock are **through** holes (`T + 2` mm, breaking 2 mm into the spoilboard) drilled in side 1 only; dowels are pushed into the pre-drilled spoilboard holes after each segment and the stock is lowered/slid onto them. Through-holes are required for the slide so the stock can drop onto the dowels from above; they need a bit with enough cutting length (the UI warns when `T + 2` exceeds the cap).

`buildSplitJob` outputs `step0_spoilboard.gcode` plus `segmentK.gcode` (single-sided) or `sideS_segmentK.gcode` (two-sided), each with instructions in its header. Two-sided splitting supports top-to-bottom turn-over only. If the part fits, no files are produced and the normal flow applies.

## UI notes (`src/main.ts`)

- Selection model: click toggles a shape, shift-drag box-selects (shapes fully inside), layer "Select" button toggles a layer. Changing the selection deselects the active operation; the form edits the active operation live.
- Each operation stores its own settings (`Settings`) and cached `tp`. `compile(op)` regenerates it; `placed()` translates/clips everything for export and for the preview/warnings. Warnings are collected in `refreshUi()`.
- Preview colours: grey = drawing, orange = selected, blue = toolpath (deepest pass), amber = tabs, purple dashed = side 2, green = dowels/pins and turn-over line, teal/orange dashed verticals = split windows.

## Testing

`npx vitest run` (currently 220 tests across `ops`, `twosided`, `split`, `jobs`, `import`, `dxf`, `arcs`, `text`, `vcarve`, `inlay`, `dogbone`, `project`). Browser verification recipe used during development: start the dev server, load a sample SVG into the file input with `DataTransfer`, drive the UI with scripts, and capture downloads by wrapping `URL.createObjectURL` to read the Blob text. This caught a real bug (the `rapid` flag being dropped in `translateToolpath`) that unit tests missed because they bypassed the placement step; any new Pt3 flag must be covered by a test that goes through `translateToolpath` and `toGcode`.

## Import pipeline (`src/svg.ts`, `src/import/*`)

`ParsedDrawing { shapes, notes, fileUnits, scaleToMm }` is the common result of both parsers; `processImport(parsed, opts)` (pure) scales, cleans and numbers the shapes and builds an `ImportReport`. `main.ts` `loadDrawing()` re-runs the whole thing from the stored file text whenever an import setting changes (and clears operations: ids are renumbered).

- `svg.ts` (browser only): hidden-DOM geometry as above, plus `<use>` expansion (clones the target into a `<g>` with the use's transform and x/y), skipping `defs/clipPath/mask/marker/pattern/symbol`, skipping `display:none` ancestors, counting ignored `text`/`image`, and unit detection in `unitInfo` (width with units + viewBox, else 96 dpi with a note).
- `import/dxf.ts` (pure, uses `dxf-parser`): LINE, LWPOLYLINE/POLYLINE (bulge arcs via `bulgePoints`), CIRCLE, ARC (angles in radians from the parser, CCW, wraps past 360), ELLIPSE, SPLINE (de Boor on control points + knots, fit points as a fallback; weights are not exposed so rational splines are approximated), INSERT (recursive, scale/rotation/array, subtracts the block base point, layer "0" inherits the insert's layer), TEXT/MTEXT/DIMENSION/other types counted and reported, hidden/frozen layers skipped. `$INSUNITS` maps to mm per unit; missing = mm with a note. Curve chord tolerance 0.01 mm in output units (flattened in entity units so block scaling stays accurate).
- `import/join.ts` (pure): `cleanShapes` = drop specks (< 0.01 mm) -> dedupe (same layer, quantised 0.01 mm signature of area/centroid/length or endpoints) -> `joinShapes` -> close near-closed lines -> dedupe again. `joinShapes` clusters end points into nodes with union-find on a grid; a 2-end node is a clean join; at a node with 3+ ends it pairs the ends whose outgoing directions are most nearly opposite (cosine <= -0.9) and leaves the rest free, else counts an "ambiguous junction". Chains are walked from a free end (reversing the first piece if only its tail is free); remaining pieces are cycles. Only same-layer pieces join. After joining, `cleanShapes` closes a *single* line whose own ends are within `closeTol` (default 2 mm) only if the gap is also <= 2% of its length (`loopLike`), recorded as `stats.largestClosedGap`; this catches outlines that stop ~1 mm short without the false joins a larger `joinTol` causes. Join tolerances are applied *after* unit scaling, so a wrong units guess (e.g. inches read as mm) also makes tolerances ~25x too large relative to the geometry: re-import after fixing units. Verified on a real R12 DXF export and its SVG twin (same drawing): once units are set both give 906 x 1470 mm, 570 shapes, 600 pieces joined. Default tolerance 0.05 mm: real CAD exports usually meet exactly, but data can have genuine gaps (a real file had a 56 mm hole), so raising the tolerance is not a substitute for the manual tools.
- Manual fixes in `main.ts`: **Close selected** (marks open shapes closed in place; ops keep their ids) and **Join selected** (`joinShapes` on the selection with its own tolerance, then `replaceShapes` which renumbers ids and remaps/drops affected operations, references and selection).

## Arcs (G2/G3) (`src/core/arcs.ts`, `gcode.ts`)

`fitArcs(moves, tol=0.01)` greedily replaces runs of moves that lie on one circle with `Seg { to, arc: { i, j, cw, radius } }` (I/J = centre relative to the arc start). A run must be at constant Z, contain no `rapid` move, turn one way, sweep <= 180 degrees, have radius 0.4..2000 mm, and every point must be within `tol` of the circle (circumcircle of first, middle, last point, so both ends are exactly equidistant from the centre, which firmware radius checks need). Ramps and z-steps therefore stay as G1 lines; helical arcs (G2/G3 with Z) are deliberately not emitted because Marlin support is uncertain. `toGcode` uses it when `post.arcs` is set; I/J are written with one more decimal than positions. Direction is preserved: climb inside a pocket = CW = G2 (tested).

**Marlin caveat:** arcs only work if the firmware was built with `ARC_SUPPORT` (defaults vary between versions; some MPCNC users report editing the config). So the UI defaults arcs to **off for Marlin and on for GRBL** (changing firmware flips the default) and offers `arcTestGcode()`: an air-cut file (stays at Z=10) that draws a full CW circle and four CCW quarter arcs. Measured on a real outline: 9,566 -> 5,832 lines, 840 arcs, worst deviation 0.0011 mm (ramps keep it from being smaller). `estimateMinutes()` gives the run-time guide shown in the UI (cut/plunge feeds + 3000 mm/min rapids, no acceleration).

## Text (`src/text/*`, `src/import/text.ts`)

`text/outline.ts` (pure, fully tested against the real font in Node): `textToContours(font, text, {capHeight, tracking, lineSpacing, align})` lays out glyphs with kerning, flattens quadratic/cubic curves to 0.01 mm and returns closed contours in mm, Y up (origin = start of the first baseline; centre/right alignment shifts per line). Size is **cap height** (measured from the glyph H), which is what users mean by text height. Counters (holes) come out as separate contours; downstream `normalize` (even-odd) turns them into holes, so pockets leave them uncut. `text/fonts.ts` bundles six OFL fonts via `@fontsource/*` (`?url` imports, woff1 parsed by opentype.js 2.x, loaded lazily; **woff2 is not supported by opentype.js**). `fonts-guess.ts` (pure) maps a file's font family/weight to the nearest bundled font. Imports: SVG `<text>` (position from x/y through the screen CTM, size from computed font-size x CTM scale, rotation from the CTM, `text-anchor`, tspans with y/dy become new lines) and DXF TEXT/MTEXT (height = cap height, halign via the alignment point, MTEXT attachment corner moved to the first baseline, formatting codes stripped by `dxfText`) produce `TextItem`s on `ParsedDrawing.texts`; `main.ts loadDrawing` converts them (async, fonts loaded on demand) before `processImport` and adds a note that letter shapes are substituted. The Add-text tool appends shapes with `addShapes` (existing ids unchanged). opentype.js has no types: see `src/text/opentype.d.ts`.

## V-carving (`src/core/vcarve.ts`)

**Geometry.** The ideal V-carved floor at a point is `distance to the outline / tan(half angle)` (plus a tip allowance). A V-bit whose tip runs along the medial axis at depth `(r - tipRadius) / tan(half)` (r = inscribed-circle radius there) produces exactly that, because each cone's flank passes through the outline. So V-carving = medial axis + radius per node + depth from radius.

**Medial axis (`medialAxis`).** Outline (even-odd normalised, so interior is always on the left of a boundary edge) is resampled every `spacing` mm (0.1..0.5, from the tip size), triangulated with `delaunator` (unconstrained; **not** Clipper's `triangulateD`, which merges collinear vertices and so destroys dense straight-edge sampling), triangles are labelled inside/outside by flood fill from the directed boundary edges (label flips across a boundary edge), circumcentres of inside triangles are the Voronoi vertices = axis nodes with `r` = circumradius (an obtuse triangle whose longest side is an outline piece has its centre outside and is skipped), and Voronoi edges are the chords between two inside triangles, skipping chords between sites <= 2 samples apart along the same loop (sampling noise). `pruneAxis` then removes dead-end branches shorter than 3 samples (hairs). `chains()` splits the graph at junctions/dead ends; chains start at their shallow end and are ordered nearest-neighbour; paths are simplified with 3D RDP (x, y, depth, eps 0.02).

**Passes and caps.** Depth per node = `depthForRadius`, capped by `min(maxDepth, maxVDepth)` (a V-bit cannot cut wider than its own diameter). If deeper than the material `stepdown`, several passes run, each clamped to a growing depth limit. `wide: 'clear'` adds concentric rings (inward offsets from `surfaceRadius(cap)` in steps of 0.15 of that radius, 0.1..0.5 mm) at the cap depth for areas the cone cannot reach; `'skip'` leaves them. `Toolpath.meta` carries `wantedDepth` and `usedCap`, which `main.ts` turns into the "widest strokes need N mm" warning.

**Verification.** The tests do not just check shapes: they *simulate* the cutter (deepest cone over all path samples) and compare it with the ideal roof at many probe points: no uncut ridge inside, nothing cut outside, rings leave holes alone, a wedge's depth follows the local half-width, and a real bold word carves in under a second with essentially no short points (`tests/vcarve.test.ts`, `tests/vcarve_text.test.ts`). Preview draws all passes of a V-carve (other operations show only the deepest). Choosing V-carve with a non-V bit auto-selects a 60 degree V-bit and a 3 mm depth.

**Limits.** Wide-area clearing with a V-bit leaves ridges (step/2 / tan(half)); no separate flat-bit clearing op yet. Narrow strokes below the tip width are not carved. Skeleton accuracy depends on sampling: very coarse spacing on huge shapes is not adaptive.

## V-inlay (`src/core/inlay.ts`, `src/core/ringlink.ts`)

Recess depth P, glue gap g, tan = tan(half V angle), delta = P * tan.

- **Female** = `vcarve(shapes, maxDepth P, wide 'clear', clearStep 0.2)`. Its sloped wall meets the outline at the surface and the flat floor starts delta inside the outline.
- **Male** = the *inverse*, cut on a second board and **mirrored about the vertical centre line of the selection** (so it reads correctly once the insert is flipped): islands = `offset(mirrored, -delta)` (top inset by delta, widening to the outline at depth P). The wall is `profile(island, 'outside', V-bit, depth P+g)`: the V-bit's per-level offset puts the cone edge on the island outline at every depth, so this is exactly right. Flat background: concentric `offset(island, +d)` rings from `surfaceRadius(P+g)` out to the moat width at depth P+g (coarse 0.5 mm step: the base is sanded away). **Counters (holes of the island) are cleared completely**, not just to the moat width, or a bump would remain that cannot fit the recess. Depth P+g means the insert stands proud by g.
- **Blank**: `offset(island, r0 + moat - 0.2)` (kept just inside the carved region), returned so `main.ts` can add it to the drawing as a shape for an ordinary flat-bit cut-out.
- Pause: the first male `Cut` carries `pauseBefore` (swap the board); `toGcode` writes a comment block, `M117` (Marlin) and `M0`. `Cut.tag` ('female'/'male') drives the preview colours (blue / purple dashed).
- **Verification** (`tests/inlay.test.ts`): a cross-section fit test simulates the cutter on both toolpaths and checks `recess depth(y) == insert height(y) - g` across a stroke for 90 and 60 degree bits (tolerance 0.2 mm = the V-bit floor ridge), that the insert is mirrored (an L), that nothing is cut outside the blank, that thin strokes warn, and that a ring's counter is fully carved.
- Warnings: strokes thinner than `2 * delta` vanish when inset (`lost > 2%` of area), depth beyond `maxVDepth`, nothing left to insert.
- `linkRings(rings, z, zStart, {ramp, linkMax})` links concentric rings: the first ring of a chain ramps in, later rings that start within `linkMax` are joined by a short move at depth instead of lifting and re-ramping. Used by V-carve wide-area clearing and the inlay background. Measured on a real 4-letter inlay: 53,695 lines / 2 h 15 min before linking, coarser background step and slope-based feed, 18,036 lines / 24 min after.

## Feed on descending moves (`moveFeed` in `gcode.ts`)

A straight plunge (or anything steeper than 45 degrees) uses `plungeFeed`; descents under about 6 degrees (ramps, V-carve skeleton slopes) use the full cutting feed; in between it blends linearly, rounded to 25 mm/min. Before this, every descending move used the plunge feed, which made ramped jobs far slower than necessary (about 37 of 49 minutes in the inlay above). `estimateMinutes` uses the same function. This changes feeds for every ramped operation (ramps are 3 degrees by default): the plunge feed still applies to real plunges.

## Dogbone corners (`insideCorners`, `addDogbones` in `ops.ts`)

Sites come from the **original region**, not by guessing at sharp vertices of the offset loops: `insideCorners(normalizedRegion)` returns vertices where the path turns left (the cut region lies to the left of every edge after even-odd normalisation, outer loops CCW and holes CW, so a left turn = locally convex corner of the region) with interior angle 30..160 degrees. Fine curves (many tiny turns), island corners (reflex for the region) and near-straight vertices are ignored. For a corner C with unit inward bisector b and half-angle h, the cutter-centre path vertex is T = C + b*r/sin(h) and the relief point D = C + b*r (a circle of radius r centred on D passes through C); `addDogbones(loop, corners, r)` finds the offset-loop vertex within 0.05 mm of T and inserts D, T. Excursions longer than 3r (very sharp corners) are skipped. It runs **before** `orient()` so the interior-left assumption holds, only on the first pocket ring (the wall pass) and only for 'inside' profiles, using the per-level radius. Tests (`tests/dogbone.test.ts`) check coverage (the centre path gets within r of every corner, 3*sqrt(2) without), direction preserved, round shapes unchanged, island corners untouched, exactly 8 extra points per level for a square.

## V-carve flat-bit companion (`vcarveWithFlat` in `vcarve.ts`)

`wide: 'walls'` makes the V-bit cut only (a) skeleton stretches that need no more than the cap depth (chains are split where `need > cap`) and (b) one wall contour `offset(region, -surfaceRadius(cap))` at full depth (ramped). `vcarveWithFlat` then: if no part is wider than the cap, returns the plain result; else floor = `offset(region, -cap*tan(half))` (where the sloped wall meets the flat floor, independent of tip width), flat pocket = `pocket(floor, flat bit)`, `reachable = open(floor, flat radius)`, `leftover = floor - reachable` (`subtract` via Clipper `differenceD`). If the leftover is > 2% of the floor (and > 1 mm2), or the flat bit cannot help at all, the V pass is regenerated with `ringsWithin: leftover`: V-bit clearing rings (0.3 mm step, ridge <= 0.15 mm) kept only where they touch the leftover (at least 15% of sampled ring points inside it), linked with `linkRings`. **An earlier version only warned when the flat bit could not reach the floor, which silently left most of it uncut (it looked like a 2 minute job); the V-bit fallback is what makes the result correct.** In the app an operation can produce two toolpaths: `Op.pre` (runs first, with a different bit) plus `Op.tp`; always use `tpsOf(op)`. `toGcode` inserts the bit-change pause when consecutive toolpaths use different tools. Tests simulate both bits (flat = a disc of the bit's radius at path depth, V = cone) and check the combined depth against the ideal at probe points, nothing outside, a truly flat floor, and the partly reachable case.

## Undo/redo, projects and backup (`src/project.ts`, `src/storage.ts`, end of `main.ts`)

- A `Snapshot` = source file (name + text), `shapes`, hidden layers, ops (id, ids, settings, inlay blank), `nextOp`, front/back refs, and **every settings control** in the side panel by id (`captureForm`: inputs, selects, textareas, checkboxes; not file inputs). Toolpaths are never stored: `applySnapshot` restores the form first, then recompiles every op (compile reads the current panel for material etc.). Settings missing from an old project take the current panel values.
- `History` (pure, tested) keeps up to 100 snapshots with a cursor; `commit` ignores a state identical to the current one; a new change after undo drops the redo branch. `sameSnapshot` compares shapes **by object identity**, so **shapes must be replaced, never edited in place** (that is why "Close selected" now maps to new objects). Structural changes call `commit()` directly (add/delete op, load drawing, add text/shapes, replace shapes, close, set refs); settings edits call `scheduleCommit()` (600 ms debounce via `input`/`change` listeners on `<aside>`), so one burst of typing is one step. Selection, view and measurements are not history. `restoring` suppresses commits while applying.
- Keyboard: Ctrl/Cmd+Z, Ctrl+Y, Ctrl+Shift+Z, Ctrl+S, ignored while focus is in an input/select/textarea so text fields keep native undo.
- **Project file** (`.opencam.json`): `{app:'open-cam', version:1, savedAt, source, shapes:[{layer, closed, pts:[x,y,...] rounded to 0.001}], hidden, ops, nextOp, frontRef, backRef, form}`. `projectToSnapshot` validates (app/version, shape coordinates, op shape ids in range, refs dropped if out of range) and throws `ProjectError` with plain-English messages; newer versions are refused. Bump `PROJECT_VERSION` and add a migration if the format changes.
- **Backup**: after each commit a 3 s debounced write of the same JSON to IndexedDB (`storage.ts`, key `autosave`; localStorage is too small). On start `offerBackup` shows the restore bar; **autosave is paused while the bar is showing** (so an ignored bar cannot be overwritten by an empty session).

**Dev-server gotcha:** if you add a function and its import in two quick edits, the browser can keep a cached copy of the module under an old `?t=` HMR URL ("X is not defined" with a correct file on disk). Touch the file again (any edit) to bump the URL, or load the page with a new query string.

## Measure tool and size readouts

`main.ts` keeps `measures` (pairs of drawing-frame points), `pendingA`, `hoverP`. Points snap to the nearest line vertex within 10 screen px (`snapPoint`; vertices are dense because curves are sampled every 0.5 mm). Results are shown on the canvas and in the panel in mm, inches and pixels at 96 dpi. `M` toggles, `Esc` cancels/exits. The "Drawing size" box and the "Selection" box give instant sanity checks of units. A dev-only hook `window.__app` (`import.meta.env.DEV`) exposes `shapes` and `ops` for browser verification.

## Help system

`docs/USER_GUIDE.md` is the single source. `help.html` + `src/help.ts` render it with `marked`: heading ids (GitHub-style slugs), a contents sidebar with scroll-spy, client-side section search (press `/`), print styles, and an `?embed=1` mode (no header/sidebar) used by the in-app drawer. In the app, any element with `data-help="<anchor>"` gets a **?** button that opens the drawer (iframe `help.html?embed=1#anchor`); `F1`/`?` opens it at the top; `src/hints.ts` maps field ids to hover hints. **When adding a section to the guide, check the slug it produces matches any `data-help` that should point at it** (the help page's own contents links are verified in the browser).

## Known limitations / ideas

- 3D milling is top-surface only (no undercuts, X-direction raster finishing only, flat-level roughing); no adaptive/trochoidal clearing, no rest machining. V-carve exists (medial axis, with an optional flat-bit companion). Inlay exists (V-inlay only): no flat-bottom (pocket) inlay, no per-letter separate inserts, the insert is mirrored about the vertical centre line only.
- Arc output exists but skips ramps (no helical arcs); the text engine has no single-line (engraving) fonts and no per-letter editing after insertion.
- Competitor ideas not yet adopted (from reading DeskProto and Estlcam): lead-in/out, customisable keyboard shortcuts, mitre and tongue-and-groove joint wizards, trochoidal clearing, 3D roughing/finishing from STL, tool library persistence. Done since: machine-time estimate, dogbone corners, undo/redo, project save/load, autosave, V-carve, inlay, text, arcs.
- Split jobs: top-to-bottom turn-over only; through-hole registration needs a long enough bit; no automatic "cut remaining length" ordering of segments beyond equal windows.
- Import: no DWG, no images (reported to the user), SVG clip paths and masks ignored, DXF rational spline weights ignored, DXF entities in non-XY planes (extrusion directions) are not re-projected.
- Safety features present: bounds check, flute length, depth vs stock, dowel fit and hole depth warnings. Not present: Z-travel limit, holder collision, tool-load estimates.

## Release hygiene

Before declaring a change done: `npx tsc`, `npx vitest run`, `npx vite build`, and for UI changes a browser check that exercises the actual download path. Update this file and `docs/USER_GUIDE.md` (generic wording only: no references to any specific industry or product) in the same change.

## 3D milling (STL) - IN PROGRESS

Core done and tested: src/core/mesh.ts (parseStl, orient, heightMap), src/core/mill3d.ts (toolSurface, cutSurface, rough3d, finish3d, simplify3), tests/mill3d.test.ts. Model is reduced to a top-down height map; tool-tip surface = max(model - bit profile), so paths never gouge. Roughing = flat levels (stepdown from material, 'leave' stock), finishing = X raster on the tool surface, climb = +X passes stepping +Y, optional zigzag chaining. UI: 'stlbox' panel in index.html, 3D ops use Kind rough3d/finish3d (Settings.m3), model not saved in projects (reload STL). Sample: public/samples/relief.stl.

Verified: 240 tests pass; browser check with relief.stl (preview shaded, rough 1089 passes, finish 200 passes ~14k points, download G-code ok, 21k lines). Reach warning = fraction of interior cells where cutSurface (min over footprint of S+profile) stays >0.05 mm above the model. User guide section '3D milling' added.

Not done: finishing cross-pass, rest machining, saving the STL in projects, Z-level finishing for steep walls (raster on steep walls is coarse in Y).
## Drill operation and operation order

Kind 'drill' (UI: Drill holes): closed shapes are tested with src/core/holes.ts circleOf (bbox square within 2%, radius constant within max(0.03mm, 1%)); grouped by diameter (0.01 mm), ordered nearest-neighbour, then core drill() (peck if bit==hole within 0.2, spiral pocket if bit smaller, skipped if bit bigger). Hole markers are drawn instead of paths. Operation order = list order = G-code order; opup/opdown buttons swap neighbours (commit() for undo). Bit-change pauses only when the tool differs between consecutive toolpaths. Tests: tests/holes.test.ts.

## Simulation, zero point

src/core/sim.ts: stock height grid (top Z=0, bottom -t, cell 0.5 mm, capped at 1.5M cells), kernelFor(tool) = bit profile offsets, cutSegment sweeps the bit tip (samples every cell/2), simulateToolpath mirrors toolpath playback (start 1 mm above first xy; moves flagged rapid are only checked: crash if grid height > z+0.15), autoStock (cut bbox + 5 mm margin, thickness = deepest Z), simSummary. src/sim3d.ts: WebGL2 orbit viewer (height grid pooled by min to ~300k vertices, side walls, colour by depth, depth exaggeration uniform). UI in main.ts end ('simbtn', dialog '#simdlg' outside the aside so form capture ignores it; one source per side/segment). Zero mode: select #zero (corner / part / centre) applied only in the single-setup branch of placed(); two-sided and split force corner; bounds check replaced by size check when not corner. Tests: tests/sim.test.ts. Dialog visibility needs '#simdlg.hidden' CSS (ID specificity).

## Run open line out to outline

src/core/runout.ts runOutToEdge(line, edge) returns {pts, free}: each end of the open line continues along its last >=2 mm heading to the nearest crossing of the closed outline (an end on the outline, or up to 1.5 mm past it, counts as reaching it); the shape is closed by following the outline the shorter way round. The shape is EXACT (no overshoot); Shape.free = [from,to) point range of the outline-following open side. expandFreeEdge(pts, free, d) pushes that side outwards along its normals by d and unions the strip: used by compile() for kind 'pocket' only, with d = bit radius + 0.5 (so the overshoot is part of the operation, not the geometry). free is kept through replaceShapes, project save/load (optional field) and undo. UI: button #runout (select one open + one closed shape). Tests: tests/runout.test.ts. Dev hook window.__app.select(ids) (DEV only).

## Review fixes (2026-11-16, from docs/REVIEW_TODO.md)

- **Climb/conventional corrected.** Climb = uncut material on the RIGHT of travel (clockwise spindle seen from above; same as G41 with M3; the tooth moves with the work and the cutting force pulls the tool forward). Outside loops climb CW, inside (pocket/hole walls) climb CCW. Earlier versions had it reversed. Tests include a convention-independent check (`tests/ops.test.ts`, "climb really is climb": which side of travel is material). The 3D raster climbs right-to-left with rows stepping +Y.
- **Fast entry on later depths.** `planEntries(paths)` in `gcode.ts`: when an earlier pass with the same bit ended at exactly this cut's start point (closed loops), the next pass rapids down to 1 mm above its start depth instead of feeding from Z1 at plunge speed. Used by `toGcode`, `estimateMinutes` and the simulation (which checks the drop really is through air). Cuts after a `pauseBefore` forget what was cleared (the stock may have been swapped).
- **Time estimate** now counts the first descent of every cut (it started each cut at its first point before).
- **Marlin G0.** Marlin treats G0 like G1 and keeps the modal feed, so fast moves crawled at the last cutting/plunge feed. Marlin output now states `F3000` (`Post.rapidFeed`) on every G0 and the next G1 restates its feed; the firmware still clamps each axis to its own M203 maximum. GRBL output is unchanged (plain G0).
- **After adding an operation nothing stays "active"** (editing the form used to change the operation just added). Click an operation in the list to edit, move or delete it.
- **Operation info vs warnings.** `Op.info` holds plain facts (e.g. how each hole size will be drilled); shown under the operation. `planDrill` (in `core/holes.ts`) holds the drill grouping and messages, tested in `tests/holes.test.ts`.
- **3D**: roughing keeps `leave` all round the bit (bit grown by 2x leave, then lifted by leave), finishing warns when no roughing precedes it, 3D operations work in two-sided jobs (see below) and split jobs (`clipToolpath` is generic; windows are clipped like any toolpath, the overlap is simply cut twice), `Math.min(...bigArray)` replaced by `minOf/maxOf` (`core/util.ts`; spreading 100k+ values overflows the stack).
- **Two-sided 3D (side 2).** `turnOver()` in `core/mesh.ts` rotates the placed model 180 degrees about the flip line (the same line `ptsOf` uses: centre of the front outline; `tb` mirrors Y, `lr` mirrors X; Z becomes `-T - Z` with T the two-sided stock thickness), then re-bases it like any model and returns its new `x`, `y` and `top`. `compile3d` feeds that to the ordinary `rough3d`/`finish3d`, so side 2 is the height map of the model's underside. A rotation, not a mirror: nothing is reversed. Z zero for side 2 is the new top surface, as for 2D operations. Tests in `tests/mill3d.test.ts`. Side 2 needs a closed solid (a surface-only STL such as `relief.stl` has no underside, so its side 2 is meaningless; the app warns). Back-side 3D passes are drawn purple on the preview. Two-sided simulation stock: sides 1 and 2 are translated by the same (dx, dy) and the flip line is the stock centre, so the stock rectangle (0,0)-(W,H) is correct for both. Unchecked on a real machine.
- **3D model in projects.** `Snapshot.model` = `{name, tri: Float32Array}` (the triangles as read, before orientation). Saved as base64 of the raw floats (~48 bytes/triangle), also in the IndexedDB autosave; compared by identity so undo steps share one array. Orientation settings are in `form`. `applySnapshot` keeps the existing `stl` object when the triangle array is the same, and calls `rebuildModel()` (cheap relative to the compile). Loading an STL commits an undo step. Old projects have no `model` and open with none.
- **Rest roughing (3D).** `RoughParams.rest` = diameter of the earlier flat bit. The earlier bit's tool surface is computed on the same height map (grown by `2*leave`, lifted by `leave`, like this bit's); a cell is cut at a level only if this bit's surface is at or below it and the earlier bit's was still above it. Ignored (with a warning) if the earlier bit is not bigger. 2D rest machining is not built.
- **Steep-wall contours.** `FinishParams.steep` (degrees). Grid squares whose tool-surface range exceeds `tan(angle)*cell` are steep; raster coverage excludes their corner cells, and `contours()` (marching squares over just those squares, edges numbered per cell so segments chain exactly) traces level lines at `stepover` spacing from the top of the steep area down. Each segment is oriented by sampling the surface either side, so the high ground (the model wall) is on the right of travel for climb, left for conventional. A saddle cell makes two separate segments. Constant-Z passes plunge at their start like any pass; `simplify3` thins them. Tests: `tests/mill3d.test.ts` (a cliff, a cone's contour is a clockwise circle).
- **Helical arcs.** `fitArcs` accepts Z that changes linearly with the angle turned (within min(tol, 0.01)); `Seg.arc` has `sweep`; `toGcode` writes `Z` in G2/G3 when it changes and uses `moveFeed` with the arc length for the feed (a 3 degree ramp keeps the cutting feed).
- **DXF hatches.** `import/hatch.ts` reads HATCH entities from the raw ASCII group codes (dxf-parser skips them): polyline boundaries (with bulges) and line/arc/ellipse edges; spline edges are reported. Outlines identical in bounding box and area (1%) to an existing closed shape are dropped, because two identical loops cancel under the even-odd union. Only the ENTITIES section is read (not blocks).
- **Binary DXF.** `import/bindxf.ts` converts to ASCII text (sentinel check, 1- or 2-byte group codes decided from the first record, value type by group code range) and `parseDxf` does the rest. Main reads the file as bytes and stores the converted text as the project source. DWG is not supported.
- **3D cross finishing.** `FinishParams.cross`: `finish3d` runs `finishOnce` on the model, then on the model with X and Y swapped (`transpose`, a mirror about the diagonal) and swaps the toolpath back. A mirror keeps climb as climb (uncut side stays on the right: stepping +Y heading -X becomes stepping +X heading -Y), tested.
- **Lead-in/out.** `leadMoves` (`entry.ts`) wraps the moves of one closed loop; only `profile` (outside/inside) uses it, via `ProfileParams.lead` (radius). Quarter-circle tangent arcs bend to the waste side (`wasteLeft = climb`: finished edge is on the right for climb). Lead-in only on the first depth (the arc is the descent, from `zStart` to `z`), lead-out only on the last; middle depths are unchanged so `planEntries` still rapids into the kerf. The arcs must pass `clear()` (outside the offset ring for an outside cut, inside it for an inside cut), else the radius is halved twice, then dropped. Tests: `tests/lead.test.ts`.
- **Pocket lead-in/out and rest machining.** `PocketParams.lead` reuses `leadMoves` for the wall pass only (`guard === 0`, the first ring of each depth); `clear()` = inside the wall-pass ring (boundary counts). That ring's loop is restarted at the middle of its longest edge (`startMidEdge`) at every depth, because a lead arc needs a straight run, not a corner; later depths keep the same start so `planEntries` still rapids in. Not offered for on-line (no waste side) or V-carve. `PocketParams.rest` (diameter of an earlier bigger flat bit): `restRegion(full, big, margin)` = `full` minus the area swept by the big bit (open `full` by `big/2`, grown 0.05 mm for rounding), dropping slivers under 0.01 mm², then the leftovers grown by `margin` (tool diameter + 0.5, so the wall ring has room to reach into the corner) and clipped to the pocket. `pocket()` runs its normal rings on that region; dogbone corners still come from the full pocket. A rest bit not bigger than this one is ignored; if nothing is left over the operation says so. UI: `#prest`, `Settings.prest`. Tests: `tests/pocket_lead_rest.test.ts`.
- **Custom start/end G-code and machine defaults.** `Post.startGcode` / `Post.endGcode`: blank lines are dropped; non-blank start text replaces the built-in spindle/pause lines (after G21 G90 G17), non-blank end text replaces the spindle-stop, `G0 X0 Y0` and `M2` lines (after the final lift to safe Z). `src/machine.ts` keeps `MachineProfile` (firmware, arcs, work area, start/end text) in localStorage under `open-cam.machine`; `loadMachine` validates field by field, so damaged data falls back to defaults. Saved by the "Save as my machine defaults" button, applied once at startup, never put in project files. Tests: `tests/machine.test.ts`.
- **Flat-bottom inlay.** `inlayFlat` (`inlay.ts`): shape = opening(closing(design, r), r) so pocket and cut-out match with a round bit; insert shape = shape - `FLAT_FIT` (0.1 mm); recess = `pocket`, insert = `profile` outside with 3 tabs, first insert cut has `pauseBefore`. Insert board thickness = depth + proud. Tests: `tests/inlayflat.test.ts`.
- **Start depth.** `CutParams.start` (mm below the top) for outside/inside/pocket/on-line/drill (not V-carve, inlay, 3D). `depthLevels(depth, stepdown, start)` spans start..depth; the first pass has `zStart = -start` and `Cut.airTo = 1 - start`; `planEntries` turns that into a rapid drop (the simulator checks planned drops against the stock, so a start depth below material that is still there shows as a crash). Old projects without `start` read as 0. The spiral-drill path inherits it through `pocket`. Tests: `tests/gcode_entry.test.ts`.
- **Simulation yield.** `nextTurn()` uses `requestAnimationFrame` in a visible tab and a `MessageChannel` message in a hidden one (hidden tabs do not run animation frames, which made the simulation crawl).
- **Zero at "part"** uses the bounding box of the shapes that have operations (plus the 3D model), not the path the bit's edge takes.
- **HTML safety:** layer names and file names go through `esc()` before being put in the page.
- **Simulation viewer:** a fresh canvas per opening (old listeners and GL context go with the old canvas), program deleted on dispose; auto-stock mode says it cannot show spoilboard contact.

## Look and layout
- No UI framework: plain HTML (`index.html`) and TypeScript. All styling is in `src/style.css` (design tokens at the top: concrete-grey panel, paper-coloured drawing area, dark steel step plates, orange only for the download action and teal for selection).
- `src/ui.ts` turns every `aside h2` into a folding "step" plate by MOVING its following siblings into a `.body` div (elements keep their ids, so no other code is affected). Fold state is remembered in localStorage (`open-cam.folded`); the two-sided and split sections start folded. The simulation, download and zero-note elements sit in the sticky `#actions` strip.
- A draggable divider (`#splitter`, also arrow keys; double-click resets) sets the panel width (260 to 900 px); remembered in localStorage (`open-cam.panelWidth`) and it fires a window `resize` so the canvas redraws.
- Not restyled yet: `help.html` (the guide page) and the colours the drawing canvas and simulation use.
