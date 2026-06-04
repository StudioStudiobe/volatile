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

### On the canvas
Click a shape (or its layer) to select it, **drag** to move, and drag a **corner
handle** to resize (center-anchored, rotation-aware). The numeric fields sync when
you release. Selection handles never appear in the exported SVG.

## Presets
Four buttons reproduce the reference mechanisms to start from:
**Dome + triangle** (orientation shift + knock-out), **Focus capsules**
(orientation contrast), **Diagonal cut** (knock-out + re-fill), **Disc** (solid).

## Export
**SVG** (vector, print-ready) and **PNG** (2×).

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
