/*
 * Rackplanner 3D: the viewer.
 *
 * One ES module: builds the three.js scene from a normalized plan, walks or
 * orbits the datacenter, raycasts for hover and click, and fills the static
 * HTML chrome (toolbar, inspector, legend, dialogs) with the current plan.
 */
import * as THREE from '../vendor/three/build/three.module.js';

const M = window.RP.model;
const IO = window.RP.io;
const L = window.RP.layout;

/* --------------------------------------------------------------- helpers */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Rack names in plans often carry a redundant "Rack " prefix ("Rack A01");
// strip it for display only.
const rn = (s) => { const t = String(s).replace(/^rack[ \t]+/i, ''); return t || String(s); };

const MONO_FONT = 'ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace';
const _mc = document.createElement('canvas').getContext('2d');
/** Truncates text with '…' so it fits maxW (px) at the given font (default: the elevation's device-name font). */
function fitText(text, maxW, font = `7.5px ${MONO_FONT}`, ls = 0.2) {
  _mc.font = font;
  const width = (s) => _mc.measureText(s).width + s.length * ls;
  if (width(text) <= maxW) return { text, w: width(text) };
  let t = text;
  while (t.length > 1 && width(t + '…') > maxW) t = t.slice(0, -1);
  t += '…';
  return { text: t, w: width(t) };
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fmtKW = (w) => (w >= 1000 ? (w / 1000).toFixed(w >= 10000 ? 0 : 1).replace(/\.0$/, '') + ' kW' : Math.round(w) + ' W');
const fmtKG = (k) => (k >= 1000 ? (k / 1000).toFixed(1).replace(/\.0$/, '') + ' t' : Math.round(k) + ' kg');
const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');

const canvas = $('scene');
const tooltip = $('tooltip');
const crosshair = $('crosshair');
const inspector = $('inspector');
const inspBody = $('inspBody');

/* --------------------------------------------------------------- renderer */

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
const scene = new THREE.Scene();
// Matte studio backdrop: a soft vertical gradient, no sheen.
{
  const cv = document.createElement('canvas');
  cv.width = 2;
  cv.height = 512;
  const ctx = cv.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 512);
  g.addColorStop(0, '#28324a');
  g.addColorStop(0.55, '#161d29');
  g.addColorStop(1, '#0a0e15');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 2, 512);
  scene.background = new THREE.CanvasTexture(cv);
}
scene.fog = new THREE.Fog(0x10161f, 70, 180);
const camera = new THREE.PerspectiveCamera(62, 1, 0.05, 500);
camera.rotation.order = 'YXZ';
// Orthographic camera for the straight-on rack front view (looks exactly
// like the 2D elevation: no perspective distortion).
const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.05, 400);
let orthoH = 8; // visible height in meters
const ROW_VIEW_DIST = 2.6; // how far the row view camera stands from the row
function sizeOrtho() {
  const a = camera.aspect || 1;
  orthoCam.left = (-a * orthoH) / 2;
  orthoCam.right = (a * orthoH) / 2;
  orthoCam.top = orthoH / 2;
  orthoCam.bottom = -orthoH / 2;
  orthoCam.updateProjectionMatrix();
}

scene.add(new THREE.HemisphereLight(0xbdd3ff, 0x1a2433, 1.0));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(40, 80, 25);
scene.add(sun);

/* --------------------------------------------------------------- state */

let project = null; // the normalized plan (model.js shape)
let world = null; // { group, layout, pickables, pick, hover, sel, dvById }
let hovered = null; // { kind, entry, pos, size }
let selected = null;
let rackView = null; // row view: { row, re, x, targetX, activeIdx, t, ... }

const view = {
  mode: 'orbit',
  // orbit
  target: new THREE.Vector3(0, 1, 0),
  goal: new THREE.Vector3(0, 1, 0),
  radius: 40,
  goalR: 40,
  theta: 0.8,
  phi: 1.12,
  // walk
  pos: new THREE.Vector3(0, 1.6, 0),
  yaw: 0,
  pitch: 0,
  keys: new Set(),
};

const raycaster = new THREE.Raycaster();
const CENTER = new THREE.Vector2(0, 0);
const pointer = new THREE.Vector2(0, 0);
let pointerPx = { x: 0, y: 0 };
let dragging = null; // { btn, x, y }

/* --------------------------------------------------------------- labels */

/**
 * A fixed label plane: unlike a billboard sprite it never rotates toward
 * the camera — it sits on the hardware and is readable from the front
 * (callers rotate it with the rack's dir). Double-sided, so it remains
 * faintly visible from behind, through the cabinet.
 */
// Canvas supersampling: 6× so that even at the row-view distance the labels
// are ≥2× oversampled at the mip level the GPU picks (3× landed right between
// two mips there and looked soft).
const LABEL_SS = 6;

/** A label canvas: `w × h` logical px, drawn at LABEL_SS× internal resolution. */
function labelCanvas(w, h) {
  const cv = document.createElement('canvas');
  cv.width = w * LABEL_SS;
  cv.height = h * LABEL_SS;
  const c = cv.getContext('2d');
  c.scale(LABEL_SS, LABEL_SS); // drawing code stays in logical px
  return [cv, c];
}

function labelPlane(cv, w, h) {
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide })
  );
}

function rr(c, x, y, w, h, r) {
  if (c.roundRect) c.roundRect(x, y, w, h, r);
  else c.rect(x, y, w, h);
}

function drawSpark(c, x, y, s) {
  c.fillStyle = '#ffd75e';
  c.beginPath();
  c.moveTo(x + 0.45 * s, y);
  c.lineTo(x, y + 0.55 * s);
  c.lineTo(x + 0.35 * s, y + 0.55 * s);
  c.lineTo(x + 0.15 * s, y + s);
  c.lineTo(x + 0.75 * s, y + 0.4 * s);
  c.lineTo(x + 0.4 * s, y + 0.4 * s);
  c.closePath();
  c.fill();
}

const fmtW = (w) => (w >= 10000 ? (w / 1000).toFixed(0) + ' kW' : w >= 1000 ? (w / 1000).toFixed(1) + ' kW' : Math.round(w) + ' W');

/** Bottom panel: the rack name plus three usage bars (energy / weight / units). */
function rackPanel(name, st) {
  const [cv, c] = labelCanvas(256, 120);
  c.beginPath();
  rr(c, 1, 1, 254, 118, 10);
  c.fillStyle = 'rgba(12,17,26,0.88)';
  c.fill();
  c.beginPath();
  rr(c, 2, 2, 252, 116, 9);
  c.strokeStyle = 'rgba(110,135,170,0.45)';
  c.lineWidth = 2;
  c.stroke();
  c.fillStyle = '#e8eef7';
  c.font = '600 21px system-ui, sans-serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(name, 128, 17, 236);
  const rows = [
    { y: 38, sym: 'spark',
      frac: st.powerBudgetW > 0 ? st.powerW / st.powerBudgetW : 0,
      color: st.overPower ? '#ff5d5d' : st.powerBudgetW > 0 && st.powerW / st.powerBudgetW > 0.85 ? '#ffb43d' : '#58d68d',
      text: fmtW(st.powerW) + (st.powerBudgetW > 0 ? ' / ' + fmtW(st.powerBudgetW) : '') },
    { y: 64, sym: 'kg',
      frac: st.weightBudgetKg > 0 ? st.weightKg / st.weightBudgetKg : 0,
      color: st.overWeight ? '#ff5d5d' : st.weightBudgetKg > 0 && st.weightKg / st.weightBudgetKg > 0.85 ? '#ffb43d' : '#6fb3ff',
      text: Math.round(st.weightKg) + ' kg' + (st.weightBudgetKg > 0 ? ' / ' + Math.round(st.weightBudgetKg) + ' kg' : '') },
    { y: 90, sym: 'U',
      frac: st.units > 0 ? st.used / st.units : 0,
      color: '#ffd75e',
      text: st.used + '/' + st.units + ' U' },
  ];
  for (const row of rows) {
    const { y } = row;
    if (row.sym === 'spark') drawSpark(c, 10, y + 2, 14);
    else {
      c.fillStyle = '#9fb0c5';
      c.font = '700 12px system-ui, sans-serif';
      c.textAlign = 'left';
      c.textBaseline = 'middle';
      c.fillText(row.sym, 8, y + 10);
    }
    c.beginPath();
    rr(c, 32, y, 216, 18, 5);
    c.fillStyle = 'rgba(255,255,255,0.13)';
    c.fill();
    if (row.frac > 0) {
      c.beginPath();
      rr(c, 32, y, Math.max(10, 216 * Math.min(1, row.frac)), 18, 5);
      c.fillStyle = row.color;
      c.fill();
    }
    c.fillStyle = '#ffffff';
    c.font = '600 12px system-ui, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(row.text, 140, y + 10, 208);
  }
  return labelPlane(cv, 0.56, 0.262); // fits inside the 0.6 m rack width
}

/** Vertical rack name tag: one letter per line, running down the rack's front-left. */
function rackNameTag(name) {
  const LW = 40; // px per letter row
  const LH = name.length * LW + 14;
  const [cv, c] = labelCanvas(44, LH);
  c.beginPath();
  rr(c, 1, 1, 42, LH - 2, 8);
  c.fillStyle = 'rgba(12,17,26,0.55)';
  c.fill();
  c.fillStyle = '#e8eef7';
  c.font = '700 26px system-ui, sans-serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  for (let i = 0; i < name.length; i++) c.fillText(name[i], 22, 10 + LW / 2 + i * LW);
  const w = 0.055; // fits the 6 cm strip between the cabinet edge (0.30) and the device edge (0.24)
  return labelPlane(cv, w, (w * cv.height) / cv.width);
}

function floorLabel(text) {
  const [cv, c] = labelCanvas(512, 128);
  c.fillStyle = '#9fc2ff';
  c.font = '700 64px system-ui, sans-serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(text.toUpperCase(), 256, 64, 500);
  return labelPlane(cv, 3.4, 0.85);
}

const CHIP_PX2M = 0.0011; // device label scale: 1 canvas px = 1.1 mm

/**
 * A world-fixed device label (the row view's "chip"): cluster dot + name +
 * position, pinned to the top-left of the device face as seen from the
 * front. A plane like the rack labels — it never billboards toward the
 * camera. Side-slot devices get the vertical variant, running down the slot.
 */
function deviceLabelPlane(d, e) {
  const vertical = d.loc.kind === 'side';
  const pos = vertical ? `V${d.loc.at + 1}` : M.formatSpan(d.loc.at, d.loc.at + e.h - 1);
  const nameFont = `600 22px ${MONO_FONT}`;
  const posFont = `400 15px ${MONO_FONT}`;
  const H = 34, pad = 10, dot = 10, gap = 7; // px
  const maxName = vertical ? 380 : 300; // keeps the chip inside face / slot
  const { text: name, w: nameW } = fitText(d.name, maxName, nameFont, 0.5);
  _mc.font = posFont;
  const posW = _mc.measureText(pos).width + pos.length * 0.5;
  const L = pad + dot + gap + nameW + 8 + posW + pad; // the row's length
  const W = vertical ? H : L, Hh = vertical ? L : H; // logical px
  const [cv, c] = labelCanvas(W, Hh);
  if (vertical) {
    c.translate(H, 0); // the row runs down the slot, glyphs rotated 90°
    c.rotate(Math.PI / 2);
  }
  c.beginPath();
  rr(c, 1, 1, L - 2, H - 2, 7);
  c.fillStyle = 'rgba(10,14,20,0.85)';
  c.fill();
  c.strokeStyle = '#3a4a61';
  c.lineWidth = 1.5;
  c.stroke();
  c.beginPath();
  c.arc(pad + dot / 2, H / 2, dot / 2, 0, Math.PI * 2);
  c.fillStyle = e.color;
  c.fill();
  c.textBaseline = 'middle';
  c.fillStyle = '#dce5f1';
  c.font = nameFont;
  c.fillText(name, pad + dot + gap, H / 2 + 1);
  c.fillStyle = '#8fa1b8';
  c.font = posFont;
  c.fillText(pos, pad + dot + gap + nameW + 8, H / 2 + 1);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return new THREE.Mesh(
    new THREE.PlaneGeometry(W * CHIP_PX2M, Hh * CHIP_PX2M),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false })
  );
}

/* --------------------------------------------------------------- world */

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _vs = new THREE.Vector3();
const _c = new THREE.Color();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _t3 = new THREE.Vector3();

const put = (im, i, x, y, z, sx, sy, sz) => {
  _m.compose(_v.set(x, y, z), _q.identity(), _vs.set(sx, sy, sz));
  im.setMatrixAt(i, _m);
};

const FRAME_N = 12; // plinth, 4 posts, 4 rails, back panel, 2 side panels

/**
 * Procedural marble floor texture (cool light stone with soft veins).
 * Generated on a canvas so it stays a static, offline, no-build asset.
 */
function marbleTexture(w, d) {
  // One canvas per slab, mapped 1:1 over the whole floor: the marble runs
  // continuously across the slab instead of repeating ~1 m tiles.
  const S = 1024;
  const cv = document.createElement('canvas');
  cv.width = S;
  cv.height = Math.min(2048, Math.max(256, Math.round(S * d / w)));
  const k = S / 512; // pattern size relative to the old 1 m tile
  const c = cv.getContext('2d');
  c.fillStyle = '#b9c1ca';
  c.fillRect(0, 0, cv.width, cv.height);
  // Soft cloudy patches.
  for (let i = 0; i < 26; i++) {
    const x = Math.random() * cv.width, y = Math.random() * cv.height, r = (60 + Math.random() * 160) * k;
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, Math.random() < 0.5 ? 'rgba(228,232,238,0.5)' : 'rgba(148,158,172,0.4)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, cv.width, cv.height);
  }
  // Broad veins.
  for (let v = 0; v < 14; v++) {
    c.beginPath();
    let x = Math.random() * cv.width, y = Math.random() * cv.height, a = Math.random() * Math.PI * 2;
    c.moveTo(x, y);
    const steps = 30 + Math.floor(Math.random() * 40);
    for (let s = 0; s < steps; s++) {
      a += (Math.random() - 0.5) * 0.9;
      const len = (8 + Math.random() * 14) * k;
      x += Math.cos(a) * len;
      y += Math.sin(a) * len;
      c.lineTo(x, y);
    }
    c.strokeStyle = Math.random() < 0.7 ? 'rgba(122,133,148,0.35)' : 'rgba(90,100,116,0.4)';
    c.lineWidth = (0.8 + Math.random() * 2.2) * k;
    c.stroke();
  }
  // Fine dark cracks.
  for (let n = 0; n < 5; n++) {
    c.beginPath();
    let x = Math.random() * cv.width, y = Math.random() * cv.height, a = Math.random() * Math.PI * 2;
    c.moveTo(x, y);
    for (let s = 0; s < 50; s++) {
      a += (Math.random() - 0.5) * 0.7;
      x += Math.cos(a) * 9 * k;
      y += Math.sin(a) * 9 * k;
      c.lineTo(x, y);
    }
    c.strokeStyle = 'rgba(70,79,92,0.28)';
    c.lineWidth = 0.6 * k;
    c.stroke();
  }
  const t = new THREE.CanvasTexture(cv);
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function buildWorld() {
  const layout = L.compute(project);
  const g = new THREE.Group();
  const unit = new THREE.BoxGeometry(1, 1, 1);
  const edge = new THREE.EdgesGeometry(unit);
  const pick = { dev: [], side: [], res: [], frame: [] };

  // Floor slabs (polished marble): one mesh per floor, each with its own
  // non-repeating texture mapped over the whole slab.
  const slabs = [];
  layout.floors.forEach((f) => {
    const m = new THREE.Mesh(unit, new THREE.MeshStandardMaterial({ map: marbleTexture(f.slab.w, f.slab.d), roughness: 0.35, metalness: 0.05 }));
    m.position.set(f.slab.x, f.slab.y, f.slab.z);
    m.scale.set(f.slab.w, f.slab.h, f.slab.d);
    m.userData.floor = f;
    slabs.push(m);
    g.add(m);
  });

  // Rack frames, devices, side devices, reserved and over-budget frames are
  // each a solid + ghost InstancedMesh pair: the selected rack (or the rack
  // of a selected device) renders solid, every other rack at 10% opacity.
  // fillAll() rewrites both meshes whenever the selection changes.
  const GHOST = { transparent: true, opacity: 0.1, depthWrite: false };
  const mkPair = (geo, matS, matG, cap) => {
    const solid = new THREE.InstancedMesh(geo, matS, cap);
    const ghost = new THREE.InstancedMesh(geo, matG, cap);
    for (const im of [solid, ghost]) {
      im.count = 0;
      im.userData.idx = new Int32Array(cap);
      im.frustumCulled = false;
      g.add(im);
    }
    return [solid, ghost];
  };
  const [frameSolid, frameGhost] = mkPair(unit, new THREE.MeshStandardMaterial({ color: 0x303c4e, roughness: 0.8, metalness: 0.4 }), new THREE.MeshStandardMaterial({ color: 0x303c4e, roughness: 0.8, metalness: 0.4, ...GHOST }), layout.racks.length * FRAME_N);
  layout.racks.forEach((r) => pick.frame.push(r));

  // Side channel strip (one per rack that has side slots) and a slot box per
  // slot — mirroring the 2D sheet's side column. Chrome only: not pickable.
  const slotList = [];
  layout.racks.forEach((r, ri) => {
    for (let s = 0; s < r.rackType.sideSlots; s++) slotList.push({ r, ri, s });
  });
  const [chanSolid, chanGhost] = mkPair(unit, new THREE.MeshStandardMaterial({ color: 0x232c3c, roughness: 0.9, metalness: 0.2 }), new THREE.MeshStandardMaterial({ color: 0x232c3c, roughness: 0.9, metalness: 0.2, ...GHOST }), layout.racks.length);
  const [slotSolid, slotGhost] = mkPair(unit, new THREE.MeshStandardMaterial({ color: 0x141b28, roughness: 0.95, metalness: 0.1 }), new THREE.MeshStandardMaterial({ color: 0x141b28, roughness: 0.95, metalness: 0.1, ...GHOST }), Math.max(1, slotList.length));

  const devs = layout.devices;
  const nU = devs.filter((d) => !d.side && !d.reserved).length;
  const nS = devs.filter((d) => d.side && !d.reserved).length;
  const nR = devs.filter((d) => d.reserved).length;
  const [devSolid, devGhost] = mkPair(unit, new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.2 }), new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.2, ...GHOST }), nU);
  const [faceSolid, faceGhost] = mkPair(unit, new THREE.MeshBasicMaterial({ toneMapped: false }), new THREE.MeshBasicMaterial({ toneMapped: false, ...GHOST }), nU);
  const [sideSolid, sideGhost] = mkPair(unit, new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.2 }), new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.2, ...GHOST }), nS);
  const [sideFaceSolid, sideFaceGhost] = mkPair(unit, new THREE.MeshBasicMaterial({ toneMapped: false }), new THREE.MeshBasicMaterial({ toneMapped: false, ...GHOST }), nS);
  const [resSolid, resGhost] = mkPair(unit, new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.3, depthWrite: false, roughness: 0.9 }), new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.04, depthWrite: false, roughness: 0.9 }), nR);
  for (const dv of devs) {
    if (dv.reserved) pick.res.push(dv);
    else if (dv.side) pick.side.push(dv);
    else pick.dev.push(dv);
  }

  // Over-budget racks glow red: a soft translucent shell around the cabinet
  // (a wireframe frame read badly at an angle — it looked like a stray red
  // triangle). The shell is 3 cm proud of the cabinet on every side.
  const overRacks = layout.racks.filter((r) => r.stats.overPower || r.stats.overWeight);
  let overSolid = null, overGhost = null;
  if (overRacks.length) [overSolid, overGhost] = mkPair(unit, new THREE.MeshBasicMaterial({ color: 0xff4d4d, toneMapped: false, transparent: true, opacity: 0.2, depthWrite: false }), new THREE.MeshBasicMaterial({ color: 0xff4d4d, toneMapped: false, transparent: true, opacity: 0.03, depthWrite: false }), overRacks.length);

  // Labels.
  const labels = new Map();
  for (const r of layout.racks) {
    // Fixed to the cabinet front (never billboarded): readable from the
    // front, faintly visible from behind through the open cabinet.
    const face = r.dir === 1 ? 0 : Math.PI;
    const panel = rackPanel(rn(r.rack.name), r.stats);
    panel.rotation.y = face;
    panel.position.set(r.x, r.y + 0.38, r.z + r.dir * (L.RACK_D / 2 + 0.03));
    const tag = rackNameTag(rn(r.rack.name));
    tag.rotation.y = face;
    const tagH = tag.geometry.parameters.height;
    tag.position.set(
      r.x - r.dir * 0.27, // front-left strip: never over the device boxes (±0.24), still inside the cabinet (±0.30)
      Math.max(r.y + tagH / 2, r.topY - 0.06 - tagH / 2), // from the top, down; never below the floor
      r.z + r.dir * (L.RACK_D / 2 + 0.02)
    );
    labels.set(r.rack.id, [panel, tag]);
    g.add(panel, tag);
  }
  const floorLabels = [];
  layout.floors.forEach((f) => {
    const sp = floorLabel(f.floor.name);
    sp.position.set(0, f.y + 0.9, -f.slab.d / 2 - 1.1);
    floorLabels.push(sp);
    g.add(sp);
  });

  // Hover and selection outlines.
  const hover = new THREE.LineSegments(edge, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }));
  const sel = new THREE.LineSegments(edge, new THREE.LineBasicMaterial({ color: 0x35c4ff }));
  hover.visible = sel.visible = false;
  g.add(hover, sel);

  const dvById = new Map(layout.devices.map((dv) => [dv.d.id, dv]));
  const pickables = [devSolid, devGhost, faceSolid, faceGhost, sideSolid, sideFaceSolid, sideGhost, sideFaceGhost, resSolid, resGhost, frameSolid, frameGhost, ...slabs];
  const instanced = [frameSolid, frameGhost, chanSolid, chanGhost, slotSolid, slotGhost, devSolid, devGhost, faceSolid, faceGhost, sideSolid, sideGhost, sideFaceSolid, sideFaceGhost, resSolid, resGhost].concat(overSolid ? [overSolid, overGhost] : []);
  return {
    group: g,
    layout,
    labels,
    floorLabels,
    dvById,
    devSolid,
    devGhost,
    faceSolid,
    faceGhost,
    sideSolid,
    sideGhost,
    sideFaceSolid,
    sideFaceGhost,
    resSolid,
    resGhost,
    frameSolid,
    frameGhost,
    chanSolid,
    chanGhost,
    slotSolid,
    slotGhost,
    slotList,
    overSolid,
    overGhost,
    overRacks,
    slabs,
    pickables,
    instanced,
    focusId: null,
    keepSet: null, // row view: set of rack ids that stay solid
    pick,
    hover,
    sel,
  };
}

/** Writes one rack's 9 frame boxes into `im` at row `j`. */
function writeFrame(im, j, r) {
  const px = L.RACK_W / 2 - 0.025;
  const pz = L.RACK_D / 2 - 0.025;
  const h = r.height;
  let i = j;
  put(im, i++, r.x, r.y + L.BASE_H / 2, r.z, L.RACK_W - 0.02, L.BASE_H, L.RACK_D - 0.02);
  put(im, i++, r.x - px, r.y + h / 2, r.z - pz, 0.05, h, 0.05);
  put(im, i++, r.x + px, r.y + h / 2, r.z - pz, 0.05, h, 0.05);
  put(im, i++, r.x - px, r.y + h / 2, r.z + pz, 0.05, h, 0.05);
  put(im, i++, r.x + px, r.y + h / 2, r.z + pz, 0.05, h, 0.05);
  put(im, i++, r.x, r.y + h - 0.022, r.z + pz, L.RACK_W, 0.045, 0.05);
  put(im, i++, r.x, r.y + h - 0.022, r.z - pz, L.RACK_W, 0.045, 0.05);
  put(im, i++, r.x, r.y + L.BASE_H + 0.022, r.z + pz, L.RACK_W, 0.045, 0.05);
  put(im, i++, r.x, r.y + L.BASE_H + 0.022, r.z - pz, L.RACK_W, 0.045, 0.05);
  put(im, i++, r.x, r.y + L.BASE_H + (r.units * L.U) / 2, r.z - r.dir * (L.RACK_D / 2 - 0.015), L.RACK_W - 0.06, r.units * L.U, 0.02);
  // Side panels: the cabinet is closed, not an open frame.
  put(im, i++, r.x - (L.RACK_W / 2 - 0.0125), r.y + h / 2, r.z, 0.025, h, L.RACK_D - 0.1);
  put(im, i++, r.x + (L.RACK_W / 2 - 0.0125), r.y + h / 2, r.z, 0.025, h, L.RACK_D - 0.1);
}

/** Writes a rack's dark side channel strip (full unit height) into `im`. */
function writeChannel(im, j, r) {
  const cw = L.RACK_W / 2 - 0.2413; // 19" bay edge to the cabinet edge
  put(im, j, r.x + r.dir * (L.RACK_W / 2 - cw / 2), r.y + L.BASE_H + (r.units * L.U) / 2, r.z + r.dir * 0.476, cw, r.units * L.U, 0.012);
}

/** Writes a device body (or reserved block) into `im` at instance `j`. */
const writeDev = (im, j, dv) => put(im, j, dv.pos[0], dv.pos[1], dv.pos[2], dv.size[0], dv.size[1], dv.size[2]);

/**
 * Fills the solid/ghost instance meshes for the current selection: the
 * kept racks (world.keepSet in the row view, world.focusId otherwise) go
 * into the solid meshes, everything else into the ghost ones — or not at
 * all while the row view is open, where only the row's racks exist.
 * `userData.idx` maps instance → pick-list index. Fresh local cursors on
 * every fill: a mesh's own .count persists across fills and must never be
 * reused as a cursor.
 */
function fillAll() {
  const W = world;
  const fid = W.focusId;
  const keep = W.keepSet; // row view: the whole row stays solid
  const hide = !!rackView; // row view: no racks but the row's
  const solidOf = (id) => (keep ? keep.has(id) : id === fid);
  let fs = 0, fg = 0, cs = 0, cg = 0;
  for (let ri = 0; ri < W.layout.racks.length; ri++) {
    const r = W.layout.racks[ri];
    const solid = solidOf(r.rack.id);
    if (hide && !solid) continue;
    const im = solid ? W.frameSolid : W.frameGhost;
    const j = solid ? fs : fg;
    writeFrame(im, j, r);
    for (let k = 0; k < FRAME_N; k++) im.userData.idx[j + k] = ri;
    if (solid) fs += FRAME_N; else fg += FRAME_N;
    if (r.rackType.sideSlots) {
      const cim = solid ? W.chanSolid : W.chanGhost;
      const cj = solid ? cs++ : cg++;
      writeChannel(cim, cj, r);
      cim.userData.idx[cj] = ri;
    }
  }
  W.frameSolid.count = fs;
  W.frameGhost.count = fg;
  W.chanSolid.count = cs;
  W.chanGhost.count = cg;

  let ds = 0, dg = 0, ss = 0, sg = 0, rs = 0, rg = 0;
  let u = 0, s = 0, rv = 0;
  for (const dv of W.layout.devices) {
    const solid = solidOf(dv.rack.rack.id);
    const side = dv.side;
    if (dv.reserved) {
      if (!hide || solid) {
        const im = solid ? W.resSolid : W.resGhost;
        const j = solid ? rs++ : rg++;
        writeDev(im, j, dv);
        im.setColorAt(j, _c.set(dv.color));
        im.userData.idx[j] = rv;
      }
      rv++;
      continue;
    }
    if (!hide || solid) {
      const body = solid ? (side ? W.sideSolid : W.devSolid) : side ? W.sideGhost : W.devGhost;
      const face = solid ? (side ? W.sideFaceSolid : W.faceSolid) : side ? W.sideFaceGhost : W.faceGhost;
      const j = solid ? (side ? ss++ : ds++) : side ? sg++ : dg++;
      writeDev(body, j, dv);
      body.setColorAt(j, _c.set(dv.color));
      if (side) {
        const fx = dv.pos[0] + Math.sign(dv.pos[0] - dv.rack.x) * (dv.size[0] / 2 + 0.004);
        put(face, j, fx, dv.pos[1], dv.pos[2], 0.008, dv.size[1] * 0.92, dv.size[2] * 0.7);
        face.setColorAt(j, _c.set(dv.color).multiplyScalar(1.6));
      } else {
        const fz = dv.pos[2] + dv.rack.dir * (dv.size[2] / 2 + 0.004);
        put(face, j, dv.pos[0], dv.pos[1], fz, dv.size[0] * 0.94, dv.size[1] * 0.9, 0.01);
        face.setColorAt(j, _c.set(dv.color).multiplyScalar(1.7));
      }
      const pi = side ? s : u;
      body.userData.idx[j] = pi;
      face.userData.idx[j] = pi;
    }
    if (side) s++; else u++;
  }
  W.devSolid.count = ds;    W.devGhost.count = dg;
  W.faceSolid.count = ds;   W.faceGhost.count = dg;
  W.sideSolid.count = ss;   W.sideGhost.count = sg;
  W.sideFaceSolid.count = ss; W.sideFaceGhost.count = sg;
  W.resSolid.count = rs;    W.resGhost.count = rg;

  // Slot boxes: dark insets for the empty slots (an occupied one sits
  // hidden behind its device).
  let sls = 0, slg = 0;
  for (const se of W.slotList) {
    const solid = solidOf(se.r.rack.id);
    if (hide && !solid) continue;
    const im = solid ? W.slotSolid : W.slotGhost;
    const j = solid ? sls++ : slg++;
    put(im, j,
      se.r.x + se.r.dir * (L.RACK_W / 2 - 0.035), // same center as the slot's device
      se.r.topY - L.sideSlotTop(se.r.units, se.s, se.r.rackType.sideSlots) - L.SIDE_LEN / 2,
      se.r.z + se.r.dir * 0.49,
      L.SIDE_W, L.SIDE_LEN, 0.012);
    im.userData.idx[j] = se.ri;
  }
  W.slotSolid.count = sls;
  W.slotGhost.count = slg;

  if (W.overSolid) {
    let os = 0, og = 0;
    W.overRacks.forEach((r, i) => {
      const solid = solidOf(r.rack.id);
      if (hide && !solid) return;
      const im = solid ? W.overSolid : W.overGhost;
      const j = solid ? os++ : og++;
      put(im, j, r.x, r.y + r.height / 2, r.z, L.RACK_W + 0.06, r.height + 0.06, L.RACK_D + 0.06);
      im.userData.idx[j] = i;
    });
    W.overSolid.count = os;
    W.overGhost.count = og;
  }

  for (const im of W.instanced) {
    if (!im.count) continue;
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
  }
  for (const [id, arr] of W.labels) {
    const op = solidOf(id) ? 1 : hide ? 0 : 0.1;
    for (const spr of arr) spr.material.opacity = op;
  }
}

function disposeWorld(w) {
  scene.remove(w.group);
  w.group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const mat of mats) {
        if (mat.map) mat.map.dispose();
        mat.dispose();
      }
    }
  });
}

/* --------------------------------------------------------------- picking */

function entityBox(kind, entry) {
  if (kind === 'device' || kind === 'reserved') return { pos: entry.pos, size: entry.size };
  if (kind === 'rack') return { pos: [entry.x, entry.y + entry.height / 2, entry.z], size: [L.RACK_W + 0.05, entry.height + 0.05, L.RACK_D + 0.05] };
  const s = entry.slab;
  return { pos: [s.x, s.y, s.z], size: [s.w, s.h, s.d] };
}

function pickEntity(hit) {
  const o = hit.object;
  const W = world;
  // solid/ghost meshes carry instance → pick-list index in userData.idx;
  // face meshes share the index space of their body mesh.
  const idx = o.userData.idx ? o.userData.idx[hit.instanceId] : hit.instanceId;
  let kind;
  if (o === W.frameSolid || o === W.frameGhost) {
    const entry = W.pick.frame[idx];
    return { kind: 'rack', entry, box: entityBox('rack', entry) };
  }
  if (o.userData.floor) {
    const entry = o.userData.floor;
    return { kind: 'floor', entry, box: entityBox('floor', entry) };
  }
  const isSide = o === W.sideSolid || o === W.sideFaceSolid || o === W.sideGhost || o === W.sideFaceGhost;
  if (o === W.devSolid || o === W.faceSolid || o === W.devGhost || o === W.faceGhost) kind = 'device';
  else if (isSide) kind = 'device';
  else if (o === W.resSolid || o === W.resGhost) kind = 'reserved';
  else return null;
  const list = kind === 'device' && isSide ? W.pick.side : kind === 'device' ? W.pick.dev : W.pick.res;
  const entry = list[idx];
  return entry ? { kind, entry, box: entityBox(kind, entry) } : null;
}

function setOutline(line, box) {
  line.visible = true;
  line.position.set(box.pos[0], box.pos[1], box.pos[2]);
  line.scale.set(box.size[0], box.size[1], box.size[2]);
}

function updateHover(cam) {
  if (!world) return;
  // Hovering the elevation view drives the 3D highlight; otherwise raycast.
  if (elHover) hovered = { kind: 'device', entry: elHover, box: entityBox('device', elHover) };
  else {
    raycaster.far = view.mode === 'walk' ? 14 : Infinity;
    raycaster.setFromCamera(view.mode === 'walk' ? CENTER : pointer, cam);
    const hits = raycaster.intersectObjects(world.pickables, false);
    hovered = hits.length ? pickEntity(hits[0]) : null;
  }
  if (hovered) setOutline(world.hover, hovered.box);
  else world.hover.visible = false;
  // Keep the open elevation row in step with the 3D hover.
  if (openRackId && elevRows.size)
    for (const [id, el] of elevRows) el.classList.toggle('hl', !!(hovered && (hovered.kind === 'device' || hovered.kind === 'reserved') && hovered.entry.d.id === id));

  // Tooltip.
  if (hovered) {
    const e = hovered.entry;
    let text;
    if (hovered.kind === 'device' || hovered.kind === 'reserved') {
      const d = e.d;
      const t = e.type;
      const pos = d.loc.kind === 'side' ? `Side V${d.loc.at + 1}` : M.formatSpan(d.loc.at, d.loc.at + e.h - 1);
      text = `<b>${esc(d.name)}</b> · ${esc(t.label)} · ${esc(rn(e.rack.rack.name))} ${pos}`;
    } else if (hovered.kind === 'rack') {
      const st = e.stats;
      text = `<b>${esc(rn(e.rack.name))}</b> · ${e.rackType.name} · ${st.used}/${st.units} U · ${fmtKW(st.powerW)}`;
    } else {
      const st = M.statsWithin(project, e.floor.id);
      text = `<b>${esc(e.floor.name)}</b> · ${plural(st.racks, 'rack')} · ${plural(st.count, 'device')}`;
    }
    tooltip.innerHTML = text;
    tooltip.hidden = false;
    tooltip.classList.toggle('walk', view.mode === 'walk');
    if (view.mode === 'orbit') {
      tooltip.style.left = clamp(pointerPx.x + 16, 8, innerWidth - tooltip.offsetWidth - 8) + 'px';
      tooltip.style.top = clamp(pointerPx.y + 18, 8, innerHeight - tooltip.offsetHeight - 40) + 'px';
    }
  } else tooltip.hidden = true;
}

function focusEntity(ent) {
  if (view.mode !== 'orbit') return;
  const [x, y, z] = ent.box.pos;
  view.goal.set(x, clamp(y, 0.3, world.layout.bounds.top), z);
  const s = Math.max(...ent.box.size);
  view.goalR = ent.kind === 'device' || ent.kind === 'reserved' ? Math.max(5, s * 14) : ent.kind === 'rack' ? Math.max(9, s * 2.2) : Math.max(16, s * 0.8);
}

/** The rack id that should render solid for a selection (null = none). */
function focusIdFor(ent) {
  if (!ent) return null;
  if (ent.kind === 'rack') return ent.entry.rack.id;
  if (ent.kind === 'floor') return null;
  return ent.entry.rack.rack.id;
}

function select(ent) {
  selected = ent;
  if (selected) setOutline(world.sel, selected.box);
  else world.sel.visible = false;
  elHover = null;
  openRackId = null;
  elevRows.clear();
  if (!ent) {
    inspector.hidden = true;
    if (!rackView && world.focusId) {
      world.focusId = null;
      fillAll();
    }
    return;
  }
  if (ent.kind === 'rack') openRackId = ent.entry.rack.id;
  inspBody.innerHTML = ent.kind === 'floor' ? floorHTML(ent.entry) : ent.kind === 'rack' ? rackHTML(ent.entry) : deviceHTML(ent.entry);
  if (openRackId) for (const el of inspBody.querySelectorAll('.eldev')) elevRows.set(el.dataset.did, el);
  inspector.hidden = false;
  // The selected rack (or the rack of a selected device) stays solid; every
  // other rack drops to 10% opacity. While the front view is open the focus
  // is pinned to the viewed rack, no matter what gets clicked.
  const fid = rackView ? rackView.re.rack.id : focusIdFor(ent);
  if (world.focusId !== fid) {
    world.focusId = fid;
    fillAll();
  }
  focusEntity(ent);
}

/* --------------------------------------------------------------- elevation
 * A 2D front view of a rack, the way the 2D app draws it: unit grid, device
 * faces (ports, bays, fans, …), cluster colors, hatched reserved space,
 * side slots on the right. Rows are hoverable and clickable. */

const ELU = 10; // px per unit in the elevation view
let elHover = null; // layout device entry hovered in the elevation view
let openRackId = null; // rack id whose elevation is open (for 3D → row sync)
const elevRows = new Map(); // device id → row element

function faceSVG(face, w, h) {
  const s = [];
  const n = (count) => Math.max(1, Math.min(count, Math.floor(w / 8)));
  switch (face) {
    case 'rj45': {
      const ports = n(48), pw = (w - 12) / ports;
      for (let i = 0; i < ports; i++) s.push(`<rect x="${6 + i * pw + 1}" y="${h / 2 - 3.5}" width="${Math.max(2, pw - 2.5)}" height="7" fill="#22303f"/>`);
      break;
    }
    case 'qsfp': {
      const ports = n(24), pw = (w - 12) / ports;
      for (let i = 0; i < ports; i++) s.push(`<rect x="${6 + i * pw + 1}" y="${h / 2 - 4}" width="${Math.max(3, pw - 3)}" height="8" fill="#22303f"/>`);
      break;
    }
    case 'patch': {
      const ports = n(24), pw = (w - 12) / ports;
      for (const r2 of [0, 1]) for (let i = 0; i < ports; i++) s.push(`<rect x="${6 + i * pw + 1}" y="${h * (0.28 + r2 * 0.4)}" width="${Math.max(2, pw - 2.5)}" height="${h * 0.2}" fill="#22303f"/>`);
      break;
    }
    case 'pdu': {
      const outs = n(12), pw = (w - 16) / outs;
      for (let i = 0; i < outs; i++) s.push(`<circle cx="${10 + i * pw + pw / 2}" cy="${h / 2}" r="${Math.min(3.5, pw / 2 - 1.5)}" fill="none" stroke="#22303f" stroke-width="1.4"/>`);
      break;
    }
    case 'compute': {
      const bays = h > 14 ? 8 : 4, pw = (w * 0.42) / bays;
      for (let i = 0; i < 5; i++) s.push(`<rect x="8" y="${4 + i * (h - 8) / 5}" width="${w * 0.42}" height="2" fill="#22303f" opacity="0.5"/>`);
      for (let i = 0; i < bays; i++) s.push(`<rect x="${w * 0.52 + i * pw + 1}" y="${h / 2 - 4}" width="${pw - 2.5}" height="8" fill="#22303f"/>`);
      break;
    }
    case 'storage': {
      const cols = 12, rows2 = h > 16 ? 2 : 1, pw = (w - 16) / cols, ph = (h - 10) / rows2;
      for (let r2 = 0; r2 < rows2; r2++) for (let i = 0; i < cols; i++) s.push(`<rect x="${8 + i * pw + 1}" y="${5 + r2 * ph + 1}" width="${pw - 2.5}" height="${ph - 2.5}" fill="#22303f" opacity="0.85"/>`);
      break;
    }
    case 'jbod': {
      const drawers = h > 18 ? 2 : 1, dh = (h - 10) / drawers;
      for (let d = 0; d < drawers; d++) {
        const dy = 5 + d * dh;
        s.push(`<rect x="8" y="${dy}" width="${w - 16}" height="${dh - 4}" fill="none" stroke="#22303f" stroke-width="1.3"/>`);
        s.push(`<line x1="${w / 2 - 14}" y1="${dy + dh / 2 - 2}" x2="${w / 2 + 14}" y2="${dy + dh / 2 - 2}" stroke="#22303f" stroke-width="2"/>`);
      }
      break;
    }
    case 'gpu': {
      const r3 = Math.min(6, (h - 10) / 2);
      for (let i = 0; i < 4; i++) s.push(`<circle cx="${w * 0.58 + i * (w * 0.36) / 4}" cy="${h / 2}" r="${r3}" fill="none" stroke="#22303f" stroke-width="1.3"/>`);
      for (let i = 0; i < 4; i++) s.push(`<rect x="8" y="${3 + i * (h - 6) / 4}" width="${w * 0.36}" height="1.6" fill="#22303f" opacity="0.5"/>`);
      break;
    }
    case 'ups':
      s.push(`<rect x="${w - 46}" y="${h / 2 - 4}" width="26" height="8" fill="#22303f"/>`);
      s.push(`<circle cx="${w - 12}" cy="${h / 2}" r="3" fill="none" stroke="#22303f" stroke-width="1.4"/>`);
      break;
    case 'blank':
      for (let i = 0; i < 3; i++) s.push(`<rect x="${w * (0.25 + i * 0.2)}" y="${h / 2 - 1}" width="${w * 0.12}" height="2" fill="#22303f" opacity="0.6"/>`);
      break;
    default: // generic
      for (let i = 0; i < 6; i++) s.push(`<line x1="${8 + i * (w - 16) / 6}" y1="${h - 4}" x2="${16 + i * (w - 16) / 6}" y2="4" stroke="#22303f" stroke-width="1.6" opacity="0.55"/>`);
  }
  return s.join('');
}

function elevationSVG(re) {
  const rt = re.rackType;
  const units = rt.units;
  const W = 280;
  const left = 26;
  const right = rt.sideSlots ? 24 : 8;
  const faceX = left;
  const faceW = W - right - left - 4;
  const top = 6;
  const H = top + units * ELU + 8;
  const o = [];
  o.push(`<svg class="elev" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(rn(re.rack.name))} front view">`);
  o.push(`<defs><pattern id="hatch" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse"><rect width="6" height="6" fill="#151c28"/><line x1="0" y1="0" x2="0" y2="6" stroke="#3a4656" stroke-width="2"/></pattern></defs>`);
  o.push(`<rect x="2" y="${top - 2}" width="${W - 4}" height="${units * ELU + 4}" rx="2" fill="#0d131c" stroke="#3a4a61" stroke-width="1.5"/>`);
  for (let u = 1; u <= units; u++) {
    o.push(`<line x1="${left - 3}" y1="${top + u * ELU}" x2="${W - right + 2}" y2="${top + u * ELU}" stroke="#243044" stroke-width="${u % 5 ? 0.4 : 0.8}" opacity="${u % 5 ? 0.5 : 0.9}"/>`);
    o.push(`<text class="unum" x="13" y="${top + (u - 0.5) * ELU + 2.5}">${u}</text>`);
  }
  // Side channel + slot boxes, like the 2D sheet: every slot is drawn, the
  // empty ones as dashed boxes.
  const nSlots = rt.sideSlots || 0;
  if (nSlots) {
    const cx = W - right + 4;
    const sh = 12 * ELU; // a slot runs 12 U
    const gapPx = (units * ELU - nSlots * sh) / (nSlots + 1);
    const bySlot = new Map();
    for (const d of M.sortedDevices(project, re.rack.id)) if (d.loc.kind === 'side') bySlot.set(d.loc.at, d);
    o.push(`<rect x="${cx - 2}" y="${top}" width="${ELU + 4}" height="${units * ELU}" fill="#101724"/>`);
    for (let k = 0; k < nSlots; k++) {
      const sy = top + gapPx + k * (sh + gapPx);
      const d = bySlot.get(k);
      if (!d) {
        o.push(`<rect x="${cx}" y="${sy}" width="${ELU}" height="${sh}" rx="1.5" fill="none" stroke="#3a4a61" stroke-width="1" stroke-dasharray="3 2.5"/>`);
        continue;
      }
      const e = world.dvById.get(d.id);
      const name = esc(fitText(d.name, sh - 10).text); // vertical text: fits the slot box
      o.push(`<g class="eldev" data-did="${d.id}">`);
      o.push(`<rect class="elbg" x="${cx}" y="${sy}" width="${ELU}" height="${sh}" rx="1.5" fill="${e.color}" fill-opacity="0.25" stroke="${e.color}" stroke-width="1.2"/>`);
      if (e.type.face === 'pdu') for (let i = 0; i < 6; i++) o.push(`<circle cx="${cx + ELU / 2}" cy="${sy + 9 + i * (sh - 18) / 5}" r="2" fill="none" stroke="#9fb2c8" stroke-width="1"/>`);
      o.push(`<text class="dname" transform="translate(${cx + 2} ${sy + 5}) rotate(90)">${name}</text>`);
      o.push(`</g>`);
    }
  }
  for (const d of M.sortedDevices(project, re.rack.id)) {
    const e = world.dvById.get(d.id);
    if (!e) continue;
    const col = e.color;
    if (d.loc.kind === 'side') continue; // drawn with the slot boxes above
    const y = top + (d.loc.at - 1) * ELU;
    const hpx = e.h * ELU;
    const fit = fitText(d.name, faceW - 18); // keep the name inside the device box
    const name = esc(fit.text);
    const nameW = Math.min(faceW - 16, fit.w + 8);
    o.push(`<g class="eldev" data-did="${d.id}">`);
    o.push(`<rect class="elbg" x="${faceX}" y="${y + 0.5}" width="${faceW}" height="${hpx - 1}" rx="1" fill="${e.reserved ? 'url(#hatch)' : col}" fill-opacity="${e.reserved ? 1 : 0.22}" stroke="${col}" stroke-width="1.2"/>`);
    o.push(`<rect x="${faceX}" y="${y + 0.5}" width="3" height="${hpx - 1}" fill="${col}"/>`);
    if (!e.reserved) o.push(`<g transform="translate(${faceX + 8} ${y + 1})">${faceSVG(e.type.face, faceW - 16, hpx - 2)}</g>`);
    o.push(`<rect x="${faceX + 6}" y="${y + 1}" width="${nameW}" height="10" rx="1.5" fill="#0d131c" opacity="0.78"/>`);
    o.push(`<text class="dname" x="${faceX + 10}" y="${y + 8.5}">${name}</text>`);
    o.push(`</g>`);
  }
  o.push(`</svg>`);
  return o.join('');
}

/* --------------------------------------------------------------- inspector */

const row = (dt, dd) => (dd ? `<dt>${dt}</dt><dd>${dd}</dd>` : '');

function deviceHTML(e) {
  const d = e.d;
  const t = e.type;
  const re = e.rack;
  const cl = d.cluster ? M.clusterById(project, d.cluster) : null;
  const pos = d.loc.kind === 'side' ? `Side slot V${d.loc.at + 1}` : M.formatSpan(d.loc.at, d.loc.at + e.h - 1);
  const power = M.powerOf(project, d);
  const weight = M.weightOf(project, d);
  return `
    <h2>${esc(d.name)}</h2>
    <p class="loc">${esc(re.floor.name)} · ${esc(re.row.name)} · ${esc(rn(re.rack.name))} · ${pos}</p>
    <dl>
      ${row('Cluster', cl ? `<span class="chip" style="background:${cl.color}"></span>${esc(cl.name)}` : '<span class="dim">none</span>')}
      ${row('Type', `${esc(t.label)}<small>${esc(t.tag)}${t.spec ? ' · ' + esc(t.spec) : ''} · ${e.h}U</small>`)}
      ${row('Power', `${fmtKW(power)}${d.powerW != null && d.powerW !== t.powerW ? `<small> type ${fmtKW(t.powerW)}</small>` : ''}`)}
      ${row('Weight', `${fmtKG(weight)}${d.weightKg != null && d.weightKg !== t.weightKg ? `<small> type ${fmtKG(t.weightKg)}</small>` : ''}`)}
      ${row('Serial number', d.serial ? esc(d.serial) : '')}
      ${row('Asset tag', d.asset ? esc(d.asset) : '')}
      ${row('IP address', d.ip ? esc(d.ip) : '')}
      ${row('Owner', d.owner ? esc(d.owner) : '')}
      ${row('Notes', d.notes ? `<p class="notes">${esc(d.notes)}</p>` : '')}
    </dl>
    <button class="linkish" data-act="rackview" data-id="${re.rack.id}">Show ${esc(rn(re.rack.name))}</button>`;
}

function barHTML(used, budget, over) {
  if (!budget) return `${fmtKW(used)}<small class="dim"> · no budget</small>`;
  const pct = clamp((used / budget) * 100, 0, 100);
  return `<span class="bar${over ? ' over' : ''}"><span style="width:${pct}%"></span></span> ${fmtKW(used)} / ${fmtKW(budget)}`;
}

function rackHTML(re) {
  const st = re.stats;
  const rt = re.rackType;
  return `
    <h2>${esc(rn(re.rack.name))}</h2>
    <p class="loc">${esc(re.floor.name)} · ${esc(re.row.name)}</p>
    <dl>
      ${row('Type', `${esc(rt.name)} · ${rt.units}U · ${rt.sideSlots} side slots`)}
      ${row('Space', `${st.used} / ${st.units} U used${st.reserved ? `, ${st.reserved} U reserved` : ''}`)}
      ${row('Power', barHTML(st.powerW, st.powerBudgetW, st.overPower) + (st.overPower ? ' <b class="over">over budget</b>' : ''))}
      ${row('Weight', rt.weightKg ? `${fmtKG(st.weightKg)} / ${fmtKG(rt.weightKg)}${st.overWeight ? ' <b class="over">over</b>' : ''}` : fmtKG(st.weightKg))}
      ${row('Devices', `${st.count} devices${rt.sideSlots ? `, ${st.sideUsed} / ${rt.sideSlots} side slots` : ''}`)}
    </dl>
    <button class="linkish" data-act="rackview" data-id="${re.rack.id}">⌖ Front view in 3D</button>
    <h3>Front view</h3>
    ${elevationSVG(re)}`;
}

function floorHTML(f) {
  const st = M.statsWithin(project, f.floor.id);
  return `
    <h2>${esc(f.floor.name)}</h2>
    <dl>
      ${row('Rows', plural(f.floor.rows.length, 'row'))}
      ${row('Racks', plural(st.racks, 'rack'))}
      ${row('Devices', plural(st.count, 'device'))}
      ${row('Space', `${st.used} / ${st.units} U used`)}
      ${row('Power', fmtKW(st.powerW))}
      ${row('Weight', fmtKG(st.weightKg))}
      ${row('Over budget', st.overPower || st.overWeight ? `<b class="over">${st.overPower + st.overWeight} rack(s)</b>` : 'none')}
    </dl>`;
}

inspBody.addEventListener('click', (ev) => {
  const dvEl = ev.target.closest('.eldev');
  if (dvEl) {
    const dv = world.dvById.get(dvEl.dataset.did);
    if (dv) select({ kind: 'device', entry: dv, box: entityBox('device', dv) });
    return;
  }
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.dataset.id;
  if (btn.dataset.act === 'rack' || btn.dataset.act === 'rackview') {
    const re = world.layout.rackBy.get(id);
    if (!re) return;
    select({ kind: 'rack', entry: re, box: entityBox('rack', re) });
    if (btn.dataset.act === 'rackview') enterRackView(re);
  }
});
inspBody.addEventListener('mouseover', (ev) => {
  const t = ev.target.closest('.eldev');
  if (t) elHover = world.dvById.get(t.dataset.did) || null;
});
inspBody.addEventListener('mouseout', (ev) => {
  const t = ev.target.closest('.eldev');
  if (t && !t.contains(ev.relatedTarget)) elHover = null;
});
$('inspClose').addEventListener('click', () => select(null));

/* --------------------------------------------------------------- toolbar */

function buildFloors() {
  const nav = $('floors');
  nav.innerHTML = '';
  world.layout.floors.forEach((f, i) => {
    const b = document.createElement('button');
    b.textContent = f.floor.name;
    b.title = `Focus ${f.floor.name}`;
    b.addEventListener('click', () => {
      if (rackView) exitRackView();
      if (view.mode === 'walk') {
        view.pos.y = f.y + 1.6;
      } else {
        view.goal.set(0, f.y + Math.min(2, f.slab.w * 0.15), 0);
        view.goalR = Math.max(14, f.slab.w * 1.1);
      }
    });
    nav.appendChild(b);
  });
}

function buildLegend() {
  const el = $('legend');
  const counts = new Map();
  for (const d of project.devices) counts.set(d.cluster || '∅', (counts.get(d.cluster || '∅') || 0) + 1);
  el.innerHTML = project.clusters.length
    ? project.clusters.map((c) => `<li><span class="chip" style="background:${c.color}"></span>${esc(c.name)} <small>${counts.get(c.id) || 0}</small></li>`).join('')
    : '<li class="dim">no clusters</li>';
}

function setProject(p, source) {
  project = p;
  rackView = null;
  overlayEl.hidden = true;
  overlayEl.innerHTML = '';
  overlayItems = [];
  if (world) disposeWorld(world);
  world = buildWorld();
  scene.add(world.group);
  fillAll();
  selected = null;
  hovered = null;
  elHover = null;
  openRackId = null;
  elevRows.clear();
  inspector.hidden = true;
  tooltip.hidden = true;

  $('planName').textContent = p.name + (source && source !== p.name ? ` — ${source}` : '');
  const t = M.statsWithin(p, null);
  $('planInfo').textContent = `${plural(p.floors.length, 'floor')} · ${plural(t.racks, 'rack')} · ${plural(t.count, 'device')} · ${fmtKW(t.powerW)}`;
  buildFloors();
  buildLegend();

  const b = world.layout.bounds;
  view.goal.set(0, Math.min(2.5, b.top * 0.4), 0);
  view.target.copy(view.goal);
  view.radius = view.goalR = Math.max(b.w, b.d) * 1.05 + 8;
  view.theta = 0.8;
  view.phi = 1.12;
}

/* --------------------------------------------------------------- loading */

function toastWarnings(warnings) {
  const el = $('warnings');
  el.innerHTML = `<details open><summary>⚠ ${warnings.length} problem${warnings.length === 1 ? '' : 's'} while loading</summary><ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></details>`;
  el.hidden = false;
  clearTimeout(toastWarnings.t);
  toastWarnings.t = setTimeout(() => (el.hidden = true), 15000);
}
$('warningsClose').addEventListener('click', () => ($('warnings').hidden = true));

async function openText(text, name) {
  const looksCSV = /(?:^|\n)[^\n]*[;,][^\n]*\r?\n/.test(text) && !/^\s*[{\[]/.test(text);
  let result;
  try {
    result = looksCSV ? IO.importCSV(text) : IO.normalizeProject(JSON.parse(text));
  } catch (e) {
    $('loadErr').textContent = e.message;
    $('loadErr').hidden = false;
    return;
  }
  $('loadErr').textContent = '';
  $('loadErr').hidden = true;
  if (result.warnings && result.warnings.length) toastWarnings(result.warnings);
  $('loadDialog').close();
  setProject(result.project, name && name !== result.project.name ? name : null);
}

$('loadOk').addEventListener('click', async () => {
  const file = $('loadFile').files[0];
  if (file) return openText(await file.text(), file.name);
  const text = $('loadText').value.trim();
  if (text) return openText(text, null);
  $('loadErr').textContent = 'Choose a file or paste a plan.';
});
$('loadExample').addEventListener('click', () => {
  $('loadDialog').close();
  setProject(M.createExampleProject(), null);
});
async function loadPlanFile(file) {
  const res = await fetch(file);
  if (!res.ok) throw new Error('could not load ' + file);
  const result = IO.normalizeProject(await res.json());
  if (result.warnings.length) toastWarnings(result.warnings);
  return result.project;
}
$('loadExampleBig').addEventListener('click', async () => {
  $('loadDialog').close();
  try {
    setProject(await loadPlanFile('plans/example-big.json'), null);
  } catch (e) {
    $('loadErr').textContent = 'Could not load the big example: ' + e.message;
    $('loadErr').hidden = false;
  }
});
$('loadBtn').addEventListener('click', () => {
  $('loadFile').value = '';
  $('loadText').value = '';
  $('loadErr').textContent = '';
  $('loadDialog').showModal();
});

$('linkBtn').addEventListener('click', async () => {
  const code = await IO.encodeShare(project);
  const url = location.href.split('#')[0] + '#plan=' + code;
  try {
    await navigator.clipboard.writeText(url);
    flash($('linkBtn'), 'Copied ✓');
  } catch (e) {
    window.prompt('Copy this link:', url);
  }
});
function flash(btn, text) {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = old), 1200);
}

/* --------------------------------------------------------------- controls */

function lockPointer() {
  try {
    canvas.requestPointerLock?.()?.catch?.(() => {});
  } catch (e) {
    /* pointer lock unavailable (e.g. iframe without allow) */
  }
}

function setMode(mode) {
  view.mode = mode;
  $('orbitBtn').classList.toggle('active', mode === 'orbit');
  $('walkBtn').classList.toggle('active', mode === 'walk');
  crosshair.hidden = mode !== 'walk';
  $('modeHint').textContent = mode === 'walk' ? 'WASD move · Shift run · E/Q up/down · mouse look · click inspect · Esc orbit' : 'drag rotate · wheel zoom · right-drag pan · click inspect · V walk';
}

function toWalk() {
  view.mode = 'walk';
  const n = world.layout.floors.length;
  const fi = clamp(Math.round(camera.position.y / L.FLOOR_H), 0, n - 1);
  view.pos.set(camera.position.x, fi * L.FLOOR_H + 1.6, camera.position.z);
  const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
  view.yaw = e.y;
  view.pitch = e.x;
  setMode('walk');
  lockPointer();
}

function toOrbit() {
  view.keys.clear();
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  view.goal.copy(camera.position).addScaledVector(dir, 8);
  view.goal.y = Math.max(0.4, view.goal.y);
  const off = camera.position.clone().sub(view.goal);
  view.theta = Math.atan2(off.x, off.z);
  view.phi = clamp(Math.acos(clamp(off.y / Math.max(off.length(), 0.001), -1, 1)), 0.05, 1.5707);
  view.radius = view.goalR = 12;
  view.mode = 'orbit';
  setMode('orbit');
}

$('orbitBtn').addEventListener('click', () => {
  if (rackView) return toRowOrbit(); // orbit the row, stay in row mode
  if (view.mode !== 'orbit') toOrbit();
});
$('walkBtn').addEventListener('click', () => {
  if (rackView) exitRackView();
  if (view.mode !== 'walk') toWalk();
});
$('fadeBtn').addEventListener('click', () => {
  chipFade = !chipFade;
  $('fadeBtn').classList.toggle('active', chipFade);
  if (rackView) updateRowLabelsFade();
});
$('leaveRowBtn').addEventListener('click', () => exitRackView());

/* ----------------------------------------------- rack row view (ortho) */

const overlayEl = $('rackOverlay');
let overlayItems = []; // { el, anchor }
let chipFade = true; // distance fade of the device labels (toolbar toggle, on by default)

function addOverlayItem(el, anchor, opts = {}) {
  overlayEl.appendChild(el);
  overlayItems.push({ el, anchor, clamp: opts.clamp, center: opts.center });
}

/** Builds the floating rack description shown in the row view. */
function buildRackOverlay(re) {
  overlayEl.innerHTML = '';
  overlayItems = [];
  const st = re.stats;
  const head = document.createElement('div');
  head.className = 'rk-head';
  head.innerHTML =
    `<b>${esc(rn(re.rack.name))}</b> · ${esc(re.rackType.name)} · ${st.used}/${st.units} U · ${fmtKW(st.powerW)}${st.powerBudgetW ? ' / ' + fmtKW(st.powerBudgetW) : ''}` +
    `${st.overPower || st.overWeight ? ' · <span class="over">over budget</span>' : ''}`;
  // clamp: keep the rack description on screen (just under the toolbar) even
  // when zoomed in so far that the anchor point is off-screen.
  // The header is centered in the view (its top edge follows the rack top).
  addOverlayItem(head, new THREE.Vector3(re.x, re.topY + L.TOP_H + 0.12, re.z), { clamp: true, center: true });
  // Floor name: pinned at the left middle of the view.
  const fl = document.createElement('div');
  fl.className = 'rk-floor';
  fl.textContent = re.floor.name.toUpperCase();
  overlayEl.appendChild(fl);
  overlayEl.hidden = false;
}

/* Device labels of the open row: world-fixed planes on the hardware. */
let rowLabels = []; // { m, i } — the label mesh and its rack index in the row

function buildRowLabels() {
  rackView.row.racks.forEach((rr, i) => {
    for (const d of M.sortedDevices(project, rr.rack.id)) {
      const e = world.dvById.get(d.id);
      if (!e) continue;
      const m = deviceLabelPlane(d, e);
      const vertical = d.loc.kind === 'side';
      const lw = m.geometry.parameters.width;
      const lh = m.geometry.parameters.height;
      m.rotation.y = rr.dir === 1 ? 0 : Math.PI; // face the row's front
      // Top-left corner of the face as seen from the front (flips with dir).
      const sx = rr.dir === 1 ? 1 : -1;
      m.position.set(
        e.pos[0] - sx * (e.size[0] / 2 - lw / 2 - (vertical ? 0.004 : 0.006)),
        e.pos[1] + e.size[1] / 2 - lh / 2 - 0.004,
        // Just in front of the lit face strip (it ends at +0.009 from the
        // body front) so the label is never buried inside the hardware.
        e.pos[2] + rr.dir * (e.size[2] / 2 + 0.022)
      );
      world.group.add(m);
      rowLabels.push({ m, i });
    }
  });
  updateRowLabelsFade();
}

/** Distance fade of the device labels (the "Fade" toolbar toggle). */
function updateRowLabelsFade() {
  for (const { m, i } of rowLabels)
    m.material.opacity = chipFade ? Math.max(0.1, 1 - 0.3 * Math.abs(i - rackView.activeIdx)) : 1;
}

function updateOverlay(cam) {
  const minTop = $('bar').offsetHeight + 10;
  for (const it of overlayItems) {
    _t3.copy(it.anchor).project(cam);
    if (_t3.z > 1) {
      it.el.style.display = 'none';
      continue;
    }
    it.el.style.display = '';
    let top = (-_t3.y * 0.5 + 0.5) * innerHeight;
    if (it.clamp) top = Math.max(minTop, top);
    it.el.style.left = it.center ? '50%' : ((_t3.x * 0.5 + 0.5) * innerWidth) + 'px';
    it.el.style.top = top + 'px';
  }
}

/** The layout row entry ({ row, dir, z, racks }) a rack entry stands in. */
function rowEntryOf(re) {
  const f = world.layout.floors.find((f) => f.floor === re.floor);
  return f.rows.find((r) => r.row === re.row);
}

/** Pan the row view to center on (possibly another) rack of the row. */
function recenterOn(re) {
  const rv = rackView;
  const idx = rv.row.racks.findIndex((r) => r.rack.id === re.rack.id);
  if (idx < 0) return;
  rv.activeIdx = idx;
  rv.targetX = re.x;
  rv.re = re;
  // In the orbit around the row the pivot (the row's middle point) never
  // moves: switching racks only changes the labels and the selection.
  buildRackOverlay(re); // the floating description follows the centered rack
  select({ kind: 'rack', entry: re, box: entityBox('rack', re) }); // and so does the panel
  updateRowLabelsFade(); // the distance fade follows the centered rack
  syncRowNav(); // the rack slider follows too
}

/** Scroll one rack left/right in the row view. */
function stepRack(step) {
  const rv = rackView;
  const idx = clamp(rv.activeIdx + step, 0, rv.row.racks.length - 1);
  if (idx !== rv.activeIdx) recenterOn(rv.row.racks[idx]);
}

/* ------------------------------------------- row/rack sliders (row view) */

/** Keeps the left-side sliders in sync with the row view (or hides them). */
function syncRowNav() {
  const nav = $('rowNav');
  if (!rackView) {
    nav.hidden = true;
    return;
  }
  nav.hidden = false;
  const rv = rackView;
  const rows = world.layout.floors.find((f) => f.floor === rv.re.floor).rows;
  const rowSlider = $('rowSlider');
  rowSlider.max = rows.length - 1;
  rowSlider.value = Math.max(0, rows.indexOf(rv.row));
  $('rowVal').textContent = rv.row.row.name;
  const rackSlider = $('rackSlider');
  rackSlider.max = rv.row.racks.length;
  rackSlider.value = rv.activeIdx + 1;
  $('rackVal').textContent = rn(rv.re.rack.name);
}

$('rowSlider').addEventListener('input', (e) => {
  if (!rackView) return;
  const rows = world.layout.floors.find((f) => f.floor === rackView.re.floor).rows;
  const rowE = rows[+e.target.value];
  if (!rowE || rowE === rackView.row) return;
  // Same rack column in the new row, clamped to its length. The camera
  // flies over to the new row (the Flight slider's duration).
  enterRackView(rowE.racks[clamp(rackView.activeIdx, 0, rowE.racks.length - 1)], flightDur);
});

$('rackSlider').addEventListener('input', (e) => {
  if (!rackView) return;
  const idx = +e.target.value - 1;
  if (idx !== rackView.activeIdx) recenterOn(rackView.row.racks[idx]);
});

let flightDur = 3; // seconds — the row-switch flight (the "Flight" slider)
$('flightSlider').addEventListener('input', (e) => {
  flightDur = +e.target.value;
  $('flightVal').textContent = flightDur + ' s';
});

/**
 * Switch the row view from the flat front-on camera to a free orbit around
 * the row: row mode itself — and its transparency — stays on, only the
 * camera changes. Dragging in the row view does this; so does the toolbar's
 * Orbit button. The big “Leave row mode” button (or Esc) is what exits.
 */
function toRowOrbit() {
  const rv = rackView;
  if (!rv || rv.cam === 'orbit') return;
  const re = rv.re;
  rv.cam = 'orbit';
  // Pivot: the middle point of the row, fixed for the rest of the row
  // mode. From then on only the orbit angle changes — the distance from
  // this point never does (except an explicit Shift+wheel zoom).
  const row = rv.row.racks;
  const midX = (row[0].x + row[row.length - 1].x) / 2;
  let midY = 0;
  for (const r of row) midY += r.y + r.height / 2;
  midY /= row.length;
  view.target.set(midX, midY, re.z);
  view.goal.copy(view.target);
  // Keep the camera exactly where the ortho view was: same position, new
  // pivot, so the switch must not jump or zoom.
  const ox = rv.x - midX;
  const oy = re.y + re.height / 2 - midY;
  const oz = re.dir * ROW_VIEW_DIST;
  const dist = Math.sqrt(ox * ox + oy * oy + oz * oz);
  view.radius = view.goalR = dist;
  view.theta = Math.atan2(ox, oz);
  view.phi = clamp(Math.acos(clamp(oy / dist, -1, 1)), 0.05, 1.5707);
}

/**
 * Row front view: the ortho camera stands in front of the rack's whole row.
 * The row reads as a clean strip of cabinets; the mouse wheel scrolls
 * through it rack by rack (shift+wheel zooms).
 */
/**
 * @param {number} flyDur  Flight duration in seconds (row slider, "Flight"):
 *   crane up to a 45° view of the whole floor, pan across to the new row,
 *   descend behind it, and — as the last step — rotate around to face its
 *   front. All flight timings are fractions of this total. 0 = the usual
 *   0.55 s entry. During the flight both transition rows stay solid; every
 *   other row is hidden.
 */
function enterRackView(re, flyDur = 0) {
  const fly = flyDur > 0;
  // The flight starts from the camera that is actually on screen.
  const inOrtho = !rackView || rackView.cam === 'ortho';
  const fromPos = (inOrtho ? orthoCam : camera).position.clone();
  const fromTarget = (rackView ? (inOrtho ? rackView.target : view.target) : view.target).clone();
  const fromH = inOrtho && rackView ? orthoH : 2 * view.radius * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const fromRow = rackView ? rackView.row : null;
  if (rackView) {
    if (rowEntryOf(re) === rackView.row) return recenterOn(re); // same row: just re-center
    exitRackView(fly); // fly keeps the active camera as the flight's start point
  }
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  const rowE = rowEntryOf(re);
  const cy = re.y + re.height / 2;
  view.mode = 'orbit';
  setMode('orbit');
  const T2 = new THREE.Vector3(re.x, cy, re.z);
  let flyState = null;
  if (fly) {
    // Spherical flight parameters. Start: the current camera relative to
    // the old view center. Top: 45° above the floor center, far enough for
    // the whole floor to fit in the frame.
    const slab = world.layout.floors.find((f) => f.floor === re.floor).slab;
    const off = fromPos.clone().sub(fromTarget);
    const r0 = Math.max(0.5, off.length());
    flyState = {
      T0: fromTarget.clone(),
      T2,
      Tfloor: new THREE.Vector3(0, re.y + 1, 0),
      theta0: Math.atan2(off.x, off.z),
      phi0: clamp(Math.acos(clamp(off.y / r0, -1, 1)), 0.05, Math.PI - 0.05),
      r0,
      theta1: re.dir === 1 ? 0 : Math.PI, // the new row's front (last step)
      rTop: Math.max(slab.w, slab.d) * 0.75 + 4,
      Htop: Math.min(90, Math.max(slab.w, slab.d) * 0.7 + 4),
    };
  }
  rackView = {
    row: rowE,
    re,
    cam: 'ortho', // 'ortho' front view, or 'orbit' around the row (drag)
    x: re.x, // current view center (eased)
    targetX: re.x, // the rack the view is scrolling to
    activeIdx: rowE.racks.findIndex((r) => r.rack.id === re.rack.id),
    t: 0,
    wheelAcc: 0,
    target: T2.clone(),
    fromPos,
    fromH,
    fromTarget,
    finalH: re.height * 1.4, // relaxed framing: floor below, labels above
    minH: re.height * 0.35, // close up on a few devices
    maxH: 90, // zoom right out to take in the whole row
    fly,
    flyState,
    dur: fly ? flyDur : 0.55, // all flight timings are fractions of dur
  };
  // The row stays solid, every other row ghosted so it reads as a clean
  // strip. During a flight the old row stays solid too, so both
  // transition rows are visible.
  world.keepSet = fly && fromRow
    ? new Set([...fromRow.racks, ...rowE.racks].map((r) => r.rack.id))
    : new Set(rowE.racks.map((r) => r.rack.id));
  world.focusId = re.rack.id;
  for (const sp of world.floorLabels) sp.visible = false; // replaced by the pinned floor chip
  fillAll();
  buildRackOverlay(re);
  buildRowLabels();
  syncRowNav();
  $('leaveRowBtn').hidden = false;
}

const easeIO = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2); // easeInOutQuad

function updateRackView(dt) {
  const rv = rackView;
  const re = rv.re;
  rv.t = Math.min(1, rv.t + dt / rv.dur);
  // Ease the view center toward the rack it's scrolling to.
  if (Math.abs(rv.targetX - rv.x) > 0.0004) rv.x += (rv.targetX - rv.x) * Math.min(1, dt * 6);
  else rv.x = rv.targetX;
  const cy = re.y + re.height / 2;
  if (rv.fly) {
    // The 3 s flight in four steps, one motion each, so they stay
    // seamless: 1) crane up to a 45° view of the whole floor, 2) pan
    // across the floor over to the new row, 3) descend behind it — and
    // 4) the last step: rotate around to face the new row's front.
    const F = rv.flyState;
    const ROT = 0.72; // the last step (the rotation) starts here
    const s = (t0, t1) => easeIO(clamp((rv.t - t0) / (t1 - t0), 0, 1));
    const u1 = s(0, 0.28);    // rise
    const u2 = s(0.28, 0.5);  // pan
    const u3 = s(0.5, ROT);   // descend
    const u4 = s(ROT, 1);     // rotate — the last step
    const phi = rv.t < 0.5
      ? THREE.MathUtils.lerp(F.phi0, Math.PI / 4, u1)
      : rv.t < ROT ? THREE.MathUtils.lerp(Math.PI / 4, Math.PI / 2, u3) : Math.PI / 2;
    const radius = rv.t < 0.5
      ? THREE.MathUtils.lerp(F.r0, F.rTop, u1)
      : rv.t < ROT ? THREE.MathUtils.lerp(F.rTop, ROW_VIEW_DIST, u3) : ROW_VIEW_DIST;
    // A quarter turn (45° of the full swing) happens while rising, the
    // remaining three quarters in the last (rotation) step.
    const theta = rv.t < ROT
      ? THREE.MathUtils.lerp(F.theta0, F.theta1, 0.25 * u1)
      : THREE.MathUtils.lerp(F.theta0, F.theta1, 0.25 + 0.75 * u4);
    if (rv.t < 0.28) _t1.lerpVectors(F.T0, F.Tfloor, u1);
    else if (rv.t < 0.5) _t1.lerpVectors(F.Tfloor, _t2.set(rv.x, cy, re.z), u2);
    else _t1.copy(_t2.set(rv.x, cy, re.z));
    orthoCam.position.set(
      _t1.x + radius * Math.sin(phi) * Math.sin(theta),
      _t1.y + radius * Math.cos(phi),
      _t1.z + radius * Math.sin(phi) * Math.cos(theta)
    );
    orthoH = rv.t < 0.28
      ? THREE.MathUtils.lerp(rv.fromH, F.Htop, u1)
      : rv.t < ROT ? F.Htop : THREE.MathUtils.lerp(F.Htop, rv.finalH, u4);
    sizeOrtho();
    rv.target.copy(_t1);
    orthoCam.lookAt(rv.target);
    // As the final rotation begins, the old row is out of the transition
    // again — the turn would otherwise swing it back into full view.
    if (rv.t >= ROT && !rv.oldRowHidden) {
      rv.oldRowHidden = true;
      world.keepSet = new Set(rv.row.racks.map((r) => r.rack.id));
      fillAll();
    }
    if (rv.t >= 1) rv.fly = false;
  } else {
    const k = easeIO(rv.t);
    _t1.set(rv.x, cy, re.z);
    _t2.set(rv.x, cy, re.z + re.dir * ROW_VIEW_DIST);
    orthoCam.position.lerpVectors(rv.fromPos, _t2, k);
    if (rv.t < 1) orthoH = rv.fromH + (rv.finalH - rv.fromH) * k; // then the wheel owns zoom
    sizeOrtho();
    rv.target.lerpVectors(rv.fromTarget, _t1, k);
    orthoCam.lookAt(rv.target);
  }
}

function exitRackView(keepCamera = false) {
  const rv = rackView;
  if (!rv) return;
  const re = rv.re;
  const wasOrbit = rv.cam === 'orbit';
  rackView = null;
  world.keepSet = null;
  world.focusId = focusIdFor(selected); // refollow the real selection
  fillAll(); // restore the racks hidden while the row view was open
  for (const arr of world.labels.values()) for (const spr of arr) spr.visible = true;
  for (const sp of world.floorLabels) sp.visible = true;
  overlayEl.hidden = true;
  overlayEl.innerHTML = '';
  overlayItems = [];
  $('leaveRowBtn').hidden = true;
  syncRowNav();
  for (const { m } of rowLabels) {
    world.group.remove(m);
    m.geometry.dispose();
    m.material.map.dispose();
    m.material.dispose();
  }
  rowLabels = [];
  if (wasOrbit || keepCamera) return; // the perspective camera already owns the view
  view.target.copy(rv.target);
  view.goal.copy(rv.target);
  view.theta = re.dir === 1 ? 0 : Math.PI;
  view.phi = Math.PI / 2;
  view.radius = view.goalR = Math.max(3.5, orthoH * 0.85);
  // Park the perspective camera where the orbit camera leaves off.
  camera.position.set(
    view.target.x + view.radius * Math.sin(view.phi) * Math.sin(view.theta),
    view.target.y + view.radius * Math.cos(view.phi),
    view.target.z + view.radius * Math.sin(view.phi) * Math.cos(view.theta)
  );
}

document.addEventListener('pointerlockchange', () => {
  if (view.mode === 'walk' && document.pointerLockElement !== canvas) toOrbit();
});
document.addEventListener('mousemove', (e) => {
  if (view.mode === 'walk' && document.pointerLockElement === canvas) {
    view.yaw -= e.movementX * 0.0022;
    view.pitch = clamp(view.pitch - e.movementY * 0.0022, -1.5, 1.5);
  }
});

let dragMoved = false;
canvas.addEventListener('pointerdown', (e) => {
  if (view.mode === 'walk') {
    if (document.pointerLockElement !== canvas) lockPointer();
    else if (hovered) select(hovered);
    return;
  }
  dragMoved = false;
  dragging = { btn: e.button === 2 || e.shiftKey ? 'pan' : 'rotate', x: e.clientX, y: e.clientY, inRackView: !!rackView };
  canvas.setPointerCapture(e.pointerId);
});
window.addEventListener('pointermove', (e) => {
  pointerPx = { x: e.clientX, y: e.clientY };
});
canvas.addEventListener('pointermove', (e) => {
  pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  if (!dragging || view.mode !== 'orbit') return;
  const dx = e.clientX - dragging.x;
  const dy = e.clientY - dragging.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) dragMoved = true;
  // In the row view a plain click stays; an actual drag switches to a free
  // orbit around the row — row mode itself stays on.
  if (dragging.inRackView && rackView && rackView.cam === 'ortho' && dragMoved) toRowOrbit();
  dragging.x = e.clientX;
  dragging.y = e.clientY;
  if (dragging.btn === 'rotate') {
    view.theta -= dx * 0.005;
    view.phi = clamp(view.phi - dy * 0.005, 0.05, 1.5707);
  } else {
    const k = view.radius * 0.0012;
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
    view.goal.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
    view.target.copy(view.goal);
  }
});
const endDrag = () => (dragging = null);
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('click', (e) => {
  if (view.mode !== 'orbit' || e.detail === 0 || dragMoved) return;
  // In the row view, clicking a rack/device smoothly switches to it.
  if (rackView && hovered && hovered.kind !== 'floor') {
    recenterOn(hovered.kind === 'rack' ? hovered.entry : hovered.entry.rack);
  }
  select(hovered); // the clicked entity itself wins (e.g. the device panel)
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('dblclick', () => {
  if (view.mode !== 'orbit' || !hovered) return;
  enterRackView(hovered.kind === 'rack' ? hovered.entry : hovered.entry.rack);
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (rackView) {
    const rv = rackView;
    // In row mode a plain scroll always switches racks; only Shift+wheel
    // (or pinch) zooms — the ortho view or the orbit around the row.
    if (e.shiftKey || e.ctrlKey) {
      if (rv.cam === 'orbit') view.goalR = clamp(view.goalR * Math.exp(e.deltaY * 0.001), 1.5, 160);
      else {
        orthoH = clamp(orthoH * Math.exp(e.deltaY * 0.001), rv.minH, rv.maxH);
        sizeOrtho();
      }
      return;
    }
    // Scroll through the row, one rack per step (normalized wheel deltas).
    let d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (e.deltaMode === 1) d *= 16;
    else if (e.deltaMode === 2) d *= innerHeight;
    if (d !== 0 && Math.sign(d) !== Math.sign(rv.wheelAcc)) rv.wheelAcc = 0;
    rv.wheelAcc += d;
    while (Math.abs(rv.wheelAcc) >= 100) {
      const step = Math.sign(rv.wheelAcc);
      rv.wheelAcc -= step * 100;
      stepRack(step);
    }
    return;
  }
  view.goalR = clamp(view.goalR * Math.exp(e.deltaY * 0.001), 1.5, 160);
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea')) return;
  if (e.code === 'KeyV') {
    if (rackView) exitRackView();
    view.mode === 'walk' ? toOrbit() : toWalk();
    return;
  }
  if (e.code === 'Escape') {
    if (rackView) exitRackView();
    else select(null);
    return;
  }
  if (view.mode === 'walk') {
    view.keys.add(e.code);
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyE', 'KeyQ', 'Space'].includes(e.code)) e.preventDefault();
  }
});
window.addEventListener('keyup', (e) => view.keys.delete(e.code));

/* walk simulation */

function collidersFor(fi) {
  const R = 0.32;
  return world.layout.floors[fi].rows.flatMap((r) =>
    r.racks.map((rk) => [rk.x - L.RACK_W / 2 - R, rk.z - L.RACK_D / 2 - R, rk.x + L.RACK_W / 2 + R, rk.z + L.RACK_D / 2 + R])
  );
}

function updateWalk(dt) {
  const k = view.keys;
  const f = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
  const r = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
  const u = (k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0);
  const speed = k.has('ShiftLeft') || k.has('ShiftRight') ? 4.6 : 2.3;
  const p = view.pos;
  const n = world.layout.floors.length;
  const fi = clamp(Math.round((p.y - 1.6) / L.FLOOR_H), 0, n - 1);
  const boxes = collidersFor(fi);

  if (f || r) {
    const len = Math.hypot(f, r);
    const sy = Math.sin(view.yaw);
    const cy = Math.cos(view.yaw);
    const dx = ((-sy) * f + cy * r) * (speed / len) * dt;
    const dz = ((-cy) * f - sy * r) * (speed / len) * dt;
    const hit = (x, z) => boxes.some((b) => x > b[0] && x < b[2] && z > b[1] && z < b[3]);
    if (!hit(p.x + dx, p.z)) p.x += dx;
    if (!hit(p.x, p.z + dz)) p.z += dz;
  }
  p.y = clamp(p.y + u * speed * dt, 0.45, (n - 1) * L.FLOOR_H + 3.4);
  const b = world.layout.bounds;
  p.x = clamp(p.x, -b.w / 2 - 3, b.w / 2 + 3);
  p.z = clamp(p.z, -b.d / 2 - 3, b.d / 2 + 3);

  camera.position.copy(p);
  camera.rotation.set(view.pitch, view.yaw, 0);
}

function updateOrbit(dt) {
  const damp = 1 - Math.exp(-dt * 9);
  view.target.lerp(view.goal, damp);
  view.radius += (view.goalR - view.radius) * damp;
  const sp = Math.sin(view.phi);
  camera.position.set(
    view.target.x + view.radius * sp * Math.sin(view.theta),
    view.target.y + view.radius * Math.cos(view.phi),
    view.target.z + view.radius * sp * Math.cos(view.theta)
  );
  camera.lookAt(view.target);
}

/* --------------------------------------------------------------- run */

function resize() {
  // Re-read the pixel ratio: it can change on resize (e.g. the window is
  // moved to a denser monitor), so the canvas must follow the new resolution.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const w = innerWidth;
  const h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  sizeOrtho();
}
window.addEventListener('resize', resize);

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  let cam = camera;
  if (rackView) {
    if (rackView.cam === 'ortho') {
      updateRackView(dt);
      cam = orthoCam;
    } else updateOrbit(dt); // free orbit around the row; row mode stays on
    updateOverlay(cam);
  } else if (view.mode === 'walk') updateWalk(dt);
  else updateOrbit(dt);
  updateHover(cam);
  renderer.render(scene, cam);
}

async function init() {
  resize();
  setMode('orbit');
  let project = null;
  if (location.hash.startsWith('#plan=')) {
    try {
      project = IO.normalizeProject(await IO.decodeShare(location.hash.slice(6))).project;
    } catch (e) {
      $('loadErr').textContent = 'The share link could not be read: ' + e.message;
      $('loadErr').hidden = false;
      $('loadDialog').showModal();
    }
  }
  if (!project) project = M.createExampleProject();
  setProject(project, null);
  requestAnimationFrame(frame);
}
init();
