# open-cam

A free, open-source, in-browser CAM tool: turn an SVG drawing into G-code for a hobby CNC router. Nothing is uploaded; it all runs on your computer.

- **Using it:** open the app and click *Help & guide*, or read [docs/USER_GUIDE.md](docs/USER_GUIDE.md).
- **Working on it:** read [docs/DEVELOPER.md](docs/DEVELOPER.md) (architecture, conventions, algorithms, testing, known limits). The original research and roadmap is in [PLAN.md](PLAN.md).

```bash
npm install
npm run dev        # http://localhost:5173
npx vitest run     # tests
npx vite build     # production build
```

Features: profile / pocket / on-the-line / drill operations with climb or conventional direction, ramped entry, holding tabs, flat/ball/V bits, Marlin and GRBL output, work-area checks, two-sided jobs with keyed dowel registration, thick-stock dowel strategy, splitting parts longer than the machine into registered segments, V-carving, V-inlay and flat-bottom inlay, lead-in/out, dogbone corners, 3D surfacing from an STL (roughing and finishing), a 3D material-removal simulation, and undo / saved projects.

## Licence

LGPL-3.0-or-later: see `COPYING.LESSER`, `COPYING` and `NOTICE.md` (which also lists the third-party components and their licences).
