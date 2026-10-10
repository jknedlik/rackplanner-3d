/*
 * Vendored from https://github.com/dennisklein/rackplanner (js/render.js) — CC0 1.0 Universal (public domain).
 * Unmodified except this header.
 *
/*
 * Rackplanner: SVG rendering of the rack elevation sheet.
 *
 * A sheet shows one row of racks, standing on a common floor line, with a
 * cluster legend and a title block. Produces SVG markup strings with
 * concrete colors (no CSS variables), so the same output works on screen, as
 * a downloaded .svg, as a PNG export and in print. Also owns the sheet
 * geometry, including hit testing for drag and drop.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./model.js'));
  else (root.RP = root.RP || {}).render = factory(root.RP.model);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (M) {
  'use strict';

  // ------------------------------------------------------------- geometry
  // One height unit is drawn 20 px tall; the 19" mounting width is 240 px.

  const U = 20;
  const BAY_W = 240;
  const RAIL = 24;
  const FRAME = 10;
  const SIDE_W = 36;
  const GAP = 36;
  const MX = 28;
  const TOP = 30;
  const HEADER = 50;
  const PLINTH = 12;
  const EAR = 9;
  const RACK_W = FRAME + RAIL + BAY_W + RAIL + SIDE_W + FRAME;
  const ADD_W = 120;
  const SLOT_W = U;
  const SLOT_H = BAY_W;
  const TITLE_W = 330;
  const TITLE_H = 112;

  const rackX = (i) => MX + i * (RACK_W + GAP);
  const sheetWidth = (columns, extra) => MX * 2 + columns * RACK_W + (columns - 1) * GAP + (extra ? GAP + ADD_W : 0);

  /**
   * Geometry of a row: racks side by side, bottoms aligned, so shorter
   * racks start lower. Units are numbered from the top of each rack.
   */
  function rowLayout(project, rowId, withAddSlot) {
    const pos = M.locateRow(project, rowId) || M.allRows(project)[0];
    const types = pos.row.racks.map((rack) => M.rackTypeOf(project, rack));
    const maxUnits = Math.max(...types.map((t) => t.units));
    const uBottom = TOP + HEADER + FRAME + maxUnits * U;
    const racks = pos.row.racks.map((rack, i) => {
      const t = types[i];
      const x = rackX(i);
      const uTop = uBottom - t.units * U;
      return {
        rack,
        i,
        x,
        bayX: x + FRAME + RAIL,
        sideX: x + FRAME + RAIL + BAY_W + RAIL,
        units: t.units,
        slots: t.sideSlots,
        uTop,
        uh: t.units * U,
        rackTop: uTop - FRAME,
        headTop: uTop - FRAME - HEADER,
      };
    });
    const addSlot = !!withAddSlot && racks.length < M.LIMITS.racks;
    const rackBottom = uBottom + FRAME;
    return {
      row: pos.row,
      floor: pos.floor,
      racks,
      byId: new Map(racks.map((r) => [r.rack.id, r])),
      maxUnits,
      uBottom,
      rackBottom,
      top: TOP + HEADER + FRAME,
      footTop: rackBottom + PLINTH + 30,
      width: sheetWidth(racks.length, addSlot),
      addSlot: addSlot ? { x: rackX(racks.length), y: uBottom - maxUnits * U - FRAME, w: ADD_W, h: maxUnits * U + FRAME * 2 } : null,
    };
  }

  function slotRect(r, k) {
    const gap = (r.uh - r.slots * SLOT_H) / (r.slots + 1);
    return { x: r.sideX + (SIDE_W - SLOT_W) / 2 - 2, y: r.uTop + gap + k * (SLOT_H + gap), w: SLOT_W, h: SLOT_H };
  }

  function rectIn(r, loc, h) {
    if (loc.kind === 'side') return Object.assign(slotRect(r, loc.at), { rotated: true });
    return { x: r.bayX, y: r.uTop + (loc.at - 1) * U, w: BAY_W, h: h * U, rotated: false };
  }

  /** Where a device of `typeId` (and `height`, for reserved space) at `loc` is drawn on its row's sheet. */
  function locRect(project, loc, typeId, height, layout) {
    const pos = M.locateRack(project, loc.rack);
    if (!pos) return null;
    const lay = layout && layout.row.id === pos.row.id ? layout : rowLayout(project, pos.row.id);
    return rectIn(lay.racks[pos.index], loc, M.heightOf(project, typeId, height));
  }

  // ---------------------------------------------------------------- fonts

  const FONT_MONO = `'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace`;
  const FONT_UI = `Barlow, 'Segoe UI', system-ui, -apple-system, sans-serif`;
  const FONT_COND = `'Barlow Condensed', 'Arial Narrow', Barlow, sans-serif`;
  const WEB_FONTS = /'IBM Plex Mono',\s*|'Barlow Condensed',\s*|\bBarlow,\s*/g;
  /** A font stack without the web fonts, which exported files cannot load. */
  const withoutWebFonts = (stack) => stack.replace(WEB_FONTS, '');
  const FONTS = {
    name1: { css: `500 11px ${FONT_MONO}`, family: FONT_MONO, size: 11, weight: 500 },
    name: { css: `600 12.5px ${FONT_MONO}`, family: FONT_MONO, size: 12.5, weight: 600 },
    tag: { css: `600 8.5px ${FONT_UI}`, family: FONT_UI, size: 8.5, weight: 600 },
    tape: { css: `600 11.5px ${FONT_MONO}`, family: FONT_MONO, size: 11.5, weight: 600 },
    stat: { css: `500 10.5px ${FONT_MONO}`, family: FONT_MONO, size: 10.5, weight: 500 },
    legend: { css: `500 12px ${FONT_UI}`, family: FONT_UI, size: 12, weight: 500 },
    title: { css: `600 17px ${FONT_COND}`, family: FONT_COND, size: 17, weight: 600 },
    rail: { css: `500 8.5px ${FONT_MONO}`, family: FONT_MONO, size: 8.5, weight: 500 },
    cap: { css: `600 7px ${FONT_UI}`, family: FONT_UI, size: 7, weight: 600 },
    small: { css: `500 9.5px ${FONT_MONO}`, family: FONT_MONO, size: 9.5, weight: 500 },
    // Cabling drawings.
    label: { css: `600 10px ${FONT_MONO}`, family: FONT_MONO, size: 10, weight: 600 },
    box: { css: `600 11.5px ${FONT_MONO}`, family: FONT_MONO, size: 11.5, weight: 600 },
    port: { css: `600 8.5px ${FONT_MONO}`, family: FONT_MONO, size: 8.5, weight: 600 },
    unit: { css: `500 7.5px ${FONT_MONO}`, family: FONT_MONO, size: 7.5, weight: 500 },
    note: { css: `500 11px ${FONT_UI}`, family: FONT_UI, size: 11, weight: 500 },
    head: { css: `600 12px ${FONT_UI}`, family: FONT_UI, size: 12, weight: 600 },
  };

  // --------------------------------------------------------------- themes

  const THEMES = {
    light: {
      paper: '#f8f9fb', grid: '#e9edf1', gridMajor: '#dde3e9', border: '#bfc8d2',
      ink: '#18212b', ink2: '#4f5b68', ink3: '#8390a0',
      frame: '#2a3038', frameHi: '#3b424c', rail: '#343b44', railText: '#b3bdc8', railTick: '#4b535e', hole: '#1b1f25',
      slotA: '#f2f4f7', slotB: '#e8ecf0', slotLine: '#dce1e7',
      channel: '#30373f', channelSlot: '#e8ecf0', slotDash: '#8e99a6', finger: '#464e59',
      faceBase: '#ffffff', faceMix: 0.15, bayMix: 0.3, deep: '#10151b', edgeMix: 0.32,
      tape: '#f2c230', tapeShade: '#c99b12', tapeInk: '#1b1f24', bar: '#2a3038', barTrack: '#dfe4ea', barReserved: '#9aa5b1', power: '#c98a0c',
      select: '#18212b', handle: '#f2c230', ok: '#1f9d55', bad: '#d33c3c',
      unassigned: '#8c96a3', perf: 'rgba(16,21,27,0.3)', led: '#2fbf64', reserved: '#f1f3f6', display: '#1d2a22', displayInk: '#6fe39a',
      portHole: '#262c33', portMetal: '#bcc4cd', portEdge: '#7d8894', portFree: '#c9d0d7',
    },
    dark: {
      paper: '#161b21', grid: '#1c2229', gridMajor: '#222931', border: '#36404b',
      ink: '#e6ebf0', ink2: '#a5b0bc', ink3: '#6f7b89',
      frame: '#39414b', frameHi: '#48515c', rail: '#434c57', railText: '#a3aeba', railTick: '#58626e', hole: '#1a1e24',
      slotA: '#1e242b', slotB: '#232a32', slotLine: '#2b333c',
      channel: '#3d4550', channelSlot: '#232a32', slotDash: '#687482', finger: '#525b67',
      faceBase: '#1b2128', faceMix: 0.3, bayMix: 0.44, deep: '#07090c', edgeMix: 0.42,
      tape: '#f2c230', tapeShade: '#a07a0c', tapeInk: '#1b1f24', bar: '#c9d2dc', barTrack: '#2b333c', barReserved: '#5d6875', power: '#e0a529',
      select: '#f3f6f9', handle: '#f2c230', ok: '#43c47a', bad: '#f06464',
      unassigned: '#7d8794', perf: 'rgba(255,255,255,0.2)', led: '#43d17a', reserved: '#1d232a', display: '#0b1510', displayInk: '#5fd68b',
      portHole: '#0b0e12', portMetal: '#6b7480', portEdge: '#2a3038', portFree: '#3a434d',
    },
  };

  // --------------------------------------------------------------- colors

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgbToHex(rgb) {
    return '#' + rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
  }
  /** Linear blend from color a to color b; t = share of b. */
  function mix(a, b, t) {
    const A = hexToRgb(a);
    const B = hexToRgb(b);
    return rgbToHex(A.map((v, i) => v + (B[i] - v) * t));
  }
  /** WCAG relative luminance of a #rrggbb color. */
  function luminance(hex) {
    const [r, g, b] = hexToRgb(hex).map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  /** WCAG contrast ratio of two #rrggbb colors (1 to 21). */
  function contrast(a, b) {
    const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
    return (x + 0.05) / (y + 0.05);
  }
  /** The ink for text on fill `bg`: white or `dark`, whichever stands out more. */
  function inkOn(bg, dark) {
    const ink = dark || '#10151b';
    return contrast('#ffffff', bg) >= contrast(ink, bg) ? '#ffffff' : ink;
  }

  /** Derives the full device color scheme from a cluster's base color. */
  function schemeFor(color, theme) {
    const T = THEMES[theme] || THEMES.light;
    const base = M.normalizeHex(color) || T.unassigned;
    const dark = theme === 'dark';
    return {
      base,
      ear: dark ? mix(base, '#000000', 0.1) : base,
      screw: mix(base, '#ffffff', 0.55),
      face: mix(T.faceBase, base, T.faceMix),
      bay: mix(T.faceBase, base, T.bayMix),
      edge: mix(base, T.deep, T.edgeMix),
      detail: dark ? mix(base, '#ffffff', 0.25) : mix(base, T.deep, 0.5),
      port: mix(base, T.deep, dark ? 0.82 : 0.7),
      text: T.ink,
      sub: T.ink2,
      led: T.led,
    };
  }

  // -------------------------------------------------------------- helpers

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const r1 = (v) => Math.round(v * 100) / 100;

  function approxMeasure(text, css) {
    const size = parseFloat(/(\d+(?:\.\d+)?)px/.exec(css)[1]);
    const perChar = /Mono/.test(css) ? 0.6 : 0.52;
    return text.length * size * perChar;
  }

  /**
   * Shortens text with an ellipsis until it fits `max` px. Spaces and an
   * ellipsis the cut leaves at the end go, so "a … 04" never becomes "a … …".
   */
  function fitText(text, font, max, measure) {
    const m = measure || approxMeasure;
    if (m(text, font.css) <= max) return text;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (m(text.slice(0, mid) + '…', font.css) <= max) lo = mid;
      else hi = mid - 1;
    }
    const kept = text.slice(0, lo).replace(/[\s…]+$/, '');
    return kept ? kept + '…' : '…';
  }

  function text(x, y, str, font, fill, extra) {
    return `<text x="${r1(x)}" y="${r1(y)}" font-family="${font.family}" font-size="${font.size}" font-weight="${font.weight}" fill="${fill}"${extra || ''}>${esc(str)}</text>`;
  }

  const rectPath = (x, y, w, h) => `M${r1(x)} ${r1(y)}h${r1(w)}v${r1(h)}h${r1(-w)}z`;

  /** 1.2 kW, 850 W */
  function formatPower(w) {
    return w >= 1000 ? `${(Math.round(w / 100) / 10).toFixed(1)} kW` : `${Math.round(w)} W`;
  }
  const kw = (w) => (Math.round(w / 100) / 10).toFixed(1);

  // --------------------------------------------------------- device faces
  // Each face is drawn in local coordinates: (0,0) top-left, `g.w` wide
  // (BAY_W on the Racks sheet) and `h` px tall, `g.u` px per unit. Details
  // sit right of the label area and scale with the face.

  const LABEL_X = EAR + 7;
  const DETAIL_X = 108;

  /** Face geometry: unit height `u` and width `width` (the Racks sheet's by default). */
  function faceGeom(opts) {
    const u = (opts && opts.u) || U;
    const w = (opts && opts.width) || BAY_W;
    return { u, w, dx: DETAIL_X, dw: w - EAR - 6 - DETAIL_X, s: u / U };
  }

  function rj45Ports(sc, h, hU, theme, g) {
    const cols = 24;
    const per = 6;
    const gIn = 1;
    const gOut = 3.5;
    const pw = (g.dw - (cols - cols / per) * gIn - (cols / per - 1) * gOut) / cols;
    let d = '';
    for (let k = 0; k < hU; k++) {
      let x = g.dx;
      for (let c = 0; c < cols; c++) {
        d += rectPath(x, k * g.u + 4 * g.s, pw, 5 * g.s) + rectPath(x, k * g.u + 11 * g.s, pw, 5 * g.s);
        x += pw + ((c + 1) % per === 0 ? gOut : gIn);
      }
    }
    return `<path d="${d}" fill="${sc.port}"/>`;
  }

  function qsfpCages(sc, h, hU, theme, g) {
    const cols = 12;
    const gIn = 1.6;
    const gOut = 5;
    const pw = (g.dw - 10 * gIn - gOut) / cols;
    let outer = '';
    let inner = '';
    for (let k = 0; k < hU; k++) {
      let x = g.dx;
      for (let c = 0; c < cols; c++) {
        for (const y of [k * g.u + 3 * g.s, k * g.u + 10.5 * g.s]) {
          outer += rectPath(x, y, pw, 6.5 * g.s);
          inner += rectPath(x + 1.3, y + 1.4 * g.s, pw - 2.6, 3.7 * g.s);
        }
        x += pw + (c === 5 ? gOut : gIn);
      }
    }
    return `<path d="${outer}" fill="${sc.bay}" stroke="${sc.detail}" stroke-width="0.6"/><path d="${inner}" fill="${sc.port}"/>`;
  }

  /** Drive bays with their handles and LEDs, each given as one path. */
  function bayPaths(sc, bays, handles, leds) {
    return (
      `<path d="${bays}" fill="${sc.bay}" stroke="${sc.detail}" stroke-width="0.7"/>` +
      `<path d="${handles}" stroke="${sc.detail}" stroke-width="1.1" stroke-linecap="round"/>` +
      `<path d="${leds}" fill="${sc.detail}"/>`
    );
  }

  function computeBays(sc, h, hU, theme, g) {
    const n = 10;
    const rows = Math.max(1, Math.floor(hU / 2));
    const rowH = (h - 10) / rows;
    const pitch = g.dw / n;
    const w = pitch - 1.6;
    let bays = '';
    let handles = '';
    let leds = '';
    for (let r = 0; r < rows; r++) {
      const y = 5 + r * rowH;
      for (let i = 0; i < n; i++) {
        const x = g.dx + i * pitch;
        bays += rectPath(x, y, w, rowH - (rows > 1 ? 2 : 0));
        handles += `M${r1(x + 2)} ${r1(y + rowH - 5.5 - (rows > 1 ? 2 : 0))}h${r1(w - 4)}`;
        leds += rectPath(x + w - 3.2, y + 2.5, 1.6, 1.6);
      }
    }
    return bayPaths(sc, bays, handles, leds);
  }

  function storageBays(sc, h, hU, theme, g) {
    const cols = 6;
    const rows = hU;
    const px = g.dw / cols;
    const py = (h - 10) / rows;
    let bays = '';
    let handles = '';
    let leds = '';
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = g.dx + c * px;
        const y = 5 + r * py;
        bays += rectPath(x, y, px - 1.8, py - 2);
        handles += `M${r1(x + 2.5)} ${r1(y + py - 6)}h${r1((px - 1.8) * 0.5)}`;
        leds += rectPath(x + px - 6, y + 2.5, 1.8, 1.8);
      }
    }
    return bayPaths(sc, bays, handles, leds);
  }

  function controlPanel(sc, h) {
    const y = h - 15;
    return (
      `<circle cx="${LABEL_X + 5}" cy="${y}" r="4.5" fill="${sc.bay}" stroke="${sc.detail}" stroke-width="0.9"/>` +
      `<path d="M${LABEL_X + 5} ${y - 2.4}v2.2M${LABEL_X + 3.1} ${y - 1.3}a2.4 2.4 0 1 0 3.8 0" fill="none" stroke="${sc.detail}" stroke-width="0.8" stroke-linecap="round"/>` +
      `<circle cx="${LABEL_X + 15}" cy="${y}" r="1.5" fill="${sc.led}"/>` +
      `<circle cx="${LABEL_X + 20}" cy="${y}" r="1.5" fill="${sc.detail}"/>` +
      `<path d="${rectPath(LABEL_X + 27, y - 2, 7, 4)}" fill="${sc.port}"/>`
    );
  }

  function statusLeds(sc, h) {
    return (
      `<circle cx="${LABEL_X + 2}" cy="${h - 15}" r="1.5" fill="${sc.led}"/>` +
      `<circle cx="${LABEL_X + 7}" cy="${h - 15}" r="1.5" fill="${sc.detail}"/>` +
      `<circle cx="${LABEL_X + 12}" cy="${h - 15}" r="1.5" fill="${sc.detail}"/>`
    );
  }

  function enclosureDrawers(sc, h, hU, theme, g) {
    const n = Math.max(1, Math.floor(hU / 2));
    const pitch = (h - 4) / n;
    const dh = pitch - 4;
    let out = '';
    for (let i = 0; i < n; i++) {
      const y = 4 + i * pitch;
      out += `<rect x="${g.dx}" y="${r1(y)}" width="${r1(g.dw)}" height="${r1(dh)}" rx="1" fill="${sc.bay}" stroke="${sc.detail}" stroke-width="0.7"/>`;
      if (dh >= 20) {
        out +=
          `<rect x="${g.dx + 3}" y="${r1(y + 3)}" width="${r1(g.dw - 6)}" height="${r1(dh - 13)}" fill="url(#rp-perf-${theme})"/>` +
          `<rect x="${r1(g.dx + g.dw / 2 - 18)}" y="${r1(y + dh - 7)}" width="36" height="4" rx="2" fill="${sc.detail}"/>` +
          `<circle cx="${g.dx + 7}" cy="${r1(y + dh - 5)}" r="1.5" fill="${sc.led}"/>`;
      } else {
        out += `<rect x="${r1(g.dx + g.dw / 2 - 18)}" y="${r1(y + dh / 2 - 1.5)}" width="36" height="3" rx="1.5" fill="${sc.detail}"/>`;
      }
    }
    return out;
  }

  function gpuFans(sc, h, hU, theme, g) {
    const rows = Math.max(1, Math.floor(hU / 2));
    const cols = 5;
    const cw = g.dw / cols;
    const ch = (h - 8) / rows;
    const r = Math.max(3, Math.min(cw, ch) / 2 - 1.5);
    let rings = '';
    let blades = '';
    for (let i = 0; i < rows; i++) {
      for (let c = 0; c < cols; c++) {
        const cx = r1(g.dx + c * cw + cw / 2);
        const cy = r1(4 + i * ch + ch / 2);
        rings += `<circle cx="${cx}" cy="${cy}" r="${r1(r)}"/>`;
        for (let k = 0; k < 3; k++) {
          const a = (k * 2 * Math.PI) / 3 + 0.4;
          blades += `M${cx} ${cy}l${r1(Math.cos(a) * r * 0.8)} ${r1(Math.sin(a) * r * 0.8)}`;
        }
      }
    }
    return (
      `<rect x="${g.dx - 2}" y="3" width="${r1(g.dw + 4)}" height="${h - 6}" rx="1.5" fill="${sc.bay}"/>` +
      `<g fill="${sc.port}" stroke="${sc.detail}" stroke-width="0.8">${rings}</g>` +
      `<path d="${blades}" stroke="${sc.bay}" stroke-width="1.4" stroke-linecap="round"/>`
    );
  }

  function patchJacks(sc, h, hU, theme, g) {
    const cols = 24;
    const per = 6;
    const pw = 3.6;
    const gap = (g.dw - cols * pw - (cols / per - 1) * 3) / (cols - cols / per);
    let jacks = '';
    let labels = '';
    for (let k = 0; k < hU; k++) {
      let x = g.dx;
      for (let c = 0; c < cols; c++) {
        jacks += rectPath(x, k * g.u + 7 * g.s, pw, 6 * g.s);
        x += pw + ((c + 1) % per === 0 ? 3 + gap : gap);
      }
      labels += rectPath(g.dx, k * g.u + 2.5 * g.s, g.dw, 2.5);
    }
    return `<path d="${labels}" fill="${sc.bay}"/><path d="${jacks}" fill="${sc.port}"/>`;
  }

  function pduOutlets(sc, h, hU, theme, g) {
    const n = 12;
    const pitch = g.dw / n;
    let body = '';
    let holes = '';
    for (let k = 0; k < hU; k++) {
      for (let i = 0; i < n; i++) {
        const x = g.dx + i * pitch + 0.8;
        const y = k * g.u + (g.u - 12) / 2;
        body += rectPath(x, y, pitch - 1.6, 12);
        holes += rectPath(x + 1.6, y + 3, 1.4, 3) + rectPath(x + pitch - 4.6, y + 3, 1.4, 3) + rectPath(x + (pitch - 1.6) / 2 - 0.7, y + 7.5, 1.4, 2.4);
      }
    }
    return `<path d="${body}" fill="${sc.bay}" stroke="${sc.detail}" stroke-width="0.6"/><path d="${holes}" fill="${sc.port}"/>`;
  }

  function upsPanel(sc, h, hU, theme, g) {
    const T = THEMES[theme];
    let s =
      `<rect x="${g.dx}" y="4" width="34" height="12" rx="1" fill="${T.display}"/>` +
      `<rect x="${g.dx + 3}" y="7" width="18" height="2" fill="${T.displayInk}"/>` +
      `<rect x="${g.dx + 3}" y="11" width="11" height="2" fill="${T.displayInk}" opacity="0.6"/>`;
    for (let i = 0; i < 3; i++) s += `<circle cx="${g.dx + 44 + i * 9}" cy="10" r="2.6" fill="${sc.bay}" stroke="${sc.detail}" stroke-width="0.8"/>`;
    if (hU > 1) {
      let vents = '';
      for (let y = g.u + 4; y < h - 5; y += 4) vents += `M${g.dx} ${y}h${r1(g.dw)}`;
      s += `<path d="${vents}" stroke="${sc.detail}" stroke-width="1.2" stroke-linecap="round" opacity="0.7"/>`;
    }
    return s;
  }

  function blankGrooves(sc, h, hU, theme, g) {
    let d = '';
    for (let k = 0; k < hU; k++) d += `M${g.dx - 10} ${r1(k * g.u + g.u / 2)}h${r1(g.dw + 10)}`;
    return `<path d="${d}" stroke="${sc.bay}" stroke-width="2" stroke-linecap="round"/>`;
  }

  function genericVents(sc, h, hU, theme, g) {
    return (
      `<rect x="${g.dx}" y="4" width="${r1(g.dw)}" height="${h - 8}" rx="1" fill="${sc.bay}"/>` +
      `<rect x="${g.dx + 2}" y="6" width="${r1(g.dw - 4)}" height="${h - 12}" fill="url(#rp-perf-${theme})"/>`
    );
  }

  /** Diagonal hatching inside a w×h box, as one path. */
  function hatch(w, h, step) {
    let d = '';
    for (let c = step; c < w + h; c += step) {
      const x1 = Math.min(c, w);
      const x2 = Math.max(0, c - h);
      d += `M${r1(x1)} ${r1(c - x1)}L${r1(x2)} ${r1(c - x2)}`;
    }
    return d;
  }

  function reservedFace(type, name, color, T, measure, hU, powerW, g) {
    const w = g.w;
    const h = hU * g.u;
    const line = color ? mix(color, T.paper, 0.35) : T.ink3;
    let s = `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="2" fill="${T.reserved}"/>`;
    s += `<path d="${hatch(w, h, 9)}" stroke="${line}" stroke-width="0.9" opacity="0.45"/>`;
    s += `<rect x="1" y="1" width="${w - 2}" height="${h - 2}" rx="2" fill="none" stroke="${line}" stroke-width="1.4" stroke-dasharray="5 3"/>`;
    const detail = `RESERVED · ${hU}U${powerW ? ' · ' + formatPower(powerW) : ''}`;
    if (hU === 1) {
      const nm = fitText(name, FONTS.name1, 120, measure);
      s += `<rect x="${LABEL_X - 3}" y="${r1(h / 2 - 7)}" width="${r1(measure(nm, FONTS.name1.css) + 6)}" height="14" fill="${T.reserved}"/>`;
      s += text(LABEL_X, h / 2 + 3.9, nm, FONTS.name1, T.ink);
      s += text(w - 10, h / 2 + 3, detail, FONTS.tag, T.ink2, ' text-anchor="end" letter-spacing="0.8"');
    } else {
      const nm = fitText(name, FONTS.name, w - 2 * LABEL_X, measure);
      const tw = Math.max(measure(nm, FONTS.name.css), measure(detail, FONTS.tag.css) + 8) + 8;
      s += `<rect x="${LABEL_X - 4}" y="4" width="${r1(tw)}" height="30" fill="${T.reserved}"/>`;
      s += text(LABEL_X, 16, nm, FONTS.name, T.ink);
      s += text(LABEL_X, 29, detail, FONTS.tag, T.ink2, ' letter-spacing="0.8"');
    }
    return s;
  }

  /**
   * How each face is drawn: its details, as draw(sc, h, hU, theme, g), and a
   * small panel that devices of 3U and more get.
   */
  const FACE_ART = {
    rj45: [rj45Ports],
    qsfp: [qsfpCages],
    compute: [computeBays],
    storage: [storageBays, controlPanel],
    jbod: [enclosureDrawers, statusLeds],
    gpu: [gpuFans, controlPanel],
    patch: [patchJacks],
    pdu: [pduOutlets],
    ups: [upsPanel, statusLeds],
    blank: [blankGrooves],
    generic: [genericVents, statusLeds],
  };

  /** Ears with their screws and the face between them, as every device has. */
  function bodyShell(sc, w, h, units, u) {
    let s = `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="2" fill="${sc.ear}"/>`;
    s += `<rect x="${EAR}" y="0.5" width="${w - 2 * EAR}" height="${h - 1}" fill="${sc.face}"/>`;
    const screws = units === 1 ? [h / 2] : [u / 2, h - u / 2];
    for (const y of screws) {
      s += `<circle cx="${EAR / 2 + 0.5}" cy="${y}" r="1.7" fill="${sc.screw}"/>`;
      s += `<circle cx="${w - EAR / 2 - 0.5}" cy="${y}" r="1.7" fill="${sc.screw}"/>`;
    }
    return s;
  }
  const edgeLine = (sc, w, h) => `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="2" fill="none" stroke="${sc.edge}"/>`;

  /**
   * Front of a device of `type` named `name`, `hU` units tall (the type's
   * height unless it is reserved space). `extra`: { color, powerW } for
   * reserved space, and `u` and `width` for a face drawn at another scale
   * than the Racks sheet's (20 px units, 240 px wide).
   */
  function deviceFace(type, name, sc, theme, measure, hU, extra) {
    const T = THEMES[theme] || THEMES.light;
    const units = hU || type.height;
    const g = faceGeom(extra);
    if (type.face === 'reserved') return reservedFace(type, name, extra && extra.color, T, measure, units, extra && extra.powerW, g);
    const w = g.w;
    const h = units * g.u;
    let s = bodyShell(sc, w, h, units, g.u);
    const [draw, panel] = FACE_ART[type.face] || FACE_ART.generic;
    s += draw(sc, h, units, theme, g);
    if (panel && units >= 3) s += panel(sc, h);

    const labelMax = DETAIL_X - LABEL_X - 6;
    if (units === 1) {
      if (type.face !== 'blank' && type.face !== 'patch') s += `<circle cx="${DETAIL_X - 5}" cy="${h / 2}" r="1.4" fill="${sc.led}"/>`;
      s += text(LABEL_X, h / 2 + 3.9, fitText(name, FONTS.name1, labelMax - 5, measure), FONTS.name1, sc.text);
    } else {
      s += text(LABEL_X, 16, fitText(name, FONTS.name, labelMax, measure), FONTS.name, sc.text);
      s += text(LABEL_X, 29, fitText(`${type.tag} · ${units}U`, FONTS.tag, labelMax, measure), FONTS.tag, sc.sub, ' letter-spacing="0.8"');
    }
    return s + edgeLine(sc, w, h);
  }

  // ---------------------------------------------------------------- ports
  // Port sizes per connector family at 22 px units, [width, height]: dense
  // rows (switches) and single rows (servers). Other unit heights scale them.

  const PORT_U = 22;
  const DENSE = { rj45: [6.6, 6.4], sfp: [9, 5.6], qsfp: [12.6, 6.6], qsfpdd: [13, 7], osfp: [13.6, 7], sas: [11, 6], lc: [7, 5], mpo: [10, 5] };
  const SPARSE = { rj45: [9, 8], sfp: [11.5, 6.5], qsfp: [17, 8], qsfpdd: [17.5, 8.5], osfp: [18, 8.5], sas: [14, 7.5], lc: [9, 6], mpo: [12, 6] };
  const familyOf = (connector) => (M.connectorById(connector) || { family: 'rj45' }).family;
  const sizeOf = (table, connector) => table[familyOf(connector)] || table.rj45;

  /** Switches: a switch drawing or at least 12 ports (as cabling.isSwitch). */
  function isSwitchType(type) {
    return !!type && (type.face === 'rj45' || type.face === 'qsfp' || M.expandPorts(type).length >= 12);
  }
  /** Device types whose rear shows two power supplies. */
  const hasPower = (type) => !!type && !['pdu', 'patch', 'blank', 'reserved'].includes(type.face);

  // Two power supplies, side by side at the right end of the face.
  const PSU_W = 24;
  const PSU_GAP = 3;
  const PSU_ROOM = 2 * PSU_W + PSU_GAP + 8;
  const psuX = (w) => w - EAR - 5 - 2 * PSU_W - PSU_GAP;

  /**
   * Where the ports of `side` ('front'|'rear', the device's own side) of
   * device type `type` sit on its face, `len` px wide and `hU` units tall at
   * `opts.u` px per unit (20 by default): switches and devices with more
   * than 12 ports there in two rows (odd ports on top, cabled upwards; even
   * ones below, cabled downwards), other devices in one row along their
   * lowest unit, RJ45 first. Port sizes follow the connector; rows that
   * would not fit are squeezed. Returns [{ name, connector, group, index,
   * x, y, w, h, exit: 'up'|'down' }] in face coordinates.
   */
  function portLayout(type, side, hU, len, opts) {
    const u = (opts && opts.u) || U;
    const k0 = u / PORT_U;
    const units = hU || (type && type.height) || 1;
    const all = M.expandPorts(type).filter((p) => p.side === side);
    if (!all.length) return [];
    // The rear of a 1U device keeps room for its power supplies.
    const right = len - EAR - 5 - (side === 'rear' && units === 1 && hasPower(type) ? PSU_ROOM : 0);
    const bottom = units * u;
    const out = [];
    const put = (p, x, y, w, h, exit) => out.push({ name: p.name, connector: p.connector, group: p.group, index: p.index, x: r1(x), y: r1(y), w: r1(w), h: r1(h), exit });
    if (isSwitchType(type) || all.length > 12) {
      const groups = [];
      for (const p of all) (groups[p.group] = groups[p.group] || []).push(p);
      const list = groups.filter(Boolean);
      const gap = 1.4 * k0;
      const block = 3.6 * k0;
      const widthOf = (g) => {
        const w = sizeOf(DENSE, g[0].connector)[0] * k0;
        const cols = Math.ceil(g.length / 2);
        return cols * w + (cols - 1) * gap + Math.floor((cols - 1) / 6) * block;
      };
      const x0 = units === 1 ? DETAIL_X : LABEL_X + 4;
      const total = list.reduce((a, g) => a + widthOf(g), 0) + (list.length - 1) * 8 * k0;
      const k = Math.min(1, (right - x0) / total);
      const margin = 3.2 * k0;
      let x = x0;
      for (const g of list) {
        const [w0, h0] = sizeOf(DENSE, g[0].connector);
        const w = w0 * k0;
        const h = h0 * k0;
        g.forEach((p, i) => {
          const c = Math.floor(i / 2);
          const top = i % 2 === 0;
          const px = x + (c * (w + gap) + Math.floor(c / 6) * block) * k;
          put(p, px, top ? bottom - u + margin : bottom - margin - h, w * k, h, top ? 'up' : 'down');
        });
        x += (widthOf(g) + 8 * k0) * k;
      }
    } else {
      const sorted = all.filter((p) => familyOf(p.connector) === 'rj45').concat(all.filter((p) => familyOf(p.connector) !== 'rj45'));
      const x0 = units >= 2 ? 72 : DETAIL_X;
      const gapOf = (i) => (i === 0 ? 0 : sorted[i - 1].group === sorted[i].group ? 4 : 9) * k0;
      const total = sorted.reduce((a, p, i) => a + gapOf(i) + sizeOf(SPARSE, p.connector)[0] * k0, 0);
      const k = Math.min(1, (right - x0) / total);
      let x = x0;
      sorted.forEach((p, i) => {
        const [w0, h0] = sizeOf(SPARSE, p.connector);
        x += gapOf(i) * k;
        put(p, x, bottom - u / 2 - (h0 * k0) / 2, w0 * k0 * k, h0 * k0, 'down');
        x += w0 * k0 * k;
      });
    }
    return out;
  }

  /**
   * One port of a portLayout: an RJ45 jack or a cage, filled with `color`
   * (a cable's network) or empty.
   */
  function portShape(pt, color, theme) {
    const T = THEMES[theme] || THEMES.light;
    if (familyOf(pt.connector) === 'rj45' || familyOf(pt.connector) === 'lc') {
      const nw = r1(pt.w * 0.4);
      const ny = pt.exit === 'up' ? pt.y + pt.h - 1.4 : pt.y;
      return (
        `<rect x="${r1(pt.x)}" y="${r1(pt.y)}" width="${r1(pt.w)}" height="${r1(pt.h)}" rx="0.6" fill="${color || T.portHole}"${color ? ` stroke="${mix(color, '#000000', 0.35)}" stroke-width="0.6"` : ''}/>` +
        `<rect x="${r1(pt.x + pt.w * 0.3)}" y="${r1(ny)}" width="${nw}" height="1.4" fill="${color ? mix(color, '#000000', 0.45) : T.portFree}"/>`
      );
    }
    const inset = Math.min(1.5, pt.w * 0.14, pt.h * 0.2);
    return (
      `<rect x="${r1(pt.x)}" y="${r1(pt.y)}" width="${r1(pt.w)}" height="${r1(pt.h)}" rx="0.8" fill="${T.portMetal}" stroke="${T.portEdge}" stroke-width="0.6"/>` +
      `<rect x="${r1(pt.x + inset)}" y="${r1(pt.y + inset)}" width="${r1(pt.w - 2 * inset)}" height="${r1(pt.h - 2 * inset)}" rx="0.4" fill="${color || T.portHole}"/>`
    );
  }

  /** Two power supplies with their grilles and LEDs. */
  function powerSupplies(sc, w, h, units, g) {
    const ph = Math.min(15, (units === 1 ? h : g.u) - 6);
    const y = units === 1 ? (h - ph) / 2 : 4;
    let boxes = '';
    let grille = '';
    let leds = '';
    for (let k = 0; k < 2; k++) {
      const x = psuX(w) + k * (PSU_W + PSU_GAP);
      boxes += rectPath(x, y, PSU_W, ph);
      for (const dx of [4, 7.5, 11, 14.5]) grille += `M${r1(x + dx)} ${r1(y + 2.5)}v${r1(ph - 5)}`;
      leds += `<circle cx="${r1(x + PSU_W - 4)}" cy="${r1(y + ph / 2)}" r="1.3" fill="${sc.led}"/>`;
    }
    return `<path d="${boxes}" fill="${sc.bay}" stroke="${sc.detail}" stroke-width="0.6"/><path d="${grille}" stroke="${sc.detail}" stroke-width="0.7" opacity="0.6"/>` + leds;
  }

  /** Fans in a row between `x1` and `x2`, filling the face below `top`. */
  function fanRow(sc, x1, x2, top, bottom) {
    const hh = bottom - top;
    const d = Math.min(hh, 26);
    const n = Math.max(1, Math.floor((x2 - x1) / (d + 4)));
    const pitch = (x2 - x1) / n;
    const r = d / 2 - 1;
    let rings = '';
    let blades = '';
    for (let i = 0; i < n; i++) {
      const cx = r1(x1 + pitch * (i + 0.5));
      const cy = r1(top + hh / 2);
      rings += `<circle cx="${cx}" cy="${cy}" r="${r1(r)}"/>`;
      for (let k = 0; k < 3; k++) {
        const a = (k * 2 * Math.PI) / 3 + 0.4;
        blades += `M${cx} ${cy}l${r1(Math.cos(a) * r * 0.8)} ${r1(Math.sin(a) * r * 0.8)}`;
      }
    }
    return (
      `<rect x="${r1(x1 - 2)}" y="${r1(top)}" width="${r1(x2 - x1 + 4)}" height="${r1(hh)}" rx="1.5" fill="${sc.bay}"/>` +
      `<g fill="${sc.port}" stroke="${sc.detail}" stroke-width="0.7">${rings}</g>` +
      `<path d="${blades}" stroke="${sc.bay}" stroke-width="1.2" stroke-linecap="round"/>`
    );
  }

  /**
   * One side ('front'|'rear', the device's own) of a device drawn
   * generically: body and ears like deviceFace, name (and tag above 1U),
   * the ports of that side and, at the rear, two power supplies (not for
   * PDUs, patch panels and blanking panels), with a fan grille on switches
   * that have no ports there. Options: `u` and `width` as for deviceFace,
   * `portColor(portName)` → fill of a cabled port or null, `ports: false` to
   * leave the ports out (to draw them over cables), `layout` (a
   * portLayout to reuse), `color`/`powerW` for reserved space.
   */
  function sideFace(type, name, sc, theme, measure, hU, side, opts) {
    const o = opts || {};
    const T = THEMES[theme] || THEMES.light;
    const units = hU || type.height;
    const g = faceGeom(o);
    if (type.face === 'reserved') return reservedFace(type, name, o.color, T, measure, units, o.powerW, g);
    const w = g.w;
    const h = units * g.u;
    const ports = o.layout || portLayout(type, side, units, w, { u: g.u });
    const psu = side === 'rear' && hasPower(type);
    let s = bodyShell(sc, w, h, units, g.u);
    // What the label must keep clear of on its line.
    let clear = w - EAR - 6;
    if (psu) {
      s += powerSupplies(sc, w, h, units, g);
      clear = psuX(w) - 6;
    }
    const fans = !ports.length && isSwitchType(type);
    // The tag goes below the name when the second unit is free, else beside it.
    const tagBelow = units >= 3 || (!ports.length && !fans);
    if (fans) {
      const top = units === 1 ? 3 : tagBelow ? 34 : g.u + 3;
      s += fanRow(sc, units === 1 ? DETAIL_X : LABEL_X + 4, clear - 4, top, h - 3);
      if (units === 1) clear = DETAIL_X - 4;
    }
    if (units === 1) {
      for (const p of ports) clear = Math.min(clear, p.x - 4);
      s += text(LABEL_X, h / 2 + 3.9, fitText(name, FONTS.name1, Math.max(10, clear - LABEL_X - 4), measure), FONTS.name1, sc.text);
    } else {
      const tag = `${type.tag} · ${units}U`;
      const max = clear - LABEL_X - 4;
      const nm = fitText(name, FONTS.name, max, measure);
      s += text(LABEL_X, 16, nm, FONTS.name, sc.text);
      const tagY = tagBelow ? 29 : 15.5;
      const tagX = tagBelow ? LABEL_X : LABEL_X + measure(nm, FONTS.name.css) + 8;
      if (clear - tagX > 24) s += text(tagX, tagY, fitText(tag, FONTS.tag, clear - tagX - 4, measure), FONTS.tag, sc.sub, ' letter-spacing="0.8"');
    }
    if (o.ports !== false) for (const p of ports) s += portShape(p, o.portColor ? o.portColor(p.name) : null, theme);
    return s + edgeLine(sc, w, h);
  }

  /** The face seen from the front of the rack: a device mounted back to front shows its rear. */
  function faceOf(type, name, sc, theme, measure, hU, extra, reversed) {
    return reversed && type.face !== 'reserved' ? sideFace(type, name, sc, theme, measure, hU, 'rear', extra) : deviceFace(type, name, sc, theme, measure, hU, extra);
  }

  // Side-mounted devices are drawn rotated so their label reads bottom to top.
  const placeTransform = (r) => (r.rotated ? `translate(${r1(r.x)} ${r1(r.y + r.h)}) rotate(-90)` : `translate(${r1(r.x)} ${r1(r.y)})`);

  // ------------------------------------------------------------ the sheet

  /** The perforation pattern device faces fill vents with (url(#rp-perf-<theme>)), to put in <defs>. */
  function perfPattern(theme) {
    const T = THEMES[theme] || THEMES.light;
    return `<pattern id="rp-perf-${theme}" width="4" height="4" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="0.9" fill="${T.perf}"/></pattern>`;
  }

  function defs(theme, T, lay) {
    const r0 = lay && lay.racks[0];
    const gx = r1((r0 ? r0.bayX : 0) % U);
    const gy = r1((lay ? lay.uBottom : 0) % U);
    return (
      `<defs>` +
      `<pattern id="rp-grid-${theme}" width="${U}" height="${U}" x="${gx}" y="${gy}" patternUnits="userSpaceOnUse">` +
      `<path d="M${U} 0H0V${U}" fill="none" stroke="${T.grid}" stroke-width="0.6"/></pattern>` +
      `<pattern id="rp-grid5-${theme}" width="${U * 5}" height="${U * 5}" x="${gx}" y="${gy}" patternUnits="userSpaceOnUse">` +
      `<path d="M${U * 5} 0H0V${U * 5}" fill="none" stroke="${T.gridMajor}" stroke-width="0.8"/></pattern>` +
      perfPattern(theme) +
      `</defs>`
    );
  }

  function rackHeader(r, st, T, o, measure) {
    const x = r.x;
    const y = r.headTop;
    const rack = r.rack;
    const statText = `${st.used + st.reserved}/${st.units} U · ${st.powerBudgetW ? `${kw(st.powerW)}/${kw(st.powerBudgetW)} kW` : formatPower(st.powerW)}`;
    const warn = st.overPower || st.overWeight;
    const statW = measure(statText + (warn ? ' !' : ''), FONTS.stat.css);
    const name = fitText(rack.name, FONTS.tape, Math.max(60, RACK_W - statW - 36), measure);
    const tw = measure(name, FONTS.tape.css) + 18;
    let s = `<g class="rack-head" data-rack="${esc(rack.id)}">`;
    if (o.interactive) s += `<rect x="${x}" y="${y - 4}" width="${RACK_W}" height="${HEADER - 4}" fill="#000" fill-opacity="0"/>`;
    s += `<rect x="${x + 1}" y="${y + 5}" width="${r1(tw)}" height="21" rx="1.5" fill="${T.tapeShade}"/>`;
    s += `<rect x="${x}" y="${y + 4}" width="${r1(tw)}" height="21" rx="1.5" fill="${T.tape}"/>`;
    s += text(x + 9, y + 18.5, name, FONTS.tape, T.tapeInk);
    s += text(x + RACK_W, y + 18.5, statText + (warn ? ' !' : ''), FONTS.stat, warn ? T.bad : T.ink2, ' text-anchor="end"');
    // Space bar (used, then reserved) and power bar.
    s += `<rect x="${x}" y="${y + 32}" width="${RACK_W}" height="4" rx="2" fill="${T.barTrack}"/>`;
    const usedW = (RACK_W * st.used) / st.units;
    const resW = (RACK_W * st.reserved) / st.units;
    if (st.used) s += `<rect x="${x}" y="${y + 32}" width="${r1(Math.max(4, usedW))}" height="4" rx="2" fill="${T.bar}"/>`;
    if (st.reserved) s += `<rect x="${r1(x + usedW)}" y="${y + 32}" width="${r1(Math.max(2, resW))}" height="4" fill="${T.barReserved}"/>`;
    if (st.powerBudgetW) {
      const p = Math.min(1, st.powerW / st.powerBudgetW);
      s += `<rect x="${x}" y="${y + 39}" width="${RACK_W}" height="3" rx="1.5" fill="${T.barTrack}"/>`;
      if (st.powerW) s += `<rect x="${x}" y="${y + 39}" width="${r1(Math.max(3, RACK_W * p))}" height="3" rx="1.5" fill="${st.overPower ? T.bad : T.power}"/>`;
    }
    if (o.interactive) {
      const lines = [
        `${rack.name} (${o.rackTypeName || `${st.units}U`})`,
        `${st.used} U used, ${st.reserved} U reserved, ${st.free} U free, side slots ${st.sideUsed}/${st.sideSlots}`,
        `Power ${formatPower(st.powerW)}${st.powerBudgetW ? ` of ${formatPower(st.powerBudgetW)}` : ''}${st.overPower ? ' (over budget)' : ''}`,
        `Weight ${Math.round(st.weightKg)} kg${st.weightBudgetKg ? ` of ${st.weightBudgetKg} kg` : ''}${st.overWeight ? ' (over the limit)' : ''}`,
      ];
      s += `<title>${esc(lines.join('\n'))}</title>`;
    }
    return s + `</g>`;
  }

  function rackBody(r, T, lay) {
    const x = r.x;
    const bx = r.bayX;
    const lx = x + FRAME;
    const rx = bx + BAY_W;
    const sx = r.sideX;
    const uTop = r.uTop;
    const uBottom = lay.uBottom;
    let s = '';
    // Frame and feet.
    s += `<rect x="${x + 10}" y="${lay.rackBottom}" width="42" height="${PLINTH}" rx="1.5" fill="${T.frameHi}"/>`;
    s += `<rect x="${x + RACK_W - 52}" y="${lay.rackBottom}" width="42" height="${PLINTH}" rx="1.5" fill="${T.frameHi}"/>`;
    s += `<rect x="${x}" y="${r.rackTop}" width="${RACK_W}" height="${lay.rackBottom - r.rackTop}" rx="3" fill="${T.frame}"/>`;
    s += `<rect x="${x + 3}" y="${r.rackTop + 3}" width="${RACK_W - 6}" height="2" rx="1" fill="${T.frameHi}"/>`;
    // Rails.
    s += `<rect x="${lx}" y="${uTop}" width="${RAIL}" height="${r.uh}" fill="${T.rail}"/>`;
    s += `<rect x="${rx}" y="${uTop}" width="${RAIL}" height="${r.uh}" fill="${T.rail}"/>`;
    // Unit slots, alternating shade; U1 sits at the top.
    let slotsA = '';
    let slotsB = '';
    let holes = '';
    let ticks = '';
    let nums = '';
    for (let u = 1; u <= r.units; u++) {
      const y = uTop + (u - 1) * U;
      if (u % 2) slotsA += rectPath(bx, y, BAY_W, U);
      else slotsB += rectPath(bx, y, BAY_W, U);
      for (const hy of [3, 8.5, 14]) holes += rectPath(lx + RAIL - 7, y + hy, 4, 3) + rectPath(rx + 3, y + hy, 4, 3);
      ticks += `M${lx} ${y + U - 0.5}h${u % 5 === 0 ? 9 : 5}`;
      nums += text(lx + 13, y + 13.5, String(u), FONTS.rail, T.railText, ' text-anchor="end"');
    }
    s += `<path d="${slotsA}" fill="${T.slotA}"/><path d="${slotsB}" fill="${T.slotB}"/>`;
    s += `<path d="${holes}" fill="${T.hole}"/><path d="${ticks}" stroke="${T.railTick}"/>`;
    s += nums;
    // Vertical side channel with cable fingers and the side slots.
    s += `<rect x="${sx}" y="${uTop}" width="${SIDE_W}" height="${r.uh}" fill="${T.channel}"/>`;
    let fingers = '';
    for (let y = uTop + 6; y < uBottom - 10; y += 2 * U) fingers += rectPath(sx + SIDE_W - 7, y, 5, 9);
    s += `<path d="${fingers}" fill="${T.finger}"/>`;
    for (let k = 0; k < r.slots; k++) {
      const sr = slotRect(r, k);
      s += `<rect x="${r1(sr.x)}" y="${r1(sr.y)}" width="${SLOT_W}" height="${SLOT_H}" rx="1.5" fill="${T.channelSlot}"/>`;
      s += `<rect x="${r1(sr.x + 0.5)}" y="${r1(sr.y + 0.5)}" width="${SLOT_W - 1}" height="${SLOT_H - 1}" rx="1.5" fill="none" stroke="${T.slotDash}" stroke-dasharray="3 2.5"/>`;
      const cx = r1(sr.x + SLOT_W / 2 + 3.2);
      const cy = r1(sr.y + SLOT_H / 2);
      s += text(cx, cy, `SIDE V${k + 1} · 1U`, FONTS.rail, T.ink3, ` transform="rotate(-90 ${cx} ${cy})" text-anchor="middle" letter-spacing="1"`);
    }
    return s;
  }

  function deviceNode(project, d, r, T, theme, o, measure) {
    const type = M.typeOf(project, d.type);
    const cluster = M.clusterById(project, d.cluster);
    const sc = schemeFor(cluster ? cluster.color : null, theme);
    const hU = M.deviceHeight(project, d);
    const rect = rectIn(r, d.loc, hU);
    const dim = o.highlight && !o.highlight(d);
    const cls = ['dev'];
    if (o.dragging && o.dragging.has(d.id)) cls.push('is-dragging');
    if (o.selected && o.selected.has(d.id)) cls.push('is-selected');
    if (type.variable) cls.push('is-reserved');
    let s = `<g class="${cls.join(' ')}" data-id="${esc(d.id)}" transform="${placeTransform(rect)}"${dim ? ' opacity="0.2"' : ''}`;
    if (o.interactive) {
      const where = M.formatDeviceLoc(project, d);
      const label = `${d.name}, ${type.label}, ${where}${cluster ? `, cluster ${cluster.name}` : ''}`;
      s += ` tabindex="0" role="button" aria-label="${esc(label)}">`;
      const lines = [d.name, `${type.label} (${hU}U)`, where];
      if (cluster) lines.push(`Cluster: ${cluster.name}`);
      const power = M.powerOf(project, d);
      if (power) lines.push(`Power: ${formatPower(power)}`);
      for (const f of M.FIELDS) if (d[f.key]) lines.push(`${f.label}: ${d[f.key]}`);
      s += `<title>${esc(lines.join('\n'))}</title>`;
    } else s += '>';
    s += faceOf(type, d.name, sc, theme, measure, hU, { color: cluster ? cluster.color : null, powerW: type.variable ? M.powerOf(project, d) : 0 }, d.reversed);
    if (o.interactive) {
      const w = rect.rotated ? rect.h : rect.w;
      const h = rect.rotated ? rect.w : rect.h;
      s += `<rect class="dev-hl" x="-1.5" y="-1.5" width="${w + 3}" height="${h + 3}" rx="3" fill="none" stroke="${T.ink}" stroke-width="1.5"/>`;
    }
    return s + '</g>';
  }

  /** CAD-style selection: dashed outline with yellow corner handles. */
  function selectionMarks(x, y, w, h, T) {
    const pad = 3.5;
    const X = x - pad;
    const Y = y - pad;
    const W = w + pad * 2;
    const H = h + pad * 2;
    let s = `<g class="sel-marks" pointer-events="none">`;
    s += `<rect x="${r1(X)}" y="${r1(Y)}" width="${r1(W)}" height="${r1(H)}" rx="2" fill="none" stroke="${T.select}" stroke-width="1.5" stroke-dasharray="5 3"/>`;
    for (const [hx, hy] of [[X, Y], [X + W, Y], [X, Y + H], [X + W, Y + H]]) {
      s += `<rect x="${r1(hx - 3.5)}" y="${r1(hy - 3.5)}" width="7" height="7" fill="${T.handle}" stroke="${T.select}" stroke-width="1.2"/>`;
    }
    return s + '</g>';
  }

  function addRackSlot(lay, T) {
    const a = lay.addSlot;
    const cx = a.x + a.w / 2;
    const cy = lay.uBottom - Math.min(lay.maxUnits * U, 400) / 2;
    return (
      `<g class="add-rack" tabindex="0" role="button" aria-label="Add a rack to ${esc(lay.row.name)}">` +
      `<title>Add a rack at the end of ${esc(lay.row.name)}</title>` +
      `<rect x="${a.x + 0.75}" y="${a.y + 0.75}" width="${a.w - 1.5}" height="${a.h - 1.5}" rx="3" fill="${T.paper}" fill-opacity="0.6" stroke="${T.ink3}" stroke-width="1.5" stroke-dasharray="6 4"/>` +
      `<circle cx="${cx}" cy="${cy - 14}" r="15" fill="none" stroke="${T.ink2}" stroke-width="1.5"/>` +
      `<path d="M${cx - 7} ${cy - 14}h14M${cx} ${cy - 21}v14" stroke="${T.ink2}" stroke-width="1.8" stroke-linecap="round"/>` +
      text(cx, cy + 20, 'Add rack', FONTS.legend, T.ink2, ' text-anchor="middle"') +
      `</g>`
    );
  }

  /**
   * Lays out the cluster legend (clusters with devices in this row) beside
   * the title block, or above it when the sheet is too narrow for both.
   */
  function legendLayout(project, lay, rowDevices, measure) {
    const counts = new Map();
    let unassigned = 0;
    for (const d of rowDevices) {
      if (d.type === M.RESERVED.id) continue;
      if (d.cluster && M.clusterById(project, d.cluster)) counts.set(d.cluster, (counts.get(d.cluster) || 0) + 1);
      else unassigned++;
    }
    const items = project.clusters.filter((c) => counts.has(c.id)).map((c) => ({ name: c.name, color: c.color, count: counts.get(c.id) }));
    if (unassigned) items.push({ name: 'Unassigned', color: null, count: unassigned });
    const width = lay.width;
    const inner = width - MX * 2;
    const stacked = inner - TITLE_W - 40 < 240;
    const maxW = stacked ? inner : inner - TITLE_W - 40;
    let x = 0;
    let row = 0;
    for (const it of items) {
      it.label = fitText(it.name, FONTS.legend, 200, measure);
      it.w = 20 + measure(it.label, FONTS.legend.css) + 8 + measure(String(it.count), FONTS.stat.css) + 26;
      if (x > 0 && x + it.w > maxW) {
        x = 0;
        row++;
      }
      it.x = x;
      it.row = row;
      x += it.w;
    }
    const rows = items.length ? row + 1 : 1;
    const legendH = 20 + rows * 22;
    return {
      items,
      width,
      titleY: stacked ? lay.footTop + legendH + 14 : lay.footTop,
      height: stacked ? legendH + 14 + TITLE_H : Math.max(TITLE_H, legendH),
    };
  }

  function footer(project, lay, leg, T, theme, o, measure) {
    let s = '';
    const y0 = lay.footTop;
    s += text(MX, y0 + 9, 'CLUSTERS', FONTS.tag, T.ink3, ' letter-spacing="1.2"');
    if (!leg.items.length) s += text(MX, y0 + 31, 'No devices placed yet', FONTS.legend, T.ink3);
    for (const it of leg.items) {
      const x = MX + it.x;
      const y = y0 + 20 + it.row * 22;
      const sc = schemeFor(it.color, theme);
      s += `<rect x="${r1(x)}" y="${y + 2}" width="14" height="12" rx="2" fill="${sc.ear}" stroke="${sc.edge}"/>`;
      s += `<text x="${r1(x + 20)}" y="${y + 12}" font-family="${FONTS.legend.family}" font-size="${FONTS.legend.size}" font-weight="${FONTS.legend.weight}" fill="${T.ink}">${esc(it.label)}<tspan dx="7" font-family="${FONTS.stat.family}" font-size="${FONTS.stat.size}" fill="${T.ink3}">${it.count}</tspan></text>`;
    }

    // Title block in the lower right corner, like a drawing sheet.
    const x = leg.width - MX - TITLE_W;
    const y = leg.titleY;
    const c1 = 226;
    const info = project.info || {};
    const cellW = c1 - 14;
    const rightW = TITLE_W - c1 - 14;
    s += `<rect x="${x + 0.5}" y="${y + 0.5}" width="${TITLE_W - 1}" height="${TITLE_H - 1}" fill="${T.paper}" stroke="${T.ink2}"/>`;
    s += `<path d="M${x + c1 + 0.5} ${y}v94M${x} ${y + 34.5}h${TITLE_W}M${x} ${y + 64.5}h${TITLE_W}M${x} ${y + 94.5}h${TITLE_W}" stroke="${T.ink2}" stroke-width="0.7"/>`;
    const cap = (cx, cy, str) => text(cx, cy, str, FONTS.cap, T.ink3, ' letter-spacing="1"');
    const val = (cx, cy, str, max) => text(cx, cy, fitText(str, FONTS.stat, max, measure), FONTS.stat, T.ink);
    s += cap(x + 7, y + 10, 'RACK PLAN');
    s += text(x + 7, y + 28, fitText(project.name, FONTS.title, cellW, measure), FONTS.title, T.ink);
    s += cap(x + c1 + 7, y + 10, 'DATE');
    s += val(x + c1 + 7, y + 26, o.date || '', rightW);
    s += cap(x + 7, y + 44, 'LOCATION');
    s += val(x + 7, y + 58, [info.site, lay.floor.name, lay.row.name].filter(Boolean).join(' · '), cellW);
    s += cap(x + c1 + 7, y + 44, 'REVISION');
    s += val(x + c1 + 7, y + 58, info.revision || '–', rightW);
    s += cap(x + 7, y + 74, 'DRAWN BY');
    s += val(x + 7, y + 88, info.author || '–', cellW);
    s += cap(x + c1 + 7, y + 74, 'SHEET');
    s += val(x + c1 + 7, y + 88, o.sheet ? `${o.sheet.index + 1} / ${o.sheet.count}` : '1 / 1', rightW);
    const n = lay.racks.length;
    const heights = [...new Set(lay.racks.map((r) => r.units))].sort((a, b) => b - a).join('/');
    s += text(x + 7, y + 106.5, fitText(`${M.plural(n, 'rack')} · 19″ · ${heights}U · 1U = 44.45 mm`, FONTS.small, TITLE_W - 14, measure), FONTS.small, T.ink2);
    return s;
  }

  /**
   * Renders the sheet of one row. Options:
   *   rowId (default: the first row), theme: 'light' | 'dark',
   *   interactive: adds focus/hover hooks and the add-rack slot,
   *   selected: Set of device ids, selectedRack, highlight(device) → bool
   *   (others are dimmed), dragging: Set of device ids, date,
   *   sheet: { index, count }, measure(text, cssFont) → px
   */
  function renderScene(project, opts) {
    const o = opts || {};
    const theme = o.theme === 'dark' ? 'dark' : 'light';
    const T = THEMES[theme];
    const measure = o.measure || approxMeasure;
    const lay = rowLayout(project, o.rowId, o.interactive && o.addRack !== false);
    const stats = M.statsByRack(project);
    const byRack = M.devicesByRack(project);
    const rowDevices = [];
    for (const r of lay.racks) rowDevices.push(...(byRack.get(r.rack.id) || []));
    const leg = legendLayout(project, lay, rowDevices, measure);
    const width = lay.width;
    const height = Math.round(lay.footTop + leg.height + 30);
    let s = defs(theme, T, lay);
    s += `<rect class="sheet" width="${width}" height="${height}" fill="${T.paper}"/>`;
    s += `<rect width="${width}" height="${height}" fill="url(#rp-grid-${theme})" pointer-events="none"/>`;
    s += `<rect width="${width}" height="${height}" fill="url(#rp-grid5-${theme})" pointer-events="none"/>`;
    s += `<rect x="10.5" y="10.5" width="${width - 21}" height="${height - 21}" fill="none" stroke="${T.border}" pointer-events="none"/>`;

    for (const r of lay.racks) {
      const rt = M.rackTypeOf(project, r.rack);
      s += `<g class="rack" data-rack="${esc(r.rack.id)}">`;
      s += rackHeader(r, stats.get(r.rack.id), T, Object.assign({}, o, { rackTypeName: rt.name }), measure);
      s += rackBody(r, T, lay);
      const devs = (byRack.get(r.rack.id) || []).slice().sort((a, b) => (a.loc.kind === b.loc.kind ? a.loc.at - b.loc.at : a.loc.kind === 'u' ? -1 : 1));
      for (const d of devs) s += deviceNode(project, d, r, T, theme, o, measure);
      s += '</g>';
    }
    if (lay.addSlot) s += addRackSlot(lay, T);
    s += footer(project, lay, leg, T, theme, o, measure);

    if (o.selectedRack && lay.byId.has(o.selectedRack)) {
      const r = lay.byId.get(o.selectedRack);
      s += selectionMarks(r.x, r.rackTop, RACK_W, lay.rackBottom - r.rackTop, T);
    }
    if (o.selected) {
      for (const d of rowDevices) {
        if (!o.selected.has(d.id)) continue;
        const rect = rectIn(lay.byId.get(d.loc.rack), d.loc, M.deviceHeight(project, d));
        s += selectionMarks(rect.x, rect.y, rect.w, rect.h, T);
      }
    }
    return { width, height, body: s, layout: lay };
  }

  /**
   * Translucent preview of devices at their target places, outlined green
   * (fits) or red. `items`: [{ typeId, loc, height, name, color, reversed }].
   */
  function renderGhosts(project, items, ok, opts) {
    const o = opts || {};
    const theme = o.theme === 'dark' ? 'dark' : 'light';
    const T = THEMES[theme];
    const measure = o.measure || approxMeasure;
    const color = ok ? T.ok : T.bad;
    let s = `<g pointer-events="none">`;
    for (const it of items) {
      const r = locRect(project, it.loc, it.typeId, it.height, o.layout);
      if (!r || (o.rowId && M.locateRack(project, it.loc.rack).row.id !== o.rowId)) continue;
      const type = M.typeOf(project, it.typeId);
      const hU = M.heightOf(project, it.typeId, it.height);
      const sc = schemeFor(it.color || null, theme);
      // A device taller than 1U cannot be drawn into a side slot; only mark the slot.
      if (!(it.loc.kind === 'side' && hU !== 1)) {
        s += `<g transform="${placeTransform(r)}" opacity="${ok ? 0.92 : 0.55}">${faceOf(type, it.name || type.label, sc, theme, measure, hU, { color: it.color }, it.reversed)}</g>`;
      }
      if (!ok) s += `<rect x="${r1(r.x)}" y="${r1(r.y)}" width="${r.w}" height="${r.h}" fill="${T.bad}" fill-opacity="0.18"/>`;
      s += `<rect x="${r1(r.x - 1.5)}" y="${r1(r.y - 1.5)}" width="${r.w + 3}" height="${r.h + 3}" rx="2.5" fill="none" stroke="${color}" stroke-width="2"/>`;
    }
    return s + '</g>';
  }

  /** One device's ghost: opts as renderGhosts, plus height, name, color and reversed of the device. */
  function renderGhost(project, typeId, loc, ok, opts) {
    const o = opts || {};
    return renderGhosts(project, [{ typeId, loc, height: o.height, name: o.name, color: o.color, reversed: o.reversed }], ok, o);
  }

  /**
   * Maps a sheet coordinate on the sheet of `rowId` to a drop location for a
   * device of `typeId`. `grab` is the distance in px from the device's top
   * edge to the pointer.
   */
  function locateDrop(project, rowId, typeId, x, y, grab, height) {
    if (!M.typeOf(project, typeId)) return null;
    const lay = rowLayout(project, rowId);
    const hU = M.heightOf(project, typeId, height);
    if (y < lay.top - HEADER - 40 || y > lay.rackBottom + 60) return null;
    for (const r of lay.racks) {
      if (x < r.x - GAP / 2 || x >= r.x + RACK_W + GAP / 2) continue;
      const rack = r.rack.id;
      if (x >= r.sideX - 2 && r.slots) {
        const k = Math.max(0, Math.min(r.slots - 1, Math.floor(((y - r.uTop) * r.slots) / r.uh)));
        return { rack, kind: 'side', at: k };
      }
      const top = Math.round((y - grab - r.uTop) / U);
      const t = Math.max(0, Math.min(r.units - hU, top));
      return { rack, kind: 'u', at: t + 1 };
    }
    return null;
  }

  /**
   * Small standalone drawing of a device type for the parts bin and dialogs:
   * its front, or with `side` 'rear' its rear with power supplies and ports
   * (with 'front', the ports of the front are drawn too).
   */
  function renderPreview(type, theme, color, name, measure, height, side) {
    const th = theme === 'dark' ? 'dark' : 'light';
    const hU = type.variable ? height || 2 : type.height;
    const sc = schemeFor(color || null, th);
    const m = measure || approxMeasure;
    const label = name || type.label;
    const plainFront = side !== 'rear' && (side !== 'front' || !M.expandPorts(type).some((p) => p.side === 'front'));
    return {
      width: BAY_W,
      height: hU * U,
      body: defs(th, THEMES[th]) + (plainFront ? deviceFace(type, label, sc, th, m, hU, { color }) : sideFace(type, label, sc, th, m, hU, side, { color })),
    };
  }

  /**
   * Complete standalone SVG document (light theme) of one row. Exported
   * files cannot load the page's web fonts (a PNG is rasterised from an
   * <img>, an .svg is opened elsewhere), so text is set and measured in the
   * fallback fonts to keep labels inside their boxes.
   */
  function exportSVG(project, opts) {
    const measure = opts && opts.measure;
    const o = Object.assign({}, opts, {
      theme: 'light',
      interactive: false,
      selected: null,
      selectedRack: null,
      highlight: null,
      dragging: null,
      measure: measure ? (t, css) => measure(t, withoutWebFonts(css)) : undefined,
    });
    const sc = renderScene(project, o);
    const body = sc.body.replace(/font-family="([^"]*)"/g, (m, stack) => `font-family="${withoutWebFonts(stack)}"`);
    const where = `${sc.layout.floor.name} · ${sc.layout.row.name}`;
    return (
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="${sc.width}" height="${sc.height}" viewBox="0 0 ${sc.width} ${sc.height}">` +
      `<title>${esc(project.name)} · ${esc(where)}</title>${body}</svg>`
    );
  }

  // Canvas limits browsers share: a side of 32767 px and 16384² px in all.
  const CANVAS_SIDE = 32767;
  const CANVAS_AREA = 16384 * 16384;
  /**
   * The scale to raster a drawing of w × h px at for a PNG: `want` (2 by
   * default, for sharp text), less where the canvas would be larger than
   * browsers allow; null when even 1 is too large (export an SVG instead).
   */
  function pngScale(w, h, want) {
    const s = Math.min(want || 2, CANVAS_SIDE / w, CANVAS_SIDE / h, Math.sqrt(CANVAS_AREA / (w * h)));
    return s >= 1 ? Math.floor(s * 1000) / 1000 : null;
  }

  return {
    geometry: { U, BAY_W, RACK_W, RAIL, FRAME, GAP, MX, SLOT_W, SLOT_H, HEADER, ADD_W, EAR, LABEL_X, DETAIL_X },
    esc,
    r1,
    text,
    approxMeasure,
    perfPattern,
    deviceFace,
    sideFace,
    portLayout,
    portShape,
    isSwitchType,
    sheetWidth,
    rowLayout,
    locRect,
    THEMES,
    FONTS,
    mix,
    contrast,
    inkOn,
    schemeFor,
    fitText,
    formatPower,
    renderScene,
    renderGhost,
    renderGhosts,
    renderPreview,
    locateDrop,
    exportSVG,
    pngScale,
    withoutWebFonts,
  };
});
