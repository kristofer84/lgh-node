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
// "<device>.<domain>[.mood|.night]"
function parseEntry(entry) {
	const p = entry.split('.');
	return { device: p[0], type: p[1], tier: p[2] };
}

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
	const centre = c && inside(room.points, c) ? c : room.anchor;
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

//Every emitted lamp point, filled in before anything is written so hit radii
//can be computed against the full set.
const allPoints = [];
for (const [zone, room] of Object.entries(geo.rooms)) {
	if (!config.zones[zone]) continue;
	const tiered = zones[zone].lights.filter(l => l.tier);
	tiered.forEach((l, i) => {
		const p = placement(zone, l.device, i, tiered.length);
		if (p) for (const q of positionsOf(p)) allPoints.push({ device: l.device, ...q });
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
	//Only lights carrying a mood/night tier get their own symbol; a plain light
	//is toggled with the room and needs no glow of its own.
	const tiered = zones[zone].lights.filter(l => l.tier);
	if (!tiered.length) continue;
	lightLayer.push(`          <g clip-path="url(#${zone}-clip)">`);
	tiered.forEach((l, i) => {
		const p = placement(zone, l.device, i, tiered.length);
		if (!p) return;
		//The click target is the small symbol, NOT the glow. While one circle did
		//both, a lamp's hit area was its whole radial gradient (r up to 60), so
		//clicking anywhere in vardagsrum hit whichever lamp happened to be on
		//top, and the room itself was almost unclickable.
		lightLayer.push(`            <g class="item" id="${l.device}">`);
		for (const q of positionsOf(p)) {
			lightLayer.push(`              <circle class="glow ${l.tier}" cx="${tx(q.cx)}" cy="${ty(q.cy)}" r="${p.r}" fill="url(#pf)" pointer-events="none" />`);
			lightLayer.push(`              <circle class="point" cx="${tx(q.cx)}" cy="${ty(q.cy)}" r="6" pointer-events="none" />`);
			//A bigger invisible disc so the symbol is tappable on a phone:
			//r=6 user units is only about 13 px across there.
			lightLayer.push(`              <circle class="hit" cx="${tx(q.cx)}" cy="${ty(q.cy)}" r="${hitRadius(l.device, q)}" fill="none" pointer-events="all" />`);
		}
		lightLayer.push(`            </g>`);
	});
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
readoutLayer.push(`        </g>`);

out.push(...basePlan);
out.push(...lightLayer);
out.push(`        <g id="border-fade" pointer-events="none"><use xlink:href="#rooms-outline" /></g>`);
out.push(...readoutLayer);

//------------------------------------------------------- appliance markers
// home.js maps a power sensor to a rect by name.split('_')[0]
const fixtureFor = {
	K: 'kylskap', F: 'frys', DM: 'diskmaskin', TM: 'tvattmaskin', TT: 'torktumlare',
};
const wanted = new Set((config.zones.devices ?? []).map(e => e.split('_')[0]));
const used = new Set();
out.push(`        <g id="appliances">`);
for (const f of geo.fixtures) {
	const id = fixtureFor[f.text];
	if (!id || !wanted.has(id) || used.has(id)) continue;
	used.add(id);
	out.push(`          <rect class="device hidden" id="${id}" x="${tx(f.x) - 11}" y="${ty(f.y) - 14}" width="22" height="22" />`);
}
out.push(`        </g>`);
for (const id of wanted) {
	if (!used.has(id)) note(`power sensor "${id}_*" has no marker in the plan -- it will never be drawn`);
}

//------------------------------------------------------------- footer line
if (config.zones.home?.some(e => e.startsWith('sensorer_alla'))) {
	out.push(`        <g transform="translate(12, ${VB[3] - 10})">`);
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
	const items = Object.values(zones).reduce((a, z) => a + z.lights.filter(l => l.tier).length, 0);
	console.log(`wrote web/dashboard.html  viewBox 0 0 ${VB[2]} ${VB[3]}`);
	console.log(`  ${rooms} rooms, ${items} clickable lights, ${used.size} appliance markers`);
	console.log(`  rewrote ${inlined} style="" attribute(s) as presentation attributes (CSP: no 'unsafe-inline')${dropped ? `, dropped ${dropped} non-presentation decl(s)` : ''}`);
	if (seeded) console.log(`  seeded ${seeded} glow position(s) into lights.json -- edit that file to place them properly`);
}

if (warn.length) {
	console.log('\nwarnings:');
	for (const w of warn) console.log('  ! ' + w);
}
