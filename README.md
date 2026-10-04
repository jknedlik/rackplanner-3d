# Rackplanner 3D

A **walkable 3D viewer** for [Rackplanner](https://dennisklein.github.io/rackplanner/)
datacenter plans. Load a plan file (or a CSV inventory) and walk around or
orbit a virtual datacenter: hover a rack or device for a tooltip, click it
for a full inspector (cluster, type, position, power, weight, serial, asset
tag, IP, owner, notes) plus an SVG front elevation drawn the way the 2D app
draws it. Racks over their power/weight budget glow red, clusters are
color-coded, and reserved space is translucent.

## Quick start

A fresh clone needs the Three.js submodule checked out once:

```sh
git submodule update --init vendor/three
```

```sh
./start.sh            # → http://localhost:8080
./start.sh 9000       # …or pick another port
```

The script serves this folder with Python's built-in HTTP server **in the
foreground** — the site is up only while the script runs, and `Ctrl+C`
stops it. The only prerequisite is Python 3; there is no build step and no
package manager.

Because the app is plain static files, it also works from **any** static
host (GitHub Pages, `npx serve`, a shared folder, …) — just point the host
at this directory.

## Controls

| Where | Action |
|---|---|
| **Orbit** (default) | drag rotates · wheel zooms · right-drag / Shift-drag pans · click inspects |
| **Walk** | W A S D move · Shift run · E / Q up and down · mouse looks · click inspects (you collide with racks) |
| **Rack row view** | double-click a rack or device (or the big “Enter row mode” button, shown while a rack is selected) for a straight-on orthographic view of the whole row, with every device labeled |
| inside the row view | **wheel** scrolls rack by rack (centered rack in a floating header) · **Shift+wheel / pinch** zooms · click a rack to switch to it · **drag / the Orbit button** orbits around the row while row mode stays on · **← Leave row mode** button or **Esc / V** exits |
| row sliders (left) | **Row** jumps between the floor's rows (keeping your rack column) with a camera flight — crane up to a 45° top view, pan across, descend, and rotate to face the new row · **Rack** jumps between the row's racks · **Zoom** sets the magnification (px per U) · **Flight** sets the flight length (1–10 s, 3 s default) |
| common | **V** toggles walk/orbit · **Esc** deselects · floor buttons in the header jump between floors · **Fade** (on by default) dims device labels by distance from the centered rack |

## Opening plans

**Open plan…** in the header gives you:

- a rackplanner **plan file** (`.json`) or a **CSV inventory**
  (`Rack`, `Position`, `Name` or `Type` at minimum — missing floors, rows,
  racks and clusters are created by name), chosen as a file or pasted;
- **Example plan** — the built-in two-floor example;
- **Big example (2 × 16 racks)** — a one-floor hall with 32 racks and
  306 devices (network, compute, storage and GPU rows, two racks over
  budget) — good for trying the row view, sliders and flight;
- **Copy link** shares the currently loaded plan as a URL
  (`#plan=…`, deflate-compressed) that works in a private browser tab.

The plan file format (schema v3) is defined by Rackplanner; legacy v1/v2
files and share links from the 2D app are accepted and repaired, with
warnings shown if anything had to be fixed.

## Project layout

```
index.html              page shell: toolbar, inspector, dialogs (static)
css/app.css             dark theme, all UI chrome
js/model.js             UPSTREAM (CC0) — plan model, placement rules, stats
js/io.js                UPSTREAM (CC0) — file/CSV/share-link (de)serialization
js/layout.js            plan → physical positions (pure, DOM-free, Node-testable)
js/app.js               the ES module: three.js scene, instanced rendering,
                        orbit/walk/ortho row-view cameras, hover/click,
                        inspector incl. the SVG rack elevation
vendor/three          Three.js r170 (git submodule) — the only runtime dep
plans/example.json      the built-in example plan
plans/example-big.json  the “Big example” (2 × 16 racks, 306 devices)
start.sh                local server for development
```

`js/model.js` and `js/io.js` are vendored **verbatim** from the upstream
2D app (CC0 1.0) and must keep accepting every plan the 2D app produces —
all behavior lives in `layout.js` and `app.js`.

### Checks

```sh
node --check js/model.js js/io.js js/layout.js   # plain scripts
node --input-type=module --check < js/app.js     # the ES module
./start.sh                                       # then browse
```

There are no unit tests; the DOM-free modules are smoke-tested with
Node one-liners.

## Hosting

`.github/workflows/pages.yml` deploys the working tree to GitHub Pages on
every push to the default branch (static files, no build). The site must
work from any static host, including `localhost`.

## Credits

Plan format and the upstream model/IO code: [Rackplanner](https://dennisklein.github.io/rackplanner/)
(CC0 1.0). 3D rendering: [Three.js](https://threejs.org/) r170 (MIT),
pinned as a git submodule at `vendor/three` (tag `r170`).
