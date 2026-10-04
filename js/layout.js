/*
 * Rackplanner 3D: physical layout of a plan.
 *
 * The plan file has no physical coordinates, so this derives them: racks
 * stand side by side in a row, rows are spaced by an aisle with alternating
 * fronts (hot/cold), floors are stacked. All sizes are in meters.
 *
 * Pure data in, data out; no DOM and no three.js, so it runs in Node for
 * tests as well as in the browser.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./model.js'));
  else (root.RP = root.RP || {}).layout = factory(root.RP.model);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (M) {
  'use strict';

  // Physical sizes.
  const U = 0.04445; // one rack unit
  const RACK_W = 0.6; // 19" cabinet width
  const RACK_D = 1.05; // cabinet depth
  const PITCH = RACK_W + 0.1; // center-to-center: 10 cm gap between racks
  const BASE_H = 0.06; // plinth under the lowest unit
  const TOP_H = 0.06; // frame above the topmost unit
  const DEV_W = 0.46; // device face width (leaves a visible gap to the side slots)
  const DEV_D = 0.55; // device depth
  const AISLE = 1.2; // gap between two rows
  const FLOOR_H = 4.2; // floor to floor
  const SIDE_LEN = 12 * U; // a side slot's run: 12 U tall (the plan format's "12 U run")
  const SIDE_W = U; // a side-mounted device is 1 U thick

  /**
   * Everything the renderer needs: floors with their slabs, racks with
   * center positions and heights, devices with center and size, plus the
   * plan's per-rack stats. `rackBy` maps rack id → rack entry.
   */
  function compute(project) {
    const stats = M.statsByRack(project);
    const racks = [];
    const rackBy = new Map();
    const floors = [];
    let maxRacks = 0;
    let maxRows = 0;

    project.floors.forEach((floor, fi) => {
      const y = fi * FLOOR_H;
      const rows = [];
      floor.rows.forEach((row, ri) => {
        const dir = ri % 2 === 0 ? 1 : -1; // front of the row: +z / -z
        const z = (ri - (floor.rows.length - 1) / 2) * (RACK_D + AISLE);
        const rowRacks = [];
        row.racks.forEach((rack, k) => {
          const rackType = M.rackTypeById(project, rack.type) || M.DEFAULT_RACK_TYPES[0];
          // Racks read left → right as seen from the row's front: rows facing
          // −z are mirrored in world x, so flip their numbering.
          const order = dir === 1 ? k : row.racks.length - 1 - k;
          const entry = {
            rack,
            row,
            floor,
            rackType,
            x: (order - (row.racks.length - 1) / 2) * PITCH,
            z,
            y,
            dir,
            units: rackType.units,
            topY: y + BASE_H + rackType.units * U,
            frontZ: z + (dir * RACK_D) / 2,
            backZ: z - (dir * RACK_D) / 2,
            height: BASE_H + rackType.units * U + TOP_H,
            stats: stats.get(rack.id),
          };
          racks.push(entry);
          rackBy.set(rack.id, entry);
          rowRacks.push(entry);
        });
        rows.push({ row, dir, z, racks: rowRacks });
        maxRacks = Math.max(maxRacks, row.racks.length);
      });
      maxRows = Math.max(maxRows, floor.rows.length);
      floors.push({ floor, y, rows, slab: null });
    });

    // Slabs sized to their floor's biggest row.
    for (const f of floors) {
      const nRows = f.floor.rows.length;
      const nRacks = Math.max(...f.floor.rows.map((r) => r.racks.length));
      f.slab = {
        x: 0,
        z: 0,
        y: f.y - 0.075,
        w: (nRacks - 1) * PITCH + RACK_W + 2,
        d: (nRows - 1) * (RACK_D + AISLE) + RACK_D + 2,
        h: 0.15,
      };
    }

    // Devices.
    const devices = [];
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
        // Right side as seen from the front (screen-right in the 3D front view,
        // like the 2D elevation): +x for fronts facing +z, -x for -z.
        pos = [re.x + (re.dir === 1 ? 1 : -1) * (RACK_W / 2 - 0.035), top - SIDE_LEN / 2, re.z + re.dir * 0.25];
        size = [SIDE_W, SIDE_LEN, 0.5];
      } else {
        // Units count from the top: `at` is the topmost unit filled.
        pos = [re.x, re.topY - (d.loc.at - 1 + h / 2) * U, re.frontZ - re.dir * (DEV_D / 2 + 0.03)];
        size = [DEV_W, h * U - 0.008, DEV_D];
      }
      devices.push({
        d,
        type,
        rack: re,
        h,
        side,
        reserved,
        pos,
        size,
        color: reserved ? '#9aa4b2' : cluster ? cluster.color : '#5d6b7a',
      });
    }

    const bounds = {
      w: (maxRacks - 1) * PITCH + RACK_W + 4,
      d: (maxRows - 1) * (RACK_D + AISLE) + RACK_D + 4,
      top: floors.length * FLOOR_H + 2,
    };

    return { U, RACK_W, RACK_D, BASE_H, TOP_H, AISLE, FLOOR_H, floors, racks, rackBy, devices, bounds, stats };
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

  return { compute, U, RACK_W, RACK_D, BASE_H, TOP_H, AISLE, FLOOR_H, PITCH, SIDE_LEN, SIDE_W, sideSlotTop };
});
