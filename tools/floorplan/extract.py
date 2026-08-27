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

# Rendered room label -> zone key. Zone keys MUST match db/config.json.
ZONE = {
    'VARDAGSRUM': 'vardagsrum', 'KÖK': 'kok', 'GÅNG': 'gang', 'HALL': 'gang',
    'ENTRÉ1': 'entre1', 'ENTRÉ2': 'entre2',
    'SOV1': 'sov1', 'SOV2': 'sov2', 'SOV3': 'sov3', 'SOV4': 'sov4',
    'BAD1': 'bad1', 'BAD2': 'bad2', 'BAD3': 'bad3',
    'KLK1': 'klk1', 'KLK2': 'klk2',
    'ORANGERI': 'orangeri', 'TVÄTT': 'tvatt', 'LOGGIA': 'loggia', 'BALKONG': 'balkong',
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


def make_base(svg):
    """Strip the drawing down to line-work: no text, metadata, inkscape cruft.

    <defs> is KEPT, and so is any id something actually points at -- the drawing
    may carry a real clipPath, and a dangling clip-path reference can make a
    browser drop the clipped element entirely. Surviving ids are prefixed so a
    future drawing cannot collide with a generated one (a room called `kok`...).
    """
    t = re.sub(r'<text\b.*?</text>', '', svg, flags=re.S)
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


def main():
    svg = open(SRC, encoding='utf8').read()
    vb = re.search(r'viewBox="([\d.\s-]+)"', svg).group(1).split()
    VW, VH = float(vb[2]), float(vb[3])
    W, H = int(VW * PPU), int(VH * PPU)

    labels = read_labels(svg)
    rooms_in = [(ZONE[t], x, y) for t, x, y in labels if t in ZONE]
    marks = [{'text': t, 'x': x, 'y': y} for t, x, y in labels if t not in ZONE]
    seen = {}
    for z, _, _ in rooms_in:
        seen[z] = seen.get(z, 0) + 1
    dupes = [z for z, c in seen.items() if c > 1]
    if dupes:
        sys.exit(f'ERROR: duplicate room labels for {dupes}')
    print(f'{len(rooms_in)} rooms, {len(marks)} fixture markers')

    with tempfile.TemporaryDirectory() as tmp:
        png = os.path.join(tmp, 'walls.png')
        rasterize(re.sub(r'<text\b.*?</text>', '', svg, flags=re.S), W, H, png)
        img = read_gray(png)

    free = img > 250

    # Envelope first: complement of the page background. No morphological closing
    # here -- it eats into the facade and pulls the outline inside the outer wall.
    lab, _ = ndimage.label(free)
    border = set(lab[0, :]) | set(lab[-1, :]) | set(lab[:, 0]) | set(lab[:, -1])
    border.discard(0)
    env = ndimage.binary_fill_holes(~np.isin(lab, list(border)))
    l2, n2 = ndimage.label(env)
    env = ndimage.binary_fill_holes(l2 == int(np.argmax(ndimage.sum(env, l2, range(1, n2 + 1)))) + 1)

    # Rooms may only claim free space INSIDE the building. Without this a room
    # that is open to the exterior (the balcony, the loggia) leaks into the page
    # background and the seeds partition the whole sheet between them.
    inner = free & env

    # A label may sit outside the building -- LOGGIA and BALKONG are annotated
    # from the margin. Snap any such seed to the nearest pixel inside.
    # Snap to a *room-sized* region, not merely the nearest interior pixel: the
    # nearest one is often a sliver between a wall and a railing, and seeding
    # there yields a room of a few square units.
    ilab, inum = ndimage.label(inner)
    isize = ndimage.sum(inner, ilab, range(1, inum + 1))
    roomy = np.zeros_like(inner)
    for k, sz in enumerate(isize, start=1):
        if sz >= 3000:                     # ~47 sq units at 8 px/unit
            roomy |= (ilab == k)
    _, (ny, nx) = ndimage.distance_transform_edt(~roomy, return_indices=True)

    # Rooms: multi-source geodesic flood fill. Plain connected components does not
    # separate rooms -- doorways merge them into one region. Seeding at each label
    # and letting the fills meet splits rooms at their narrowest connection.
    from collections import deque
    owner = np.zeros(img.shape, np.int16)
    q = deque()
    names = ['']
    for i, (zone, x, y) in enumerate(rooms_in, start=1):
        names.append(zone)
        px, py = int(x * PPU), int(y * PPU)
        if not inner[py, px]:
            sy, sx = int(ny[py, px]), int(nx[py, px])
            print(f'  {zone}: label is outside the building, snapped '
                  f'{np.hypot(sy - py, sx - px) / PPU:.1f} units to the nearest interior point')
            py, px = sy, sx
        if owner[py, px]:
            sys.exit(f'ERROR: {zone} seed landed on {names[owner[py, px]]}')
        owner[py, px] = i
        q.append((py, px))
    while q:
        y, x = q.popleft()
        o = owner[y, x]
        for ny2, nx2 in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
            if 0 <= ny2 < H and 0 <= nx2 < W and inner[ny2, nx2] and owner[ny2, nx2] == 0:
                owner[ny2, nx2] = o; q.append((ny2, nx2))

    # NB: a traced boundary can touch itself, making the polygon non-simple.
    # SVG fills and hit-tests it with the nonzero rule, so such a room still
    # covers its fixtures correctly -- an even-odd point-in-polygon test will
    # disagree and wrongly report points inside a bathtub as outside the room.
    rooms = {}
    for i, zone in enumerate(names):
        if i == 0:
            continue
        # Close hard enough to bridge a fixture outline: a bathtub or shower rim
        # is ink drawn INSIDE the room, so the space behind it ends up as a
        # separate connected component of the room's own mask, and trace() keeps
        # only the largest -- silently cutting the tub out of the bathroom.
        m = ndimage.binary_closing(owner == i, np.ones((9, 9)))
        m = ndimage.binary_fill_holes(m)
        lb, nc = ndimage.label(m)
        if nc > 1:
            sizes = ndimage.sum(m, lb, range(1, nc + 1))
            dropped = sizes.sum() - sizes.max()
            if dropped / sizes.sum() > 0.02:
                print(f'  WARNING {zone}: trace drops {dropped / sizes.sum():.0%} of the room '
                      f'({int(dropped)} px) as a detached component')
        loop = trace(m)
        if not loop:
            sys.exit(f'ERROR: could not trace {zone}')
        pts = to_units(simplify(loop, 3.0))
        anchor = next((x, y) for z, x, y in rooms_in if z == zone)
        rooms[zone] = {'points': pts, 'anchor': list(anchor)}
        print(f'  {zone:<11} {len(pts):>3} pts')

    silhouette = to_units(simplify(trace(ndimage.binary_dilation(env, np.ones((3, 3)), iterations=3)), 3.0))

    pts = [p for r in rooms.values() for p in r['points']] + silhouette
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    ox, oy = min(xs) - 1.0, min(ys) - 1.0
    vw = round((max(xs) - min(xs) + 2) * SCALE)
    vh = round((max(ys) - min(ys) + 2) * SCALE)

    out = {
        'transform': {'origin': [round(ox, 3), round(oy, 3)], 'scale': SCALE, 'viewBox': [0, 0, vw, vh]},
        'silhouette': silhouette,
        'rooms': rooms,
        'fixtures': marks,
    }
    json.dump(out, open(os.path.join(HERE, 'geometry.json'), 'w'), ensure_ascii=False, indent=1)
    open(os.path.join(HERE, 'base.svg'), 'w', encoding='utf8').write(make_base(svg))
    print(f'\nviewBox 0 0 {vw} {vh}   origin ({ox:.2f}, {oy:.2f})  scale {SCALE}')
    print('wrote geometry.json + base.svg -- now run: node tools/floorplan/generate.mjs')


main()
