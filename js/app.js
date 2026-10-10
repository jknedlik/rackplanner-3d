/*
 * Rackplanner 3D: the viewer.
 *
 * One ES module: builds the three.js scene from a normalized plan, walks or
 * orbits the datacenter, raycasts for hover and click, and fills the static
 * HTML chrome (toolbar, inspector, legend, dialogs) with the current plan.
 */
import * as THREE from '../vendor/three/build/three.module.js';

const M = window.RP.model;
const R = window.RP.render;
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
/** Width of `text` set in `css` (a font shorthand like the 2D app's FONTS) — for R.fitText. */
const measureText = (text, css) => {
  _mc.font = css;
  return _mc.measureText(text).width;
};
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
// The render resolution follows the display, but the frame loop adapts it
// to what the GPU can actually sustain: pixelRatio steps down when frames
// run long and back up when there is headroom again (see frame()).
let pixelCap = Math.min(window.devicePixelRatio, 2);
let pixelRatio = pixelCap;
const applyPixelRatio = () => {
  renderer.setPixelRatio(pixelRatio);
  // A reduced resolution softens every texture, not just the labels — keep
  // it visible instead of letting the view silently go blurry.
  const rs = $('resStat');
  if (pixelRatio < pixelCap - 1e-3) {
    rs.hidden = false;
    rs.textContent = `render ${pixelRatio.toFixed(2)}×`;
  } else rs.hidden = true;
};
applyPixelRatio();
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
// The row view renders at a fixed on-screen scale (CSS px per meter), so
// 1 U is the same pixel size on every screen and at every window size —
// the window only decides how much of the rack is visible.
const ROW_PX_PER_M = 420;
let lastOrthoH = 0, lastOrthoA = 0; // sizeOrtho() only works when these change
function sizeOrtho() {
  const a = camera.aspect || 1;
  if (orthoH === lastOrthoH && a === lastOrthoA) return;
  lastOrthoH = orthoH;
  lastOrthoA = a;
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
let frontPanelsOn = true; // row view: the faceplate textures (left nav checkbox)
let cableFollow = null; // cable mode: { id, m, d, d0, d1, t0, dur } — the camera riding legs[0]

const view = {
  mode: 'orbit',
  // orbit
  target: new THREE.Vector3(0, 1, 0),
  goal: new THREE.Vector3(0, 1, 0),
  radius: 40,
  goalR: 40,
  theta: 0.8,
  phi: 1.12,
  thetaGoal: null, // one-shot angle easing (leaving row mode); drags cancel it
  phiGoal: null,
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
// Render/hover bookkeeping: the scene re-renders only when something
// visible changed, and the hover raycast (the most expensive per-frame
// pick over every instance mesh) runs only when the pointer or camera
// actually moved — never while the view is at rest.
let needsRender = true;
let hoverDirty = true; // pointer or camera moved since the last raycast
let pointerDirty = false; // the pointer itself moved → raycast this frame
let camRayAlt = false; // camera-only movement raycasts on alternate frames (30 Hz)
let hoverKey = null; // identity of the entity the outline/tooltip show
let lastTipHTML = null;
let tipX = -1, tipY = -1, tipW = 0, tipH = 0, tipMeasuredFor = null;
const camSig = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 0 };
let lastSeenOrthoH = 0;
let perfAcc = 0, perfN = 0, perfWarm = 0; // frame-time stats for adaptive resolution

/** True when the camera's position or orientation differs from the last frame. */
function cameraMoved(cam) {
  const p = cam.position, q = cam.quaternion, c = camSig;
  if (p.x !== c.x || p.y !== c.y || p.z !== c.z || q.x !== c.qx || q.y !== c.qy || q.z !== c.qz || q.w !== c.qw) {
    c.x = p.x; c.y = p.y; c.z = p.z; c.qx = q.x; c.qy = q.y; c.qz = q.z; c.qw = q.w;
    return true;
  }
  return false;
}

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

/**
 * A label canvas: `w × h` logical px, drawn at `ss ×` internal resolution
 * (default LABEL_SS). Per-label ss: the textures are already 2–9× the
 * on-screen size at row-view distance, so extra resolution is only spent
 * where a label is read up close (walking distance) — blanket oversampling
 * would burn gigabytes of GPU memory for nothing.
 */
function labelCanvas(w, h, ss = LABEL_SS) {
  const cv = document.createElement('canvas');
  cv.width = w * ss;
  cv.height = h * ss;
  const c = cv.getContext('2d');
  c.scale(ss, ss); // drawing code stays in logical px
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
  // Read at walking distance — 8× so it stays crisp up close (2048×960).
  const [cv, c] = labelCanvas(256, 120, 8);
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
  c.font = '400 24px system-ui, sans-serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(name, 128, 18, 236);
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
      c.font = '400 14px system-ui, sans-serif';
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
    c.font = '400 14px system-ui, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(row.text, 140, y + 10, 208);
  }
  // ~12% smaller than the 0.6 m cabinet width: the same canvas on a smaller
  // quad raises the text density and reads sharper.
  return labelPlane(cv, 0.49, 0.229);
}

/** Vertical rack name tag: one letter per line, running down the rack's front-left. */
function rackNameTag(name) {
  const LW = 40; // px per letter row
  const LH = name.length * LW + 14;
  const [cv, c] = labelCanvas(44, LH, 8); // read up close along the cabinet edge
  c.beginPath();
  rr(c, 1, 1, 42, LH - 2, 8);
  c.fillStyle = 'rgba(12,17,26,0.55)';
  c.fill();
  c.fillStyle = '#e8eef7';
  c.font = '400 30px system-ui, sans-serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  for (let i = 0; i < name.length; i++) c.fillText(name[i], 22, 10 + LW / 2 + i * LW);
  const w = 0.048; // fits the 6 cm strip between the cabinet edge (0.30) and the device edge (0.24)
  return labelPlane(cv, w, (w * cv.height) / cv.width);
}

function floorLabel(text) {
  const [cv, c] = labelCanvas(512, 128);
  c.fillStyle = '#9fc2ff';
  c.font = '400 64px system-ui, sans-serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(text.toUpperCase(), 256, 64, 500);
  return labelPlane(cv, 3.4, 0.85);
}

const CHIP_PX2M = 0.00095; // device label scale: 1 canvas px = 0.95 mm (smaller = sharper)

/**
 * A world-fixed device label (the row view's "chip"): cluster dot + name +
 * position, pinned to the top-left of the device face as seen from the
 * front. A plane like the rack labels — it never billboards toward the
 * camera. Side-slot devices get the vertical variant, running down the slot.
 */
function deviceLabelPlane(d, e) {
  const vertical = d.loc.kind === 'side';
  const pos = vertical ? `V${d.loc.at + 1}` : M.formatSpan(d.loc.at, d.loc.at + e.h - 1);
  // Plate: 70 % of a 1 U box (the 1 U device body is 44.45 − 8 =
  // 36.45 mm, so 27 px ≈ 25.65 mm) — the same for every device. The
  // name is the largest size that exactly fits the plate: with a
  // centered baseline the caps/descenders reach ≈ 0.47 em from the
  // middle, so 25 px fills the 27 px plate edge-to-edge.
  // (The layout namespace is not reachable here: the local `L` below
  //  shadows it.)
  const H = Math.round((0.7 * (0.04445 - 0.008)) / CHIP_PX2M); // 27 px
  const nameFont = `400 25px ${MONO_FONT}`;
  const posFont = `400 12px ${MONO_FONT}`;
  const pad = 8, gap = 6, dot = 9;
  const faceW = e.size[0] / CHIP_PX2M; // logical px across the device face
  _mc.font = posFont;
  const posW = _mc.measureText(pos).width + pos.length * 0.5;
  const maxName = vertical
    ? 380
    : Math.max(40, Math.min(Math.round(H * 9), faceW - 2 * pad - dot - 2 * gap - posW));
  const { text: name, w: nameW } = fitText(d.name, maxName, nameFont, 0.5);
  // The row's length: horizontal chips stretch to cover 70 % of the device
  // face (and never run past it).
  const fit = pad + dot + gap + nameW + gap + posW + pad;
  const L = vertical ? fit : Math.min(faceW, Math.max(fit, 0.7 * faceW));
  const W = vertical ? H : L, Hh = vertical ? L : H; // logical px
  const [cv, c] = labelCanvas(W, Hh);
  if (vertical) {
    c.translate(H, 0); // the row runs down the slot, glyphs rotated 90°
    c.rotate(Math.PI / 2);
  }
  c.beginPath();
  rr(c, 1, 1, L - 2, H - 2, gap);
  // Nearly solid: a 15 %-transparent plate reads as much smaller than its
  // real 70 %-of-1U-box height against the dark rack.
  c.fillStyle = 'rgba(10,14,20,0.97)';
  c.fill();
  c.strokeStyle = '#5a7292';
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
  c.fillText(pos, pad + dot + gap + nameW + gap, H / 2 + 1);
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
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();

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
  // The channel strip is cut around the occupied side slots in the row and
  // cable views, so it can take up to (slots + 1) segments per rack.
  let chanCap = 0;
  layout.racks.forEach((r) => {
    if (r.rackType.sideSlots) chanCap += r.rackType.sideSlots + 1;
  });
  const [chanSolid, chanGhost] = mkPair(unit, new THREE.MeshStandardMaterial({ color: 0x232c3c, roughness: 0.9, metalness: 0.2 }), new THREE.MeshStandardMaterial({ color: 0x232c3c, roughness: 0.9, metalness: 0.2, ...GHOST }), Math.max(1, chanCap));
  const [slotSolid, slotGhost] = mkPair(unit, new THREE.MeshStandardMaterial({ color: 0x141b28, roughness: 0.95, metalness: 0.1 }), new THREE.MeshStandardMaterial({ color: 0x141b28, roughness: 0.95, metalness: 0.1, ...GHOST }), Math.max(1, slotList.length));

  const devs = layout.devices;
  const nU = devs.filter((d) => !d.side && !d.reserved).length;
  const nS = devs.filter((d) => d.side && !d.reserved).length;
  const nR = devs.filter((d) => d.reserved).length;
  // Which side slots are occupied, per rack — the channel strip is cut
  // around them in the row and cable views (see fillAll).
  const slotDev = new Map();
  for (const dv of devs)
    if (dv.side) {
      const id = dv.rack.rack.id;
      if (!slotDev.has(id)) slotDev.set(id, new Set());
      slotDev.get(id).add(dv.d.loc.at);
    }
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

  // Front faceplates: the 2D app's actual face drawing (R.deviceFace /
  // R.sideFace — ports, bays, fans, PDUs, the rear with its power supplies
  // for a device mounted back to front), tinted with the cluster and
  // rasterized as a texture, one instanced mesh per type + side + cluster.
  // They sit just proud of the device's face, in front of the colored
  // strip, and are only shown in the row view (the "Front panels" checkbox).
  // Chrome only: the pickable face strip and body sit right behind them.
  const plateByType = new Map();
  for (const dv of devs)
    if (!dv.side && !dv.reserved) {
      const cl = dv.d.cluster ? M.clusterById(project, dv.d.cluster) : null;
      const key = dv.type.id + '|' + (dv.d.reversed ? 'r' : '') + '|' + (cl ? cl.color : '');
      const e = plateByType.get(key);
      if (e) e.list.push(dv);
      else plateByType.set(key, { type: dv.type, color: cl ? cl.color : null, reversed: !!dv.d.reversed, list: [dv] });
    }
  const plates = [...plateByType.values()];
  for (const p of plates) {
    p.mesh = new THREE.InstancedMesh(unit, new THREE.MeshBasicMaterial({ color: 0xdfe7f0, toneMapped: false }), p.list.length);
    p.mesh.count = 0;
    p.mesh.userData.n = 0; // fresh fill cursor, like the other instance meshes
    p.mesh.frustumCulled = false;
    p.mesh.visible = false;
    g.add(p.mesh);
    for (const dv of p.list) dv.plate = p;
    makeFaceTexture(p.type, p.color, p.reversed, (tex) => {
      p.mesh.material.color.set(0xffffff);
      p.mesh.material.map = tex;
      p.mesh.material.needsUpdate = true;
      needsRender = true;
    });
  }

  // Over-budget racks glow red: a soft translucent shell around the cabinet
  // (a wireframe frame read badly at an angle — it looked like a stray red
  // triangle). The shell is 3 cm proud of the cabinet on every side.
  const overRacks = layout.racks.filter((r) => r.stats.overPower || r.stats.overWeight);
  let overSolid = null, overGhost = null;
  if (overRacks.length) [overSolid, overGhost] = mkPair(unit, new THREE.MeshBasicMaterial({ color: 0xff4d4d, toneMapped: false, transparent: true, opacity: 0.2, depthWrite: false }), new THREE.MeshBasicMaterial({ color: 0xff4d4d, toneMapped: false, transparent: true, opacity: 0.03, depthWrite: false }), overRacks.length);

  // Cable trays: one above every row, above its tallest rack's tray height.
  const trays = [];
  const trayMat = new THREE.MeshStandardMaterial({ color: 0x3c4a63, roughness: 0.65, metalness: 0.55 });
  for (const f of layout.floors)
    for (const r of f.rows) {
      if (!r.racks.length) continue;
      const w = Math.max(...r.racks.map((x) => x.x + x.w / 2)) - Math.min(...r.racks.map((x) => x.x - x.w / 2)) + 0.5;
      const m = new THREE.Mesh(unit, trayMat);
      m.position.set(0, r.trayY - L.TRAY_H / 2, r.z);
      m.scale.set(w, L.TRAY_H, L.TRAY_W);
      m.userData.row = r;
      trays.push(m);
      g.add(m);
    }

  // Cables: every run of every cable in one LineSegments (one draw call),
  // vertex-colored by network. The visible subset (row view, cable
  // visibility) is the geometry's draw range; emphasis is the dim factor
  // written into the colors by fillCables().
  const routeList = L.routes(project, layout);
  const NO_NET = new THREE.Color('#8a97a8');
  const netColor = new Map(project.networks.map((n) => [n.id, new THREE.Color(n.color)]));
  const basePos = [];
  const baseCol = [];
  const segCable = [];
  const cableRacks = new Map();
  const cableRouteById = new Map();
  for (const rt of routeList) {
    const c = rt.cable;
    const col = (c.network && netColor.get(c.network)) || NO_NET;
    const racks = new Set();
    for (const x of M.cableEnds(c)) {
      const dv = layout.ports.get(`${x.end.device}|${x.end.port}`);
      if (dv) racks.add(dv.rack.rack.id);
    }
    if (!racks.size) continue;
    cableRacks.set(c.id, racks);
    cableRouteById.set(c.id, rt);
    for (const leg of rt.legs)
      for (let i = 0; i + 1 < leg.length; i++) {
        basePos.push(leg[i][0], leg[i][1], leg[i][2], leg[i + 1][0], leg[i + 1][1], leg[i + 1][2]);
        for (const p of [leg[i], leg[i + 1]]) baseCol.push(col.r, col.g, col.b);
        segCable.push(c);
      }
  }
  const cableGeo = new THREE.BufferGeometry();
  cableGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(basePos), 3).setUsage(THREE.DynamicDrawUsage));
  cableGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(baseCol), 3).setUsage(THREE.DynamicDrawUsage));
  const cables = new THREE.LineSegments(cableGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95 }));
  cables.frustumCulled = false;
  g.add(cables);
  // The hovered/selected cable gets a real 3D thickness: tube meshes rebuilt
  // in updateCableHighlight().
  const cableHi = new THREE.Group();
  g.add(cableHi);

  // Labels.
  const labels = new Map();
  for (const r of layout.racks) {
    // Fixed to the cabinet front (never billboarded): readable from the
    // front, faintly visible from behind through the open cabinet.
    const face = r.dir === 1 ? 0 : Math.PI;
    const panel = rackPanel(rn(r.rack.name), r.stats);
    panel.rotation.y = face;
    panel.position.set(r.x, r.y + 0.38, r.z + r.dir * (r.d / 2 + 0.03));
    const tag = rackNameTag(rn(r.rack.name));
    tag.rotation.y = face;
    const tagH = tag.geometry.parameters.height;
    tag.position.set(
      r.x - r.dir * (r.w / 2 - 0.03), // front-left strip: clear of the device boxes (±0.23), inside the cabinet
      Math.max(r.y + tagH / 2, r.topY - 0.06 - tagH / 2), // from the top, down; never below the floor
      r.z + r.dir * (r.d / 2 + 0.02)
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
  const pickables = [cables, devSolid, devGhost, faceSolid, faceGhost, sideSolid, sideFaceSolid, sideGhost, sideFaceGhost, resSolid, resGhost, frameSolid, frameGhost, ...slabs];
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
    trays,
    cables,
    cableGeo,
    cableHi,
    cableBasePos: basePos,
    cableBaseCol: baseCol,
    segCable,
    segCount: segCable.length,
    cableRacks,
    cableRouteById,
    cableHot: null, // cable ids that stay bright while a selection dims the rest
    plates,
    slotDev,
    pickables,
    instanced,
    focusId: null,
    focusRacks: null, // cable selection: the racks it runs through stay solid
    keepSet: null, // row view: set of rack ids that stay solid
    pick,
    hover,
    sel,
  };
}

/** Writes one rack's 9 frame boxes into `im` at row `j`. */
function writeFrame(im, j, r) {
  const w = r.w, d = r.d;
  const px = w / 2 - 0.025;
  const pz = d / 2 - 0.025;
  const h = r.height;
  let i = j;
  put(im, i++, r.x, r.y + L.BASE_H / 2, r.z, w - 0.02, L.BASE_H, d - 0.02);
  put(im, i++, r.x - px, r.y + h / 2, r.z - pz, 0.05, h, 0.05);
  put(im, i++, r.x + px, r.y + h / 2, r.z - pz, 0.05, h, 0.05);
  put(im, i++, r.x - px, r.y + h / 2, r.z + pz, 0.05, h, 0.05);
  put(im, i++, r.x + px, r.y + h / 2, r.z + pz, 0.05, h, 0.05);
  // Top and bottom rails sit in the 6 cm frame gaps, not over the top and
  // bottom devices: their faces then have clear air in front of and behind
  // them, so the front-port cable stubs can run out to the aisle lane.
  put(im, i++, r.x, r.y + h - 0.0375, r.z + pz, w, 0.045, 0.05);
  put(im, i++, r.x, r.y + h - 0.0375, r.z - pz, w, 0.045, 0.05);
  put(im, i++, r.x, r.y + L.BASE_H / 2 - 0.0225, r.z + pz, w, 0.045, 0.05);
  put(im, i++, r.x, r.y + L.BASE_H / 2 - 0.0225, r.z - pz, w, 0.045, 0.05);
  put(im, i++, r.x, r.y + L.BASE_H + (r.units * L.U) / 2, r.z - r.dir * (d / 2 - 0.015), w - 0.06, r.units * L.U, 0.02);
  // Side panels: the cabinet is closed, not an open frame.
  put(im, i++, r.x - (w / 2 - 0.0125), r.y + h / 2, r.z, 0.025, h, d - 0.1);
  put(im, i++, r.x + (w / 2 - 0.0125), r.y + h / 2, r.z, 0.025, h, d - 0.1);
}

/** Writes a rack's dark side channel strip, from y0 to y1, into `im`. */
function writeChannelSeg(im, j, r, y0, y1) {
  const cw = r.w / 2 - 0.2413; // 19" bay edge to the cabinet edge
  put(im, j, r.x + r.dir * (r.w / 2 - cw / 2), (y0 + y1) / 2, r.z + r.dir * 0.476, cw, y1 - y0, 0.012);
}

// Faceplate matrix temps (writePlate is called per device per fill).
const _plm = new THREE.Matrix4();
const _plq = new THREE.Quaternion();
const _plp = new THREE.Vector3();
const _pls = new THREE.Vector3();
const _plUp = new THREE.Vector3(0, 1, 0);

/**
 * Writes one faceplate: a thin box 9–15 mm proud of the device's face (in
 * front of the colored strip). Flipped 180° for rows facing −z, so the
 * texture reads left-to-right from the row's front.
 */
function writePlate(im, j, dv) {
  const dir = dv.rack.dir;
  const face = dv.pos[2] + dir * (dv.size[2] / 2);
  _plq.setFromAxisAngle(_plUp, dir === 1 ? 0 : Math.PI);
  _plm.compose(_plp.set(dv.pos[0], dv.pos[1], face + dir * 0.012), _plq, _pls.set(dv.size[0] * 0.94, dv.size[1] * 0.92, 0.006));
  im.setMatrixAt(j, _plm);
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
  needsRender = true; // instance matrices and label opacities changed
  hoverDirty = true; // the pickable instances changed under the pointer
  const fid = W.focusId;
  const fr = W.focusRacks;
  const keep = W.keepSet; // row view: the whole row stays solid
  const hide = !!rackView; // row view: no racks but the row's
  const solidOf = (id) => (keep ? keep.has(id) : fr ? fr.has(id) : id === fid);
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
      // The strip runs the full unit height — cut where a vertical unit
      // sits, so the unit reads from the front in the row and cable views.
      const n = r.rackType.sideSlots;
      const y0 = r.y + L.BASE_H;
      const y1 = y0 + r.units * L.U;
      const parts = [];
      const cuts = (rackView || view.mode === 'cable') && W.slotDev.get(r.rack.id);
      if (cuts && cuts.size) {
        let cur = y0;
        for (const s of [...cuts].sort((a, b) => a - b)) {
          const top = r.topY - L.sideSlotTop(r.units, s, n);
          const a = top - L.SIDE_LEN - 0.012, b = top + 0.012;
          if (a > cur) parts.push([cur, a]);
          cur = Math.max(cur, b);
        }
        if (cur < y1) parts.push([cur, y1]);
      } else parts.push([y0, y1]);
      const cim = solid ? W.chanSolid : W.chanGhost;
      for (const [sa, sb] of parts) {
        const cj = solid ? cs++ : cg++;
        writeChannelSeg(cim, cj, r, sa, sb);
        cim.userData.idx[cj] = ri;
      }
    }
  }
  W.frameSolid.count = fs;
  W.frameGhost.count = fg;
  W.chanSolid.count = cs;
  W.chanGhost.count = cg;

  let ds = 0, dg = 0, ss = 0, sg = 0, rs = 0, rg = 0;
  let u = 0, s = 0, rv = 0;
  // Faceplates: row view only, behind the "Front panels" checkbox.
  const platesOn = !!rackView && frontPanelsOn;
  for (const p of W.plates) p.mesh.userData.n = 0;
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
        if (platesOn && dv.plate) writePlate(dv.plate.mesh, dv.plate.mesh.userData.n++, dv);
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
  for (const p of W.plates) {
    p.mesh.count = p.mesh.userData.n;
    p.mesh.visible = platesOn;
    if (p.mesh.count) p.mesh.instanceMatrix.needsUpdate = true;
  }

  // Slot boxes: dark insets for the empty slots (an occupied one sits
  // hidden behind its device).
  let sls = 0, slg = 0;
  for (const se of W.slotList) {
    const solid = solidOf(se.r.rack.id);
    if (hide && !solid) continue;
    const im = solid ? W.slotSolid : W.slotGhost;
    const j = solid ? sls++ : slg++;
    put(im, j,
      se.r.x + se.r.dir * (se.r.w / 2 - 0.025 - L.SIDE_W / 2), // same center as the slot's device
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
      put(im, j, r.x, r.y + r.height / 2, r.z, r.w + 0.06, r.height + 0.06, r.d + 0.06);
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
  // Trays read with the cabling: visible in cable mode only (the open
  // row's tray in the row view).
  for (const t of W.trays) t.visible = view.mode === 'cable' && (!hide || t.userData.row === rackView.row);
  fillCables();
}

/* --------------------------------------------------------------- cabling */

const C = window.RP.cabling;

/** Cables that stay bright for the current focus; null = all of them. */
function refreshCableHot() {
  const W = world;
  if (!W) return;
  if (selected && selected.kind === 'cable') {
    W.cableHot = new Set([selected.entry.cable.id]);
    return;
  }
  const fid = W.focusId;
  if (fid) {
    const s = new Set();
    for (const c of project.cables)
      for (const rid of W.cableRacks.get(c.id) || [])
        if (rid === fid) {
          s.add(c.id);
          break;
        }
    W.cableHot = s;
    return;
  }
  W.cableHot = null;
}

/**
 * Writes the visible cable segments: the row view keeps only the cables
 * that run entirely inside the open row; the focus (a selected rack or
 * cable) dims every other cable to 16 % of its color.
 */
function fillCables() {
  const W = world;
  if (!W.cableGeo) return;
  if (view.mode !== 'cable') {
    W.cableGeo.setDrawRange(0, 0);
    clearCableHi();
    return;
  }
  const rowRacks = rackView ? new Set([...(W.keepSet || [])]) : null;
  const pos = W.cableGeo.attributes.position.array;
  const col = W.cableGeo.attributes.color.array;
  const bpos = W.cableBasePos;
  const bcol = W.cableBaseCol;
  const hot = W.cableHot;
  let n = 0;
  for (let s = 0; s < W.segCount; s++) {
    const c = W.segCable[s];
    if (rowRacks) {
      let vis = true;
      for (const rid of W.cableRacks.get(c.id))
        if (!rowRacks.has(rid)) {
          vis = false;
          break;
        }
      if (!vis) continue;
    }
    const f = !hot || hot.has(c.id) ? 1 : 0.16;
    const o = s * 6;
    for (let k = 0; k < 6; k++) {
      pos[n * 6 + k] = bpos[o + k];
      col[n * 6 + k] = bcol[o + k] * f;
    }
    n++;
  }
  W.cableGeo.setDrawRange(0, n * 2);
  W.cableGeo.attributes.position.needsUpdate = true;
  W.cableGeo.attributes.color.needsUpdate = true;
  W.cableGeo.computeBoundingSphere();
  needsRender = true;
}

const cableColorOf = (c) => {
  const n = c.network ? M.networkById(project, c.network) : null;
  return new THREE.Color(n ? n.color : '#8a97a8');
};

const _tubeWhite = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, transparent: true, opacity: 0.55, depthWrite: false });

/**
 * The hovered or selected cable, drawn with real thickness: a soft white
 * tube under the network color. Rebuilt whenever the highlight changes.
 */
function clearCableHi() {
  const W = world;
  if (!W.cableHi) return;
  for (const m of W.cableHi.children) {
    W.cableHi.remove(m);
    m.geometry.dispose();
    if (m.material !== _tubeWhite) m.material.dispose();
  }
}

function updateCableHighlight() {
  const W = world;
  if (!W.cableHi) return;
  clearCableHi();
  const id =
    selected && selected.kind === 'cable'
      ? selected.entry.cable.id
      : hovered && hovered.kind === 'cable'
        ? hovered.entry.cable.id
        : null;
  const rt = id ? W.cableRouteById.get(id) : null;
  if (!rt || view.mode !== 'cable') return;
  const strong = !!(selected && selected.kind === 'cable' && selected.entry.cable.id === id);
  const col = cableColorOf(rt.cable);
  for (const leg of rt.legs) {
    const pts = leg.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.5);
    const tubular = Math.max(8, pts.length * 3);
    const g = new THREE.TubeGeometry(curve, tubular, strong ? 0.013 : 0.009, 6, false);
    if (strong) W.cableHi.add(new THREE.Mesh(g, _tubeWhite));
    W.cableHi.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: col, toneMapped: false, transparent: true, opacity: strong ? 1 : 0.95, depthWrite: false })));
  }
  needsRender = true;
}

/* ----------------------------------------------- cable mode: follow + card */

const cableCardEl = $('cableCard');
const _cableV = new THREE.Vector3();

/** Cumulative arc length at each point of a leg. */
function legMetric(leg) {
  const m = [0];
  for (let i = 1; i < leg.length; i++)
    m.push(m[i - 1] + Math.hypot(leg[i][0] - leg[i - 1][0], leg[i][1] - leg[i - 1][1], leg[i][2] - leg[i - 1][2]));
  return m;
}

/** The point at arc length `d` along `leg` (its metric `m`). */
function pointAtLeg(leg, m, d) {
  if (!leg.length) return null;
  if (d <= 0) return leg[0];
  if (d >= m[m.length - 1]) return leg[leg.length - 1];
  let i = 1;
  while (m[i] < d) i++;
  const t = (d - m[i - 1]) / (m[i] - m[i - 1] || 1);
  const a = leg[i - 1], b = leg[i];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * Ride a cable's first leg from one end to the other: the orbit target is
 * dragged along the route (ease-in-out, 0.35 m/s). Clicking the same cable
 * again reverses the trip from where the camera is.
 */
function startCableFollow(ent) {
  const rt = world.cableRouteById.get(ent.entry.cable.id);
  if (!rt || !rt.legs.length) return;
  const leg = rt.legs[0];
  const m = legMetric(leg);
  const total = m[m.length - 1];
  if (!total) return;
  const same = cableFollow && cableFollow.id === rt.cable.id;
  const d0 = same ? cableFollow.d : 0;
  const d1 = same ? (cableFollow.d1 === 0 ? total : 0) : total;
  if (d0 === d1) return;
  cableFollow = { id: rt.cable.id, m, d: d0, d0, d1, t0: performance.now(), dur: clamp(total / 0.35, 1.5, 12) };
  needsRender = true;
}

/** The detail card that hangs to the right of the followed/selected cable. */
function cableCardHTML(rt) {
  const c = rt.cable;
  const dsc = C.describe(project, c);
  const net = c.network ? M.networkById(project, c.network) : null;
  const endHTML = (x) => {
    const d = x.device;
    if (!d) return `<span class="dim">${esc(x.end.device)} · ${esc(x.end.port)}</span>`;
    const re = world.layout.rackBy.get(d.loc.rack);
    return `<b>${esc(d.name)}</b><small>${re ? esc(rn(re.rack.name)) : '—'} · ${esc(x.end.port)}${x.face === 'rear' ? ' · rear' : ''}</small>`;
  };
  const len =
    dsc.lengthM != null ? `${esc(C.fmtM(dsc.lengthM))}${dsc.lengthAuto ? ' est.' : ' (set)'}`
    : dsc.needM != null ? `${esc(C.fmtM(dsc.needM))} needed`
    : '';
  const warn = dsc.issues.filter((i) => i.level === 'warn');
  return `
    <h3>${esc(c.label || 'Cable')}${net ? ` <span class="chip" style="background:${net.color}"></span>${esc(net.name)}` : ''}</h3>
    <dl>
      ${row('End A', endHTML(dsc.ends[0]))}
      ${dsc.ends[1] ? row('End B', endHTML(dsc.ends[1])) : ''}
      ${row('Type', dsc.type ? esc(dsc.type.name) : '')}
      ${row('Length', len)}
    </dl>
    ${warn.length ? `<p class="cc-warn"><b class="over">${warn.map((i) => esc(i.short)).join(' · ')}</b></p>` : ''}`;
}

/**
 * Positions (or hides) the cable card. It follows the camera's ride point
 * while following, and sits at the middle of the first leg while a cable is
 * only selected — offset to the right of the run, clamped to the screen.
 */
function updateCableCard(cam) {
  const on = world && view.mode === 'cable' && (cableFollow || (selected && selected.kind === 'cable'));
  if (!on) {
    cableCardEl.hidden = true;
    return;
  }
  const id = cableFollow ? cableFollow.id : selected.entry.cable.id;
  const rt = world.cableRouteById.get(id);
  if (!rt || !rt.legs.length) {
    cableCardEl.hidden = true;
    return;
  }
  const leg = rt.legs[0];
  let p;
  if (cableFollow) p = pointAtLeg(leg, cableFollow.m, cableFollow.d);
  else {
    const m = legMetric(leg);
    p = pointAtLeg(leg, m, m[m.length - 1] / 2); // mid of the first leg
  }
  if (!p) {
    cableCardEl.hidden = true;
    return;
  }
  _cableV.set(p[0], p[1], p[2]).project(cam);
  if (_cableV.z > 1) {
    cableCardEl.hidden = true;
    return;
  }
  cableCardEl.hidden = false;
  const x = clamp((_cableV.x * 0.5 + 0.5) * innerWidth + 34, 8, innerWidth - cableCardEl.offsetWidth - 8);
  const y = clamp((-_cableV.y * 0.5 + 0.5) * innerHeight - 24, 56, innerHeight - cableCardEl.offsetHeight - 40);
  cableCardEl.style.left = x + 'px';
  cableCardEl.style.top = y + 'px';
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
  if (kind === 'rack') return { pos: [entry.x, entry.y + entry.height / 2, entry.z], size: [entry.w + 0.05, entry.height + 0.05, entry.d + 0.05] };
  const s = entry.slab;
  return { pos: [s.x, s.y, s.z], size: [s.w, s.h, s.d] };
}

function pickEntity(hit) {
  const o = hit.object;
  const W = world;
  if (o === W.cables) {
    const c = W.segCable[Math.floor(hit.index / 2)];
    const rt = c && W.cableRouteById.get(c.id);
    return rt ? { kind: 'cable', entry: rt, box: null } : null;
  }
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
  // Hovering the elevation view drives the 3D highlight; otherwise raycast —
  // but only when the pointer or the camera actually moved: a full pick over
  // every instance mesh is the most expensive thing we do per frame. It is
  // skipped entirely while the view is at rest, and while the user is
  // mid-drag, when the tooltip would just get in the way. Camera-only
  // movement raycasts on alternate frames (30 Hz is plenty for the crosshair
  // and for the camera easing after a drag).
  if (elHover) hovered = { kind: 'device', entry: elHover, box: entityBox('device', elHover) };
  else if (elCableHover) {
    const rt = world.cableRouteById.get(elCableHover);
    hovered = rt ? { kind: 'cable', entry: rt, box: null } : null;
  } else if ((dragging && dragMoved) || cableFollow) hovered = null; // a real drag, or the camera riding a cable: no picking under a moving view
  else if (hoverDirty && (pointerDirty || (camRayAlt = !camRayAlt))) {
    raycaster.far = view.mode === 'walk' ? 14 : Infinity;
    raycaster.params.Line.threshold = view.mode === 'walk' ? 0.02 : 0.035;
    raycaster.setFromCamera(view.mode === 'walk' ? CENTER : pointer, cam);
    const hits = raycaster.intersectObjects(world.pickables, false);
    // The cable lines only exist in cable mode: behind them, the rack or
    // device under the pointer should still be picked.
    let hit = null;
    for (const h of hits) {
      if (h.object === world.cables && view.mode !== 'cable') continue;
      hit = h;
      break;
    }
    hovered = hit ? pickEntity(hit) : null;
    hoverDirty = false;
  }
  pointerDirty = false; // consumed (it is only ever set together with hoverDirty)
  // The mode is part of the key: the same entity shows a different tooltip
  // style in walk vs orbit mode.
  const key = !hovered
    ? null
    : (view.mode === 'walk' ? 'w:' : 'o:') + (hovered.kind === 'device' || hovered.kind === 'reserved'
      ? 'd' + hovered.entry.d.id
      : hovered.kind === 'rack' ? 'r' + hovered.entry.rack.id : hovered.kind === 'cable' ? 'c' + hovered.entry.cable.id : 'f' + hovered.entry.floor.id);
  // The orbit/cable tooltip follows the cursor; everything else is static
  // per hover entity, so an unchanged key means an unchanged frame.
  const tipFollow = view.mode !== 'walk' && (pointerPx.x !== tipX || pointerPx.y !== tipY);
  if (key === hoverKey && !tipFollow) return;
  const changed = key !== hoverKey;
  hoverKey = key;
  if (changed) {
    needsRender = true; // the 3D outline line appears / moves / disappears
    if (!hovered) {
      world.hover.visible = false;
      lastTipHTML = null;
      tooltip.hidden = true;
      if (openRackId && elevRows.size) for (const [id, el] of elevRows) el.classList.remove('hl');
      if (openRackId && elevCables.size) for (const el of elevCables.values()) el.classList.remove('hl');
      updateCableHighlight();
      return;
    }
    if (hovered.box) setOutline(world.hover, hovered.box);
    else world.hover.visible = false;
    // Keep the open elevation in step with the 3D hover: its device rows
    // and its cable runs highlight together.
    if (openRackId && elevRows.size) {
      const isDev = hovered.kind === 'device' || hovered.kind === 'reserved';
      for (const [id, el] of elevRows) el.classList.toggle('hl', isDev && hovered.entry.d.id === id);
    }
    if (openRackId && elevCables.size) {
      const isCable = hovered.kind === 'cable';
      const cid = isCable ? hovered.entry.cable.id : null;
      for (const [id, els] of elevCables) for (const el of els) el.classList.toggle('hl', isCable && id === cid);
    }
    const e = hovered.entry;
    let text;
    if (hovered.kind === 'device' || hovered.kind === 'reserved') {
      const d = e.d;
      const t = e.type;
      const pos = d.loc.kind === 'side' ? `Side V${d.loc.at + 1}` : M.formatSpan(d.loc.at, d.loc.at + e.h - 1);
      text = `<b>${esc(d.name)}</b> · ${esc(t.label)} · ${esc(rn(e.rack.rack.name))} ${pos}`;
    } else if (hovered.kind === 'rack') {
      const st = e.stats;
      text = `<b>${esc(rn(e.rack.name))}</b> · ${esc(e.rackType.name)} · ${st.used}/${st.units} U · ${fmtKW(st.powerW)}`;
    } else if (hovered.kind === 'cable') {
      const c = e.cable;
      const net = c.network ? M.networkById(project, c.network) : null;
      const dsc = C.describe(project, c);
      const ends = dsc.ends
        .map((x) => `${esc(x.device ? x.device.name : '?')} ${esc(x.end.port)}`)
        .join(' ⇄ ');
      text = `<b>${esc(c.label || 'Cable')}</b>${net ? ` · ${esc(net.name)}` : ''} · ${ends}${dsc.lengthM != null ? ` · ${esc(C.fmtM(dsc.lengthM))}${dsc.lengthAuto ? ' est.' : ''}` : ''}`;
    } else {
      const st = M.statsWithin(project, e.floor.id);
      text = `<b>${esc(e.floor.name)}</b> · ${plural(st.racks, 'rack')} · ${plural(st.count, 'device')}`;
    }
    if (lastTipHTML !== text) {
      lastTipHTML = text;
      tooltip.innerHTML = text; // was: every frame while hovering (reflow)
      tipMeasuredFor = null;
    }
    tooltip.hidden = false;
    tooltip.classList.toggle('walk', view.mode === 'walk');
    updateCableHighlight();
  }
  if (!hovered) return;
  if (view.mode !== 'walk') {
    if (tipMeasuredFor !== key) { tipMeasuredFor = key; tipW = tooltip.offsetWidth; tipH = tooltip.offsetHeight; }
    const x = clamp(pointerPx.x + 16, 8, innerWidth - tipW - 8);
    const y = clamp(pointerPx.y + 18, 8, innerHeight - tipH - 40);
    if (x !== tipX || y !== tipY) {
      tipX = x;
      tipY = y;
      tooltip.style.left = x + 'px';
      tooltip.style.top = y + 'px';
    }
  }
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
  if (ent.kind === 'floor' || ent.kind === 'cable') return null; // a cable's racks go to focusRacks
  return ent.entry.rack.rack.id;
}

function select(ent) {
  selected = ent;
  needsRender = true; // the selection outline changed
  hoverDirty = true; // elHover is cleared below; the 3D hover may be stale
  if (selected && selected.box) setOutline(world.sel, selected.box);
  else world.sel.visible = false;
  elHover = null;
  elCableHover = null;
  openRackId = null;
  elevRows.clear();
  elevCables.clear();
  if (!ent) {
    inspector.hidden = true;
    cableFollow = null; // nothing to ride
    if (!rackView && (world.focusId || world.focusRacks)) {
      world.focusId = null;
      world.focusRacks = null;
      fillAll();
    }
    refreshCableHot();
    updateCableHighlight();
    syncEnterRowBtn();
    return;
  }
  if (ent.kind === 'rack') openRackId = ent.entry.rack.id;
  // A cable: the detail card follows it, and in cable mode the camera
  // rides the run (clicking it again reverses). No riding in the row view —
  // its ortho camera owns the framing.
  if (ent.kind === 'cable') {
    cableCardEl.innerHTML = cableCardHTML(ent.entry);
    if (view.mode === 'cable' && !rackView) startCableFollow(ent);
    else cableFollow = null;
  } else if (cableFollow) {
    cableFollow = null; // the selection left the cable
  }
  // A cable keeps the racks it runs through solid.
  world.focusRacks = ent.kind === 'cable' ? world.cableRacks.get(ent.entry.cable.id) || null : null;
  inspBody.innerHTML =
    ent.kind === 'floor'
      ? floorHTML(ent.entry)
      : ent.kind === 'rack'
        ? rackHTML(ent.entry)
        : ent.kind === 'cable'
          ? cableHTML(ent.entry)
          : deviceHTML(ent.entry);
  if (openRackId) {
    for (const el of inspBody.querySelectorAll('.eldev')) elevRows.set(el.dataset.did, el);
    for (const el of inspBody.querySelectorAll('.elcable')) {
      const arr = elevCables.get(el.dataset.cid) || [];
      elevCables.set(el.dataset.cid, arr);
      arr.push(el);
    }
  }
  inspector.hidden = false;
  // The selected rack (or the rack of a selected device) stays solid; every
  // other rack drops to 10% opacity. While the front view is open the focus
  // is pinned to the viewed rack, no matter what gets clicked.
  const fid = rackView ? rackView.re.rack.id : focusIdFor(ent);
  const fr = rackView ? null : world.focusRacks;
  if (world.focusId !== fid || world.focusRacks !== fr) {
    world.focusId = fid;
    world.focusRacks = fr;
    fillAll();
  }
  refreshCableHot();
  updateCableHighlight();
  if (ent.box) focusEntity(ent);
  syncEnterRowBtn();
}

/* --------------------------------------------------------------- elevation
 * A 2D front view of a rack, the way the 2D app draws it: unit grid, device
 * faces (ports, bays, fans, …), cluster colors, hatched reserved space,
 * side slots on the right. Rows are hoverable and clickable. */

const ELU = 16; // px per unit in the elevation view (the 2D face art's text is 11 px)

// Elevation hover state — shared with the 3D hover loop so device outlines
// and cable highlights stay in sync between the view and the open front view.
let elHover = null; // the hovered device (a world.dvById entry)
let elCableHover = null; // the hovered cable's id
let openRackId = null; // the rack whose front view is open in the inspector
const elevRows = new Map(); // deviceId → <g class="eldev"> of the open elevation
const elevCables = new Map(); // cableId → [.elcable paths] of the open elevation

/**
 * The 2D front view of a rack, the way the 2D app draws it: unit grid,
 * device faces (ports, bays, fans, …), cluster colors, hatched reserved
 * space, side slots on the right — plus the cabling from the front: the
 * cable tray above the rack, the real ports of every device (cabled ones
 * in their network's color), and the cable runs. Rear-side ports come in
 * dashed. Rows are hoverable and clickable; so are the cables.
 */
function elevationSVG(re) {
  const rt = re.rackType;
  const units = rt.units;
  const W = 280;
  const left = 26;
  const right = rt.sideSlots ? 24 : 8;
  const faceX = left;
  const faceW = W - right - left - 4;
  const trayY = 8;

  // Cabling context: the cables that touch this rack and the lanes they
  // use. The 2D app's convention: a copper cable (an RJ45 head) runs down
  // the left cable manager, everything else down the right, and the lanes
  // stack one per network. Vertical runs stay in the margins — the bay
  // only sees a short stub at each port.
  const devs = M.sortedDevices(project, re.rack.id);
  cableIndexMap = C.cableIndex(project); // "deviceId|port" → { cable, role, leg }
  const devIds = new Set(devs.map((d) => d.id));
  const rackCables = (project.cables || []).filter((c) => M.cableEnds(c).some((x) => devIds.has(x.end.device)));
  const netsUsed = [...new Set(rackCables.map((c) => c.network || ''))];
  const trayH = Math.max(14, 8 + netsUsed.length * 4); // the tray grows with its lanes
  const top = trayY + trayH + 8;
  const H = top + units * ELU + 8;
  const laneY = (net) => trayY + 5 + Math.max(0, netsUsed.indexOf(net || '')) * 4;
  const netColor = (net) => {
    const n = net ? M.networkById(project, net) : null;
    return n ? n.color : '#8a97a8';
  };
  const laneSide = (c) => {
    const p = C.portOf(project, c.a);
    return p && M.connectorById(p.connector).family === 'rj45' ? 'L' : 'R';
  };
  const netsL = netsUsed.filter((net) => rackCables.some((c) => (c.network || '') === net && laneSide(c) === 'L'));
  const netsR = netsUsed.filter((net) => rackCables.some((c) => (c.network || '') === net && laneSide(c) === 'R'));
  const laneR0 = faceX + faceW + (rt.sideSlots ? 5 : 9);
  const laneX = (c) => {
    const list = laneSide(c) === 'L' ? netsL : netsR;
    const k = Math.max(0, list.indexOf(c.network || ''));
    const span = list === netsL ? 8 : rt.sideSlots ? 4 : 10;
    const step = list.length > 1 ? Math.min(3, span / (list.length - 1)) : 0;
    return (laneSide(c) === 'L' ? 17 : laneR0) + k * step;
  };

  const o = [];
  o.push(`<svg class="elev" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(rn(re.rack.name))} front view">`);
  // The face art fills its vents with the theme's perforation pattern.
  o.push(`<defs>${R.perfPattern('dark')}</defs>`);

  // Cable tray above the row, one lane per network.
  o.push(`<rect x="6" y="${trayY}" width="${W - 12}" height="${trayH}" rx="2" fill="#101724" stroke="#3a4a61" stroke-width="1" stroke-dasharray="4 3"/>`);
  o.push(`<text class="traylbl" x="8" y="${trayY - 3}">CABLE TRAY${rackCables.length ? ` · ${rackCables.length}` : ''}</text>`);

  o.push(`<rect x="2" y="${top - 2}" width="${W - 4}" height="${units * ELU + 4}" rx="2" fill="#0d131c" stroke="#3a4a61" stroke-width="1.5"/>`);
  for (let u = 1; u <= units; u++) {
    o.push(`<line x1="${left - 3}" y1="${top + u * ELU}" x2="${W - right + 2}" y2="${top + u * ELU}" stroke="#243044" stroke-width="${u % 5 ? 0.4 : 0.8}" opacity="${u % 5 ? 0.5 : 0.9}"/>`);
    o.push(`<text class="unum" x="13" y="${top + (u - 0.5) * ELU + 3}">${u}</text>`);
  }

  // Where an end of a cable meets the sheet: at its port (front side), at
  // the device's edge on the lane's side (rear side — that part of the run
  // stays dashed), or at the tray edge (a far end in another rack; the
  // world x of that rack decides which edge).
  const portPx = new Map(); // "deviceId|port" → { x, y, face, top }
  const exitSide = (deviceId) => {
    const d = world.dvById.get(deviceId);
    const other = d && d.rack;
    if (!other || other.rack.id === re.rack.id) return 1;
    return other.x >= re.x ? 1 : -1;
  };
  const endGeom = (end, here, lx) => {
    const p = here ? portPx.get(`${end.device}|${end.port}`) : null;
    if (p) {
      if (p.face === 'front') {
        const lift = Math.min(4, Math.max(1, p.y - (p.top + 2)));
        return { x: p.x, y: p.y, syL: p.y - lift, face: 'front', here: true };
      }
      const ex = lx < faceX + faceW / 2 ? faceX : faceX + faceW;
      return { x: ex, y: p.y, syL: p.y, face: 'rear', here: true };
    }
    if (here) return { x: faceX + faceW / 2, y: top + 1, syL: top + 1, face: 'front', here: true }; // unknown port
    return { x: exitSide(end.device) === 1 ? W - 8 : 8, y: 0, face: null, here: false };
  };

  // Side channel + slot boxes, like the 2D sheet: every slot is drawn, the
  // empty ones as dashed boxes.
  const nSlots = rt.sideSlots || 0;
  if (nSlots) {
    const cx = W - right + 4;
    const sh = 12 * ELU; // a slot runs 12 U
    const gapPx = (units * ELU - nSlots * sh) / (nSlots + 1);
    const bySlot = new Map();
    for (const d of devs) if (d.loc.kind === 'side') bySlot.set(d.loc.at, d);
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
      const ports = e.type && !e.reserved ? e.ports : [];
      if (ports.length)
        ports.forEach((p, i) => {
          const cy = sy + 6 + ((i + 0.5) / ports.length) * (sh - 12);
          const cid = cableHit(d.id, p.name);
          o.push(`<rect class="elport${cid ? '' : ' idle'}" x="${cx + ELU / 2 - 1.5}" y="${cy - 1.5}" width="3" height="3" rx="0.7" fill="${cid ? netColor(cid.net) : '#22303f'}" data-cid="${cid ? esc(cid.cid) : ''}"/>`);
          portPx.set(`${d.id}|${p.name}`, { x: cx + ELU / 2, y: cy, face: p.face, top: sy + 1, side: true });
        });
      else if (e.type.face === 'pdu') for (let i = 0; i < 6; i++) o.push(`<circle cx="${cx + ELU / 2}" cy="${sy + 9 + i * (sh - 18) / 5}" r="2" fill="none" stroke="#9fb2c8" stroke-width="1"/>`);
      o.push(`<text class="dname" transform="translate(${cx + 2} ${sy + 5}) rotate(90)">${name}</text>`);
      o.push(`</g>`);
    }
  }
  for (const d of devs) {
    const e = world.dvById.get(d.id);
    if (!e) continue;
    if (d.loc.kind === 'side') continue; // drawn with the slot boxes above
    const y = top + (d.loc.at - 1) * ELU;
    const hpx = e.h * ELU;
    // The 2D app's own face drawing: the side visible from the rack's front
    // (a device mounted back to front shows its rear), tinted with the
    // cluster, with the real ports of that side — the cabled ones in their
    // network's color. Reserved space gets its hatched drawing.
    const visible = d.reversed ? 'rear' : 'front';
    const sc = R.schemeFor(d.cluster && M.clusterById(project, d.cluster) ? M.clusterById(project, d.cluster).color : null, 'dark');
    const art = e.reserved
      ? R.deviceFace(e.type, d.name, sc, 'dark', measureText, e.h, { u: ELU, width: faceW, color: null, powerW: M.powerOf(project, d) })
      : R.sideFace(e.type, d.name, sc, 'dark', measureText, e.h, visible, {
          u: ELU,
          width: faceW,
          portColor: (pn) => {
            const cid = cableHit(d.id, pn);
            return cid ? netColor(cid.net) : null;
          },
        });
    o.push(`<g class="eldev" data-did="${d.id}">`);
    o.push(`<g transform="translate(${faceX} ${r1(y)})">${art}</g>`);
    // Hover/selection outline (the face art is tinted with the cluster).
    o.push(`<rect class="elbg" x="${faceX}" y="${y + 0.5}" width="${faceW}" height="${hpx - 1}" rx="1" fill="#ffffff" fill-opacity="0"/>`);
    // Where each of the device's ports meets the sheet: at its real face
    // position when the port is on the visible side (its cable run starts
    // there, solid), at the device's edge when it is on the far side (the
    // run stays dashed).
    const lay = e.reserved ? [] : R.portLayout(e.type, visible, e.h, faceW, { u: ELU });
    const posBy = new Map(lay.map((pt) => [pt.name, pt]));
    for (const p of e.ports) {
      if (p.face === 'front') {
        const pt = posBy.get(p.name) || { x: faceW / 2 - 2, y: hpx / 2 - 2, w: 4, h: 4 };
        portPx.set(`${d.id}|${p.name}`, { x: faceX + pt.x + pt.w / 2, y: y + pt.y + pt.h / 2, face: 'front', top: y + 1, side: false });
        const cid = cableHit(d.id, p.name);
        if (cid) o.push(`<rect class="elport" data-cid="${esc(cid.cid)}" x="${r1(pt.x - 1)}" y="${r1(pt.y - 1)}" width="${r1(pt.w + 2)}" height="${r1(pt.h + 2)}" fill="#ffffff" fill-opacity="0" pointer-events="all"/>`);
      } else {
        // The far side's run comes in dashed from the device's edge, along
        // its first unit, the way the 2D sheet's hidden stub sits.
        portPx.set(`${d.id}|${p.name}`, { x: 0, y: y + Math.min(hpx / 2, ELU / 2), face: 'rear', top: y + 1, side: false });
      }
    }
    o.push(`</g>`);
  }

  // The cable runs: each end goes from its port to the cable's lane in the
  // rack's cable manager; same-rack runs on the same side go straight
  // down the shared lane, everything else over the tray, and far ends in
  // other racks out to the edge of the sheet. Rear-side runs stay dashed.
  const cbl = [];
  for (const c of rackCables) {
    const col = netColor(c.network);
    const lx = laneX(c);
    const lane = laneY(c.network);
    const head = endGeom(c.a, devIds.has(c.a.device), lx);
    for (const leg of M.legsOf(c).filter(Boolean)) {
      const far = endGeom(leg, devIds.has(leg.device), lx);
      const parts = []; // [d, dashed]
      const push = (d, dashed) => d && parts.push([d, !!dashed]);
      const rear = (g) => g.face === 'rear';
      if (head.here && far.here) {
        push(`M${r1(head.x)} ${r1(head.y)}V${r1(head.syL)}H${r1(lx)}`, rear(head));
        if (head.face === far.face) {
          push(`M${r1(lx)} ${r1(head.syL)}V${r1(far.syL)}`, rear(head) || rear(far));
        } else {
          push(`M${r1(lx)} ${r1(head.syL)}V${r1(lane)}`, rear(head));
          push(`M${r1(lx)} ${r1(lane)}V${r1(far.syL)}`, rear(far));
        }
        push(`M${r1(lx)} ${r1(far.syL)}H${r1(far.x)}V${r1(far.y)}`, rear(far));
      } else if (head.here) {
        push(`M${r1(head.x)} ${r1(head.y)}V${r1(head.syL)}H${r1(lx)}V${r1(lane)}H${r1(far.x)}`, rear(head));
      } else if (far.here) {
        push(`M${r1(head.x)} ${r1(lane)}H${r1(lx)}V${r1(far.syL)}H${r1(far.x)}V${r1(far.y)}`, rear(far));
      }
      if (parts.length)
        cbl.push({
          id: c.id,
          svg: parts
            .map(([d, dashed]) => {
              const da = dashed ? ' stroke-dasharray="3 2"' : '';
              // A wide invisible twin makes the thin run easy to hover.
              return `<path class="elchit" data-cid="${esc(c.id)}" d="${d}" fill="none" stroke="none" stroke-width="9"/>` +
                `<path class="elcable" data-cid="${esc(c.id)}" d="${d}" fill="none" stroke="${col}" stroke-width="1.1"${da}/>`;
            })
            .join(''),
        });
    }
  }
  for (const q of cbl) o.push(`<g class="elcableg" data-cid="${esc(q.id)}">${q.svg}</g>`);
  o.push(`</svg>`);
  return o.join('');
}

/** r1: round to one decimal, like the 2D sheet's geometry. */
const r1 = (v) => Math.round(v * 10) / 10;

/** The cable on device `deviceId`'s port `port`: { cid, net } or null. */
function cableHit(deviceId, port) {
  const hit = cableIndexMap.get(`${deviceId}|${port}`);
  return hit ? { cid: hit.cable.id, net: hit.cable.network || null } : null;
}
let cableIndexMap = new Map(); // "deviceId|port" → { cable }, rebuilt per elevation

/**
 * A faceplate texture: the 2D app's own face drawing — R.deviceFace for a
 * front-facing device, R.sideFace's rear (power supplies, fans, rear ports)
 * for one mounted back to front — tinted with the cluster, at 1.6× the
 * sheet's scale, rasterized offscreen from an SVG data URL. Loaded async —
 * the plate stays its plain color until the texture arrives.
 */
function makeFaceTexture(type, clusterColor, reversed, onReady) {
  const u = 32, W = 384; // 1.6× the 2D sheet (20 px per U, 240 px bay)
  const H = Math.max(u, type.height * u);
  const sc = R.schemeFor(clusterColor || null, 'light');
  const art = reversed
    ? R.sideFace(type, type.label, sc, 'light', measureText, type.height, 'rear', { u, width: W })
    : R.deviceFace(type, type.label, sc, 'light', measureText, type.height, { u, width: W });
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<defs>${R.perfPattern('light')}</defs>${art}</svg>`;
  const img = new Image();
  img.onload = () => {
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    cv.getContext('2d').drawImage(img, 0, 0);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    onReady(tex);
  };
  img.onerror = () => {}; // the plate stays its plain light color
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
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
  // The cables on this device: each links to the cable's own inspector.
  const cabs = C.cablesOfDevice(project, d.id);
  const cableLine = (c) => {
    const others = M.cableEnds(c)
      .map((x) => x.end)
      .filter((o) => o.device !== d.id)
      .map((o) => {
        const od = M.deviceById(project, o.device);
        return `${od ? esc(od.name) : esc(o.device)} ${esc(o.port)}`;
      });
    const extra = others.length > 1 ? ` +${others.length - 1}` : '';
    return `<button class="linkish" data-act="cable" data-id="${c.id}">${esc(c.label || `→ ${others[0] || '—'}`)}${extra}</button>`;
  };
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
      ${row('Cables', cabs.length ? cabs.map(cableLine).join('<br>') : '')}
    </dl>
    <button class="linkish" data-act="rackview" data-id="${re.rack.id}">Show ${esc(rn(re.rack.name))}</button>`;
}

function cableHTML(rt) {
  const c = rt.cable;
  const dsc = C.describe(project, c);
  const net = c.network ? M.networkById(project, c.network) : null;
  const endHTML = (x) => {
    const d = x.device;
    if (!d) return `<span class="dim">${esc(x.end.device)} · ${esc(x.end.port)}</span>`;
    const re = world.layout.rackBy.get(d.loc.rack);
    return `<button class="linkish" data-act="device" data-id="${d.id}">${esc(d.name)}</button>
      <small>${re ? rn(re.rack.name) : '—'} · ${esc(x.end.port)}${x.role === 'b' ? ' · B' : ''}${x.face === 'rear' ? ' · rear' : ''}</small>`;
  };
  const len =
    dsc.lengthM != null ? `${esc(C.fmtM(dsc.lengthM))}${dsc.lengthAuto ? ' est.' : ' (set)'}`
    : dsc.needM != null ? `${esc(C.fmtM(dsc.needM))} needed, no length`
    : '<span class="dim">length not set</span>';
  const warn = dsc.issues.filter((i) => i.level === 'warn');
  const note = dsc.issues.filter((i) => i.level === 'note');
  return `
    <h2>${esc(c.label || 'Cable')}</h2>
    <p class="loc">${net ? `<span class="chip" style="background:${net.color}"></span>${esc(net.name)}` : '<span class="dim">no network</span>'}</p>
    <dl>
      ${row('Type', dsc.type ? `${esc(dsc.type.name)}${dsc.type.media ? ` · ${esc(dsc.type.media)}` : ''}` : '<span class="dim">not set</span>')}
      ${row('Length', len)}
      ${row('End A', dsc.ends[0] ? endHTML(dsc.ends[0]) : '<span class="dim">—</span>')}
      ${row('End B', dsc.ends[1] ? endHTML(dsc.ends[1]) : '<span class="dim">—</span>')}
    </dl>
    ${warn.length ? `<p class="cablewarn"><b class="over">${warn.map((i) => esc(i.short)).join(' · ')}</b></p><p class="dim">${esc(warn.map((i) => i.text).join('. '))}</p>` : ''}
    ${note.length ? `<p class="cabenote dim">${esc(note.map((i) => i.text).join(' · '))}</p>` : ''}`;
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
  // A cabled port selects its cable (like the 2D app), the row the device.
  const pt = ev.target.closest('.elport[data-cid]');
  if (pt && pt.dataset.cid) {
    const rt = world.cableRouteById.get(pt.dataset.cid);
    if (rt) {
      select({ kind: 'cable', entry: rt, box: null });
      return;
    }
  }
  const dvEl = ev.target.closest('.eldev');
  if (dvEl) {
    const dv = world.dvById.get(dvEl.dataset.did);
    if (dv) select({ kind: 'device', entry: dv, box: entityBox('device', dv) });
    return;
  }
  const cb = ev.target.closest('.elcable, .elchit');
  if (cb) {
    const rt = world.cableRouteById.get(cb.dataset.cid);
    if (rt) select({ kind: 'cable', entry: rt, box: null });
    return;
  }
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.dataset.id;
  if (btn.dataset.act === 'rack') {
    const re = world.layout.rackBy.get(id);
    if (re) select({ kind: 'rack', entry: re, box: entityBox('rack', re) });
  } else if (btn.dataset.act === 'rackview') {
    const re = world.layout.rackBy.get(id);
    if (re) enterRackView(re);
  } else if (btn.dataset.act === 'cable') {
    const rt = world.cableRouteById.get(id);
    if (rt) select({ kind: 'cable', entry: rt, box: null });
  } else if (btn.dataset.act === 'device') {
    const dv = world.dvById.get(id);
    if (dv) select({ kind: 'device', entry: dv, box: entityBox('device', dv) });
  }
});
inspBody.addEventListener('mouseover', (ev) => {
  // A cabled port highlights its cable; otherwise the device row or the
  // cable run under the pointer.
  const pt = ev.target.closest('.elport[data-cid]');
  if (pt && pt.dataset.cid) {
    elCableHover = pt.dataset.cid;
    elHover = null;
    return;
  }
  const dv = ev.target.closest('.eldev');
  if (dv) {
    elCableHover = null;
    elHover = world.dvById.get(dv.dataset.did) || null;
    return;
  }
  const cb = ev.target.closest('.elcable, .elchit');
  if (cb) elCableHover = cb.dataset.cid;
});
inspBody.addEventListener('mouseout', (ev) => {
  const t = ev.target.closest('.eldev');
  if (t) {
    if (!t.contains(ev.relatedTarget)) {
      elHover = null;
      hoverDirty = true; // resume 3D hovering
    }
    return;
  }
  const cb = ev.target.closest('.elcable, .elchit');
  if (cb && !cb.contains(ev.relatedTarget)) {
    elCableHover = null;
    hoverDirty = true; // resume 3D hovering
  }
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
  needsRender = true;
  hoverDirty = true;
  hoverKey = null;
  lastTipHTML = null;
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
  elCableHover = null;
  openRackId = null;
  elevRows.clear();
  elevCables.clear();
  cableFollow = null; // the routes it rode are gone with the old world
  inspector.hidden = true;
  tooltip.hidden = true;
  syncEnterRowBtn();

  $('planName').textContent = p.name + (source && source !== p.name ? ` — ${source}` : '');
  measureBar(); // the header content (and possibly height) changed
  const t = M.statsWithin(p, null);
  $('planInfo').textContent = `${plural(p.floors.length, 'floor')} · ${plural(t.racks, 'rack')} · ${plural(t.count, 'device')} · ${fmtKW(t.powerW)}`;
  buildFloors();
  buildLegend();

  const b = world.layout.bounds;
  view.goal.set(0, Math.min(2.5, b.top * 0.4), 0);
  view.target.copy(view.goal);
  view.radius = view.goalR = Math.max(b.w, b.d) * 1.05 + 8;
  view.thetaGoal = view.phiGoal = null;
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
  needsRender = true;
  hoverDirty = true; // hover params differ per mode (crosshair vs pointer)
  $('orbitBtn').classList.toggle('active', mode === 'orbit');
  $('walkBtn').classList.toggle('active', mode === 'walk');
  $('cableBtn').classList.toggle('active', mode === 'cable');
  crosshair.hidden = mode !== 'walk';
  $('modeHint').textContent =
    mode === 'walk'
      ? 'WASD move · Shift run · E/Q up/down · mouse look · click inspect · Esc orbit'
      : mode === 'cable'
        ? 'drag rotate · wheel zoom · click a cable to follow it · C for orbit'
        : 'drag rotate · wheel zoom · right-drag pan · click inspect · V walk · C cables';
  if (mode !== 'cable' && cableFollow) cableFollow = null; // no more visible cable to ride
  if (world) fillAll(); // cable + faceplate visibility and the strip cuts depend on the mode
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
  view.thetaGoal = view.phiGoal = null;
  view.theta = Math.atan2(off.x, off.z);
  view.phi = clamp(Math.acos(clamp(off.y / Math.max(off.length(), 0.001), -1, 1)), 0.05, 1.5707);
  view.radius = view.goalR = 12;
  view.mode = 'orbit';
  setMode('orbit');
}

/** Cable mode: orbit-style camera, but the cables are on and a click rides a cable. */
function toCable() {
  if (view.mode === 'walk') toOrbit();
  setMode(view.mode === 'cable' ? 'orbit' : 'cable');
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
  if (rackView) {
    needsRender = true; // label opacities changed
    updateRowLabelsFade();
  }
});
$('cableBtn').addEventListener('click', () => toCable());
$('panelChk').addEventListener('change', (e) => {
  frontPanelsOn = e.target.checked;
  if (world) fillAll(); // the faceplates appear/disappear
});
$('leaveRowBtn').addEventListener('click', () => exitRackView());
// The big “Enter row mode” button — same spot and style as “Leave row
// mode”: shown whenever a rack is selected (and row mode is closed).
function syncEnterRowBtn() {
  const k = selected ? selected.kind : null;
  $('enterRowBtn').hidden = !(k && (k === 'rack' || k === 'device') && !rackView);
}
$('enterRowBtn').addEventListener('click', () => {
  if (!selected || rackView) return;
  const k = selected.kind;
  if (k !== 'rack' && k !== 'device') return;
  // A device sends the row mode into its rack's row.
  enterRackView(k === 'rack' ? selected.entry : selected.entry.rack);
});

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
  overlayStale = true; // a fresh header element needs positioning
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

let barH = 0; // header height, re-measured on resize / plan change
const measureBar = () => (barH = $('bar').offsetHeight);
let overlayStale = true; // the overlay moved since the last positioning
function updateOverlay(cam) {
  if (!overlayStale) return; // camera and zoom at rest → nothing to move
  overlayStale = false;
  const minTop = barH + 10;
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
  // The floor chip sits just above the slider panel — the panel's height
  // varies (three sliders), so measure it instead of hard-coding an offset.
  const fl = overlayEl.querySelector('.rk-floor');
  if (fl) fl.style.bottom = Math.round(innerHeight - nav.getBoundingClientRect().top + 10) + 'px';
  syncZoomSlider();
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

// The Zoom slider: logarithmic over the row view's zoom range (the same
// range as Shift+wheel). Its label shows what 1 U renders as.
function syncZoomSlider() {
  const rv = rackView;
  const sl = $('zoomSlider');
  if (!rv || document.activeElement === sl) return; // mid-drag: don't fight it
  const h = canvas.clientHeight;
  const ppm = rv.ppm || h / orthoH;
  const ppmOut = h / rv.maxH, ppmIn = h / rv.minH;
  sl.value = Math.round(clamp(1000 * Math.log(ppm / ppmOut) / Math.log(ppmIn / ppmOut), 0, 1000));
  $('zoomVal').textContent = Math.round(ppm * L.U) + ' px/U';
}
$('zoomSlider').addEventListener('input', (e) => {
  const rv = rackView;
  if (!rv) return;
  const h = canvas.clientHeight;
  const ppmOut = h / rv.maxH, ppmIn = h / rv.minH;
  const ppm = ppmOut * Math.pow(ppmIn / ppmOut, +e.target.value / 1000);
  rv.ppm = ppm;
  orthoH = h / ppm; // the frame loop notices the change and re-renders
  sizeOrtho();
  $('zoomVal').textContent = Math.round(ppm * L.U) + ' px/U';
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
  view.thetaGoal = view.phiGoal = null;
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
  // Default zoom: the fixed on-screen scale (ROW_PX_PER_M), but never so
  // close that the rack is cropped — the whole rack, with a little
  // headroom, always fits (a short window zooms out just enough).
  const h0 = canvas.clientHeight;
  const ppm = Math.min(ROW_PX_PER_M, (h0 * 0.94) / re.height);
  // The row view rides the orbit camera's parameters; only walk must give
  // them up. Cable mode stays on — it just adds the runs to the same view.
  if (view.mode === 'walk') {
    view.mode = 'orbit';
    setMode('orbit');
  }
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
    ppm, // on-screen zoom in CSS px per meter (Zoom slider / Shift+wheel)
    finalH: h0 / ppm,
    minH: re.height * 0.35, // closest the zoom goes: a few devices
    maxH: 90, // furthest out: the whole row
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
  syncEnterRowBtn();
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
    // The pan ends at t = 0.5 — the view has covered the x/y distance to
    // the new rack. The selection box follows the view: it jumps to the
    // new rack the moment the camera arrives, not when the flight ends.
    if (rv.t >= 0.5 && !rv.selMoved) {
      rv.selMoved = true;
      select({ kind: 'rack', entry: re, box: entityBox('rack', re) });
    }
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
  rackView = null;
  world.keepSet = null;
  world.focusId = focusIdFor(selected); // refollow the real selection
  world.focusRacks = selected && selected.kind === 'cable' ? world.cableRacks.get(selected.entry.cable.id) : null;
  fillAll(); // restore the racks hidden while the row view was open
  refreshCableHot();
  updateCableHighlight();
  for (const arr of world.labels.values()) for (const spr of arr) spr.visible = true;
  for (const sp of world.floorLabels) sp.visible = true;
  overlayEl.hidden = true;
  overlayEl.innerHTML = '';
  overlayItems = [];
  $('leaveRowBtn').hidden = true;
  syncEnterRowBtn();
  syncRowNav();
  for (const { m } of rowLabels) {
    world.group.remove(m);
    m.geometry.dispose();
    m.material.map.dispose();
    m.material.dispose();
  }
  rowLabels = [];
  if (keepCamera) return; // a row-to-row flight keeps the camera where it is
  // Leaving row mode always returns to a fixed “whole floor” framing:
  // 45° elevation, 45° around the vertical axis, far enough to see the
  // whole floor. Target and radius ease in updateOrbit, the angles via
  // one-shot goals; the selection is kept.
  const slab = world.layout.floors.find((f) => f.floor === re.floor).slab;
  view.goal.set(0, re.y + 1, 0);
  view.thetaGoal = Math.PI / 4;
  view.phiGoal = Math.PI / 4;
  view.goalR = Math.max(slab.w, slab.d) * 0.75 + 4;
  // Park the perspective camera at the orbit's current pose, so the first
  // cut lands on a coherent frame; from there everything eases.
  const sp = Math.sin(view.phi);
  camera.position.set(
    view.target.x + view.radius * sp * Math.sin(view.theta),
    view.target.y + view.radius * Math.cos(view.phi),
    view.target.z + view.radius * sp * Math.cos(view.theta)
  );
  camera.lookAt(view.target);
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
  pointerDirty = true; // the hover must track the cursor this frame
  hoverDirty = true;
  if (!dragging || (view.mode !== 'orbit' && view.mode !== 'cable')) return;
  const dx = e.clientX - dragging.x;
  const dy = e.clientY - dragging.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) {
    dragMoved = true;
    if (cableFollow) cableFollow = null; // a drag takes over the camera
  }
  // In the row view a plain click stays; an actual drag switches to a free
  // orbit around the row — row mode itself stays on.
  if (dragging.inRackView && rackView && rackView.cam === 'ortho' && dragMoved) toRowOrbit();
  dragging.x = e.clientX;
  dragging.y = e.clientY;
  if (dragging.btn === 'rotate') {
    view.thetaGoal = view.phiGoal = null; // the drag owns the angles now
    view.theta -= dx * 0.005;
    view.phi = clamp(view.phi - dy * 0.005, 0.05, 1.5707);
  } else {
    const k = view.radius * 0.0012;
    const right = _right.setFromMatrixColumn(camera.matrix, 0);
    const up = _up.setFromMatrixColumn(camera.matrix, 1);
    view.goal.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
    view.target.copy(view.goal);
  }
});
const endDrag = () => {
  dragging = null;
  hoverDirty = true; // hover was suppressed during the drag — pick again
  pointerDirty = true;
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('click', (e) => {
  if ((view.mode !== 'orbit' && view.mode !== 'cable') || e.detail === 0 || dragMoved) return;
  // In the row view, clicking a rack/device smoothly switches to it.
  if (rackView && hovered && hovered.kind !== 'floor' && hovered.kind !== 'cable') {
    recenterOn(hovered.kind === 'rack' ? hovered.entry : hovered.entry.rack);
  }
  select(hovered); // the clicked entity itself wins (e.g. the device panel)
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('dblclick', () => {
  if (view.mode === 'walk' || !hovered || hovered.kind === 'cable') return;
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
        rv.ppm = canvas.clientHeight / orthoH; // the Zoom slider follows
        syncZoomSlider();
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
  if (e.code === 'KeyC') {
    toCable();
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
    r.racks.map((rk) => [rk.x - rk.w / 2 - R, rk.z - rk.d / 2 - R, rk.x + rk.w / 2 + R, rk.z + rk.d / 2 + R])
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
  // Snap when the easing is visually done, so the camera can come to rest —
  // on-demand rendering needs a fixed point (the easing is asymptotic).
  if (view.target.distanceToSquared(view.goal) < 1e-8) view.target.copy(view.goal);
  if (Math.abs(view.goalR - view.radius) < 1e-4) view.radius = view.goalR;
  if (view.thetaGoal != null) {
    view.theta += (view.thetaGoal - view.theta) * damp;
    if (Math.abs(view.thetaGoal - view.theta) < 0.0004) { view.theta = view.thetaGoal; view.thetaGoal = null; }
  }
  if (view.phiGoal != null) {
    view.phi += (view.phiGoal - view.phi) * damp;
    if (Math.abs(view.phiGoal - view.phi) < 0.0004) { view.phi = view.phiGoal; view.phiGoal = null; }
  }
  const sp = Math.sin(view.phi);
  camera.position.set(
    view.target.x + view.radius * sp * Math.sin(view.theta),
    view.target.y + view.radius * Math.cos(view.phi),
    view.target.z + view.radius * sp * Math.cos(view.theta)
  );
  camera.lookAt(view.target);
}

/* --------------------------------------------------------------- run */

let viewH = 0; // canvas CSS height, tracked so resize() can rescale the row view
function resize() {
  // Re-read the pixel ratio cap: it can change on resize (e.g. the window is
  // moved to a denser monitor) — the adaptive value stays below it.
  pixelCap = Math.min(window.devicePixelRatio, 2);
  if (pixelRatio > pixelCap) pixelRatio = pixelCap;
  applyPixelRatio();
  const w = innerWidth;
  const h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  // Keep the row view's on-screen scale (px per meter) constant: the
  // visible height in meters grows/shrinks with the canvas. Skipped while
  // an entry/flight animation is driving orthoH.
  const h1 = canvas.clientHeight;
  if (viewH && h1 !== viewH && rackView && rackView.cam === 'ortho' &&
      !rackView.fly && rackView.t >= 1) {
    const rv = rackView;
    // The user's zoom is kept — except at (or beyond) the default framing,
    // which must keep the whole rack in frame: re-derive it for the new
    // window height.
    if (rv.ppm <= (viewH * 0.94) / rv.re.height + 1)
      rv.ppm = Math.min(ROW_PX_PER_M, (h1 * 0.94) / rv.re.height);
    orthoH = h1 / rv.ppm;
    syncZoomSlider();
  }
  viewH = h1;
  sizeOrtho();
  measureBar();
  overlayStale = true;
  needsRender = true;
  if (rackView) syncRowNav(); // the slider panel re-centers, the floor chip follows
}
window.addEventListener('resize', resize);

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  // Cable follow: drag the orbit target along the route (ease-in-out). The
  // orbit easing chases it, so the camera glides after the cable.
  if (cableFollow && world) {
    const fl = cableFollow;
    const t = clamp((now - fl.t0) / (fl.dur * 1000), 0, 1);
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    fl.d = fl.d0 + (fl.d1 - fl.d0) * e;
    const rt = world.cableRouteById.get(fl.id);
    const p = rt ? pointAtLeg(rt.legs[0], fl.m, fl.d) : null;
    if (p) {
      view.goal.set(p[0], p[1], p[2]);
      if (view.goalR > 1.6) view.goalR = 1.6; // keep the run filling the view
    }
    if (t >= 1) {
      cableFollow = null;
      hoverDirty = true; // hover was suppressed during the ride — pick again
      pointerDirty = true;
    }
  }
  let cam = camera;
  if (rackView) {
    if (rackView.cam === 'ortho') {
      updateRackView(dt);
      cam = orthoCam;
    } else updateOrbit(dt); // free orbit around the row; row mode stays on
  } else if (view.mode === 'walk') updateWalk(dt);
  else updateOrbit(dt);
  if (cameraMoved(cam) || orthoH !== lastSeenOrthoH) {
    lastSeenOrthoH = orthoH;
    needsRender = true;
    hoverDirty = true; // the scene under the pointer/crosshair moved
    if (rackView) overlayStale = true;
  }
  updateHover(cam);
  updateCableCard(cam); // the detail card tracks the ride point (DOM, every frame)
  // Adaptive resolution: after a short warm-up, look at the average frame
  // time every ~50 frames and step the render scale down when it runs long
  // (≈45 fps) or back up when there is headroom (≈60 fps). It never goes
  // more than half a step below native — on a 2× display that is 1.5, never
  // 1.0 — because below that every texture reads as blurry, which is worse
  // than a slightly lower framerate.
  perfWarm += dt;
  perfAcc += dt;
  perfN++;
  if (perfWarm > 2 && perfN >= 50) {
    const avg = (perfAcc / perfN) * 1000;
    perfAcc = 0;
    perfN = 0;
    const floor = Math.max(1, pixelCap - 0.5);
    if (avg > 22 && pixelRatio > floor) { pixelRatio = Math.max(floor, pixelRatio - 0.25); applyPixelRatio(); needsRender = true; }
    else if (avg < 16 && pixelRatio < pixelCap) { pixelRatio = Math.min(pixelCap, pixelRatio + 0.25); applyPixelRatio(); needsRender = true; }
  }
  // On-demand rendering: the same frame would be wasted GPU work (and heat,
  // which is what throttles sustained framerates).
  if (needsRender) {
    needsRender = false;
    if (rackView) updateOverlay(cam);
    renderer.render(scene, cam);
  }
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
