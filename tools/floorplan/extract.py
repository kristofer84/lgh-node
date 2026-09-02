#!/usr/bin/env python3
"""Derive geometry.json + base.svg from the Inkscape drawing.

    python3 tools/floorplan/extract.py [drawing.svg]

Defaults to tools/floorplan/lgh_rot.svg. Needs rsvg-convert, numpy, scipy.
Run tools/floorplan/generate.mjs afterwards to rebuild web/dashboard.html.

Room names are read from the rendered <text> content, NOT from inkscape:label
-- several of those labels are stale (the room reading SOV2 is labelled Klk2).
"""
import json, os, re, subprocess, sys, tempfile
import numpy as np
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'lgh_rot.svg')
PPU = 8      # raster pixels per drawing unit
SCALE = 3    # drawing units -> dashboard user units

# Extra empty margin added to the BOTTOM of the viewBox, in drawing units. The
# envelope (silhouette) stops at the apartment's lowest wall, but the drawing
# (appliances, vinkyl, …) and the readout space need a little more room below
# it. 12 drawing units = 36 user units, taking the viewBox from 694 to 730 tall.
BOTTOM_PAD = 12.0

# Rendered room label -> zone key. Zone keys MUST match db/config.json.
ZONE = {
    'VARDAGSRUM': 'vardagsrum', 'KÖK': 'kok', 'GÅNG': 'gang', 'HALL': 'gang',
    'ENTRÉ1': 'entre1', 'ENTRÉ2': 'entre2',
    'SOV1': 'sov1', 'SOV2': 'sov2', 'SOV3': 'sov3', 'SOV4': 'sov4',
    'BAD1': 'bad1', 'BAD2': 'bad2', 'BAD3': 'bad3',
    'KLK1': 'klk1', 'KLK2': 'klk2',
    'ORANGERI': 'orangeri', 'TVÄTT': 'tvatt', 'LOGGIA': 'loggia', 'BALKONG': 'balkong',
    # the Rum layer spells a couple of them out in full
    'TVÄTTSTUGA': 'tvatt',
}


def read_labels(svg):
    out = []
    for m in re.finditer(r'<text\b(.*?)</text>', svg, re.S):
        attrs, block = m.group(1), m.group(0)
        x = re.search(r'\bx="([-\d.]+)"', attrs)
        y = re.search(r'\by="([-\d.]+)"', attrs)
        txt = ''.join(re.findall(r'<tspan\b[^>]*>(.*?)</tspan>', block, re.S)) or re.sub(r'<[^>]+>', '', block)
        txt = re.sub(r'\s+', ' ', txt).strip()
        if x and y and txt:
            out.append((txt, float(x.group(1)), float(y.group(1))))
    return out


def rasterize(svg_text, w, h, path):
    with tempfile.NamedTemporaryFile('w', suffix='.svg', delete=False) as f:
        f.write(svg_text)
        tmp = f.name
    subprocess.run(['rsvg-convert', '-w', str(w), '-h', str(h), '-b', 'white', tmp, '-o', path], check=True)
    os.unlink(tmp)


def read_gray(png):
    pgm = png + '.pgm'
    subprocess.run(['convert', png, '-colorspace', 'gray', '-depth', '8', pgm], check=True)
    d = open(pgm, 'rb').read()
    os.unlink(pgm)
    i, parts = 0, []
    while len(parts) < 4:
        while d[i:i + 1].isspace():
            i += 1
        if d[i:i + 1] == b'#':
            while d[i:i + 1] not in (b'\n', b'\r'):
                i += 1
            continue
        j = i
        while not d[j:j + 1].isspace():
            j += 1
        parts.append(d[i:j]); i = j
    i += 1
    w, h = int(parts[1]), int(parts[2])
    return np.frombuffer(d[i:i + w * h], np.uint8).reshape(h, w)


def trace(mask):
    """Moore-neighbour boundary trace of the largest component."""
    lab, n = ndimage.label(mask)
    if n == 0:
        return None
    sizes = ndimage.sum(mask, lab, range(1, n + 1))
    mask = lab == int(np.argmax(sizes)) + 1
    H, W = mask.shape
    ys, xs = np.nonzero(mask)
    start = (ys.min(), xs[ys == ys.min()].min())
    nb = [(0, 1), (1, 1), (1, 0), (1, -1), (0, -1), (-1, -1), (-1, 0), (-1, 1)]
    cur, bdir, out = start, 4, [start]
    for _ in range(4 * int(mask.sum()) + 10):
        moved = False
        for k in range(8):
            d = (bdir + 1 + k) % 8
            ny, nx = cur[0] + nb[d][0], cur[1] + nb[d][1]
            if 0 <= ny < H and 0 <= nx < W and mask[ny, nx]:
                bdir = (d + 5) % 8
                cur = (ny, nx); out.append(cur); moved = True
                break
        if not moved:
            break
        if cur == start and len(out) > 2:
            break
    return out


def simplify(pts, eps):
    a = np.array(pts, float)

    def rec(i, j):
        if j <= i + 1:
            return [i]
        p, q = a[i], a[j]
        d = q - p
        L = float(np.hypot(*d))
        seg = a[i + 1:j] - p
        dist = np.abs(d[0] * seg[:, 1] - d[1] * seg[:, 0]) / L if L else np.hypot(seg[:, 0], seg[:, 1])
        m = int(np.argmax(dist))
        if dist[m] > eps:
            k = i + 1 + m
            return rec(i, k) + rec(k, j)
        return [i]

    idx = rec(0, len(a) - 1) + [len(a) - 1]
    return [pts[i] for i in idx]


def to_units(loop):
    pts = [(round(x / PPU, 2), round(y / PPU, 2)) for (y, x) in loop]
    ded = [pts[0]]
    for p in pts[1:]:
        if p != ded[-1]:
            ded.append(p)
    return ded


def parse_path(d):
    """Straight-line subset of SVG path data: M/m L/l H/h V/v Z/z. The Rum layer
    is drawn with the line tool, so there are no curves to worry about."""
    toks = re.findall(r'[MmLlHhVvZz]|-?\d*\.?\d+(?:[eE][-+]?\d+)?', d)
    pts, cur, cmd, i = [], [0.0, 0.0], None, 0
    while i < len(toks):
        t = toks[i]
        if t in 'MmLlHhVvZz':
            cmd = t; i += 1; continue
        if cmd in 'Mm':
            x, y = float(toks[i]), float(toks[i + 1]); i += 2
            cur = [cur[0] + x, cur[1] + y] if cmd == 'm' else [x, y]
            pts.append((cur[0], cur[1]))
            cmd = 'l' if cmd == 'm' else 'L'        # implicit lineto after moveto
        elif cmd in 'Ll':
            x, y = float(toks[i]), float(toks[i + 1]); i += 2
            cur = [cur[0] + x, cur[1] + y] if cmd == 'l' else [x, y]
            pts.append((cur[0], cur[1]))
        elif cmd in 'Hh':
            x = float(toks[i]); i += 1
            cur = [cur[0] + x, cur[1]] if cmd == 'h' else [x, cur[1]]
            pts.append((cur[0], cur[1]))
        elif cmd in 'Vv':
            y = float(toks[i]); i += 1
            cur = [cur[0], cur[1] + y] if cmd == 'v' else [cur[0], y]
            pts.append((cur[0], cur[1]))
        else:
            i += 1
    return pts


def read_rum_layer(svg):
    """Room outlines drawn by hand on the 'Rum' layer, plus the fixture runs.

    These are authoritative: they replaced a flood-fill segmentation that had to
    guess where a doorway ended and could not tell a wardrobe niche from a room.
    """
    i = svg.find('inkscape:label="Rum"')
    if i < 0:
        return None, None
    block = svg[svg.rfind('<g', 0, i):svg.rindex('</svg>')]
    if re.search(r'transform=', block[:block.index('>')]):
        sys.exit('ERROR: the Rum layer carries a transform; coordinates would be wrong')
    shapes = {}
    for m in re.finditer(r'<(path|rect)\b((?:[^>"]|"[^"]*")*?)/?>', block):
        tag, attrs = m.group(1), m.group(2)
        lab = re.search(r'inkscape:label="([^"]*)"', attrs)
        if not lab:
            continue
        if tag == 'path':
            pts = parse_path(re.search(r'\bd="([^"]*)"', attrs).group(1))
        else:
            f = lambda k: float(re.search(r'\b%s="([-\d.]+)"' % k, attrs).group(1))
            x, y, w, h = f('x'), f('y'), f('width'), f('height')
            pts = [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
        # drop a repeated closing point
        if len(pts) > 1 and abs(pts[0][0] - pts[-1][0]) < 1e-6 and abs(pts[0][1] - pts[-1][1]) < 1e-6:
            pts = pts[:-1]
        shapes[lab.group(1)] = [(round(x, 2), round(y, 2)) for x, y in pts]
    # Layer labels are mixed case ('Vardagsrum', 'Tvättstuga'); the text labels
    # they must agree with are upper case.
    rooms = {ZONE[k.upper()]: v for k, v in shapes.items() if k.upper() in ZONE}
    runs = {k: v for k, v in shapes.items() if k.upper() not in ZONE}
    return rooms, runs


def make_base(svg):
    """Strip the drawing down to line-work: no text, metadata, inkscape cruft.

    <defs> is KEPT, and so is any id something actually points at -- the drawing
    may carry a real clipPath, and a dangling clip-path reference can make a
    browser drop the clipped element entirely. Surviving ids are prefixed so a
    future drawing cannot collide with a generated one (a room called `kok`...).
    """
    # The Rum layer is annotation, not artwork -- strip it or its outlines are
    # drawn on the dashboard.
    i = svg.find('inkscape:label="Rum"')
    if i >= 0:
        t = svg[:svg.rfind('<g', 0, i)] + '</svg>'
    else:
        t = svg
    t = re.sub(r'<text\b.*?</text>', '', t, flags=re.S)
    t = re.sub(r'<metadata\b.*?</metadata>', '', t, flags=re.S)
    t = re.sub(r'<sodipodi:namedview\b.*?</sodipodi:namedview>', '', t, flags=re.S)
    t = re.sub(r'<sodipodi:namedview\b[^>]*/>', '', t)
    t = re.sub(r'\s(inkscape|sodipodi):[\w-]+="[^"]*"', '', t)

    referenced = set(re.findall(r'url\(#([^)\s]+)\)', t)) | set(re.findall(r'(?:xlink:)?href="#([^"]+)"', t))
    for rid in referenced:
        t = t.replace(f'url(#{rid})', f'url(#plan-{rid})')
        t = t.replace(f'href="#{rid}"', f'href="#plan-{rid}"')
    t = re.sub(r'\sid="([^"]*)"',
               lambda m: f' id="plan-{m.group(1)}"' if m.group(1) in referenced else '', t)
    if referenced:
        print(f'  kept {len(referenced)} referenced id(s) from the drawing: '
              + ', '.join(sorted(referenced)))
    return re.sub(r'd="([^"]*)"',
                  lambda m: 'd="' + re.sub(r'-?\d+\.\d+',
                                           lambda k: f'{float(k.group()):.2f}'.rstrip('0').rstrip('.'),
                                           m.group(1)) + '"', t)


def point_in(pts, p):
    x, y = p
    w = False
    for i in range(len(pts)):
        xi, yi = pts[i]
        xj, yj = pts[i - 1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            w = not w
    return w


def sample_points(pts, step):
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    x = min(xs)
    while x < max(xs):
        y = min(ys)
        while y < max(ys):
            if point_in(pts, (x, y)):
                yield (x, y)
            y += step
        x += step


def main():
    svg = open(SRC, encoding='utf8').read()
    vb = re.search(r'viewBox="([\d.\s-]+)"', svg).group(1).split()
    VW, VH = float(vb[2]), float(vb[3])
    W, H = int(VW * PPU), int(VH * PPU)

    labels = read_labels(svg)
    anchors = {ZONE[t]: (x, y) for t, x, y in labels if t in ZONE}
    marks = [{'text': t, 'x': x, 'y': y} for t, x, y in labels if t not in ZONE]

    rooms_pts, runs = read_rum_layer(svg)
    if not rooms_pts:
        sys.exit("ERROR: no 'Rum' layer in the drawing. Room outlines are read from "
                 "that layer; draw one shape per room and label it with the room name.")
    print(f'{len(rooms_pts)} room outlines, {len(runs)} fixture runs, {len(marks)} markers')

    missing = [z for z in rooms_pts if z not in anchors]
    if missing:
        sys.exit(f'ERROR: no text label inside {missing}; the anchor is needed for readouts')

    # Every room's text label must land inside its own outline -- that is what
    # ties the two layers together, and it catches a mislabelled shape.
    rooms = {}
    for zone, pts in rooms_pts.items():
        a = anchors[zone]
        if not point_in(pts, a):
            # LOGGIA and BALKONG are labelled from the margin, outside the room.
            # Fall back to a point that is definitely inside, since the anchor
            # positions the readout and seeds automatic lamp placement.
            inside_pts = list(sample_points(pts, 0.5))
            if not inside_pts:
                sys.exit(f'ERROR: {zone} outline encloses no area')
            a = min(inside_pts, key=lambda q: (q[0] - a[0]) ** 2 + (q[1] - a[1]) ** 2)
            print(f'  {zone}: label is outside its outline, anchored at {a[0]:.1f},{a[1]:.1f} instead')
        rooms[zone] = {'points': pts, 'anchor': [round(a[0], 3), round(a[1], 3)]}

    # Rooms must not overlap. A hand-drawn outline is easy to nudge over a wall.
    zs = list(rooms)
    for i, a in enumerate(zs):
        for b in zs[i + 1:]:
            hits = sum(1 for p in sample_points(rooms[a]['points'], 0.8) if point_in(rooms[b]['points'], p))
            if hits:
                print(f'  WARNING {a} and {b} overlap ({hits} sample points)')

    # The apartment envelope, for the soft border. This is the only thing still
    # needing a raster: it follows the outside of the walls, which the room
    # outlines (drawn on the inside faces) do not describe.
    with tempfile.TemporaryDirectory() as tmp:
        png = os.path.join(tmp, 'walls.png')
        rasterize(re.sub(r'<text\b.*?</text>', '', make_base(svg), flags=re.S), W, H, png)
        img = read_gray(png)
    free = img > 250
    lab, _ = ndimage.label(free)
    border = set(lab[0, :]) | set(lab[-1, :]) | set(lab[:, 0]) | set(lab[:, -1])
    border.discard(0)
    env = ndimage.binary_fill_holes(~np.isin(lab, list(border)))
    l2, n2 = ndimage.label(env)
    env = ndimage.binary_fill_holes(l2 == int(np.argmax(ndimage.sum(env, l2, range(1, n2 + 1)))) + 1)
    silhouette = to_units(simplify(trace(ndimage.binary_dilation(env, np.ones((3, 3)), iterations=3)), 3.0))

    pts = [p for r in rooms.values() for p in r['points']] + silhouette
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    ox, oy = min(xs) - 1.0, min(ys) - 1.0
    vw = round((max(xs) - min(xs) + 2) * SCALE)
    vh = round((max(ys) - min(ys) + 2 + BOTTOM_PAD) * SCALE)

    out = {
        'transform': {'origin': [round(ox, 3), round(oy, 3)], 'scale': SCALE, 'viewBox': [0, 0, vw, vh]},
        'silhouette': silhouette,
        'rooms': rooms,
        'runs': {k: v for k, v in runs.items()},
        'fixtures': marks,
    }
    json.dump(out, open(os.path.join(HERE, 'geometry.json'), 'w'), ensure_ascii=False, indent=1)
    open(os.path.join(HERE, 'base.svg'), 'w', encoding='utf8').write(make_base(svg))
    for z in sorted(rooms):
        print(f'  {z:<11} {len(rooms[z]["points"]):>3} pts')
    print(f'\nviewBox 0 0 {vw} {vh}   origin ({ox:.2f}, {oy:.2f})  scale {SCALE}')
    print('wrote geometry.json + base.svg -- now run: node tools/floorplan/generate.mjs')


main()
