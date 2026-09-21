// Isometric ("3D-ish") drawings of a rack area and of the warehouse floor, as plain SVG strings —
// no DOM, no Supabase, same convention as the other modules: index.html decides where the markup
// goes and wires the clicks. Purpose: show WHERE a bin is instead of making someone decode
// "A 3-2 2-1" against a flat Depth x Level grid — the rack is drawn semi-transparent, and the bin
// being looked for is one solid blue box with its coordinates on a label.
//
// Axes (all lengths in centimetres):
//   x — along the run, "bin" direction, left to right facing the rack (Bin 1 at x = 0)
//   y — depth away from the walkway: Depth 1 (front rack) is at y = 0, Depth 2 behind it, ...
//   z — height: Level 1 is the shelf closest to the floor
// The viewer stands in front of the rack at its right-hand end, looking slightly down, so what's
// visible is the front face (the walkway side), the right-hand end face, and the top.
//
// Dimensions come from a warehouse_zones row (all optional, all cm): rack_width_cm (one bay),
// rack_depth_cm, rack_height_cm; shelf_width_cm, shelf_depth_cm, shelf_height_cm (the CLEAR
// height of one level, board top to the underside of the next); bin_width_cm, bin_depth_cm,
// bin_height_cm. Anything not recorded falls back to a schematic default so the drawing still
// reads; resolveRackGeometry() reports which values were actually recorded, so a caller can tell
// a measured 120 cm from a placeholder one.
//
// STATUS: wired in, via the <script type="module"> bridge near the end of index.html
// (window.resolveRackGeometry / buildIsoRackSVG / buildIsoFloorSVG). Used by the Settings-gated
// "Isometric bin locator" (an item's Bin Location Map and the Bin Locator — renderBinLocationIso()
// / renderBinLocatorIso()) and by the Warehouse page's "Dimensions & 3D View" panel
// (renderDimPreview()).

const COS30 = Math.cos(Math.PI / 6);
const SIN30 = 0.5;

export const ISO_DEFAULTS = Object.freeze({ binW: 40, rackD: 60, clear: 42, boardT: 3, gap: 8 });
export const ISO_BLUE = Object.freeze({ front: '#2563eb', side: '#1d4ed8', top: '#60a5fa' });

const MAX_ROWS_PER_SHELF = 6;
const MAX_DRAWN_BINS = 2500; // beyond this the empty-bin outlines are skipped, board outlines and any occupied/selected bin still are drawn

function num(v) {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) && n > 0 ? n : null;
}
const clamp = (lo, hi, v) => Math.min(hi, Math.max(lo, v));
const f1 = (n) => Math.round(n * 10) / 10;
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const P = (x, y, z) => [(x + y) * COS30, (x - y) * SIN30 - z];

// Same shape index.html's own bin codes use: "Zone Depth-Level Bin-Row", e.g. "A 3-2 3-1" — the
// warehouse's own paper notation, Row always written.
export function formatLocationCode(zone, depth, level, bin, row = 1) {
  return `${zone} ${depth}-${level} ${bin}-${row || 1}`;
}

// bounds: { maxDepth, maxLevel, maxBin } as index.html's getZoneBounds() returns; extra: { minBin, minRows }
// so a bin further along (or a Row further back) than the configured size still fits in the picture.
export function resolveRackGeometry(zone, bounds, extra = {}) {
  const z = zone || {};
  const b = bounds || {};
  const levels = Math.max(1, Math.floor(b.maxLevel || 1));
  const depthCount = Math.max(1, Math.floor(b.maxDepth || 1));
  const binsPerLevel = Math.max(1, Math.floor(Math.max(b.maxBin || 1, extra.minBin || 1)));
  const bays = Math.max(1, Math.floor(z.max_aisle || 1));

  const rec = {
    rackW: num(z.rack_width_cm), rackD: num(z.rack_depth_cm), rackH: num(z.rack_height_cm),
    shelfW: num(z.shelf_width_cm), shelfD: num(z.shelf_depth_cm), shelfH: num(z.shelf_height_cm),
    binW: num(z.bin_width_cm), binD: num(z.bin_depth_cm), binH: num(z.bin_height_cm),
  };

  const bayWRec = rec.rackW || rec.shelfW;
  const runLength = bayWRec ? bays * bayWRec : binsPerLevel * (rec.binW || ISO_DEFAULTS.binW);
  const bayW = runLength / bays;
  const cellW = runLength / binsPerLevel;

  const rackDRec = rec.rackD || rec.shelfD;
  const rows = clamp(1, MAX_ROWS_PER_SHELF, Math.max(Math.floor(extra.minRows || 1),
    (rec.binD && rackDRec) ? Math.floor(rackDRec / rec.binD) : 1));
  const rackD = rackDRec || (rec.binD ? rec.binD * rows : ISO_DEFAULTS.rackD);
  const gap = ISO_DEFAULTS.gap;
  const totalDepth = depthCount * rackD + (depthCount - 1) * gap;

  const boardT = ISO_DEFAULTS.boardT;
  const clear = rec.shelfH
    || (rec.rackH ? Math.max(5, (rec.rackH - boardT) / levels - boardT) : null)
    || (rec.binH ? rec.binH + 8 : ISO_DEFAULTS.clear);
  const pitch = clear + boardT;
  const height = levels * pitch + boardT;
  const binH = clamp(2, Math.max(2, clear - 1), rec.binH || clear * 0.7);
  const binD = rackD / rows;
  // The size a bin is DRAWN at: what was recorded, but never larger than the cell it sits in (a bin
  // that's wider than its share of the shelf is a data problem the panel flags, not something to
  // draw overlapping its neighbour); with nothing recorded it fills its cell.
  const binDrawW = rec.binW ? Math.min(rec.binW, cellW) : cellW;
  const binDrawD = rec.binD ? Math.min(rec.binD, binD) : binD;

  return {
    zone: z.zone || '', bays, depthCount, levels, binsPerLevel, rows,
    bayW, runLength, cellW, rackD, gap, totalDepth, boardT, clear, pitch, height, binH,
    binD, binDrawW, binDrawD,
    recorded: rec,
    // Only what the picture was actually built from — a caller can flag a mismatch between the
    // height implied by levels x shelf height and a separately entered rack height.
    impliedHeight: height,
  };
}

// ── tiny scene builder shared by the rack and floor renderers ─────────────────────────────────
function makeScene(fs) {
  const els = [];
  const bb = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const addPt = (p) => { bb.minX = Math.min(bb.minX, p[0]); bb.maxX = Math.max(bb.maxX, p[0]); bb.minY = Math.min(bb.minY, p[1]); bb.maxY = Math.max(bb.maxY, p[1]); };
  const addRect = (cx, cy, w, h) => { addPt([cx - w / 2, cy - h / 2]); addPt([cx + w / 2, cy + h / 2]); };
  const pts = (arr) => arr.map((p) => `${f1(p[0])},${f1(p[1])}`).join(' ');
  return {
    els, bb, fs, addPt, addRect,
    poly(cls, corners3, attrs = '', title = '') {
      const pp = corners3.map((c) => P(c[0], c[1], c[2]));
      pp.forEach(addPt);
      els.push(`<polygon class="${cls}" points="${pts(pp)}"${attrs}>${title ? `<title>${esc(title)}</title>` : ''}</polygon>`);
    },
    line(cls, a3, b3) {
      const a = P(a3[0], a3[1], a3[2]), b = P(b3[0], b3[1], b3[2]);
      addPt(a); addPt(b);
      els.push(`<line class="${cls}" x1="${f1(a[0])}" y1="${f1(a[1])}" x2="${f1(b[0])}" y2="${f1(b[1])}"/>`);
    },
    // box faces, in the three orientations that face the viewer: front (-y side), right end (+x side), top
    box(clsFront, clsSide, clsTop, x0, y0, z0, x1, y1, z1, attrs = '') {
      this.poly(clsFront, [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], attrs);
      this.poly(clsSide, [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], attrs);
      this.poly(clsTop, [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], attrs);
    },
    // a label pill on a leader line, lifted above an anchor point (screen coords), clamped into [minX, maxX]
    pill(anchor, text, lift, clampMinX, clampMaxX, cls = 'iso-pill', textCls = 'iso-pill-text') {
      const w = String(text).length * fs * 0.62 + fs * 1.5;
      const h = fs * 1.9;
      let cx = anchor[0];
      if (Number.isFinite(clampMinX) && Number.isFinite(clampMaxX) && clampMaxX - clampMinX > w) cx = clamp(clampMinX + w / 2, clampMaxX - w / 2, cx);
      const cy = anchor[1] - lift;
      addRect(cx, cy, w, h); addPt(anchor);
      els.push(`<line class="iso-leader" x1="${f1(anchor[0])}" y1="${f1(anchor[1])}" x2="${f1(cx)}" y2="${f1(cy + h / 2)}"/>`);
      els.push(`<rect class="${cls}" x="${f1(cx - w / 2)}" y="${f1(cy - h / 2)}" width="${f1(w)}" height="${f1(h)}" rx="${f1(h / 2)}"/>`);
      els.push(`<text class="${textCls}" x="${f1(cx)}" y="${f1(cy)}" font-size="${f1(fs)}" text-anchor="middle" dominant-baseline="central">${esc(text)}</text>`);
    },
    // a dimension line between two 3D points, pushed out by an offset vector, with ticks and a label
    dim(a3, b3, off3, text, dashed = false) {
      const A = P(a3[0], a3[1], a3[2]), B = P(b3[0], b3[1], b3[2]);
      const A2 = P(a3[0] + off3[0], a3[1] + off3[1], a3[2] + off3[2]);
      const B2 = P(b3[0] + off3[0], b3[1] + off3[1], b3[2] + off3[2]);
      [A, B, A2, B2].forEach(addPt);
      const seg = (cls, p, q) => els.push(`<line class="${cls}" x1="${f1(p[0])}" y1="${f1(p[1])}" x2="${f1(q[0])}" y2="${f1(q[1])}"/>`);
      seg('iso-dim iso-dim-ext', A, A2); seg('iso-dim iso-dim-ext', B, B2);
      seg(`iso-dim${dashed ? ' iso-dim-dash' : ''}`, A2, B2);
      const dx = B2[0] - A2[0], dy = B2[1] - A2[1];
      const len = Math.hypot(dx, dy) || 1;
      const px = (-dy / len) * fs * 0.4, py = (dx / len) * fs * 0.4;
      seg('iso-dim', [A2[0] - px, A2[1] - py], [A2[0] + px, A2[1] + py]);
      seg('iso-dim', [B2[0] - px, B2[1] - py], [B2[0] + px, B2[1] + py]);
      const ox = A2[0] - A[0], oy = A2[1] - A[1], olen = Math.hypot(ox, oy) || 1;
      const mx = (A2[0] + B2[0]) / 2 + (ox / olen) * fs * 0.9;
      const my = (A2[1] + B2[1]) / 2 + (oy / olen) * fs * 0.9;
      const w = String(text).length * fs * 0.58;
      addRect(mx, my, w, fs);
      els.push(`<text class="iso-dim-text" x="${f1(mx)}" y="${f1(my)}" font-size="${f1(fs * 0.85)}" text-anchor="middle" dominant-baseline="central">${esc(text)}</text>`);
    },
  };
}

// Drawn with CSS variables so it follows light/dark theme; the rack is deliberately see-through
// (low fill opacity everywhere) and the located bin is the only fully opaque thing in the picture.
const STYLE = `<style>
.iso-floor{fill:var(--border);fill-opacity:.3}
.iso-grid{stroke:var(--text-muted);stroke-opacity:.18;stroke-width:1;vector-effect:non-scaling-stroke;fill:none}
.iso-post{stroke:var(--text-muted);stroke-opacity:.5;stroke-width:2;vector-effect:non-scaling-stroke;fill:none}
.iso-board-top{fill:var(--card-bg);fill-opacity:.32;stroke:var(--text-muted);stroke-opacity:.45;stroke-width:1;vector-effect:non-scaling-stroke}
.iso-board-front{fill:var(--text-muted);fill-opacity:.3;stroke:var(--text-muted);stroke-opacity:.45;stroke-width:1;vector-effect:non-scaling-stroke}
.iso-board-side{fill:var(--text-muted);fill-opacity:.42;stroke:var(--text-muted);stroke-opacity:.45;stroke-width:1;vector-effect:non-scaling-stroke}
.iso-bin{fill:var(--card-bg);fill-opacity:.14;stroke:var(--text-muted);stroke-opacity:.3;stroke-width:1;vector-effect:non-scaling-stroke}
.iso-bin-occupied{fill:var(--primary);fill-opacity:.3;stroke:var(--primary);stroke-opacity:.6}
.iso-shelf-selected{fill:var(--primary);fill-opacity:.16;stroke:var(--primary);stroke-opacity:.85;stroke-width:1.5}
.iso-click{cursor:pointer}
.iso-click:hover{fill:var(--primary);fill-opacity:.38}
.iso-hl-overlay{filter:drop-shadow(0 0 5px rgba(37,99,235,.8))}
.iso-hl-front{fill:${ISO_BLUE.front};stroke:#fff;stroke-width:1.2;vector-effect:non-scaling-stroke}
.iso-hl-side{fill:${ISO_BLUE.side};stroke:#fff;stroke-width:1.2;vector-effect:non-scaling-stroke}
.iso-hl-top{fill:${ISO_BLUE.top};stroke:#fff;stroke-width:1.2;vector-effect:non-scaling-stroke}
.iso-hl-over{fill-opacity:.62;stroke-opacity:.7}
.iso-leader{stroke:${ISO_BLUE.front};stroke-width:1.5;vector-effect:non-scaling-stroke}
.iso-pill{fill:${ISO_BLUE.front};stroke:#fff;stroke-width:1.2;vector-effect:non-scaling-stroke}
.iso-pill-text{fill:#fff;font-family:system-ui,-apple-system,sans-serif;font-weight:700}
.iso-tag{fill:var(--card-bg);stroke:var(--text-muted);stroke-width:1;vector-effect:non-scaling-stroke}
.iso-tag-text{fill:var(--text-main);font-family:system-ui,-apple-system,sans-serif;font-weight:700}
.iso-dim{stroke:var(--text-main);stroke-opacity:.75;stroke-width:1;fill:none;vector-effect:non-scaling-stroke}
.iso-dim-ext{stroke-opacity:.35;stroke-dasharray:3 3}
.iso-dim-dash{stroke-dasharray:5 4;stroke-opacity:.5}
.iso-dim-text{fill:var(--text-main);font-family:system-ui,-apple-system,sans-serif;font-weight:600;paint-order:stroke;stroke:var(--card-bg);stroke-width:3px;stroke-linejoin:round}
.iso-zone-front{fill:var(--text-muted);fill-opacity:.12;stroke:var(--text-muted);stroke-opacity:.5;stroke-width:1;vector-effect:non-scaling-stroke}
.iso-zone-side{fill:var(--text-muted);fill-opacity:.2;stroke:var(--text-muted);stroke-opacity:.5;stroke-width:1;vector-effect:non-scaling-stroke}
.iso-zone-top{fill:var(--card-bg);fill-opacity:.28;stroke:var(--text-muted);stroke-opacity:.5;stroke-width:1;vector-effect:non-scaling-stroke}
.iso-zone-selected{stroke:var(--primary);stroke-opacity:1;stroke-width:2}
.iso-zone-label{fill:var(--text-main);font-family:system-ui,-apple-system,sans-serif;font-weight:700;paint-order:stroke;stroke:var(--card-bg);stroke-width:3px;stroke-linejoin:round}
.iso-level-line{stroke:var(--text-muted);stroke-opacity:.35;stroke-width:1;vector-effect:non-scaling-stroke;fill:none}
</style>`;

function finish(scene, ariaLabel, extraClass = '') {
  const { bb, fs } = scene;
  const pad = fs * 1.4;
  const w = bb.maxX - bb.minX + 2 * pad;
  const h = bb.maxY - bb.minY + 2 * pad;
  return `<svg class="iso-svg${extraClass ? ' ' + extraClass : ''}" xmlns="http://www.w3.org/2000/svg" viewBox="${f1(bb.minX - pad)} ${f1(bb.minY - pad)} ${f1(w)} ${f1(h)}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(ariaLabel)}" style="width:100%;height:auto;display:block">${STYLE}${scene.els.join('')}</svg>`;
}

function occupiedMap(list) {
  const m = new Map();
  (list || []).forEach((o) => {
    const key = `${o.depth}|${o.level}|${o.bin}|${o.row || 1}`;
    m.set(key, (m.get(key) || 0) + (o.count || 1));
  });
  return m;
}

// geom: resolveRackGeometry() result.
// opts: {
//   highlight: { depth, level, bin, row?, label? }   the one bin to find — drawn solid blue with a coordinates label
//   occupied:  [{ depth, level, bin, row?, count? }] bins holding something — tinted (Bin Locator)
//   selected:  { depth, level }                      a whole shelf outlined (Bin Locator)
//   showDimensions: draw L / D / H (and shelf clear-height) callouts; sampleBin: draw a blue reference bin
//   interactive: bins/boards carry data-depth/level/bin/row and a pointer cursor; ariaLabel
// }
export function buildIsoRackSVG(geom, opts = {}) {
  const g = geom;
  const { highlight = null, occupied = [], selected = null, showDimensions = false, sampleBin = false, interactive = false } = opts;
  const L = g.runLength, Dt = g.totalDepth, H = g.height;

  // base font size in scene units, from the size of the whole rack
  const corners = [[0, 0, 0], [L, 0, 0], [L, Dt, 0], [0, Dt, 0], [0, 0, H], [L, 0, H], [L, Dt, H], [0, Dt, H]].map((c) => P(c[0], c[1], c[2]));
  const sceneW = Math.max(...corners.map((c) => c[0])) - Math.min(...corners.map((c) => c[0]));
  const sceneH = Math.max(...corners.map((c) => c[1])) - Math.min(...corners.map((c) => c[1]));
  const fs = clamp(5, 90, Math.max(sceneW, sceneH) / 30);
  const S = makeScene(fs);
  corners.forEach(S.addPt);
  const sceneMinX = Math.min(...corners.map((c) => c[0])), sceneMaxX = Math.max(...corners.map((c) => c[0]));

  const occ = occupiedMap(occupied);
  const totalBins = g.depthCount * g.levels * g.rows * g.binsPerLevel;
  const drawEmptyBins = totalBins <= MAX_DRAWN_BINS;
  const dataAttrs = (d, l, b, r) => (interactive ? ` data-depth="${d}" data-level="${l}"${b ? ` data-bin="${b}"` : ''}${r ? ` data-row="${r}"` : ''}` : '');
  const codeFor = (d, l, b, r) => formatLocationCode(g.zone, d, l, b, r);

  S.poly('iso-floor', [[0, 0, 0], [L, 0, 0], [L, Dt, 0], [0, Dt, 0]]);

  // The bin being looked for: solid, opaque, blue. It is painted at its own place in the sequence
  // below, not on top of everything — so the (see-through) shelves and uprights nearer the viewer
  // than it lay over it like glass, which is what makes a bin in the BACK rack read as being behind
  // the front one instead of floating in front of it.
  const minSize = Math.max(fs * 0.9, 0);
  let hlSpec = null;
  if (highlight && highlight.depth >= 1 && highlight.level >= 1 && highlight.bin >= 1) {
    hlSpec = { d: highlight.depth, l: highlight.level, b: highlight.bin, r: highlight.row || 1, label: highlight.label, tag: false };
  } else if (sampleBin) {
    hlSpec = { d: 1, l: 1, b: 1, r: 1, label: 'sample bin', tag: true };
  }
  let hl = null;
  const drawBlueBin = (spec) => {
    const { d, l, b, r } = spec;
    const cx0 = (b - 1) * g.cellW, cx1 = b * g.cellW;
    const cy0 = (d - 1) * (g.rackD + g.gap) + (r - 1) * g.binD, cy1 = cy0 + g.binD;
    const z0 = (l - 1) * g.pitch + g.boardT, z1 = z0 + g.binH;
    // the recorded bin size, centred in its cell — and never smaller than a readable blob, however big the rack is
    const fit = (c0, c1, size) => { const c = (c0 + c1) / 2, w = Math.max(size, minSize); return [c - w / 2, c + w / 2]; };
    const [bx0, bx1] = fit(cx0, cx1, g.binDrawW), [by0, by1] = fit(cy0, cy1, g.binDrawD);
    const bz1 = Math.max(z1, z0 + minSize);
    S.els.push('<g class="iso-hl">');
    S.box('iso-hl-front', 'iso-hl-side', 'iso-hl-top', bx0, by0, z0, bx1, by1, bz1, interactive ? ` data-depth="${d}" data-level="${l}" data-bin="${b}" data-row="${r}"` : '');
    S.els.push('</g>');
    hl = { anchor: P((bx0 + bx1) / 2, (by0 + by1) / 2, bz1), label: spec.label || codeFor(d, l, b, r), tag: spec.tag, box: [bx0, by0, z0, bx1, by1, bz1] };
  };
  // The shelves in front of a bin lay over it like glass (that's the depth cue), which on its own
  // would wash the blue out — so the same box is laid over the top once more, mostly opaque: solid
  // blue to the eye, with the glass edges still faintly showing through it.
  const drawBlueBinOverlay = () => {
    const [x0, y0, z0, x1, y1, z1] = hl.box;
    S.els.push('<g class="iso-hl iso-hl-overlay">');
    S.box('iso-hl-front iso-hl-over', 'iso-hl-side iso-hl-over', 'iso-hl-top iso-hl-over', x0, y0, z0, x1, y1, z1, '');
    S.els.push('</g>');
  };

  // racks back to front, levels bottom to top, so nearer/higher things paint over farther/lower ones
  for (let d = g.depthCount; d >= 1; d--) {
    const y0 = (d - 1) * (g.rackD + g.gap), y1 = y0 + g.rackD;
    for (let k = 0; k <= g.bays; k++) S.line('iso-post', [k * g.bayW, y1, 0], [k * g.bayW, y1, H]);
    for (let l = 1; l <= g.levels; l++) {
      const zb = (l - 1) * g.pitch, zt = zb + g.boardT;
      const isSel = selected && selected.depth === d && selected.level === l;
      S.poly(`iso-board-top${isSel ? ' iso-shelf-selected' : ''}${interactive ? ' iso-click' : ''}`, [[0, y0, zt], [L, y0, zt], [L, y1, zt], [0, y1, zt]], dataAttrs(d, l), isSel || !interactive ? '' : `Rack ${d} · Level ${l}`);
      S.poly('iso-board-front', [[0, y0, zb], [L, y0, zb], [L, y0, zt], [0, y0, zt]]);
      S.poly('iso-board-side', [[L, y0, zb], [L, y1, zb], [L, y1, zt], [L, y0, zt]]);
      for (let r = g.rows; r >= 1; r--) {
        for (let b = 1; b <= g.binsPerLevel; b++) {
          const count = occ.get(`${d}|${l}|${b}|${r}`) || 0;
          if (count || drawEmptyBins) {
            const x0 = (b - 1) * g.cellW, x1 = b * g.cellW;
            const ry0 = y0 + (r - 1) * g.binD, ry1 = ry0 + g.binD;
            const title = interactive || count ? `${codeFor(d, l, b, r)}${count ? ` — ${count} item${count > 1 ? 's' : ''}` : ''}` : '';
            S.poly(`iso-bin${count ? ' iso-bin-occupied' : ''}${interactive ? ' iso-click' : ''}`, [[x0, ry0, zt], [x1, ry0, zt], [x1, ry1, zt], [x0, ry1, zt]], dataAttrs(d, l, b, r), title);
          }
          if (hlSpec && !hl && hlSpec.d === d && hlSpec.l === l && hlSpec.b === b && hlSpec.r === r) drawBlueBin(hlSpec);
        }
      }
    }
    for (let k = 0; k <= g.bays; k++) S.line('iso-post', [k * g.bayW, y0, 0], [k * g.bayW, y0, H]);
  }
  if (hlSpec && !hl) drawBlueBin(hlSpec); // a spot outside the drawn rack: still show it rather than nothing
  if (hl) drawBlueBinOverlay();
  if (hl) S.pill(hl.anchor, hl.label, fs * 3.4, sceneMinX, sceneMaxX, hl.tag ? 'iso-tag' : 'iso-pill', hl.tag ? 'iso-tag-text' : 'iso-pill-text');

  if (showDimensions) {
    const rec = g.recorded;
    const cm = (v) => `${f1(v)} cm`;
    const off = fs * 3;
    const rackW = rec.rackW || rec.shelfW;
    S.dim([0, 0, 0], [L, 0, 0], [0, -off, 0], rackW ? `${g.bays > 1 ? `${g.bays} × ${f1(rackW)} = ` : ''}${cm(L)}` : `≈ ${cm(L)}`, !rackW);
    const rackD = rec.rackD || rec.shelfD;
    S.dim([L, 0, 0], [L, Dt, 0], [off, 0, 0], rackD ? `${g.depthCount > 1 ? `${g.depthCount} racks · ` : ''}${cm(Dt)}` : `≈ ${cm(Dt)}`, !rackD);
    S.dim([0, 0, 0], [0, 0, H], [0, -off, 0], rec.rackH ? cm(rec.rackH) : `≈ ${cm(H)}`, !rec.rackH);
    // clear height of one level, measured up the front-right upright — on the second level when
    // there is one, so its label sits well clear of the depth callout down at floor level
    const lv = g.levels >= 2 ? 1 : 0;
    const zA = lv * g.pitch + g.boardT;
    S.dim([L, 0, zA], [L, 0, zA + g.clear], [off * 0.9, 0, 0], rec.shelfH ? cm(rec.shelfH) : `≈ ${cm(g.clear)}`, !rec.shelfH);
  }

  return finish(S, opts.ariaLabel || `Isometric view of rack area ${g.zone}`, interactive ? 'iso-interactive' : '');
}

// ── warehouse floor: every rack area as a translucent block on the floor grid ─────────────────
// zones: warehouse_zones rows (grid_col/grid_row/max_aisle/max_rack + the dimension columns).
// opts: { selectedZone, highlight: { zone, depth, level, bin, row?, label? }, cellCm = 120, interactive, ariaLabel }
export function buildIsoFloorSVG(zones, opts = {}) {
  const placed = (zones || []).filter((z) => Number.isFinite(z.grid_col) && Number.isFinite(z.grid_row));
  if (!placed.length) return '';
  const { selectedZone = null, highlight = null, interactive = false } = opts;
  const cell = opts.cellCm || 120;

  const geoms = new Map();
  placed.forEach((z) => geoms.set(z.zone, resolveRackGeometry(z, { maxDepth: z.max_rack || 1, maxLevel: z.max_level || 1, maxBin: z.max_bin || 1 })));
  const minCol = Math.min(...placed.map((z) => z.grid_col)) - 1, maxCol = Math.max(...placed.map((z) => z.grid_col + (z.max_aisle || 1))) + 1;
  const minRow = Math.min(...placed.map((z) => z.grid_row)) - 1, maxRow = Math.max(...placed.map((z) => z.grid_row + (z.max_rack || 1))) + 1;
  const tallest = Math.max(...[...geoms.values()].map((g) => g.height));

  const X0 = minCol * cell, X1 = maxCol * cell, Y0 = minRow * cell, Y1 = maxRow * cell;
  const cornerPts = [[X0, Y0, 0], [X1, Y0, 0], [X1, Y1, 0], [X0, Y1, 0], [X0, Y0, tallest], [X1, Y1, tallest]].map((c) => P(c[0], c[1], c[2]));
  const sw = Math.max(...cornerPts.map((c) => c[0])) - Math.min(...cornerPts.map((c) => c[0]));
  const sh = Math.max(...cornerPts.map((c) => c[1])) - Math.min(...cornerPts.map((c) => c[1]));
  const fs = clamp(20, 400, Math.max(sw, sh) / 34);
  const S = makeScene(fs);
  cornerPts.forEach(S.addPt);
  const sceneMinX = Math.min(...cornerPts.map((c) => c[0])), sceneMaxX = Math.max(...cornerPts.map((c) => c[0]));

  S.poly('iso-floor', [[X0, Y0, 0], [X1, Y0, 0], [X1, Y1, 0], [X0, Y1, 0]]);
  for (let c = minCol; c <= maxCol; c++) S.line('iso-grid', [c * cell, Y0, 0], [c * cell, Y1, 0]);
  for (let r = minRow; r <= maxRow; r++) S.line('iso-grid', [X0, r * cell, 0], [X1, r * cell, 0]);

  // The located bin's box, at its real place inside its rack area. It is painted INSIDE its rack
  // area's glass (before that area's faces, below) so the see-through block visibly holds it.
  let hlBox = null;
  if (highlight && geoms.has(highlight.zone)) {
    const z = placed.find((p) => p.zone === highlight.zone);
    const g = geoms.get(highlight.zone);
    const N = Math.max(g.binsPerLevel, highlight.bin || 1);
    const zw = (z.max_aisle || 1) * cell;
    const bx0 = z.grid_col * cell + ((highlight.bin - 1) / N) * zw, bx1 = z.grid_col * cell + (highlight.bin / N) * zw;
    const perRack = cell; // each rack occupies one grid cell deep on the floor plan
    const by0 = z.grid_row * cell + (highlight.depth - 1) * perRack + (((highlight.row || 1) - 1) / g.rows) * perRack;
    const by1 = by0 + perRack / g.rows;
    const z0 = (highlight.level - 1) * g.pitch + g.boardT, z1 = z0 + g.binH;
    const min = fs * 1.1;
    const grow = (a0, a1) => (a1 - a0 >= min ? [a0, a1] : [(a0 + a1) / 2 - min / 2, (a0 + a1) / 2 + min / 2]);
    const [gx0, gx1] = grow(bx0, bx1), [gy0, gy1] = grow(by0, by1);
    hlBox = { zone: highlight.zone, x0: gx0, x1: gx1, y0: gy0, y1: gy1, z0, z1: Math.max(z1, z0 + min) };
  }

  // far to near: smaller x and larger y are farther from the viewer
  const ordered = placed.slice().sort((a, b) => ((a.grid_col + (a.max_aisle || 1) / 2) - (a.grid_row + (a.max_rack || 1) / 2)) - ((b.grid_col + (b.max_aisle || 1) / 2) - (b.grid_row + (b.max_rack || 1) / 2)));
  ordered.forEach((z) => {
    const g = geoms.get(z.zone);
    const x0 = z.grid_col * cell, x1 = (z.grid_col + (z.max_aisle || 1)) * cell;
    const y0 = z.grid_row * cell, y1 = (z.grid_row + (z.max_rack || 1)) * cell;
    const sel = z.zone === selectedZone ? ' iso-zone-selected' : '';
    const attrs = interactive ? ` data-zone="${esc(z.zone)}"` : '';
    S.els.push(`<g class="${interactive ? 'iso-click' : ''}"${attrs}>`);
    if (hlBox && hlBox.zone === z.zone) {
      S.els.push('<g class="iso-hl">');
      S.box('iso-hl-front', 'iso-hl-side', 'iso-hl-top', hlBox.x0, hlBox.y0, hlBox.z0, hlBox.x1, hlBox.y1, hlBox.z1, '');
      S.els.push('</g>');
    }
    S.box(`iso-zone-front${sel}`, `iso-zone-side${sel}`, `iso-zone-top${sel}`, x0, y0, 0, x1, y1, g.height, '');
    for (let l = 1; l < g.levels; l++) {
      const zl = l * g.pitch;
      S.line('iso-level-line', [x0, y0, zl], [x1, y0, zl]);
      S.line('iso-level-line', [x1, y0, zl], [x1, y1, zl]);
    }
    // the letter goes near one end of the run, so it never sits on top of the located bin: the
    // near-left end normally, the far end when the bin is in that first stretch of this area
    const binHere = hlBox && hlBox.zone === z.zone;
    const nearStart = binHere && ((highlight.bin - 0.5) / Math.max(g.binsPerLevel, highlight.bin || 1)) < 0.3;
    const labelAt = nearStart ? 0.88 : 0.12;
    const c = P(x0 + (x1 - x0) * labelAt, (y0 + y1) / 2, g.height);
    S.addRect(c[0], c[1], fs * 2, fs * 1.4);
    S.els.push(`<text class="iso-zone-label" x="${f1(c[0])}" y="${f1(c[1])}" font-size="${f1(fs * 1.25)}" text-anchor="middle" dominant-baseline="central">${esc(z.zone)}</text>`);
    S.els.push('</g>');
  });

  if (hlBox) {
    // same solid-over-glass treatment as the rack view (see buildIsoRackSVG)
    S.els.push('<g class="iso-hl iso-hl-overlay">');
    S.box('iso-hl-front iso-hl-over', 'iso-hl-side iso-hl-over', 'iso-hl-top iso-hl-over', hlBox.x0, hlBox.y0, hlBox.z0, hlBox.x1, hlBox.y1, hlBox.z1, '');
    S.els.push('</g>');
    const anchor = P((hlBox.x0 + hlBox.x1) / 2, (hlBox.y0 + hlBox.y1) / 2, hlBox.z1);
    S.pill(anchor, highlight.label || formatLocationCode(highlight.zone, highlight.depth, highlight.level, highlight.bin, highlight.row || 1), fs * 4, sceneMinX, sceneMaxX);
  }

  return finish(S, opts.ariaLabel || 'Isometric view of the warehouse floor', interactive ? 'iso-interactive' : '');
}
