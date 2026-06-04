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
  doc: { w: 2000, h: 1000 },
  invert: false,                 // global black/white swap
  base: { angle: 0, line: 16, inverted: false },  // stripe field; gap = line / 2 (derived)
  layers: [],
};

const ink   = () => (state.invert ? '#ffffff' : '#000000');
const paper = () => (state.invert ? '#000000' : '#ffffff');

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

function defaultOp(type) {
  if (type === 'fill')    return { type: 'fill', color: 'paper' };
  if (type === 'outline') return { type: 'outline', width: 4, dashed: false };
  return { type: 'stripes', angle: (state.base.angle + 90) % 180, line: 0, inverted: false };
}

function defaultLayer(type) {
  return { id: nid(), name: cap(type), visible: true, rotate: 0,
           shape: makeShape(type), op: defaultOp('stripes') };
}

/* ============================================================
   SVG rendering
   ============================================================ */

function patKey(angle, line, inv) {
  return 'p_' + String(angle).replace(/[.-]/g, '_') + '_' +
         String(line).replace(/[.-]/g, '_') + '_' + (inv ? 1 : 0);
}

function patDef(angle, line, inv) {
  const P = line * 1.5;                       // period = line + gap = x + x/2
  const lc = inv ? paper() : ink();           // line colour
  const bg = inv ? ink() : paper();           // gap colour
  return `<pattern id="${patKey(angle, line, inv)}" patternUnits="userSpaceOnUse" `
       + `width="${P}" height="${P}" patternTransform="rotate(${angle})">`
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

function layerAttrs(op, patterns) {
  if (op.type === 'fill') {
    return `fill="${op.color === 'ink' ? ink() : paper()}" stroke="none"`;
  }
  if (op.type === 'outline') {
    const dash = op.dashed ? ` stroke-dasharray="${op.width * 2.5} ${op.width * 2}"` : '';
    return `fill="none" stroke="${ink()}" stroke-width="${op.width}"${dash}`;
  }
  // stripes
  const line = op.line > 0 ? op.line : state.base.line;
  const key = patKey(op.angle, line, op.inverted);
  patterns.set(key, patDef(op.angle, line, op.inverted));
  return `fill="url(#${key})" stroke="none"`;
}

function buildSVG() {
  const { w, h } = state.doc;
  const patterns = new Map();
  const baseKey = patKey(state.base.angle, state.base.line, state.base.inverted);
  patterns.set(baseKey, patDef(state.base.angle, state.base.line, state.base.inverted));

  let body = `<rect x="0" y="0" width="${w}" height="${h}" fill="${paper()}"/>`
           + `<rect x="0" y="0" width="${w}" height="${h}" fill="url(#${baseKey})"/>`;

  for (const L of state.layers) {
    if (!L.visible) continue;
    const attrs = layerAttrs(L.op, patterns);
    const [cx, cy] = shapeCenter(L.shape);
    const tf = L.rotate ? `rotate(${L.rotate} ${cx} ${cy})` : '';
    body += shapeMarkup(L.shape, attrs, tf);
  }

  const defs = `<defs>${[...patterns.values()].join('')}</defs>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" `
       + `width="${w}" height="${h}" preserveAspectRatio="xMidYMid meet">${defs}${body}</svg>`;
}

function renderSVG() {
  if (typeof document === 'undefined') return;
  document.getElementById('preview').innerHTML = buildSVG();
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
  if (op.type === 'fill') {
    return [selectField('Colour', op.color,
      [['paper', 'paper — knock-out'], ['ink', 'ink — solid']], (v) => { op.color = v; r(); })];
  }
  if (op.type === 'outline') {
    return [
      numField('Stroke', op.width, 1, 80, 1, (v) => { op.width = v; r(); }),
      checkField('Dashed', op.dashed, (v) => { op.dashed = v; r(); }),
    ];
  }
  return [
    numField('Angle°', op.angle, 0, 180, 1, (v) => { op.angle = v; r(); }),
    numField('Line (0 = base)', op.line, 0, 240, 1, (v) => { op.line = v; r(); }),
    checkField('Inverted', op.inverted, (v) => { op.inverted = v; r(); }),
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
    el('input', { type: 'text', class: 'lname', value: L.name, oninput: (e) => { L.name = e.target.value; } }),
    btn('▲', () => move(i, -1), 'mini'),
    btn('▼', () => move(i, 1), 'mini'),
    btn('⧉', () => { const c = JSON.parse(JSON.stringify(L)); c.id = nid(); state.layers.splice(i + 1, 0, c); renderAll(); }, 'mini'),
    btn('✕', () => { state.layers.splice(i, 1); renderAll(); }, 'mini danger'),
  );
  return el('div', { class: 'layer' },
    head,
    checkField('Visible', L.visible, (v) => { L.visible = v; renderSVG(); }),
    selectField('Shape', L.shape.type, SHAPES.map((s) => [s, s]), (t) => { L.shape = makeShape(t); renderAll(); }),
    ...shapeFields(L),
    numField('Rotate°', L.rotate, -180, 180, 1, (v) => { L.rotate = v; renderSVG(); }),
    selectField('Operation', L.op.type,
      [['stripes', 'stripes'], ['fill', 'fill'], ['outline', 'outline']],
      (t) => { L.op = defaultOp(t); renderAll(); }),
    ...opFields(L),
  );
}

/* ---------- Document size presets ---------- */
function sizeRow() {
  const sizes = [['Spread', 2000, 1333], ['Poster', 1414, 2000], ['Square', 1600, 1600], ['Wide', 2000, 1000]];
  return el('div', { class: 'addrow' },
    ...sizes.map((s) => btn(s[0], () => { state.doc.w = s[1]; state.doc.h = s[2]; renderAll(); }, 'sz')));
}

/* ============================================================
   Control panel
   ============================================================ */
function renderControls() {
  if (typeof document === 'undefined') return;
  const p = document.getElementById('panel');
  p.innerHTML = '';

  p.append(section('Document', [
    numField('Width', state.doc.w, 100, 6000, 10, (v) => { state.doc.w = v; renderSVG(); }),
    numField('Height', state.doc.h, 100, 6000, 10, (v) => { state.doc.h = v; renderSVG(); }),
    sizeRow(),
    checkField('Invert whole image', state.invert, (v) => { state.invert = v; renderSVG(); }),
  ]));

  p.append(section('Base field', [
    numField('Angle°', state.base.angle, 0, 180, 1, (v) => { state.base.angle = v; renderSVG(); }),
    numField('Line width x', state.base.line, 1, 240, 1, (v) => { state.base.line = v; renderSVG(); }),
    checkField('Inverted (white-dominant)', state.base.inverted, (v) => { state.base.inverted = v; renderSVG(); }),
    el('p', { class: 'hint' }, 'Gap is locked to x / 2.'),
  ]));

  const wrap = el('div', {});
  state.layers.forEach((L, i) => wrap.append(layerCard(L, i)));
  p.append(section('Layers', [
    wrap,
    el('div', { class: 'addrow' },
      ...SHAPES.map((t) => btn('+ ' + t, () => { state.layers.push(defaultLayer(t)); renderAll(); }, 'add'))),
  ]));

  p.append(section('Presets', [
    el('div', { class: 'addrow' },
      btn('Dome + triangle', () => loadPreset('dome'), 'preset'),
      btn('Focus capsules', () => loadPreset('focus'), 'preset'),
      btn('Diagonal cut', () => loadPreset('diag'), 'preset'),
      btn('Disc', () => loadPreset('disc'), 'preset')),
  ]));

  p.append(section('Export', [
    el('div', { class: 'addrow' },
      btn('Download SVG', exportSVG, 'exp'),
      btn('Download PNG', () => exportPNG(2), 'exp')),
  ]));
}

function renderAll() { renderControls(); renderSVG(); }

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
  download(new Blob([buildSVG()], { type: 'image/svg+xml' }), 'linework.svg');
}

function exportPNG(scale) {
  const url = URL.createObjectURL(new Blob([buildSVG()], { type: 'image/svg+xml' }));
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = state.doc.w * scale;
    c.height = state.doc.h * scale;
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    c.toBlob((b) => download(b, 'linework.png'));
  };
  img.src = url;
}

/* ============================================================
   Presets — reproduce the reference mechanisms
   ============================================================ */
function loadPreset(name) {
  if (name === 'dome') {
    state.doc = { w: 2000, h: 1000 };
    state.base = { angle: 0, line: 16 };
    state.invert = false;
    state.layers = [
      { id: nid(), name: 'Triangle (vertical)', visible: true, rotate: 0,
        shape: { type: 'polygon', points: [[1075, 120], [1075, 900], [1900, 900]] },
        op: { type: 'stripes', angle: 90, line: 0, inverted: false } },
      { id: nid(), name: 'Dome (knock-out)', visible: true, rotate: -44,
        shape: { type: 'sector', cx: 1500, cy: 430, r: 330, a0: 180, a1: 360 },
        op: { type: 'fill', color: 'paper' } },
    ];
  } else if (name === 'focus') {
    state.doc = { w: 2000, h: 1333 };
    state.base = { angle: 90, line: 14 };
    state.invert = false;
    state.layers = [560, 1000, 1440].map((cx, i) => ({
      id: nid(), name: 'Capsule ' + (i + 1), visible: true, rotate: 0,
      shape: { type: 'rect', x: cx - 150, y: 170, w: 300, h: 1060, r: 150 },
      op: { type: 'stripes', angle: 0, line: 0, inverted: false },
    }));
  } else if (name === 'diag') {
    state.doc = { w: 1414, h: 2000 };
    state.base = { angle: 45, line: 10, inverted: true };  // white-dominant field
    state.invert = false;
    state.layers = [
      { id: nid(), name: 'Polygon (knock-out)', visible: true, rotate: 0,
        shape: { type: 'polygon', points: [[180, 230], [560, 230], [900, 760], [900, 1770], [520, 1770], [180, 1240]] },
        op: { type: 'fill', color: 'paper' } },
      { id: nid(), name: 'Circle (re-fill)', visible: true, rotate: 0,
        shape: { type: 'circle', cx: 560, cy: 1000, r: 300 },
        op: { type: 'stripes', angle: 45, line: 0, inverted: true } },  // matches base → only shows over the knock-out
    ];
  } else if (name === 'disc') {
    state.doc = { w: 2000, h: 1400 };
    state.base = { angle: 0, line: 12 };
    state.invert = false;
    state.layers = [
      { id: nid(), name: 'Disc (solid)', visible: true, rotate: 0,
        shape: { type: 'circle', cx: 1000, cy: 700, r: 520 },
        op: { type: 'fill', color: 'ink' } },
    ];
  }
  renderAll();
}

/* ---------- Boot ---------- */
if (typeof document !== 'undefined') {
  loadPreset('dome');
} else if (typeof module !== 'undefined') {
  module.exports = { state, buildSVG, loadPreset };  // for headless rendering / tests
}
