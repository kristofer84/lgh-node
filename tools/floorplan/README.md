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
| `lights.json` | per-device glow positions. Auto-seeded in a ring around the room anchor on first run, then **hand-edit it** — `"auto": true` marks one that has never been placed properly |
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

`extract.py` derives `geometry.json` and `base.svg` from `lgh_rot.svg`. It needs
`rsvg-convert` plus python3 with numpy/scipy, and takes about 45 s.

1. Strip `<text>` from the drawing and rasterize the walls at 8 px/mm.
2. Seed a **multi-source geodesic flood fill** at each room's text anchor. Plain
   connected components does *not* work: doorways merge Hall/Kök/Vardagsrum/Entré
   into one region. Flooding from labelled seeds splits rooms at their narrowest
   connection, which is the doorway.
3. Moore-neighbour boundary trace + Douglas–Peucker to get 5–32 point polygons.
4. The apartment envelope (`#rooms-outline`) is the complement of the page
   background, filled and slightly dilated. Do **not** add a morphological
   closing to tidy the door-swing arcs: it eats into the facade and pulls the
   silhouette inside the outer wall.

⚠ **Read room names from the rendered `<text>` content, not from `inkscape:label`.**
Several labels in `lgh_rot.svg` are stale — the room whose text reads `SOV2`
carries `inkscape:label="Klk2"`.

⚠ **A room label may sit outside the building.** `LOGGIA` and `BALKONG` are annotated
from the margin, so their label coordinates are in the page background, not in the room.
`extract.py` snaps such a seed to the nearest *room-sized* interior region — nearest
interior *pixel* is not enough, as that is often a sliver between a wall and a railing
and yields a room of a few square units.

⚠ **The room flood fill is confined to the building envelope.** A room open to the
exterior (the balcony, the loggia) otherwise leaks into the page background, and the
competing seeds partition the whole sheet between them — `loggia` and `balkong` came out
at 21 000 units² covering the entire page.

⚠ **A new room label must be added to the `ZONE` map in `extract.py`**, and its zone key
must exist in `db/config.json`. When `HALL` was renamed `GÅNG`, the zone key became
`gang` — the HA devices are still named `hall_*`, because those are entity ids, not room
names.

## Coordinate system

The apartment occupies only part of the A4 page, so the transform crops to it:
`scale(3) translate(-45.88, -33)`, giving `viewBox="0 0 354 692"`.

⚠ The scale is chosen so the width stays ~354 against the old plan's 342. Every
stroke width, font size and glow radius in `style.css` is in **user units** with no
`vector-effect`, so they are all implicitly relative to that number. Changing the
scale silently rescales the entire UI.

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
- `.temp`, `.name-blocker` and `.device` elements must all be emitted with `hidden`.
  `home.js` derives the current toggle state with `$('.temp').hasClass('hidden')`, so
  one un-hidden element inverts the checkbox.
