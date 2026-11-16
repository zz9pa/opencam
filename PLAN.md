# Open-source browser CAM ("Easel replacement") – Plan

## 1. Landscape (what exists)
| Project | Notes | Use for us |
|---|---|---|
| [Kiri:Moto](https://github.com/GridSpace/grid-apps) (MIT, JS, runs in browser) | CAM mode: facing, roughing, profiling, finishing; mostly 2.5D, some 4-axis. UI is dense, not beginner friendly. | Closest prior art – study/fork or borrow ideas; don't build on its UI. |
| [OpenCAMLib](https://opencamlib.readthedocs.io/) (LGPL, C++ with Python/Node/WASM bindings) | Drop-cutter, push-cutter/waterline, ball/bull/cone cutters. Powers FreeCAD 3D surface/waterline. | Candidate 3D engine (check LGPL fits your licence plans), or reimplement the simple parts. |
| FreeCAD CAM (Path) | Full-featured, desktop, steep learning curve. | Reference for strategies. |
| jscut, CAMotics | jscut = 2D browser CAM (abandoned); CAMotics = simulator. | Reference / simulation ideas. |

Conclusion: yes, slicer-style ideas transfer directly. Nothing open source combines Easel-level friendliness with real 3D milling plus split/dowel workflows for guitar parts. That is the gap.

## 2. Product principles
- 100% client-side (static site, files never leave the machine, works offline, free to host).
- Wizard-first: Import → Material & stock → Machine → Tool → "What do you want to do?" → Preview → Export. Advanced settings hidden behind "Expert".
- Sensible defaults from a tool/material feeds-and-speeds table; plain-English warnings ("this bit is too wide to cut this corner").
- Always-on 3D simulation (material removal) before export.
- Safety checks: out-of-bounds, plunge into stock, tool too short, gouging.

## 3. Architecture
- TypeScript + Vite, Three.js for viewport, geometry in Web Workers (never block UI).
- Core library `cam-core` (no UI, testable in Node): geometry → toolpaths → post-processor → G-code.
- Libraries: Clipper2 (WASM) for 2D polygon boolean/offset; opentype/svg parsers (svg-path-parser, dxf-parser); three STLLoader; `three-mesh-bvh` for fast mesh queries; optional OpenCAMLib WASM.
- Post-processors as small plugins: GRBL (default), Mach3/LinuxCNC, Marlin-CNC; configurable header/footer, arcs on/off (G2/G3), tool change, spindle control.

## 4. Toolpath algorithms
**2D / 2.5D (Phase 1)**
- Profile (inside/outside/on-line) via polygon offset (Clipper2) by tool radius; tabs/bridges; multiple depth passes; lead-in/out; ramp/helical entry.
- Pocket: offset-spiral (contour-parallel) and zig-zag; adaptive/trochoidal clearing as later upgrade.
- V-carve (medial axis / offset-to-zero) and engraving; drill; text.
- **Climb vs conventional**: this is the "keep the spindle moving the right way" requirement. Rule: spindle CW (standard) → climb milling = uncut material on the RIGHT of the direction of travel, so the tool travels CW around the *outside* of a part contour and CCW around pocket walls and holes (corrected 2026-11-16: an earlier version had this the wrong way round), flipped for conventional. Implementation: after offsetting, normalise polygon winding, then enforce direction per loop type; for zig-zag pockets, use only one cutting direction (retract and rapid back) when climb is required. Make it a global setting with a per-op override, and unit-test by checking signed area of each emitted loop.

**3D (Phase 2)**
- Heightmap from mesh (GPU/BVH depth render) – fast path for relief carving and for most guitar *tops/backs*.
- Roughing: Z-level (waterline-style) slicing of the mesh offset by tool radius + stock-to-leave, using Clipper2 for each slice, then pocket the slice region → "3D adaptive" roughing. This is literally slicer technology.
- Finishing: raster drop-cutter (ball/bull/flat) over BVH, with stepover; waterline/contour finishing; pencil/rest machining; steep/shallow splitting for scallop control. Tool-radius compensation via dropping the actual cutter shape onto the mesh.
- Rest-machining via simulated stock.

**4th axis / flip machining (Phase 3)** – two-sided jobs (see §5).

## 5. Guitar-specific features (the differentiator)
- **Two-sided machining with registration**: model the part as two setups (front/back). Auto-add dowel/alignment holes in the stock sacrificial area or spoilboard; generate drill op first, then flip-and-realign instructions. Dowel diameter, count and position editable; positions mirrored correctly about the flip axis.
- **Neck workflow**: neck is long and may exceed machine bed → **split job** into segments with overlap and alignment dowels/keys (dowel holes drilled in both halves, or tongue/finger joints), per-segment stock, G-code per segment. Also headstock angle (scarf joint) and truss-rod channel as templates.
- Parametric templates: truss-rod slot, pickup/control cavities (from SVG outline + depth), neck pocket, binding channel, fret-slot via slotting saw/small endmill.
- Body workflow: top contour (3D carve), back contour, cavities, outline profile with tabs, flip with dowels.
- Import friendly: STL/OBJ, SVG, DXF; units and scale/orient tools; "place in stock" with grain direction indicator.

## 6. UX plan
1. Landing: "Start a project" with three choices: *Cut shapes from a drawing*, *Carve a 3D model*, *Guitar parts*.
2. Machine setup saved locally (bed size, spindle range, GRBL flavour, work origin).
3. Tool library with presets (1/8" & 1/4" flat, ball, V-bit) and material presets (pine, MDF, hardwood, ply, acrylic, aluminium).
4. Each operation is a card with a one-line description and a live preview; a "Why?" link explains the setting for beginners.
5. Estimated time, warnings list, simulation scrubber, "Download .nc" and checklist ("Zero X/Y at …, Z at top of stock").

## 7. Phases
| Phase | Deliverable | Rough effort |
|---|---|---|
| 0 | Repo, tooling, cam-core skeleton, GRBL post, 3D viewer, SVG/STL import | 1–2 wks |
| 1 | 2D: profile, pocket, drill, tabs, depth passes, climb/conventional enforcement, simulation view, wizard UI | 4–6 wks |
| 2 | 3D: heightmap relief, Z-level roughing, raster/waterline finishing, material-removal sim | 6–10 wks |
| 3 | Two-sided + dowels, split necks, guitar templates | 4–6 wks |
| 4 | Adaptive clearing, V-carve, rest machining, tool library sharing, polish & docs | ongoing |

## 8. Risks / open questions
- 3D path quality/performance in JS → prototype drop-cutter with BVH early; fall back to OpenCAMLib WASM (LGPL linkage implications for licence choice).
- Gouge-free 3D with non-ball tools and collision with holder.
- Correct machine-specific behaviour (arc support, spindle, homing) → keep post-processors tiny and well tested; validate output with CAMotics or an NC viewer in CI.
- Safety: always show clear disclaimers; test on air-cut first.
- Licence choice (MIT/GPL/AGPL) – decide before pulling in dependencies.

## 9. Decisions needed from you
1. Your machine: type, bed size, controller (GRBL? Mach3?), spindle, 3 vs 4 axis.
2. Tech stack OK (TypeScript/Three.js, client-side only)?
3. Licence and whether OpenCAMLib (LGPL) is acceptable.
4. Priority: ship 2D first (Easel parity) vs. go straight to 3D guitar workflow.
