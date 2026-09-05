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
  animation: { bpm: 120, scroll: 0, drift: 0, flipEvery: 0, loopBeats: 8, audioGain: 1 },
  scenes: [],                    // saved snapshots of design + motion, played in order
  sequence: { loop: true },
  grid: { show: true, snap: true, cols: 12, rows: 0, margin: 0 },   // editing aid, never exported
};

const seq = { playing: false, index: -1 };   // sequence playback (runtime, not in history)

const anim = { playing: false, beats: 0, last: 0, raf: 0 };
const ui = { tab: 'static', layout: 'tabs', setup: false };   // tab: 'static' | 'motion' | 'sequence'; layout: 'tabs' | 'split'; setup: right panel open
try {
  if (localStorage.getItem('linework.layout') === 'split') ui.layout = 'split';
  if (localStorage.getItem('linework.setup') === '1') ui.setup = true;
} catch (e) { /* private mode etc. */ }

function setLayout(l) {
  ui.layout = l;
  try { localStorage.setItem('linework.layout', l); } catch (e) { /* ignore */ }
  renderControls();
}

function toggleSetup() {
  ui.setup = !ui.setup;
  try { localStorage.setItem('linework.setup', ui.setup ? '1' : '0'); } catch (e) { /* ignore */ }
  renderControls();
}

/* ---------- Motion curves (shared by layers and the base field) ----------
   cycleF: 1 on the beat, back to 0 over the period (smooth / snap / punch).
   travelF: 0 = start, 1 = end, over `period` beats; return: pingpong / jump / hold. */
function cycleF(b, period, off, mode) {
  const u = (((b - (off || 0)) / (period || 1)) % 1 + 1) % 1;
  switch (mode) {
    case 'snap':  return u < 0.5 ? 1 : 0;
    case 'punch': return (1 - u) * (1 - u);
    default:      return (1 + Math.cos(2 * Math.PI * u)) / 2;
  }
}

function travelF(b, period, off, mode, ease) {
  const u = (b - (off || 0)) / (period || 4);
  let f;
  switch (mode) {
    case 'jump': f = u < 0 ? 0 : u % 1; break;
    case 'hold': f = Math.min(1, Math.max(0, u)); break;
    default: { const t = ((u % 2) + 2) % 2; f = t < 1 ? t : 2 - t; }
  }
  return ease === 'linear' ? f : (1 - Math.cos(Math.PI * f)) / 2;
}

/* Value between Min and Max (% -> factor) for a "size-like" parameter.
   Fields on `o` with prefix `pre`: Min, Max, Drive, Start ('large' | 'small' = the
   value on the beat), Travel (beats from one to the other), Offset, Return
   ('pingpong' | 'jump' | 'hold' | 'snap'), Ease ('smooth' | 'linear' | 'punch').
   Legacy Period + Mode fields are translated on the fly. */
function cycleValue(o, pre, b) {
  const lo = o[pre + 'Min'] ?? 100, hi = o[pre + 'Max'] ?? 100;
  if (lo === hi) return lo / 100;
  const drive = o[pre + 'Drive'];
  let f;                                                   // 0 = Small, 1 = Large
  if (drive && drive !== 'clock') {
    f = soundLevel(drive);
  } else {
    let ret = o[pre + 'Return'], travel = o[pre + 'Travel'], ease = o[pre + 'Ease'];
    const start = o[pre + 'Start'] || 'large';
    if (!ret) {                                            // legacy: Period + Mode
      const m = o[pre + 'Mode'] || 'smooth', P = o[pre + 'Period'] || 1;
      ret = m === 'snap' ? 'snap' : m === 'punch' ? 'jump' : 'pingpong';
      travel = m === 'punch' ? P : P / 2;
      ease = m === 'punch' ? 'punch' : 'smooth';
    }
    const u = (b - (o[pre + 'Offset'] || 0)) / (travel || 0.5);
    let t;                                                 // 0 = at the start value, 1 = at the other
    switch (ret) {
      case 'snap': t = ((u % 2) + 2) % 2 < 1 ? 0 : 1; break;
      case 'jump': t = u < 0 ? 0 : u % 1; break;
      case 'hold': t = Math.min(1, Math.max(0, u)); break;
      default: { const w = ((u % 2) + 2) % 2; t = w < 1 ? w : 2 - w; }
    }
    if (ease === 'punch') t = 1 - (1 - t) * (1 - t);        // fast away, soft arrival
    else if (ease !== 'linear') t = (1 - Math.cos(Math.PI * t)) / 2;
    f = start === 'large' ? 1 - t : t;
  }
  return (lo + (hi - lo) * f) / 100;
}

function soundLevel(band) {
  return audio.kind === 'off' ? 0 : (audio.levels[band] || 0);
}

/* Animated view of the design at the current clock (pure: no state mutation) */
function animated() {
  const a = state.animation, b = anim.beats;
  const flip = a.flipEvery > 0 && Math.floor(b / a.flipEvery) % 2 === 1;
  // base line width between Small and Large (% of x); layers that inherit x follow
  const baseLine = Math.max(0.5, state.base.line * cycleValue(a, 'line', b));
  // base angle: drift (continuous) + swing towards an end angle
  let delta = (a.drift || 0) * b;
  if (a.swingOn && a.swingTo != null) {
    const f = (a.swingDrive && a.swingDrive !== 'clock') ? soundLevel(a.swingDrive) : travelF(b, a.swingPeriod, a.swingOffset, a.swingMode, a.swingEase);
    delta += (a.swingTo - state.base.angle) * f;
  }
  return {
    phase: a.scroll * b * baseLine * 1.5,           // lines/beat -> user units (one period per line)
    angle: state.base.angle + delta,
    angleDelta: delta,                              // layers' stripe angles move with the base
    baseLine,
    invert: state.invert !== flip,
    // spin: continuous (°/beat), step (°/step, hard turn every N beats) or punch (fast eased turn on the beat)
    layerRotate: (L) => {
      const s = L.spin || 0;
      if (!s) return L.rotate;
      const mode = L.spinMode || 'continuous';
      if (mode === 'continuous') return L.rotate + s * b;
      const u = b / (L.spinEvery || 1), n = Math.floor(u), t = u - n;
      if (mode === 'step') return L.rotate + s * n;
      return L.rotate + s * (n + (1 - Math.pow(1 - t, 4)));      // punch: most of the turn right after the beat
    },
    // move: from the design position (start) to the End point. f = 0 start, 1 end.
    layerOffset: (L) => {
      if (!L.moveOn || L.moveX == null) return [0, 0];
      const [cx, cy] = shapeCenter(L.shape);
      const f = (L.moveDrive && L.moveDrive !== 'clock') ? soundLevel(L.moveDrive)
              : travelF(b, L.movePeriod, L.moveOffset, L.moveMode, L.moveEase);
      return [(L.moveX - cx) * f, (L.moveY - cy) * f];
    },
    // size: moves between Small and Large (% of design size). On the beat
    // (offset) the shape is at Large; how it returns depends on the motion.
    layerScale: (L) => cycleValue({ ...L, sizeDrive: L.drive }, 'size', b),
  };
}

/* Scaled copy of a shape about its centre (geometry, not a transform:
   the stripe pattern and the border width must stay at x). */
function scaledShape(s, k) {
  if (k === 1) return s;
  const [cx, cy] = shapeCenter(s);
  const q = (v) => Math.round(v * 100) / 100;
  const X = (x) => q(cx + (x - cx) * k), Y = (y) => q(cy + (y - cy) * k), S = (v) => q(v * k);
  switch (s.type) {
    case 'circle':  return { ...s, r: S(s.r) };
    case 'sector':  return { ...s, r: S(s.r) };
    case 'ellipse': return { ...s, rx: S(s.rx), ry: S(s.ry) };
    case 'rect':    return { ...s, x: X(s.x), y: Y(s.y), w: S(s.w), h: S(s.h), r: S(s.r) };
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
           spin: 0, sizeMin: 100, sizeMax: 100, sizeStart: 'large', sizeTravel: 0.5, sizeOffset: 0, sizeReturn: 'pingpong', sizeEase: 'smooth',
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
let viewBaseLine = 16;    // animated base line width (user units)
let viewAngleDelta = 0;   // animated base angle change, applied to layer stripes too

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
  // stripes (layer angles move together with the base, so relations hold)
  const line = op.line > 0 ? op.line : viewBaseLine;
  const angle = r1((op.angle + viewAngleDelta) % 360);
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
  viewBaseLine = r1(view.baseLine);
  viewAngleDelta = view.angleDelta;
  const baseAngle = r1(view.angle % 360);
  const patterns = new Map();
  const baseKey = patKey(baseAngle, viewBaseLine, state.base.inverted);
  patterns.set(baseKey, patDef(baseAngle, viewBaseLine, state.base.inverted));

  let body = `<rect x="0" y="0" width="${w}" height="${h}" fill="${paper()}"/>`
           + `<rect x="0" y="0" width="${w}" height="${h}" fill="url(#${baseKey})"/>`;

  for (const L of state.layers) {
    if (!L.visible || !layerActive(L)) continue;
    const attrs = layerAttrs(L, patterns);
    let shape = scaledShape(L.shape, view.layerScale(L));
    const [ox, oy] = view.layerOffset(L);
    if (ox || oy) { const m = clone(shape); translateShape(m, shape, ox, oy); shape = m; }
    const [cx, cy] = shapeCenter(shape);
    const rot = r1(view.layerRotate(L));
    const tf = rot ? `rotate(${rot} ${cx} ${cy})` : '';
    const border = (L.border && L.op.type !== 'outline')
      ? ` stroke="${col(L.borderColor || 'ink')}" stroke-width="${viewBaseLine}" stroke-linejoin="miter"` : '';
    const meta = forExport ? '' : ` class="shape" data-id="${L.id}"`;
    body += shapeMarkup(shape, attrs + border + meta, tf);
  }

  if (!forExport && state.grid && state.grid.show) body += gridOverlay();
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
  updatePlayhead();
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
                          animation: state.animation, scenes: state.scenes, sequence: state.sequence,
                          grid: state.grid });
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
    autosave();
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
  return el('div', { class: 'hist' },
    el('button', { type: 'button', id: 'undo', class: 'mini', title: '⌘/Ctrl+Z', onclick: undo }, '↶ Undo'),
    el('button', { type: 'button', id: 'redo', class: 'mini', title: '⇧⌘Z / Ctrl+Y', onclick: redo }, '↷ Redo'));
}

function layoutToggle() {
  const split = ui.layout === 'split';
  return el('button', { type: 'button', class: 'mini', title: 'Show the three panels as tabs or side by side',
                        onclick: () => setLayout(split ? 'tabs' : 'split') },
            split ? '⊟ Tabs' : '⊞ Side by side');
}

function setupToggle() {
  return el('button', { type: 'button', class: 'mini' + (ui.setup ? ' active' : ''),
                        title: 'Document, grid and base field (right panel)', onclick: toggleSetup },
            '⚙ Setup');
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
  } else if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault(); saveProject();
  } else if (e.key === ' ' && tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT' && tag !== 'BUTTON') {
    e.preventDefault(); anim.playing ? pause() : play();
  } else if ((e.key === 'f' || e.key === 'F') && !mod && !typing && tag !== 'INPUT' && tag !== 'SELECT') {
    e.preventDefault(); toggleFullscreen();
  } else if ((e.key === 'g' || e.key === 'G') && !mod && !typing && tag !== 'INPUT' && tag !== 'SELECT') {
    e.preventDefault(); state.grid.show = !state.grid.show; renderAll();
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
  );
}

/* Motion card: the same layer, only its animation settings */
function motionCard(L) {
  const moving = (L.spin || 0) !== 0 || (L.sizeMin ?? 100) !== (L.sizeMax ?? 100) || !!L.moveOn;
  return el('div', {
      class: 'layer' + (L.id === state.selectedId ? ' active' : ''),
      onclick: (e) => {
        if (e.target.closest('input, select, textarea, button')) return;
        if (state.selectedId !== L.id) { state.selectedId = L.id; renderAll(); }
      },
    },
    el('div', { class: 'lhead' },
      el('span', { class: 'lname' }, L.name),
      el('span', { class: 'hint' }, (L.visible ? '' : 'hidden · ') + (moving ? 'moving' : 'still'))),
    el('p', { class: 'hint' }, (L.tlIn || L.tlOut != null)
      ? `On the timeline: ${L.tlIn || 0} → ${L.tlOut == null ? 'end' : L.tlOut} beats.`
      : 'Visible for the whole scene (set in / out on the timeline under the canvas).'),
    el('div', { class: 'grp' }, 'Spin'),
    selectField('Spin mode', L.spinMode || 'continuous',
      [['continuous', 'continuous (°/beat)'], ['step', 'step on the beat (°/step)'], ['punch', 'punch on the beat (°/step)']],
      (v) => { L.spinMode = v; renderAll(); }),
    numField((L.spinMode || 'continuous') === 'continuous' ? 'Spin (°/beat)' : 'Turn (°/step)', L.spin || 0, -180, 180, 0.5, (v) => { L.spin = v; renderSVG(); }),
    (L.spinMode || 'continuous') !== 'continuous'
      ? numField('Every N beats', L.spinEvery || 1, 0.25, 16, 0.25, (v) => { L.spinEvery = v; renderSVG(); }) : null,
    el('div', { class: 'grp' }, 'Move (start = design position)'),
    checkField('Move to an end position', !!L.moveOn, (v) => {
      L.moveOn = v;
      if (v && L.moveX == null) {                        // first time: put the end a grid cell to the right
        const [cx, cy] = shapeCenter(L.shape);
        L.moveX = r1(Math.min(state.doc.w, cx + gridLines().cw * 2)); L.moveY = cy;
      }
      state.selectedId = L.id; renderAll();
    }),
    ...(L.moveOn ? [
      numField('End x', L.moveX, -state.doc.w, state.doc.w * 2, 1, (v) => { L.moveX = v; renderSVG(); }),
      numField('End y', L.moveY, -state.doc.h, state.doc.h * 2, 1, (v) => { L.moveY = v; renderSVG(); }),
      el('div', { class: 'addrow' },
        btn('End = current position', () => { const [cx, cy] = shapeCenter(L.shape); L.moveX = cx; L.moveY = cy; renderAll(); }),
        btn('Swap start / end', () => {
          const [cx, cy] = shapeCenter(L.shape);
          translateShape(L.shape, clone(L.shape), L.moveX - cx, L.moveY - cy);
          roundShape(L.shape); L.moveX = cx; L.moveY = cy; renderAll();
        })),
      selectField('Drive', L.moveDrive || 'clock', DRIVES, (v) => { L.moveDrive = v; renderAll(); }),
      ...((L.moveDrive || 'clock') === 'clock' ? [
        numField('Travel (beats)', L.movePeriod || 4, 0.25, 64, 0.25, (v) => { L.movePeriod = v; renderSVG(); }),
        numField('Offset (beats)', L.moveOffset || 0, 0, 64, 0.25, (v) => { L.moveOffset = v; renderSVG(); }),
        selectField('Return', L.moveMode || 'pingpong',
          [['pingpong', 'ping-pong (back and forth)'], ['jump', 'jump (restart at start)'], ['hold', 'hold (stay at end)']],
          (v) => { L.moveMode = v; renderSVG(); }),
        selectField('Ease', L.moveEase || 'smooth', [['smooth', 'smooth'], ['linear', 'linear']], (v) => { L.moveEase = v; renderSVG(); }),
      ] : [el('p', { class: 'hint' }, 'Position follows the sound level of that band: quiet = start, loud = end.')]),
      el('p', { class: 'hint' }, 'Drag the dashed ghost on the canvas to place the end. It snaps to the grid.'),
    ] : []),
    el('div', { class: 'grp' }, 'Size'),
    ...cycleFields(L, 'size', 'drive', 'size', renderSVG, renderAll),
  );
}

/* ============================================================
   Formats — switching formats keeps the composition
   ============================================================ */
/* Print formats live in 0.1 mm units (A4 = 2100 x 2970), screen formats in px.
   Portrait dimensions are stored; landscape swaps them. */
const FORMATS = [
  { id: 'A5', label: 'A5', mm: [148, 210], group: 'Print' },
  { id: 'A4', label: 'A4', mm: [210, 297], group: 'Print' },
  { id: 'A3', label: 'A3', mm: [297, 420], group: 'Print' },
  { id: 'A2', label: 'A2', mm: [420, 594], group: 'Print' },
  { id: 'A1', label: 'A1', mm: [594, 841], group: 'Print' },
  { id: 'ig-post', label: 'IG post 1:1', px: [1080, 1080], group: 'Social' },
  { id: 'ig-post-45', label: 'IG post 4:5', px: [1080, 1350], group: 'Social' },
  { id: 'ig-reel', label: 'IG reel 9:16', px: [1080, 1920], group: 'Social' },
  { id: 'hd', label: 'Screen HD 16:9', px: [1080, 1920], group: 'Screen', wide: true },
  { id: 'uhd', label: 'Screen 4K 16:9', px: [2160, 3840], group: 'Screen', wide: true },
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
    if (L.moveX != null) { L.moveX = X(L.moveX); L.moveY = Y(L.moveY); }
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
  const groups = [...new Set(FORMATS.map((f) => f.group))];
  return el('div', {}, ...groups.map((g) => el('div', {},
    el('div', { class: 'grp' }, g),
    el('div', { class: 'addrow fmt' },
      ...FORMATS.filter((f) => f.group === g).map((f) =>
        btn(f.label, () => setFormat(f.id, f.wide ? true : state.doc.landscape),   // screens default to landscape
            'sz' + (f.id === state.doc.format ? ' active' : '')))))));
}


/* ============================================================
   Control panel
   ============================================================ */
function lineInfo() {
  const f = currentFormat();
  if (!f || !f.mm) return '';
  return ` Line x = ${r1(state.base.line / 10)} mm, gap ${r1(state.base.line / 20)} mm.`;
}

const TABS = [['static', 'Static'], ['motion', 'Motion'], ['sequence', 'Sequence']];

function renderControls() {
  if (typeof document === 'undefined') return;
  const host = document.getElementById('panels');
  host.innerHTML = '';
  host.className = 'panels ' + ui.layout;
  document.getElementById('tools').replaceChildren(
    el('span', { class: 'pname-top', title: 'Project name (rename in ⚙ Setup)' }, project.name),
    el('button', { type: 'button', class: 'mini', title: '⌘/Ctrl+S', onclick: saveProject }, '💾 Save'),
    historyRow(), layoutToggle(), setupToggle());

  const setup = document.getElementById('setup');
  setup.innerHTML = '';
  setup.hidden = !ui.setup;
  if (ui.setup) {
    setup.append(el('h2', { class: 'ptitle' }, 'Setup'));
    setup.append(projectSection());
    setup.append(formatSection(true));
    setup.append(gridSection());
    setup.append(baseSection());
  }

  const tabs = ui.layout === 'split' ? TABS.map((t) => t[0]) : [ui.tab];
  for (const t of tabs) {
    const p = el('aside', { class: 'panel' });
    if (ui.layout === 'split') p.append(el('h2', { class: 'ptitle' }, TABS.find((x) => x[0] === t)[1]));
    else p.append(tabRow());
    fillPanel(p, t);
    host.append(p);
  }
  updateHistoryButtons();
}

function formatSection(withCustom) {
  const custom = (k) => (v) => { state.doc[k] = v; state.doc.format = null; renderSVG(); refreshDocInfo(); };
  return section(withCustom ? 'Document' : 'Format', [
    formatRow(),
    checkField('Landscape', state.doc.landscape, (v) => {
      if (state.doc.format) setFormat(state.doc.format, v);
      else { reformat(state.doc.h, state.doc.w); state.doc.landscape = v; renderAll(); }
    }),
    withCustom ? selectField('On format change', state.reformatMode,
      [['fit', 'fit (keep all, field extends)'], ['fill', 'fill (cover, crop edges)']],
      (v) => { state.reformatMode = v; }) : null,
    el('p', { class: 'hint docinfo' }, docInfo()),
    withCustom ? el('p', { class: 'hint' }, 'Formats rescale the whole composition (incl. line width). Width / height below only resize the canvas (custom format).') : null,
    withCustom ? numField('Width', state.doc.w, 100, 10000, 10, custom('w')) : null,
    withCustom ? numField('Height', state.doc.h, 100, 10000, 10, custom('h')) : null,
    withCustom ? checkField('Invert whole image', state.invert, (v) => { state.invert = v; renderSVG(); }) : null,
  ]);
}

function baseSection() {
  return section('Base field', [
    numField('Angle°', state.base.angle, 0, 180, 1, (v) => { state.base.angle = v; renderSVG(); }),
    numField('Line width x', state.base.line, 1, 240, 1, (v) => { state.base.line = v; renderSVG(); }),
    selectField('Line colour', state.base.inverted ? 'paper' : 'ink', COLOURS,
      (v) => { state.base.inverted = v === 'paper'; renderSVG(); }),
    el('p', { class: 'hint' }, 'Gap is locked to x / 2.' + lineInfo()),
  ]);
}

function fillPanel(p, tab) {
  if (tab === 'sequence') { sequenceTab(p); return; }

  if (tab === 'motion') {
    p.append(animationSection());
    p.append(baseMotionSection());
    p.append(audioSection());
    const wrap = el('div', {});
    state.layers.forEach((L) => wrap.append(motionCard(L)));
    p.append(section('Layers', [
      el('p', { class: 'hint' }, 'Per layer: spin and a Small / Large size the shape moves between. Shapes and colours are set in the Static tab.'),
      wrap,
    ]));
    p.append(recordRow());
    return;
  }

  const wrap = el('div', {});
  state.layers.forEach((L, i) => wrap.append(layerCard(L, i)));
  p.append(section('Layers', [
    el('p', { class: 'hint' }, 'Drag a shape to move it; drag a corner square to resize (opposite corner stays). Alt: from centre · Shift: keep proportions. Delete removes the selected layer. Format, grid and base field: ⚙ Setup (top right).'),
    wrap,
    el('div', { class: 'addrow' },
      ...SHAPES.map((t) => btn('+ ' + t, () => { const L = defaultLayer(t); state.layers.push(L); state.selectedId = L.id; renderAll(); }, 'add'))),
  ]));

  p.append(exportSection());
}

function refreshDocInfo() {
  document.querySelectorAll('.docinfo').forEach((d) => { d.textContent = docInfo(); });
}

function renderAll() { renderControls(); renderSVG(); renderTimeline(); updateHistoryButtons(); }

/* ============================================================
   Timeline — per scene, under the canvas
   Length = the scene loaded in the editor (or the loop length). Each
   layer has an in / out point in beats; outside it the layer is hidden.
   The clock wraps around the length, so the playhead loops.
   ============================================================ */
function timelineLength() {
  const sc = seq.index >= 0 ? state.scenes[seq.index] : null;
  return Math.max(0.25, sc ? sc.beats : (state.animation.loopBeats || 8));
}

function sceneBeat() {                       // beat within the scene, wrapping
  const len = timelineLength();
  return ((anim.beats % len) + len) % len;
}

function layerActive(L) {
  const b = sceneBeat(), len = timelineLength();
  const tin = L.tlIn || 0, tout = L.tlOut == null ? Infinity : L.tlOut;
  if (tin <= 0 && tout >= len) return true;
  return b >= tin && b < tout;
}

const TL = { rowH: 20, ruler: 18, left: 110, snap: 0.25 };
let tlDrag = null;

function tlLabel() {
  const sc = seq.index >= 0 ? state.scenes[seq.index] : null;
  return sc ? `${sc.name} · ${sc.beats} beats` : `Loop · ${state.animation.loopBeats || 8} beats`;
}

function renderTimeline() {
  const host = document.getElementById('timeline');
  if (!host) return;
  host.innerHTML = '';
  const len = timelineLength();
  const W = Math.max(200, host.clientWidth - TL.left - 12);
  const rows = state.layers.length;
  const H = TL.ruler + rows * TL.rowH + 6;
  const bx = (b) => TL.left + (b / len) * W;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', TL.left + W + 12);
  svg.setAttribute('height', H);
  svg.setAttribute('class', 'tl');
  const S = (tag, attrs, text) => {
    const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (text != null) n.textContent = text;
    return n;
  };
  // header label
  svg.append(S('text', { x: 4, y: 12, class: 'tl-title' }, tlLabel()));
  // ruler
  svg.append(S('rect', { x: TL.left, y: 0, width: W, height: TL.ruler, class: 'tl-ruler', 'data-tl': 'ruler' }));
  const step = len > 32 ? 4 : len > 16 ? 2 : 1;
  for (let b = 0; b <= len + 1e-9; b += step) {
    const x = bx(b);
    svg.append(S('line', { x1: x, y1: TL.ruler - 5, x2: x, y2: H, class: 'tl-tick' }));
    if (b < len) svg.append(S('text', { x: x + 3, y: 12, class: 'tl-num' }, b));
  }
  for (let b = 0; b < len; b += step / 4) {
    if (Math.abs((b / step) % 1) < 1e-9) continue;
    svg.append(S('line', { x1: bx(b), y1: TL.ruler - 2, x2: bx(b), y2: TL.ruler, class: 'tl-tick' }));
  }
  // rows
  state.layers.forEach((L, i) => {
    const y = TL.ruler + i * TL.rowH + 3, h = TL.rowH - 6;
    const sel = L.id === state.selectedId;
    svg.append(S('rect', { x: 0, y: y - 3, width: TL.left + W + 12, height: TL.rowH, class: 'tl-row' + (sel ? ' sel' : ''), 'data-tl': 'row', 'data-id': L.id }));
    svg.append(S('text', { x: 4, y: y + h - 4, class: 'tl-name' + (L.visible ? '' : ' off'), 'data-tl': 'row', 'data-id': L.id }, L.name));
    const tin = Math.max(0, L.tlIn || 0), tout = Math.min(len, L.tlOut == null ? len : L.tlOut);
    if (tout > tin) {
      const x0 = bx(tin), x1 = bx(tout);
      svg.append(S('rect', { x: x0, y, width: x1 - x0, height: h, rx: 3, class: 'tl-bar' + (sel ? ' sel' : ''), 'data-tl': 'bar', 'data-id': L.id }));
      svg.append(S('rect', { x: x0 - 3, y, width: 6, height: h, class: 'tl-edge', 'data-tl': 'in', 'data-id': L.id }));
      svg.append(S('rect', { x: x1 - 3, y, width: 6, height: h, class: 'tl-edge', 'data-tl': 'out', 'data-id': L.id }));
    }
  });
  // playhead
  const px = bx(sceneBeat());
  svg.append(S('line', { id: 'tl-head', x1: px, y1: 0, x2: px, y2: H, class: 'tl-head' }));
  host.append(svg);
  host._geom = { len, W, bx };
}

function updatePlayhead() {
  const host = document.getElementById('timeline');
  const head = document.getElementById('tl-head');
  if (!host || !head || !host._geom) return;
  const x = host._geom.bx(sceneBeat());
  head.setAttribute('x1', x); head.setAttribute('x2', x);
}

function tlBeatAt(clientX) {
  const host = document.getElementById('timeline');
  const svg = host.querySelector('svg');
  const r = svg.getBoundingClientRect();
  const { len, W } = host._geom;
  const b = ((clientX - r.left) - TL.left) / W * len;
  return Math.max(0, Math.min(len, b));
}

function onTimelineDown(e) {
  const t = e.target.closest('[data-tl]');
  if (!t) return;
  const kind = t.getAttribute('data-tl');
  const id = t.getAttribute('data-id');
  const L = id ? state.layers.find((l) => l.id === id) : null;
  if (kind === 'ruler') {                                  // scrub / jump
    const b = tlBeatAt(e.clientX);
    anim.beats = Math.floor(anim.beats / timelineLength()) * timelineLength() + b;
    tlDrag = { kind: 'scrub' };
    paint();
    e.preventDefault();
    return;
  }
  if (!L) return;
  if (state.selectedId !== L.id) { state.selectedId = L.id; renderControls(); renderSVG(); }
  if (kind === 'row') return;
  const len = timelineLength();
  const tin = L.tlIn || 0, tout = L.tlOut == null ? len : L.tlOut;
  tlDrag = { kind, L, tin, tout, b0: tlBeatAt(e.clientX), len };
  e.preventDefault();
}

function onTimelineMove(e) {
  if (!tlDrag) return;
  if (tlDrag.kind === 'scrub') {
    const b = tlBeatAt(e.clientX);
    anim.beats = Math.floor(anim.beats / timelineLength()) * timelineLength() + b;
    paint();
    return;
  }
  const q = (v) => Math.round(v / TL.snap) * TL.snap;
  const d = tlBeatAt(e.clientX) - tlDrag.b0;
  const { L, tin, tout, len } = tlDrag;
  if (tlDrag.kind === 'in') {
    L.tlIn = Math.max(0, Math.min(tout - TL.snap, q(tin + d)));
  } else if (tlDrag.kind === 'out') {
    const v = Math.min(len, Math.max(tin + TL.snap, q(tout + d)));
    L.tlOut = v >= len ? null : v;
  } else {                                                 // bar: move both
    const w = tout - tin;
    let ni = q(tin + d);
    ni = Math.max(0, Math.min(len - w, ni));
    L.tlIn = ni;
    L.tlOut = ni + w >= len ? null : ni + w;
  }
  if (L.tlIn === 0) delete L.tlIn;
  renderTimeline();
  paint();
}

function onTimelineUp() {
  if (!tlDrag) return;
  const was = tlDrag.kind;
  tlDrag = null;
  if (was !== 'scrub') markDirty();
}

function initTimeline() {
  const host = document.getElementById('timeline');
  host.addEventListener('pointerdown', onTimelineDown);
  window.addEventListener('pointermove', onTimelineMove);
  window.addEventListener('pointerup', onTimelineUp);
  window.addEventListener('resize', renderTimeline);
}

/* ============================================================
   Projects — save / load
   Autosave in this browser on every history step; named projects in
   localStorage; JSON files for backup, transfer and version control.
   ============================================================ */
const project = { name: 'Untitled' };
const PKEY = 'linework.projects', AKEY = 'linework.autosave';

function projectData() {
  return { app: 'linework', version: 1, name: project.name,
           savedAt: new Date().toISOString(), state: JSON.parse(serialize()) };
}

function listProjects() {
  try { return JSON.parse(localStorage.getItem(PKEY) || '{}'); } catch (e) { return {}; }
}

function writeProjects(all) {
  try { localStorage.setItem(PKEY, JSON.stringify(all)); return true; }
  catch (e) { alert('Could not save in this browser: ' + e.message); return false; }
}

function saveProject() {
  const name = (project.name || '').trim() || 'Untitled';
  project.name = name;
  const all = listProjects();
  all[name] = projectData();
  if (writeProjects(all)) renderControls();
}

function deleteProject(name) {
  const all = listProjects();
  delete all[name];
  writeProjects(all);
  renderControls();
}

/* ids must stay unique after a load: continue numbering past the highest one */
function bumpUid(json) {
  let max = 0;
  json.replace(/"L(\d+)"/g, (m, n) => { max = Math.max(max, +n); return m; });
  if (max >= _uid) _uid = max + 1;
}

function loadProjectData(d, opts) {
  if (!d || d.app !== 'linework' || !d.state) { alert('Not a Linework project file.'); return false; }
  pause();
  seq.playing = false;
  Object.assign(state, d.state);
  if (!state.grid) state.grid = { show: true, snap: true, cols: 12, rows: 0, margin: 0 };
  if (!state.scenes) state.scenes = [];
  if (!state.sequence) state.sequence = { loop: true };
  project.name = d.name || 'Untitled';
  state.selectedId = null;
  anim.beats = 0;
  bumpUid(JSON.stringify(d.state));
  undoStack = []; redoStack = []; stable = null;
  renderAll();
  flushHistory();                        // fresh history baseline
  if (!(opts && opts.silent)) autosave();
  return true;
}

function loadProject(name) {
  const d = listProjects()[name];
  if (d) loadProjectData(d);
}

function autosave() {
  try { localStorage.setItem(AKEY, JSON.stringify(projectData())); } catch (e) { /* quota / private mode */ }
}

function restoreAutosave() {
  try {
    const raw = localStorage.getItem(AKEY);
    if (!raw) return false;
    return loadProjectData(JSON.parse(raw), { silent: true });
  } catch (e) { return false; }
}

function exportProject() {
  const name = (project.name || 'Untitled').replace(/[^\w\- ]+/g, '').trim() || 'Untitled';
  download(new Blob([JSON.stringify(projectData(), null, 2)], { type: 'application/json' }), name + '.linework.json');
}

function importProjectFile(file) {
  const fr = new FileReader();
  fr.onload = () => { try { loadProjectData(JSON.parse(fr.result)); } catch (e) { alert('Could not read this file: ' + e.message); } };
  fr.readAsText(file);
}

function newProject() {
  if (!confirm('Start a new project? The current one stays saved only if you saved it.')) return;
  loadDefault();
  project.name = 'Untitled';
  undoStack = []; redoStack = []; stable = null;
  flushHistory();
  autosave();
  renderControls();
}

function projectSection() {
  const all = listProjects();
  const names = Object.keys(all).sort((a, b) => (all[b].savedAt || '').localeCompare(all[a].savedAt || ''));
  const fileInput = el('input', { type: 'file', accept: '.json,application/json',
    onchange: (e) => { const f = e.target.files[0]; if (f) importProjectFile(f); e.target.value = ''; } });
  const when = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
  return section('Project', [
    el('label', { class: 'row' }, el('span', { class: 'lbl' }, 'Name'),
       el('input', { type: 'text', value: project.name, oninput: (e) => { project.name = e.target.value; } })),
    el('div', { class: 'addrow' },
      btn('Save in browser', saveProject),
      btn('Save as file', exportProject),
      btn('Open file…', () => fileInput.click()),
      btn('New', newProject, 'danger')),
    el('div', { hidden: true }, fileInput),
    names.length ? el('div', { class: 'plist' }, ...names.map((n) => el('div', { class: 'pitem' + (n === project.name ? ' cur' : '') },
      el('span', { class: 'pname', title: when(all[n].savedAt) }, n),
      el('span', { class: 'hint' }, when(all[n].savedAt)),
      btn('Load', () => loadProject(n), 'mini'),
      btn('✕', () => { if (confirm(`Delete "${n}"?`)) deleteProject(n); }, 'mini danger')))) : null,
    el('p', { class: 'hint' }, 'The current state is also autosaved in this browser and restored when you come back. ⌘/Ctrl+S saves under the current name. Files are plain JSON.'),
  ]);
}

/* ============================================================
   Scenes & sequence
   A scene is a snapshot of the whole design + motion settings, with a
   length in beats. The sequence plays scenes in order (hard cuts).
   ============================================================ */
const SCENE_KEYS = ['doc', 'base', 'invert', 'layers', 'animation'];

function sceneSnapshot() {
  const s = {};
  SCENE_KEYS.forEach((k) => { s[k] = clone(state[k]); });
  return s;
}

function addScene() {
  const n = state.scenes.length + 1;
  state.scenes.push({ id: nid(), name: 'Scene ' + n, beats: 8, snap: sceneSnapshot() });
  renderAll();
}

function updateScene(i) {
  state.scenes[i].snap = sceneSnapshot();
  renderAll();
}

/* Load a scene into the editor. During playback the load is "silent":
   it is not an undo step (the design jumps back and forth by design). */
function loadScene(i, silent) {
  const sc = state.scenes[i];
  if (!sc) return;
  Object.assign(state, clone(sc.snap));
  state.selectedId = null;
  anim.beats = 0;
  seq.index = i;
  renderAll();
  if (silent) { flushHistory(); undoStack.pop(); stable = serialize(); updateHistoryButtons(); }
}

function sequenceBeats() { return state.scenes.reduce((t, s) => t + (s.beats || 0), 0); }

function playSequence() {
  if (!state.scenes.length) return;
  seq.playing = true;
  loadScene(0, true);
  play();
}

function stopSequence() {
  seq.playing = false;
  renderControls();
}

/* Called every frame while the clock runs. Returns 'end' when the last
   scene finished (the caller decides: loop, stop, or end the recording). */
function advanceSequence() {
  if (!seq.playing) return 'hold';
  const sc = state.scenes[seq.index];
  if (!sc || anim.beats < sc.beats) return 'hold';
  const next = seq.index + 1;
  if (next >= state.scenes.length) return 'end';
  loadScene(next, true);
  return 'next';
}

/* ---------- Sequence files ---------- */
function exportSequence() {
  if (!state.scenes.length) { alert('No scenes to save yet.'); return; }
  const d = { app: 'linework-sequence', version: 1, name: project.name, savedAt: new Date().toISOString(),
              sequence: clone(state.sequence), scenes: clone(state.scenes) };
  const name = (project.name || 'Untitled').replace(/[^\w\- ]+/g, '').trim() || 'Untitled';
  download(new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' }), name + '.sequence.json');
}

function importSequenceFile(file) {
  const fr = new FileReader();
  fr.onload = () => {
    let d;
    try { d = JSON.parse(fr.result); } catch (e) { alert('Could not read this file: ' + e.message); return; }
    if (!d || d.app !== 'linework-sequence' || !Array.isArray(d.scenes)) { alert('Not a Linework sequence file.'); return; }
    const replace = state.scenes.length ? confirm(`Replace the ${state.scenes.length} current scene(s)?\nCancel appends the ${d.scenes.length} loaded scene(s) instead.`) : true;
    const incoming = d.scenes.map((s) => ({ ...s, id: nid() }));
    bumpUid(JSON.stringify(incoming));
    if (replace) { state.scenes = incoming; if (d.sequence) state.sequence = { ...state.sequence, ...d.sequence }; }
    else state.scenes.push(...incoming);
    seq.playing = false; seq.index = -1;
    renderAll();
  };
  fr.readAsText(file);
}

function sceneCard(sc, i) {
  const active = seq.playing && seq.index === i;
  return el('div', { class: 'layer' + (active ? ' active' : '') },
    el('div', { class: 'lhead' },
      el('input', { type: 'text', class: 'lname', value: sc.name, oninput: (e) => { sc.name = e.target.value; markDirty(); } }),
      btn('▲', () => { if (i > 0) { [state.scenes[i - 1], state.scenes[i]] = [state.scenes[i], state.scenes[i - 1]]; renderAll(); } }, 'mini'),
      btn('▼', () => { if (i < state.scenes.length - 1) { [state.scenes[i + 1], state.scenes[i]] = [state.scenes[i], state.scenes[i + 1]]; renderAll(); } }, 'mini'),
      btn('✕', () => { state.scenes.splice(i, 1); if (seq.index >= state.scenes.length) seq.index = -1; renderAll(); }, 'mini danger')),
    numField('Length (beats)', sc.beats, 1, 256, 1, (v) => { sc.beats = v; renderTimeline(); markDirty(); }),
    el('div', { class: 'addrow' },
      btn('Load into editor', () => { seq.playing = false; loadScene(i); }),
      btn('Update from editor', () => updateScene(i))),
    el('p', { class: 'hint' }, `${sc.snap.layers.length} layer${sc.snap.layers.length === 1 ? '' : 's'} · ${sc.snap.doc.w} × ${sc.snap.doc.h} · ${sc.snap.animation.bpm} bpm`));
}

function sequenceTab(p) {
  const total = sequenceBeats();
  const wrap = el('div', {});
  state.scenes.forEach((sc, i) => wrap.append(sceneCard(sc, i)));
  p.append(section('Scenes', [
    el('p', { class: 'hint' }, 'A scene is the whole design plus its motion, frozen as it is now. Build it in Static and Motion, then add it here. Scenes play in order with hard cuts.'),
    wrap,
    el('div', { class: 'addrow' }, btn('+ Add scene from editor', addScene, 'add')),
  ]));
  p.append(section('Playback', [
    el('div', { class: 'addrow' },
      el('button', { type: 'button', id: 'seqplay', onclick: () => (seq.playing ? (stopSequence(), pause()) : playSequence()) },
         seq.playing ? '■ Stop sequence' : '▶ Play sequence'),
      btn('⛶ Fullscreen', toggleFullscreen)),
    checkField('Loop', state.sequence.loop, (v) => { state.sequence.loop = v; markDirty(); }),
    el('p', { class: 'hint' }, `Total length: ${total} beats` + (state.scenes.length ? ` (${(total * 60 / (state.animation.bpm || 120)).toFixed(1)} s at the editor's BPM)` : '')),
  ]));
  p.append(section('Record', [
    el('div', { class: 'addrow' },
      el('button', { type: 'button', class: 'recbtn', disabled: rec.busy ? 'true' : null,
                     onclick: () => recordLoop(total, true) }, rec.busy ? '● Recording…' : '● Record sequence')),
    el('p', { class: 'hint' }, 'Records all scenes once, in real time, with sound if a source is active.'),
  ]));
  const seqFile = el('input', { type: 'file', accept: '.json,application/json',
    onchange: (e) => { const f = e.target.files[0]; if (f) importSequenceFile(f); e.target.value = ''; } });
  p.append(section('Sequence file', [
    el('div', { class: 'addrow' },
      btn('Download sequence', exportSequence),
      btn('Upload sequence…', () => seqFile.click())),
    el('div', { hidden: true }, seqFile),
    el('p', { class: 'hint' }, 'All scenes and the loop setting as one JSON file. Uploading asks whether to replace the current scenes or append.'),
  ]));
}

/* ============================================================
   Audio — sound-driven motion
   Source: microphone / line-in, or an audio file. Three band levels
   (low / mid / high, 0..1) are measured every frame; a layer can let a
   band drive its size instead of the clock.
   ============================================================ */
const audio = { ctx: null, analyser: null, src: null, stream: null, el: null,
                kind: 'off', data: null, levels: { low: 0, mid: 0, high: 0, all: 0 } };
const BANDS = { low: [20, 160], mid: [160, 2000], high: [2000, 12000], all: [20, 12000] };

async function setAudioSource(kind, file) {
  stopAudio();
  if (kind === 'off') { renderControls(); return; }
  try {
    audio.ctx = audio.ctx || new (window.AudioContext || window.webkitAudioContext)();
    await audio.ctx.resume();
    const an = audio.ctx.createAnalyser();
    an.fftSize = 2048;
    an.smoothingTimeConstant = 0.5;
    audio.analyser = an;
    audio.data = new Uint8Array(an.frequencyBinCount);
    if (kind === 'mic') {
      audio.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      audio.src = audio.ctx.createMediaStreamSource(audio.stream);
      audio.src.connect(an);                          // analyse only: no monitoring (feedback)
    } else {
      if (!file) return;
      audio.el = new Audio(URL.createObjectURL(file));
      audio.el.loop = true;
      audio.src = audio.ctx.createMediaElementSource(audio.el);
      audio.src.connect(an);
      an.connect(audio.ctx.destination);
      await audio.el.play();
    }
    audio.kind = kind;
    if (!anim.playing) play();                        // frames are needed to see the sound
  } catch (err) {
    alert('Audio source failed: ' + err.message);
    stopAudio();
  }
  renderControls();
}

function stopAudio() {
  if (audio.stream) audio.stream.getTracks().forEach((t) => t.stop());
  if (audio.el) { audio.el.pause(); URL.revokeObjectURL(audio.el.src); }
  if (audio.src) audio.src.disconnect();
  if (audio.analyser) audio.analyser.disconnect();
  audio.stream = audio.el = audio.src = audio.analyser = null;
  audio.kind = 'off';
  audio.levels = { low: 0, mid: 0, high: 0, all: 0 };
}

function analyseAudio() {
  const an = audio.analyser;
  if (!an) return;
  an.getByteFrequencyData(audio.data);
  const hz = audio.ctx.sampleRate / an.fftSize;
  const gain = state.animation.audioGain || 1;
  for (const b in BANDS) {
    const [f0, f1] = BANDS[b];
    const i0 = Math.max(0, Math.floor(f0 / hz)), i1 = Math.min(audio.data.length - 1, Math.ceil(f1 / hz));
    let sum = 0;
    for (let i = i0; i <= i1; i++) sum += audio.data[i];
    const raw = Math.min(1, (sum / (i1 - i0 + 1) / 255) * gain);
    const prev = audio.levels[b];
    audio.levels[b] = raw > prev ? raw : prev * 0.82 + raw * 0.18;   // fast attack, slower release
  }
  updateMeters();
}

function updateMeters() {
  for (const b in BANDS) {
    const m = document.getElementById('meter-' + b);
    if (m) m.style.width = (audio.levels[b] * 100).toFixed(1) + '%';
  }
}

function audioSection() {
  const a = state.animation;
  const fileInput = el('input', { type: 'file', accept: 'audio/*',
    onchange: (e) => { const f = e.target.files[0]; if (f) setAudioSource('file', f); } });
  const meters = el('div', { class: 'meters' }, ...['low', 'mid', 'high'].map((b) =>
    el('div', { class: 'meter' }, el('span', { class: 'mlbl' }, b),
       el('div', { class: 'mbar' }, el('div', { class: 'mfill', id: 'meter-' + b })))));
  return section('Audio', [
    selectField('Source', audio.kind,
      [['off', 'off (clock only)'], ['mic', 'microphone / line-in'], ['file', 'audio file']],
      (v) => { if (v === 'file') fileInput.click(); else setAudioSource(v); }),
    audio.kind === 'file' && audio.el ? el('p', { class: 'hint' }, 'Playing file (loops). Choose "audio file" again to load another.') : null,
    el('div', { hidden: true }, fileInput),
    numField('Gain', a.audioGain || 1, 0.2, 8, 0.1, (v) => { a.audioGain = v; markDirty(); }),
    meters,
    el('p', { class: 'hint' }, 'Per layer, set Drive to a band: its size then follows the sound level between Small and Large instead of the clock. With a file source, recordings include the audio.'),
  ]);
}

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
  if (audio.kind !== 'off') analyseAudio();
  if (advanceSequence() === 'end') {
    if (state.sequence.loop) loadScene(0, true);
    else { stopSequence(); pause(); paint(); return; }
  }
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

/* ---------- Record a loop (WebM) ----------
   Real-time capture of a canvas fed with the SVG frames, via MediaRecorder.
   Length in beats; pick a multiple of every period for a seamless loop. */
const rec = { busy: false };

function recordPixels() {                      // screen formats native, others capped to 1920 on the long side
  const f = currentFormat(), { w, h } = state.doc;
  if (f && f.px) return [w, h];
  const k = Math.min(1, 1920 / Math.max(w, h));
  return [Math.round(w * k / 2) * 2, Math.round(h * k / 2) * 2];
}

function recordLoop(beats, sequence) {
  if (rec.busy || typeof MediaRecorder === 'undefined') return;
  if (sequence && !state.scenes.length) return;
  const mime = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm', 'video/mp4'].find((m) => MediaRecorder.isTypeSupported(m));
  if (!mime) { alert('This browser cannot record video (MediaRecorder unsupported).'); return; }
  const [W, H] = recordPixels();
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const stream = c.captureStream(0);              // we push frames explicitly after each draw
  const track = stream.getVideoTracks()[0];
  if (audio.kind !== 'off' && audio.src) {                   // mix the sound into the recording
    const dest = audio.ctx.createMediaStreamDestination();
    audio.src.connect(dest);
    dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
    if (audio.el) { audio.el.currentTime = 0; }                // file starts with the recording
  }
  const mr = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 16e6 });
  const chunks = [];
  mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  mr.onstop = () => {
    download(new Blob(chunks, { type: mime }), exportName(mime.includes('mp4') ? 'mp4' : 'webm'));
    rec.busy = false;
    anim.beats = 0;
    if (wasPlaying) play(); else paint();
    renderControls();
  };

  const wasPlaying = anim.playing;
  pause();
  rec.busy = true;
  if (sequence) { seq.playing = true; loadScene(0, true); } else anim.beats = 0;
  syncRecordButton();
  const total = beats;
  let last = performance.now(), done = 0, stopped = false;

  const frame = () => {
    if (stopped) return;
    const now = performance.now(), dt = (now - last) / 1000;
    last = now;
    const db = dt * state.animation.bpm / 60;       // beats this frame (BPM may differ per scene)
    anim.beats += db;
    done += db;
    const ended = sequence ? advanceSequence() === 'end' : done >= total;
    if (ended) { stopped = true; if (sequence) seq.playing = false; setTimeout(() => mr.stop(), 300); return; }   // let the encoder flush
    if (audio.kind !== 'off') analyseAudio();
    const svg = buildSVG(true);
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, W, H);
      if (track.requestFrame) track.requestFrame();
      rec.frames++;
      paint();                                       // keep the stage in sync
      requestAnimationFrame(frame);
    };
    img.onerror = () => requestAnimationFrame(frame);
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  };
  rec.frames = 0;
  mr.start(500);
  frame();
}

function syncRecordButton() {
  document.querySelectorAll('.recbtn').forEach((b) => {
    b.disabled = rec.busy;
    if (rec.busy) b.textContent = '● Recording…';
  });
}

function recordRow() {
  const a = state.animation;
  const [W, H] = recordPixels();
  return section('Record', [
    el('div', { class: 'row' },
      el('button', { type: 'button', class: 'recbtn', disabled: rec.busy ? 'true' : null,
                     onclick: () => recordLoop(a.loopBeats || 8) }, rec.busy ? '● Recording…' : '● Record loop'),
      numField('Length (beats)', a.loopBeats || 8, 1, 128, 1, (v) => { a.loopBeats = v; renderTimeline(); markDirty(); })),
    el('p', { class: 'hint' }, `Records ${W} × ${H} px in real time at the current BPM, as WebM (Chrome / Firefox; Safari gives MP4). `
      + 'For a seamless loop, make the length a multiple of every period. Frame rate depends on the machine: HD is fine on a laptop with a GPU, 4K may drop frames.'),
  ]);
}

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
  return section('Clock', [
    el('div', { class: 'addrow' },
      el('button', { type: 'button', id: 'play', onclick: () => (anim.playing ? pause() : play()) },
         anim.playing ? '❚❚ Pause' : '▶ Play'),
      btn('⟲ Reset', resetClock),
      btn('⛶ Fullscreen', toggleFullscreen)),
    numField('BPM', a.bpm, 20, 300, 1, (v) => { a.bpm = v; markDirty(); }),
    numField('Flip every N beats', a.flipEvery, 0, 32, 1, (v) => { a.flipEvery = v; paint(); markDirty(); }),
    el('p', { class: 'hint' }, 'Rates are per beat, so a change of tempo keeps the same feel. Space toggles play; F toggles fullscreen. The design itself never changes while playing.'),
  ]);
}

const DRIVES = [['clock', 'clock (beats)'], ['low', 'sound: low (bass)'], ['mid', 'sound: mid'], ['high', 'sound: high'], ['all', 'sound: all']];

/* Small / Large + how to move between them. `o` holds the fields with prefix `pre`;
   `driveKey` names the drive field (layers keep the older `drive`). */
function cycleFields(o, pre, driveKey, labelUnit, onChange, onStructure) {
  // translate legacy Period + Mode once, so the fields show what is actually running
  if (!o[pre + 'Return'] && (o[pre + 'Mode'] || o[pre + 'Period'])) {
    const m = o[pre + 'Mode'] || 'smooth', P = o[pre + 'Period'] || 1;
    o[pre + 'Return'] = m === 'snap' ? 'snap' : m === 'punch' ? 'jump' : 'pingpong';
    o[pre + 'Travel'] = m === 'punch' ? P : P / 2;
    o[pre + 'Ease'] = m === 'punch' ? 'punch' : 'smooth';
    delete o[pre + 'Mode']; delete o[pre + 'Period'];
  }
  const clock = (o[driveKey] || 'clock') === 'clock';
  return [
    numField(`Small (% of ${labelUnit})`, o[pre + 'Min'] ?? 100, 0, 500, 1, (v) => { o[pre + 'Min'] = v; onChange(); }),
    numField(`Large (% of ${labelUnit})`, o[pre + 'Max'] ?? 100, 0, 500, 1, (v) => { o[pre + 'Max'] = v; onChange(); }),
    selectField('Drive', o[driveKey] || 'clock', DRIVES, (v) => { o[driveKey] = v; onStructure(); }),
    ...(clock ? [
      selectField('On the beat', o[pre + 'Start'] || 'large', [['large', 'Large, then to Small'], ['small', 'Small, then to Large']], (v) => { o[pre + 'Start'] = v; onChange(); }),
      numField('Travel (beats)', o[pre + 'Travel'] ?? 0.5, 0.125, 32, 0.125, (v) => { o[pre + 'Travel'] = v; onChange(); }),
      selectField('Return', o[pre + 'Return'] || 'pingpong',
        [['pingpong', 'ping-pong (there and back, no jump)'], ['jump', 'jump (restart on the beat)'], ['hold', 'hold (go once, stay)'], ['snap', 'snap (hard switch, no travel)']],
        (v) => { o[pre + 'Return'] = v; onChange(); }),
      selectField('Ease', o[pre + 'Ease'] || 'smooth', [['smooth', 'smooth'], ['linear', 'linear'], ['punch', 'punch (fast away, soft arrival)']], (v) => { o[pre + 'Ease'] = v; onChange(); }),
      numField('Offset (beats)', o[pre + 'Offset'] || 0, 0, 32, 0.125, (v) => { o[pre + 'Offset'] = v; onChange(); }),
    ] : [el('p', { class: 'hint' }, 'Follows the sound level of that band: quiet = Small, loud = Large.')]),
  ];
}

function baseMotionSection() {
  const a = state.animation, p = () => { paint(); markDirty(); };
  return section('Base field', [
    numField('Scroll (lines/beat)', a.scroll || 0, -4, 4, 0.05, (v) => { a.scroll = v; p(); }),
    numField('Drift (°/beat)', a.drift || 0, -45, 45, 0.5, (v) => { a.drift = v; p(); }),
    el('div', { class: 'grp' }, 'Line width (layers inheriting x follow)'),
    ...cycleFields(a, 'line', 'lineDrive', 'x', p, renderAll),
    el('div', { class: 'grp' }, 'Angle (start = base angle)'),
    checkField('Swing to an end angle', !!a.swingOn, (v) => { a.swingOn = v; if (a.swingTo == null) a.swingTo = (state.base.angle + 90) % 180; renderAll(); }),
    ...(a.swingOn ? [
      numField('End angle°', a.swingTo ?? 90, -180, 360, 1, (v) => { a.swingTo = v; p(); }),
      selectField('Drive', a.swingDrive || 'clock', DRIVES, (v) => { a.swingDrive = v; renderAll(); }),
      ...((a.swingDrive || 'clock') === 'clock' ? [
        numField('Travel (beats)', a.swingPeriod || 4, 0.25, 64, 0.25, (v) => { a.swingPeriod = v; p(); }),
        numField('Offset (beats)', a.swingOffset || 0, 0, 64, 0.25, (v) => { a.swingOffset = v; p(); }),
        selectField('Return', a.swingMode || 'pingpong',
          [['pingpong', 'ping-pong (back and forth)'], ['jump', 'jump (restart at start)'], ['hold', 'hold (stay at end)']],
          (v) => { a.swingMode = v; p(); }),
        selectField('Ease', a.swingEase || 'smooth', [['smooth', 'smooth'], ['linear', 'linear']], (v) => { a.swingEase = v; p(); }),
      ] : [el('p', { class: 'hint' }, 'Angle follows the sound level: quiet = base angle, loud = end angle.')]),
    ] : []),
    el('p', { class: 'hint' }, 'Layer stripes turn along with the base, so orientation contrasts stay intact.'),
  ]);
}

function tabRow() {
  const tab = (id, label) => el('button', {
    type: 'button', class: 'tab' + (ui.tab === id ? ' active' : ''),
    onclick: () => { ui.tab = id; renderControls(); },
  }, label);
  return el('div', { class: 'tabs' }, tab('static', 'Static'), tab('motion', 'Motion'), tab('sequence', 'Sequence'));
}

function exportSection() {
  return section('Export', [
    el('div', { class: 'addrow' },
      btn('Download SVG', exportSVG, 'exp'),
      btn('Download PDF', exportPDF, 'exp'),
      btn('Download PNG', exportPNG, 'exp')),
    el('p', { class: 'hint' }, 'PDF and SVG are vector at the exact print size; the PDF writes the stripes as paths (no patterns).'),
    anim.playing || anim.beats ? el('p', { class: 'hint' }, 'Exports the frame as it is now (pause to pick one).') : null,
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

/* ============================================================
   PDF export — a minimal, dependency-free vector PDF
   The stripes are written as real paths (clipped rectangles), not as
   patterns, so any RIP or print workflow reads them. Print formats get
   their exact mm size; screen formats 1 px = 0.75 pt.
   ============================================================ */
const pn = (v) => String(Math.round(v * 1000) / 1000);
const KAPPA = 0.5522847498;

function pdfRect(x, y, w, h) { return `${pn(x)} ${pn(y)} ${pn(w)} ${pn(h)} re`; }

/* path construction ops for a shape, in user units */
function pdfPath(s) {
  const L = (x, y) => `${pn(x)} ${pn(y)} l`;
  const C = (a, b, c, d, e, f) => `${pn(a)} ${pn(b)} ${pn(c)} ${pn(d)} ${pn(e)} ${pn(f)} c`;
  switch (s.type) {
    case 'circle': case 'ellipse': {
      const rx = s.type === 'circle' ? s.r : s.rx, ry = s.type === 'circle' ? s.r : s.ry;
      const { cx, cy } = s, kx = KAPPA * rx, ky = KAPPA * ry;
      return [`${pn(cx + rx)} ${pn(cy)} m`,
        C(cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry),
        C(cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy),
        C(cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry),
        C(cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy), 'h'].join('\n');
    }
    case 'rect': {
      const { x, y, w, h } = s, r = Math.max(0, Math.min(s.r || 0, w / 2, h / 2));
      if (!r) return pdfRect(x, y, w, h);
      const k = KAPPA * r;
      return [`${pn(x + r)} ${pn(y)} m`, L(x + w - r, y),
        C(x + w - r + k, y, x + w, y + r - k, x + w, y + r), L(x + w, y + h - r),
        C(x + w, y + h - r + k, x + w - r + k, y + h, x + w - r, y + h), L(x + r, y + h),
        C(x + r - k, y + h, x, y + h - r + k, x, y + h - r), L(x, y + r),
        C(x, y + r - k, x + r - k, y, x + r, y), 'h'].join('\n');
    }
    case 'polygon':
      return s.points.map((p, i) => `${pn(p[0])} ${pn(p[1])} ${i ? 'l' : 'm'}`).join('\n') + '\nh';
    case 'sector': {
      const rad = (a) => a * Math.PI / 180;
      let sweep = (((s.a1 - s.a0) % 360) + 360) % 360;
      if (sweep === 0) sweep = 360;
      const n = Math.ceil(sweep / 90), d = rad(sweep / n), kk = 4 / 3 * Math.tan(d / 4);
      const P = (t) => [s.cx + s.r * Math.cos(t), s.cy + s.r * Math.sin(t)];
      const D = (t) => [-s.r * Math.sin(t), s.r * Math.cos(t)];
      let t = rad(s.a0);
      const p0 = P(t);
      const ops = [`${pn(s.cx)} ${pn(s.cy)} m`, L(p0[0], p0[1])];
      for (let i = 0; i < n; i++) {
        const a = P(t), da = D(t), b = P(t + d), db = D(t + d);
        ops.push(C(a[0] + kk * da[0], a[1] + kk * da[1], b[0] - kk * db[0], b[1] - kk * db[1], b[0], b[1]));
        t += d;
      }
      ops.push('h');
      return ops.join('\n');
    }
  }
}

const pdfGray = (hex) => (hex === '#ffffff' ? '1' : '0');

/* stripes covering bbox (in the current frame); caller has set the clip */
function pdfStripes(bbox, angle, line, inv) {
  const P = line * 1.5;
  const lc = inv ? paper() : ink(), bg = inv ? ink() : paper();
  const [bx, by, bw, bh] = bbox;
  const ph = viewPhase ? (viewPhase % P) : 0;
  const a = angle * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  // bbox corners into pattern space (inverse of rotate(angle) translate(0, ph))
  const corners = [[bx, by], [bx + bw, by], [bx + bw, by + bh], [bx, by + bh]].map(([X, Y]) =>
    [c * X + s * Y, -s * X + c * Y - ph]);
  const xs = corners.map((p) => p[0]), ys = corners.map((p) => p[1]);
  const x0 = Math.min(...xs) - P, x1 = Math.max(...xs) + P;
  const k0 = Math.floor(Math.min(...ys) / P) - 1, k1 = Math.ceil(Math.max(...ys) / P) + 1;
  let ops = `${pdfGray(bg)} g ${pdfRect(bx, by, bw, bh)} f\n`;
  ops += `q ${pn(c)} ${pn(s)} ${pn(-s)} ${pn(c)} 0 0 cm 1 0 0 1 0 ${pn(ph)} cm ${pdfGray(lc)} g\n`;
  for (let k = k0; k <= k1; k++) ops += `${pdfRect(x0, k * P, x1 - x0, line)} f\n`;
  return ops + 'Q\n';
}

function buildPDF() {
  const { w, h } = state.doc, f = currentFormat();
  const sc = (f && f.mm) ? (72 / 25.4) / 10 : 0.75;       // units -> pt
  const W = w * sc, H = h * sc;
  buildSVG(true);                                          // sets the view globals for this frame
  const view = animated();
  const baseAngle = r1(view.angle % 360);
  let c = `${pn(sc)} 0 0 ${pn(-sc)} 0 ${pn(H)} cm\n`;      // y down, like the design
  c += `${pdfGray(paper())} g ${pdfRect(0, 0, w, h)} f\n`;
  c += `q ${pdfRect(0, 0, w, h)} W n\n` + pdfStripes([0, 0, w, h], baseAngle, viewBaseLine, state.base.inverted) + 'Q\n';

  for (const L of state.layers) {
    if (!L.visible || !layerActive(L)) continue;
    let shape = scaledShape(L.shape, view.layerScale(L));
    const [ox, oy] = view.layerOffset(L);
    if (ox || oy) { const m = clone(shape); translateShape(m, shape, ox, oy); shape = m; }
    const [cx, cy] = shapeCenter(shape);
    const rot = r1(view.layerRotate(L));
    const path = pdfPath(shape);
    c += 'q\n';
    if (rot) {
      const a = rot * Math.PI / 180, co = Math.cos(a), si = Math.sin(a);
      c += `${pn(co)} ${pn(si)} ${pn(-si)} ${pn(co)} ${pn(cx - co * cx + si * cy)} ${pn(cy - si * cx - co * cy)} cm\n`;
    }
    const op = L.op, colr = L.color || 'ink';
    if (op.type === 'fill') {
      c += `${pdfGray(col(colr))} g\n${path}\nf\n`;
    } else if (op.type === 'outline') {
      c += `${pdfGray(col(colr))} G ${pn(op.width)} w\n${path}\nS\n`;
    } else {
      const line = op.line > 0 ? op.line : viewBaseLine;
      const angle = r1((op.angle + viewAngleDelta) % 360);
      c += `q\n${path}\nW n\n` + pdfStripes(shapeBBox(shape), angle, line, colr === 'paper') + 'Q\n';
    }
    if (L.border && op.type !== 'outline') {
      c += `${pdfGray(col(L.borderColor || 'ink'))} G ${pn(viewBaseLine)} w 0 j\n${path}\nS\n`;
    }
    c += 'Q\n';
  }

  const title = (project.name || 'Linework').replace(/[()\\]/g, '');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pn(W)} ${pn(H)}] /Contents 4 0 R /Resources << >> >>`,
    `<< /Length ${c.length} >>\nstream\n${c}\nendstream`,
    `<< /Title (${title}) /Producer (Linework) /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}) >>`,
  ];
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((o) => { out += String(o).padStart(10, '0') + ' 00000 n \n'; });
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(out, (ch) => ch.charCodeAt(0) & 0xff);
}

function exportPDF() {
  download(new Blob([buildPDF()], { type: 'application/pdf' }), exportName('pdf'));
}

function loadDefault() {                  // A4 portrait starting canvas (units: 0.1 mm)
  state.doc = { w: 2100, h: 2970, format: 'A4', landscape: false };
  state.base = { angle: 0, line: 24, inverted: false };   // 2.4 mm line, 1.2 mm gap
  state.invert = false;
  state.animation = { bpm: 120, scroll: 0, drift: 0, flipEvery: 0, loopBeats: 8, audioGain: 1 };
  state.scenes = [];
  state.sequence = { loop: true };
  state.grid = { show: true, snap: true, cols: 12, rows: 0, margin: 0 };
  anim.beats = 0;
  state.layers = [
    { id: nid(), name: 'Circle', visible: true, rotate: 0, spin: 0,
      sizeMin: 100, sizeMax: 100, sizeStart: 'large', sizeTravel: 0.5, sizeOffset: 0, sizeReturn: 'pingpong', sizeEase: 'smooth',
      color: 'ink', border: true, borderColor: 'ink',
      shape: { type: 'circle', cx: 1050, cy: 1485, r: 700 },
      op: { type: 'stripes', angle: 90, line: 0 } },
  ];
  state.selectedId = null;
  renderAll();
}

/* ============================================================
   Grid — modular grid for placing and snapping
   cols across the width inside the margin; rows = 0 gives square cells.
   ============================================================ */
function gridLines() {
  const g = state.grid, { w, h } = state.doc;
  const m = Math.max(0, Math.min(g.margin || 0, Math.min(w, h) / 2 - 1));
  const cols = Math.max(1, Math.round(g.cols) || 1);
  const cw = (w - 2 * m) / cols;
  const rows = g.rows > 0 ? Math.round(g.rows) : Math.max(1, Math.floor((h - 2 * m) / cw + 1e-6));
  const rh = g.rows > 0 ? (h - 2 * m) / rows : cw;
  const xs = [], ys = [];
  for (let i = 0; i <= cols; i++) xs.push(m + i * cw);
  for (let j = 0; j <= rows; j++) ys.push(m + j * rh);
  if (Math.abs(ys[ys.length - 1] - (h - m)) > 1e-6) ys.push(h - m);    // bottom margin is a snap target too
  return { xs, ys, m, cw, rh, cols, rows };
}

function gridOverlay() {
  const { xs, ys, m } = gridLines();
  const { w, h } = state.doc;
  const sw = Math.max(w, h) / 1200, c = '#ff3d9a';         // guide magenta, with a pale halo so it reads on black and white
  const lines = xs.map((x) => `M${x} ${m}V${h - m}`).join('') + ys.map((y) => `M${m} ${y}H${w - m}`).join('');
  let g = `<g class="grid" pointer-events="none" fill="none">`;
  g += `<path d="${lines}" stroke="#ffffff" stroke-width="${sw * 3}" opacity=".45"/>`;
  g += `<path d="${lines}" stroke="${c}" stroke-width="${sw}" opacity=".9"/>`;
  if (m > 0) g += `<rect x="${m}" y="${m}" width="${w - 2 * m}" height="${h - 2 * m}" stroke="${c}" stroke-width="${sw * 2}" opacity=".9"/>`;
  return g + '</g>';
}

/* nearest grid line to v within thr, else null */
function snapTo(v, lines, thr) {
  let best = null, bd = thr;
  for (const l of lines) { const d = Math.abs(v - l); if (d < bd) { bd = d; best = l; } }
  return best;
}

/* Snap a moved shape: its bbox edges and centre against the grid.
   Returns the [dx, dy] correction to apply (0 when nothing is close). */
function snapMoveDelta(shape, rotated, thr) {
  const { xs, ys } = gridLines();
  const [bx, by, bw, bh] = shapeBBox(shape);
  const cx = bx + bw / 2, cy = by + bh / 2;
  const candX = rotated ? [cx] : [bx, cx, bx + bw];
  const candY = rotated ? [cy] : [by, cy, by + bh];
  const pick = (cands, lines) => {
    let best = 0, bd = thr;
    for (const c of cands) { const s = snapTo(c, lines, thr); if (s !== null && Math.abs(s - c) < bd) { bd = Math.abs(s - c); best = s - c; } }
    return best;
  };
  return [pick(candX, xs), pick(candY, ys)];
}

function snapPoint(ux, uy, thr) {
  const { xs, ys } = gridLines();
  const sx = snapTo(ux, xs, thr), sy = snapTo(uy, ys, thr);
  return [sx === null ? ux : sx, sy === null ? uy : sy];
}

function gridSection() {
  const g = state.grid, M = Math.min(state.doc.w, state.doc.h) / 4;
  return section('Grid', [
    el('div', { class: 'addrow' },
      checkField('Show', g.show, (v) => { g.show = v; renderSVG(); }),
      checkField('Snap', g.snap, (v) => { g.snap = v; markDirty(); })),
    numField('Columns', g.cols, 1, 48, 1, (v) => { g.cols = v; renderSVG(); }),
    numField('Rows (0 = square)', g.rows, 0, 64, 1, (v) => { g.rows = v; renderSVG(); }),
    numField('Margin', g.margin, 0, Math.round(M), 1, (v) => { g.margin = v; renderSVG(); }),
    el('p', { class: 'hint' }, 'Edges and centre snap while dragging, the cursor while resizing. Hold ⌘/Ctrl to ignore the grid. G toggles it. Never exported.'),
  ]);
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
  g += `</g>`;
  if (L.moveOn && L.moveX != null) g += moveGhost(L, hs, sw);
  return g;
}

/* End position of a moving layer: a draggable dashed ghost + a path line */
function moveGhost(L, hs, sw) {
  const [cx, cy] = shapeCenter(L.shape);
  const ghost = clone(L.shape);
  translateShape(ghost, L.shape, L.moveX - cx, L.moveY - cy);
  const tf = L.rotate ? `rotate(${L.rotate} ${L.moveX} ${L.moveY})` : '';
  const mg = '#ff3d9a';
  let g = `<line x1="${cx}" y1="${cy}" x2="${L.moveX}" y2="${L.moveY}" stroke="${mg}" stroke-width="${sw}" `
        + `stroke-dasharray="${hs * 0.5} ${hs * 0.5}" pointer-events="none"/>`;
  g += shapeMarkup(ghost, `class="ghost" data-ghost="1" fill="rgba(255,61,154,0.08)" stroke="${mg}" stroke-width="${sw}" `
                   + `stroke-dasharray="${hs} ${hs * 0.6}"`, tf);
  g += `<circle cx="${L.moveX}" cy="${L.moveY}" r="${hs / 2.5}" fill="${mg}" pointer-events="none"/>`;
  return g;
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

  const ghostEl = e.target.closest('[data-ghost]');
  if (ghostEl && state.selectedId) {
    const L = state.layers.find((l) => l.id === state.selectedId);
    if (!L) return;
    drag = { mode: 'ghost', L, rect, sx, sy, snap: { x: L.moveX, y: L.moveY }, startUser: [ux, uy] };
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
  let [ux, uy] = userCoords(pendingMouse, drag.rect, drag.sx, drag.sy);
  const snapping = state.grid.snap && !(pendingMouse.metaKey || pendingMouse.ctrlKey);
  const thr = 8 * drag.sx;                              // 8 screen px
  if (drag.mode === 'ghost') {                          // end point of a moving layer
    let ex = drag.snap.x + ux - drag.startUser[0], ey = drag.snap.y + uy - drag.startUser[1];
    if (snapping) [ex, ey] = snapPoint(ex, ey, thr);
    drag.L.moveX = ex; drag.L.moveY = ey;
  } else if (drag.mode === 'move') {
    const dx = ux - drag.startUser[0], dy = uy - drag.startUser[1];
    translateShape(drag.L.shape, drag.snap, dx, dy);
    if (snapping) {
      const [ax, ay] = snapMoveDelta(drag.L.shape, !!drag.L.rotate, thr);
      if (ax || ay) translateShape(drag.L.shape, drag.snap, dx + ax, dy + ay);
    }
  } else {
    if (snapping) [ux, uy] = snapPoint(ux, uy, thr);
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
  if (drag.L.moveX != null) { drag.L.moveX = r1(drag.L.moveX); drag.L.moveY = r1(drag.L.moveY); }
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
  restoreAutosave();   // pick up where the browser left off
  initCanvas();
  initTimeline();
  renderTimeline();
} else if (typeof module !== 'undefined') {
  module.exports = { state, anim, audio, seq, project, projectData, buildSVG, buildPDF, layerActive, timelineLength, gridLines, snapMoveDelta, snapPoint, setFormat, reformat, FORMATS, exportPixels, undo, redo, flushHistory };  // headless / tests
}
