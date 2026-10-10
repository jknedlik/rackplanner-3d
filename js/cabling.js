/*
 * Vendored from https://github.com/dennisklein/rackplanner — CC0 1.0 Universal (public domain).
 * Unmodified except this header.
 *
/*
 * Rackplanner: cabling.
 *
 * Connects ports, estimates cable lengths, picks cable types and
 * transceivers, finds problems, lists what to order and draws the fabric of
 * a network as data. js/model.js holds the schema (ports, cables, networks,
 * the cable type and transceiver catalogs) and keeps cables consistent when
 * the layout changes. Pure functions without DOM access, shared by the
 * browser app and the Node tests.
 *
 * Lengths follow a cable's way: from the port to the rack's cable manager,
 * up to the tray above the racks, along and across rows, and down again;
 * between floors they are entered by hand.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./model.js'));
  else (root.RP = root.RP || {}).cabling = factory(root.RP.model);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (M) {
  'use strict';

  const L = M.LIMITS;
  const UNIT_M = 0.04445; // one rack unit
  const OVERSUBSCRIBED = 3; // leaves with more than 3 : 1 down to up are flagged

  // ------------------------------------------------------------ formatting

  /** "2.5 m"; `digits` decimals at most. */
  function fmtM(m, digits) {
    if (m === null || m === undefined) return '–';
    const f = Math.pow(10, digits === undefined ? 2 : digits);
    return `${Math.round(m * f) / f} m`;
  }
  /** A needed length, rounded up to 0.1 m as an estimated length would be: never down to a limit it is past. */
  const fmtNeed = (m) => fmtM(Math.ceil(m * 10 - 1e-6) / 10, 1);
  /** "25 Gb/s", "100 Mb/s". */
  function fmtSpeed(g) {
    if (!g) return '';
    return g < 1 ? `${Math.round(g * 1000)} Mb/s` : `${Math.round(g * 100) / 100} Gb/s`;
  }
  /** "25G", "100M". */
  function shortSpeed(g) {
    if (!g) return '';
    return g < 1 ? `${Math.round(g * 1000)}M` : `${Math.round(g * 100) / 100}G`;
  }
  /** "6:1", "2.75:1"; '–' without uplinks. */
  function fmtRatio(r) {
    return r === null || r === undefined || !Number.isFinite(r) ? '–' : `${Math.round(r * 100) / 100}:1`;
  }
  const connLabel = (id) => (M.connectorById(id) || { label: id }).label;
  const modeLabel = (mode) => (mode === 'smf' ? 'single-mode' : 'multimode');
  /** "a QSFP56 DAC", "an SFP28 DAC", "an LC duplex OM4": acronyms by the sound of their first letter. */
  function withArticle(name) {
    const word = String(name).split(/\s/)[0];
    const acronym = /^[A-Z0-9][A-Z0-9+\-/]*$/.test(word) && /[A-Z]/.test(word[0]);
    const an = acronym ? /^[AEFHILMNORSX]/.test(word) : /^[aeiou]/i.test(word) || /^8|^11|^18/.test(word);
    return `${an ? 'an' : 'a'} ${name}`;
  }

  // ---------------------------------------------------------------- context

  /**
   * Lookups for many cables at once: devices, racks with their place along
   * the row, ports by type, label counts and the catalogs by id. Functions
   * taking an optional `ctx` build one when it is missing; pass one when
   * describing many cables of the same plan. With `opts.memo`, describe
   * keeps what it finds per cable object: for a plan that no longer
   * changes, such as each state of the app's undo history.
   */
  function context(project, opts) {
    const racks = new Map();
    const rackX = new Map();
    const order = new Map();
    M.allRacks(project).forEach((r, i) => {
      racks.set(r.rack.id, r);
      order.set(r.rack.id, i);
    });
    for (const floor of project.floors) {
      for (const row of floor.rows) {
        let x = 0;
        for (const rack of row.racks) {
          const w = M.rackTypeOf(project, rack).widthMm / 1000;
          rackX.set(rack.id, x + w / 2);
          x += w;
        }
      }
    }
    const labels = new Map();
    for (const c of project.cables) if (c.label) labels.set(c.label, (labels.get(c.label) || 0) + 1);
    const deviceOrder = new Map(M.sortedDevices(project).map((d, i) => [d.id, i]));
    return {
      project,
      devices: new Map(project.devices.map((d) => [d.id, d])),
      deviceOrder,
      racks,
      rackX,
      order,
      ports: new Map(),
      labels,
      cableTypes: new Map(project.cableTypes.map((t) => [t.id, t])),
      transceivers: new Map(project.transceivers.map((t) => [t.id, t])),
      networks: new Map(project.networks.map((n) => [n.id, n])),
      memo: opts && opts.memo ? new WeakMap() : null,
    };
  }

  function portsOfType(ctx, typeId) {
    let m = ctx.ports.get(typeId);
    if (!m) ctx.ports.set(typeId, (m = new Map(M.expandPorts(M.typeOf(ctx.project, typeId)).map((p) => [p.name, p]))));
    return m;
  }
  function endPort(ctx, end) {
    const d = end && ctx.devices.get(end.device);
    return d ? portsOfType(ctx, d.type).get(end.port) || null : null;
  }
  function endFace(ctx, end) {
    const d = end && ctx.devices.get(end.device);
    const p = endPort(ctx, end);
    if (!p) return null;
    return d.reversed ? (p.side === 'front' ? 'rear' : 'front') : p.side;
  }
  const endName = (ctx, end) => `${(ctx.devices.get(end.device) || { name: end.device }).name} ${end.port}`;

  // ---------------------------------------------------------------- lookups

  function cableById(project, id) {
    return project.cables.find((c) => c.id === id) || null;
  }

  /** Map from "deviceId|port" to { cable, role: 'a'|'b', leg } for every cabled port. */
  function cableIndex(project) {
    const m = new Map();
    for (const cable of project.cables) for (const x of M.cableEnds(cable)) m.set(`${x.end.device}|${x.end.port}`, { cable, role: x.role, leg: x.leg });
    return m;
  }

  /** The port an end is plugged into: { name, group, index, connector, speedGbps, side }, or null. */
  function portOf(project, end, ctx) {
    return endPort(ctx || context(project), end);
  }

  /** The side of the rack a port is on: the device's side, flipped when the device is mounted back to front. */
  function portFace(project, end, ctx) {
    return endFace(ctx || context(project), end);
  }

  function cablesOfDevice(project, deviceId) {
    return project.cables.filter((c) => M.cableEnds(c).some((x) => x.end.device === deviceId));
  }

  /** Cables with at least one end in a rack, row or floor (whichever id matches). */
  function cablesWithin(project, id) {
    const devices = new Set(M.devicesWithin(project, id).map((d) => d.id));
    return project.cables.filter((c) => M.cableEnds(c).some((x) => devices.has(x.end.device)));
  }

  // --------------------------------------------------------------- catalogs

  /** `name`, or with a number when `list` has it: "QSFP56 DAC 2". The base is cut so that the name keeps within 60 characters. */
  function uniqueName(list, name) {
    const used = new Set(list.map((x) => x.name));
    if (!used.has(name)) return name;
    const base = name.slice(0, 56);
    let i = 2;
    while (used.has(`${base} ${i}`)) i++;
    return `${base} ${i}`;
  }

  function moveIn(list, id, toIndex) {
    const i = list.findIndex((t) => t.id === id);
    const to = Math.max(0, Math.min(list.length - 1, toIndex));
    if (i < 0 || i === to) return false;
    list.splice(to, 0, list.splice(i, 1)[0]);
    return true;
  }

  /** Cables that name cable type `id` (cables picking their type don't count). */
  function cableTypeUse(project, id) {
    return project.cables.filter((c) => c.type === id).length;
  }

  /** Adds a cable type from `template`; null when the catalog is full. */
  function addCableType(project, template) {
    if (project.cableTypes.length >= L.cableTypes) return null;
    const t = M.cleanCableType(template);
    t.id = M.nextId('ct', new Set(project.cableTypes.map((x) => x.id)));
    t.name = uniqueName(project.cableTypes, t.name);
    project.cableTypes.push(t);
    return t;
  }

  /** Changes a cable type. Its number of legs stays while cables name it. */
  function updateCableType(project, id, changes) {
    const i = project.cableTypes.findIndex((t) => t.id === id);
    if (i < 0) return 'Unknown cable type';
    const before = project.cableTypes[i];
    const next = M.cleanCableType(Object.assign({}, before, changes));
    next.id = id;
    // Names tell types apart in cable schedules, so they stay unique.
    next.name = uniqueName(project.cableTypes.filter((t) => t.id !== id), next.name);
    const n = cableTypeUse(project, id);
    if (n && next.legs !== before.legs) {
      return `${n} cable${n === 1 ? ' uses' : 's use'} this type, so it keeps ${before.legs === 1 ? 'one end at each side' : `${before.legs} legs`}`;
    }
    project.cableTypes[i] = next;
    return null;
  }

  /** Removes a cable type no cable names; returns an error message otherwise. */
  function deleteCableType(project, id) {
    const n = cableTypeUse(project, id);
    if (n) return `${n} cable${n === 1 ? ' uses' : 's use'} this type`;
    project.cableTypes = project.cableTypes.filter((t) => t.id !== id);
    return null;
  }

  /** Moves a cable type to `toIndex`; picking goes by this order. */
  function moveCableType(project, id, toIndex) {
    return moveIn(project.cableTypes, id, toIndex);
  }

  /** Cable ends that name transceiver `id`. */
  function transceiverUse(project, id) {
    let n = 0;
    for (const c of project.cables) for (const x of M.cableEnds(c)) if (x.end.transceiver === id) n++;
    return n;
  }

  function addTransceiver(project, template) {
    if (project.transceivers.length >= L.transceivers) return null;
    const t = M.cleanTransceiver(template);
    t.id = M.nextId('tr', new Set(project.transceivers.map((x) => x.id)));
    t.name = uniqueName(project.transceivers, t.name);
    project.transceivers.push(t);
    return t;
  }

  function updateTransceiver(project, id, changes) {
    const i = project.transceivers.findIndex((t) => t.id === id);
    if (i < 0) return 'Unknown transceiver';
    const next = M.cleanTransceiver(Object.assign({}, project.transceivers[i], changes));
    next.id = id;
    next.name = uniqueName(project.transceivers.filter((t) => t.id !== id), next.name);
    project.transceivers[i] = next;
    return null;
  }

  /** Removes a transceiver no cable end names; returns an error message otherwise. */
  function deleteTransceiver(project, id) {
    const n = transceiverUse(project, id);
    if (n) return `${n} cable end${n === 1 ? ' uses' : 's use'} this transceiver`;
    project.transceivers = project.transceivers.filter((t) => t.id !== id);
    return null;
  }

  function moveTransceiver(project, id, toIndex) {
    return moveIn(project.transceivers, id, toIndex);
  }

  function nextNetworkName(project) {
    const used = new Set(project.networks.map((n) => n.name));
    let i = project.networks.length + 1;
    while (used.has(`Network ${i}`)) i++;
    return `Network ${i}`;
  }

  /** Adds a network (a free color and a label series from its name unless given); null when the plan has 30. */
  function addNetwork(project, props) {
    if (project.networks.length >= L.networks) return null;
    const n = M.cleanNetwork(Object.assign({ name: nextNetworkName(project) }, props), project);
    n.id = M.uid('n');
    project.networks.push(n);
    return n;
  }

  function updateNetwork(project, id, changes) {
    const i = project.networks.findIndex((n) => n.id === id);
    if (i < 0) return 'Unknown network';
    const before = project.networks[i];
    const merged = Object.assign({}, before, changes);
    if (!M.normalizeHex(merged.color)) merged.color = before.color;
    const next = M.cleanNetwork(merged, project);
    next.id = id;
    project.networks[i] = next;
    return null;
  }

  /** Removes a network; its cables stay, without a network. Returns how many cables it had. */
  function deleteNetwork(project, id) {
    project.networks = project.networks.filter((n) => n.id !== id);
    let n = 0;
    for (const c of project.cables) {
      if (c.network === id) {
        c.network = null;
        n++;
      }
    }
    return n;
  }

  // ------------------------------------------------------------- connecting

  function draftCable(props, id) {
    const p = props || {};
    return {
      id: id || null,
      type: p.type || null,
      network: p.network || null,
      a: M.cleanCableEnd(p.a),
      b: Array.isArray(p.b) ? p.b.map(M.cleanCableEnd) : M.cleanCableEnd(p.b),
    };
  }

  /**
   * Why a cable `{ a, b, type, network }` cannot be added (or, with
   * `ignoreCableId`, cable `ignoreCableId` cannot be changed to it), or null.
   * A breakout has `b` as a list of legs (null for an unused leg).
   */
  function checkConnect(project, props, ignoreCableId) {
    if (!ignoreCableId && project.cables.length >= L.cables) return `A plan holds ${L.cables} cables`;
    return M.cableProblem(project, draftCable(props, ignoreCableId), M.cableContext(project, ignoreCableId));
  }

  function finishCable(project, p, id, labels) {
    const network = p.network || null;
    const given = M.str(p.label, 40);
    return {
      id,
      type: p.type || null,
      network,
      label: labels ? (given ? labels.take(given) : labels.next(M.labelSeed(project, network), true)) : given || M.nextCableLabel(project, network),
      lengthM: M.clampNum(p.lengthM, 0.1, 10000, null),
      notes: typeof p.notes === 'string' ? p.notes.slice(0, 2000) : '',
      a: M.cleanCableEnd(p.a),
      b: Array.isArray(p.b) ? p.b.map(M.cleanCableEnd) : M.cleanCableEnd(p.b),
    };
  }

  /**
   * Adds a cable: { a, b, type, network, label, lengthM, notes }. Without a
   * label it continues its network's series. Returns { cable } or { error }.
   */
  function connect(project, props) {
    const error = checkConnect(project, props);
    if (error) return { error };
    const cable = finishCable(project, props || {}, M.uid('cb'));
    project.cables.push(cable);
    return { cable };
  }

  /**
   * connect for many cables in a row, reading the plan's ports and labels
   * once: { check(props), add(props) }. `check` says why connect would
   * refuse a cable (or null) and `add` adds it like connect. Labels it
   * hands out skip `taken` (a Set) as well. Nothing else may change the
   * plan's cables in between.
   */
  function connector(project, taken) {
    const ctx = M.cableContext(project);
    let labels = null;
    const check = (props) => (project.cables.length >= L.cables ? `A plan holds ${L.cables} cables` : M.cableProblem(project, draftCable(props), ctx));
    const add = (props) => {
      const error = check(props);
      if (error) return { error };
      labels = labels || M.labeler(project, taken);
      const cable = finishCable(project, props || {}, M.uid('cb'), labels);
      project.cables.push(cable);
      M.claimPorts(ctx, cable);
      return { cable };
    };
    return { check, add };
  }

  /** Changes a cable's ends, type, network, label, length or notes; refuses (with a message) what connect would. */
  function updateCable(project, id, changes) {
    const i = project.cables.findIndex((c) => c.id === id);
    if (i < 0) return 'Unknown cable';
    const merged = Object.assign({}, project.cables[i], changes);
    const error = checkConnect(project, merged, id);
    if (error) return error;
    project.cables[i] = finishCable(project, merged, id);
    return null;
  }

  /**
   * updateCable for many cables, reading the plan's ports once: cable `id`
   * of `ids` gets `changes` (an object, or a function of the cable and its
   * place in `ids` that returns one). Each change is checked as updateCable
   * checks it; a refused one leaves its cable as it was and the others go
   * on. Returns [{ id, error }] for the cables refused ([] when all changed).
   */
  function updateCables(project, ids, changes) {
    const ctx = M.cableContext(project);
    const at = new Map(project.cables.map((c, i) => [c.id, i]));
    const refused = [];
    ids.forEach((id, k) => {
      const i = at.get(id);
      if (i === undefined) return void refused.push({ id, error: 'Unknown cable' });
      const cur = project.cables[i];
      const merged = Object.assign({}, cur, typeof changes === 'function' ? changes(cur, k) : changes);
      const error = M.cableProblem(project, draftCable(merged, id), ctx);
      if (error) return void refused.push({ id, error });
      const next = finishCable(project, merged, id);
      for (const x of M.cableEnds(cur)) {
        const key = `${x.end.device}|${x.end.port}`;
        if (ctx.used.get(key) === cur) ctx.used.delete(key);
      }
      M.claimPorts(ctx, next);
      project.cables[i] = next;
    });
    return refused;
  }

  /** Removes cables by id (one id or a list); returns how many went. */
  function disconnect(project, ids) {
    const gone = new Set([].concat(ids));
    const before = project.cables.length;
    project.cables = project.cables.filter((c) => !gone.has(c.id));
    return before - project.cables.length;
  }

  /**
   * Plans cables from port `fromPort` of each device in `from` (taken in
   * rack order, top to bottom) to the ports of device `to`, starting at
   * `toPort` and advancing `step` ports each time. With `skipUsed`, ports
   * that already have a cable are passed over. With a breakout `type`, each
   * port of `to` is a head taking `legs` sources in a row. Labels start at
   * `firstLabel` and take the free labels of its series after it (a label
   * without a number starts a series: uplink → uplink-0001), else continue
   * the network's series. `label` is the label of one cable given by hand:
   * the first cable gets it as it is, even when another cable has it (that
   * is flagged, as for any label typed), and the others go on as without it. Ports of `to` that no cable can join
   * to the source (see joins) are passed over like used ones, so a run of
   * RJ45 ports does not spill into the cages after it. The plan is not changed:
   * returns [{ a, b, type, network, label, ok, reason, info }] for
   * connectSeries.
   */
  function planSeries(project, opts) {
    const o = Object.assign({ step: 1, skipUsed: true, type: null, network: null }, opts);
    const step = Math.max(1, Math.round(o.step) || 1);
    const target = M.deviceById(project, o.to);
    const type = o.type ? M.cableTypeById(project, o.type) : null;
    const legs = type && type.legs > 1 ? type.legs : 0;
    const ports = target ? M.expandPorts(M.typeOf(project, target.type)) : [];
    const ctx = M.cableContext(project);
    const labels = M.labeler(project);
    const items = [];
    const ids = new Set([].concat(o.from || []));
    const sources = M.sortedDevices(project).filter((d) => ids.has(d.id) && d.id !== o.to);
    const busy = (device, port) => ctx.used.get(`${device}|${port}`);
    const rctx = context(project);
    let pi = o.toPort ? ports.findIndex((p) => p.name === o.toPort) : 0;
    const noTarget = !target ? 'Pick the device to connect to' : pi < 0 ? `${target.name} has no port ${o.toPort}` : `No free port left on ${target.name}`;
    if (pi < 0) pi = ports.length;
    // Free ports passed over because no cable joins them to the source: the reason the series ran out, when it did.
    let unfit = false;

    /** The next port of the target for source device `src`, or null when none is left. */
    const nextTargetPort = (src) => {
      for (; pi < ports.length; pi += step) {
        const p = ports[pi];
        if (o.skipUsed && busy(target.id, p.name)) continue;
        if (!joins(project, { device: src.id, port: o.fromPort }, { device: target.id, port: p.name }, type, rctx)) {
          unfit = true;
          continue;
        }
        pi += step;
        return p;
      }
      return null;
    };
    const srcConn = (d) => {
      const pt = endPort(rctx, { device: d.id, port: o.fromPort });
      return pt ? connLabel(pt.connector) : o.fromPort;
    };
    const describeEnd = (e) => (e ? `${ctx.devices.get(e.device).name} ${e.port}` : '–');
    // Items are listed in the order of their (first) source.
    const plan = (at, a, b) => {
      const cable = { id: null, type: o.type || null, network: o.network || null, a, b };
      const reason = M.cableProblem(project, cable, ctx);
      const item = { a, b, type: cable.type, network: cable.network, label: '', ok: !reason, reason: reason || '', info: '' };
      item.info = `${describeEnd(a)} → ${Array.isArray(b) ? b.map(describeEnd).join(', ') : describeEnd(b)}`;
      if (item.ok) {
        // One cable's label given by hand is kept as it is. A first label of
        // a series is kept when free, else the next free one after it (one
        // without a number starts a series); the network's series continues
        // past its highest.
        const own = o.label && !items.some((x) => x.item.ok) ? M.str(o.label, 40) : '';
        item.label = own ? labels.take(own) : o.firstLabel ? labels.from(o.firstLabel) : labels.next(M.labelSeed(project, o.network), true);
        M.claimPorts(ctx, cable);
      }
      items.push({ at, item });
    };
    const refuse = (at, d, reason) => {
      const item = { a: { device: d.id, port: o.fromPort }, b: null, type: o.type || null, network: o.network || null, label: '', ok: false, reason, info: `${d.name} ${o.fromPort}` };
      items.push({ at, item });
    };

    // Sources whose port is missing or already cabled are reported without taking a port of the target.
    const ready = [];
    sources.forEach((d, at) => {
      const has = M.expandPorts(M.typeOf(project, d.type)).some((p) => p.name === o.fromPort);
      const other = has && busy(d.id, o.fromPort);
      if (!has) refuse(at, d, `${d.name} has no port ${o.fromPort}`);
      else if (other && o.skipUsed) refuse(at, d, `${d.name} ${o.fromPort} already has cable ${other.label || 'without a label'}`);
      else ready.push({ d, at });
    });
    const end = (d) => ({ device: d.id, port: o.fromPort });
    const chunk = legs || 1;
    for (let i = 0; i < ready.length; i += chunk) {
      const group = ready.slice(i, i + chunk);
      const p = target && nextTargetPort(group[0].d);
      const none = unfit ? `No free port left on ${target.name} that fits ${type ? type.name : srcConn(group[0].d)}` : noTarget;
      if (!p) group.forEach((x) => refuse(x.at, x.d, none));
      else if (legs) plan(group[0].at, { device: target.id, port: p.name }, Array.from({ length: legs }, (_, k) => (group[k] ? end(group[k].d) : null)));
      else plan(group[0].at, end(group[0].d), { device: target.id, port: p.name });
    }
    return items.sort((x, y) => x.at - y.at).map((x) => x.item);
  }

  /** Adds the cables of a plan from planSeries that are ok. Returns the cables added. */
  function connectSeries(project, items) {
    const out = [];
    const many = connector(project);
    for (const it of items) {
      if (!it.ok) continue;
      const r = many.add({ a: it.a, b: it.b, type: it.type, network: it.network, label: it.label });
      if (r.cable) out.push(r.cable);
    }
    return out;
  }

  // ----------------------------------------------------------------- length

  /** How far below the top of its rack a device's ports are, in metres: the middle of the device. */
  function dropM(ctx, d) {
    const pos = ctx.racks.get(d.loc.rack);
    if (d.loc.kind === 'side') {
      const units = M.rackUnits(ctx.project, pos.rack);
      const slots = Math.max(1, M.rackSideSlots(ctx.project, pos.rack));
      return ((d.loc.at + 0.5) / slots) * units * UNIT_M;
    }
    return (d.loc.at - 1 + M.deviceHeight(ctx.project, d) / 2) * UNIT_M;
  }

  /** Length between two ends, slack included: { m, how: 'rack'|'floor' }, or null across floors. */
  function runLength(ctx, a, b) {
    const p = ctx.project;
    const da = ctx.devices.get(a.device);
    const db = ctx.devices.get(b.device);
    const ra = da && ctx.racks.get(da.loc.rack);
    const rb = db && ctx.racks.get(db.loc.rack);
    if (!ra || !rb || ra.floor !== rb.floor) return null;
    const slack = M.rackSlackM(p, ra.rack) + M.deviceSlackM(p, da) + M.rackSlackM(p, rb.rack) + M.deviceSlackM(p, db);
    if (ra.rack === rb.rack) {
      const depth = endFace(ctx, a) !== endFace(ctx, b) ? M.rackTypeOf(p, ra.rack).depthMm / 1000 : 0;
      return { m: Math.abs(dropM(ctx, da) - dropM(ctx, db)) + depth + slack, how: 'rack' };
    }
    const pitch = ra.floor.rowPitchM === undefined || ra.floor.rowPitchM === null ? M.DEFAULT_ROW_PITCH_M : ra.floor.rowPitchM;
    const along = Math.abs(ctx.rackX.get(ra.rack.id) - ctx.rackX.get(rb.rack.id)) + Math.abs(ra.rowIndex - rb.rowIndex) * pitch;
    return { m: dropM(ctx, da) + dropM(ctx, db) + M.rackTrayM(p, ra.rack) + M.rackTrayM(p, rb.rack) + along + slack, how: 'floor' };
  }

  /**
   * The length a cable needs, to the centimetre: { m, how } with `how`
   * 'rack' when it stays in one rack, 'floor' when it runs over the tray.
   * A breakout needs the length of its longest leg. Null when an end is on
   * another floor.
   */
  function neededLength(project, cable, ctx) {
    const c = ctx || context(project);
    let m = null;
    let how = 'rack';
    for (const leg of M.legsOf(cable)) {
      if (!leg) continue;
      const r = cable.a && runLength(c, cable.a, leg);
      if (!r) return null;
      if (m === null || r.m > m) m = r.m;
      if (r.how === 'floor') how = 'floor';
    }
    return m === null ? null : { m: Math.round(m * 100) / 100, how };
  }

  /** The length to buy for `m` metres: the next stock length of the type (null past the longest), or the next 0.1 m when made to length. */
  function stockLength(type, m) {
    if (!type.lengthsM.length) return Math.max(0.1, Math.ceil(m * 10 - 1e-6) / 10);
    const l = type.lengthsM.find((x) => x >= m - 1e-9);
    return l === undefined ? null : l;
  }

  // ---------------------------------------------------------------- picking

  const mediaOf = (type) => M.MEDIA[type.media] || M.MEDIA.cat6a;

  /**
   * How plug `plug` of a cable type meets a port: { ok, exact, transceiver,
   * reaches, code }. Fiber at a cage needs a transceiver that fits the cage,
   * takes the plug and the fiber's mode: `chosen` (an id) or else the first
   * one in the catalog that reaches `metres`, an exact cage match first.
   */
  function endFit(ctx, type, plug, port, metres, chosen) {
    if (!port) return { ok: false, exact: false, transceiver: null, reaches: true, code: 'plug' };
    const media = mediaOf(type);
    const cage = M.connectorById(port.connector).cage;
    if (media.kind !== 'fiber' || !cage) {
      const ok = media.kind === 'fiber' ? plug === port.connector : M.plugFits(plug, port.connector);
      return { ok, exact: ok && plug === port.connector, transceiver: null, reaches: true, code: ok ? null : 'plug' };
    }
    const fits = (t) => M.plugFits(t.connector, port.connector) && t.fiber === plug && t.mode === media.mode;
    const reaches = (t) => metres === null || metres === undefined || t.reachM >= metres;
    if (chosen) {
      const t = ctx.transceivers.get(chosen) || null;
      const ok = !!t && fits(t);
      return { ok, exact: false, transceiver: t, reaches: !t || reaches(t), code: ok ? null : 'optics', chosen: true };
    }
    const list = ctx.project.transceivers.filter(fits);
    list.sort((x, y) => (y.connector === port.connector) - (x.connector === port.connector));
    if (!list.length) return { ok: false, exact: false, transceiver: null, reaches: true, code: 'optics' };
    const t = list.find(reaches) || list[0];
    return { ok: true, exact: false, transceiver: t, reaches: reaches(t), code: null };
  }

  function typeFit(ctx, type, cable, ports, metres, flip) {
    const plugA = flip ? type.connectorB : type.connector;
    const plugB = flip ? type.connector : type.connectorB;
    const a = endFit(ctx, type, plugA, ports.a, metres, cable.a && cable.a.transceiver);
    const b = M.legsOf(cable).map((e, i) => (e ? endFit(ctx, type, plugB, ports.b[i], metres, e.transceiver) : null));
    const all = [a].concat(b.filter(Boolean));
    const reaches = (!type.maxM || metres === null || metres === undefined || metres <= type.maxM) && all.every((f) => f.reaches);
    return { type, flip, plugA, plugB, a, b, ok: all.every((f) => f.ok), reaches, score: all.filter((f) => f.exact).length };
  }

  /**
   * The first fit in catalog order, except that a copper or direct type
   * whose plugs only match by family gives way to the first copper or
   * direct type in `fits` that matches the most ports exactly, wherever
   * that stands. Fiber types keep their place: they meet cages through
   * transceivers, so they neither win nor lose by it.
   */
  function firstFit(fits) {
    const direct = (f) => mediaOf(f.type).kind !== 'fiber';
    const first = fits[0];
    if (!first || !direct(first)) return first || null;
    const most = Math.max(...fits.filter(direct).map((f) => f.score));
    return first.score === most ? first : fits.find((f) => direct(f) && f.score === most);
  }

  /**
   * The cable type and transceivers of a cable for a run of `metres` (null:
   * unknown). A named type is used as it is; otherwise the type is picked:
   * the first single cable type in catalog order that fits both ports and
   * reaches, else the first that fits; of copper and direct types, exact
   * plug matches go before the same family (see firstFit). Returns { type,
   * auto, flip, transceivers: { a, b: [per leg] }, fits: { a, b: [per leg]
   * }, issues } where `fits` says which ends take their plug and issues are
   * the plug, optics and type checks.
   */
  function resolve(project, cable, metres, ctx) {
    const c = ctx || context(project);
    const ports = { a: endPort(c, cable.a), b: M.legsOf(cable).map((e) => (e ? endPort(c, e) : null)) };
    // A single type with two different plugs goes the way that fits, and of two that fit, the one matching more ports exactly.
    const tryType = (t) => {
      const f = typeFit(c, t, cable, ports, metres, false);
      if (t.legs > 1 || t.connector === t.connectorB) return f;
      const flipped = typeFit(c, t, cable, ports, metres, true);
      if (f.ok !== flipped.ok) return f.ok ? f : flipped;
      return flipped.score > f.score ? flipped : f;
    };
    let fit = null;
    const auto = !cable.type;
    if (!auto) {
      const t = c.cableTypes.get(cable.type);
      if (t) fit = tryType(t);
    } else if (!Array.isArray(cable.b)) {
      const fits = project.cableTypes.filter((t) => t.legs === 1).map(tryType).filter((f) => f.ok);
      fit = firstFit(fits.filter((f) => f.reaches)) || firstFit(fits);
    }
    const issues = [];
    if (!fit) {
      const legs = M.legsOf(cable).filter(Boolean);
      const b = legs.length ? endPort(c, legs[0]) : null;
      issues.push({
        code: 'type',
        level: 'warn',
        text: ports.a && b ? `No cable type in the catalog joins ${connLabel(ports.a.connector)} and ${connLabel(b.connector)}` : 'No cable type in the catalog fits',
        short: 'No cable type',
      });
    } else {
      const ends = [{ end: cable.a, f: fit.a, plug: fit.plugA }].concat(M.legsOf(cable).map((e, i) => ({ end: e, f: fit.b[i], plug: fit.plugB })));
      for (const { end, f, plug } of ends) {
        if (!end || f.ok) continue;
        const port = endPort(c, end);
        const where = `${endName(c, end)} (${port ? connLabel(port.connector) : 'no port'})`;
        const media = mediaOf(fit.type);
        if (f.code === 'plug') {
          issues.push({ code: 'plug', level: 'warn', text: `${fit.type.name} does not plug into ${where}`, short: 'Plug does not fit' });
        } else if (f.transceiver) {
          const t = f.transceiver;
          const text = M.plugFits(t.connector, port.connector) ? `${t.name} does not take ${connLabel(plug)} ${modeLabel(media.mode)} fiber` : `${t.name} does not fit ${where}`;
          issues.push({ code: 'optics', level: 'warn', text, short: 'Wrong optics' });
        } else {
          const text = `No transceiver in the catalog fits ${where} and takes ${connLabel(plug)} ${modeLabel(media.mode)} fiber`;
          issues.push({ code: 'optics', level: 'warn', text, short: 'Optics missing' });
        }
      }
    }
    return {
      type: fit ? fit.type : null,
      auto,
      flip: fit ? fit.flip : false,
      transceivers: { a: fit ? fit.a.transceiver : null, b: M.legsOf(cable).map((e, i) => (fit && fit.b[i] ? fit.b[i].transceiver : null)) },
      fits: { a: !!fit && fit.a.ok, b: M.legsOf(cable).map((e, i) => !!fit && !!fit.b[i] && fit.b[i].ok) },
      issues,
    };
  }

  /**
   * True when a cable can join port end `a` to port end `b` ({ device,
   * port }). With a cable `type` (an id or the type itself), when a plug of
   * it fits the port of `b` (the head's plug, for a breakout); transceivers
   * are not asked for, as a fiber type meets a cage of any family through
   * one. Without, when resolve finds a single cable type of the catalog
   * that fits both ports: the cable would not warn "No cable type".
   */
  function joins(project, a, b, type, ctx) {
    const c = ctx || context(project);
    const t = typeof type === 'string' ? c.cableTypes.get(type) : type;
    const port = endPort(c, b);
    if (!port) return false;
    if (!t) return !!endPort(c, a) && !!resolve(project, { a, b, type: null }, null, c).type;
    const plugs = t.legs > 1 ? [t.connector] : [t.connector, t.connectorB];
    return plugs.some((plug) => endFit(c, t, plug, port, null).code !== 'plug');
  }

  // ----------------------------------------------------------------- checks

  /** Speed of each leg, and the note when a leg runs slower than its faster port. */
  function speeds(c, cable, r) {
    const legs = M.legsOf(cable);
    const n = legs.length;
    const pa = endPort(c, cable.a);
    const out = { legs: [], note: null };
    legs.forEach((leg, i) => {
      if (!leg) return void out.legs.push(null);
      const pb = endPort(c, leg);
      const limits = [];
      if (pa) limits.push({ g: pa.speedGbps / n, port: true, what: `${endName(c, cable.a)} is the slower end` });
      if (pb) limits.push({ g: pb.speedGbps, port: true, what: `${endName(c, leg)} is the slower end` });
      if (r.type && r.type.speedGbps) limits.push({ g: r.type.speedGbps / n, what: `the ${r.type.name} is rated ${fmtSpeed(r.type.speedGbps / n)}` });
      // Optics that don't fit say nothing about the speed; the optics check does.
      const ta = r.fits.a && r.transceivers.a;
      const tb = r.fits.b[i] && r.transceivers.b[i];
      if (ta && ta.speedGbps) limits.push({ g: ta.speedGbps / n, what: `the ${ta.name} runs at ${fmtSpeed(ta.speedGbps / n)}` });
      if (tb && tb.speedGbps) limits.push({ g: tb.speedGbps, what: `the ${tb.name} runs at ${fmtSpeed(tb.speedGbps)}` });
      const rated = limits.filter((l) => l.g > 0);
      const speed = rated.length ? Math.min(...rated.map((l) => l.g)) : 0;
      const top = Math.max(0, ...rated.filter((l) => l.port).map((l) => l.g));
      out.legs.push(speed);
      if (speed && speed < top && !out.note) out.note = { speed, top, why: rated.find((l) => l.g === speed).what };
    });
    return out;
  }

  /**
   * Everything about a cable: { cable, type, auto, needM, how, lengthM,
   * lengthAuto, speedGbps, legSpeedsGbps, ends: [{ end, role, leg, device,
   * port, face, transceiver }], issues: [{ code, level: 'warn'|'note',
   * text, short }] }. `lengthM` is the length set, or the needed length
   * rounded up to a stock length (to 0.1 m when made to length); null when
   * there is none. Checks: plug, optics, speed, reach, stock, type, length
   * and label.
   */
  function describe(project, cable, ctx) {
    const c = ctx || context(project);
    const known = c.memo && c.memo.get(cable);
    if (known) return known;
    const need = neededLength(project, cable, c);
    const needM = need ? need.m : null;
    const lengthAuto = cable.lengthM === null || cable.lengthM === undefined;
    const metres = lengthAuto ? needM : cable.lengthM;
    const r = resolve(project, cable, metres, c);
    const type = r.type;
    const issues = r.issues.slice();
    const lengthM = !lengthAuto ? cable.lengthM : type && needM !== null ? stockLength(type, needM) : null;

    const sp = speeds(c, cable, r);
    // Speeds only matter for a cable that can be made: the plug, optics and type checks come first.
    if (sp.note && type && r.fits.a && r.fits.b.every((ok, i) => ok || !M.legsOf(cable)[i])) {
      issues.push({ code: 'speed', level: 'note', text: `Runs at ${fmtSpeed(sp.note.speed)}, not ${fmtSpeed(sp.note.top)}: ${sp.note.why}`, short: `Runs at ${shortSpeed(sp.note.speed)}` });
    }
    if (type && metres !== null) {
      const lead = lengthAuto ? `Needs ${fmtNeed(metres)}` : `Set to ${fmtM(metres)}`;
      const optics = [r.transceivers.a].concat(r.transceivers.b).filter(Boolean);
      const short = optics.find((t) => t.reachM < metres);
      if (type.maxM && metres > type.maxM) issues.push({ code: 'reach', level: 'warn', text: `${lead}: ${withArticle(type.name)} reaches ${fmtM(type.maxM)}`, short: 'Too long' });
      else if (short) issues.push({ code: 'reach', level: 'warn', text: `${lead}: the ${short.name} reaches ${fmtM(short.reachM)}`, short: 'Too long' });
      else if (type.lengthsM.length && stockLength(type, metres) === null) {
        const longest = type.lengthsM[type.lengthsM.length - 1];
        issues.push({ code: 'stock', level: 'warn', text: `${lead}: the longest ${type.name} is ${fmtM(longest)}`, short: 'No stock length' });
      }
    }
    if (needM === null && lengthAuto) {
      issues.push({ code: 'length', level: 'warn', text: 'The ends are on different floors: enter the length', short: 'No length' });
    } else if (!lengthAuto && needM !== null && cable.lengthM < needM - 1e-9) {
      issues.push({ code: 'length', level: 'warn', text: `Set to ${fmtM(cable.lengthM)} but needs ${fmtNeed(needM)}`, short: 'Too short' });
    }
    const uses = cable.label ? c.labels.get(cable.label) || 0 : 0;
    if (uses > 1) {
      issues.push({ code: 'label', level: 'warn', text: `The label ${cable.label} is used ${uses === 2 ? 'twice' : `${uses} times`}`, short: uses === 2 ? 'Label used twice' : `Label used ${uses} times` });
    }

    const legSpeeds = sp.legs;
    const rated = legSpeeds.filter((g) => g);
    const out = {
      cable,
      type,
      auto: r.auto,
      needM,
      how: need ? need.how : null,
      lengthM,
      lengthAuto,
      speedGbps: rated.length ? Math.min(...rated) : 0,
      legSpeedsGbps: legSpeeds,
      ends: M.cableEnds(cable).map((x) => ({
        end: x.end,
        role: x.role,
        leg: x.leg,
        device: c.devices.get(x.end.device) || null,
        port: endPort(c, x.end),
        face: endFace(c, x.end),
        transceiver: x.role === 'a' ? r.transceivers.a : r.transceivers.b[x.leg === null ? 0 : x.leg],
      })),
      issues,
    };
    if (c.memo) c.memo.set(cable, out);
    return out;
  }

  /** describe for many cables (default: all) with one context (made when `ctx` is not given). */
  function describeAll(project, cables, ctx) {
    ctx = ctx || context(project);
    return (cables || project.cables).map((c) => describe(project, c, ctx));
  }

  /**
   * What to order for `cables` (default: all), in catalog order: stock
   * cables by stock length (a length set between two is bought at the
   * longer), cables made to length with each length and the total, and
   * transceivers. `unresolved` counts cables without a type or length, or
   * longer than their type's longest stock length. `ctx` is optional.
   */
  function billOfMaterials(project, cables, ctx) {
    const stock = new Map();
    const made = new Map();
    const optics = new Map();
    let unresolved = 0;
    const bump = (map, key, sub) => {
      let m = map.get(key);
      if (!m) map.set(key, (m = new Map()));
      m.set(sub, (m.get(sub) || 0) + 1);
    };
    for (const d of describeAll(project, cables, ctx)) {
      for (const e of d.ends) if (e.transceiver) optics.set(e.transceiver.id, (optics.get(e.transceiver.id) || 0) + 1);
      // A length set between stock lengths is bought at the next one; past the longest it cannot be.
      const buy = d.type && d.lengthM !== null && d.type.lengthsM.length ? stockLength(d.type, d.lengthM) : d.lengthM;
      if (!d.type || buy === null) unresolved++;
      else bump(d.type.lengthsM.length ? stock : made, d.type.id, buy);
    }
    const byLength = (m) => [...m].sort((x, y) => x[0] - y[0]);
    return {
      cables: project.cableTypes.reduce((out, type) => out.concat(byLength(stock.get(type.id) || new Map()).map(([lengthM, count]) => ({ type, lengthM, count }))), []),
      madeToLength: project.cableTypes
        .filter((t) => made.has(t.id))
        .map((type) => {
          const lengths = byLength(made.get(type.id)).map(([lengthM, count]) => ({ lengthM, count }));
          return { type, lengths, totalM: Math.round(lengths.reduce((a, l) => a + l.lengthM * l.count, 0) * 100) / 100 };
        }),
      transceivers: project.transceivers.filter((t) => optics.has(t.id)).map((transceiver) => ({ transceiver, count: optics.get(transceiver.id) })),
      unresolved,
    };
  }

  // --------------------------------------------------------------- grouping

  const ROUTE_KINDS = ['rack', 'row', 'floor', 'plan'];

  /**
   * Where a cable runs: { key, label, kind } with kind 'rack' (Within Rack
   * A01), 'row' (Rack A01 ⇄ A02), 'floor' (Ground floor · Row A ⇄ Row B)
   * or 'plan' (Ground floor ⇄ First floor).
   */
  function routeOf(project, cable, ctx) {
    const c = ctx || context(project);
    const racks = [];
    for (const x of M.cableEnds(cable)) {
      const d = c.devices.get(x.end.device);
      const r = d && c.racks.get(d.loc.rack);
      if (r && !racks.includes(r)) racks.push(r);
    }
    racks.sort((x, y) => c.order.get(x.rack.id) - c.order.get(y.rack.id));
    const distinct = (list) => list.filter((v, i) => list.indexOf(v) === i);
    const rows = distinct(racks.map((r) => r.row));
    const floors = distinct(racks.map((r) => r.floor));
    if (!racks.length) return { key: 'none', label: 'Nowhere', kind: 'none' };
    if (racks.length === 1) return { key: `rack:${racks[0].rack.id}`, label: `Within ${racks[0].rack.name}`, kind: 'rack' };
    if (rows.length === 1) {
      const names = racks.map((r) => r.rack.name);
      const label = names.every((n) => n.startsWith('Rack ')) ? `Rack ${names.map((n) => n.slice(5)).join(' ⇄ ')}` : names.join(' ⇄ ');
      return { key: `racks:${racks.map((r) => r.rack.id).join('|')}`, label, kind: 'row' };
    }
    if (floors.length === 1) return { key: `rows:${rows.map((r) => r.id).join('|')}`, label: `${floors[0].name} · ${rows.map((r) => r.name).join(' ⇄ ')}`, kind: 'floor' };
    return { key: `floors:${floors.map((f) => f.id).join('|')}`, label: floors.map((f) => f.name).join(' ⇄ '), kind: 'plan' };
  }

  const compareRanks = (x, y) => {
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (x[i] === undefined ? -1 : x[i]) - (y[i] === undefined ? -1 : y[i]);
      if (d) return d;
    }
    return 0;
  };

  /**
   * Cables in groups: by 'route' (in plan order of their first rack, within
   * a rack first), 'network' or 'type' (in catalog order, then the ones
   * without), or 'device' (a cable is listed under each device it joins, in
   * rack order). Returns [{ key, label, cables }]; cables keep their order.
   * `context` is optional.
   */
  function groupCables(project, cables, by, context0) {
    const ctx = context0 || context(project);
    const groups = new Map();
    const put = (key, label, rank, cable) => {
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { key, label, cables: [], rank }));
      else if (compareRanks(rank, g.rank) < 0) g.rank = rank;
      g.cables.push(cable);
    };
    const netIndex = new Map(project.networks.map((n, i) => [n.id, i]));
    const typeIndex = new Map(project.cableTypes.map((t, i) => [t.id, i]));
    for (const cable of cables) {
      if (by === 'network') {
        const n = ctx.networks.get(cable.network);
        put(n ? n.id : '', n ? n.name : 'No network', [n ? netIndex.get(n.id) : Infinity], cable);
      } else if (by === 'type') {
        const t = describe(project, cable, ctx).type;
        put(t ? t.id : '', t ? t.name : 'No cable type', [t ? typeIndex.get(t.id) : Infinity], cable);
      } else if (by === 'device') {
        const seen = new Set();
        for (const x of M.cableEnds(cable)) {
          const d = ctx.devices.get(x.end.device);
          if (!d || seen.has(d.id)) continue;
          seen.add(d.id);
          put(d.id, d.name, [ctx.deviceOrder.get(d.id)], cable);
        }
      } else {
        const r = routeOf(project, cable, ctx);
        const orders = M.cableEnds(cable)
          .map((x) => ctx.devices.get(x.end.device))
          .filter(Boolean)
          .map((d) => ctx.order.get(d.loc.rack))
          .sort((a, b) => a - b);
        put(r.key, r.label, [orders[0], ROUTE_KINDS.indexOf(r.kind), orders[orders.length - 1]], cable);
      }
    }
    return [...groups.values()].sort((x, y) => compareRanks(x.rank, y.rank)).map(({ key, label, cables: list }) => ({ key, label, cables: list }));
  }

  /** Predicate for cables matching `query` (every word must occur in its label, devices, ports, network, type or notes), or null for an empty query. `context0` is optional. */
  function cableMatcher(project, query, context0) {
    const words = M.queryWords(query);
    if (!words.length) return null;
    const ctx = context0 || context(project);
    return (cable) => {
      const net = ctx.networks.get(cable.network);
      const type = describe(project, cable, ctx).type;
      const ends = M.cableEnds(cable).map((x) => endName(ctx, x.end));
      const text = [cable.label, cable.notes, net ? net.name : '', type ? type.name : ''].concat(ends).join(' ').toLowerCase();
      return words.every((w) => text.includes(w));
    };
  }

  // ----------------------------------------------------------------- fabric

  /** "cn-001 … 012" for names that differ in their last number, else "cn-001 … gpu-008". */
  function rangeName(names) {
    if (names.length < 2) return names.join('');
    const first = names[0];
    const last = names[names.length - 1];
    const m1 = /^(.*?)(\d+)$/.exec(first);
    const m2 = /^(.*?)(\d+)$/.exec(last);
    return m1 && m2 && m1[1] === m2[1] ? `${first} … ${m2[2]}` : `${first} … ${last}`;
  }

  /**
   * The links of fabric().links taken together: { n, speedGbps, totalGbps },
   * where speedGbps is the one speed every cable runs at, or 0 when they run
   * at different speeds (inside one link too: a pair of devices can be
   * joined by a 1G and a 10G cable) or are not rated.
   */
  function linkSpeed(links) {
    let n = 0;
    let totalGbps = 0;
    const speeds = new Set();
    for (const l of links) {
      n += l.count;
      totalGbps += l.totalGbps;
      for (const g of l.speedsGbps || [l.speedGbps]) speeds.add(g);
      if (!l.speedsGbps && l.count * l.speedGbps !== l.totalGbps) speeds.add(NaN);
    }
    const one = speeds.size === 1 ? [...speeds][0] : 0;
    return { n, speedGbps: one || 0, totalGbps };
  }
  /** "11×200G", or "3 · 600G" for links of different speeds, "2" for unrated ones; `sep` goes around the "×". */
  function linksLabel(links, sep) {
    const { n, speedGbps, totalGbps } = linkSpeed(links);
    if (speedGbps) return `${n}${sep || ''}×${sep || ''}${shortSpeed(speedGbps)}`;
    return totalGbps ? `${n} · ${shortSpeed(totalGbps)}` : `${n}`;
  }

  /** Switches: device types with at least 12 ports or a switch drawing. */
  function isSwitch(project, device) {
    const t = device && M.typeOf(project, device.type);
    return !!t && (t.face === 'rj45' || t.face === 'qsfp' || M.expandPorts(t).length >= 12);
  }

  /**
   * One network (null: the cables without one) as a graph. Leaves are
   * switches with links to nodes (devices that are not switches), cores
   * the other switches. Nodes with the same leaves, cluster and type form a
   * group. Returns { switches, cores, leaves, nodes, groups: [{ devices,
   * leaves, cluster, type, links }], links: [{ a, b, count, speedGbps (the
   * slowest), speedsGbps (each speed once), totalGbps }], ratios: Map
   * leafId → { down, up, ratio } in Gb/s, checks:
   * [{ level ('warn' or 'ok'), device (the leaf it is about, if one),
   * devices (the devices it is about, if several), leaves (the leaves of
   * the nodes it is about), text }]: leaves oversubscribed or without
   * uplinks, leaves that do not reach every core switch (or that they all
   * do), nodes on several leaves }; devices in rack order.
   */
  function fabric(project, networkId) {
    const ctx = context(project);
    const net = networkId || null;
    const peers = new Map();
    const pairs = new Map();
    const order = (id) => ctx.deviceOrder.get(id);
    const link = (a, b, g) => {
      for (const [x, y] of [[a, b], [b, a]]) {
        let m = peers.get(x);
        if (!m) peers.set(x, (m = new Map()));
        const p = m.get(y) || { count: 0, gbps: 0 };
        m.set(y, { count: p.count + 1, gbps: p.gbps + g });
      }
      const [x, y] = order(a) <= order(b) ? [a, b] : [b, a];
      const key = `${x}|${y}`;
      const p = pairs.get(key) || { a: x, b: y, count: 0, speeds: [] };
      p.count++;
      p.speeds.push(g);
      pairs.set(key, p);
    };
    for (const cable of project.cables) {
      if ((cable.network || null) !== net) continue;
      const d = describe(project, cable, ctx);
      M.legsOf(cable).forEach((leg, i) => {
        if (leg) link(cable.a.device, leg.device, d.legSpeedsGbps[i] || 0);
      });
    }
    const byOrder = (ids) => ids.sort((x, y) => order(x) - order(y)).map((id) => ctx.devices.get(id));
    const ids = [...peers.keys()];
    const sw = new Set(ids.filter((id) => isSwitch(project, ctx.devices.get(id))));
    const leafIds = ids.filter((id) => sw.has(id) && [...peers.get(id).keys()].some((p) => !sw.has(p)));
    const leafSet = new Set(leafIds);
    const ratios = new Map();
    const checks = [];
    for (const id of byOrder(leafIds.slice()).map((d) => d.id)) {
      let down = 0;
      let up = 0;
      for (const [peer, p] of peers.get(id)) {
        if (sw.has(peer)) up += p.gbps;
        else down += p.gbps;
      }
      const ratio = up ? down / up : null;
      ratios.set(id, { down, up, ratio });
      const name = ctx.devices.get(id).name;
      if (ratio !== null && ratio > OVERSUBSCRIBED) {
        checks.push({ level: 'warn', device: id, text: `${name} is oversubscribed ${fmtRatio(ratio)}: ${fmtSpeed(down)} down, ${fmtSpeed(up)} up` });
      } else if (ratio === null && ids.some((x) => sw.has(x) && !leafSet.has(x))) {
        checks.push({ level: 'warn', device: id, text: `${name} has no uplinks` });
      }
    }
    // Every leaf up to every core switch.
    const cores = byOrder([...sw].filter((id) => !leafSet.has(id)));
    const leaves = byOrder(leafIds.slice());
    if (cores.length && leaves.length) {
      const short = leaves.filter((lf) => cores.some((c) => !peers.get(lf.id).has(c.id)));
      const all = cores.length === 1 ? 'the core switch' : cores.length === 2 ? 'both core switches' : `all ${cores.length} core switches`;
      if (!short.length) checks.push({ level: 'ok', text: `Every leaf reaches ${all}` });
      else checks.push({ level: 'warn', devices: short.map((d) => d.id), text: `${short.map((d) => d.name).join(', ')} ${short.length === 1 ? 'does' : 'do'} not reach ${all}` });
    }
    const groups = new Map();
    for (const node of byOrder(ids.filter((id) => !sw.has(id)))) {
      const leaves = [...peers.get(node.id).keys()].filter((p) => leafSet.has(p)).sort((x, y) => order(x) - order(y));
      const key = [leaves.join(','), node.cluster || '', node.type].join('\u0000');
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { devices: [], leaves: leaves.map((id) => ctx.devices.get(id)), cluster: node.cluster || null, type: node.type, links: 0 }));
      g.devices.push(node);
      for (const p of peers.get(node.id).values()) g.links += p.count;
    }
    // Nodes on more than one leaf.
    for (const g of groups.values()) {
      if (g.leaves.length < 2) continue;
      const names = g.devices.map((d) => d.name);
      checks.push({ level: 'ok', devices: g.devices.map((d) => d.id), leaves: g.leaves.map((d) => d.id), text: `${rangeName(names)} hang${names.length === 1 ? 's' : ''} off ${g.leaves.length} leaves` });
    }
    return {
      switches: byOrder([...sw]),
      cores,
      leaves,
      nodes: byOrder(ids.filter((id) => !sw.has(id))),
      groups: [...groups.values()],
      links: [...pairs.values()].map((p) => ({ a: p.a, b: p.b, count: p.count, speedGbps: Math.min(...p.speeds), speedsGbps: [...new Set(p.speeds)].sort((x, y) => x - y), totalGbps: p.speeds.reduce((s, g) => s + g, 0) })),
      ratios,
      checks,
    };
  }

  // ------------------------------------------------------------ type ports

  /** Each cable as it would be if device type `typeId` got the port groups `newPorts` (null: gone), as model.updateDeviceType does it. */
  function portChangeAfter(project, typeId, newPorts) {
    const type = M.typeOf(project, typeId);
    if (!type || type.variable) return null;
    const work = Object.assign({}, project, {
      deviceTypes: project.deviceTypes.map((t) => (t.id === typeId ? Object.assign({}, t, { ports: M.cleanPorts(newPorts) }) : t)),
      cables: M.clone(project.cables),
    });
    M.remapPorts(work, typeId, type.ports || []);
    return new Map(work.cables.map((c) => [c.id, c]));
  }

  /**
   * Cables that would lose an end if device type `typeId` got the port
   * groups `newPorts`: ends keep their group and place in the group (see
   * model.portMoves).
   */
  function portChangeImpact(project, typeId, newPorts) {
    const after = portChangeAfter(project, typeId, newPorts);
    if (!after) return [];
    return project.cables.filter((c) => {
      const n = after.get(c.id);
      return !n || M.cableEnds(n).length < M.cableEnds(c).length;
    });
  }

  /**
   * Cables that keep their ends but would have one on another port name if
   * device type `typeId` got the port groups `newPorts`: [{ cable, moves:
   * [{ device, from, to }] }], so that renamed or moved ports can be named
   * before the change.
   */
  function portChangeMoves(project, typeId, newPorts) {
    const after = portChangeAfter(project, typeId, newPorts);
    if (!after) return [];
    const out = [];
    for (const c of project.cables) {
      const n = after.get(c.id);
      if (!n || M.cableEnds(n).length < M.cableEnds(c).length) continue;
      const moved = M.cableEnds(n);
      const moves = M.cableEnds(c)
        .map((x, i) => ({ device: x.end.device, from: x.end.port, to: moved[i].end.port }))
        .filter((m) => m.from !== m.to);
      if (moves.length) out.push({ cable: c, moves });
    }
    return out;
  }

  return {
    UNIT_M,
    OVERSUBSCRIBED,
    CONNECTORS: M.CONNECTORS,
    MEDIA: M.MEDIA,
    connectorById: M.connectorById,
    plugFits: M.plugFits,
    fmtM,
    fmtSpeed,
    shortSpeed,
    fmtRatio,
    linkSpeed,
    linksLabel,
    context,
    cableById,
    cableIndex,
    portOf,
    portFace,
    cablesOfDevice,
    cablesWithin,
    cleanCableType: M.cleanCableType,
    addCableType,
    updateCableType,
    deleteCableType,
    moveCableType,
    cableTypeUse,
    cleanTransceiver: M.cleanTransceiver,
    addTransceiver,
    updateTransceiver,
    deleteTransceiver,
    moveTransceiver,
    transceiverUse,
    cleanNetwork: M.cleanNetwork,
    addNetwork,
    updateNetwork,
    deleteNetwork,
    checkConnect,
    connect,
    connector,
    updateCable,
    updateCables,
    disconnect,
    planSeries,
    connectSeries,
    neededLength,
    stockLength,
    resolve,
    joins,
    describe,
    describeAll,
    billOfMaterials,
    routeOf,
    groupCables,
    cableMatcher,
    isSwitch,
    fabric,
    rangeName,
    portChangeImpact,
    portChangeMoves,
    remapPortsForType: M.remapPorts,
  };
});
