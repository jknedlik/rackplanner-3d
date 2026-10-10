/*
 * Rackplanner 3D: physical layout of a plan.
 *
 * The plan file has no physical coordinates, so this derives them: racks
 * stand side by side in a row (their width and depth come from the rack
 * type), rows are spaced by the floor's row pitch with alternating fronts
 * (hot/cold), floors are stacked, and every rack type's tray height puts a
 * cable tray above each row. Devices carry their ports' world positions,
 * and cable routes follow the 2D app's convention: from the port out to the
 * rack's cable manager (copper on the left, everything else on the right,
 * as seen from the side the port is on), up the lane, over the tray — or
 * straight down a shared lane when both ends run in the same rack and the
 * same manager — and down again.
 *
 * All sizes are in meters. Pure data in, data out; no DOM and no three.js,
 * so it runs in Node for tests as well as in the browser.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./model.js'));
  else (root.RP = root.RP || {}).layout = factory(root.RP.model);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (M) {
  'use strict';

  // Physical sizes.
  const U = 0.04445; // one rack unit
  const RACK_W = 0.6; // default cabinet width (rack types without a widthMm)
  const RACK_D = 1.2; // default cabinet depth (rack types without a depthMm)
  const GAP = 0.1; // gap between two racks in a row
  const BASE_H = 0.06; // plinth under the lowest unit
  const TOP_H = 0.06; // frame above the topmost unit
  const DEV_W = 0.46; // device face width (leaves a visible gap to the side slots)
  const DEV_D = 0.55; // device depth
  const FLOOR_H = 4.2; // floor to floor
  const SIDE_LEN = 12 * U; // a side slot's run: 12 U tall (the plan format's "12 U run")
  const SIDE_W = U; // a side-mounted device is 1 U thick
  const TRAY_W = 0.3; // cable tray width (across the aisle)
  const TRAY_H = 0.06; // cable tray depth
  const TRAY_NET = 0.045; // spacing of a network's lane on the tray

  const rackW = (t) => (t.widthMm ? t.widthMm / 1000 : RACK_W);
  const rackD = (t) => (t.depthMm ? t.depthMm / 1000 : RACK_D);
  const rowPitchOf = (floor) =>
    floor.rowPitchM == null ? M.DEFAULT_ROW_PITCH_M : floor.rowPitchM;

  /**
   * Everything the renderer needs: floors with their slabs, racks with
   * center positions and heights, devices with center, size and port
   * positions, rows with their cable tray, plus the plan's per-rack stats.
   * `rackBy` maps rack id → rack entry.
   */
  function compute(project) {
    const stats = M.statsByRack(project);
    const racks = [];
    const rackBy = new Map();
    const floors = [];
    let maxRows = 0;

    project.floors.forEach((floor, fi) => {
      const y = fi * FLOOR_H;
      const pitch = rowPitchOf(floor);
      const rows = [];
      floor.rows.forEach((row, ri) => {
        const dir = ri % 2 === 0 ? 1 : -1; // front of the row: +z / -z
        const z = (ri - (floor.rows.length - 1) / 2) * pitch;
        const rowRacks = [];
        // Row centered on x, racks side by side. Racks read left → right as
        // seen from the row's front: rows facing −z are mirrored in world x,
        // so flip their order.
        const widths = row.racks.map((rack) => rackW(M.rackTypeOf(project, rack)));
        const total = widths.reduce((a, b) => a + b, 0) + (row.racks.length - 1) * GAP;
        let acc = -total / 2;
        row.racks.forEach((rack, k) => {
          const rackType = M.rackTypeById(project, rack.type) || M.DEFAULT_RACK_TYPES[0];
          const w = widths[k];
          const x = dir === 1 ? acc + w / 2 : -acc - w / 2;
          acc += w + GAP;
          const entry = {
            rack,
            row,
            floor,
            rackType,
            x,
            z,
            y,
            dir,
            units: rackType.units,
            w: rackW(rackType),
            d: rackD(rackType),
            topY: y + BASE_H + rackType.units * U,
            frontZ: z + (dir * rackD(rackType)) / 2,
            backZ: z - (dir * rackD(rackType)) / 2,
            trayM: M.rackTrayM(project, rack),
            height: BASE_H + rackType.units * U + TOP_H,
            stats: stats.get(rack.id),
          };
          racks.push(entry);
          rackBy.set(rack.id, entry);
          rowRacks.push(entry);
        });
        rows.push({ row, dir, z, racks: rowRacks, trayY: 0 });
      });
      // One tray above the row, above its tallest rack's own tray height.
      for (const r of rows)
        r.trayY = Math.max(...r.racks.map((re) => re.topY + re.trayM)) + 0.02;
      maxRows = Math.max(maxRows, floor.rows.length);
      floors.push({ floor, y, rows, slab: null, pitch });
    });

    // Slabs sized to their floor's widest row and row span.
    for (const f of floors) {
      const w = Math.max(...f.rows.map((r) => rowWidth(r))) + 2;
      const d = (f.floor.rows.length - 1) * f.pitch + Math.max(...f.rows.map((r) => Math.max(...r.racks.map((x) => x.d)))) + 2;
      f.slab = { x: 0, z: 0, y: f.y - 0.075, w, d, h: 0.15 };
    }
    const rowOf = new Map(floors.flatMap((f) => f.rows.map((r) => [r.row.id, r])));

    // Devices.
    const devices = [];
    const ports = new Map(); // "deviceId|port" → { x, y, z, face, rack, dv }
    for (const d of project.devices) {
      const re = rackBy.get(d.loc.rack);
      if (!re) continue; // normalizeProject never leaves these behind
      const type = M.typeOf(project, d.type) || M.RESERVED;
      const h = M.deviceHeight(project, d);
      const cluster = d.cluster ? M.clusterById(project, d.cluster) : null;
      const reserved = d.type === M.RESERVED.id;
      let pos, size, side = false;
      if (d.loc.kind === 'side') {
        // A 19" device on its side (1 U wide × 12 U tall), in side slot s.
        // The slots are spread over the rack's height like the 2D sheet.
        side = true;
        const s = d.loc.at;
        const top = re.topY - sideSlotTop(re.units, s, re.rackType.sideSlots);
        // Right side as seen from the front (screen-right in the 3D front
        // view, like the 2D elevation): +x for fronts facing +z, -x for -z.
        // The slot sits in the channel between the 19" bay and the cabinet
        // wall, outer face flush with the side panel's inner face — the
        // device (and the cables out of its ports) must never enter the
        // wall.
        pos = [re.x + (re.dir === 1 ? 1 : -1) * (re.w / 2 - 0.025 - SIDE_W / 2), top - SIDE_LEN / 2, re.z + re.dir * 0.25];
        size = [SIDE_W, SIDE_LEN, 0.5];
      } else {
        // Units count from the top: `at` is the topmost unit filled.
        pos = [re.x, re.topY - (d.loc.at - 1 + h / 2) * U, re.frontZ - re.dir * (DEV_D / 2 + 0.03)];
        size = [DEV_W, h * U - 0.008, DEV_D];
      }
      const dv = {
        d,
        type,
        rack: re,
        h,
        side,
        reserved,
        pos,
        size,
        color: reserved ? '#9aa4b2' : cluster ? cluster.color : '#5d6b7a',
        ports: [],
      };
      // Port positions: spread evenly across the face, mid-height. A bay
      // device's face points to the rack's front or rear (flipped when the
      // device is mounted back to front); a side device's face is the outer
      // end of the slot and its ports run along its depth.
      const list = reserved ? [] : M.expandPorts(type);
      const n = list.length;
      if (n) {
        const m = 0.012; // margin inside the face edge
        const outX = re.dir === 1 ? 1 : -1; // the slot's outer side
        for (let i = 0; i < n; i++) {
          const p = list[i];
          const face = d.reversed ? (p.side === 'front' ? 'rear' : 'front') : p.side;
          let x, y, z;
          if (side) {
            x = pos[0] + outX * (size[0] / 2);
            y = pos[1];
            z = pos[2] - size[2] / 2 + m + ((i + 0.5) / n) * (size[2] - 2 * m);
          } else {
            x = pos[0] - size[0] / 2 + m + ((i + 0.5) / n) * (size[0] - 2 * m);
            y = pos[1];
            z = face === 'front' ? pos[2] + re.dir * (size[2] / 2) : pos[2] - re.dir * (size[2] / 2);
          }
          const at = { x, y, z, face, rack: re, dv, name: p.name, connector: p.connector, speedGbps: p.speedGbps };
          dv.ports.push(at);
          ports.set(`${d.id}|${p.name}`, at);
        }
      }
      devices.push(dv);
    }

    const bounds = {
      w: Math.max(0, ...floors.map((f) => f.slab.w)) + 2,
      d: Math.max(0, ...floors.map((f) => f.slab.d)) + 2,
      top: floors.length * FLOOR_H + 2,
    };

    return { U, floors, racks, rackBy, rowOf, devices, ports, bounds, stats };
  }

  /** A row's width across its racks (including the gaps). */
  function rowWidth(r) {
    if (!r.racks.length) return 0;
    const w = r.racks.map((x) => x.w).reduce((a, b) => a + b, 0) + (r.racks.length - 1) * GAP;
    return w;
  }

  /**
   * Meters from the rack's top (topY) down to the top edge of side slot `s`
   * on a rack of `units` U with `n` side slots — the 2D app's distribution:
   * equal gaps above, between and below the 12 U slot runs.
   */
  function sideSlotTop(units, s, n) {
    const gap = (units * U - n * SIDE_LEN) / (n + 1);
    return gap + s * (SIDE_LEN + gap);
  }

  // --------------------------------------------------------------- cabling

  /**
   * The world z of a network's lane on a row's tray: the networks of the
   * whole plan, in plan order, then the cables without one — the lanes stay
   * put from row to row, like the 2D sheet's tray.
   */
  function netLaneOffset(project, networkId) {
    const ids = project.networks.map((n) => n.id).concat(['']);
    const i = Math.max(0, ids.indexOf(networkId || ''));
    const off = (i - (ids.length - 1) / 2) * TRAY_NET;
    const half = TRAY_W / 2 - 0.02;
    return Math.max(-half, Math.min(half, off));
  }

  /**
   * Where a cable end meets its rack's cable manager: the vertical lane the
   * run climbs. Copper (an RJ45 first port) runs down the left manager, the
   * rest down the right, as seen from the side the port is on — the 2D
   * app's convention.
   */
  function endLane(at, copper) {
    const r = at.rack;
    // Side devices sit in the manager on their slot's side (the right one,
    // seen from the front), whatever their lane's network asks for. The lane
    // hugs the side panel's inner face — the device fills the channel out to
    // that face, so its run can only climb alongside it. A front port's lane
    // stands just in front of the slot's face (the port's stub must not cut
    // through the vertical unit).
    if (at.dv.side) {
      const z = at.face === 'front' ? r.frontZ - r.dir * 0.1 : r.backZ + r.dir * 0.12;
      return { x: r.x + r.dir * (r.w / 2 - 0.025), z };
    }
    // Left, as seen from `at.face`: front seen from dir, rear seen from −dir.
    // A front port's lane stands in the aisle, in front of the cabinet —
    // inside the front there is no clear vertical (the rails and the side
    // slots block it), and the run reads as a real patch panel.
    const leftSign = at.face === 'front' ? -r.dir : r.dir;
    const sideSign = copper ? leftSign : -leftSign;
    const x = r.x + sideSign * (r.w / 2 - 0.06);
    const z = at.face === 'front' ? r.frontZ + r.dir * 0.12 : r.backZ + r.dir * 0.12;
    return { x, z };
  }

  /** The polyline of one cable's head to one of its far ends, in world points. */
  function cableLeg(layout, project, cable, head, leg, high) {
    const A = layout.ports.get(`${head.device}|${head.port}`);
    const Bp = layout.ports.get(`${leg.device}|${leg.port}`);
    if (!A || !Bp) return null;
    const ca = M.connectorById(A.connector);
    const aCopper = !!ca && ca.family === 'rj45';
    const la = endLane(A, aCopper);
    const lb = endLane(Bp, aCopper); // the lane follows the head's media, per the 2D sheet
    const rowA = layout.rowOf.get(A.rack.row.id);
    const rowB = layout.rowOf.get(Bp.rack.row.id);
    const netOff = netLaneOffset(project, cable.network);
    const trayA = rowA.trayY + 0.015;
    const trayB = rowB.trayY + 0.015;
    // From a port to its lane plane (and back): out from the face to the
    // lane's z, across to the lane's x. Both lane planes (the rear one at
    // the back wall, the front one in the aisle) are clear of the device, so
    // the two-segment stub never cuts through it. A side port already sits
    // on its lane (the panel face), so it just runs to the lane's z.
    const toLane = (at, lane) => {
      if (at.dv.side) return [[at.x, at.y, lane.z]];
      return [[at.x, at.y, lane.z], [lane.x, at.y, lane.z]];
    };
    const fromLane = (at, lane) => {
      if (at.dv.side) return [[at.x, at.y, at.z]];
      return [[lane.x, at.y, at.z], [at.x, at.y, at.z]];
    };

    // Patch cable: both ends in the same rack, on the same face — a sagging
    // curve in front of (behind) the panels, from port to port, the way a
    // short cord dangles. The curve starts 5 mm proud of the face (the plug
    // body), so it never grazes the device's shell. Side-slot devices keep
    // the manager run.
    if (A.rack === Bp.rack && A.face === Bp.face && !A.dv.side && !Bp.dv.side) {
      const sgn = A.face === 'front' ? A.rack.dir : -A.rack.dir; // out of the face
      const p0 = [A.x, A.y, A.z + sgn * 0.005];
      const p3 = [Bp.x, Bp.y, Bp.z + sgn * 0.005];
      const bulge = 0.045 + Math.min(0.1, Math.abs(Bp.x - A.x) * 0.4);
      const sag = 0.012 + Math.min(0.06, Math.abs(Bp.y - A.y) * 0.25);
      const p1 = [A.x, A.y - sag, A.z + sgn * bulge];
      const p2 = [Bp.x, Bp.y - sag, Bp.z + sgn * bulge];
      const out = [[A.x, A.y, A.z]];
      for (let i = 0; i <= 16; i++) {
        const t = i / 16, u = 1 - t;
        const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
        out.push([a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1], a * p0[2] + b * p1[2] + c * p2[2] + d * p3[2]]);
      }
      out.push([Bp.x, Bp.y, Bp.z]);
      return out;
    }
    // Between floors: out to the tray, then up a riser outside every floor
    // slab (high.riseX), across under the "ceiling" (high.y — above the
    // highest tray in the plan), and down the far side. A straight run
    // would cut through the racks of the floors in between.
    if (A.rack.floor !== Bp.rack.floor) {
      return [
        [A.x, A.y, A.z],
        ...toLane(A, la),
        [la.x, trayA, la.z],
        [la.x, trayA, rowA.z + netOff],
        [high.riseX, trayA, rowA.z + netOff],
        [high.riseX, high.y, rowA.z + netOff],
        [high.riseX, high.y, rowB.z + netOff],
        [high.riseX, trayB, rowB.z + netOff],
        [lb.x, trayB, rowB.z + netOff],
        [lb.x, trayB, lb.z],
        [lb.x, Bp.y, lb.z],
        ...fromLane(Bp, lb),
      ];
    }
    // Same rack, same lane: straight down the shared lane, no tray.
    if (A.rack === Bp.rack && Math.abs(la.x - lb.x) < 0.02 && la.z === lb.z) {
      return [
        [A.x, A.y, A.z],
        ...toLane(A, la),
        [la.x, Bp.y, la.z],
        ...fromLane(Bp, lb),
      ];
    }
    return [
      [A.x, A.y, A.z],
      ...toLane(A, la),
      [la.x, trayA, la.z],
      [la.x, trayA, rowA.z + netOff],
      [lb.x, trayB, rowB.z + netOff],
      [lb.x, trayB, lb.z],
      [lb.x, Bp.y, lb.z],
      ...fromLane(Bp, lb),
    ];
  }

  /**
   * Every route the scene draws: one entry per cable with its legs (a
   * breakout runs from its head to each plugged leg), each leg a polyline
   * of world points. Cables with a missing end are skipped.
   */
  function routes(project, layout) {
    layout = layout || compute(project);
    const out = [];
    // The cross-floor riser: up outside the widest floor slab, across above
    // the highest tray in the plan.
    let riseX = 0, hiY = 0;
    for (const f of layout.floors) {
      riseX = Math.max(riseX, f.slab.w / 2);
      for (const r of f.rows) hiY = Math.max(hiY, r.trayY);
    }
    const high = { y: hiY + 0.45, riseX: riseX + 0.7 };
    for (const c of project.cables || []) {
      if (!c.a) continue;
      const legs = (M.legsOf(c) || []).filter(Boolean);
      if (!legs.length) continue;
      const path = legs.map((leg) => cableLeg(layout, project, c, c.a, leg, high)).filter(Boolean);
      if (path.length) out.push({ cable: c, legs: path });
    }
    return out;
  }

  return { compute, routes, netLaneOffset, U, RACK_W, RACK_D, GAP, BASE_H, TOP_H, FLOOR_H, TRAY_W, TRAY_H, SIDE_LEN, SIDE_W, sideSlotTop };
});
