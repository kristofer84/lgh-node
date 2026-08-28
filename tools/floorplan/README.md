# Floorplan pipeline

`web/dashboard.html` is **generated**, not hand-edited. Regenerate with:

```bash
node tools/floorplan/generate.mjs          # writes web/dashboard.html
node tools/floorplan/generate.mjs --check  # non-zero exit if it is stale
```

> ⚠ **Do not edit `web/dashboard.html` by hand** — the next regeneration overwrites it.
> Change `db/config.json`, `lights.json` or `geometry.json` instead.

## Why it is generated

The markup and `db/config.json` used to be two hand-maintained lists that had to
agree on four separate naming contracts, none of them validated anywhere:

| contract | broke as |
|---|---|
| `<g class="room" id="X">` ⟷ a key of `config.zones` | click logs `Missing zone`, and `updateView` could throw |
| `class="item" id="Y"` ⟷ first segment of a `.light`/`.switch` entry | click is a silent server-side no-op |
| `id="th-Z"` ⟷ a `.sensor` named `Z` ending `temperature`/`humidity` | reading never renders |
| `class="device" id="W"` ⟷ `W_…_w` in `config.zones.devices` | appliance never lights up |

They had in fact drifted: `id="sovrum_3_hoger"` / `sovrum_3_vanster` in the markup
matched no config entry, so those two clicks did nothing at all. Generating the
markup from the config makes all four contracts true by construction, and the
generator warns about the cases it cannot fix (a zone with no room, a room with no
zone, a power sensor with no marker in the plan).

## Inputs

| file | what it is |
|---|---|
| `geometry.json` | room polygons, per-room text anchors, fixture markers, and the source→dashboard transform |
| `base.svg` | the architectural line-work, drawn over the room tint (`pointer-events: none`) |
| `readouts.json` | per-zone nudge for the temperature/humidity readout, in drawing units. Hand-edited; `extract.py` never writes it |
| `lights.json` | per-device glow positions, or `{"run": "Köksbänk", "count": 6}` to space lamps evenly along a run outlined on the `Rum` layer. `"symbol": false` drops the ring and keeps the glow — strip lighting reads better as a glow than as a row of rings. `"tap": false` drops the hit disc too, making the lamp **display-only**: it still glows to show its state, but the press falls through to the room behind it (badrum 1–3 and klk1 are set this way — every lamp in those rooms is switched together, so a per-lamp target is only a way to miss the room). A `tap: false` point is also left out of the neighbour search, so it never shrinks another lamp's radius. `"under": true` (with `run`) means the lamp sits *beneath* that piece of furniture: the furniture is drawn, and the glow is clipped to the room **minus** the furniture, so the light spills out around it instead of through it. The tap target stays at the furniture's centre. Auto-seeded in a ring around the room anchor on first run, then **hand-edit it** — `"auto": true` marks one that has never been placed properly. An entry here is also what makes an *untiered* light an item at all (see the tier/entry note below) |
| `dashboard.template.html` | everything outside the `<svg>`; `<!--FLOORPLAN-->` is the splice point |
| `../../db/config.json` | the zones. Decides what is emitted at all |
| `lgh_rot.svg` | the original Inkscape drawing, kept for re-extraction |
| `extract.py` | rebuilds `geometry.json` + `base.svg` from that drawing |

## Re-extracting geometry from a new drawing

```bash
cp ~/lgh_rot.svg tools/floorplan/lgh_rot.svg
python3 tools/floorplan/extract.py      # -> geometry.json + base.svg
node   tools/floorplan/generate.mjs     # -> web/dashboard.html
```

**Room outlines are read from a layer called `Rum`.** One shape per room, labelled
with the room name (`inkscape:label`), drawn with the line tool — the parser handles
`M/L/H/V/Z` and `<rect>`, not curves. Shapes on that layer whose label is *not* a room
become **fixture runs** (`Köksbänk`, `Kökshylla`, `Bänk`), which a lamp can be spaced
along; see `lights.json` below.

This replaced a multi-source flood fill over a rasterised plan. That worked, but it had
to infer where one room ended and the next began, and every awkward case needed a
correction: it split rooms at doorways by guessing, carved bathtubs and vanities out of
their rooms, handed the kitchen's counter to the corridor, and gave `gang` every wardrobe
niche it could reach. Hand-drawn outlines are authoritative and the whole class of
problem is gone, along with `rooms-override.json`, which existed only to patch it up.
Extraction also dropped from ~45 s to ~7 s.

`extract.py` still rasterises once, for the apartment envelope (`#rooms-outline`): that
follows the *outside* of the walls, which room outlines drawn on the inside faces cannot
describe.

Checks it runs, each of which has caught a real mistake:

- every room's **text label must fall inside its own outline** — that is what ties the
  `Rum` layer to the room names. `LOGGIA` and `BALKONG` are labelled from the margin, so
  their anchors fall back to the nearest point inside the shape;
- **rooms must not overlap** — a hand-drawn outline is easy to nudge over a wall;
- a trace that **drops a detached component** is reported.

⚠ **Read room names from the rendered `<text>` content, not from `inkscape:label`** — on
the *text* elements several labels are stale (the room reading `SOV2` carries
`inkscape:label="Klk2"`). On the `Rum` layer the labels are the only identifier there is,
and they are trusted; the label-inside-outline check is what guards them.

⚠ **The `Rum` layer must not reach `base.svg`.** It is annotation, not artwork — left in,
its outlines are drawn on the dashboard.

## Coordinate system

The apartment occupies only part of the A4 page, so the transform crops to it:
`scale(3) translate(-45.88, -33)`, giving `viewBox="0 0 354 692"`.

⚠ The scale is chosen so the width stays ~354 against the old plan's 342. Every
stroke width, font size and glow radius in `style.css` is in **user units** with no
`vector-effect`, so they are all implicitly relative to that number. Changing the
scale silently rescales the entire UI.

## Anatomy of a light

Each lamp is emitted as a group, and the three circles have distinct jobs:

```html
<g class="item" id="<device>">                <!-- the click target, per home.js -->
  <circle class="glow mood"  r="34" fill="url(#pf)" pointer-events="none"/>
  <circle class="point"      r="6"            pointer-events="none"/>
  <circle class="hit"        r="12" fill="none" pointer-events="all"/>
</g>
```

- ⚠ **The lamps are drawn in their own `#lights` layer, AFTER the base plan.** Inside the
  room groups (below the artwork) a bathroom's ceiling lights vanished behind the bathtub
  and toilet outlines. The layer is still clipped per room so a glow cannot cross a wall.
  Because the lamps are no longer descendants of the room group, `home.js`'s room click
  clears their `state` **by name from the model**, not with `$(ar).find('*')`.
  For the same reason no CSS selector can walk from a room to its lamps, so each zone's lamps
  sit in `<g id="lights-<zone>" class="zone-lights">` and `updateArea()` **mirrors the room's
  `light` value onto that group**. That is what lets `style.css` say "every lamp in a room
  that is fully on" — which it uses to drop the individual glows at the `on` step, where the
  room is washed amber anyway and the glows only muddy it. Mirroring in `updateArea()` rather
  than `updateView()` means the optimistic update on a room press gets it too.
- ⚠ **Absorbing fixtures can also hand a room space that is not really its own.**
  `gang` collected every wardrobe niche it could reach plus an arm along the top of the
  kitchen, ending up at 1517 units² for what is really a corridor. It is overridden in
  `rooms-override.json` as a plain rectangle. `vardagsrum`, `entre1` and `kok` are
  overridden alongside it so the four tile cleanly: vardagsrum's ragged diagonal bottom
  and entre1's top both become the corridor's top line, and the kitchen takes the strip
  gang vacated above it plus the counter run down its left side.

  Two things to check after editing an override, both of which caught real mistakes here:
  keep the room's **text anchor inside the shape** (readouts and automatic lamp placement
  use it), and **sample for overlaps against every other room** — a rectangle drawn by eye
  ran into `tvatt`, `sov3` and `bad3` before the numbers were checked.
- ⚠ **Fixtures drawn inside a room are absorbed back into it** (`extract.py`). A bathtub,
  shower tray or vanity is ink, so the flood fill cannot enter it and the room polygon
  notches around every fixture — measured at 3762 px of the bathroom lamps being clipped
  away. Two things that made this hard to get right: the neighbour search must dilate by
  **more than one pixel** (a pocket is ringed by the fixture's own outline, so at 1 px it
  borders only ink and looks unbordered), and it must run in a **per-component bounding
  box** (dilating each of thousands of components across the full raster takes minutes).
- ⚠ **A traced room boundary can touch itself, making the polygon non-simple.** SVG fills
  and hit-tests it with the **nonzero** rule, so the room still covers its fixtures
  correctly — but an even-odd point-in-polygon test disagrees and will wrongly report a
  point inside a bathtub as outside the room. Do not "fix" a room on the strength of such
  a test; render it and look.
- ⚠ **Two independent things decide what a light gets: the tier and the `lights.json`
  entry.** A `.mood`/`.night` tier in `db/config.json` says *"this lamp belongs to the
  room's mood/night scene"* — it comes on when you cycle the room to that state, and its
  glow previews with the room. A `lights.json` entry says *"this lamp is a thing you can
  see and tap"* — it gets its own symbol, glow and hit disc, and `[state="on"] .glow`
  lights that glow exactly when the lamp itself is on. **Either one alone is enough to
  make a light an item.** `mikkel_garderob` and `kai_garderob` are placed but untiered:
  visible and tappable, but a wardrobe light has no business joining a mood scene. A light
  with neither is toggled with the room and draws nothing.
  The check reads `lights.json` directly and must **not** go through `placement()`, which
  auto-seeds an entry for whatever it is asked about — routing it that way would turn
  every plain light in the flat into an item on the next run.
- **One device can be several physical lamps.** Give its `lights.json` entry
  `"points": [[x,y], [x,y]]` instead of `cx`/`cy` and it emits a glow, symbol and hit
  disc per point inside a single `<g class="item">`, so they toggle together as the one
  device they are. `vardagsrum_vaggar` is a pair flanking the dining table,
  `vardagsrum_soffa` a pair along the far wall, `koksbank` a run of five along the
  counter, and each bathroom ceiling light a 2×2 spread across the room — the same
  treatment the pre-2026-08 dashboard gave them (7 in a row for the counter, 4 in a
  grid per bathroom).
- ⚠ **The glow must not be the click target.** While one circle was both, a lamp's hit
  area was its entire radial gradient — up to `r=60` — so clicking anywhere in vardagsrum
  hit whichever lamp was topmost and the room itself was nearly unclickable.
- `.point` is the always-visible symbol: outlined when the lamp is off, filled `#ffcc00`
  when on, driven by `state` on the group.
- `.hit` is an invisible disc giving a tappable area (`r=6` is ~13 px on a phone).
  ⚠ Its radius is **computed as half the distance to the nearest point of a *different*
  device**, clamped to 7–14, so two hit areas can never steal each other's clicks. (Two
  points of the same device may overlap — they toggle the same thing.) A fixed radius
  broke as soon as two lamps sat close together.
- ⚠ `state` on the group is set by `home.js` **from the model** (`updateView`). Do not go
  back to the old `getComputedStyle(...).opacity` heuristic — it inferred on/off from
  whether the glow was visible, which says nothing now the symbols are always drawn.
- ⚠ The glow class is `glow mood`, and `[state] .glow` rules carry `!important`. Putting
  `state` on the group while `[state="off"] { opacity: 0 }` targeted the element itself
  would hide the symbol along with the glow.

## Gotchas paid for once

- ⚠ **Never clip `#base-plan`.** It was originally clipped to `#rooms-outline`, copying the
  old design where a rectangular photo had to be trimmed to the apartment. On line-art that
  only destroys drawing: wherever the traced silhouette ran along the *inner* face of an
  outer wall, the clip removed that wall — the whole angled facade and the walls around
  KLK1/LOGGIA vanished, ~36k pixels, and the rooms looked like they spilled into empty space.
  `#rooms-outline` is now used only for the soft border in `#border-fade`.
- ⚠ **The room outline polygons live in `<defs>`**, and both the room group and its
  `clipPath` reference them with `<use>`. Putting the polygon inside the group it
  clips is a circular reference: the clip is then ignored and every glow bleeds
  through the walls into neighbouring rooms.
- The glow gradient uses `var(--sc)`, defined in `style.css` as `stop { --sc: #ffcc00 }`.
  It renders black in `rsvg-convert`, which does not resolve CSS variables — that is
  a preview artefact, not a bug. Substitute the literal colour when rasterizing.
- ⚠ **`<defs>` from the drawing must survive.** It sits *before* the first `<g>`, so
  slicing the artwork from `indexOf('<g')` silently dropped it. The current drawing has a
  real `<clipPath>`, and a dangling `clip-path` reference can make a browser refuse to
  render the clipped element. `extract.py` keeps every id something points at (prefixed
  `plan-` so a future drawing cannot collide with a generated id such as a zone name),
  and `generate.mjs` takes everything inside the root `<svg>`.
- ⚠ **Inkscape writes presentation properties into `style=""`, and the CSP forbids that.**
  `mqtt-web.js` sends `style-src 'self'` with no `'unsafe-inline'`, and `style-src` governs
  style *attributes* too — a browser refuses them, and the wall paths carry no `fill`
  fallback, so the grey poché would render black. `generate.mjs` rewrites those
  declarations into presentation attributes at build time; it prints how many on every
  run. Two traps if you touch that step: convert **per element, replacing an existing
  attribute rather than appending** (appending gives `Attribute fill redefined` and the
  whole document fails to parse), and keep `stop-color` / `stop-opacity` / `vector-effect`
  in the allowed set — dropping `stop-color` silently kills the gradients in the drawing.
  Only `font-variation-settings` and `-inkscape-stroke` are safely discarded.
- `home.js` binds clicks with `$(".room").click(...)` at ready — **direct binding, not
  delegation** — so the generated markup must be static in the file. Anything
  injected later is inert.
- `.temp` and `.device` elements must all be emitted with `hidden`. `home.js` derives the
  current toggle state with `$('.temp').hasClass('hidden')`, so one un-hidden element
  inverts the checkbox.
- ⚠ **`#readouts` carries `pointer-events="none"`.** The layer sits above the room groups,
  so without it a temperature label swallows clicks meant for the room underneath whenever
  temps are shown. (While the readouts lived *inside* the room groups, clicking a label
  toggled the room; this keeps that behaviour.)
- ⚠ **`clip-rule` belongs on the clip path's child shape, not on `<clipPath>`.** The
  "spill" clip for an `under` lamp is the room and the furniture as two subpaths with
  `clip-rule="evenodd"`; put that attribute on the `<clipPath>` and renderers do not all
  inherit it, so nothing is punched out. Its `<clipPath>` must also be pushed into `defs`
  **before** `defs` is flushed into the output, or the glow carries a dangling
  `clip-path` reference — which can stop it rendering at all.
- ⚠ **A light-point ring must NOT carry the `mood`/`night` class.** The rings are emitted
  as `class="point point-mood"` (not `point mood`) because `.mood, .night { opacity: 0 }`
  applies until the room is lit — reusing the tier class hides the ring it is meant to
  show. The hide-when-lit rules key off `.point-mood` / `.point-night`.
- The old white `.name-blocker` rects behind each readout are gone. They existed to mask
  room names printed into the background *photo*; the plan is line-art, so there is
  nothing to mask and the readouts sit directly on the drawing.
