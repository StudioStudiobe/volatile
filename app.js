'use strict';

/* ============================================================
   Linework — black & white stripe-pattern composition tool

   Model:  one BASE stripe field  +  a stack of LAYERS.
   Each layer = a SHAPE with an OPERATION. Later layers paint
   on top of earlier ones (knock-outs override the field, etc.).

   Stripe rule (locked):  black line width = x, gap = x / 2.
   ============================================================ */

const SHAPES = ['circle', 'ellipse', 'rect', 'polygon', 'sector'];

let _uid = 1;
const nid = () => 'L' + (_uid++);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/* ---------- State ---------- */
const state = {
  doc: { w: 2100, h: 2970, format: 'A4', landscape: false },  // units: 0.1 mm (print) or px (screen)
  reformatMode: 'fit',           // on format change: 'fit' keeps everything, 'fill' crops
  invert: false,                 // global black/white swap
  base: { angle: 0, line: 16, inverted: false },  // stripe field; gap = line / 2 (derived)
  layers: [],
  selectedId: null,
  // Animation is a non-destructive overlay on the design: values below are
  // rates per beat; the running clock lives in `anim` (not in history).
  animation: { bpm: 120, scroll: 0, drift: 0, flipEvery: 0 },
};

const anim = { playing: false, beats: 0, last: 0, raf: 0 };

/* Animated view of the design at the current clock (pure: no state mutation) */
function animated() {
  const a = state.animation, b = anim.beats;
  const flip = a.flipEvery > 0 && Math.floor(b / a.flipEvery) % 2 === 1;
  return {
    phase: a.scroll * b * state.base.line * 1.5,   // lines/beat -> user units (one period per line)
    angle: state.base.angle + a.drift * b,
    invert: state.invert !== flip,
    layerRotate: (L) => L.rotate + (L.spin || 0) * b,
    // pulse: size breathes ±pulse % around the design size, one cycle per period
    layerScale: (L) => {
      if (!L.pulse) return 1;
      const period = L.pulsePeriod || 4, off = L.pulseOffset || 0;
      return 1 + (L.pulse / 100) * Math.sin(2 * Math.PI * (b - off) / period);
    },
  };
}

/* Scaled copy of a shape about its centre (geometry, not a transform:
   the stripe pattern and the border width must stay at x). */
function scaledShape(s, k) {
  if (k === 1) return s;
  const [cx, cy] = shapeCenter(s);
  const X = (x) => cx + (x - cx) * k, Y = (y) => cy + (y - cy) * k;
  switch (s.type) {
    case 'circle':  return { ...s, r: s.r * k };
    case 'sector':  return { ...s, r: s.r * k };
    case 'ellipse': return { ...s, rx: s.rx * k, ry: s.ry * k };
    case 'rect':    return { ...s, x: X(s.x), y: Y(s.y), w: s.w * k, h: s.h * k, r: s.r * k };
    case 'polygon': return { ...s, points: s.points.map((p) => [X(p[0]), Y(p[1])]) };
  }
}

let viewInvert = false;   // set per render from animated().invert
const ink   = () => (viewInvert ? '#ffffff' : '#000000');
const paper = () => (viewInvert ? '#000000' : '#ffffff');
const col   = (c) => (c === 'paper' ? paper() : ink());   // layer colour name -> hex
const COLOURS = [['ink', 'black (ink)'], ['paper', 'white (paper)']];

/* ---------- Defaults ---------- */
function makeShape(type) {
  const { w, h } = state.doc, cx = w / 2, cy = h / 2, s = Math.min(w, h) * 0.3;
  switch (type) {
    case 'circle':  return { type, cx, cy, r: s };
    case 'ellipse': return { type, cx, cy, rx: s, ry: s * 0.62 };
    case 'rect':    return { type, x: cx - s, y: cy - s * 1.2, w: s * 2, h: s * 2.4, r: s };
    case 'polygon': return { type, points: [[cx, cy - s], [cx + s, cy + s], [cx - s, cy + s]] };
    case 'sector':  return { type, cx, cy, r: s, a0: 180, a1: 360 };
  }
}

/* Colour lives on the layer (not the operation) so it survives switching the
   operation: stripes -> line colour, fill -> fill colour, outline -> stroke. */
function defaultOp(type) {
  if (type === 'fill')    return { type: 'fill' };
  if (type === 'outline') return { type: 'outline', width: 4 };
  return { type: 'stripes', angle: (state.base.angle + 90) % 180, line: 0 };
}

function defaultLayer(type) {
  return { id: nid(), name: cap(type), visible: true, rotate: 0,
           spin: 0, pulse: 0, pulsePeriod: 4, pulseOffset: 0,
           color: 'ink', border: false, borderColor: 'ink',
           shape: makeShape(type), op: defaultOp('stripes') };
}

/* ============================================================
   SVG rendering
   ============================================================ */

function patKey(angle, line, inv) {
  return 'p_' + String(angle).replace(/[.-]/g, '_') + '_' +
         String(line).replace(/[.-]/g, '_') + '_' + (inv ? 1 : 0);
}

let viewPhase = 0;        // stripe scroll offset (user units), shared by all patterns

function patDef(angle, line, inv) {
  const P = line * 1.5;                       // period = line + gap = x + x/2
  const lc = inv ? paper() : ink();           // line colour
  const bg = inv ? ink() : paper();           // gap colour
  const ph = viewPhase ? ` translate(0 ${(viewPhase % P).toFixed(3)})` : '';
  return `<pattern id="${patKey(angle, line, inv)}" patternUnits="userSpaceOnUse" `
       + `width="${P}" height="${P}" patternTransform="rotate(${angle})${ph}">`
       + `<rect width="${P}" height="${P}" fill="${bg}"/>`
       + `<rect width="${P}" height="${line}" fill="${lc}"/>`
       + `</pattern>`;
}

function sectorPath(s) {
  const rad = (a) => (a * Math.PI) / 180;
  const x0 = s.cx + s.r * Math.cos(rad(s.a0)), y0 = s.cy + s.r * Math.sin(rad(s.a0));
  const x1 = s.cx + s.r * Math.cos(rad(s.a1)), y1 = s.cy + s.r * Math.sin(rad(s.a1));
  const large = (((s.a1 - s.a0) % 360) + 360) % 360 > 180 ? 1 : 0;
  return `M ${s.cx} ${s.cy} L ${x0.toFixed(2)} ${y0.toFixed(2)} `
       + `A ${s.r} ${s.r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`;
}

function shapeCenter(s) {
  switch (s.type) {
    case 'circle': case 'ellipse': case 'sector': return [s.cx, s.cy];
    case 'rect': return [s.x + s.w / 2, s.y + s.h / 2];
    case 'polygon': {
      let X = 0, Y = 0;
      s.points.forEach((p) => { X += p[0]; Y += p[1]; });
      return [X / s.points.length, Y / s.points.length];
    }
  }
}

function shapeMarkup(s, attrs, tf) {
  const t = tf ? ` transform="${tf}"` : '';
  switch (s.type) {
    case 'circle':  return `<circle cx="${s.cx}" cy="${s.cy}" r="${s.r}" ${attrs}${t}/>`;
    case 'ellipse': return `<ellipse cx="${s.cx}" cy="${s.cy}" rx="${s.rx}" ry="${s.ry}" ${attrs}${t}/>`;
    case 'rect':    return `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="${s.r}" ry="${s.r}" ${attrs}${t}/>`;
    case 'polygon': return `<polygon points="${s.points.map((p) => p.join(',')).join(' ')}" ${attrs}${t}/>`;
    case 'sector':  return `<path d="${sectorPath(s)}" ${attrs}${t}/>`;
  }
}

function layerAttrs(L, patterns) {
  const op = L.op, c = L.color || 'ink';
  if (op.type === 'fill') {
    return `fill="${col(c)}"`;
  }
  if (op.type === 'outline') {
    return `fill="none" stroke="${col(c)}" stroke-width="${op.width}"`;
  }
  // stripes (layer angles drift together with the base, so relations hold)
  const line = op.line > 0 ? op.line : state.base.line;
  const angle = r1((op.angle + state.animation.drift * anim.beats) % 360);
  const inv = c === 'paper';                    // white lines on black
  const key = patKey(angle, line, inv);
  patterns.set(key, patDef(angle, line, inv));
  return `fill="url(#${key})"`;
}

function buildSVG(forExport) {
  const { w, h } = state.doc;
  const view = animated();
  viewInvert = view.invert;
  viewPhase = view.phase;
  const baseAngle = r1(view.angle % 360);
  const patterns = new Map();
  const baseKey = patKey(baseAngle, state.base.line, state.base.inverted);
  patterns.set(baseKey, patDef(baseAngle, state.base.line, state.base.inverted));

  let body = `<rect x="0" y="0" width="${w}" height="${h}" fill="${paper()}"/>`
           + `<rect x="0" y="0" width="${w}" height="${h}" fill="url(#${baseKey})"/>`;

  for (const L of state.layers) {
    if (!L.visible) continue;
    const attrs = layerAttrs(L, patterns);
    const shape = scaledShape(L.shape, view.layerScale(L));
    const [cx, cy] = shapeCenter(shape);
    const rot = r1(view.layerRotate(L));
    const tf = rot ? `rotate(${rot} ${cx} ${cy})` : '';
    const border = (L.border && L.op.type !== 'outline')
      ? ` stroke="${col(L.borderColor || 'ink')}" stroke-width="${state.base.line}" stroke-linejoin="miter"` : '';
    const meta = forExport ? '' : ` class="shape" data-id="${L.id}"`;
    body += shapeMarkup(shape, attrs + border + meta, tf);
  }

  if (!forExport && state.selectedId) body += selectionOverlay();

  const defs = `<defs>${[...patterns.values()].join('')}</defs>`;
  const f = currentFormat();
  const size = (forExport && f && f.mm)
    ? `width="${w / 10}mm" height="${h / 10}mm"`      // print-ready physical size
    : `width="${w}" height="${h}"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" `
       + `${size} preserveAspectRatio="xMidYMid meet">${defs}${body}</svg>`;
}

function paint() {
  document.getElementById('preview').innerHTML = buildSVG(false);
}

function renderSVG() {
  if (typeof document === 'undefined') return;
  paint();
  markDirty();
}

/* ============================================================
   History — undo / redo
   Snapshot-based: every render marks the document dirty; after a short
   pause the previous stable snapshot is pushed. Slider drags and canvas
   drags therefore collapse into one undo step.
   ============================================================ */
const HISTORY_MAX = 100;
let undoStack = [], redoStack = [], stable = null, dirtyTimer = null;

function serialize() {
  return JSON.stringify({ doc: state.doc, base: state.base, invert: state.invert,
                          layers: state.layers, reformatMode: state.reformatMode,
                          animation: state.animation });
}

function flushHistory() {
  if (dirtyTimer) { clearTimeout(dirtyTimer); dirtyTimer = null; }
  const cur = serialize();
  if (stable === null) stable = cur;
  else if (cur !== stable) {
    undoStack.push(stable);
    if (undoStack.length > HISTORY_MAX) undoStack.shift();
    redoStack = [];
    stable = cur;
  }
  updateHistoryButtons();
}

function markDirty() {
  if (dirtyTimer) clearTimeout(dirtyTimer);
  dirtyTimer = setTimeout(flushHistory, 400);
}

function restore(json) {
  Object.assign(state, JSON.parse(json));
  stable = json;
  if (!state.layers.some((l) => l.id === state.selectedId)) state.selectedId = null;
  renderAll();
}

function undo() {
  flushHistory();
  if (!undoStack.length) return;
  redoStack.push(stable);
  restore(undoStack.pop());
  updateHistoryButtons();
}

function redo() {
  flushHistory();
  if (!redoStack.length) return;
  undoStack.push(stable);
  restore(redoStack.pop());
  updateHistoryButtons();
}

function updateHistoryButtons() {
  if (typeof document === 'undefined') return;
  const u = document.getElementById('undo'), r = document.getElementById('redo');
  if (u) u.disabled = !undoStack.length && serialize() === stable;
  if (r) r.disabled = !redoStack.length;
}

function historyRow() {
  return el('div', { class: 'addrow hist' },
    el('button', { type: 'button', id: 'undo', class: 'mini', onclick: undo }, '↶ Undo'),
    el('button', { type: 'button', id: 'redo', class: 'mini', onclick: redo }, '↷ Redo'),
    el('span', { class: 'hint' }, '⌘/Ctrl+Z · ⇧⌘Z · Delete removes the selected layer'));
}

function onKey(e) {
  const t = e.target, tag = t && t.tagName;
  const typing = tag === 'TEXTAREA' || (tag === 'INPUT' && t.type === 'text');
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') {
    if (typing) return;                     // let the field handle its own text undo
    e.preventDefault();
    e.shiftKey ? redo() : undo();
  } else if (mod && e.key.toLowerCase() === 'y') {
    if (typing) return;
    e.preventDefault(); redo();
  } else if (e.key === ' ' && tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT' && tag !== 'BUTTON') {
    e.preventDefault(); anim.playing ? pause() : play();
  } else if ((e.key === 'f' || e.key === 'F') && !mod && !typing && tag !== 'INPUT' && tag !== 'SELECT') {
    e.preventDefault(); toggleFullscreen();
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && !typing && tag !== 'INPUT' && tag !== 'SELECT') {
    const i = state.layers.findIndex((l) => l.id === state.selectedId);
    if (i < 0) return;
    e.preventDefault();
    state.layers.splice(i, 1); state.selectedId = null; renderAll();
  }
}

/* ============================================================
   Tiny DOM helper
   ============================================================ */
function el(tag, props, ...kids) {
  const e = document.createElement(tag);
  props = props || {};
  for (const k in props) {
    const v = props[k];
    if (v == null) continue;
    if (k === 'class') e.className = v;
    else if (k.slice(0, 2) === 'on' && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return e;
}

/* ---------- Field widgets ---------- */
function numField(label, val, min, max, step, on) {
  const r = el('input', { type: 'range', min, max, step, value: val });
  const n = el('input', { type: 'number', min, max, step, value: val });
  r.addEventListener('input', () => { n.value = r.value; on(+r.value); });
  n.addEventListener('input', () => { r.value = n.value; on(+n.value); });
  return el('label', { class: 'row' }, el('span', { class: 'lbl' }, label),
            el('div', { class: 'rngwrap' }, r, n));
}

function selectField(label, val, opts, on) {
  const s = el('select', { onchange: (e) => on(e.target.value) },
               ...opts.map((o) => el('option', { value: o[0] }, o[1])));
  s.value = val;
  return el('label', { class: 'row' }, el('span', { class: 'lbl' }, label), s);
}

function checkField(label, val, on) {
  const c = el('input', { type: 'checkbox', onchange: (e) => on(e.target.checked) });
  c.checked = val;
  return el('label', { class: 'row check' }, c, el('span', { class: 'lbl' }, label));
}

function btn(label, on, cls) {
  return el('button', { type: 'button', class: cls || '', onclick: on }, label);
}

function section(title, children) {
  return el('section', { class: 'sec' }, el('h2', {}, title), ...children);
}

/* ---------- Shape / op parameter fields ---------- */
function shapeFields(L) {
  const s = L.shape, r = renderSVG;
  const W = state.doc.w, H = state.doc.h, M = Math.max(W, H);
  const f = (label, key, min, max) => numField(label, s[key], min, max, 1, (v) => { s[key] = v; r(); });
  switch (s.type) {
    case 'circle':  return [f('cx', 'cx', 0, W), f('cy', 'cy', 0, H), f('radius', 'r', 1, M)];
    case 'ellipse': return [f('cx', 'cx', 0, W), f('cy', 'cy', 0, H), f('radius x', 'rx', 1, M), f('radius y', 'ry', 1, M)];
    case 'rect':    return [f('x', 'x', -M, W), f('y', 'y', -M, H), f('width', 'w', 1, M), f('height', 'h', 1, M), f('corner r', 'r', 0, M)];
    case 'sector':  return [f('cx', 'cx', 0, W), f('cy', 'cy', 0, H), f('radius', 'r', 1, M), f('start°', 'a0', 0, 360), f('end°', 'a1', 0, 360)];
    case 'polygon': return [polygonField(L)];
  }
}

function polygonField(L) {
  const t = el('textarea', { rows: 3 }, L.shape.points.map((p) => p.join(',')).join('  '));
  t.addEventListener('input', () => {
    const pts = t.value.trim().split(/\s+/)
      .map((pair) => pair.split(',').map(Number))
      .filter((p) => p.length === 2 && p.every((n) => !isNaN(n)));
    if (pts.length >= 3) { L.shape.points = pts; renderSVG(); }
  });
  return el('label', { class: 'row col' }, el('span', { class: 'lbl' }, 'Points (x,y …)'), t);
}

function opFields(L) {
  const op = L.op, r = renderSVG;
  if (op.type === 'fill') return [];
  if (op.type === 'outline') {
    return [numField('Stroke', op.width, 1, 80, 1, (v) => { op.width = v; r(); })];
  }
  return [
    numField('Angle°', op.angle, 0, 180, 1, (v) => { op.angle = v; r(); }),
    numField('Line (0 = base)', op.line, 0, 240, 1, (v) => { op.line = v; r(); }),
  ];
}

/* ---------- Layer card ---------- */
function move(i, d) {
  const j = i + d;
  if (j < 0 || j >= state.layers.length) return;
  const a = state.layers;
  [a[i], a[j]] = [a[j], a[i]];
  renderAll();
}

function layerCard(L, i) {
  const head = el('div', { class: 'lhead' },
    el('input', { type: 'text', class: 'lname', value: L.name, oninput: (e) => { L.name = e.target.value; markDirty(); } }),
    btn('▲', () => move(i, -1), 'mini'),
    btn('▼', () => move(i, 1), 'mini'),
    btn('⧉', () => { const c = JSON.parse(JSON.stringify(L)); c.id = nid(); state.layers.splice(i + 1, 0, c); state.selectedId = c.id; renderAll(); }, 'mini'),
    btn('✕', () => { if (state.selectedId === L.id) state.selectedId = null; state.layers.splice(i, 1); renderAll(); }, 'mini danger'),
  );
  return el('div', {
      class: 'layer' + (L.id === state.selectedId ? ' active' : ''),
      onclick: (e) => {
        if (e.target.closest('input, select, textarea, button')) return;
        if (state.selectedId !== L.id) { state.selectedId = L.id; renderAll(); }
      },
    },
    head,
    checkField('Visible', L.visible, (v) => { L.visible = v; renderSVG(); }),
    selectField('Shape', L.shape.type, SHAPES.map((s) => [s, s]), (t) => { L.shape = makeShape(t); renderAll(); }),
    ...shapeFields(L),
    numField('Rotate°', L.rotate, -180, 180, 1, (v) => { L.rotate = v; renderSVG(); }),
    selectField('Operation', L.op.type,
      [['stripes', 'stripes'], ['fill', 'fill (solid / knock-out)'], ['outline', 'outline']],
      (t) => { L.op = defaultOp(t); renderAll(); }),
    selectField('Colour', L.color || 'ink', COLOURS, (v) => { L.color = v; renderSVG(); }),
    ...opFields(L),
    checkField('Border (width = x)', !!L.border, (v) => { L.border = v; renderAll(); }),
    L.border && L.op.type !== 'outline'
      ? selectField('Border colour', L.borderColor || 'ink', COLOURS, (v) => { L.borderColor = v; renderSVG(); })
      : null,
    el('div', { class: 'sub' }, 'Animation'),
    numField('Spin (°/beat)', L.spin || 0, -90, 90, 0.5, (v) => { L.spin = v; renderSVG(); }),
    numField('Pulse (±%)', L.pulse || 0, 0, 100, 1, (v) => { L.pulse = v; renderSVG(); }),
    numField('Period (beats)', L.pulsePeriod || 4, 0.25, 16, 0.25, (v) => { L.pulsePeriod = v; renderSVG(); }),
    numField('Offset (beats)', L.pulseOffset || 0, 0, 16, 0.25, (v) => { L.pulseOffset = v; renderSVG(); }),
  );
}

/* ============================================================
   Formats — switching formats keeps the composition
   ============================================================ */
/* Print formats live in 0.1 mm units (A4 = 2100 x 2970), screen formats in px.
   Portrait dimensions are stored; landscape swaps them. */
const FORMATS = [
  { id: 'A5', label: 'A5', mm: [148, 210] },
  { id: 'A4', label: 'A4', mm: [210, 297] },
  { id: 'A3', label: 'A3', mm: [297, 420] },
  { id: 'A2', label: 'A2', mm: [420, 594] },
  { id: 'A1', label: 'A1', mm: [594, 841] },
  { id: 'ig-post', label: 'IG post 1:1', px: [1080, 1080] },
  { id: 'ig-post-45', label: 'IG post 4:5', px: [1080, 1350] },
  { id: 'ig-reel', label: 'IG reel 9:16', px: [1080, 1920] },
];
const PRINT_DPI = 300;

const formatById = (id) => FORMATS.find((f) => f.id === id) || null;
const currentFormat = () => formatById(state.doc.format);

function formatUnits(f, landscape) {
  let [w, h] = f.mm ? [f.mm[0] * 10, f.mm[1] * 10] : f.px;
  if (landscape) [w, h] = [h, w];
  return [w, h];
}

const r1 = (v) => Math.round(v * 10) / 10;

/* Scale the whole composition (geometry AND line widths) from the old canvas
   into the new one, anchored at the centre. 'fit' = contain, 'fill' = cover. */
function reformat(w1, h1) {
  const w0 = state.doc.w, h0 = state.doc.h;
  if (w0 === w1 && h0 === h1) return;
  const s = state.reformatMode === 'fill'
    ? Math.max(w1 / w0, h1 / h0)
    : Math.min(w1 / w0, h1 / h0);
  const X = (x) => r1((x - w0 / 2) * s + w1 / 2);
  const Y = (y) => r1((y - h0 / 2) * s + h1 / 2);
  const S = (v) => r1(v * s);

  for (const L of state.layers) {
    const sh = L.shape;
    switch (sh.type) {
      case 'circle': case 'sector':
        sh.cx = X(sh.cx); sh.cy = Y(sh.cy); sh.r = S(sh.r); break;
      case 'ellipse':
        sh.cx = X(sh.cx); sh.cy = Y(sh.cy); sh.rx = S(sh.rx); sh.ry = S(sh.ry); break;
      case 'rect':
        sh.x = X(sh.x); sh.y = Y(sh.y); sh.w = S(sh.w); sh.h = S(sh.h); sh.r = S(sh.r); break;
      case 'polygon':
        sh.points = sh.points.map((p) => [X(p[0]), Y(p[1])]); break;
    }
    if (L.op.type === 'stripes' && L.op.line > 0) L.op.line = S(L.op.line);
    if (L.op.type === 'outline') L.op.width = Math.max(0.5, S(L.op.width));
  }
  state.base.line = Math.max(0.5, S(state.base.line));
  state.doc.w = w1;
  state.doc.h = h1;
}

function setFormat(id, landscape) {
  const f = formatById(id);
  if (!f) return;
  const [w, h] = formatUnits(f, landscape);
  reformat(w, h);
  state.doc.format = id;
  state.doc.landscape = !!landscape;
  renderAll();
}

/* Physical / export description of the current document */
function docInfo() {
  const f = currentFormat();
  const { w, h } = state.doc;
  if (f && f.mm) {
    const [mw, mh] = [w / 10, h / 10];
    const [pw, ph] = exportPixels();
    return `${mw} × ${mh} mm · 1 unit = 0.1 mm · PNG ${pw} × ${ph} px @ ${PRINT_DPI} dpi`;
  }
  if (f) return `${w} × ${h} px`;
  return `custom · ${w} × ${h} units · PNG at 2×`;
}

function exportPixels() {
  const f = currentFormat();
  const { w, h } = state.doc;
  if (f && f.mm) return [Math.round(w / 10 / 25.4 * PRINT_DPI), Math.round(h / 10 / 25.4 * PRINT_DPI)];
  if (f) return [w, h];
  return [w * 2, h * 2];
}

function exportName(ext) {
  const f = currentFormat();
  const tag = f ? f.id + (state.doc.landscape ? '-landscape' : '') : 'custom';
  return `linework-${tag}.${ext}`;
}

/* ---------- Document / format controls ---------- */
function formatRow() {
  return el('div', { class: 'addrow fmt' },
    ...FORMATS.map((f) => btn(f.label, () => setFormat(f.id, state.doc.landscape),
      'sz' + (f.id === state.doc.format ? ' active' : ''))));
}


/* ============================================================
   Control panel
   ============================================================ */
function lineInfo() {
  const f = currentFormat();
  if (!f || !f.mm) return '';
  return ` Line x = ${r1(state.base.line / 10)} mm, gap ${r1(state.base.line / 20)} mm.`;
}

function renderControls() {
  if (typeof document === 'undefined') return;
  const p = document.getElementById('panel');
  p.innerHTML = '';
  p.append(historyRow());

  const custom = (k) => (v) => { state.doc[k] = v; state.doc.format = null; renderSVG(); refreshDocInfo(); };
  p.append(section('Document', [
    formatRow(),
    checkField('Landscape', state.doc.landscape, (v) => {
      if (state.doc.format) setFormat(state.doc.format, v);
      else { reformat(state.doc.h, state.doc.w); state.doc.landscape = v; renderAll(); }
    }),
    selectField('On format change', state.reformatMode,
      [['fit', 'fit (keep all, field extends)'], ['fill', 'fill (cover, crop edges)']],
      (v) => { state.reformatMode = v; }),
    el('p', { class: 'hint', id: 'docinfo' }, docInfo()),
    el('p', { class: 'hint' }, 'Formats rescale the whole composition (incl. line width). Width / height below only resize the canvas (custom format).'),
    numField('Width', state.doc.w, 100, 10000, 10, custom('w')),
    numField('Height', state.doc.h, 100, 10000, 10, custom('h')),
    checkField('Invert whole image', state.invert, (v) => { state.invert = v; renderSVG(); }),
  ]));

  p.append(section('Base field', [
    numField('Angle°', state.base.angle, 0, 180, 1, (v) => { state.base.angle = v; renderSVG(); }),
    numField('Line width x', state.base.line, 1, 240, 1, (v) => { state.base.line = v; renderSVG(); }),
    selectField('Line colour', state.base.inverted ? 'paper' : 'ink', COLOURS,
      (v) => { state.base.inverted = v === 'paper'; renderSVG(); }),
    el('p', { class: 'hint' }, 'Gap is locked to x / 2.' + lineInfo()),
  ]));

  const wrap = el('div', {});
  state.layers.forEach((L, i) => wrap.append(layerCard(L, i)));
  p.append(section('Layers', [
    el('p', { class: 'hint' }, 'Drag a shape to move it; drag a corner square to resize (opposite corner stays). Alt: from centre · Shift: keep proportions.'),
    wrap,
    el('div', { class: 'addrow' },
      ...SHAPES.map((t) => btn('+ ' + t, () => { const L = defaultLayer(t); state.layers.push(L); state.selectedId = L.id; renderAll(); }, 'add'))),
  ]));

  p.append(animationSection());

  p.append(section('Export', [
    el('div', { class: 'addrow' },
      btn('Download SVG', exportSVG, 'exp'),
      btn('Download PNG', exportPNG, 'exp')),
  ]));
}

function refreshDocInfo() {
  const d = document.getElementById('docinfo');
  if (d) d.textContent = docInfo();
}

function renderAll() { renderControls(); renderSVG(); updateHistoryButtons(); }

/* ============================================================
   Animation — first sketch
   A beat clock drives rates set in the design (per beat). The design
   itself never changes while playing, so undo stays clean and any
   frame can be exported as a still.
   ============================================================ */
function tick(now) {
  if (!anim.playing) return;
  const dt = (now - anim.last) / 1000;
  anim.last = now;
  anim.beats += dt * state.animation.bpm / 60;
  paint();
  anim.raf = requestAnimationFrame(tick);
}

function play() {
  if (anim.playing) return;
  anim.playing = true;
  anim.last = performance.now();
  anim.raf = requestAnimationFrame(tick);
  syncPlayButton();
}

function pause() {
  anim.playing = false;
  cancelAnimationFrame(anim.raf);
  syncPlayButton();
}

function resetClock() { anim.beats = 0; paint(); }

function syncPlayButton() {
  const b = document.getElementById('play');
  if (b) b.textContent = anim.playing ? '❚❚ Pause' : '▶ Play';
}

function toggleFullscreen() {
  const st = document.querySelector('.stage');
  if (document.fullscreenElement) document.exitFullscreen();
  else st.requestFullscreen();
}

function animationSection() {
  const a = state.animation;
  return section('Animation (sketch)', [
    el('div', { class: 'addrow' },
      el('button', { type: 'button', id: 'play', onclick: () => (anim.playing ? pause() : play()) },
         anim.playing ? '❚❚ Pause' : '▶ Play'),
      btn('⟲ Reset', resetClock),
      btn('⛶ Fullscreen', toggleFullscreen)),
    numField('BPM', a.bpm, 20, 300, 1, (v) => { a.bpm = v; markDirty(); }),
    numField('Scroll (lines/beat)', a.scroll, -4, 4, 0.05, (v) => { a.scroll = v; paint(); markDirty(); }),
    numField('Drift (°/beat)', a.drift, -45, 45, 0.5, (v) => { a.drift = v; paint(); markDirty(); }),
    numField('Flip every N beats', a.flipEvery, 0, 32, 1, (v) => { a.flipEvery = v; paint(); markDirty(); }),
    el('p', { class: 'hint' }, 'Rates are per beat, so a change of tempo keeps the same feel. Each layer has its own Spin and Pulse (size breathing) in its card. Space toggles play; F toggles fullscreen.'),
  ]);
}

/* ============================================================
   Export
   ============================================================ */
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function exportSVG() {
  download(new Blob([buildSVG(true)], { type: 'image/svg+xml' }), exportName('svg'));
}

/* PNG at the format's native size: 300 dpi for print formats, 1x for screen
   formats (1080 px Instagram), 2x for a custom canvas. */
function exportPNG() {
  const [pw, ph] = exportPixels();
  const url = URL.createObjectURL(new Blob([buildSVG(true)], { type: 'image/svg+xml' }));
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = pw;
    c.height = ph;
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    c.toBlob((b) => download(b, exportName('png')));
  };
  img.src = url;
}

function loadDefault() {                  // A4 portrait starting canvas (units: 0.1 mm)
  state.doc = { w: 2100, h: 2970, format: 'A4', landscape: false };
  state.base = { angle: 0, line: 24, inverted: false };   // 2.4 mm line, 1.2 mm gap
  state.invert = false;
  state.animation = { bpm: 120, scroll: 0, drift: 0, flipEvery: 0 };
  anim.beats = 0;
  state.layers = [
    { id: nid(), name: 'Circle', visible: true, rotate: 0, spin: 0, pulse: 0, pulsePeriod: 4, pulseOffset: 0,
      color: 'ink', border: true, borderColor: 'ink',
      shape: { type: 'circle', cx: 1050, cy: 1485, r: 700 },
      op: { type: 'stripes', angle: 90, line: 0 } },
  ];
  state.selectedId = null;
  renderAll();
}

/* ============================================================
   Canvas interaction — drag to move, corner handles to resize
   ============================================================ */
const clone = (o) => JSON.parse(JSON.stringify(o));

function shapeBBox(s) {
  switch (s.type) {
    case 'circle': case 'sector': return [s.cx - s.r, s.cy - s.r, 2 * s.r, 2 * s.r];
    case 'ellipse': return [s.cx - s.rx, s.cy - s.ry, 2 * s.rx, 2 * s.ry];
    case 'rect': return [s.x, s.y, s.w, s.h];
    case 'polygon': {
      const xs = s.points.map((p) => p[0]), ys = s.points.map((p) => p[1]);
      const minx = Math.min(...xs), miny = Math.min(...ys);
      return [minx, miny, Math.max(...xs) - minx, Math.max(...ys) - miny];
    }
  }
}

function selectionOverlay() {
  const L = state.layers.find((l) => l.id === state.selectedId);
  if (!L || !L.visible) return '';
  const [bx, by, bw, bh] = shapeBBox(L.shape);
  const [cx, cy] = shapeCenter(L.shape);
  const tf = L.rotate ? ` transform="rotate(${L.rotate} ${cx} ${cy})"` : '';
  const hs = Math.max(state.doc.w, state.doc.h) / 90;   // handle size (user units)
  const sw = hs / 3, ac = '#3b82f6';
  const corners = [[bx, by], [bx + bw, by], [bx + bw, by + bh], [bx, by + bh]];
  let g = `<g${tf}>`;
  g += `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="none" stroke="${ac}" `
     + `stroke-width="${sw}" stroke-dasharray="${hs} ${hs * 0.6}" pointer-events="none"/>`;
  corners.forEach(([hx, hy], i) => {
    g += `<rect class="handle h${i}" data-handle="${i}" x="${hx - hs / 2}" y="${hy - hs / 2}" `
       + `width="${hs}" height="${hs}" fill="#ffffff" stroke="${ac}" stroke-width="${sw}"/>`;
  });
  return g + `</g>`;
}

function toLocal(vx, vy, angleDeg) {           // rotate a vector by -angle, into the shape's frame
  const a = -(angleDeg || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return [vx * c - vy * s, vx * s + vy * c];
}

function translateShape(shape, snap, dx, dy) {
  switch (shape.type) {
    case 'circle': case 'ellipse': case 'sector':
      shape.cx = snap.cx + dx; shape.cy = snap.cy + dy; break;
    case 'rect':
      shape.x = snap.x + dx; shape.y = snap.y + dy; break;
    case 'polygon':
      shape.points = snap.points.map((p) => [p[0] + dx, p[1] + dy]); break;
  }
}

function fromLocal(lx, ly, angleDeg) {         // inverse of toLocal
  const a = (angleDeg || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return [lx * c - ly * s, lx * s + ly * c];
}

const UNIFORM = { circle: true, sector: true, polygon: true };   // always keep proportions

/* Resize by dragging a corner handle.
   Works in the shape's local (unrotated) frame, relative to its centre.
   Default: the OPPOSITE corner stays put (like any drawing app).
   Alt / Option: scale from the centre.  Shift: keep proportions (rect, ellipse). */
function resizeShape(d, ux, uy, mods) {
  const sh = d.L.shape, snap = d.snap, [cx, cy] = d.center, rot = d.L.rotate;
  const [lx, ly] = toLocal(ux - cx, uy - cy, rot);
  const [bx, by, bw, bh] = d.bbox;                    // local bbox at drag start
  const centered = !!mods.alt;
  const uniform = UNIFORM[sh.type] || !!mods.shift;
  const MIN = 4;

  // anchor: opposite corner (or centre)
  const [hx, hy] = d.corner;                          // grabbed corner, local
  const ax = centered ? 0 : (hx === bx ? bx + bw : bx);
  const ay = centered ? 0 : (hy === by ? by + bh : by);

  // new extent from anchor to cursor
  const f = centered ? 2 : 1;
  let kx = Math.max(MIN, Math.abs(lx - ax) * f) / bw;
  let ky = Math.max(MIN, Math.abs(ly - ay) * f) / bh;
  if (uniform) kx = ky = Math.max(kx, ky);

  // scale about the anchor: p' = a + (p - a) * k  ->  centre (0,0) moves to a * (1 - k)
  const ncx = ax * (1 - kx), ncy = ay * (1 - ky);
  const [dx, dy] = fromLocal(ncx, ncy, rot);
  const ncenter = [cx + dx, cy + dy];

  switch (sh.type) {
    case 'circle': case 'sector':
      sh.cx = ncenter[0]; sh.cy = ncenter[1]; sh.r = snap.r * kx; break;
    case 'ellipse':
      sh.cx = ncenter[0]; sh.cy = ncenter[1]; sh.rx = snap.rx * kx; sh.ry = snap.ry * ky; break;
    case 'rect': {
      const w = snap.w * kx, h = snap.h * ky;
      sh.w = w; sh.h = h; sh.x = ncenter[0] - w / 2; sh.y = ncenter[1] - h / 2;
      sh.r = snap.r * Math.min(kx, ky);               // capsule stays a capsule
      break;
    }
    case 'polygon':
      sh.points = snap.points.map((p) => {
        const [px, py] = toLocal(p[0] - cx, p[1] - cy, rot);
        const [qx, qy] = fromLocal(ax + (px - ax) * kx, ay + (py - ay) * ky, rot);
        return [cx + qx, cy + qy];
      });
      break;
  }
}

let drag = null, pendingMouse = null, rafQueued = false;

function userCoords(e, rect, sx, sy) {
  return [(e.clientX - rect.left) * sx, (e.clientY - rect.top) * sy];
}

function onCanvasDown(e) {
  const svg = document.querySelector('#preview svg');
  if (!svg) return;
  const rect = svg.getBoundingClientRect();
  const sx = state.doc.w / rect.width, sy = state.doc.h / rect.height;
  const [ux, uy] = userCoords(e, rect, sx, sy);

  const handle = e.target.closest('[data-handle]');
  if (handle && state.selectedId) {
    const L = state.layers.find((l) => l.id === state.selectedId);
    if (!L) return;
    const center = shapeCenter(L.shape);
    const [bx, by, bw, bh] = shapeBBox(L.shape);
    const bbox = [bx - center[0], by - center[1], bw, bh];      // local frame
    const i = +handle.getAttribute('data-handle');
    const corner = [[bbox[0], bbox[1]], [bbox[0] + bw, bbox[1]],
                    [bbox[0] + bw, bbox[1] + bh], [bbox[0], bbox[1] + bh]][i];
    drag = { mode: 'resize', L, rect, sx, sy, snap: clone(L.shape), center, bbox, corner };
    e.preventDefault();
    return;
  }

  const shapeEl = e.target.closest('[data-id]');
  if (shapeEl) {
    const id = shapeEl.getAttribute('data-id');
    const L = state.layers.find((l) => l.id === id);
    if (!L) return;
    if (state.selectedId !== id) { state.selectedId = id; renderControls(); scrollActiveIntoView(); }
    drag = { mode: 'move', L, rect, sx, sy, snap: clone(L.shape), startUser: [ux, uy] };
    renderSVG();
    e.preventDefault();
    return;
  }

  if (state.selectedId) { state.selectedId = null; renderControls(); renderSVG(); }
}

function onCanvasMove(e) {
  if (!drag) return;
  e.preventDefault();
  pendingMouse = e;
  if (!rafQueued) { rafQueued = true; requestAnimationFrame(applyDrag); }
}

function applyDrag() {
  rafQueued = false;
  if (!drag || !pendingMouse) return;
  const [ux, uy] = userCoords(pendingMouse, drag.rect, drag.sx, drag.sy);
  if (drag.mode === 'move') {
    translateShape(drag.L.shape, drag.snap, ux - drag.startUser[0], uy - drag.startUser[1]);
  } else {
    resizeShape(drag, ux, uy, { alt: pendingMouse.altKey, shift: pendingMouse.shiftKey });
  }
  renderSVG();
}

function roundShape(sh) {
  for (const k in sh) {
    if (typeof sh[k] === 'number') sh[k] = r1(sh[k]);
    else if (k === 'points') sh.points = sh.points.map((p) => [r1(p[0]), r1(p[1])]);
  }
}

function onCanvasUp() {
  if (!drag) return;
  roundShape(drag.L.shape);
  drag = null;
  renderAll();        // sync the numeric fields with the dragged geometry
}

function scrollActiveIntoView() {
  const a = document.querySelector('.panel .layer.active');
  if (a) a.scrollIntoView({ block: 'nearest' });
}

function initCanvas() {
  document.getElementById('preview').addEventListener('pointerdown', onCanvasDown);
  window.addEventListener('pointermove', onCanvasMove);
  window.addEventListener('pointerup', onCanvasUp);
  window.addEventListener('keydown', onKey);
  // A new click starts a new action: commit whatever the previous one left pending,
  // so two quick button presses become two undo steps.
  window.addEventListener('pointerdown', () => flushHistory(), true);
}

/* ---------- Boot ---------- */
if (typeof document !== 'undefined') {
  loadDefault();
  flushHistory();      // seed the stable snapshot; nothing to undo yet
  initCanvas();
} else if (typeof module !== 'undefined') {
  module.exports = { state, anim, buildSVG, setFormat, reformat, FORMATS, exportPixels, undo, redo, flushHistory };  // headless / tests
}
