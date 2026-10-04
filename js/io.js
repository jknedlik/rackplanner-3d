/*
 * Vendored from https://github.com/dennisklein/rackplanner — CC0 1.0 Universal (public domain).
 * Unmodified except this header.
 *
/*
 * Rackplanner: reading and writing plans.
 *
 * Validates untrusted plan files (all schema versions), serializes plans,
 * exports and imports CSV inventories, and packs plans into share links.
 * No DOM access; shared by the browser app and the Node tests.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./model.js'));
  else (root.RP = root.RP || {}).io = factory(root.RP.model);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (M) {
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
        const floor = { id: claim(idOf(f.id), 'f'), name: str(f.name, 60) || M.nextFloorName(p), rows: [] };
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
            row.racks.push({ id, name, type: rackType(k.type, name || 'A rack') });
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
    const p = M.newProjectShell({ name: str(raw.name, 120) || 'Untitled rack plan' });
    p.deviceTypes = readTypes(raw.deviceTypes, 'device type', 'label', M.cleanDeviceType, L.deviceTypes, [M.RESERVED.id], warnings) || p.deviceTypes;
    const rackTypes = readTypes(raw.rackTypes, 'rack type', 'name', M.cleanRackType, L.rackTypes, [], warnings);
    if (rackTypes && rackTypes.length) p.rackTypes = rackTypes;
    if (isObj(raw.info)) for (const k of Object.keys(p.info)) p.info[k] = str(raw.info[k], 60);
    const rackIds = readLayout(raw, p, warnings);

    // Cluster ids as written in the file → ids in the plan. Ids starting
    // with "__" are reserved for the app ("__none", "__new") and replaced.
    const clusterIds = new Map();
    (Array.isArray(raw.clusters) ? raw.clusters : []).forEach((c, i) => {
      if (!isObj(c)) return;
      const fileId = idOf(c.id);
      const label = str(c.name, 60) || `#${i + 1}`;
      if (!fileId) return void warnings.push(`Skipped cluster ${label}: it has no id.`);
      if (clusterIds.has(fileId)) return void warnings.push(`Skipped cluster ${label}: its id “${fileId}” is used twice.`);
      const id = fileId.startsWith('__') ? M.uid('c') : fileId;
      clusterIds.set(fileId, id);
      p.clusters.push({ id, name: str(c.name, 60) || M.nextClusterName(p), color: M.normalizeHex(c.color) || M.nextClusterColor(p) });
    });

    // Each device is checked against the devices already accepted in its rack.
    const perRack = new Map();
    const deviceIds = new Set();
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
      let id = idOf(d.id);
      if (!id || deviceIds.has(id)) id = M.uid('d');
      deviceIds.add(id);
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
        loc: nloc,
      });
      for (const f of M.FIELDS) dev[f.key] = str(d[f.key], 120);
      if (type.variable) dev.height = height;
      list.push(dev);
      p.devices.push(dev);
    });
    if (isObj(raw.meta) && raw.meta.example === true) p.meta.example = true;
    return { project: p, warnings };
  }

  /** The plan as JSON. Empty optional device fields are left out. */
  function serialize(project, opts) {
    const devices = project.devices.map((d) => {
      const o = { id: d.id, type: d.type, name: d.name, cluster: d.cluster || null };
      if (d.notes) o.notes = d.notes;
      for (const f of M.FIELDS) if (d[f.key]) o[f.key] = d[f.key];
      if (d.powerW !== null && d.powerW !== undefined) o.powerW = d.powerW;
      if (d.weightKg !== null && d.weightKg !== undefined) o.weightKg = d.weightKg;
      if (d.type === M.RESERVED.id) o.height = M.deviceHeight(project, d);
      o.loc = d.loc;
      return o;
    });
    return JSON.stringify(
      {
        app: 'rackplanner',
        version: M.SCHEMA_VERSION,
        name: project.name,
        info: project.info,
        deviceTypes: project.deviceTypes,
        rackTypes: project.rackTypes,
        floors: project.floors,
        clusters: project.clusters,
        devices,
        meta: project.meta || {},
      },
      null,
      opts && opts.compact ? 0 : 2
    );
  }

  // ------------------------------------------------------------------- CSV

  const CSV_COLUMNS = ['Floor', 'Row', 'Rack', 'Position', 'Height (U)', 'Type', 'Name', 'Cluster']
    .concat(M.FIELDS.map((f) => f.csv))
    .concat(['Power (W)', 'Weight (kg)', 'Notes']);

  function csvCell(value) {
    let s = String(value == null ? '' : value);
    // Keep spreadsheet apps from evaluating cells as formulas.
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

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
          d.loc.kind === 'side' ? `Side V${d.loc.at + 1}` : M.formatPosition(project, d.loc, d.type, d.height).replace('–', '-'),
          M.deviceHeight(project, d),
          type.label,
          d.name,
          cluster ? cluster.name : '',
        ]
          .concat(M.FIELDS.map((f) => d[f.key] || ''))
          .concat([M.powerOf(project, d), M.weightOf(project, d), d.notes || ''])
      );
    }
    return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
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
    // Undo the formula guard csvCell adds.
    return rows
      .map((r) => r.map((v) => (/^'[=+\-@\t\r]/.test(v) ? v.slice(1) : v)))
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
    encodeShare,
    decodeShare,
  };
});
