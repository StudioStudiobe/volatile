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
- **stripes** — fill the shape with a stripe pattern. One operation covers three
  effects: change **angle** (orientation shift), toggle **inverted**
  (figure-ground swap), change **line** width (local density). `line = 0` inherits
  the base width.
- **fill** — solid fill: `paper` (knock-out / negative space) or `ink` (solid black).
- **outline** — stroke only, optionally **dashed** — for construction lines.

Any layer can also carry a **border** — a stroke around the shape at the base line
width `x` (so a white knock-out with a black outline gives the dome look).

The stripe rule is locked: **black line = x, gap = x / 2** (so ⅔ ink coverage).
A global **Invert** swaps black and white for the whole composition.

> Patterns are drawn in a shared coordinate space, so a stripe layer with the
> same settings as the base is invisible *except* where it sits over a knock-out.
> That's how the "XOR" look (a shape re-filling only the negative area) is made —
> no boolean engine needed yet.

## Formats

The document has a **format**: `A5` `A4` `A3` `A2` `A1` (portrait or landscape) or
`IG post 1:1` `IG post 4:5` `IG reel 9:16`. Switching format keeps the
composition: every layer *and the line width x* are scaled uniformly from the
centre of the canvas, so an A4 design re-issued as A1 is the same image,
enlarged.

- Print formats work in **0.1 mm units** (A4 = 2100 × 2970). The panel shows the
  physical line width, and the SVG export carries real `mm` dimensions.
- Screen formats work in **px** (Instagram: 1080 wide).
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
handle** to resize (center-anchored, rotation-aware). The numeric fields sync when
you release. Selection handles never appear in the exported SVG.

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
- Multi-select, snapping and a rotate handle on the canvas (single-shape move + resize already work).
- Save / load a composition as JSON (state currently lives only in the tab).
- Motion / DJ-visual mode (to be brainstormed).
