# open-cam user guide

open-cam turns a drawing into G-code for your CNC router, right in your web browser. Nothing is uploaded: your drawing and settings stay on your computer.

This guide assumes you have never used a CNC machine before. If you have, skip to [Step by step](#step-by-step).

## Contents

1. [The idea in one minute](#the-idea-in-one-minute)
2. [Words you will meet](#words-you-will-meet)
3. [Before you start: safety](#before-you-start-safety)
4. [Step by step](#step-by-step)
5. [Undo, redo and saving your work](#undo-redo-and-saving-your-work)
6. [Importing drawings (SVG and DXF)](#importing-drawings-svg-and-dxf)
7. [Checking sizes with the Measure tool](#checking-sizes-with-the-measure-tool)
8. [Adding text](#adding-text)
9. [V-carving](#v-carving)
10. [Inlay](#inlay)
11. [3D milling](#3d-milling)
12. [Simulating the job (3D preview)](#simulating-the-job-3d-preview)
13. [Where X/Y zero is](#where-xy-zero-is)
14. [Choosing what to cut](#choosing-what-to-cut)
15. [Bits](#bits)
16. [Settings explained](#settings-explained)
17. [Running your job](#running-your-job)
18. [Smaller, smoother files with arcs](#smaller-smoother-files-with-arcs)
19. [Cutting both sides (turning the stock over)](#cutting-both-sides-turning-the-stock-over)
20. [Dowel holes and how deep they are](#dowel-holes-and-how-deep-they-are)
21. [Parts longer than your machine (splitting)](#parts-longer-than-your-machine-splitting)
22. [Warnings and what to do about them](#warnings-and-what-to-do-about-them)
23. [Troubleshooting](#troubleshooting)
24. [Limits](#limits)

Tip: inside the app, the **?** buttons next to each section open the matching part of this guide in a side panel, and hovering over a field shows a short hint.

## The idea in one minute

1. You open a drawing (an SVG file).
2. You click the lines you want to cut and say what to do with each: cut around it, cut inside it, follow the line, or clear out the inside.
3. You say what bit you have and how deep to cut.
4. open-cam draws the path the bit will take. You check it.
5. You download a G-code file and run it on your machine.

open-cam also checks your choices and warns you about things that commonly go wrong (cutting deeper than the bit can reach, a part that does not fit your machine, and so on).

## Words you will meet

| Word | Meaning |
|---|---|
| **Stock** | The piece of material you are cutting (a board, a block). |
| **Spoilboard** | The sacrificial board under your stock. Cutting all the way through the stock touches it, so it gets marked up. That is its job. |
| **Work area** | How far your machine can move in X (left-right) and Y (front-back). |
| **Zero** | The point the machine treats as 0. Here: X and Y zero are at a corner, and Z zero is on the **top surface** of the material. |
| **Bit** | The cutter in the spindle. |
| **Flat end mill** | A bit with a flat bottom. The normal choice for cutting out shapes and clearing pockets. |
| **Ball nose** | A bit with a rounded tip. |
| **V-bit** | A pointed bit, used for engraving and chamfers. |
| **Flute length / cutting length** | How much of the bit actually has cutting edges. Cutting deeper than this rubs the bare shank and burns. |
| **Depth** | How far down to cut. |
| **Starts at depth** | Where cutting begins, measured down from the top of the material (0 = the top). See *Starting part way down* below. |
| **Stepdown** | How much the bit goes down on each pass. A deep cut is made in several passes. |
| **Climb / conventional** | Which way round the bit travels. See [Cut direction](#cut-direction). |
| **Tab** | A small bridge of material left so a cut-out piece does not move or fly when it is cut free. |
| **Ramp** | Going down gradually along the path instead of plunging straight down. |
| **Dowel** | A small round pin used to line things up. |
| **Registration** | Getting something back in exactly the same place (after turning it over, or sliding it along). |

## Before you start: safety

A CNC machine is powerful and does exactly what the file says, including the wrong thing. Please:

- **Always do an air-cut first.** Run the file with the spindle off and the bit raised well above the material (or with no material). Watch the whole path. Check it goes where you expect and stays inside the material.
- **Hold the stock down firmly.** Clamps, screws into waste areas, or double-sided tape for small parts. Plan where the clamps are so the bit never goes near them.
- **Wear eye and ear protection** and keep hands, hair and loose sleeves away. Know where your emergency stop is.
- **Never leave a running machine unattended.**
- Set Z zero carefully. If it is wrong, the bit will cut too deep or air-cut.
- Start with gentle settings (the defaults are conservative) and make them faster only after a good first result.

open-cam helps, but you are responsible for what you run.

## Step by step

The left panel runs top to bottom. The big area on the right is the preview.

### 1. Your drawing

Click **Choose file** and pick an SVG or DXF. open-cam tells you the size of the drawing straight away (in millimetres and inches), plus anything it had to ignore or tidy up. **Check that size is what you expect**: see [Importing drawings](#importing-drawings-svg-and-dxf) and [Measure](#checking-sizes-with-the-measure-tool).

If your drawing has **layers**, they appear as a list. Untick a layer to hide it. Click a layer's **Select** button to select everything on it (click again to un-select). With many layers, use **Hide all**, then tick just the layers you want, and **Select all shown** to select everything that is showing. **Show all** brings every layer back. Use **Clear selection** to select nothing.

In the preview:

- **Click** a line to select or un-select it.
- **Shift + drag** draws a box and selects every shape fully inside it.
- **Drag** to move the view; use the **mouse wheel** to zoom. **Fit view** shows everything.

Selected lines are orange.

### 2. Machine and material

- **Controller firmware**: *Marlin* or *GRBL*. This changes how the file pauses and ends. If you are not sure, Marlin is common on gantry-style hobby machines and GRBL on many small desktop machines.
- **Work area X / Y**: how far your machine can travel. open-cam warns if the job does not fit.
- **Material**: a starting point for speeds and depth per pass. The defaults are cautious.

The file pauses at the start so you can switch your spindle on yourself (many routers have no computer control of the spindle). It pauses again at bit changes so you can swap the bit and set Z zero again.

### 3. Operations

An *operation* is one instruction such as "cut around these shapes with this bit to this depth". You can add as many as you like.

1. Select some lines (see above).
2. Choose **What to do with the selection**, the bit, the depth and the other settings.
3. Click **Add operation from selection**. The operation appears in the list below. To change its settings, move it with the arrow buttons, or delete it, click it in the list first (new operations are not left selected, so changing the form for your next operation never alters the one you just added).

The operation appears in the list and its path appears in the preview (blue). Click an operation in the list to select it and edit its settings; changes apply straight away. **Delete** removes it.

### 4. Check, then download

Read any warnings (red text under the operations). Under them, open-cam shows an **estimated run time** (a guide only: real jobs run a little longer because of acceleration). When you are happy, click **Download G-code**.

## Undo, redo and saving your work

**Undo and redo.** The **Undo** and **Redo** buttons at the top of the left panel step back and forward through your changes: adding or deleting an operation, changing an operation's settings, adding text, joining or closing lines, changing import settings, and so on. The keyboard shortcuts are **Ctrl+Z** (undo) and **Ctrl+Y** or **Ctrl+Shift+Z** (redo); on a Mac use Cmd. A burst of typing in a settings box counts as one step. While your cursor is inside a text box, Ctrl+Z undoes the typing in that box as usual. Selecting shapes, zooming and measuring are not undo steps. The last 100 steps are kept.

**Save project / Open project.** **Save project** (or Ctrl+S) downloads one file with everything: the drawing, your operations, and every setting. **Open project** loads it back exactly as you left it, so you can carry on another day or on another computer. If you opened a file with import settings (units and so on), those can still be changed later because the original file is kept inside the project.

- Project files are plain text (extension `.opencam.json`) and can be large if your drawing has a lot of detail.
- A project saved by a newer version of open-cam may not open in an older one: you are told if so.
- G-code is *not* stored: it is re-made from your operations whenever you download it.

**Automatic backup.** open-cam also keeps a backup of your current work in your browser every few seconds. If you close the tab by accident or the browser crashes, the next time you open open-cam a bar offers to **Restore it** or **Start fresh**. The backup is paused until you choose, so look out for that bar. The backup stays on your computer, inside the browser, and is not uploaded anywhere. It is a safety net, not a filing system: use **Save project** for work you want to keep.

## Importing drawings (SVG and DXF)

### What is read

- **SVG**: paths, rectangles, circles, ellipses, lines, polygons and polylines, with their transforms. Copies made with *clone/use* are included. Layers are kept (drawing-program layers become open-cam layers). Hidden items are skipped.
- **DXF** (ASCII and binary): lines, polylines (including rounded corners), circles, arcs, ellipses, splines and block inserts (with scale, rotation and arrays), on their layers. Curves are turned into short straight segments accurate to 0.01 mm. Hidden or frozen layers are skipped.
- **Text** (SVG text, DXF TEXT and MTEXT) is turned into outlines with our built-in fonts (see [Adding text](#adding-text)).
- **Hatches** (filled areas in a DXF): their outlines are read as closed shapes, unless the same outline is already drawn as a line. A hatch pattern itself is not a cutting path. Hatches bounded by splines cannot be read, and open-cam says so.
- **Not read**: images, dimensions and 3D objects. open-cam tells you how many it ignored.

### Units and size

The file's units are used when it states them (for SVG: the size and view box; for DXF: its unit setting). If it does not, open-cam says so and assumes millimetres (DXF) or 96 pixels per inch (SVG). Older DXF files (the R12 format, for instance) often do not state units at all, so a drawing made in inches can appear 25 times too small: if the size shown looks tiny, set **Units in the file** to inches. **Always check the drawing size shown under the file name.** If it is wrong:

1. Open **Import settings**.
2. Choose the right **Units in the file** (millimetres, inches, centimetres or pixels), or set a **Scale (%)**.

Changing import settings re-reads the file and clears your operations (the lines are renumbered).

### Joining pieces into outlines

Many drawing programs break one outline into several separate pieces. A piece has to be a complete closed loop before open-cam can cut around it, so open-cam automatically:

- **Joins** pieces whose ends are within **Join gaps up to** (0.05 mm by default). Pieces on different layers are never joined.
- **Closes** a line whose ends meet. A single line whose own two ends are *nearly* meeting (up to **Close nearly-closed outlines up to**, 2 mm by default) is also closed with a short straight line, but only if the gap is tiny compared with the length of the line (at most 2%), so a short open line is never closed by accident. open-cam tells you the largest gap it closed.
- **Continues straight through** where a line simply ends on an outline, so the outline still joins up and the line stays separate.
- **Leaves alone** points where three or more lines meet with no clear straight continuation (it tells you how many).
- **Removes duplicates**: the same line drawn twice on top of itself (switch off with *Remove duplicate lines*).

You will see a summary such as "Joined 598 separate pieces into longer lines, making 41 closed outlines".

### Fixing an outline that is still open

If an outline will not cut because it is open, there is a real gap in the drawing. Select the open line (it shows as *open* in the layer list), then:

- **Close selected**: draws a straight line from the end back to the start. The message tells you how long that closing line is, so you can check it is sensible.
- **Join selected**: joins several selected open lines end to end, bridging gaps up to **"Join selected" gaps up to (mm)** in Import settings.
- **Run open line out to outline**: for a shape that is meant to open out through the edge of a part (for example a recess that runs out to the end of a board). Select the open line **and** the closed outline it should run out through, then press the button. Each end carries straight on in the direction it was heading until it crosses the outline, follows the outline between the two points, so the shape is closed exactly on that edge (and follows any curve in it). The shape stays exact in the drawing; when you **Pocket** it, the operation lets the bit run out past that edge by its own radius, so no thin strip is left behind. If an end never reaches the outline, you get a message instead.

Fixing the drawing in your drawing program is always the best answer if the gap is large.

## Checking sizes with the Measure tool

Use **Measure** (or press **M**) to confirm the drawing came in at the right size. Click two points; open-cam shows the distance in **millimetres, inches and pixels** (pixels at 96 per inch, which is what an SVG file uses), with the horizontal and vertical parts too.

- Points **snap to line corners and ends** when you click near one.
- Measure something whose real size you know, such as the overall length of the part. If it is off by a fixed factor (25.4, for example), change the units in Import settings.
- **Clear measurements** removes them. **Esc** cancels a half-made measurement, and pressing it again leaves Measure.

The panel also shows the **size of your current selection**, which is a quick way to check one shape.

## Adding text

Open **Add text**, type your words, pick a font, set the **letter height** (the height of capital letters, in mm) and click **Add text to drawing**. The text becomes ordinary lines on its own layer, so you can use it like any other shape: cut around it, pocket it, or follow its lines. Letters with holes (such as O, B or 8) are handled correctly: a pocket leaves the holes uncut.

- **Fonts** are built in (sans-serif, bold, narrow bold, slab serif, monospace and a script font), so they work offline.
- **Letter spacing** and **line spacing** adjust the layout. **Align** lines up multi-line text left, centre or right.
- **X / Y** set where the text starts (left end of the first line, on the baseline). Leave them empty to put the text in the middle of the view.
- Text in a file you import (SVG text, DXF TEXT and MTEXT) is turned into outlines the same way. The position, size, rotation and alignment are kept, but the **letter shapes come from our fonts, not yours**, so they may differ from the font used in your file. Check them before cutting. For exact lettering, convert your text to outlines (curves) in your drawing program first.
- Cutting text deeply with a wide bit rounds off fine detail. Use a bit narrower than the thinnest stroke, or [V-carve](#v-carving) it with a V-bit.

## V-carving

V-carving cuts lettering and artwork with a **V-shaped bit**. The bit runs along the **middle of every stroke** and goes **deeper where the stroke is wider**, so the sloping sides of the groove meet the outline exactly. Thin parts are shallow and wide parts are deep, which gives crisp, sharp-cornered lettering that a flat bit cannot.

**To V-carve:**

1. Select the shapes (text is ideal) and choose **V-carve** under *What to do with the selection*. open-cam switches to a typical 60&deg; V-bit and a shallow depth for you; change them to match your bit.
2. Set **Depth**, which here means the *deepest the tip will go*. Thin strokes are shallower automatically.
3. Choose what to do with areas that are too wide for the V to reach (below), then click **Add operation from selection**.

**How deep will it go?** For a stroke of half-width *w*, the tip must go down *w / tan(half the V angle)*. A 90&deg; V goes as deep as the half-width; a **60&deg; V goes about 1.7 times deeper** for the same stroke; a wider angle is shallower and quicker. A **flat tip** on the bit (the *Tip* setting) means the narrowest strokes are only touched on the surface.

**Wide areas.** If a shape is wider than the V can reach at your maximum depth (or wider than the bit itself), choose:

- **Clear it flat at the maximum depth**: the rest of the area is cleared with the same bit at the maximum depth. This is slower and leaves a slightly ridged floor, not a clean V.
- **Leave it**: only what the V reaches is carved, and wide areas are left with an uncut centre.
- **Clear it with a flat bit first** (cleanest): a flat end mill clears the wide floor flat to the full depth, then the program **pauses for you to change to the V-bit**, which cuts the sloping sides and the thinner strokes. Enter the flat bit's diameter. The floor is truly flat, with none of the faint ridges a V-bit leaves, and it is quicker for big areas.
  - If the flat bit is too wide to reach part of the floor (a narrow stroke, or a tight corner), the **V-bit clears that part itself**, so nothing is ever left uncut. open-cam tells you what share the flat bit manages. A smaller flat bit leaves less for the V-bit. On narrow lettering the saving is modest; on large wide shapes it is large.

open-cam tells you how deep the widest strokes would like to go, so you can choose a deeper maximum, a wider-angle bit, or smaller lettering for a clean V everywhere. It also warns if the bit itself is too narrow to carve that deep: a V-bit can never cut wider than its own diameter.

**Good to know**

- Carving is done in several passes if the depth is more than your material's *depth per pass*. Each pass follows the same lines a little deeper.
- Each line of the toolpath starts at its shallowest end (the sharp tips of letters) and sinks as it goes, so there is little straight plunging.
- A sharp-pointed V-bit gives the crispest result: a wide flat tip rounds off the corners and leaves thin strokes uncut.
- Try it on scrap first. V-carving is sensitive to how accurately your Z zero is set: 0.1 mm error changes the width of every groove.

## Inlay

An **inlay** is a recess cut in one board with a matching insert cut from another, which you glue in so the two sit flush: lettering or a pattern in a contrasting wood, for example. open-cam makes both parts from one selection, using a V-bit, so they **fit together without measuring**.

**How it fits.** The recess has sloping sides and a flat floor. The insert is cut as its exact opposite: its sides slope the same way, so it wedges into the recess. The insert is cut a little deeper than the recess (the **glue gap**), so it stands slightly proud when pressed home. You sand it flush after gluing, and the gap leaves room for the glue.

**To make an inlay**

1. Select the shapes (text works well) and choose **Inlay** under *What to do with the selection*. open-cam switches to a 60&deg; V-bit and a shallow depth for you.
2. Set **Depth**: the depth of the recess. Set the **glue gap** (0.3 mm is a good start) and the **background width** (how much flat background is cut around the lettering on the insert board; 2.5 mm is plenty).
3. Click **Add operation from selection**. The operation appears in the list below. To change its settings, move it with the arrow buttons, or delete it, click it in the list first (new operations are not left selected, so changing the form for your next operation never alters the one you just added). The outline of the insert blank is added to your drawing as a selected shape.
4. Add a normal **cut-out** operation (outside the line, with a **flat** bit) on that blank outline to cut the insert board free after carving.
5. Download the G-code and run it:
   - **First the recess** is cut in the first board.
   - The program then **pauses with a message to swap the board**. Put the second board for the insert on the machine in **the same position**, face up, set Z zero on its top surface, and resume.
   - **Then the insert** is carved. It is **mirrored on purpose**, so the lettering reads correctly once you flip the finished insert over to glue it in.
   - The cut-out follows, and needs a bit change (the program pauses for that too).
6. Glue the insert into the recess, **face down** (the carved side goes in), clamp, and let the glue dry. Then sand or plane the back off until the insert is flush with the surface.

**How deep?** Thin strokes limit what is possible: the insert's top is smaller than the recess's opening by twice *depth &times; tan(half the V angle)*, so a stroke thinner than that cannot be inlaid and open-cam warns you. For a 60&deg; bit at 3 mm deep that is about 3.5 mm; a 90&deg; bit at 3 mm is about 6 mm. Use a shallower recess or bolder lettering for thin shapes.

**Good to know**

- The recess floor is cleared with the V-bit, so it is very slightly ridged (up to about 0.15 mm). The glue gap covers this.
- The background of the insert board is cleared more coarsely, because it is sanded away anyway.
- Use the same V-bit for the recess and the insert, and set Z zero carefully on both boards: any error changes how tightly the insert fits.
- Practise on scrap: wedge-fit inlays are sensitive to bit angle, so check your bit really is the angle printed on it.

### Flat-bottom inlay

Choose **Inlay, flat bottom** for a recess with a flat floor and straight walls, cut with an ordinary flat bit. The program pockets the recess to the depth you set, **pauses so you can swap in the insert board**, then cuts the same shape out of it (face up, not mirrored). The insert comes out 0.1 mm smaller all round so it goes in without force. The insert board must be as thick as the recess depth plus **Insert proud by**, so the insert stands that far above the surface and can be sanded flush. Three small tabs keep the insert in its board: cut them with a knife.

A round bit cannot make a sharp inside corner in a pocket or a sharp outside corner on a cut-out, so both pieces are cut with every corner rounded to the bit radius. They match each other, but the design loses sharp corners. A smaller bit rounds less. Detail narrower than the bit is lost, and the program tells you how much.

## 3D milling

Open the **3D model (STL)** panel and load an STL file. The program carves the **top surface** of the model: a flat bit removes the bulk of the material (roughing), then a ball nose bit follows the surface to leave a smooth finish. Anything hidden under an overhang cannot be reached from above, so it is ignored.

1. **Load the file.** The panel shows the size it found. If the size looks wrong, change **Model units** (inches or centimetres) or **Top of model** (which side of the model faces up).
2. **Choose the bit** in the Bit section (a flat end mill for roughing, a ball nose for finishing), then press **Add 3D roughing**. Change the bit and press **Add 3D finishing**.
3. **Top is below stock top** is for when the highest point of the model should sit below the surface of the stock. The program measures every depth from the stock top.
4. **Stock left by roughing** is the thin layer the roughing pass leaves for the finishing pass to remove.
5. **Step-over** is how far apart the passes are, as a percentage of the bit diameter. Smaller finishing step-overs give a smoother surface and a longer run.
6. **Back-and-forth passes** make the job faster by joining passes, but every second pass then cuts in the other direction. Leave it off to keep every pass in the direction you chose under Cut direction.
7. **Finish in both directions** adds a second set of finishing passes that run across the first. A single set of passes leaves steep walls that run along them rougher than the rest; the crossing set cuts those cleanly. It doubles the finishing time.
8. **Rest roughing** (diameter of an earlier bigger bit): rough the whole model first with a big bit, then add roughing again with a smaller bit and enter the big bit's diameter here. The smaller bit only cuts where the big one could not reach: tight corners and narrow slots. Use the same stock-left setting for both.
9. **Steep walls as contour lines** (angle): where the surface is steeper than this angle, the finishing raster stops and the bit follows level contour lines instead, which leaves a much smoother steep wall. Contours are spaced by the finishing step-over in height. Leave at 0 for no contours; 40 to 50 degrees is typical.
10. **Add the model's outline to the drawing** puts the outline of the model in the drawing, so you can add an ordinary cut-out around it.

The warnings list tells you when part of the surface is too fine for the chosen bit (tight inside curves and narrow grooves). A smaller bit cuts closer there.

**Carving both sides.** In a two-sided job (see *Turning the stock over*), set a 3D operation to **Side 2** and it carves the underside of the same model: the stock and the model are turned over together, so what was the bottom of the model becomes the surface you cut. Set the stock thickness in the two-sided settings; if the model is thinner than the stock, side 2 first removes the extra material above the model's underside. Leave the model attached to the stock (for example with tabs on the outline cut) until both sides are done, so it cannot move. The model must be a closed solid (a model that is only a surface has no underside to carve). 3D operations also work in split jobs: each segment carves its own part of the model.

The model is saved inside the project file (and in the automatic backup), so opening a project brings the model back with its operations. A big model makes a big project file: about 50 bytes per triangle.

Finishing with a flat bit leaves small steps on sloped surfaces: use a ball nose. Roughing leaves stair-steps up to one step-down high, which the finishing pass removes.
### Starting part way down

Normally an operation starts at the top of the material. If it sits inside something that has already been cut away, that wastes time cutting air. For example, bolt holes in the floor of a 15 mm pocket: set the holes' **Starts at depth** to 15 and **Depth** to the full thickness. The bit rapids down through the empty pocket to just above the floor, then cuts from there. Place the pocket before the holes in the operation list. **Depth** is always measured from the top of the material. Check it with the simulation: if the bit would rapid into material that is still there, it reports a crash. This setting is not offered for V-carve, inlay or 3D operations.

## Simulating the job (3D preview)

Press **Simulate the job (3D preview)** under the operation list to watch the material being cut away before you cut anything for real. It runs the same moves the G-code will make, on a block of stock, and shows the result in 3D.

- **Look around:** drag to rotate, right-drag (or Shift+drag) to move, scroll to zoom. **Top**, **3D** and **Side** jump to standard views. **Depth exaggeration** makes shallow cuts easier to see.
- **Colours:** light wood is uncut top surface, darker is deeper, and grey means the bit cut right through the stock.
- **Stock:** by default the stock is worked out for you: just big enough for all the cuts, with a 5 mm margin, as thick as the deepest cut. Choose **My own size** to enter the real width, height and thickness of your board. For a two-sided job the stock size from the two-sided settings is used.
- **Several runs:** two-sided and split jobs have a separate simulation for each side or segment, chosen under **Show**, because each starts from fresh stock.

The simulation also checks for problems and lists them above the picture: fast moves that dive into uncut material (which could snap a bit), and cutting below the bottom of the stock (into your spoilboard) or outside the stock.

The simulation shows what a router cutting from above can make. It is a guide, not a promise: it does not model the bit bending, chips, or the machine's own movement.

## Where X/Y zero is

Under the machine settings, **Where X/Y zero is on the machine** chooses where the program's X0 Y0 is:

- **Corner of the work area** (default): zero at the bottom-left of your work area, with the part placed 5 mm in. The program checks that everything stays inside your work area.
- **Lower-left corner of the part** or **Centre of the part**: zero at that point of the shapes you are cutting (the edge of the part itself, not the path the bit takes round it). Set X/Y zero on the machine to match before you run. The program cannot check the machine's limits in these modes, so make sure the job fits the travel from where you set zero.

Two-sided and split jobs always use the corner.

## Choosing what to cut

| Choice | What it does | Use it for |
|---|---|---|
| **Cut out - outside the line** | The bit travels just outside the line, so the shape you drew is kept. Holes inside the shape are cut on their inside. | Cutting a part out of a board. |
| **Cut out - inside the line** | The bit travels just inside the line, so the area inside is removed. | Cutting a hole or opening. |
| **Cut on the line** | The centre of the bit follows the line exactly. Works on open lines too. | Engraving, slots, cutting a groove. |
| **Drill holes** | Select round shapes (circles) and the bit goes to each centre. A bit the same size as the hole plunges straight down in short pecks; a smaller bit spirals the hole out. Holes smaller than the bit are skipped with a warning, and shapes that are not round are ignored. | Screw holes, pegs, round holes. |
| **Pocket** | Clears away everything inside the shape, ring by ring. Optional [dogbone corners](#settings-explained). | Recesses, cavities. |
| **V-carve** | A V-bit follows the middle of each stroke, deeper where it is wider. See [V-carving](#v-carving). | Lettering and artwork with crisp sloping sides. |
| **Inlay** | A V-carved recess plus a matching mirrored insert for a second board. See [Inlay](#inlay). | Lettering or patterns in a contrasting wood. |

Notes:

- Only **closed** shapes (the line meets itself) can be cut outside/inside or pocketed. **Open** lines can only be cut on the line. open-cam tells you if it skipped any.
- If shapes sit inside other shapes (like a hole inside an outline), they are treated as holes.
- If a shape is smaller than your bit, there is nothing to cut and you will be warned.
- A recess with a deeper area inside it needs two operations: one for the shallow outline, one for the deeper inner shape, each with its own depth.

### Cut direction

- **Climb** (recommended): cleaner edges. The cutting edge moves with the work, so each chip starts thick and ends thin. It pulls the bit forward a little, so it suits a reasonably rigid machine.
- **Conventional**: the opposite. It pushes the bit sideways more, which can be kinder to a light machine and is sometimes better on very rough surfaces.

open-cam works out the correct travel direction around every outline, hole and island for the choice you make, assuming your spindle turns clockwise (viewed from above), which is the normal case.

**One file, several operations.** Every operation in the list goes into the same G-code file, in list order. The program only pauses for a bit change when the next operation uses a different bit. Use the up and down arrow buttons next to Delete to change the order of the selected operation (for example drill the holes first, cut the outside last so the part is still held by its tabs).

## Bits

- **Common bits**: pick one from the list (for example 6 mm flat or 60&deg; V-bit) to fill in the type, diameter and cutting length for you, then adjust if yours differ.
- **Bit type**: flat end mill, ball nose or V-bit.
- **Diameter**: the cutting width.
- **Cutting length**: the length of the cutting flutes (see the table above). Cuts deeper than this are flagged.
- **V-bit**: also enter the **angle** and the **tip** (flat tip) width. The width of a V-bit's cut changes with depth, so open-cam adjusts the path at every depth. V-bits are for engraving and chamfers; they are slow and rough for cutting out, so you will get a warning.

## Settings explained

- **Starts at depth**: leave at 0 normally. See *Starting part way down* below.
- **Depth**: total depth from the top surface. To cut right through a board, use the board's thickness. A fraction of a millimetre more makes sure it cuts all the way through (it will mark your spoilboard).
- **Ramp into the cut**: enter the material gradually. Recommended, and gentler on the bit and machine.
- **Speed when going down**: a straight plunge uses the slower *plunge* speed. A gentle ramp (under about 6&deg;) is really a cutting move, so it runs at the normal cutting speed, and in between the speed blends. Steeper moves are slower.
- **Lead-in and lead-out** (cut-outs only): the bit arrives at the edge along a curve and leaves along another, both bending away from the finished edge into the waste. Plunging straight onto the edge, or stopping on it, can leave a small mark; this avoids it. The first depth uses the curve to go down gradually, the last depth leaves along it, and depths in between follow the cut already made. Where there is no room for the curve (a small hole, a narrow gap) it is made smaller, or left out.
- **Holding tabs** (cut-outs only): leave small bridges so the part stays attached.
  - *Tabs*: how many, evenly spaced.
  - *Width*: how wide each bridge is.
  - *Height*: how tall the bridge is, measured up from the bottom of the cut. Cut the tabs away afterwards with a knife or saw.
  - Very small shapes get fewer tabs, or none.
- **Dogbone corners** (pockets and inside cut-outs, flat end mills): a round bit cannot cut a sharp *inside* corner, so it leaves a rounded one. If a square-cornered part has to fit into that opening (a joint, a slot, a tab and slot), the corners stop it. Tick **Dogbone corners** and the bit makes a small extra move into each inside corner, so its edge just reaches the corner and the square part fits. The notch looks like a small round bite in the corner, which is hidden once the part is in.
  - Only real corners are relieved: curves, and corners of islands that stand up inside a pocket, are left alone.
  - Very shallow corners (almost straight) and very sharp points are skipped.
  - It adds a little cutting time, only on the pass that runs along the wall.

### Materials and your own cutting speeds

**Material** picks cautious starting values for cutting speed, plunge speed and depth per pass. **Rigid foam** (the pink or blue insulation board sold as XPS) is included: it cuts with very little force, so it uses a much faster feed and deeper passes. Fast cutting matters in foam, because a slow feed rubs and melts it instead of cutting. White bead foam (EPS) tears and is not recommended.

### Own cutting speeds for other materials

For a material that is not listed, open **Advanced: my own speeds** under Machine and material and tick **Use my own values**. The three boxes start with the chosen material's numbers; change them:

- **Cutting speed** (mm/min): how fast the bit moves while cutting.
- **Plunge speed** (mm/min): how fast it moves down into the material. Normally slower than cutting speed.
- **Depth per pass** (mm): how deep each pass goes. A deep cut is made in several passes of this depth.

Your values apply to every operation. open-cam warns about risky combinations (plunging faster than cutting, passes more than twice the bit diameter, cutting speed beyond what most hobby machines can follow). Start gently and speed up only after a good test cut.

## Running your job

1. Fix the stock to the machine.
2. Set **X and Y zero** at the corner you chose. open-cam puts your part a few millimetres in from the corner (and tells you the size it needs).
3. Set **Z zero** on the top surface of the stock.
4. Do an air-cut.
5. Start the file. When it pauses, switch your spindle on, then resume.
6. When it finishes it stops at a safe height. Switch the spindle off.

## Smaller, smoother files with arcs

Normally open-cam writes curves as many very short straight moves, which is understood by every controller but makes big files. With **Arcs (G2/G3)** switched on, runs of moves that follow a circle are written as single arc commands instead. The result is a smaller file and smoother motion, and every point stays within 0.01 mm of the original path. Arcs follow your cut direction: climb or conventional is kept, and the right arc command (G2 clockwise, G3 counter-clockwise) is used automatically.

**Does my machine support arcs?**

- **GRBL** always does. Arcs start switched on when you choose GRBL.
- **Marlin** only does if it was built with arc support (`ARC_SUPPORT` in the firmware's configuration). Many builds have it, but not all, so arcs start **off** for Marlin.

**Check first with the arc test file** (Machine settings, *Download arc test file*). It is an air cut that never goes lower than 10 mm above your Z zero, with the spindle off. The machine should draw one full circle, then four quarter-arcs the other way. If it stops, reports an error, or moves in straight lines, your firmware has no arc support: leave arcs off.

Things to know:

- A gradual descent round a curve (a ramp) is written as a spiral arc, with a Z word in the G2/G3 line. GRBL and Marlin (with arc support) both do this. If a ramped entry ever behaves oddly on your machine, switch arcs off: the straight-line version always works. Straight moves stay as straight lines.
- If your machine stutters or draws arcs badly, switch arcs off: the straight-line version always works.

## Cutting both sides (turning the stock over)

Tick **Cut both sides, turning the stock over** to cut features on the back as well as the front. The problem to solve: after you turn the stock over, the machine must know *exactly* where it is. open-cam solves this with **dowels**: small pins that sit in holes, so the stock can only go back one way.

### Setting it up

1. **How do you turn the stock over?** Top to bottom (like turning a page upward) or left to right (like turning a page sideways). open-cam shows a line on the preview, the *turn-over line*, that the stock pivots around.
2. **Tell open-cam which outline is the front and which is the back.** Select the front outline shape and click **Selected = FRONT outline**. Select the matching outline in the back drawing and click **Selected = BACK outline**. open-cam compares them and sets the turn-over direction and mirroring for you, and tells you what it found.
3. **Back-side drawing is...** *Already mirrored* means the back drawing is exactly what you would see from above after turning the stock over. *Not mirrored* means it is drawn like the front, and open-cam should mirror it for you.
4. Set the stock size, thickness, and the dowel settings (see the next section).
5. For each operation, choose **Side 1 (front)** or **Side 2 (back)**. For side 2 you also say how those shapes were drawn:
   - *On the front view (see-through)*: you drew the back features on top of the front drawing, as if the part were transparent. open-cam flips them for you.
   - *In a separate back drawing*: they are in a separate drawing that is lined up using the two outlines.
   open-cam guesses this from where your selection sits; change it if it guessed wrong.

### Your files

- **Side 1**: drills the dowel holes first, then cuts the front.
- **Side 2**: for after the turn-over.
- Optionally, **step 0** (see "Spoilboard first" below).

Each file starts with plain-English instructions in its comments (lines starting with `;`).

### Dowels that only fit one way

With **3 keyed** dowels (the default), there is one dowel at one end of the turn-over line and a pair at the other. After turning the stock over, the dowels still line up, but the stock **cannot** be put on rotated, or turned over the wrong way, even if you slide it about. With 2 or 4 dowels the layout is symmetrical, so those mistakes can still seat; open-cam warns you if you choose them.

One mistake no hole pattern can detect: putting the stock back **without** turning it over. **Mark the top face of the stock** (a pencil cross) before side 1.

### Stock size and placement

open-cam works out the smallest stock that holds your part and the dowels, with the part centred on the turn-over line, and fills in the stock size for you. Zero X and Y at the stock's bottom-left corner, and Z on its top surface. For side 2, set Z zero on the new top surface.

## Dowel holes and how deep they are

You tell open-cam the **dowel length**, **dowel diameter**, **stock thickness**, **spoilboard thickness**, your **drill bit**, and the **bit's cutting length**. It works out the hole depths. You never type a depth.

How it thinks: a dowel stands partly in the spoilboard and partly in the stock. It aims for about half and half, makes sure enough of the dowel is in each side to hold, and keeps the top of the dowel at least 3 mm below the top of the stock so your spindle can never hit it. It adds a millimetre of clearance at the bottom of each hole for dust.

A green box under the settings shows the answer in words. If something cannot work (a dowel too long or too short, a spoilboard too thin, a hole deeper than your bit can cut), you get a warning and, where a hole would be too deep, it is limited to what the bit can do. **Read those warnings: a limited hole will not hold a dowel.**

**Max hole depth** is the deepest your setup can really drill (bit length, or how much your Z axis can lift). Leave it empty to use the bit's cutting length.

### Three ways to drill the holes

| Mode | When to use it |
|---|---|
| **Through the stock and into the spoilboard** | Thin or medium stock, where one drilling pass is within your bit's reach. |
| **Spoilboard first, then shallow holes in the stock** | **Thick stock.** Every hole is shallow, so an ordinary bit can do it. |
| **Half the dowel in this piece** | Joining two pieces together with dowels. |

### Spoilboard first (for thick stock)

You get an extra file, **step 0**, and the order becomes:

1. **Step 0 (no stock on the machine).** Drills the dowel holes in the empty spoilboard. Z zero is the **top of the spoilboard**.
2. **Side 1.** Put the stock roughly in place against stops. Drills shallow blind holes in the top of the stock, then cuts the front. (The stock's exact position does not matter; both the holes and the cuts are made in the machine's own coordinates.)
3. Lift the stock off. **Push a dowel into each spoilboard hole.**
4. Turn the stock over and lower it onto the dowels.
5. **Side 2.**

## Parts longer than your machine (splitting)

If your part is longer than your work area, tick **My part is longer than the work area: cut it in segments**. open-cam divides the job into windows along X that each fit your machine, and slides the stock between them.

How it keeps everything lined up:

- Each segment overlaps the next by the **Overlap** you choose (40 mm by default). The overlap is cut twice, so a small alignment error leaves no step.
- Between segments the stock is slid along a fixed distance and located on **dowels** in the overlap. These use the same keyed layout, so the stock cannot be put on the wrong way round.
- You can combine splitting with turning the stock over. The pins are then mirrored about the turn-over line so one set of dowels registers both the slide and the flip.

You get one file per step, in order:

1. **Step 0 (no stock).** Drills the dowel holes in the spoilboard.
2. **Segment 1.** Place the stock against your stops. It drills holes right **through** the stock where the next segment will register, then cuts its part.
3. Lift the stock. Push dowels into the spoilboard holes at the left end. Slide the stock along so its holes drop onto them.
4. **Segment 2**, and so on. (If you also turn the stock over, there is a set of side 2 segments, and each file tells you where the dowels go.)

open-cam shows the windows on the preview (dashed vertical lines) and the pins (green circles), and tells you how many segments there are and the stock size you need. Splitting works with a top-to-bottom turn-over. The registration holes go right through the stock, so you need a bit with enough cutting length (or thinner stock); open-cam warns you if not.

## Warnings and what to do about them

| Warning | What it means |
|---|---|
| *Depth is more than 1 mm past the material thickness* | You would cut well into the spoilboard. Check the depth. |
| *This cut is N mm deep but the bit only cuts M mm* | The bare shank would rub and burn. Use a longer bit, or cut from both sides. |
| *Nothing to cut - is the bit too big for this shape?* | The shape is smaller than the bit. |
| *N open line(s) skipped* | Open lines can only be cut "on the line". |
| *Toolpath is bigger than your work area* | Your part will not fit. Make it smaller, or split it (above). |
| *Part extends below zero* | The path would go outside the machine's zero corner. |
| *Tab height is as tall as the cut* | No tabs would be left. Lower the tab height. |
| *V-bits are meant for engraving...* | A V-bit is a poor choice for cutting out. Use a flat end mill. |
| *...could also be seated turned over the wrong way...* | Your dowel layout is symmetrical. Choose "3 keyed". |
| *The holes need to be N mm deep but your bit can only cut M mm* | The dowel holes would be cut short and not hold. Use a longer bit, a shorter dowel, thinner stock, or "Spoilboard first". |
| *Dowel too long / too short* | Pick a dowel that fits your stock and spoilboard (the message says how long it can be). |
| *Stock is too small for part plus dowels* | Use at least the size open-cam suggests. |

## Troubleshooting

- **Nothing happens when I select lines and click Add.** Make sure something is selected (the panel says how many). Open lines cannot be cut outside/inside/pocketed.
- **My outline will not cut around ("open line skipped").** The outline has a gap. open-cam already joins small gaps; for the rest use **Close selected** or **Join selected** (see [Fixing an outline that is still open](#fixing-an-outline-that-is-still-open)), or repair it in your drawing program.
- **The preview is blank.** The drawing may be on hidden layers or very far from the origin. Tick the layers and click **Fit view**.
- **Lines come out the wrong size.** Use **Measure** on something of known length, then fix **Units in the file** or **Scale** in Import settings.
- **My imported text looks different.** open-cam replaces fonts with its own closest match. Convert text to outlines (curves) in your drawing program for an exact copy, or use **Add text** to choose one of ours.
- **The machine stops or complains when I switch arcs on.** Your firmware has no arc support. Switch arcs off (see [Smaller, smoother files with arcs](#smaller-smoother-files-with-arcs)).
- **Two lines I did not want were joined.** Lower **Join gaps up to** in Import settings (or set it to 0 to switch joining off).
- **The cut is too wide or too narrow by the bit's radius.** You picked "on the line" where you wanted outside or inside, or the other way round.
- **The bit burns or chatters.** Reduce depth per pass or feed (use *Hardwood* settings), check the bit is sharp and the stock is firmly held.

## Limits

- Cuts flat shapes (2D and 2.5D) and the top surface of a 3D model. It cannot cut undercuts. Rest machining exists for 3D roughing only, not for 2D pockets.
- Input is SVG or DXF, ASCII or binary (DWG and other formats should be saved as DXF or SVG first). Images and 3D objects are not read. Text uses our built-in fonts, not yours.
- Curves are written as short straight lines unless you switch on arcs (which needs controller support).
- Feeds and speeds are cautious starting points, not guarantees. Machines differ.
- open-cam does not know where your clamps are, how far your Z axis can lift, or how tall your spindle is. Check those yourself.
