# Review findings (2026-11-16): outcome

A read-through of the code (by Fable) was checked and actioned by Sonnet the same day. 273 tests, type check and build pass. Nothing here has been run on a real machine.

## Agreed and fixed

- [x] **New since the review:** 3D finishing in both directions (cross pass), lead-in/lead-out on cut-outs, flat-bottom inlay.

- [x] **3D model saved in projects** (and undo steps, and the automatic backup), so opening a project no longer needs the STL loaded again.
- [x] **Repository.** First commit made and pushed to github.com/zz9pa/Camfree.

- [x] **Start depth** for outside/inside/pocket/on-line/drill: holes inside a pocket skip the air. **Hidden-tab simulation** no longer crawls (`nextTurn()` uses a message instead of animation frames when the tab is hidden).

- [x] **Licence.** LGPL-3.0-or-later chosen by the owner: `COPYING.LESSER`, `COPYING`, `NOTICE.md` (also lists third-party licences; none of the dependencies is actually LGPL, all are permissive), `package.json` updated. Earlier text saying "some dependencies are LGPL" was wrong.

- [x] **Climb and conventional were swapped (serious).** Agreed after deriving it independently three ways: (1) relative motion: with a clockwise spindle the tooth at the contact point moves the same way as the work moves relative to the tool when the uncut material is on the RIGHT of travel; (2) cutting force: the tooth pushes the work along its own motion, so the work pushes the tool forward (the grabbing feel of climb) on that side; (3) G41 with M3 (tool left of the contour, material on the right) is the textbook climb. Outside loops now climb CW, pocket/hole walls CCW; the 3D raster climbs right to left with rows stepping +Y. Direction tests rewritten, plus new convention-independent tests (which side of travel is the material). Docs corrected (DEVELOPER, PLAN, USER_GUIDE).
- [x] **Slow re-entry on every pass.** `planEntries()` in `gcode.ts`: later depths rapid down to 1 mm above their start depth when an earlier pass with the same bit cut that exact point. The simulation checks the drops really are through air (the Boden job reports no problems).
- [x] **Time estimate ignored the descent.** Now counted. (The Boden job estimate rose from about 2 h 50 to 3 h 16: the old figure was too low.)
- [x] **Marlin G0 feed.** Every G0 on Marlin now states `F3000` and the next G1 restates its feed. GRBL unchanged. The firmware still clamps each axis to its own maximum (M203), so a slow Z axis is protected.
- [x] **Editing settings changed the last operation.** Nothing is "active" after adding an operation; click one in the list to edit it. Hint shown under the list.
- [x] **3D finishing with no roughing** now warns (also when the roughing comes later in the list).
- [x] **3D operations in two-sided and split jobs.** Refused at first; now built (see DEVELOPER.md "Two-sided 3D"). Back-side passes drawn purple.
- [x] **Stack overflow risk on large arrays.** `minOf` / `maxOf` (`core/util.ts`) replace `Math.min(...bigArray)` in the 3D finishing, shape bounding boxes, two-sided, split, V-carve and inlay code. Test with 400,000 values.
- [x] **"Stock left by roughing" was vertical only.** Now kept all round the bit (bit grown by twice the allowance, then lifted by it).
- [x] **Zero at "part" used the tool-centre path.** Now uses the bounding box of the shapes with operations (plus the 3D model). Labels and guide updated.
- [x] **Unescaped names in HTML.** Layer names, the STL file name and DXF "ignored" entity names are escaped.
- [x] **Simulation viewer leak.** Fresh canvas on every opening, shader program deleted on close.
- [x] **Auto stock and the spoilboard.** The status line now says it cannot show spoilboard contact in automatic mode when a cut reaches the bottom.
- [x] **Drill tolerance / info in warnings.** A hole a hair smaller than the bit now warns it will come out bit-sized. Plain facts about the holes moved out of the warnings list into `Op.info`, shown under the operation. The grouping logic moved into `core/holes.ts` (`planDrill`) with tests.
- [x] **Housekeeping.** `git init` and `.gitignore` done (nothing committed yet). Stale "3D milling is planned" text corrected in DEVELOPER and README. Cosmetic run-together line fixed. `test.svg` moved to `public/samples/simple-shapes.svg`.

## Not done

- [ ] **More UI logic into `core`.** Partly done: drill grouping (`planDrill`), zero/stock placement (`core/place.ts`) and the side-2 model turn (`turnOver`) are in `core` with tests. The rest of `compile()`, `compile3d()` and `placed()` in `src/main.ts` (reading the form, assembling the setups) is still untested.
- [ ] **Not built (features):** rest machining; true steep-wall (constant-Z) contouring in 3D finishing (the cross pass helps but is not the same); helical arcs (G2/G3 with Z); lead-in/out for pockets, on-the-line and V-carve; DXF HATCH import; binary DXF and DWG. None is hidden or stubbed: the app simply does not offer them.

## Still not checked

- Two-sided simulation stock position: checked by reading the code (same translation for both sides, stock symmetric about the flip line); not looked at visually.
- Split jobs with drill or 3D operations: checked only as far as the segment files being produced (2 segments for a 66 mm part on a 60 mm bed); not simulated.
- Simulating an inlay (recess then insert board) treats both boards as one stock, so it is not meaningful for inlay jobs.
- Anything on a real machine. In particular, run an air-cut first: climb/conventional just changed direction, and Marlin G0 output changed.
