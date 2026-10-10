/*
 * Vendored from https://github.com/dennisklein/rackplanner — CC0 1.0 Universal (public domain).
 * Unmodified except this header.
 *
/*
 * Rackplanner: reading and writing plans.
 *
 * Validates untrusted plan files (all schema versions), serializes plans,
 * exports and imports CSV inventories and cable schedules, and packs plans
 * into share links. No DOM access; shared by the browser app and the Node
 * tests.
 */
(function (root, factory) {
  'use strict';
  // Only the cable CSVs need cabling.js, so it is looked up when they run.
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./model.js'), () => require('./cabling.js'));
  else (root.RP = root.RP || {}).io = factory(root.RP.model, () => root.RP.cabling);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (M, cabling) {
  'use strict';

  const L = M.LIMITS;
  const str = M.str;
  // Ids may be written as numbers in hand-made files; they are kept as strings.
  const idOf = (v) => (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)) ? String(v).trim().slice(0, 80) : '');
  const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

  // ------------------------------------------------------------ validation

  /**
   * Reads the device or rack types of a catalog (`kind` names them in
   * warnings). Every type needs its own id, not one of `taken`; `clean`
   * makes the rest valid. Null when the file has no such list.
   */
  function readTypes(list, kind, labelKey, clean, max, taken, warnings) {
    if (!Array.isArray(list)) return null;
    const out = [];
    const ids = new Set(taken);
    list.forEach((t, i) => {
      if (!isObj(t)) return;
      const label = str(t[labelKey], 60) || `#${i + 1}`;
      const id = idOf(t.id);
      if (!id) return void warnings.push(`Skipped ${kind} ${label}: it has no id.`);
      if (ids.has(id)) return void warnings.push(`Skipped ${kind} ${label}: its id “${id}” is used twice.`);
      if (out.length >= max) return void warnings.push(`Skipped ${kind} ${label}: a catalog holds ${max} types.`);
      ids.add(id);
      out.push(Object.assign(clean(t), { id }));
    });
    return out;
  }

  /**
   * Names tell cable types and transceivers apart in cable schedules: a
   * name used before gets a number no other entry has.
   */
  function uniqueNames(list, kind, warnings) {
    const used = new Set(list.map((t) => t.name));
    const seen = new Set();
    for (const t of list) {
      if (seen.has(t.name)) {
        const base = t.name.slice(0, 56);
        let i = 2;
        while (used.has(`${base} ${i}`)) i++;
        warnings.push(`Renamed the ${kind} ${t.name} to ${base} ${i}: the name is used twice.`);
        t.name = `${base} ${i}`;
        used.add(t.name);
      }
      seen.add(t.name);
    }
    return list;
  }

  /**
   * Builds floors, rows and racks. Returns a map from the file's rack ids to
   * the plan's. Version 1 and 2 files have a flat list of racks, which
   * becomes one row; their rack ids are mapped to r1..rN by position.
   */
  function readLayout(raw, p, warnings) {
    const rackIds = new Map();
    const defaultType = p.rackTypes[0].id;
    const rackType = (v, name) => {
      const id = idOf(v);
      if (id && p.rackTypes.some((t) => t.id === id)) return id;
      if (id) warnings.push(`${name} refers to unknown rack type “${id}” and gets ${M.rackTypeById(p, defaultType).name}.`);
      return defaultType;
    };

    if (Array.isArray(raw.floors)) {
      // Floors, rows and racks share one id space, so an id names one thing.
      const used = new Set();
      const claim = (fileId, prefix) => {
        const id = fileId && !used.has(fileId) ? fileId : M.nextId(prefix, used);
        used.add(id);
        return id;
      };
      const unnamed = new Set();
      let droppedFloors = 0;
      for (const f of raw.floors.filter(isObj)) {
        if (p.floors.length >= L.floors) {
          droppedFloors++;
          continue;
        }
        const floor = { id: claim(idOf(f.id), 'f'), name: str(f.name, 60) || M.nextFloorName(p), rowPitchM: M.clampNum(f.rowPitchM, 0.5, 50, M.DEFAULT_ROW_PITCH_M), rows: [] };
        let droppedRows = 0;
        for (const r of (Array.isArray(f.rows) ? f.rows : []).filter(isObj)) {
          if (floor.rows.length >= L.rows) {
            droppedRows++;
            continue;
          }
          const row = { id: claim(idOf(r.id), 'row'), name: str(r.name, 60) || M.nextRowName(floor), racks: [] };
          const racks = (Array.isArray(r.racks) ? r.racks : []).filter(isObj);
          if (racks.length > L.racks) warnings.push(`${floor.name} · ${row.name}: only the first ${L.racks} racks were kept.`);
          for (const k of racks.slice(0, L.racks)) {
            const name = str(k.name, 60);
            const fileId = idOf(k.id);
            const id = claim(fileId, 'r');
            if (fileId && !rackIds.has(fileId)) rackIds.set(fileId, id);
            else if (fileId) warnings.push(`Rack id “${fileId}” is used twice; devices go to the first rack with it.`);
            if (!name) unnamed.add(id);
            row.racks.push({ id, name, type: rackType(k.type, name || 'A rack'), trayM: M.clampNum(k.trayM, 0, 10, null), slackM: M.clampNum(k.slackM, 0, 10, null) });
          }
          if (row.racks.length) floor.rows.push(row);
          else warnings.push(`Skipped ${floor.name} · ${row.name}: it has no racks.`);
        }
        if (droppedRows) warnings.push(`${floor.name}: only the first ${L.rows} rows were kept.`);
        if (floor.rows.length) p.floors.push(floor);
        else warnings.push(`Skipped ${floor.name}: it has no rows.`);
      }
      if (droppedFloors) warnings.push(`Only the first ${L.floors} floors were kept.`);
      if (!p.floors.length) M.addFloor(p, { type: defaultType });
      // Racks without a name are named by position once their row exists.
      for (const { rack, row, index } of M.allRacks(p)) if (unnamed.has(rack.id)) rack.name = M.defaultRackName(p, row.id, index);
      return rackIds;
    }

    // Versions 1 and 2: one row.
    const rawRacks = Array.isArray(raw.racks) ? raw.racks.filter(isObj) : [];
    const n = rawRacks.length ? Math.min(rawRacks.length, L.racks) : M.DEFAULT_RACKS;
    M.addFloor(p, { racks: n, type: defaultType });
    const row = p.floors[0].rows[0];
    if (rawRacks.length) {
      rawRacks.slice(0, L.racks).forEach((r, i) => {
        if (str(r.name, 60)) row.racks[i].name = str(r.name, 60);
        const fileId = idOf(r.id) || row.racks[i].id;
        if (!rackIds.has(fileId)) rackIds.set(fileId, row.racks[i].id);
      });
      if (rawRacks.length > L.racks) warnings.push(`Only the first ${L.racks} racks were kept.`);
    } else {
      row.racks.forEach((r) => rackIds.set(r.id, r.id));
    }
    return rackIds;
  }

  /**
   * Files before version 4 have no ports, lengths or slack: standard types
   * (matched by id) get the standard values of the fields they lack.
   */
  function withStandard(list, standard, keys) {
    if (!Array.isArray(list)) return list;
    return list.map((t) => {
      const std = isObj(t) && standard.find((x) => x.id === idOf(t.id));
      if (!std) return t;
      const out = Object.assign({}, t);
      for (const k of keys) if (!(k in t)) out[k] = M.clone(std[k]);
      return out;
    });
  }

  /**
   * Reads clusters or networks into `out` (`make` builds one, seeing the
   * ones before it). Ids starting with "__" are reserved for the app and
   * replaced. Returns a map from the file's ids to the plan's.
   */
  function readGroups(list, kind, max, out, make, warnings) {
    const ids = new Map();
    (Array.isArray(list) ? list : []).forEach((c, i) => {
      if (!isObj(c)) return;
      const fileId = idOf(c.id);
      const label = str(c.name, 60) || `#${i + 1}`;
      if (!fileId) return void warnings.push(`Skipped ${kind} ${label}: it has no id.`);
      if (ids.has(fileId)) return void warnings.push(`Skipped ${kind} ${label}: its id “${fileId}” is used twice.`);
      if (out.length >= max) return void warnings.push(`Skipped ${kind} ${label}: a plan holds ${max} ${kind}s.`);
      const id = fileId.startsWith('__') ? M.uid(kind[0]) : fileId;
      ids.set(fileId, id);
      out.push(make(c, id));
    });
    return ids;
  }

  /**
   * Reads the cables of a file. Ends refer to devices by their id in the
   * file (`deviceIds` maps them to the plan's) and to ports by name. A
   * cable that would break the plan's rules is skipped with a warning.
   */
  function readCables(list, p, deviceIds, networkIds, warnings) {
    const ctx = M.cableContext(p);
    const ids = new Set();
    let dropped = 0;
    (Array.isArray(list) ? list : []).forEach((c, i) => {
      if (!isObj(c)) return;
      const label = str(c.label, 40);
      const what = label ? `cable ${label}` : `cable ${i + 1}`;
      const skip = (why) => void warnings.push(`Skipped ${what}: ${why}.`);
      if (p.cables.length >= L.cables) return void dropped++;
      const type = idOf(c.type);
      if (type && !M.cableTypeById(p, type)) return skip(`unknown cable type “${type}”`);
      let network = idOf(c.network);
      if (network && !networkIds.has(network)) {
        warnings.push(`${label ? `Cable ${label}` : `Cable ${i + 1}`} refers to unknown network “${network}” and has none.`);
        network = '';
      }
      let problem = null;
      const end = (e) => {
        if (!isObj(e)) return null;
        const fileId = idOf(e.device);
        const device = deviceIds.get(fileId);
        if (!device) problem = problem || (fileId ? `device “${fileId}” is not in the plan` : 'an end has no device');
        const out = { device: device || '', port: idOf(e.port) };
        const tr = idOf(e.transceiver);
        if (tr && !M.transceiverById(p, tr)) problem = problem || `unknown transceiver “${tr}”`;
        if (tr) out.transceiver = tr;
        return out;
      };
      const a = end(c.a);
      const b = Array.isArray(c.b) ? c.b.slice(0, L.legs + 1).map(end) : end(c.b);
      if (problem) return skip(problem);
      let id = idOf(c.id);
      if (!id || ids.has(id)) id = M.uid('cb');
      const cable = {
        id,
        type: type || null,
        network: network ? networkIds.get(network) : null,
        label,
        lengthM: M.clampNum(c.lengthM, 0.1, 10000, null),
        notes: typeof c.notes === 'string' ? c.notes.slice(0, 2000) : '',
        a,
        b,
      };
      problem = M.cableProblem(p, cable, ctx);
      if (problem) return skip(problem);
      ids.add(id);
      M.claimPorts(ctx, cable);
      p.cables.push(cable);
    });
    if (dropped) warnings.push(`Only the first ${L.cables} cables were kept.`);
  }

  /**
   * Turns untrusted JSON (an imported file or saved state) into a valid
   * project. Anything that doesn't fit is dropped and reported in `warnings`.
   */
  function normalizeProject(raw) {
    if (!isObj(raw)) throw new Error('This file is not a rack plan.');
    if (!Array.isArray(raw.devices) && !Array.isArray(raw.racks) && !Array.isArray(raw.floors)) {
      throw new Error('This file is not a rack plan: it has no racks or devices.');
    }
    const warnings = [];
    // Version 1 counted units from the bottom of the rack.
    const bottomUp = Number(raw.version) === 1;
    const legacy = !(Number(raw.version) >= 4);
    const p = M.newProjectShell({ name: str(raw.name, 120) || 'Untitled rack plan' });
    const deviceTypes = legacy ? withStandard(raw.deviceTypes, M.DEFAULT_DEVICE_TYPES, ['ports', 'slackM']) : raw.deviceTypes;
    p.deviceTypes = readTypes(deviceTypes, 'device type', 'label', M.cleanDeviceType, L.deviceTypes, [M.RESERVED.id], warnings) || p.deviceTypes;
    const rawRackTypes = legacy ? withStandard(raw.rackTypes, M.DEFAULT_RACK_TYPES, ['widthMm', 'depthMm', 'trayM', 'slackM']) : raw.rackTypes;
    const rackTypes = readTypes(rawRackTypes, 'rack type', 'name', M.cleanRackType, L.rackTypes, [], warnings);
    if (rackTypes && rackTypes.length) p.rackTypes = rackTypes;
    p.cableTypes = uniqueNames(readTypes(raw.cableTypes, 'cable type', 'name', M.cleanCableType, L.cableTypes, [], warnings) || p.cableTypes, 'cable type', warnings);
    p.transceivers = uniqueNames(readTypes(raw.transceivers, 'transceiver', 'name', M.cleanTransceiver, L.transceivers, [], warnings) || p.transceivers, 'transceiver', warnings);
    if (isObj(raw.info)) for (const k of Object.keys(p.info)) p.info[k] = str(raw.info[k], 60);
    const rackIds = readLayout(raw, p, warnings);

    // Cluster and network ids as written in the file → ids in the plan.
    const clusterIds = readGroups(raw.clusters, 'cluster', Infinity, p.clusters, (c, id) => ({ id, name: str(c.name, 60) || M.nextClusterName(p), color: M.normalizeHex(c.color) || M.nextClusterColor(p) }), warnings);
    const networkIds = readGroups(raw.networks, 'network', L.networks, p.networks, (n, id) => Object.assign(M.cleanNetwork(n, p), { id }), warnings);

    // Each device is checked against the devices already accepted in its rack.
    const perRack = new Map();
    const deviceIds = new Map();
    const planIds = new Set();
    (Array.isArray(raw.devices) ? raw.devices : []).forEach((d, i) => {
      if (!isObj(d)) return;
      let type = M.typeOf(p, idOf(d.type));
      if (!type) {
        const std = M.DEFAULT_DEVICE_TYPES.find((t) => t.id === idOf(d.type));
        if (std && p.deviceTypes.length < L.deviceTypes) {
          p.deviceTypes.push(M.clone(std));
          type = M.typeOf(p, std.id);
          warnings.push(`Added the standard device type ${std.label}, which the plan uses.`);
        }
      }
      const name = str(d.name, 80) || (type ? M.suggestName(p, type.id) : `device ${i + 1}`);
      if (!type) return void warnings.push(`Skipped ${name}: unknown device type “${String(d.type)}”.`);
      const loc = isObj(d.loc) ? d.loc : {};
      const nloc = { rack: rackIds.get(idOf(loc.rack)) || null, kind: loc.kind === 'side' ? 'side' : 'u', at: Number(loc.at) };
      if (!nloc.rack) {
        const ref = idOf(loc.rack);
        return void warnings.push(`Skipped ${name}: ${ref ? `rack “${ref}” is not in the plan` : 'it has no rack'}.`);
      }
      const height = type.variable ? M.clampInt(d.height, 1, M.rackUnits(p, nloc.rack), 1) : undefined;
      if (bottomUp && nloc.kind === 'u') nloc.at = M.RACK_UNITS + 2 - nloc.at - M.heightOf(p, type.id, height);
      let list = perRack.get(nloc.rack);
      if (!list) perRack.set(nloc.rack, (list = []));
      const fit = M.canPlace(Object.assign({}, p, { devices: list }), type.id, nloc, null, height);
      if (!fit.ok) return void warnings.push(`Skipped ${name}: ${fit.reason}.`);
      const fileId = idOf(d.id);
      let id = fileId;
      if (!id || planIds.has(id)) id = M.uid('d');
      planIds.add(id);
      // Cables find a device by its id in the file; with an id used twice, the first device.
      if (fileId && !deviceIds.has(fileId)) deviceIds.set(fileId, id);
      const cluster = idOf(d.cluster);
      if (cluster && !clusterIds.has(cluster)) warnings.push(`${name} refers to unknown cluster “${cluster}” and is left unassigned.`);
      const dev = M.newDevice({
        id,
        type: type.id,
        name,
        cluster: clusterIds.has(cluster) ? clusterIds.get(cluster) : null,
        notes: typeof d.notes === 'string' ? d.notes.slice(0, 2000) : '',
        powerW: M.clampNum(d.powerW, 0, 100000, null),
        weightKg: M.clampNum(d.weightKg, 0, 5000, null),
        reversed: d.reversed === true,
        slackM: M.clampNum(d.slackM, 0, 10, null),
        loc: nloc,
      });
      for (const f of M.FIELDS) dev[f.key] = str(d[f.key], 120);
      if (type.variable) dev.height = height;
      list.push(dev);
      p.devices.push(dev);
    });
    readCables(raw.cables, p, deviceIds, networkIds, warnings);
    if (isObj(raw.meta) && raw.meta.example === true) p.meta.example = true;
    return { project: p, warnings };
  }

  /** JSON with two-space indentation, except that the items of the lists `flat` names take one line each. */
  function prettyJSON(obj, flat) {
    const shell = Object.assign({}, obj);
    for (const k of flat) shell[k] = `\u0000${k}`;
    let text = JSON.stringify(shell, null, 2);
    for (const k of flat) {
      // The marker is the last string of its kind: only meta follows the lists.
      const mark = JSON.stringify(shell[k]);
      const at = text.lastIndexOf(mark);
      const list = obj[k];
      const body = list.length ? `[\n${list.map((x) => `    ${JSON.stringify(x)}`).join(',\n')}\n  ]` : '[]';
      text = text.slice(0, at) + body + text.slice(at + mark.length);
    }
    return text;
  }

  /** The plan as JSON; devices and cables take a line each. Empty optional device fields are left out. */
  function serialize(project, opts) {
    const devices = project.devices.map((d) => {
      const o = { id: d.id, type: d.type, name: d.name, cluster: d.cluster || null };
      if (d.notes) o.notes = d.notes;
      for (const f of M.FIELDS) if (d[f.key]) o[f.key] = d[f.key];
      if (d.powerW !== null && d.powerW !== undefined) o.powerW = d.powerW;
      if (d.weightKg !== null && d.weightKg !== undefined) o.weightKg = d.weightKg;
      if (d.reversed) o.reversed = true;
      if (d.slackM !== null && d.slackM !== undefined) o.slackM = d.slackM;
      if (d.type === M.RESERVED.id) o.height = M.deviceHeight(project, d);
      o.loc = d.loc;
      return o;
    });
    const plan = {
      app: 'rackplanner',
      version: M.SCHEMA_VERSION,
      name: project.name,
      info: project.info,
      deviceTypes: project.deviceTypes,
      rackTypes: project.rackTypes,
      cableTypes: project.cableTypes || [],
      transceivers: project.transceivers || [],
      floors: project.floors,
      clusters: project.clusters,
      networks: project.networks || [],
      devices,
      cables: project.cables || [],
      meta: project.meta || {},
    };
    return opts && opts.compact ? JSON.stringify(plan) : prettyJSON(plan, ['devices', 'cables']);
  }

  // ------------------------------------------------------------------- CSV

  const CSV_COLUMNS = ['Floor', 'Row', 'Rack', 'Position', 'Height (U)', 'Type', 'Name', 'Cluster']
    .concat(M.FIELDS.map((f) => f.csv))
    .concat(['Power (W)', 'Weight (kg)', 'Notes']);

  function csvCell(value) {
    let s = String(value == null ? '' : value);
    // Keep spreadsheet apps from evaluating cells as formulas. A value that
    // already looks guarded gets one more apostrophe, which parseCSV takes off.
    if (/^'*[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  /** "U5-6" or "Side V1", as the CSVs write a device's position. */
  function positionText(project, d) {
    return d.loc.kind === 'side' ? `Side V${d.loc.at + 1}` : M.formatPosition(project, d.loc, d.type, d.height).replace('–', '-');
  }

  const csvText = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

  function toCSV(project) {
    const rows = [CSV_COLUMNS];
    const racks = new Map(M.allRacks(project).map((r) => [r.rack.id, r]));
    for (const d of M.sortedDevices(project)) {
      const type = M.typeOf(project, d.type);
      const pos = racks.get(d.loc.rack);
      const cluster = M.clusterById(project, d.cluster);
      rows.push(
        [
          pos.floor.name,
          pos.row.name,
          pos.rack.name,
          positionText(project, d),
          M.deviceHeight(project, d),
          type.label,
          d.name,
          cluster ? cluster.name : '',
        ]
          .concat(M.FIELDS.map((f) => d[f.key] || ''))
          .concat([M.powerOf(project, d), M.weightOf(project, d), d.notes || ''])
      );
    }
    return csvText(rows);
  }

  /** Splits CSV text into rows of cells. Detects comma, semicolon or tab separators. */
  function parseCSV(text) {
    const s = String(text).replace(/^﻿/, '');
    const firstLine = s.slice(0, s.search(/\r?\n|$/));
    const count = (ch) => firstLine.split(ch).length - 1;
    const sep = [',', ';', '\t'].reduce((best, ch) => (count(ch) > count(best) ? ch : best), ',');
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (quoted) {
        if (c === '"' && s[i + 1] === '"') {
          cell += '"';
          i++;
        } else if (c === '"') quoted = false;
        else cell += c;
      } else if (c === '"' && cell === '') quoted = true;
      else if (c === sep) {
        row.push(cell);
        cell = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && s[i + 1] === '\n') i++;
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
      } else cell += c;
    }
    if (cell !== '' || row.length) {
      row.push(cell);
      rows.push(row);
    }
    // Undo the formula guard csvCell adds: one apostrophe.
    return rows
      .map((r) => r.map((v) => (/^'+[=+\-@\t\r]/.test(v) ? v.slice(1) : v)))
      .filter((r) => r.some((v) => v.trim() !== ''));
  }

  const HEADERS = {
    floor: ['floor', 'level', 'hall'],
    row: ['row', 'aisle'],
    rack: ['rack', 'cabinet'],
    position: ['position', 'pos', 'u', 'unit', 'slot', 'location'],
    height: ['heightu', 'height', 'u height', 'size'],
    type: ['type', 'devicetype', 'model'],
    name: ['name', 'hostname', 'device', 'devicename'],
    cluster: ['cluster', 'group'],
    serial: ['serialnumber', 'serial', 'sn'],
    asset: ['assettag', 'asset', 'inventory'],
    ip: ['ipaddress', 'ip', 'managementip'],
    owner: ['owner', 'contact', 'tenant'],
    powerW: ['powerw', 'power', 'watts'],
    weightKg: ['weightkg', 'weight', 'kg'],
    notes: ['notes', 'note', 'comment', 'comments', 'description'],
  };
  const headerKey = (h) => h.toLowerCase().replace(/[^a-z0-9]/g, '');

  /** "U5-6", "U5", "5" → { kind: 'u', at: 5 }; "Side V2", "V2" → { kind: 'side', at: 1 }. */
  function parsePosition(text) {
    const t = String(text || '').trim();
    let m = /^(?:side\s*)?v\s*(\d+)$/i.exec(t) || /^side\s*(\d+)$/i.exec(t);
    if (m) return { kind: 'side', at: parseInt(m[1], 10) - 1 };
    m = /^u?\s*(\d+)(?:\s*[-–]\s*u?\s*\d+)?$/i.exec(t);
    if (m) return { kind: 'u', at: parseInt(m[1], 10) };
    return null;
  }

  /**
   * Reads a CSV inventory (the columns of toCSV; only Rack, Position and
   * Name or Type are required). Devices are added to `base` when given,
   * otherwise to a new plan. Floors, rows, racks, clusters and device types
   * that don't exist yet are created by name. Returns { project, warnings, added }.
   */
  function importCSV(text, base) {
    const rows = parseCSV(text);
    if (rows.length < 2) throw new Error('The CSV has no devices: it needs a header row and at least one device.');
    const col = {};
    rows[0].forEach((h, i) => {
      const key = headerKey(h);
      for (const [name, aliases] of Object.entries(HEADERS)) {
        if (col[name] === undefined && aliases.some((a) => headerKey(a) === key)) col[name] = i;
      }
    });
    for (const need of ['rack', 'position']) {
      if (col[need] === undefined) throw new Error(`The CSV needs a “${need === 'rack' ? 'Rack' : 'Position'}” column.`);
    }
    if (col.name === undefined && col.type === undefined) throw new Error('The CSV needs a “Name” or “Type” column.');

    const warnings = [];
    // A plain copy of the plan (its devices in file form), so the model's
    // naming and catalog helpers apply; normalizeProject checks the result.
    const work = JSON.parse(serialize(base || M.newProjectShell({ name: 'Imported plan' })));
    const lower = (s) => String(s || '').trim().toLowerCase();

    function findFloor(name) {
      if (!name) return work.floors[0] || M.insertFloor(work);
      return work.floors.find((f) => lower(f.name) === lower(name)) || M.insertFloor(work, name);
    }
    function findRow(floor, name) {
      if (!name) return floor.rows[0] || M.insertRow(work, floor);
      return floor.rows.find((r) => lower(r.name) === lower(name)) || M.insertRow(work, floor, name);
    }
    const rackCache = new Map();
    function findRack(floorName, rowName, rackName) {
      const key = [floorName, rowName, rackName].map(lower).join('\u0000');
      if (rackCache.has(key)) return rackCache.get(key);
      let rack = null;
      if (!floorName && !rowName) {
        const hit = M.allRacks(work).find((r) => lower(r.rack.name) === lower(rackName));
        if (hit) rack = hit.rack;
      }
      if (!rack) {
        const floor = findFloor(floorName);
        const row = floor && findRow(floor, rowName);
        if (!floor) warnings.push(`A plan holds ${L.floors} floors; skipped devices on ${floorName}.`);
        else if (!row) warnings.push(`A floor holds ${L.rows} rows; skipped devices in ${rowName} on ${floor.name}.`);
        else {
          rack = row.racks.find((r) => lower(r.name) === lower(rackName)) || null;
          if (!rack && row.racks.length >= L.racks) warnings.push(`A row holds ${L.racks} racks; skipped devices in ${rackName}.`);
          else if (!rack) rack = M.addRack(work, row.id, { name: rackName });
        }
      }
      rackCache.set(key, rack);
      return rack;
    }
    function findType(label, height) {
      const l = lower(label);
      if (l === lower(M.RESERVED.label) || l === M.RESERVED.id) return M.RESERVED;
      let t = work.deviceTypes.find((x) => lower(x.label) === l || lower(x.id) === l);
      if (t) return t;
      if (!height) return null;
      if (!l) t = work.deviceTypes.find((x) => x.face === 'generic' && x.height === height);
      if (t) return t;
      t = M.addDeviceType(work, { label: label || `Generic ${height}U device`, height, face: 'generic', tag: label ? undefined : 'DEVICE' });
      if (t) warnings.push(`Added the device type ${t.label} (${height}U) to the catalog.`);
      return t;
    }
    function findCluster(name) {
      if (!name) return null;
      let c = work.clusters.find((x) => lower(x.name) === lower(name));
      if (!c) {
        c = { id: M.uid('c'), name: name.slice(0, 60), color: M.nextClusterColor(work) };
        work.clusters.push(c);
      }
      return c.id;
    }

    const get = (r, k) => (col[k] === undefined ? '' : String(r[col[k]] == null ? '' : r[col[k]]).trim());
    const devices = [];
    rows.slice(1).forEach((r, i) => {
      const line = i + 2;
      const name = get(r, 'name');
      const label = get(r, 'type');
      const heightText = get(r, 'height');
      const height = heightText ? M.clampInt(heightText, 1, L.unitsMax, 0) : 0;
      const pos = parsePosition(get(r, 'position'));
      const what = name || `line ${line}`;
      if (!get(r, 'rack')) return void warnings.push(`Skipped ${what}: it has no rack.`);
      if (!pos) return void warnings.push(`Skipped ${what}: position “${get(r, 'position')}” is not like U12 or Side V1.`);
      const type = findType(label, height);
      if (!type) return void warnings.push(`Skipped ${what}: unknown device type “${label}” and no height to create it.`);
      if (!type.variable && height && height !== type.height) warnings.push(`${what}: ${type.label} is ${type.height}U, not ${height}U as the CSV says.`);
      // Names are cut to the length the plan keeps, so later lines find what earlier ones created.
      const rack = findRack(...['floor', 'row', 'rack'].map((k) => get(r, k).slice(0, 60)));
      if (!rack) return;
      const d = { id: M.uid('d'), type: type.id, name: name || M.nextInSeries({ devices: work.devices.concat(devices) }, type.defaultName, 1, true), cluster: findCluster(get(r, 'cluster')), notes: get(r, 'notes'), loc: { rack: rack.id, kind: pos.kind, at: pos.at } };
      for (const f of M.FIELDS) d[f.key] = get(r, f.key);
      const power = get(r, 'powerW');
      const weight = get(r, 'weightKg');
      if (power !== '' && Number(power) !== type.powerW) d.powerW = Number(power);
      if (weight !== '' && Number(weight) !== type.weightKg) d.weightKg = Number(weight);
      if (type.variable) d.height = height || 1;
      devices.push(d);
    });
    work.devices = work.devices.concat(devices);
    if (!work.floors.length) throw new Error('The CSV has no devices that could be placed.');
    const result = normalizeProject(work);
    const added = result.project.devices.length - (base ? base.devices.length : 0);
    return { project: result.project, warnings: warnings.concat(result.warnings), added };
  }

  // --------------------------------------------------------- cable CSVs

  const CABLE_CSV_COLUMNS = ['Label', 'Network', 'Cable type', 'Length (m)', 'Length', 'Leg']
    .concat(['A', 'B'].reduce((out, s) => out.concat(['floor', 'row', 'rack', 'position', 'device', 'port', 'transceiver'].map((k) => `${s} ${k}`)), []))
    .concat(['Speed', 'Checks', 'Notes']);
  // Picked types and transceivers are marked, so that reading the schedule back picks them again.
  const AUTO = ' (auto)';

  /**
   * The cable schedule: one line per cable (per leg for breakouts, with
   * Leg "1/2"), with both ends' places, the type and length, whether the
   * length is estimated or set, the speed and the checks.
   */
  function exportCablesCSV(project, cables) {
    const C = cabling();
    const ctx = C.context(project);
    const racks = new Map(M.allRacks(project).map((r) => [r.rack.id, r]));
    const rows = [CABLE_CSV_COLUMNS];
    const place = (e) => {
      const d = e && ctx.devices.get(e.device);
      if (!d) return ['', '', '', '', '', ''];
      const pos = racks.get(d.loc.rack);
      return [pos.floor.name, pos.row.name, pos.rack.name, positionText(project, d), d.name, e.port];
    };
    const optics = (end, t) => (t ? (end.transceiver ? t.name : t.name + AUTO) : '');
    for (const c of cables || project.cables) {
      const d = C.describe(project, c, ctx);
      const net = M.networkById(project, c.network);
      const type = d.type ? d.type.name + (c.type ? '' : AUTO) : '';
      const head = d.ends.find((e) => e.role === 'a');
      const legs = M.legsOf(c);
      legs.forEach((leg, i) => {
        const far = leg && d.ends.find((e) => e.role === 'b' && (e.leg === null ? 0 : e.leg) === i);
        rows.push(
          [c.label, net ? net.name : '', type, d.lengthM === null ? '' : d.lengthM, d.lengthAuto ? 'estimated' : 'set', Array.isArray(c.b) ? `${i + 1}/${legs.length}` : '']
            .concat(place(c.a), [optics(c.a, head && head.transceiver)])
            .concat(place(leg), [far ? optics(leg, far.transceiver) : ''])
            .concat([C.fmtSpeed(d.legSpeedsGbps[i]), d.issues.map((x) => x.short).join('; '), c.notes || ''])
        );
      });
    }
    return csvText(rows);
  }

  const CABLE_HEADERS = {
    label: ['label', 'cable label', 'cable id', 'cable'],
    network: ['network', 'vlan'],
    // "Cable" comes last for the type, so that alone it is the label.
    type: ['cable type', 'type', 'cable model', 'cable'],
    lengthM: ['length (m)', 'length m', 'metres', 'meters', 'length (metres)', 'length (meters)', 'length in metres', 'length in meters', 'cable length', 'cable length (m)'],
    // "Length" is the estimated/set column of exportCablesCSV, or metres when it holds numbers (see importCablesCSV).
    lengthKind: ['length'],
    leg: ['leg'],
    aDevice: ['a device', 'from device', 'from'],
    aPort: ['a port', 'from port'],
    aFloor: ['a floor', 'from floor'],
    aRow: ['a row', 'from row'],
    aRack: ['a rack', 'from rack'],
    aPosition: ['a position', 'from position'],
    aTransceiver: ['a transceiver', 'from transceiver'],
    bDevice: ['b device', 'to device', 'to'],
    bPort: ['b port', 'to port'],
    bFloor: ['b floor', 'to floor'],
    bRow: ['b row', 'to row'],
    bRack: ['b rack', 'to rack'],
    bPosition: ['b position', 'to position'],
    bTransceiver: ['b transceiver', 'to transceiver'],
    notes: ['notes', 'note', 'comment', 'comments'],
  };

  /** "4.5", "4,5" (a decimal comma), "4.5 m" → 4.5; null when it is no length above 0. */
  function readMetres(text) {
    let t = String(text).trim().replace(/\s*m$/i, '');
    if (/^\d+,\d+$/.test(t)) t = t.replace(',', '.');
    const n = /^\d*\.?\d+$|^\d+\.$/.test(t) ? Number(t) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  /**
   * Which column holds what: { label: 0, type: 2, … }. Aliases are tried
   * in rank order over all keys, and a column fills one key only, so
   * "Cable" is the label, or the type next to a "Label" or "Cable ID".
   */
  function cableColumns(header) {
    const col = {};
    const keys = header.map((h) => headerKey(String(h == null ? '' : h)));
    const used = new Set();
    const ranks = Math.max(...Object.values(CABLE_HEADERS).map((a) => a.length));
    for (let rank = 0; rank < ranks; rank++) {
      for (const [name, aliases] of Object.entries(CABLE_HEADERS)) {
        if (col[name] !== undefined || rank >= aliases.length) continue;
        const i = keys.findIndex((k, j) => !used.has(j) && k === headerKey(aliases[rank]));
        if (i < 0) continue;
        col[name] = i;
        used.add(i);
      }
    }
    return col;
  }

  /** True when CSV text is a cable schedule (it has A and B device columns) rather than a device inventory. */
  function isCablesCSV(text) {
    const rows = parseCSV(String(text || ''));
    const col = rows.length ? cableColumns(rows[0]) : {};
    return col.aDevice !== undefined && col.bDevice !== undefined && col.aPort !== undefined && col.bPort !== undefined;
  }

  /**
   * Adds the cables of a cable schedule (the columns of exportCablesCSV;
   * A and B device and port are required) to `project`, finding devices by
   * name. Lines with the same label and A end form one breakout cable when
   * they have a Leg like "1/2" or name a breakout type; legs without a Leg
   * take the free legs in line order. A breakout takes its type, network,
   * length and notes from its first line. Networks are created by name for
   * the cables that are added; an empty cell, or "… (auto)" that is not a
   * name in the catalog, leaves the type or transceiver to be picked.
   * Returns { added, warnings }.
   */
  function importCablesCSV(project, text) {
    const C = cabling();
    const rows = parseCSV(text);
    if (rows.length < 2) throw new Error('The CSV has no cables: it needs a header row and at least one cable.');
    const col = cableColumns(rows[0]);
    if (['aDevice', 'aPort', 'bDevice', 'bPort'].some((k) => col[k] === undefined)) throw new Error('The CSV needs “A device”, “A port”, “B device” and “B port” columns.');
    const warnings = [];
    const lower = (v) => String(v || '').trim().toLowerCase();
    const get = (r, k) => (col[k] === undefined ? '' : String(r[col[k]] == null ? '' : r[col[k]]).trim());
    // A plain "Length" column without a metres one holds metres when it holds anything but "estimated" and "set".
    if (col.lengthM === undefined && col.lengthKind !== undefined && rows.slice(1).some((r) => !['', 'estimated', 'set'].includes(lower(get(r, 'lengthKind'))))) {
      col.lengthM = col.lengthKind;
      delete col.lengthKind;
    }
    const byName = new Map();
    for (const d of M.sortedDevices(project)) {
      const k = lower(d.name);
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push(d);
    }
    const racks = new Map(M.allRacks(project).map((r) => [r.rack.id, r]));
    const places = {
      floor: (d) => racks.get(d.loc.rack).floor.name,
      row: (d) => racks.get(d.loc.rack).row.name,
      rack: (d) => racks.get(d.loc.rack).rack.name,
      position: (d) => positionText(project, d),
    };
    const samePlace = (x, y) => lower(x).replace(/\s+/g, '').replace(/–/g, '-') === lower(y).replace(/\s+/g, '').replace(/–/g, '-');
    /**
     * The device a line's end names: { device } when one device has the
     * name in the place the line gives (its floor, row, rack and position,
     * where given; the name as written before another case), with `off` the
     * part of the place no such device is in; { many } when that leaves
     * more than one.
     */
    const findDevice = (row, side) => {
      const name = get(row, `${side}Device`);
      let list = byName.get(lower(name)) || [];
      let off = null;
      for (const [k, at] of Object.entries(places)) {
        const v = get(row, side + k[0].toUpperCase() + k.slice(1));
        if (!v || !list.length) continue;
        const here = list.filter((d) => samePlace(at(d), v));
        if (here.length) list = here;
        else off = off || `${k} ${v}`;
      }
      const exact = list.filter((d) => d.name === name);
      if (exact.length) list = exact;
      return list.length > 1 ? { many: list.length } : { device: list[0] || null, off };
    };
    // By name as written, then by name in any case, then by id: an entry's name wins over another one's id.
    const findIn = (list, v) => {
      for (const same of [(x) => x.name === v, (x) => lower(x.name) === lower(v), (x) => x.id === v, (x) => lower(x.id) === lower(v)]) {
        const hit = list.find(same);
        if (hit) return hit;
      }
      return null;
    };
    // { auto: true } to pick, else { item } (null when the catalog has no such entry).
    const lookup = (list, v) => {
      if (!v) return { auto: true };
      const item = findIn(list, v);
      return item || !lower(v).endsWith(AUTO.trim()) ? { item } : { auto: true };
    };

    // Lines become cables: { line, rows, lines, at }, breakout legs gathered under their head.
    const cables = [];
    const breakouts = new Map();
    rows.slice(1).forEach((r, i) => {
      const line = i + 2;
      const leg = /^(\d+)\s*\/\s*(\d+)$/.exec(get(r, 'leg'));
      const type = lookup(project.cableTypes, get(r, 'type')).item;
      if (!leg && !(type && type.legs > 1)) return void cables.push({ line, rows: [r], lines: [line], at: null });
      const key = [get(r, 'label'), get(r, 'aFloor'), get(r, 'aRow'), get(r, 'aRack'), get(r, 'aDevice'), get(r, 'aPort')].map(lower).join('\u0000');
      let c = breakouts.get(key);
      if (!c) {
        breakouts.set(key, (c = { line, rows: [], lines: [], at: [], totals: [] }));
        cables.push(c);
      }
      c.rows.push(r);
      c.lines.push(line);
      c.at.push(leg ? parseInt(leg[1], 10) - 1 : null);
      c.totals.push(leg ? parseInt(leg[2], 10) : null);
    });

    // Labels given further down the file are taken too, so that a line without one doesn't get theirs.
    const given = new Set(rows.slice(1).map((r) => get(r, 'label').slice(0, 40).trim()).filter(Boolean));
    const many = C.connector(project, given);
    let added = 0;
    for (const c of cables) {
      const r = c.rows[0];
      const label = get(r, 'label').slice(0, 40);
      const what = label ? `cable ${label}` : `line ${c.line}`;
      const skip = (why) => void warnings.push(`Skipped ${what}: ${why}.`);
      let problem = null;
      const notes = [];
      const end = (row, side) => {
        const name = get(row, `${side}Device`);
        const port = get(row, `${side}Port`);
        if (!name && !port) return null;
        const found = findDevice(row, side);
        const d = found.device;
        if (found.many) problem = problem || `${found.many} devices are named ${name}: give their floor, row and rack`;
        else if (!d) problem = problem || `there is no device ${name || 'without a name'}`;
        else if (found.off) notes.push(`${d.name} is not in ${found.off}, so it is the one in rack ${places.rack(d)}`);
        const e = { device: d ? d.id : '', port };
        const tr = get(row, `${side}Transceiver`);
        const t = lookup(project.transceivers, tr);
        if (t.item) e.transceiver = t.item.id;
        else if (!t.auto) problem = problem || `unknown transceiver “${tr}”`;
        return e;
      };
      const typeText = get(r, 'type');
      const found = lookup(project.cableTypes, typeText);
      const type = found.item;
      if (!found.auto && !type) {
        skip(`unknown cable type “${typeText}”`);
        continue;
      }
      const a = end(r, 'a');
      let b;
      if (c.at) {
        // The legs: as many as the first Leg says, else as the type has, else one per line.
        const total = c.totals.find((n) => n !== null);
        const legs = total !== undefined ? total : type && type.legs > 1 ? type.legs : c.rows.length;
        if (type && type.legs > 1 && legs !== type.legs) {
          skip(`${type.name} has ${type.legs} legs, not ${legs}`);
          continue;
        }
        if (legs > L.legs) {
          skip(`a breakout cable has at most ${L.legs} legs, not ${legs}`);
          continue;
        }
        b = Array.from({ length: legs }, () => null);
        const place = (k, at) => {
          const leg = `line ${c.lines[k]}`;
          if (at < 0 || at >= legs) return void warnings.push(`Skipped ${leg} of ${what}: leg ${at + 1} is not one of its ${legs} legs.`);
          if (b[at]) return void warnings.push(`Skipped ${leg} of ${what}: leg ${at + 1} is given twice.`);
          if (c.totals[k] !== null && c.totals[k] !== legs) warnings.push(`${leg[0].toUpperCase()}${leg.slice(1)} of ${what} says ${c.totals[k]} legs, not ${legs}.`);
          b[at] = end(c.rows[k], 'b');
        };
        c.rows.forEach((row, k) => c.at[k] !== null && place(k, c.at[k]));
        c.rows.forEach((row, k) => {
          if (c.at[k] !== null) return;
          const free = b.findIndex((e) => !e);
          if (free < 0) warnings.push(`Skipped line ${c.lines[k]} of ${what}: its ${legs} legs are taken.`);
          else place(k, free);
        });
      } else b = end(r, 'b');
      if (problem) {
        skip(problem);
        continue;
      }
      const props = { a, b, type: type ? type.id : null, label, notes: get(r, 'notes') };
      // Checked before its network is created, so that a cable left out leaves nothing behind.
      const refused = many.check(props);
      if (refused) {
        skip(refused);
        continue;
      }
      // Cut to the length the plan keeps, so later lines find the network an earlier one created.
      const netName = get(r, 'network').slice(0, 60).trim();
      let network = netName ? findIn(project.networks, netName) : null;
      if (netName && !network) {
        network = C.addNetwork(project, { name: netName });
        if (!network) warnings.push(`${label ? `Cable ${label}` : `Line ${c.line}`}: a plan holds ${L.networks} networks, so it has none.`);
      }
      const metres = get(r, 'lengthM');
      let lengthM = null;
      if (metres !== '' && lower(get(r, 'lengthKind')) !== 'estimated') {
        lengthM = readMetres(metres);
        if (lengthM === null) notes.push(`its length “${metres}” is not a number of metres, so it is estimated`);
      }
      const result = many.add(Object.assign(props, { network: network ? network.id : null, lengthM }));
      if (result.error) skip(result.error);
      else {
        added++;
        for (const n of notes) warnings.push(`${label ? `Cable ${label}` : `Line ${c.line}`}: ${n}.`);
      }
    }
    return { added, warnings };
  }

  /** The order list as CSV: stock cables by length, cables made to length, then transceivers. */
  function exportOrderCSV(project, cables) {
    const bom = cabling().billOfMaterials(project, cables);
    const total = (l, n) => Math.round(l * n * 100) / 100;
    const rows = [['Item', 'Kind', 'Length (m)', 'Count', 'Total (m)']];
    for (const x of bom.cables) rows.push([x.type.name, 'Cable', x.lengthM, x.count, total(x.lengthM, x.count)]);
    for (const x of bom.madeToLength) for (const l of x.lengths) rows.push([x.type.name, 'Cable, made to length', l.lengthM, l.count, total(l.lengthM, l.count)]);
    for (const x of bom.transceivers) rows.push([x.transceiver.name, 'Transceiver', '', x.count, '']);
    return csvText(rows);
  }

  // ----------------------------------------------------------- share links

  function toBase64Url(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function fromBase64Url(text) {
    const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  async function pipe(bytes, stream) {
    return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
  }

  /**
   * Packs a plan into text for the #plan= part of a link: deflated when the
   * browser can compress ("z…"), plain otherwise ("j…"), in base64url.
   */
  async function encodeShare(project) {
    const bytes = new TextEncoder().encode(serialize(project, { compact: true }));
    if (typeof CompressionStream === 'function') return 'z' + toBase64Url(await pipe(bytes, new CompressionStream('deflate-raw')));
    return 'j' + toBase64Url(bytes);
  }

  /** Reverses encodeShare. Returns the raw plan object (still to be normalized). */
  async function decodeShare(code) {
    const bad = () => new Error('This link does not contain a readable plan. It may have been cut off.');
    const text = String(code || '').trim();
    let bytes;
    try {
      if (text[0] === 'z' && typeof DecompressionStream === 'function') bytes = await pipe(fromBase64Url(text.slice(1)), new DecompressionStream('deflate-raw'));
      else if (text[0] === 'j') bytes = fromBase64Url(text.slice(1));
      else throw bad();
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) {
      throw bad();
    }
  }

  return {
    normalizeProject,
    serialize,
    CSV_COLUMNS,
    csvCell,
    toCSV,
    parseCSV,
    parsePosition,
    importCSV,
    CABLE_CSV_COLUMNS,
    exportCablesCSV,
    isCablesCSV,
    importCablesCSV,
    exportOrderCSV,
    encodeShare,
    decodeShare,
  };
});
