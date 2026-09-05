# Linework

A small, dependency-free tool for generating black &amp; white **stripe-pattern
compositions** — the kind where geometric shapes are revealed through a field
of lines (orientation shifts, knock-outs, inversions).

Open `index.html` in a browser. No build step, no install.

## The model

Everything is built from **one base stripe field** plus a **stack of layers**.
Each layer is a `shape` with an `operation`, and later layers paint on top of
earlier ones (so a knock-out can override the field, and a stripe layer can
re-fill a knock-out).

```
base field            angle + line width x   (gap is always x / 2)
 └ layer  shape + operation
 └ layer  shape + operation     ← painted on top
 ...
```

### Shapes
`circle` · `ellipse` · `rect` (corner radius → capsule/stadium) ·
`polygon` (free points, e.g. triangles / wedges) · `sector` (pie / semicircle / dome).
Every layer can be rotated.

### Operations
- **stripes** — fill the shape with a stripe pattern: change **angle**
  (orientation shift) or **line** width (local density). `line = 0` inherits the
  base width.
- **fill** — solid fill: white gives a knock-out (negative space), black a solid.
- **outline** — stroke only, for construction lines.

Every layer has a **colour**, black (ink) or white (paper). For stripes it is the
line colour (white lines on black = figure-ground swap), for fill the fill, for
outline the stroke. It stays when you switch operation.

Any layer can also carry a **border** — a stroke around the shape at the base line
width `x`, in its own colour (a white knock-out with a black border gives the
dome look).

The stripe rule is locked: **black line = x, gap = x / 2** (so ⅔ ink coverage).
A global **Invert** swaps black and white for the whole composition.

> Patterns are drawn in a shared coordinate space, so a stripe layer with the
> same settings as the base is invisible *except* where it sits over a knock-out.
> That's how the "XOR" look (a shape re-filling only the negative area) is made —
> no boolean engine needed yet.

## Grid

Static → Grid: a modular grid of **columns** across the width inside a
**margin**; **rows** = 0 gives square cells. While dragging, a shape's edges
and centre **snap** to the lines; while resizing, the cursor does. Hold
⌘/Ctrl to ignore the grid, press **G** to show or hide it. The grid is an
editing aid and never appears in exports.

## Formats

The document has a **format**: print `A5` `A4` `A3` `A2` `A1` (portrait or
landscape), social `IG post 1:1` `IG post 4:5` `IG reel 9:16`, or screen
`HD 16:9` (1920 × 1080) and `4K 16:9` (3840 × 2160); screens default to landscape,
untick Landscape for a vertical screen. Switching format keeps the
composition: every layer *and the line width x* are scaled uniformly from the
centre of the canvas, so an A4 design re-issued as A1 is the same image,
enlarged.

- Print formats work in **0.1 mm units** (A4 = 2100 × 2970). The panel shows the
  physical line width, and the SVG export carries real `mm` dimensions.
- Social and screen formats work in **px** (Instagram 1080 wide, HD 1920, 4K 3840).
- When the aspect ratio changes (A4 → 1:1, → 9:16) choose **fit** (everything
  stays visible, the stripe field extends into the new space) or **fill** (the
  composition covers the canvas and the edges crop).
- The **Width / Height** fields only resize the canvas (crop / extend) and switch
  the document to a *custom* format; they do not rescale the layers.

## Undo

**⌘/Ctrl + Z** undoes, **⇧ ⌘ Z** (or Ctrl + Y) redoes; the buttons at the top of
the panel do the same. A slider drag or a canvas drag counts as one step.
**Delete** removes the selected layer.

### On the canvas
Click a shape (or its layer) to select it, **drag** to move, and drag a **corner
handle** to resize. The opposite corner stays put, like in any drawing app;
hold **Alt / Option** to scale from the centre and **Shift** to keep proportions
(circles, sectors and polygons always keep theirs). Works on rotated shapes. The
numeric fields sync when you release. Selection handles never appear in the
exported SVG.

## Three panels: Static, Motion, Sequence

**Static** is the design: layers (shape, operation, colour, border) and export.
**Motion** is the animation: clock, audio, per-layer motion and recording.
**Sequence** chains scenes. They show as tabs, or **side by side** (toggle in
the top bar; remembered per browser). Nothing scrolls sideways: the panels
shrink instead. Selecting a layer in one panel selects it in the other.

**⚙ Setup** (top right) opens a fourth panel on the right with the things you
set once: document format, grid and base field. It stays closed until you need it.

## Sound

In Motion → Audio pick a **source**: microphone / line-in, or an audio file
(plays in a loop). Three band levels are measured every frame: low (20–160 Hz),
mid (160–2000 Hz), high (2–12 kHz), with a **Gain**. Per layer, set **Drive**
to a band: its size then follows that level between Small and Large instead of
the clock (quiet = Small, loud = Large). Recordings include the sound when a
source is active.

## Timeline

Under the canvas: the timeline of the scene loaded in the editor (or of the
loop length when no scene is loaded). A beat ruler, a playhead, and one bar
per layer from its **in** to its **out** point. Drag the bar to move it, its
edges to set in / out (quarter-beat steps); outside the bar the layer is
hidden. Click or drag on the ruler to jump. The clock wraps at the scene
length, so the playhead loops.

## Sequence

A **scene** is a snapshot of the whole design plus its motion settings, with a
length in beats. Build a look in Static and Motion, then *Add scene from
editor*; *Load into editor* brings a scene back to tweak it, *Update from
editor* saves the tweak. **Play sequence** plays the scenes in order with hard
cuts (optionally looping); **Record sequence** captures all scenes once as a
video. Scene loads during playback are not undo steps. **Download sequence**
saves all scenes as one JSON file; **Upload sequence…** loads such a file,
replacing or appending the current scenes.

## Animation (first sketch)

A beat clock drives rates that live in the design, so the design itself never
changes while playing (undo stays clean, any frame exports as a still):

- **BPM** — tempo; all rates are *per beat*, so changing tempo keeps the feel.
- **Base field** (Motion → Base field): **Scroll** (stripes travel along their
  normal, lines per beat, shared by every pattern so base and layers stay in
  phase), **Drift** (°/beat), **Line width** between Small and Large (% of x,
  clock or sound; layers inheriting x follow, borders too) and **Swing** of the
  angle from the base angle to an end angle (travel, return, ease, or sound).
  Layer stripe angles turn along with the base.
- **Flip every N beats** — global black/white inversion on a beat grid.
- **Spin** (per layer) — *continuous* (°/beat), *step* (a hard turn of N° every
  N beats) or *punch* (the same turn, but fast and eased right on the beat).
- **Move** (per layer) — the design position is the **start**; tick *Move to an
  end position* and drag the dashed ghost on the canvas (or type End x / y) to
  set the **end**. *Travel* is the time from start to end in beats; *Return* is
  ping-pong, jump back to start, or hold at the end; *Ease* smooth or linear.
  Drive can also be a sound band (quiet = start, loud = end). The end point
  rescales with the format like everything else.
- **Small / Large** (per layer) — two sizes as % of the design size (100 = as
  drawn). **On the beat** picks which one is hit on the beat; **Travel** is the
  time to the other one (beats); **Return** is *ping-pong* (there and back,
  continuous), *jump* (restart on the beat), *hold* (go once, stay) or *snap*
  (hard switch); **Ease** is smooth, linear or punch (fast away, soft arrival);
  **Offset** shifts the cycle so layers can alternate. The same fields drive the
  base line width. The geometry scales, not the stripes: line width stays x.

**Space** toggles play, **F** toggles fullscreen on the stage (black background,
for a beamer or LED wall). **Record loop** in the Motion tab captures N beats in
real time as a WebM video (MP4 in Safari) at the screen format's native pixel
size (print formats are capped at 1920 px on the long side); make the length a
multiple of every period for a seamless loop. Rendering is plain SVG; at A4 size this runs at 60 fps
in Chromium. Audio / MIDI / Ableton Link input is not built yet — that is the
brainstorm.

## Projects

Everything (design, motion, scenes, grid, format) is one project. It is
**autosaved** in the browser and restored when you come back. In ⚙ Setup →
Project you can name it, **save it in the browser** (⌘/Ctrl+S; a list lets you
load or delete saved projects), **save it as a file** (plain JSON, good for
backup, transfer or git) and **open** such a file. *New* starts from the default
canvas.

## Export
**SVG** (vector; print formats carry their size in mm) and **PNG** at the format's
native size: 300 dpi for print (A4 = 2480 × 3508 px, A1 = 7016 × 9933 px),
1080 px wide for Instagram, 2× for a custom canvas.

## Live preview (GitHub Pages)

A workflow at `.github/workflows/pages.yml` deploys the static site to GitHub
Pages on every push. One-time setup (repo must be **public**, or owner on
**GitHub Pro**): *Settings → Pages → Build and deployment → Source: GitHub
Actions*. The site then publishes at `https://studiostudiobe.github.io/volatile/`.

## Roadmap / open questions
- Density **gradient** as a first-class operation (the shaded sphere look).
- True **boolean** regions (intersection / difference) if stacking isn't enough.
- Curved stripe fields (the wrapping/contour effect).
- Typography layer; multi-page / spread guides.
- **Randomise / generate variants** if we want a generative mode.
- Multi-select and a rotate handle on the canvas (single-shape move, resize and grid snapping already work).
- DJ-visual mode: audio-reactive or tempo-synced input, per-parameter LFOs, a canvas/WebGL renderer if SVG gets too slow at wall resolution.
