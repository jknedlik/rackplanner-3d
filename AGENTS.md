# Rackplanner 3D — agent guide

## What this project is

A **walkable 3D viewer** for [Rackplanner](https://dennisklein.github.io/rackplanner/)
plans. It is read-only: it renders a plan file in a virtual datacenter you can
walk around or orbit. You hover a rack or device for a quick tooltip, click it
for a full inspector (cluster, type, position, power, weight, serial, asset
tag, IP, owner, notes). Clicking a rack also opens its **front view**: an SVG
elevation drawn the way the 2D app draws it (unit grid, device faces per
`face` style — ports, drive bays, fans, PDUs, hatched reserved space, side
slots on the right), with rows hoverable/clickable and hover-synced with the
3D view.

**Cabling (schema v4):** plans carry networks, cable types, transceivers and
cables (a cable joins a port of one device to a port of another; `b` is a
list of legs for breakout cables). The cable runs and the trays they climb
are visible **only in cable mode** — a third camera mode (Orbit / Walk /
**Cable**, `C` key, orbit-style camera) alongside the other modes. In
cable mode you hover a cable for a tooltip (label, network, ends, length),
and **clicking a cable selects it and rides it**: the orbit target is
dragged along the run's first leg (ease-in-out, 0.35 m/s, capped at
12 s) while a compact **detail card** (`#cableCard`) hangs to the right of
the camera's ride point — network chip, both ends, type, length, and the
`C.describe` issues; clicking the same cable again rides it back,
dragging the camera or Esc/a click elsewhere stops the ride. Cables are
also click-inspectable as before: the full inspector (type, estimated or
set length, both ends with links, issues from `C.describe`) opens, and the
selected/hovered cable gets a real 3D thickness (a tube highlight);
selecting a cable keeps the racks it runs through solid.
Every cable run renders in network color: port → out to the rack's cable
manager (copper/RJ45 heads down the left manager, everything else down the
right — the 2D app's convention) → up → across the cable **tray** above
the row (lanes offset per network) → down to the far port. A same-rack
pair on the **same face** skips the tray entirely: a sagging Bézier **patch
cable** dangles from port to port in front of (behind) the panels. A
cross-floor run climbs a **riser** outside the floor slabs, crosses above
the highest tray, and drops into the far row. Racks over budget still glow
red. The rack **front view** (inspector elevation) draws the tray with a
lane per network, the real ports of every device (cabled ones in their
network's color), and the cable runs — solid for front-side ports, dashed
where a run comes from the rear, exiting the sheet edge for far ends in
other racks; runs are hoverable/clickable and hover-synced with the 3D
view. The row view shows only the cables that run entirely inside the open
row, and only that row's tray; cable mode composes with the row view
(in-row runs + trays, no riding — the ortho camera owns the framing).

There is also a **rack row view** camera mode: double-click a rack or
device (or the big “Enter row mode” button, shown while a rack or one of
its devices is selected and styled like “Leave row mode”) and the view
animates to an
**orthographic** camera standing in front of the rack's **whole row** —
each rack looks exactly like the 2D elevation. The row view renders at a
**fixed on-screen scale** (CSS px per meter, `ROW_PX_PER_M` — the Zoom
slider and Shift+wheel adjust it), so 1 U is the same pixel size on every
screen and window; the default framing always keeps the whole rack in
frame. The mouse
**wheel scrolls through the row rack by rack** (the view eases smoothly from
one rack to the next and the rack header — **centered in the view** —
follows the centered rack); the floating device labels are shown for
**every rack of the row** — centered rack at 100% opacity, −30% per rack of
distance (min 10%), toggleable with the "Fade" toolbar button (on by
default); side-slot labels are rotated 90° so they run down their slot.
The **wheel always switches between racks** (even while orbiting the row);
**Shift+wheel / pinch zooms**; **clicking another rack in the row switches
to it**. **Drag (or the Orbit toolbar button) switches to a free orbit
camera around the row at the same 2.6 m distance — no zoom jump — and
row mode itself, and its transparency, stay on**;
a big **“← Leave row mode” button** (bottom center, shown only in row mode)
or Esc/V exits — always returning to a fixed **45°/45° whole-floor framing**
(45° elevation, 45° around the vertical, far enough for the whole floor,
selection kept; target, radius and angles ease in). The left-side **Row / Rack / Zoom sliders** —
Row jumps between the floor's rows (keeping the rack column), Rack between
the row's racks, Zoom sets the magnification (px per U); the Row slider
triggers a **camera flight** whose length the **Flight**
slider sets (3 s by default — every phase is a fraction of that total):
crane up to a 45° top view of the floor (with a quarter-turn, 45° of the
full swing, while rising), pan across, descend behind the new row, and —
as the last step — rotate around to face its front. Both transition rows
stay solid during the flight; the old row is hidden again as the final
rotation starts. Only the active
row is shown (other rows are hidden while the view is open). Racks over
their power/weight budget glow red, clusters are color-coded, reserved
space is translucent. Each rack shows a panel sprite at the bottom front
of the cabinet (rack name + the three usage bars: energy/weight/units)
plus a vertical name tag — one letter per line — running down the
front-left of the cabinet; nothing is hidden per-rack in the row view —
the floating header is an HTML overlay only. The **front faceplates** —
the 2D app's device faces (`faceSVG` per `face` style: ports, bays, fans,
PDUs…) rasterized as a texture over a light metal base — appear on every
bay device **only in the row view**, behind the **“Front panels” checkbox
in the left-side nav** (on by default): one non-pickable `InstancedMesh`
per device type, a thin plate 9–15 mm proud of the device's face (in front
of the lit cluster-color strip, which is what other modes show), flipped
for rows facing −z so the texture reads left-to-right from the front.

Selection focus: clicking a rack (or a device/reservation inside one) keeps
that rack fully solid and drops every other rack to 10% opacity (the row
view hides them entirely). All racks/devices are rendered as solid+ghost
`InstancedMesh` pairs; `fillAll()` rewrites both whenever selection, row
view or focus changes.

It is deployed to GitHub Pages (`<user>.github.io/rackplanner-3d`) and must
stay runnable as **static files with no build step**.

## Stack and ground rules

- **No build step, no package manager, no CSS framework.** Plain HTML5 + CSS,
  a few classic `<script>` files, and exactly one ES module (`js/app.js`).
- **The only runtime dependency is Three.js**, pinned as a git submodule
  at `vendor/three` (mrdoob/three.js, tag `r170`; the app imports
  `vendor/three/build/three.module.js`). No CDN at runtime — everything
  works offline once the submodule is checked out
  (`git submodule update --init`).
- `js/model.js`, `js/io.js` and `js/cabling.js` are **vendored verbatim**
  from upstream (CC0 1.0). Do not rewrite or "modernize" them; all new
  behavior goes in our own files (`layout.js`, `app.js`). If a bug is really
  in them, fix it here and note it (they must keep accepting every plan
  file, CSV and share link the 2D app produces).
- **HTML5-first UI:** the chrome (header, inspector aside, `<dialog>`,
  `<details>` help/legend, footer) is static HTML/CSS in `index.html`. JS
  only fills dynamic parts (plan name, floor buttons, legend, inspector
  body, warnings) and drives the canvas. Prefer native elements
  (`<dialog>`, `<details>`, `<dl>`, `<nav>`, form buttons) over JS-made
  equivalents.
- User-entered text (device names, notes, cluster names…) is only ever put
  into the DOM through the `esc()` helper in `app.js`.

## The plan file format (rackplanner schema v4)

One JSON document. A plan **file** is the document as-is; share links pack
it into the URL. Floors/rows/racks are nested arrays; everything else is a
flat list joined by `id` (floors, rows and racks share one id space).

```
{
  "app": "rackplanner", "version": 4,
  "name": "…", "info": { "site": "…", "author": "…", "revision": "…" },
  "deviceTypes": [ { "id", "label", "tag", "spec", "height": 1..20, "face",
                     "defaultName", "powerW", "weightKg",
                     "ports": [ { "name", "first?", "count?", "connector",
                                   "speedGbps", "side": "front"|"rear" } ],
                     "slackM" } ],
  "rackTypes":   [ { "id", "name", "units": 10..60, "sideSlots": 0..4,
                     "powerW": 0=none..budget, "weightKg",
                     "widthMm", "depthMm", "trayM", "slackM" } ],
  "cableTypes":  [ { "id", "name", "media", "connector", "connectorB",
                     "legs", "speedGbps", "maxM", "lengthsM": [m] } ],
  "transceivers": [ { "id", "name", "connector", "fiber": "lc"|"mpo",
                      "mode": "mmf"|"smf", "speedGbps", "reachM" } ],
  "floors": [ { "id", "name", "rowPitchM", "rows": [ { "id", "name",
                "racks": [ { "id", "name", "type": rackTypeId,
                             "trayM", "slackM" } ] } ] } ],
  "clusters": [ { "id", "name", "color": "#rrggbb" } ],
  "networks": [ { "id", "name", "color": "#rrggbb", "firstLabel" } ],
  "devices":  [ { "id", "type": deviceTypeId, "name", "cluster": id|null,
                  "notes", "serial", "asset", "ip", "owner",
                  "powerW": null|W, "weightKg": null|kg, "reversed",
                  "slackM": null|m, "height": (reserved space only),
                  "loc": { "rack": rackId, "kind": "u"|"side", "at": n } } ],
  "cables": [ { "id", "type": cableTypeId|null, "network": id|null,
                "label", "lengthM": null|m, "notes",
                "a": { "device", "port", "transceiver"? },
                "b": end | [ end|null, … ] } ],
  "meta": { }
}
```

Rules that matter for rendering:

- **Limits:** 1–6 floors, 1–8 rows per floor, 1–16 racks per row, 60 device
  types, 20 rack types.
- **`loc.kind: "u"`** — `at` is the **topmost** unit the device fills; units
  are numbered **from the top** (U1 first). Height comes from the device
  type, so a 2U device at `at: 5` fills U5–U6.
- **`loc.kind: "side"`** — `at` is the 0-based vertical side slot (displayed
  as V1, V2…); only 1U devices, shown rotated (a vertical PDU). Each slot is
  a 12 U run; the *n* slots of a rack are spread over its unit height with
  equal gaps, the way the 2D sheet draws them.
- **`powerW`/`weightKg` null on a device** means "inherit from its type"
  (see `M.powerOf` / `M.weightOf`).
- **`reserved`** is a built-in device type not stored in `deviceTypes`; each
  reservation stores its own `height` and counts as 0 W / 0 kg unless it has
  its own values.
- **Rack budgets:** `rackTypes[].powerW` / `weightKg` are the budgets
  (0 = none). A rack is "over budget" when its used total exceeds the
  budget (`statsByRack` computes this as `overPower` / `overWeight`).
- **Cables:** a cable joins a port of one device (end `a`) to a port of
  another (end `b` — a single end, or a list of legs for a breakout cable).
  Every port takes at most one cable end. Port names come from the device
  **type's** `ports` groups: a group with `first`/`count` is a numbered
  series (e.g. `swp1…swp48`); `M.expandPorts(type)` flattens a type's ports,
  `M.legsOf(cable)` the far ends. `null` type / transceiver / length means
  "work it out" — `js/cabling.js` resolves it; `C.describe(project, cable)`
  returns the resolved type, length, both ends (device, port, face,
  transceiver) and the issues the inspector shows, and `C.cableIndex` maps
  `"deviceId|port"` to the cable on it.
- **Networks** are colored labels for cable groups; the viewer colors the 3D
  runs and the elevation runs by `networks[].color` (cables without a
  network are grey).
- Optional device fields are omitted when empty; a minimal device is
  `{ id, type, name, cluster, loc }`.
- `deviceTypes[].face` is a drawing style: `rj45, qsfp, compute, storage,
  jbod, gpu, patch, pdu, ups, blank, generic`. 3D uses it for the row
  view's faceplate textures (`faceSVG` in `app.js`); the device body color
  comes from the cluster.
- Legacy versions: v1 counted units from the **bottom**; v1/v2 had a flat
  rack list (becomes one row); v3 has no cabling (networks, cable types and
  cables come out empty). `IO.normalizeProject` upgrades all of it to v4 and
  reports `warnings`.
- **CSV inventory** (import/export): columns
  `Floor, Row, Rack, Position, Height (U), Type, Name, Cluster, Serial
  number, Asset tag, IP address, Owner, Power (W), Weight (kg), Notes`.
  Import needs only `Rack`, `Position` (`U5`, `U5-6`, `Side V1`) and
  `Name` or `Type`; missing floors/rows/racks/clusters are created by name.
  See `IO.importCSV`.
- **Share link:** `#plan=z<base64url>` (deflate-compressed compact JSON) or
  `#plan=j<base64url>` (plain). `IO.encodeShare` / `IO.decodeShare`.

`plans/example.json` is the built-in two-floor example plan
(`M.createExampleProject()`), exported via `IO.serialize`.
`plans/example-big.json` is a second, curated example loaded by the
“Big example (2 × 16 racks)” button in the open dialog (fetched at
runtime, normalized like any plan file): one floor, Row A = 4 network +
8 compute + 4 GPU racks (A13–A16 are 48 U GPU racks, A15 over its
20 kW budget), Row B = 4 network + 8 storage + 4 GPU racks (B15 over
budget). It is generated by a one-off Node script (not in the repo) that
builds the plan from the upstream example's device/rack types and
clusters and writes it through `IO.serialize`.

## How the 3D layout is derived (`js/layout.js`)

The plan has no physical coordinates, so these are derived (meters):

- 1 U = 44.45 mm. Rack width/depth come from the rack type's
  `widthMm`/`depthMm` (default 0.60 × 1.20 m when absent), plinth 0.06
  under the lowest unit, frame 0.06 above the topmost; total height
  `units × U + 0.12`.
- Devices: 0.46 wide × 0.55 deep, centered in the rack (a 1 cm gap to the
  side slots); a device at `at` with height `h` has its center at
  `topY − (at − 1 + h/2) × U`.
- Side slots: a 19″ device on its side — 1 U wide × 12 U tall (the slot's
  run) — mounted on the right side as seen from the front, **outer face
  flush with the side panel's inner face** (its ports sit on that face).
  Slot *s* of a rack with *n* slots sits `gap + s × (12 U + gap)` below
  the rack top, `gap = (units − n × 12 U) / (n + 1)` — the 2D app's even
  distribution (`L.sideSlotTop`). The rack's side shows a dark channel
  strip (19″ bay edge to cabinet edge) with a slot box per slot; empty
  slots are visible in 3D and as dashed boxes in the elevation. The strip
  is **cut around the occupied slots** in the row view and in cable mode
  (`writeChannelSeg` writes one segment per remaining run), so a vertical
  unit reads cleanly from the front instead of sitting behind the strip.
- Racks in a row stand side by side (0.70 m pitch — a 10 cm gap, `PITCH`),
  centered on x. Rows are stacked along z with the floor's `rowPitchM`
  aisle (default `M.DEFAULT_ROW_PITCH_M`, 3 m) and **alternating fronts**
  (hot/cold aisles). Floors are stacked 4.2 m apart with floor slabs.
- Cable tray: one above each row, at `row.trayY = max(topY + rackTrayM) +
  0.02` (the rack's `trayM` is the manager height above its top, from the
  rack/rack type, `M.rackTrayM`). `L.routes(project, layout)` computes the
  world-space polyline of every cable run: port → out to the rack's cable
  **manager lane** (copper — an RJ45 head — down the left manager,
  everything else down the right, as seen from the port's side; a front
  port's lane stands **in the aisle, 12 cm in front of the cabinet** —
  inside the front there is no clear vertical — while a rear port's lane
  stands 12 cm in front of the back wall; a side port's lane hugs the side
  panel's inner face, 10 cm in front of the slot for front ports) → up →
  across the tray (the lane is offset per network, `L.netLaneOffset`) →
  down to the far port. Same rack, same face: a sagging **Bézier patch
  cable** (17 samples, the curve starts 5 mm proud of the face) instead.
  Same rack, same lane, different face: straight down the shared lane, no
  tray. **Between floors**: up, out to a riser outside the widest floor
  slab (`slab.w/2 + 0.7`), across above the highest tray in the plan
  (`+0.45`), and down into the far row — a straight run would cut through
  the intermediate racks. The layout's `ports` map sends
  `"deviceId|port"` to a world position. The cabinet's top and bottom
  rails sit in the 6 cm frame gaps (clear of the top/bottom devices), so
  front-port stubs at the extreme units have clear air to the aisle lane.
- Rack numbering reads **left → right as seen from the row's front**: rows
  facing −z get their x assignment mirrored (`order = n − 1 − k`), so the
  row view, its wheel paging and the rack slider all run left → right for
  every row.
- Walk collision uses the rack AABBs of the nearest floor, player radius
  0.32 m, axis-separated.

## File map

```
index.html            page shell: toolbar, inspector, dialog, help (static)
css/app.css           dark theme, all UI chrome
js/model.js           UPSTREAM (CC0), plan model + placement rules + stats
js/io.js              UPSTREAM (CC0), file/CSV/share-link (de)serialization
js/cabling.js         UPSTREAM (CC0), cabling: ports, cables, networks,
                      cable-type/transceiver catalogs, length/type/issue
                      resolution (pure, DOM-free)
js/layout.js          plan → physical positions + cable routes
                      (pure, DOM-free, Node-testable)
js/app.js             the ES module: three.js scene, instanced rendering,
                      orbit + walk + cable + ortho row-view cameras,
                      raycast hover/click, cable runs (fillCables /
                      updateCableHighlight) + cable-mode follow and the
                      detail card (startCableFollow / updateCableCard),
                      row-view faceplates (makeFaceTexture / writePlate),
                      inspector incl. the SVG rack elevation with tray +
                      cable runs (faceSVG / elevationSVG) and the row-view
                      label overlay (buildRackOverlay / updateOverlay)
vendor/three          Three.js r170, the only runtime dependency (submodule)
plans/example.json    the built-in example plan, exported as a file
plans/example-big.json  the “Big example” (2 × 16 racks, 306 devices, no
                      cables — a v3 plan, upgraded to v4 on load)
```

Rendering uses `InstancedMesh` (one per part: rack frames 12 boxes/rack —
closed cabinet: plinth, 4 posts, 4 rails, back panel, 2 side panels —
side channel strips (segmented around occupied slots in the row/cable
views), slot boxes per side slot, device bodies, lit face strips, face
plates (row view only, one mesh per device type, textured — see above),
side devices, reserved, soft red over-budget glow shells; each structural
part has a solid + ghost pair for selection focus), cable trays (one box
per row, **visible in cable mode only**) and the cable runs — every leg of
every cable in **one `LineSegments`** with vertex colors per network
(`world.cables`; the draw range is 0 outside cable mode, dimming is
written into the colors by `fillCables`). The hovered/selected cable
additionally gets a real 3D
thickness: `TubeGeometry` highlights (CatmullRom through the route points)
rebuilt in `updateCableHighlight`, white undercoat when selected. Cables
are pickable too — `hit.index / 2` maps back to the cable through
`world.segCable`. Plus canvas-texture label planes
(floor labels, per-rack panels and vertical name tags) — fixed in front of
the cabinet (2–3 cm proud of the front face), rotated once with the rack's
dir, never billboarded toward the camera; double-sided so they stay faintly
visible from behind through the open cabinet. The floor slabs are
individual meshes, each with its own procedural canvas marble texture
(`marbleTexture(w,d)`) mapped 1:1 over the whole slab — the marble runs
continuously, never tiling. The scene background is a matte vertical
gradient. Picking maps `instanceId` back to plan entities through
`world.pick`; slabs carry their floor in `userData.floor`.

## Performance model (app.js frame loop)

The loop renders **on demand**: `frame()` calls `renderer.render` only when
`needsRender` is set — camera moved, `fillAll` / `select` / `setProject` /
`setMode` ran, the hover outline changed, a resize happened, … Anything
that mutates scene-visible state must set `needsRender` (and `hoverDirty`
when the pickable instances or the hover-relevant state changed), or the
view will go stale. Because on-demand rendering needs a fixed point, the
orbit camera **snaps to its goal within 0.1 mm** — the exponential ease is
asynchronous, without the snap the camera would "move" forever. The hover
raycast (a full pick over every instance mesh — the most expensive
per-frame work) runs only when the pointer or the camera moved: pointer
moves raycast same-frame, camera-only movement on alternate frames
(30 Hz), and hover is suppressed entirely while dragging or while the
camera rides a cable. Render
resolution is **adaptive**: after a 2 s warm-up the average frame time is
checked every ~50 frames and the pixel ratio steps in 0.25 increments
(down above ~22 ms/frame, up below ~16 ms), capped at
`min(devicePixelRatio, 2)` and **floored at `max(1, cap − 0.5)`** — it
never goes more than half a step below native (a 2× display drops to 1.5,
never 1.0), because below that every texture reads as blurry, which is
worse than a slightly lower framerate. Any reduction is shown in the
footer (`#resStat`: “render 1.50×”) instead of silently softening the view.

## Commands

```sh
# run locally (ES modules need http://, not file://)
python3 -m http.server 8080
# → http://localhost:8080

# syntax-check the plain scripts
node --check js/model.js js/io.js js/cabling.js js/layout.js
# app.js is an ES module:
node --input-type=module --check < js/app.js

# regenerate the example plan file (after upstream changes)
node -e "const M=require('./js/model.js'),IO=require('./js/io.js'),fs=require('fs');fs.writeFileSync('plans/example.json',IO.serialize(M.createExampleProject()))"
```

There are no unit tests yet; `js/model.js`, `js/io.js` and `js/layout.js`
are DOM-free, so a Node one-liner (see above) is the usual smoke test.

## Deploy

`.github/workflows/pages.yml` deploys the working tree to GitHub Pages on
every push to the default branch (static files, no build — same shape as
upstream's workflow). The site must work from any static host, including
`localhost`.
