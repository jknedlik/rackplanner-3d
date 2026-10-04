/*
 * Vendored from https://github.com/dennisklein/rackplanner — CC0 1.0 Universal (public domain).
 * Unmodified except this header.
 *
/*
 * Rackplanner: data model and placement rules.
 *
 * Pure functions without DOM access, shared by the browser app and the Node
 * tests. A project looks like this:
 *
 *   {
 *     version: 3,
 *     name: 'Untitled rack plan',
 *     info: { site, author, revision },                 // title block
 *     deviceTypes: [{ id, label, tag, spec, height, face, defaultName, powerW, weightKg }],
 *     rackTypes:   [{ id, name, units, sideSlots, powerW, weightKg }],   // budgets, 0 = none
 *     floors: [{ id, name, rows: [{ id, name, racks: [{ id, name, type }] }] }],
 *     clusters: [{ id, name, color: '#rrggbb' }],
 *     devices:  [{ id, type, name, cluster: id|null, notes, serial, asset, ip, owner,
 *                  powerW: null|W, weightKg: null|kg, height (reserved space only),
 *                  loc: { rack, kind: 'u'|'side', at } }],
 *     meta: {}
 *   }
 *
 * A plan has 1 to 6 floors, a floor 1 to 8 rows and a row 1 to 16 racks. Rack
 * ids are unique across the plan. A device either sits in its rack's height
 * units (kind 'u', `at` is the lowest-numbered unit it occupies; units are
 * numbered from the top, so U1 is the topmost unit) or in one of the rack's
 * vertical side slots (kind 'side', `at` counts from 0 at the top). Side
 * slots take 1U devices only.
 *
 * Device and rack types belong to the plan, so a plan file carries its own
 * catalog. The built-in type 'reserved' marks space for future equipment; it
 * has no fixed height (each reservation stores its own) and is not stored in
 * the catalog.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else (root.RP = root.RP || {}).model = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCHEMA_VERSION = 3;
  const LIMITS = {
    floors: 6,
    rows: 8, // per floor
    racks: 16, // per row
    unitsMin: 10,
    unitsMax: 60,
    sideSlots: 4,
    deviceHeight: 20,
    deviceTypes: 60,
    rackTypes: 20,
  };
  const RACK_UNITS = 47; // height of the default rack type
  const SIDE_SLOTS = 2;
  const DEFAULT_RACKS = 3;
  // A side slot runs along 12U of the rack (a 19" device on its side) plus a 1U gap.
  const SIDE_SLOT_SPAN = 13;

  const FACES = [
    { id: 'rj45', label: 'Switch, RJ45 ports' },
    { id: 'qsfp', label: 'Switch, QSFP cages' },
    { id: 'compute', label: 'Server, drive bays' },
    { id: 'storage', label: 'Storage server, bay grid' },
    { id: 'jbod', label: 'Disk enclosure, drawers' },
    { id: 'gpu', label: 'GPU server, fans' },
    { id: 'patch', label: 'Patch panel' },
    { id: 'pdu', label: 'PDU, outlets' },
    { id: 'ups', label: 'UPS, display' },
    { id: 'blank', label: 'Blanking panel' },
    { id: 'generic', label: 'Generic, vents' },
  ];
  const FACE_IDS = new Set(FACES.map((f) => f.id));

  const DEFAULT_DEVICE_TYPES = [
    { id: 'switch-rj45', label: '48-port switch', tag: 'SWITCH', spec: '48 × RJ45', height: 1, face: 'rj45', defaultName: 'sw-rj45-01', powerW: 150, weightKg: 6 },
    { id: 'switch-qsfp', label: '24-port switch', tag: 'SWITCH', spec: '24 × QSFP', height: 1, face: 'qsfp', defaultName: 'sw-qsfp-01', powerW: 350, weightKg: 9 },
    { id: 'compute-node', label: 'Compute node', tag: 'COMPUTE', spec: 'server', height: 2, face: 'compute', defaultName: 'cn-001', powerW: 700, weightKg: 25 },
    { id: 'storage-node', label: 'Storage node', tag: 'STORAGE', spec: 'server, 24 bays', height: 4, face: 'storage', defaultName: 'sn-01', powerW: 900, weightKg: 40 },
    { id: 'storage-enclosure', label: 'Storage enclosure', tag: 'JBOD', spec: 'JBOD, 2 drawers', height: 4, face: 'jbod', defaultName: 'jbod-01', powerW: 800, weightKg: 60 },
  ];

  /** Starting points for new device types in the catalog editor. */
  const TYPE_TEMPLATES = [
    { label: '1U server', tag: 'SERVER', spec: '10 bays', height: 1, face: 'compute', defaultName: 'srv-01', powerW: 450, weightKg: 16 },
    { label: 'GPU server', tag: 'GPU', spec: '8 × GPU', height: 4, face: 'gpu', defaultName: 'gpu-01', powerW: 3000, weightKg: 65 },
    { label: 'Patch panel', tag: 'PATCH', spec: '24 × RJ45', height: 1, face: 'patch', defaultName: 'pp-01', powerW: 0, weightKg: 2 },
    { label: 'PDU', tag: 'PDU', spec: '12 × C13', height: 1, face: 'pdu', defaultName: 'pdu-01', powerW: 0, weightKg: 5 },
    { label: 'UPS', tag: 'UPS', spec: '3 kVA', height: 2, face: 'ups', defaultName: 'ups-01', powerW: 150, weightKg: 32 },
    { label: 'Blanking panel', tag: 'BLANK', spec: 'airflow', height: 1, face: 'blank', defaultName: 'blank-01', powerW: 0, weightKg: 0.5 },
    { label: 'Generic device', tag: 'DEVICE', spec: '', height: 2, face: 'generic', defaultName: 'dev-01', powerW: 300, weightKg: 15 },
  ];

  const RESERVED = Object.freeze({
    id: 'reserved',
    label: 'Reserved space',
    tag: 'RESERVED',
    spec: 'placeholder',
    height: 1,
    face: 'reserved',
    defaultName: 'reserved-01',
    powerW: 0,
    weightKg: 0,
    variable: true,
    builtin: true,
  });

  const DEFAULT_RACK_TYPES = [
    { id: 'rack-47', name: '47U rack', units: 47, sideSlots: 2, powerW: 12000, weightKg: 1200 },
    { id: 'rack-42', name: '42U rack', units: 42, sideSlots: 2, powerW: 8000, weightKg: 1000 },
    { id: 'rack-48', name: '48U high-density rack', units: 48, sideSlots: 2, powerW: 20000, weightKg: 1500 },
  ];
  const FALLBACK_RACK_TYPE = DEFAULT_RACK_TYPES[0];

  /** Structured device fields, besides name, cluster and notes. */
  const FIELDS = [
    { key: 'serial', label: 'Serial number', csv: 'Serial number' },
    { key: 'asset', label: 'Asset tag', csv: 'Asset tag' },
    { key: 'ip', label: 'IP address', csv: 'IP address' },
    { key: 'owner', label: 'Owner', csv: 'Owner' },
  ];

  // Ordered so that the first few clusters get clearly distinct hues.
  const CLUSTER_COLORS = [
    '#2f6fdb', // cobalt
    '#e56b1f', // orange
    '#0f9d8a', // teal
    '#8a5cd6', // violet
    '#d9a21b', // amber
    '#d64545', // red
    '#3aa655', // green
    '#1f9fc9', // cyan
    '#d94c8a', // rose
    '#5b62d6', // indigo
    '#8aa82c', // olive
    '#9a6b3f', // brown
  ];

  // ---------------------------------------------------------------- helpers

  const clone = (v) => JSON.parse(JSON.stringify(v));
  const pad2 = (n) => String(n).padStart(2, '0');
  /** A trimmed string of at most `max` characters; '' for anything else. */
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  /** "1 rack", "3 racks"; `many` for irregular plurals. */
  const plural = (n, word, many) => `${n} ${n === 1 ? word : many || word + 's'}`;
  const namesOf = (list) => new Set(list.map((x) => x.name));

  /** Lowercase ASCII words joined by dashes, for file names and ids: "Halle Süd 2" → halle-sud-2. */
  function slug(s, max) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/, '')
      .slice(0, max || 60)
      .replace(/-+$/, '');
  }

  function clampInt(v, lo, hi, dflt) {
    const n = Math.round(Number(v));
    return v === null || v === '' || !Number.isFinite(n) ? dflt : Math.max(lo, Math.min(hi, n));
  }
  function clampNum(v, lo, hi, dflt) {
    const n = Number(v);
    return v === null || v === '' || v === undefined || !Number.isFinite(n) ? dflt : Math.max(lo, Math.min(hi, Math.round(n * 100) / 100));
  }

  let uidCounter = 0;
  function uid(prefix) {
    uidCounter = (uidCounter + 1) % 1679616;
    return `${prefix}-${Date.now().toString(36)}${uidCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  /** The first of make(start), make(start + 1), … that is not in `used`. */
  function firstFree(used, start, make) {
    let i = start;
    while (used.has(make(i))) i++;
    return make(i);
  }

  /** Smallest `${prefix}${k}` not in `used`. */
  function nextId(prefix, used) {
    return firstFree(used, 1, (k) => prefix + k);
  }

  function normalizeHex(value) {
    if (typeof value !== 'string') return null;
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
    if (!m) return null;
    let hex = m[1].toLowerCase();
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    return '#' + hex;
  }

  /** Letters for the n-th row: 0 → A, 25 → Z, 26 → AA. */
  function letters(n) {
    let s = '';
    let k = n + 1;
    while (k > 0) {
      k--;
      s = String.fromCharCode(65 + (k % 26)) + s;
      k = Math.floor(k / 26);
    }
    return s;
  }

  // ---------------------------------------------------------------- lookups

  function typeOf(project, id) {
    if (id === RESERVED.id) return RESERVED;
    return (project && project.deviceTypes ? project.deviceTypes.find((t) => t.id === id) : null) || null;
  }
  /** Device types offered for placement: the plan's catalog, then reserved space. */
  function placeableTypes(project) {
    return project.deviceTypes.concat([RESERVED]);
  }
  function rackTypeById(project, id) {
    return project.rackTypes.find((t) => t.id === id) || null;
  }
  function clusterById(project, id) {
    return id ? project.clusters.find((c) => c.id === id) || null : null;
  }
  function deviceById(project, id) {
    return project.devices.find((d) => d.id === id) || null;
  }
  function floorById(project, id) {
    return project.floors.find((f) => f.id === id) || null;
  }

  /** Every row in order, with its floor and positions. */
  function allRows(project) {
    const out = [];
    project.floors.forEach((floor, floorIndex) =>
      floor.rows.forEach((row, rowIndex) => out.push({ row, floor, rowIndex, floorIndex, sheet: out.length }))
    );
    return out;
  }
  /** Every rack in order, with its row, floor and position in the row. */
  function allRacks(project) {
    const out = [];
    project.floors.forEach((floor, floorIndex) =>
      floor.rows.forEach((row, rowIndex) => row.racks.forEach((rack, index) => out.push({ rack, row, floor, index, rowIndex, floorIndex })))
    );
    return out;
  }
  function locateRow(project, rowId) {
    for (let fi = 0; fi < project.floors.length; fi++) {
      const floor = project.floors[fi];
      const ri = floor.rows.findIndex((r) => r.id === rowId);
      if (ri >= 0) return { row: floor.rows[ri], floor, rowIndex: ri, floorIndex: fi };
    }
    return null;
  }
  function rowById(project, id) {
    const pos = locateRow(project, id);
    return pos ? pos.row : null;
  }
  function locateRack(project, rackId) {
    for (let fi = 0; fi < project.floors.length; fi++) {
      const floor = project.floors[fi];
      for (let ri = 0; ri < floor.rows.length; ri++) {
        const row = floor.rows[ri];
        const index = row.racks.findIndex((r) => r.id === rackId);
        if (index >= 0) return { rack: row.racks[index], row, floor, index, rowIndex: ri, floorIndex: fi };
      }
    }
    return null;
  }
  function rackById(project, id) {
    const pos = locateRack(project, id);
    return pos ? pos.rack : null;
  }
  /** Ids of all floors, rows and racks; they share one id space. */
  function structureIds(project) {
    const ids = new Set();
    for (const f of project.floors) {
      ids.add(f.id);
      for (const r of f.rows) {
        ids.add(r.id);
        for (const k of r.racks) ids.add(k.id);
      }
    }
    return ids;
  }

  const asRack = (project, rack) => (typeof rack === 'string' ? rackById(project, rack) : rack);
  function rackTypeOf(project, rack) {
    const r = asRack(project, rack);
    return (r && rackTypeById(project, r.type)) || project.rackTypes[0] || FALLBACK_RACK_TYPE;
  }
  function rackUnits(project, rack) {
    return rackTypeOf(project, rack).units;
  }
  function rackSideSlots(project, rack) {
    return rackTypeOf(project, rack).sideSlots;
  }
  /** How many side slots fit along a rack of `units`. */
  function maxSideSlots(units) {
    return Math.max(0, Math.min(LIMITS.sideSlots, Math.floor((units - 1) / SIDE_SLOT_SPAN)));
  }

  function heightOf(project, typeId, height) {
    const t = typeOf(project, typeId);
    if (!t) return 1;
    return t.variable ? clampInt(height, 1, LIMITS.unitsMax, 1) : t.height;
  }
  function deviceHeight(project, d) {
    return heightOf(project, d.type, d.height);
  }
  function deviceSpan(project, d) {
    return [d.loc.at, d.loc.at + deviceHeight(project, d) - 1];
  }
  function powerOf(project, d) {
    if (d.powerW !== null && d.powerW !== undefined) return d.powerW;
    const t = typeOf(project, d.type);
    return t ? t.powerW : 0;
  }
  function weightOf(project, d) {
    if (d.weightKg !== null && d.weightKg !== undefined) return d.weightKg;
    const t = typeOf(project, d.type);
    return t ? t.weightKg : 0;
  }

  // --------------------------------------------------------------- catalogs

  /** A valid device type from untrusted input (the id is left to the caller). */
  function cleanDeviceType(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const label = str(r.label, 60) || 'Device';
    return {
      id: str(String(r.id == null ? '' : r.id), 40),
      label,
      tag: (str(r.tag, 12) || label.split(/\s+/)[0].slice(0, 12)).toUpperCase(),
      spec: str(r.spec, 60),
      height: clampInt(r.height, 1, LIMITS.deviceHeight, 1),
      face: FACE_IDS.has(r.face) ? r.face : 'generic',
      defaultName: str(r.defaultName, 80) || `${slug(label, 20) || 'dev'}-01`,
      powerW: clampNum(r.powerW, 0, 100000, 0),
      weightKg: clampNum(r.weightKg, 0, 5000, 0),
    };
  }

  /** A valid rack type from untrusted input (the id is left to the caller). */
  function cleanRackType(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const units = clampInt(r.units, LIMITS.unitsMin, LIMITS.unitsMax, RACK_UNITS);
    return {
      id: str(String(r.id == null ? '' : r.id), 40),
      name: str(r.name, 60) || `${units}U rack`,
      units,
      sideSlots: clampInt(r.sideSlots, 0, maxSideSlots(units), Math.min(SIDE_SLOTS, maxSideSlots(units))),
      powerW: clampNum(r.powerW, 0, 1000000, 0),
      weightKg: clampNum(r.weightKg, 0, 100000, 0),
    };
  }

  function formatTypeSpec(type, height) {
    if (type.variable) return height ? `${height}U · ${type.spec}` : `any height · ${type.spec}`;
    return type.spec ? `${type.height}U · ${type.spec}` : `${type.height}U`;
  }

  function uniqueLabel(list, key, base) {
    const used = new Set(list.map((x) => x[key]));
    return used.has(base) ? firstFree(used, 2, (i) => `${base} ${i}`) : base;
  }

  /** Adds a device type from `template`; null when the catalog is full. */
  function addDeviceType(project, template) {
    if (project.deviceTypes.length >= LIMITS.deviceTypes) return null;
    const t = cleanDeviceType(template);
    t.id = nextId('t', new Set(project.deviceTypes.map((x) => x.id)));
    t.label = uniqueLabel(project.deviceTypes, 'label', t.label);
    project.deviceTypes.push(t);
    return t;
  }

  /**
   * Changes a device type. Returns an error message and leaves the plan
   * unchanged when placed devices would no longer fit.
   */
  function updateDeviceType(project, id, changes) {
    const i = project.deviceTypes.findIndex((t) => t.id === id);
    if (i < 0) return 'Unknown device type';
    const before = project.deviceTypes[i];
    const next = cleanDeviceType(Object.assign({}, before, changes));
    next.id = id;
    project.deviceTypes[i] = next;
    if (next.height !== before.height) {
      const racks = new Set(project.devices.filter((d) => d.type === id).map((d) => d.loc.rack));
      const problem = layoutProblem(project, racks);
      if (problem) {
        project.deviceTypes[i] = before;
        return `${next.height}U does not fit: ${problem}`;
      }
    }
    return null;
  }

  /** Removes a device type together with its devices. */
  function deleteDeviceType(project, id) {
    project.deviceTypes = project.deviceTypes.filter((t) => t.id !== id);
    project.devices = project.devices.filter((d) => d.type !== id);
  }

  /**
   * Moves item `i` of list `from` to position `toIndex` of list `to` (the
   * end when null; `to` may be `from`). Between two lists, `from` keeps at
   * least one item and `to` takes at most `max`.
   */
  function moveItem(from, i, to, toIndex, max) {
    if (i < 0 || (to !== from && (to.length >= max || from.length <= 1))) return false;
    const [item] = from.splice(i, 1);
    to.splice(Math.max(0, Math.min(to.length, toIndex == null ? to.length : toIndex)), 0, item);
    return true;
  }

  function moveType(list, id, toIndex) {
    const i = list.findIndex((t) => t.id === id);
    return i !== Math.max(0, Math.min(list.length - 1, toIndex)) && moveItem(list, i, list, toIndex);
  }
  /** Moves a device type to position `toIndex` of the catalog; the parts panel follows this order. */
  function moveDeviceType(project, id, toIndex) {
    return moveType(project.deviceTypes, id, toIndex);
  }
  /** Moves a rack type to position `toIndex`; the first one is used for racks in new rows. */
  function moveRackType(project, id, toIndex) {
    return moveType(project.rackTypes, id, toIndex);
  }

  function addRackType(project, template) {
    if (project.rackTypes.length >= LIMITS.rackTypes) return null;
    const t = cleanRackType(template);
    t.id = nextId('rt', new Set(project.rackTypes.map((x) => x.id)));
    t.name = uniqueLabel(project.rackTypes, 'name', t.name);
    project.rackTypes.push(t);
    return t;
  }

  /** Changes a rack type; refuses (with a message) when devices would not fit. */
  function updateRackType(project, id, changes) {
    const i = project.rackTypes.findIndex((t) => t.id === id);
    if (i < 0) return 'Unknown rack type';
    const before = project.rackTypes[i];
    const next = cleanRackType(Object.assign({}, before, changes));
    next.id = id;
    project.rackTypes[i] = next;
    const racks = new Set(allRacks(project).filter((r) => r.rack.type === id).map((r) => r.rack.id));
    const problem = layoutProblem(project, racks);
    if (problem) {
      project.rackTypes[i] = before;
      return problem;
    }
    return null;
  }

  function rackTypeUse(project, id) {
    return allRacks(project).filter((r) => r.rack.type === id).length;
  }

  /** Removes an unused rack type; returns an error message otherwise. */
  function deleteRackType(project, id) {
    const n = rackTypeUse(project, id);
    if (n) return `${n} rack${n === 1 ? ' uses' : 's use'} this type`;
    if (project.rackTypes.length <= 1) return 'A plan needs at least one rack type';
    project.rackTypes = project.rackTypes.filter((t) => t.id !== id);
    return null;
  }

  /** Gives a rack another type; refuses when its devices would not fit. */
  function setRackType(project, rackId, typeId) {
    const rack = rackById(project, rackId);
    if (!rack || !rackTypeById(project, typeId)) return 'Unknown rack or rack type';
    const before = rack.type;
    rack.type = typeId;
    const problem = layoutProblem(project, new Set([rackId]));
    if (problem) {
      rack.type = before;
      return problem;
    }
    return null;
  }

  // ------------------------------------------------------------- structure

  function nextFloorName(project) {
    return firstFree(namesOf(project.floors), project.floors.length + 1, (i) => `Floor ${i}`);
  }
  function nextRowName(floor) {
    return firstFree(namesOf(floor.rows), floor.rows.length, (i) => `Row ${letters(i)}`);
  }

  /** Short code of a row for rack names: "Row C" → C; on floor 2 → 2C. */
  function rowCode(project, rowId) {
    const pos = locateRow(project, rowId);
    if (!pos) return 'A';
    const m = /^row\s+([a-z0-9]{1,3})$/i.exec(pos.row.name.trim());
    const code = m ? m[1].toUpperCase() : letters(pos.rowIndex);
    return (pos.floorIndex > 0 ? String(pos.floorIndex + 1) : '') + code;
  }
  /** Name for the rack at `index` of a row (Rack A01, Rack A02, …). */
  function defaultRackName(project, rowId, index) {
    return `Rack ${rowCode(project, rowId)}${pad2(index + 1)}`;
  }
  function nextRackName(project, rowId) {
    const racks = (rowById(project, rowId) || { racks: [] }).racks;
    return firstFree(namesOf(racks), racks.length, (i) => defaultRackName(project, rowId, i));
  }

  /** A plan with the standard catalog and nothing on it, not even a floor; `props` overrides. */
  function newProjectShell(props) {
    return Object.assign(
      {
        version: SCHEMA_VERSION,
        name: 'Untitled rack plan',
        info: { site: '', author: '', revision: '' },
        deviceTypes: clone(DEFAULT_DEVICE_TYPES),
        rackTypes: clone(DEFAULT_RACK_TYPES),
        floors: [],
        clusters: [],
        devices: [],
        meta: {},
      },
      props
    );
  }

  function clampRackCount(n) {
    return clampInt(n, 1, LIMITS.racks, DEFAULT_RACKS);
  }

  /** A plan with one floor and one row of `rackCount` empty 47U racks. */
  function createEmptyProject(rackCount) {
    const p = newProjectShell();
    addFloor(p, { racks: rackCount ? clampRackCount(rackCount) : DEFAULT_RACKS });
    return p;
  }

  /** Same floors, rows, racks and catalog as `project`, without devices or clusters. */
  function copyLayout(project) {
    const p = clone(project);
    p.devices = [];
    p.clusters = [];
    p.meta = {};
    p.name = `${project.name} (layout)`;
    return p;
  }

  /**
   * Inserts a floor without rows at `index` (default: the end), named `name`
   * or Floor N. Null when the plan has six floors.
   */
  function insertFloor(project, name, index) {
    if (project.floors.length >= LIMITS.floors) return null;
    const floor = { id: nextId('f', structureIds(project)), name: str(name, 60) || nextFloorName(project), rows: [] };
    project.floors.splice(index == null ? project.floors.length : index, 0, floor);
    return floor;
  }

  /** Inserts a row without racks into `floor`, like insertFloor. Null when the floor has eight rows. */
  function insertRow(project, floor, name, index) {
    if (floor.rows.length >= LIMITS.rows) return null;
    const row = { id: nextId('row', structureIds(project)), name: str(name, 60) || nextRowName(floor), racks: [] };
    floor.rows.splice(index == null ? floor.rows.length : index, 0, row);
    return row;
  }

  /** Adds a floor with one row of racks; null when the plan has six floors. */
  function addFloor(project, opts) {
    const o = opts || {};
    const floor = insertFloor(project, o.name, o.index);
    if (floor) addRow(project, floor.id, { racks: o.racks == null ? DEFAULT_RACKS : o.racks, type: o.type });
    return floor;
  }

  /** Adds a row of racks to a floor; null when the floor has eight rows. */
  function addRow(project, floorId, opts) {
    const o = opts || {};
    const floor = floorById(project, floorId);
    const row = floor && insertRow(project, floor, o.name, o.index);
    if (!row) return null;
    const n = clampInt(o.racks, 1, LIMITS.racks, DEFAULT_RACKS);
    for (let i = 0; i < n; i++) addRack(project, row.id, { type: o.type });
    return row;
  }

  /**
   * Adds an empty rack to a row at `opts.index` (default: the end). It gets
   * `opts.type`, else the type of its neighbour, else the first rack type of
   * the catalog. Null when the row already has sixteen racks.
   */
  function addRack(project, rowId, opts) {
    const o = opts || {};
    const row = rowById(project, rowId);
    if (!row || row.racks.length >= LIMITS.racks) return null;
    const index = o.index == null ? row.racks.length : Math.max(0, Math.min(row.racks.length, o.index));
    const neighbour = row.racks[index - 1] || row.racks[index];
    const type =
      (o.type && rackTypeById(project, o.type) && o.type) ||
      (neighbour && rackTypeById(project, neighbour.type) && neighbour.type) ||
      project.rackTypes[0].id;
    const rack = { id: nextId('r', structureIds(project)), name: str(o.name, 60) || nextRackName(project, rowId), type };
    row.racks.splice(index, 0, rack);
    return rack;
  }

  /** Removes the devices standing in the racks of `rackIds` (a Set). */
  function removeDevicesIn(project, rackIds) {
    project.devices = project.devices.filter((d) => !rackIds.has(d.loc.rack));
  }

  /** Removes a rack and its devices. A row keeps at least one rack. */
  function removeRack(project, rackId) {
    const pos = locateRack(project, rackId);
    if (!pos || pos.row.racks.length <= 1) return false;
    pos.row.racks.splice(pos.index, 1);
    removeDevicesIn(project, new Set([rackId]));
    return true;
  }

  /**
   * Moves a rack, with its devices, to position `toIndex` of row `toRowId`
   * (the same row reorders it). A row keeps between 1 and 16 racks.
   */
  function moveRack(project, rackId, toRowId, toIndex) {
    const pos = locateRack(project, rackId);
    const target = rowById(project, toRowId);
    return !!pos && !!target && moveItem(pos.row.racks, pos.index, target.racks, toIndex, LIMITS.racks);
  }

  /** Renames the racks of a row by position: Rack A01, Rack A02, … */
  function renumberRacks(project, rowId) {
    const row = rowById(project, rowId);
    if (row) row.racks.forEach((r, i) => (r.name = defaultRackName(project, rowId, i)));
  }

  /** Adds or removes racks at the end of a row until it has `n` (1–16). */
  function setRowRackCount(project, rowId, n) {
    const row = rowById(project, rowId);
    if (!row) return;
    const count = clampRackCount(n);
    while (row.racks.length < count) addRack(project, rowId);
    while (row.racks.length > count) removeRack(project, row.racks[row.racks.length - 1].id);
  }

  /** Devices that setRowRackCount(project, rowId, n) would remove. */
  function devicesBeyond(project, rowId, n) {
    const row = rowById(project, rowId);
    if (!row) return [];
    const gone = new Set(row.racks.slice(clampRackCount(n)).map((r) => r.id));
    return project.devices.filter((d) => gone.has(d.loc.rack));
  }

  /** Removes a row with its racks and devices. A floor keeps at least one row. */
  function removeRow(project, rowId) {
    const pos = locateRow(project, rowId);
    if (!pos || pos.floor.rows.length <= 1) return false;
    const gone = rackIdsWithin(project, rowId);
    pos.floor.rows.splice(pos.rowIndex, 1);
    removeDevicesIn(project, gone);
    return true;
  }

  /** Moves a row to position `toIndex` on floor `toFloorId`. A floor keeps between 1 and 8 rows. */
  function moveRow(project, rowId, toFloorId, toIndex) {
    const pos = locateRow(project, rowId);
    const target = floorById(project, toFloorId);
    return !!pos && !!target && moveItem(pos.floor.rows, pos.rowIndex, target.rows, toIndex, LIMITS.rows);
  }

  /** Removes a floor with everything on it. A plan keeps at least one floor. */
  function removeFloor(project, floorId) {
    const i = project.floors.findIndex((f) => f.id === floorId);
    if (i < 0 || project.floors.length <= 1) return false;
    const gone = rackIdsWithin(project, floorId);
    project.floors.splice(i, 1);
    removeDevicesIn(project, gone);
    return true;
  }

  function moveFloor(project, floorId, toIndex) {
    return moveItem(project.floors, project.floors.findIndex((f) => f.id === floorId), project.floors, toIndex);
  }

  /** Rack ids in a rack, row or floor (whichever id matches). */
  function rackIdsWithin(project, id) {
    const out = new Set();
    for (const r of allRacks(project)) {
      if (r.rack.id === id || r.row.id === id || r.floor.id === id) out.add(r.rack.id);
    }
    return out;
  }
  function devicesWithin(project, id) {
    const racks = rackIdsWithin(project, id);
    return project.devices.filter((d) => racks.has(d.loc.rack));
  }

  // --------------------------------------------------------------- example

  function createExampleProject() {
    const p = newProjectShell();
    p.name = 'Hall 2 expansion';
    p.info = { site: 'Hall 2', author: 'Rackplanner', revision: 'A' };
    p.meta.example = true;
    p.deviceTypes.push(
      { id: 'gpu-server', label: 'GPU server', tag: 'GPU', spec: '8 × GPU', height: 4, face: 'gpu', defaultName: 'gpu-srv-01', powerW: 3000, weightKg: 65 },
      { id: 'patch-panel', label: 'Patch panel', tag: 'PATCH', spec: '24 × RJ45', height: 1, face: 'patch', defaultName: 'pp-01', powerW: 0, weightKg: 2 },
      { id: 'pdu', label: 'PDU', tag: 'PDU', spec: '12 × C13', height: 1, face: 'pdu', defaultName: 'pdu-01', powerW: 0, weightKg: 5 }
    );
    const rack = (id, name, type) => ({ id, name, type: type || 'rack-47' });
    p.floors = [
      {
        id: 'f1',
        name: 'Ground floor',
        rows: [
          { id: 'row1', name: 'Row A', racks: [rack('r1', 'Rack A01'), rack('r2', 'Rack A02'), rack('r3', 'Rack A03')] },
          { id: 'row2', name: 'Row B', racks: [rack('r4', 'Rack B01', 'rack-48'), rack('r5', 'Rack B02', 'rack-48'), rack('r6', 'Rack B03', 'rack-48')] },
        ],
      },
      {
        id: 'f2',
        name: 'First floor',
        rows: [{ id: 'row3', name: 'Row A', racks: [rack('r7', 'Rack 2A01', 'rack-42'), rack('r8', 'Rack 2A02', 'rack-42')] }],
      },
    ];
    p.clusters = [
      { id: 'c-net', name: 'Core network', color: '#d9a21b' },
      { id: 'c-kestrel', name: 'Kestrel HPC', color: '#2f6fdb' },
      { id: 'c-osprey', name: 'Osprey GPU', color: '#e56b1f' },
      { id: 'c-ceph', name: 'Ceph object store', color: '#0f9d8a' },
      { id: 'c-lustre', name: 'Lustre scratch', color: '#8a5cd6' },
      { id: 'c-heron', name: 'Heron AI', color: '#d94c8a' },
      { id: 'c-archive', name: 'Archive', color: '#1f9fc9' },
    ];
    let n = 0;
    const add = (type, name, cluster, rackId, kind, at, extra) =>
      p.devices.push(
        Object.assign(
          { id: `ex-${++n}`, type, name, cluster, notes: '', serial: '', asset: '', ip: '', owner: '', powerW: null, weightKg: null, loc: { rack: rackId, kind, at } },
          extra
        )
      );

    // Row A: every rack gets a management switch and a high-speed leaf on top.
    ['r1', 'r2', 'r3'].forEach((r, i) => {
      add('switch-rj45', `sw-mgmt-a0${i + 1}`, 'c-net', r, 'u', 1);
      add('switch-qsfp', `ib-leaf-a0${i + 1}`, 'c-net', r, 'u', 2);
    });
    add('switch-rj45', 'sw-bmc-a01', 'c-net', 'r1', 'side', 0);
    add('switch-rj45', 'sw-bmc-a03', 'c-net', 'r3', 'side', 0);
    for (let i = 0; i < 12; i++) add('compute-node', `cn-${String(i + 1).padStart(3, '0')}`, 'c-kestrel', 'r1', 'u', 4 + i * 2);
    for (let i = 0; i < 8; i++) add('compute-node', `gpu-${String(i + 1).padStart(3, '0')}`, 'c-osprey', 'r2', 'u', 4 + i * 2);
    for (let i = 0; i < 3; i++) add('storage-node', `ceph-0${i + 1}`, 'c-ceph', 'r2', 'u', 24 + i * 4);
    add('storage-node', 'oss-01', 'c-lustre', 'r3', 'u', 4);
    add('storage-node', 'oss-02', 'c-lustre', 'r3', 'u', 8);
    for (let i = 0; i < 4; i++) add('storage-enclosure', `jbod-0${i + 1}`, 'c-lustre', 'r3', 'u', 12 + i * 4);

    // Row B: core network, then GPU servers with room kept for the next batch.
    add('patch-panel', 'pp-b01-1', null, 'r4', 'u', 1);
    add('patch-panel', 'pp-b01-2', null, 'r4', 'u', 2);
    add('switch-qsfp', 'core-sw-01', 'c-net', 'r4', 'u', 4);
    add('switch-qsfp', 'core-sw-02', 'c-net', 'r4', 'u', 5);
    add('switch-rj45', 'sw-mgmt-b01', 'c-net', 'r4', 'u', 6);
    add('reserved', 'Core expansion', null, 'r4', 'u', 8, { height: 6, notes: 'Second spine pair, next budget year' });
    for (const r of ['r4', 'r5', 'r6']) {
      const k = r.slice(1) - 3;
      add('pdu', `pdu-b0${k}-a`, null, r, 'side', 0);
      add('pdu', `pdu-b0${k}-b`, null, r, 'side', 1);
    }
    add('switch-qsfp', 'ib-leaf-b02', 'c-heron', 'r5', 'u', 1);
    add('switch-qsfp', 'ib-leaf-b03', 'c-heron', 'r6', 'u', 1);
    for (let i = 0; i < 3; i++) add('gpu-server', `gpu-srv-0${i + 1}`, 'c-heron', 'r5', 'u', 3 + i * 4);
    for (let i = 0; i < 3; i++) add('gpu-server', `gpu-srv-0${i + 4}`, 'c-heron', 'r6', 'u', 3 + i * 4);
    add('reserved', 'GPU batch 2', 'c-heron', 'r6', 'u', 16, { height: 8, powerW: 6000, notes: 'Two more GPU servers, power already booked' });

    // First floor: an archive on smaller racks.
    add('switch-rj45', 'sw-arc-01', 'c-archive', 'r7', 'u', 1);
    add('storage-node', 'arc-01', 'c-archive', 'r7', 'u', 3);
    add('storage-node', 'arc-02', 'c-archive', 'r8', 'u', 3);
    for (let i = 0; i < 4; i++) add('storage-enclosure', `arc-jbod-0${i + 1}`, 'c-archive', i < 2 ? 'r7' : 'r8', 'u', 7 + (i % 2) * 4);
    return p;
  }

  /** True when the plan still equals the example (the notice flag aside). */
  function isPristineExample(project) {
    const ex = createExampleProject();
    const pick = (p) => JSON.stringify([p.name, p.info, p.deviceTypes, p.rackTypes, p.floors, p.clusters, p.devices]);
    return pick(project) === pick(ex);
  }

  // -------------------------------------------------------------- placement

  function formatSpan(top, bottom) {
    return top === bottom ? `U${top}` : `U${top}–${bottom}`;
  }

  /** Units of a rack occupied by devices not in `ignore` (index = unit number). */
  function rackGrid(project, rackId, ignore) {
    const skip = ignore instanceof Set ? ignore : new Set([].concat(ignore || []));
    const units = rackUnits(project, rackId);
    const grid = new Uint8Array(units + 2);
    for (const d of project.devices) {
      if (d.loc.rack !== rackId || d.loc.kind !== 'u' || skip.has(d.id)) continue;
      const [b, t] = deviceSpan(project, d);
      for (let u = Math.max(1, b); u <= Math.min(units, t); u++) grid[u] = 1;
    }
    return grid;
  }

  /** True when units `at` … `at + h - 1` are inside the rack of `grid` (from rackGrid) and free. */
  function spanFree(grid, at, h) {
    if (at < 1 || at + h - 1 > grid.length - 2) return false;
    for (let u = at; u < at + h; u++) if (grid[u]) return false;
    return true;
  }

  /**
   * Checks whether a device of `typeId` fits at `loc`. Devices listed in
   * `ignore` (an id or array of ids) are treated as absent, which is how a
   * device is checked against its own new position when moving. `height`
   * applies to reserved space only.
   */
  function canPlace(project, typeId, loc, ignore, height) {
    const skip = new Set([].concat(ignore || []));
    const type = typeOf(project, typeId);
    if (!type) return { ok: false, reason: 'Unknown device type' };
    const rack = loc ? rackById(project, loc.rack) : null;
    if (!rack) return { ok: false, reason: 'Drop it on a rack' };
    const h = heightOf(project, typeId, height);

    if (loc.kind === 'side') {
      const slots = rackSideSlots(project, rack);
      if (!slots) return { ok: false, reason: `${rack.name} has no side slots` };
      if (!Number.isInteger(loc.at) || loc.at < 0 || loc.at >= slots) return { ok: false, reason: 'There is no such side slot' };
      if (h !== 1) return { ok: false, reason: 'Side slots take 1U devices only' };
      const other = project.devices.find((d) => !skip.has(d.id) && d.loc.rack === loc.rack && d.loc.kind === 'side' && d.loc.at === loc.at);
      if (other) return { ok: false, reason: `Side slot V${loc.at + 1} holds ${other.name}`, conflict: other.id };
      return { ok: true };
    }

    if (loc.kind !== 'u') return { ok: false, reason: 'Unknown mounting position' };
    const units = rackUnits(project, rack);
    const top = loc.at;
    const bottom = loc.at + h - 1;
    if (!Number.isInteger(top) || top < 1 || bottom > units) {
      return { ok: false, reason: `A ${h}U device must sit within U1–${units}` };
    }
    for (const d of project.devices) {
      if (skip.has(d.id) || d.loc.rack !== loc.rack || d.loc.kind !== 'u') continue;
      const [b, t] = deviceSpan(project, d);
      if (b <= bottom && top <= t) return { ok: false, reason: `Overlaps ${d.name} at ${formatSpan(b, t)}`, conflict: d.id };
    }
    return { ok: true };
  }

  /**
   * Finds up to `count` free positions (lowest unit number of each device)
   * for devices of `typeId` in a rack, starting at `startU` and stacking
   * toward higher unit numbers (dir > 0, downward in the rack) or lower ones
   * (dir < 0, upward). Occupied units are skipped.
   */
  function planPositions(project, typeId, rackId, startU, count, dir, ignore, height) {
    if (!typeOf(project, typeId) || !rackById(project, rackId)) return [];
    const h = heightOf(project, typeId, height);
    const grid = rackGrid(project, rackId, ignore);
    const units = grid.length - 2;
    const step = dir < 0 ? -1 : 1;
    const out = [];
    let u = startU;
    while (out.length < count && u >= 1 && u + h - 1 <= units) {
      if (spanFree(grid, u, h)) {
        out.push(u);
        for (let k = u; k < u + h; k++) grid[k] = 1;
        u += step * h;
      } else {
        u += step;
      }
    }
    return out;
  }

  /**
   * Plans `count` devices spread evenly over `rackIds`, each rack stacked
   * from `startU` as in planPositions. When a rack runs out of space the
   * others take the rest. Returns [{ rack, at }] rack by rack; fewer than
   * `count` when the racks are full.
   */
  function planSpread(project, typeId, rackIdsList, startU, count, dir, height) {
    const racks = rackIdsList.filter((id) => rackById(project, id));
    if (!racks.length || !typeOf(project, typeId)) return [];
    const h = heightOf(project, typeId, height);
    const avail = racks.map((id) => {
      const units = rackUnits(project, id);
      const start = Math.max(1, Math.min(units - h + 1, startU));
      return planPositions(project, typeId, id, start, count, dir, null, height);
    });
    const k = racks.length;
    const take = racks.map((_, i) => Math.min(avail[i].length, Math.floor(count / k) + (i < count % k ? 1 : 0)));
    let rest = count - take.reduce((a, b) => a + b, 0);
    while (rest > 0) {
      let progressed = false;
      for (let i = 0; i < k && rest > 0; i++) {
        if (take[i] < avail[i].length) {
          take[i]++;
          rest--;
          progressed = true;
        }
      }
      if (!progressed) break;
    }
    const out = [];
    racks.forEach((rack, i) => avail[i].slice(0, take[i]).forEach((at) => out.push({ rack, at })));
    return out;
  }

  /** All positions in a rack where a device of `typeId` fits, side slots first, then top to bottom. */
  function validLocs(project, typeId, rackId, ignore, height) {
    const type = typeOf(project, typeId);
    const out = [];
    if (!type || !rackById(project, rackId)) return out;
    const h = heightOf(project, typeId, height);
    if (h === 1) {
      for (let s = 0; s < rackSideSlots(project, rackId); s++) {
        const loc = { rack: rackId, kind: 'side', at: s };
        if (canPlace(project, typeId, loc, ignore, height).ok) out.push(loc);
      }
    }
    const grid = rackGrid(project, rackId, ignore);
    for (let u = 1; u + h - 1 <= grid.length - 2; u++) {
      if (spanFree(grid, u, h)) out.push({ rack: rackId, kind: 'u', at: u });
    }
    return out;
  }

  /** Nearest free U position with a higher (dir > 0, further down) or lower (dir < 0, further up) number. */
  function nudgeTarget(project, device, dir) {
    const moves = groupNudge(project, [device.id], dir);
    return moves ? moves[0].loc : null;
  }

  /** Free position closest to `near` (a U number) in a rack, or null. */
  function nearestLoc(project, typeId, rackId, near, ignore, preferSide, height) {
    const locs = validLocs(project, typeId, rackId, ignore, height);
    if (!locs.length) return null;
    if (preferSide) {
      const side = locs.find((l) => l.kind === 'side');
      if (side) return side;
    }
    const inRack = locs.filter((l) => l.kind === 'u');
    if (!inRack.length) return locs[0];
    return inRack.reduce((best, l) => (Math.abs(l.at - near) < Math.abs(best.at - near) ? l : best));
  }

  /**
   * Checks moving several devices at once, each to its own `loc`. Every
   * device is checked against the devices that stay and against the other
   * moved ones in their new places.
   */
  function canMoveAll(project, moves) {
    const ids = new Set(moves.map((m) => m.id));
    const scratch = Object.assign({}, project, { devices: project.devices.filter((d) => !ids.has(d.id)) });
    for (const m of moves) {
      const d = deviceById(project, m.id);
      if (!d) return { ok: false, reason: 'Unknown device' };
      const r = canPlace(scratch, d.type, m.loc, null, d.height);
      if (!r.ok) return Object.assign({ device: d.id }, r, { reason: `${d.name}: ${r.reason}` });
      scratch.devices.push(Object.assign({}, d, { loc: m.loc }));
    }
    return { ok: true };
  }

  /**
   * Checks adding new devices ([{ type, height, loc }]) at once: each against
   * the plan and against the ones before it.
   */
  function canAddAll(project, items) {
    const scratch = Object.assign({}, project, { devices: project.devices.slice() });
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const r = canPlace(scratch, it.type, it.loc, null, it.height);
      if (!r.ok) return Object.assign({}, r, { reason: `${it.name || 'A copy'}: ${r.reason}` });
      scratch.devices.push({ id: `__add-${i}`, type: it.type, height: it.height, name: it.name || '', loc: it.loc });
    }
    return { ok: true };
  }

  /**
   * Moves for shifting devices by `dRack` racks within their rows and `dU`
   * units (side-slot devices only change racks). Null when a device would
   * leave its row.
   */
  function shiftMoves(project, ids, dRack, dU) {
    const moves = [];
    for (const id of ids) {
      const d = deviceById(project, id);
      if (!d) continue;
      const pos = locateRack(project, d.loc.rack);
      const target = pos && pos.row.racks[pos.index + dRack];
      if (!target) return null;
      moves.push({ id, loc: { rack: target.id, kind: d.loc.kind, at: d.loc.kind === 'u' ? d.loc.at + dU : d.loc.at } });
    }
    return moves;
  }

  /**
   * Smallest shift of the selected rack-unit devices up (dir < 0) or down
   * (dir > 0) at which all of them fit, as moves; null if there is none.
   */
  function groupNudge(project, ids, dir) {
    const set = new Set(ids);
    const moving = project.devices.filter((d) => set.has(d.id) && d.loc.kind === 'u');
    if (!moving.length) return null;
    const grids = new Map();
    for (const d of moving) if (!grids.has(d.loc.rack)) grids.set(d.loc.rack, rackGrid(project, d.loc.rack, set));
    for (let k = 1; k <= LIMITS.unitsMax; k++) {
      let fits = true;
      for (const d of moving) {
        const h = deviceHeight(project, d);
        const g = grids.get(d.loc.rack);
        const at = d.loc.at + k * dir;
        // Further shifts only take it further out of its rack.
        if (at < 1 || at + h - 1 > g.length - 2) return null;
        if (!spanFree(g, at, h)) {
          fits = false;
          break;
        }
      }
      if (fits) return moving.map((d) => ({ id: d.id, loc: { rack: d.loc.rack, kind: 'u', at: d.loc.at + k * dir } }));
    }
    return null;
  }

  /**
   * Where copies of the devices in `ids` fit as a block, keeping their
   * spacing: below them in their racks, else above, else in the nearest
   * racks of their rows (same height first). Side-slot devices take the same
   * slot or another free one in their target rack. Returns [{ id, loc }]
   * with `id` the original's, or null when there is no room.
   */
  function copyTargets(project, ids) {
    const set = new Set(ids);
    const devs = sortedDevices(project).filter((d) => set.has(d.id));
    if (!devs.length) return null;
    const grids = new Map();
    const grid = (rackId) => {
      if (!grids.has(rackId)) grids.set(rackId, rackGrid(project, rackId));
      return grids.get(rackId);
    };
    const sideTaken = (rackId) => new Set(project.devices.filter((d) => d.loc.rack === rackId && d.loc.kind === 'side').map((d) => d.loc.at));
    const attempt = (dRack, dU) => {
      const claimed = new Map();
      const out = [];
      for (const d of devs) {
        const pos = locateRack(project, d.loc.rack);
        const target = pos && pos.row.racks[pos.index + dRack];
        if (!target) return null;
        let mine = claimed.get(target.id);
        if (!mine) claimed.set(target.id, (mine = { units: new Set(), side: sideTaken(target.id) }));
        if (d.loc.kind === 'side') {
          if (deviceHeight(project, d) !== 1) return null;
          const slots = rackSideSlots(project, target);
          const order = [d.loc.at].concat(Array.from({ length: slots }, (_, i) => i));
          const at = order.find((s) => s < slots && !mine.side.has(s));
          if (at === undefined) return null;
          mine.side.add(at);
          out.push({ id: d.id, loc: { rack: target.id, kind: 'side', at } });
          continue;
        }
        const h = deviceHeight(project, d);
        const at = d.loc.at + dU;
        if (!spanFree(grid(target.id), at, h)) return null;
        for (let u = at; u < at + h; u++) if (mine.units.has(u)) return null;
        for (let u = at; u < at + h; u++) mine.units.add(u);
        out.push({ id: d.id, loc: { rack: target.id, kind: 'u', at } });
      }
      return out;
    };
    const tryShifts = (dRack) => {
      if (dRack !== 0) {
        const same = attempt(dRack, 0);
        if (same) return same;
      }
      for (let k = 1; k <= LIMITS.unitsMax; k++) {
        const down = attempt(dRack, k);
        if (down) return down;
      }
      for (let k = 1; k <= LIMITS.unitsMax; k++) {
        const up = attempt(dRack, -k);
        if (up) return up;
      }
      return null;
    };
    const found = tryShifts(0);
    if (found) return found;
    for (let n = 1; n < LIMITS.racks; n++) {
      for (const dRack of [n, -n]) {
        const r = tryShifts(dRack);
        if (r) return r;
      }
    }
    return null;
  }

  /**
   * Copies of devices for new places (`moves`: [{ id, loc }]), with new ids
   * and names that continue each series. The plan itself is not changed.
   */
  function copiesAt(project, moves) {
    const named = { devices: project.devices.slice() };
    return moves.map((m) => {
      const d = deviceById(project, m.id);
      const c = Object.assign(clone(d), { id: uid('d'), name: nextFreeName(named, d.name), loc: { rack: m.loc.rack, kind: m.loc.kind, at: m.loc.at } });
      named.devices.push(c);
      return c;
    });
  }

  /**
   * Adds copies of the devices in racks that `rackMap` maps (old rack id →
   * new rack id), at the same positions.
   */
  function copyDevicesInto(project, rackMap) {
    const moves = sortedDevices(project)
      .filter((d) => rackMap.has(d.loc.rack))
      .map((d) => ({ id: d.id, loc: Object.assign({}, d.loc, { rack: rackMap.get(d.loc.rack) }) }));
    project.devices.push(...copiesAt(project, moves));
  }

  /** Inserts a copy of a rack, with copies of its devices, right after it. Null when the row is full. */
  function duplicateRack(project, rackId) {
    const pos = locateRack(project, rackId);
    const rack = pos && addRack(project, pos.row.id, { index: pos.index + 1, type: pos.rack.type });
    if (rack) copyDevicesInto(project, new Map([[rackId, rack.id]]));
    return rack || null;
  }

  /**
   * Inserts a copy of row `source` (its racks, not their devices) into
   * `floor` at `index`, named `name` or the next free row name. Adds the
   * old → new rack ids to `rackMap`.
   */
  function copyRowInto(project, source, floor, index, name, rackMap) {
    const row = insertRow(project, floor, name, index);
    source.racks.forEach((r, i) => {
      const rack = { id: nextId('r', structureIds(project)), name: defaultRackName(project, row.id, i), type: r.type };
      row.racks.push(rack);
      rackMap.set(r.id, rack.id);
    });
    return row;
  }

  /** Inserts a copy of a row, with its racks and devices, right after it. Null when the floor is full. */
  function duplicateRow(project, rowId) {
    const pos = locateRow(project, rowId);
    if (!pos || pos.floor.rows.length >= LIMITS.rows) return null;
    const map = new Map();
    const row = copyRowInto(project, pos.row, pos.floor, pos.rowIndex + 1, '', map);
    copyDevicesInto(project, map);
    return row;
  }

  /** Inserts a copy of a floor, with everything on it, right after it. Null when the plan has six floors. */
  function duplicateFloor(project, floorId) {
    const i = project.floors.findIndex((f) => f.id === floorId);
    if (i < 0) return null;
    const source = project.floors[i];
    const floor = insertFloor(project, `${source.name} (copy)`, i + 1);
    if (!floor) return null;
    // Rows keep their names on the copied floor, and racks are named after them.
    const map = new Map();
    source.rows.forEach((r) => copyRowInto(project, r, floor, null, r.name, map));
    copyDevicesInto(project, map);
    return floor;
  }

  /**
   * Finds devices that don't fit their rack: outside its units or side
   * slots, or overlapping. Limited to `rackIdSet` when given. Returns a
   * message for the first problem, or null.
   */
  function layoutProblem(project, rackIdSet) {
    const grids = new Map();
    for (const d of project.devices) {
      if (rackIdSet && !rackIdSet.has(d.loc.rack)) continue;
      const rack = rackById(project, d.loc.rack);
      if (!rack) return `${d.name} is in an unknown rack`;
      let g = grids.get(rack.id);
      if (!g) {
        g = { units: new Array(rackUnits(project, rack) + 1).fill(null), side: new Array(rackSideSlots(project, rack)).fill(null) };
        grids.set(rack.id, g);
      }
      const h = deviceHeight(project, d);
      if (d.loc.kind === 'side') {
        if (d.loc.at >= g.side.length) return `${d.name} would lose its side slot in ${rack.name}`;
        if (h !== 1) return `${d.name} is too tall for a side slot`;
        if (g.side[d.loc.at]) return `${d.name} and ${g.side[d.loc.at]} share a side slot in ${rack.name}`;
        g.side[d.loc.at] = d.name;
        continue;
      }
      const top = d.loc.at;
      const bottom = top + h - 1;
      if (bottom >= g.units.length) return `${d.name} would stick out below U${g.units.length - 1} of ${rack.name}`;
      for (let u = top; u <= bottom; u++) {
        if (g.units[u]) return `${d.name} would overlap ${g.units[u]} in ${rack.name}`;
        g.units[u] = d.name;
      }
    }
    return null;
  }

  function formatPosition(project, loc, typeId, height) {
    if (loc.kind === 'side') return `V${loc.at + 1}`;
    return formatSpan(loc.at, loc.at + heightOf(project, typeId, height) - 1);
  }
  function formatLoc(project, loc, typeId, height) {
    const rack = rackById(project, loc.rack);
    const rackName = rack ? rack.name : 'Unknown rack';
    if (loc.kind === 'side') return `${rackName} · side slot V${loc.at + 1}`;
    return `${rackName} · ${formatPosition(project, loc, typeId, height)}`;
  }
  function formatDeviceLoc(project, d) {
    return formatLoc(project, d.loc, d.type, d.height);
  }
  /** "Ground floor · Row A" for a row, rack or device location. */
  function formatWhere(project, rackOrRowId) {
    const rack = locateRack(project, rackOrRowId);
    if (rack) return `${rack.floor.name} · ${rack.row.name}`;
    const row = locateRow(project, rackOrRowId);
    return row ? `${row.floor.name} · ${row.row.name}` : '';
  }

  // ------------------------------------------------------------------ names

  function parseSerial(name) {
    const m = /^(.*?)(\d+)(\D*)$/.exec(name);
    return m ? { head: m[1], num: parseInt(m[2], 10), width: m[2].length, tail: m[3] } : null;
  }

  function formatSerial(s, n) {
    return s.head + String(n).padStart(s.width, '0') + s.tail;
  }

  /** Like parseSerial; a name without a number starts a series: db → db-01, db-02, … */
  function seriesOf(name) {
    return parseSerial(name) || { head: name + '-', num: 1, width: 2, tail: '' };
  }

  /** `count` names counting up from `first` (cn-007 → cn-007, cn-008, …). */
  function nameSequence(first, count) {
    const name = String(first == null ? '' : first).trim();
    if (count <= 1) return [name];
    const s = seriesOf(name);
    return Array.from({ length: count }, (_, i) => formatSerial(s, s.num + i));
  }

  /**
   * Next name in the series `seed` belongs to: one past the highest number
   * already used with the same prefix and suffix, leaving room for `count`
   * consecutive names. With `inclusive`, `seed` itself may be returned.
   */
  function nextInSeries(project, seed, count, inclusive) {
    const used = namesOf(project.devices);
    const s = seriesOf(seed);
    let max = inclusive ? s.num - 1 : s.num;
    for (const name of used) {
      const o = parseSerial(name);
      if (o && o.head === s.head && o.tail === s.tail) max = Math.max(max, o.num);
    }
    let n = max + 1;
    const clash = (k) => {
      for (let i = 0; i < count; i++) if (used.has(formatSerial(s, k + i))) return true;
      return false;
    };
    while (clash(n)) n++;
    return formatSerial(s, n);
  }

  /**
   * Suggests name and cluster for new devices of `typeId` placed at `loc`.
   * The nearest device of the same type in the same rack is the reference
   * (dropping next to cn-012 of cluster Kestrel suggests cn-013, Kestrel);
   * otherwise the most recently added device of that type, otherwise the
   * type's default name. `cluster` is undefined when there is no reference.
   */
  function suggestPlacement(project, typeId, loc, count) {
    const type = typeOf(project, typeId);
    const n = Math.max(1, count || 1);
    const same = project.devices.filter((d) => d.type === typeId);
    const units = loc ? rackUnits(project, loc.rack) : RACK_UNITS;
    const slots = loc ? Math.max(1, rackSideSlots(project, loc.rack)) : SIDE_SLOTS;
    const pos = (l) => (l.kind === 'u' ? l.at : (l.at + 0.5) * (units / slots));
    let ref = null;
    if (loc) {
      for (const d of same) {
        if (d.loc.rack !== loc.rack) continue;
        if (!ref || Math.abs(pos(d.loc) - pos(loc)) < Math.abs(pos(ref.loc) - pos(loc))) ref = d;
      }
    }
    if (!ref && same.length) ref = same[same.length - 1];
    return {
      name: ref ? nextInSeries(project, ref.name, n, false) : nextInSeries(project, type ? type.defaultName : 'dev-01', n, true),
      cluster: ref ? ref.cluster : undefined,
    };
  }

  function suggestName(project, typeId, count) {
    return suggestPlacement(project, typeId, null, count).name;
  }

  /** Next unused name derived from `name` (for duplicates): cn-004 → cn-005, db → db-2. */
  function nextFreeName(project, name) {
    const used = namesOf(project.devices);
    const s = parseSerial(name);
    return s ? firstFree(used, s.num + 1, (n) => formatSerial(s, n)) : firstFree(used, 2, (i) => `${name}-${i}`);
  }

  function nextClusterColor(project) {
    const used = new Set(project.clusters.map((c) => c.color));
    return CLUSTER_COLORS.find((c) => !used.has(c)) || CLUSTER_COLORS[project.clusters.length % CLUSTER_COLORS.length];
  }

  function nextClusterName(project) {
    return firstFree(namesOf(project.clusters), project.clusters.length + 1, (i) => `Cluster ${i}`);
  }

  /** A new device with every field set; `props` overrides the defaults. */
  function newDevice(props) {
    return Object.assign(
      { id: uid('d'), type: '', name: '', cluster: null, notes: '', serial: '', asset: '', ip: '', owner: '', powerW: null, weightKg: null, loc: null },
      props
    );
  }

  // ------------------------------------------------------------- statistics

  function emptyStats(project, rack) {
    const rt = rackTypeOf(project, rack);
    return {
      units: rt.units,
      used: 0,
      reserved: 0,
      free: rt.units,
      largestFree: rt.units,
      sideUsed: 0,
      sideSlots: rt.sideSlots,
      count: 0,
      powerW: 0,
      powerBudgetW: rt.powerW,
      weightKg: 0,
      weightBudgetKg: rt.weightKg,
      overPower: false,
      overWeight: false,
    };
  }

  function finishStats(st, occupied) {
    let run = 0;
    st.largestFree = 0;
    for (let u = 1; u <= st.units; u++) {
      run = occupied[u] ? 0 : run + 1;
      st.largestFree = Math.max(st.largestFree, run);
    }
    st.free = st.units - st.used - st.reserved;
    st.powerW = Math.round(st.powerW * 100) / 100;
    st.weightKg = Math.round(st.weightKg * 100) / 100;
    st.overPower = st.powerBudgetW > 0 && st.powerW > st.powerBudgetW;
    st.overWeight = st.weightBudgetKg > 0 && st.weightKg > st.weightBudgetKg;
    return st;
  }

  /**
   * Usage of every rack in one pass: units used by devices and reserved,
   * free space, side slots, and power and weight against the rack type's
   * budgets. Reserved space counts its planned power and weight too.
   */
  function statsByRack(project) {
    const out = new Map();
    const occ = new Map();
    for (const { rack } of allRacks(project)) {
      const st = emptyStats(project, rack);
      out.set(rack.id, st);
      occ.set(rack.id, new Uint8Array(st.units + 2));
    }
    for (const d of project.devices) {
      const st = out.get(d.loc.rack);
      if (!st) continue;
      const reserved = d.type === RESERVED.id;
      st.powerW += powerOf(project, d);
      st.weightKg += weightOf(project, d);
      if (!reserved) st.count++;
      if (d.loc.kind === 'side') {
        st.sideUsed++;
        continue;
      }
      const [b, t] = deviceSpan(project, d);
      const grid = occ.get(d.loc.rack);
      for (let u = b; u <= Math.min(t, st.units); u++) grid[u] = 1;
      if (reserved) st.reserved += t - b + 1;
      else st.used += t - b + 1;
    }
    for (const [id, st] of out) finishStats(st, occ.get(id));
    return out;
  }

  function rackStats(project, rackId) {
    const rack = rackById(project, rackId);
    if (!rack) return null;
    const scoped = Object.assign({}, project, {
      floors: [{ id: '_', name: '', rows: [{ id: '_', name: '', racks: [rack] }] }],
      devices: project.devices.filter((d) => d.loc.rack === rackId),
    });
    return statsByRack(scoped).get(rackId);
  }

  /** Totals over several racks' stats (for a row, floor or the plan). */
  function sumStats(list) {
    const t = { racks: 0, units: 0, used: 0, reserved: 0, free: 0, sideUsed: 0, sideSlots: 0, count: 0, powerW: 0, powerBudgetW: 0, weightKg: 0, weightBudgetKg: 0, overPower: 0, overWeight: 0 };
    for (const s of list) {
      t.racks++;
      for (const k of ['units', 'used', 'reserved', 'free', 'sideUsed', 'sideSlots', 'count', 'powerW', 'powerBudgetW', 'weightKg', 'weightBudgetKg']) t[k] += s[k];
      if (s.overPower) t.overPower++;
      if (s.overWeight) t.overWeight++;
    }
    t.powerW = Math.round(t.powerW * 100) / 100;
    t.weightKg = Math.round(t.weightKg * 100) / 100;
    return t;
  }

  /** Stats of the racks within a rack, row or floor id (or the whole plan). */
  function statsWithin(project, id, byRack) {
    const all = byRack || statsByRack(project);
    const ids = id ? rackIdsWithin(project, id) : null;
    const list = [];
    for (const [rid, st] of all) if (!ids || ids.has(rid)) list.push(st);
    return sumStats(list);
  }

  /** Order of racks across the plan, for sorting. */
  function rackOrder(project) {
    const m = new Map();
    allRacks(project).forEach((r, i) => m.set(r.rack.id, i));
    return m;
  }

  /** Devices ordered by rack (in plan order), then top to bottom, then side slots. */
  function sortedDevices(project, rackId) {
    const order = rackOrder(project);
    const key = (d) => {
      const pos = d.loc.kind === 'u' ? d.loc.at : 1000 + d.loc.at;
      return (order.has(d.loc.rack) ? order.get(d.loc.rack) : 1e6) * 10000 + pos;
    };
    return project.devices.filter((d) => !rackId || d.loc.rack === rackId).sort((a, b) => key(a) - key(b));
  }

  /** Devices per rack id, in one pass. */
  function devicesByRack(project) {
    const m = new Map();
    for (const d of project.devices) {
      let list = m.get(d.loc.rack);
      if (!list) m.set(d.loc.rack, (list = []));
      list.push(d);
    }
    return m;
  }

  // ----------------------------------------------------------------- search

  function queryWords(query) {
    return String(query || '')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
  }

  /** Text a device can be found by: name, type, cluster and its fields. */
  function deviceHaystack(project, d, clusterNames) {
    const t = typeOf(project, d.type);
    const c = clusterNames ? clusterNames.get(d.cluster) : (clusterById(project, d.cluster) || {}).name;
    return [d.name, t ? t.label : '', c || '', d.serial, d.asset, d.ip, d.owner].join(' ').toLowerCase();
  }

  /** Predicate for devices matching `query` (every word must occur), or null for an empty query. */
  function deviceMatcher(project, query) {
    const words = queryWords(query);
    if (!words.length) return null;
    const names = new Map(project.clusters.map((c) => [c.id, c.name]));
    return (d) => {
      const text = deviceHaystack(project, d, names);
      return words.every((w) => text.includes(w));
    };
  }

  /**
   * Finds floors, rows, racks and devices whose names (and, for devices, type,
   * cluster, serial number, asset tag, IP address or owner) contain every word
   * of `query`. Each group is capped at `limit`; `counts` has the full numbers.
   */
  function search(project, query, limit) {
    const words = queryWords(query);
    const out = { floors: [], rows: [], racks: [], devices: [], counts: { floors: 0, rows: 0, racks: 0, devices: 0 } };
    if (!words.length) return out;
    const max = limit || 8;
    const hit = (text) => words.every((w) => text.includes(w));
    const push = (group, item) => {
      out.counts[group]++;
      if (out[group].length < (group === 'devices' ? max * 4 : max)) out[group].push(item);
    };
    project.floors.forEach((floor) => {
      if (hit(floor.name.toLowerCase())) push('floors', { kind: 'floor', id: floor.id, name: floor.name, detail: plural(floor.rows.length, 'row') });
      floor.rows.forEach((row) => {
        if (hit(`${row.name} ${floor.name}`.toLowerCase())) push('rows', { kind: 'row', id: row.id, name: row.name, detail: `${floor.name} · ${plural(row.racks.length, 'rack')}` });
        row.racks.forEach((rack) => {
          if (hit(rack.name.toLowerCase())) push('racks', { kind: 'rack', id: rack.id, name: rack.name, detail: `${floor.name} · ${row.name}` });
        });
      });
    });
    const match = deviceMatcher(project, query);
    for (const d of sortedDevices(project)) {
      if (!match(d)) continue;
      const pos = locateRack(project, d.loc.rack);
      push('devices', { kind: 'device', id: d.id, name: d.name, detail: `${pos.floor.name} · ${pos.row.name} · ${formatDeviceLoc(project, d)}` });
    }
    return out;
  }

  return {
    SCHEMA_VERSION,
    LIMITS,
    RACK_UNITS,
    SIDE_SLOTS,
    DEFAULT_RACKS,
    FACES,
    DEFAULT_DEVICE_TYPES,
    DEFAULT_RACK_TYPES,
    TYPE_TEMPLATES,
    RESERVED,
    FIELDS,
    CLUSTER_COLORS,
    clone,
    str,
    plural,
    slug,
    clampInt,
    clampNum,
    letters,
    uid,
    nextId,
    structureIds,
    normalizeHex,
    typeOf,
    placeableTypes,
    rackTypeById,
    rackTypeOf,
    rackUnits,
    rackSideSlots,
    maxSideSlots,
    clusterById,
    deviceById,
    floorById,
    rowById,
    rackById,
    allRows,
    allRacks,
    locateRow,
    locateRack,
    heightOf,
    deviceHeight,
    deviceSpan,
    powerOf,
    weightOf,
    cleanDeviceType,
    cleanRackType,
    formatTypeSpec,
    addDeviceType,
    updateDeviceType,
    deleteDeviceType,
    moveDeviceType,
    moveRackType,
    addRackType,
    updateRackType,
    rackTypeUse,
    deleteRackType,
    setRackType,
    defaultRackName,
    nextRackName,
    nextFloorName,
    nextRowName,
    newProjectShell,
    createEmptyProject,
    createExampleProject,
    copyLayout,
    isPristineExample,
    insertFloor,
    insertRow,
    addFloor,
    addRow,
    addRack,
    removeDevicesIn,
    removeRack,
    moveRack,
    renumberRacks,
    setRowRackCount,
    devicesBeyond,
    removeRow,
    moveRow,
    removeFloor,
    moveFloor,
    rackIdsWithin,
    devicesWithin,
    formatSpan,
    rackGrid,
    canPlace,
    planPositions,
    planSpread,
    validLocs,
    nudgeTarget,
    nearestLoc,
    canMoveAll,
    canAddAll,
    shiftMoves,
    groupNudge,
    copyTargets,
    copiesAt,
    duplicateRack,
    duplicateRow,
    duplicateFloor,
    layoutProblem,
    formatPosition,
    formatLoc,
    formatDeviceLoc,
    formatWhere,
    parseSerial,
    nameSequence,
    nextInSeries,
    suggestPlacement,
    suggestName,
    nextFreeName,
    nextClusterColor,
    nextClusterName,
    newDevice,
    statsByRack,
    rackStats,
    sumStats,
    statsWithin,
    sortedDevices,
    devicesByRack,
    deviceMatcher,
    search,
  };
});
