#!/usr/bin/env node
// Generates web/dashboard.html from:
//   geometry.json  - room polygons + anchors + fixture markers (see extract.md)
//   base.svg       - the architectural line-work, drawn underneath everything
//   lights.json    - per-device glow positions (auto-seeded, then hand-edited)
//   ../../db/config.json - the zones, which decide what actually gets emitted
//
// The point of this file: web/dashboard.html and db/config.json used to be two
// hand-maintained lists that had to agree on four separate naming contracts,
// with no validation anywhere and silent breakage when they drifted. Now the
// markup is derived from the config, so they cannot disagree.
//
//   node tools/floorplan/generate.mjs [--check]
//
// --check verifies the committed dashboard.html is up to date (for CI//pre-commit)
// without writing, exiting non-zero if it would change.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { parseEntry } from '../../web/scripts/zones.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const P = {
	geometry: join(here, 'geometry.json'),
	base: join(here, 'base.svg'),
	lights: join(here, 'lights.json'),
	readouts: join(here, 'readouts.json'),
	overrides: join(here, 'rooms-override.json'),
	template: join(here, 'dashboard.template.html'),
	config: join(repo, 'db', 'config.json'),
	out: join(repo, 'web', 'dashboard.html'),
};

const geo = JSON.parse(readFileSync(P.geometry, 'utf8'));
const config = JSON.parse(readFileSync(P.config, 'utf8'));
const lights = existsSync(P.lights) ? JSON.parse(readFileSync(P.lights, 'utf8')) : {};
const readoutNudge = existsSync(P.readouts) ? JSON.parse(readFileSync(P.readouts, 'utf8')) : {};
//Hand-drawn replacements for rooms the flood fill gets wrong. The segmentation
//gave gang every wardrobe niche it could reach plus an arm over the kitchen;
//it is really just the corridor.
const overrides = existsSync(P.overrides) ? JSON.parse(readFileSync(P.overrides, 'utf8')) : {};
const shapeOf = zone => (Array.isArray(overrides[zone]) ? overrides[zone] : geo.rooms[zone].points);

const [ox, oy] = geo.transform.origin;
const S = geo.transform.scale;
const VB = geo.transform.viewBox;

//Source drawing units -> dashboard user units
const tx = x => +((x - ox) * S).toFixed(1);
const ty = y => +((y - oy) * S).toFixed(1);
const poly = pts => pts.map(([x, y]) => `${tx(x)},${ty(y)}`).join(' ');

const warn = [];
const note = m => warn.push(m);

//---------------------------------------------------------------- parse config
//The grammar lives in web/scripts/zones.js, shared with the server and the
//browser, so this builder cannot drift from what actually gets published.

const zones = {};
for (const [zone, entries] of Object.entries(config.zones)) {
	const parsed = entries.map(parseEntry);
	zones[zone] = {
		lights: parsed.filter(p => p.type === 'light' || p.type === 'switch'),
		sensors: parsed.filter(p => p.type === 'sensor'),
		occupancy: parsed.filter(p => p.type === 'occupancy'),
	};
}

//Zones that have a room drawn for them, and the reverse
for (const zone of Object.keys(zones)) {
	if (!geo.rooms[zone] && zones[zone].lights.length) {
		note(`zone "${zone}" has ${zones[zone].lights.length} light(s) but no room in geometry.json -- it can never be clicked`);
	}
}
for (const zone of Object.keys(geo.rooms)) {
	if (!config.zones[zone]) note(`room "${zone}" is drawn but has no zone in db/config.json -- clicking it logs "Missing zone"`);
}

//---------------------------------------------------------- glow placement
// A light with no recorded position is seeded in a ring around the room's text
// anchor (which is guaranteed to sit inside the room). Positions are written
// back to lights.json so they can be nudged by hand and survive regeneration.
let seeded = 0;

//Shoelace area and area-centroid, in source units
function polyArea(pts) {
	let a = 0;
	for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
	return Math.abs(a) / 2;
}
function polyCentroid(pts) {
	let a = 0, cx = 0, cy = 0;
	for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
		const f = pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
		a += f; cx += (pts[j][0] + pts[i][0]) * f; cy += (pts[j][1] + pts[i][1]) * f;
	}
	a /= 2;
	return a ? [cx / (6 * a), cy / (6 * a)] : null;
}
function inside(pts, [x, y]) {
	let win = false;
	for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
		const [xi, yi] = pts[i], [xj, yj] = pts[j];
		if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) win = !win;
	}
	return win;
}

//A room's glow centre is its area centroid where that falls inside the room
//(concave rooms can push it into a wall), otherwise the text anchor, which is
//inside by construction. The radius follows the room's size -- a fixed radius
//gave a bathroom the same blob as the living room.
function roomGeometry(zone) {
	const room = geo.rooms[zone];
	if (!room) return null;
	const c = polyCentroid(room.points);
	//polyCentroid returns number[]; inside() wants a [x, y] pair.
	const centre = c && inside(room.points, /** @type {[number, number]} */ (c)) ? c : room.anchor;
	const size = Math.sqrt(polyArea(room.points));          //source units
	return { centre, size };
}

function placement(zone, device, index, total) {
	lights[zone] ??= {};
	if (lights[zone][device]) return lights[zone][device];
	const g = roomGeometry(zone);
	if (!g) return null;
	//Spread several lights around the centre rather than stacking them
	const spread = total > 1 ? Math.min(g.size * 0.28, 9) : 0;
	const ang = (index / Math.max(total, 1)) * Math.PI * 2 - Math.PI / 2;
	const p = {
		cx: +(g.centre[0] + Math.cos(ang) * spread).toFixed(2),
		cy: +(g.centre[1] + Math.sin(ang) * spread).toFixed(2),
		r: Math.round(Math.max(16, Math.min(60, g.size * S * 0.38))),
		auto: true,
	};
	lights[zone][device] = p;
	seeded++;
	return p;
}

//Tap radius per lamp: half the distance to its nearest neighbour, so two hit
//areas can never overlap and steal each other's clicks, clamped to something
//usable on a phone. A fixed radius broke as soon as two lamps sat close (the
//vardagsrum shelf LED is 18 units below v1).
//One device can be several physical lamps -- vardagsrum_vaggar is a pair
//flanking the dining table, vardagsrum_soffa a pair along the far wall. Such an
//entry carries `points: [[x,y], ...]` instead of a single cx/cy, and emits one
//glow+symbol+hit per point inside ONE <g class="item">, so all of them toggle
//together as the single device they are.
//A lamp entry may instead name one of the runs outlined on the drawing's "Rum"
//layer -- Koksbank, Kokshylla, Bank -- and say how many lamps sit along it.
//Spacing then follows the drawing rather than numbers typed in by hand, and it
//tracks automatically when the run is redrawn.
function runPositions(name, count) {
	const rect = geo.runs?.[name];
	if (!rect) {
		note(`lights.json names run "${name}", which is not on the drawing's Rum layer`);
		return null;
	}
	const xs = rect.map(q => q[0]), ys = rect.map(q => q[1]);
	const x0 = Math.min(...xs), x1 = Math.max(...xs);
	const y0 = Math.min(...ys), y1 = Math.max(...ys);
	const vertical = (y1 - y0) >= (x1 - x0);
	const a = vertical ? y0 : x0;
	const len = vertical ? y1 - y0 : x1 - x0;
	const across = vertical ? (x0 + x1) / 2 : (y0 + y1) / 2;
	//Half a step in from each end, so the lamps sit within the run rather than
	//on its corners.
	const step = len / count;
	return Array.from({ length: count }, (_, i) => {
		const along = a + step * (i + 0.5);
		return vertical ? { cx: across, cy: along } : { cx: along, cy: across };
	});
}

function positionsOf(p) {
	if (p.run) return runPositions(p.run, p.count ?? 1) ?? [];
	return Array.isArray(p.points) ? p.points.map(([cx, cy]) => ({ cx, cy })) : [{ cx: p.cx, cy: p.cy }];
}

//A light gets its own symbol when it carries a mood/night tier, OR when it has
//been given a position in lights.json by hand. The tier says "this lamp is part
//of the room's mood/night scene"; a hand-placed entry says "this lamp is a thing
//you can see and tap". A wardrobe light wants the second without the first --
//it should glow when it is on, but it has no business coming on with a mood
//scene. Note the check reads lights.json directly rather than calling
//placement(), which would auto-seed an entry and make every plain light an item.
function isItem(zone, l) {
	return Boolean(l.tier || lights[zone]?.[l.device]);
}

//Every emitted lamp point, filled in before anything is written so hit radii
//can be computed against the full set.
const allPoints = [];
for (const [zone, room] of Object.entries(geo.rooms)) {
	if (!config.zones[zone]) continue;
	const shown = zones[zone].lights.filter(l => isItem(zone, l));
	shown.forEach((l, i) => {
		const p = placement(zone, l.device, i, shown.length);
		//A `tap: false` lamp emits no hit disc, so it is not competing for the
		//click and must not shrink anyone else's radius.
		if (p && p.tap !== false) for (const q of positionsOf(p)) allPoints.push({ device: l.device, ...q });
	});
}

//Half the distance to the nearest point of a DIFFERENT device, so hit areas
//never steal each other's clicks. Two points of the same device may overlap --
//they toggle the same thing.
function hitRadius(device, here) {
	let nearest = Infinity;
	for (const q of allPoints) {
		if (q.device === device) continue;
		const dist = Math.hypot((q.cx - here.cx) * S, (q.cy - here.cy) * S);
		if (dist < nearest) nearest = dist;
	}
	return Math.round(Math.max(7, Math.min(14, nearest / 2 - 1)));
}

//---------------------------------------------------------------- emit
const out = [];
const defs = [];

//Glow gradients. --sc is supplied by style.css (`stop { --sc: #ffcc00 }`).
defs.push(`      <radialGradient id="pf"><stop offset="0%" stop-color="var(--sc)" stop-opacity="1" /><stop offset="100%" stop-color="var(--sc)" stop-opacity="0" /></radialGradient>`);
defs.push(`      <radialGradient id="p-vagg" cx="0" cy="0.5"><stop offset="0%" stop-color="var(--sc)" stop-opacity="1" /><stop offset="100%" stop-color="var(--sc)" stop-opacity="0" /></radialGradient>`);

//Apartment envelope: the soft border, and the clip for the base artwork
defs.push(`      <polygon id="rooms-outline" points="${poly(geo.silhouette)}" />`);
//#rooms-outline is now only the soft border drawn by #border-fade

//One clip per room so a glow cannot bleed through a wall.
//The outline polygon lives HERE, in defs, not inside the room group: a group
//clipped by a path that <use>s an element inside itself is a circular
//reference, and the clip is then ignored (glows bleed across walls).
for (const [zone, room] of Object.entries(geo.rooms)) {
	if (!config.zones[zone]) continue;
	defs.push(`      <polygon id="${zone}-outline" points="${poly(shapeOf(zone))}" />`);
	defs.push(`      <clipPath id="${zone}-clip"><use xlink:href="#${zone}-outline" /></clipPath>`);
}

//A lamp marked `under` sits beneath a piece of furniture drawn on the Rum
//layer, so its light spills out AROUND that furniture rather than through it.
//The clip is the room with the furniture punched out: two subpaths and
//clip-rule="evenodd".
const ring = pts => 'M ' + pts.map(([x, y]) => `${tx(x)},${ty(y)}`).join(' L ') + ' Z';
for (const [zone, devs] of Object.entries(lights)) {
	if (!config.zones[zone] || !geo.rooms[zone]) continue;
	for (const [device, p] of Object.entries(devs)) {
		if (!p.under || !p.run || !geo.runs?.[p.run]) continue;
		//clip-rule belongs on the path, not the clipPath: it is a property of the
		//shape being used as the clip, and renderers do not all inherit it.
		defs.push(`      <clipPath id="${device}-spill">`
			+ `<path clip-rule="evenodd" d="${ring(shapeOf(zone))} ${ring(geo.runs[p.run])}" /></clipPath>`);
	}
}


out.push(`      <svg id="image-mapper-svg" viewBox="0 0 ${VB[2]} ${VB[3]}">`);
out.push(`        <defs>`);
out.push(...defs);
out.push(`        </defs>`);

//The architectural drawing is emitted AFTER the rooms (see below) so walls and
//fixtures stay crisp on top of the room tint, and a glow reads as light shining
//under the drawing. pointer-events:none keeps it out of the way of clicks.
const baseSvg = readFileSync(P.base, 'utf8');
//Everything inside the root <svg>, not from the first <g>: the drawing's
//<defs> precedes it, and slicing from <g> dropped a real clipPath, leaving a
//dangling clip-path reference (which a browser may treat as "do not render").
let inner = baseSvg.slice(baseSvg.search(/<svg\b[^>]*>/) + baseSvg.match(/<svg\b[^>]*>/)[0].length,
	baseSvg.lastIndexOf('</svg>')).trim();

//Inkscape writes presentation properties into style="" attributes. The CSP sets
//style-src 'self' with no 'unsafe-inline', and style-src governs style
//attributes too -- a browser refuses them, and these paths carry no fill
//fallback, so the grey wall poche would render black. Rewriting them as
//presentation attributes keeps the CSP strict and needs no exception.
const PRESENTATION = new Set(['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width',
	'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray',
	'stroke-dashoffset', 'stroke-miterlimit', 'opacity', 'display', 'paint-order', 'color',
	'stop-color', 'stop-opacity', 'vector-effect']);
let inlined = 0, dropped = 0;
//Per element, not a global regex: a style declaration overrides a presentation
//attribute of the same name, so an existing one must be REPLACED, not appended
//(appending yields "Attribute fill redefined" and the document fails to parse).
inner = inner.replace(/<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g, (tag, name, attrs, selfClose) => {
	const m = attrs.match(/\sstyle="([^"]*)"/);
	if (!m) return tag;
	inlined++;
	let rest = attrs.replace(/\sstyle="[^"]*"/, '');
	for (const d of m[1].split(';')) {
		const i = d.indexOf(':');
		if (i < 0) continue;
		const prop = d.slice(0, i).trim(), val = d.slice(i + 1).trim();
		if (!PRESENTATION.has(prop)) { dropped++; continue; }
		const re = new RegExp(`\\s${prop.replace(/[-]/g, '\\-')}="[^"]*"`, 'g');
		rest = rest.replace(re, '');
		rest += ` ${prop}="${val}"`;
	}
	return `<${name}${rest}${selfClose}>`;
});
const basePlan = [
	//NOT clipped. Clipping the drawing to #rooms-outline cut the outer walls off
	//wherever the traced silhouette ran along their inner face -- most visibly
	//the whole angled facade, which left rooms looking like they spilled into
	//empty space. The drawing is the drawing; nothing should trim it.
	`        <g id="base-plan" transform="scale(${S}) translate(${-ox},${-oy})" pointer-events="none">`,
	inner,
	`        </g>`,
];

//------------------------------------------------------------- rooms
//Only the tint. The lamps are emitted further down, ABOVE the drawing --
//otherwise the base plan paints over them and a bathroom's ceiling lights
//disappear behind the bathtub and toilet outlines.
for (const zone of Object.keys(geo.rooms)) {
	if (!config.zones[zone]) continue;
	out.push(`        <g class="room" id="${zone}" clip-path="url(#${zone}-clip)">`);
	//fill/fill-opacity are inherited properties, so styling the <use> reaches
	//the referenced polygon -- same trick the apartment border already used.
	out.push(`          <use class="room-outline" xlink:href="#${zone}-outline" />`);
	out.push(`        </g>`);
}

//The lamps, still clipped per room so a glow cannot bleed through a wall.
const lightLayer = [`        <g id="lights">`];
for (const zone of Object.keys(geo.rooms)) {
	if (!config.zones[zone]) continue;
	//See isItem(): a plain light with no position of its own is toggled with the
	//room and needs no symbol.
	const shown = zones[zone].lights.filter(l => isItem(zone, l));
	if (!shown.length) continue;
	//The zone's lamps carry the room's own `light` state, mirrored onto this group
	//by updateArea(). They are not descendants of the <g class="room">, so CSS
	//cannot reach them from the room -- this group is what gives style.css a
	//handle on "every lamp in a room that is fully on".
	//⚠ TWO groups per zone, glows first, symbols second. SVG has no z-index --
	//paint order is document order -- so while each lamp emitted its own glow
	//immediately followed by its own symbol, a later lamp's glow (r up to 60)
	//painted straight over an earlier lamp's symbol (r 6) and the dot vanished
	//under its neighbour. Every glow in the room is laid down before any symbol
	//is, so no symbol can be covered by a glow. Cross-room bleed cannot happen:
	//both groups are clipped to the room.
	//Both carry `class="zone-lights"` and both are given the room's `light` by
	//updateArea(); both item wrappers are given `state` by updateItem(). The CSS
	//is written as descendant selectors from those attributes, so it does not
	//care which of the two layers an element ended up in.
	const placed = shown.map((l, i) => ({ l, p: placement(zone, l.device, i, shown.length) })).filter(x => x.p);

	lightLayer.push(`          <g id="glows-${zone}" class="zone-lights" clip-path="url(#${zone}-clip)">`);
	//Furniture stays with the glows and ahead of them: it is what a glow spills
	//out from under, so it has to be painted below the glow, not above it.
	for (const l of shown) {
		const p = lights[zone]?.[l.device];
		if (p?.under && p.run && geo.runs?.[p.run]) {
			lightLayer.push(`            <polygon class="furniture" points="${poly(geo.runs[p.run])}" pointer-events="none" />`);
		}
	}
	for (const { l, p } of placed) {
		lightLayer.push(`            <g class="item-glow" id="glow-${l.device}">`);
		for (const q of positionsOf(p)) {
			const spill = p.under && p.run && geo.runs?.[p.run] ? ` clip-path="url(#${l.device}-spill)"` : '';
			lightLayer.push(`              <circle class="${['glow', l.tier].filter(Boolean).join(' ')}" cx="${tx(q.cx)}" cy="${ty(q.cy)}" r="${p.r}" fill="url(#pf)"${spill} pointer-events="none" />`);
		}
		lightLayer.push(`            </g>`);
	}
	lightLayer.push(`          </g>`);

	lightLayer.push(`          <g id="lights-${zone}" class="zone-lights" clip-path="url(#${zone}-clip)">`);
	for (const { l, p } of placed) {
		//`symbol: false` AND `tap: false` together leave nothing for this layer to
		//hold -- the lamp is glow-only. Skip the wrapper rather than emit an empty
		//one: the glow group carries `state` for it, and every lookup of the
		//symbol group is optional-chained.
		if (p.symbol === false && p.tap === false) continue;
		//The click target is the small symbol, NOT the glow. While one circle did
		//both, a lamp's hit area was its whole radial gradient (r up to 60), so
		//clicking anywhere in vardagsrum hit whichever lamp happened to be on
		//top, and the room itself was almost unclickable.
		lightLayer.push(`            <g class="item" id="${l.device}">`);
		for (const q of positionsOf(p)) {
			//A run of strip lighting reads better as its glow alone; a row of
			//rings along a counter just looks like a row of holes. `symbol: false`
			//in lights.json drops the ring but keeps the glow and the tap area.
			if (p.symbol !== false) {
				lightLayer.push(`              <circle class="point" cx="${tx(q.cx)}" cy="${ty(q.cy)}" r="6" pointer-events="none" />`);
			}
			//A bigger invisible disc so the symbol is tappable on a phone:
			//r=6 user units is only about 13 px across there.
			//`tap: false` drops it, which makes the lamp display-only: it still
			//glows to show its state, but the press falls through to the room
			//behind it. Small rooms whose every lamp is switched together want
			//this -- a per-lamp target there is just a way to miss the room.
			if (p.tap !== false) {
				lightLayer.push(`              <circle class="hit" cx="${tx(q.cx)}" cy="${ty(q.cy)}" r="${hitRadius(l.device, q)}" fill="none" pointer-events="all" />`);
			}
		}
		lightLayer.push(`            </g>`);
	}
	lightLayer.push(`          </g>`);
}
lightLayer.push(`        </g>`);

//Readouts live OUTSIDE the room groups. Inside, the room's clip-path cut off
//any label that reached past a wall, which is most of them in a small room.
//pointer-events:none -- this layer sits above the rooms, so without it a
//readout swallows clicks meant for the room underneath whenever temps are shown.
//Inside the room groups (where these used to live) clicking a label toggled the
//room, and that behaviour is restored by letting clicks pass straight through.
const readoutLayer = [`        <g id="readouts" pointer-events="none">`];
for (const [zone, room] of Object.entries(geo.rooms)) {
	if (!config.zones[zone]) continue;
	const readouts = zones[zone].sensors.filter(s => /(temperature|humidity)$/.test(s.device));
	readouts.forEach((s, i) => {
		const nudge = readoutNudge[zone] ?? {};
		const x = tx(room.anchor[0] + (nudge.dx ?? 0));
		const y = ty(room.anchor[1] + (nudge.dy ?? 0)) + i * 15;
		readoutLayer.push(`          <text class="temp hidden" id="th-${s.device}" x="${x}" y="${y}" />`);
	});
}
//Zones with sensors but NO room drawn (utomhus -- the outdoor weather station).
//Their readout has no anchor, so readouts.json gives an absolute drawing
//position (`x`/`y`) instead of an anchor nudge.
for (const [zone, pos] of Object.entries(readoutNudge)) {
	if (geo.rooms[zone] || pos.x === undefined || pos.y === undefined) continue;
	if (!config.zones[zone]) continue;
	const readouts = zones[zone].sensors.filter(s => /(temperature|humidity)$/.test(s.device));
	readouts.forEach((s, i) => {
		readoutLayer.push(`          <text class="temp hidden" id="th-${s.device}" x="${tx(pos.x)}" y="${ty(pos.y) + i * 15}" />`);
	});
}
readoutLayer.push(`        </g>`);

out.push(...basePlan);
out.push(...lightLayer);
out.push(`        <g id="border-fade" pointer-events="none"><use xlink:href="#rooms-outline" /></g>`);
out.push(...readoutLayer);

//------------------------------------------------------- appliance markers
// home.js maps a power sensor to a rect by name.split('_')[0]
const fixtureFor = {
	K: 'kylskap', F: 'frys', DM: 'diskmaskin', TM: 'tvattmaskin', TT: 'torktumlare', V: 'vinkyl',
};
//Explicit marker box per appliance, in VIEWBOX units [x, y, w, h]. The text
//label (K/F/DM/...) only says WHERE the appliance is roughly drawn; it is not
//centred on the appliance, so each box is hand-tuned to sit on the appliance
//itself rather than derived from the label. Hand-edited like lights.json.
const applianceBox = {
	kylskap: [219, 519, 18, 18],
	frys: [322, 431, 18, 18],
	vinkyl: [156, 595, 10, 18],
	diskmaskin: [219, 455, 18, 18],
	tvattmaskin: [194, 432, 18, 18],
	torktumlare: [194, 450, 18, 18],
};
const wanted = new Set((config.zones.devices ?? []).map(e => e.split('_')[0]));
const used = new Set();
out.push(`        <g id="appliances">`);
for (const f of geo.fixtures) {
	const id = fixtureFor[f.text];
	if (!id || !wanted.has(id) || used.has(id)) continue;
	used.add(id);
	const [x, y, w, h] = applianceBox[id] ?? [tx(f.x) - 8, ty(f.y) - 8, 16, 16];
	out.push(`          <rect class="device hidden" id="${id}" x="${x}" y="${y}" width="${w}" height="${h}" />`);
}
out.push(`        </g>`);
for (const id of wanted) {
	if (!used.has(id)) note(`power sensor "${id}_*" has no marker in the plan -- it will never be drawn`);
}

//------------------------------------------------------------- footer line
if (config.zones.home?.some(e => e.startsWith('sensorer_alla'))) {
	out.push(`        <g transform="translate(5, ${VB[3] - 20})">`);
	out.push(`          <text class="temp hidden" id="info-senaste_aktivitet" default="Senaste aktivitet: " x="0" y="0" />`);
	out.push(`        </g>`);
}

out.push(`      </svg>`);

//---------------------------------------------------------------- write
const svg = out.join('\n');
const html = readFileSync(P.template, 'utf8').replace('<!--FLOORPLAN-->', svg);

const check = process.argv.includes('--check');
const current = existsSync(P.out) ? readFileSync(P.out, 'utf8') : '';

if (check) {
	if (current !== html) {
		console.error('dashboard.html is STALE -- run: node tools/floorplan/generate.mjs');
		process.exit(1);
	}
	console.log('dashboard.html is up to date');
} else {
	writeFileSync(P.out, html);
	if (seeded) writeFileSync(P.lights, JSON.stringify(lights, null, 1));
	const rooms = Object.keys(geo.rooms).filter(z => config.zones[z]).length;
	const items = Object.entries(zones).reduce((a, [z, zn]) => a + zn.lights.filter(l => isItem(z, l)).length, 0);
	console.log(`wrote web/dashboard.html  viewBox 0 0 ${VB[2]} ${VB[3]}`);
	console.log(`  ${rooms} rooms, ${items} clickable lights, ${used.size} appliance markers`);
	console.log(`  rewrote ${inlined} style="" attribute(s) as presentation attributes (CSP: no 'unsafe-inline')${dropped ? `, dropped ${dropped} non-presentation decl(s)` : ''}`);
	if (seeded) console.log(`  seeded ${seeded} glow position(s) into lights.json -- edit that file to place them properly`);
}

if (warn.length) {
	console.log('\nwarnings:');
	for (const w of warn) console.log('  ! ' + w);
}
