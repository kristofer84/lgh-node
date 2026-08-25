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
	template: join(here, 'dashboard.template.html'),
	config: join(repo, 'db', 'config.json'),
	out: join(repo, 'web', 'dashboard.html'),
};

const geo = JSON.parse(readFileSync(P.geometry, 'utf8'));
const config = JSON.parse(readFileSync(P.config, 'utf8'));
const lights = existsSync(P.lights) ? JSON.parse(readFileSync(P.lights, 'utf8')) : {};

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
function placement(zone, device, index, total) {
	lights[zone] ??= {};
	if (lights[zone][device]) return lights[zone][device];
	const a = geo.rooms[zone]?.anchor;
	if (!a) return null;
	const R = total > 1 ? 6 : 0;                       //source units
	const ang = (index / Math.max(total, 1)) * Math.PI * 2 - Math.PI / 2;
	const p = {
		cx: +(a[0] + Math.cos(ang) * R).toFixed(2),
		cy: +(a[1] + Math.sin(ang) * R).toFixed(2),
		r: 34,                                          //dashboard units
		auto: true,
	};
	lights[zone][device] = p;
	seeded++;
	return p;
}

//---------------------------------------------------------------- emit
const out = [];
const defs = [];

//Glow gradients. --sc is supplied by style.css (`stop { --sc: #ffcc00 }`).
defs.push(`      <radialGradient id="pf"><stop offset="0%" stop-color="var(--sc)" stop-opacity="1" /><stop offset="100%" stop-color="var(--sc)" stop-opacity="0" /></radialGradient>`);
defs.push(`      <radialGradient id="p-vagg" cx="0" cy="0.5"><stop offset="0%" stop-color="var(--sc)" stop-opacity="1" /><stop offset="100%" stop-color="var(--sc)" stop-opacity="0" /></radialGradient>`);

//Apartment envelope: the soft border, and the clip for the base artwork
defs.push(`      <polygon id="rooms-outline" points="${poly(geo.silhouette)}" />`);
defs.push(`      <clipPath id="clip"><use xlink:href="#rooms-outline" /></clipPath>`);

//One clip per room so a glow cannot bleed through a wall.
//The outline polygon lives HERE, in defs, not inside the room group: a group
//clipped by a path that <use>s an element inside itself is a circular
//reference, and the clip is then ignored (glows bleed across walls).
for (const [zone, room] of Object.entries(geo.rooms)) {
	if (!config.zones[zone]) continue;
	defs.push(`      <polygon id="${zone}-outline" points="${poly(room.points)}" />`);
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
let inner = baseSvg.slice(baseSvg.indexOf('<g'), baseSvg.lastIndexOf('</svg>')).trim();

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
	`        <g id="base-plan" transform="scale(${S}) translate(${-ox},${-oy})" clip-path="url(#clip)" pointer-events="none">`,
	inner,
	`        </g>`,
];

//------------------------------------------------------------- rooms
for (const [zone, room] of Object.entries(geo.rooms)) {
	if (!config.zones[zone]) continue;
	const z = zones[zone];
	out.push(`        <g class="room" id="${zone}" clip-path="url(#${zone}-clip)">`);
	//fill/fill-opacity are inherited properties, so styling the <use> reaches
	//the referenced polygon -- same trick the apartment border already used.
	out.push(`          <use class="room-outline" xlink:href="#${zone}-outline" />`);

	//Glows. Only lights carrying a mood/night tier get an individual .item
	//circle; a plain light is toggled with the room and needs no glow of its own.
	const tiered = z.lights.filter(l => l.tier);
	tiered.forEach((l, i) => {
		const p = placement(zone, l.device, i, tiered.length);
		if (!p) return;
		out.push(`          <circle id="${l.device}" class="${l.tier} item" cx="${tx(p.cx)}" cy="${ty(p.cy)}" r="${p.r}" fill="url(#pf)" />`);
	});

	//Temperature / humidity readouts, stacked at the room's text anchor
	const readouts = z.sensors.filter(s => /(temperature|humidity)$/.test(s.device));
	readouts.forEach((s, i) => {
		out.push(`          <rect class="name-blocker hidden" x="${tx(room.anchor[0]) - 4}" y="${ty(room.anchor[1]) + i * 16 - 12}" width="46" height="15" />`);
		out.push(`          <text class="temp hidden" id="th-${s.device}" x="${tx(room.anchor[0])}" y="${ty(room.anchor[1]) + i * 16}" />`);
	});

	out.push(`        </g>`);
}

out.push(...basePlan);
out.push(`        <g id="border-fade" pointer-events="none"><use xlink:href="#rooms-outline" /></g>`);

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
