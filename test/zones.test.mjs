//The shared grammar and step semantics. Pure functions, no stubs needed --
//this is the payoff for pulling them out of mqtt-web.js and home.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers.mjs';
import { parseEntry, sceneFor, stepOf, nextStep, stepsAvailable, sceneStates, overlappingDevices, leafSet, nestGroupRows, groupParent } from '../web/scripts/zones.js';

/** @typedef {import('../web/scripts/zones.js').Steps} Steps */
/** @typedef {import('../web/scripts/zones.js').ZoneModel} ZoneModel */
/** Literal `true` widens to `boolean` in a plain object literal, which is not a Steps. */
const steps = (/** @type {Steps} */ s) => s;
/** @param {ZoneModel} m */
const model = m => m;

test('parseEntry: the legacy string form maps a tier onto the steps it implied', () => {
	assert.deepEqual(parseEntry('sovrum_1_tak.light'), {
		entry: 'sovrum_1_tak.light', device: 'sovrum_1_tak', type: 'light',
		tier: undefined, level: undefined,
		steps: { natt: false, kvall: false, dag: false, stad: true }, entity: 'light.sovrum_1_tak',
	});
	//⚠ night implied mood, and `stad` lit everything regardless of tier. The
	//unlit steps are now explicit `false` (off), not absent -- absent means ignore.
	assert.deepEqual(parseEntry('slinga.light.night').steps, { natt: true, kvall: true, dag: false, stad: true });
	assert.deepEqual(parseEntry('lampa.light.mood').steps, { natt: false, kvall: true, dag: false, stad: true });
	assert.deepEqual(parseEntry('tak.light.mood.20').steps, { natt: false, kvall: 20, dag: false, stad: 100 });
	//A sensor has no steps at all and is never published to.
	assert.deepEqual(parseEntry('hall_temperature.sensor').steps, {});
	assert.equal(parseEntry('sang_hoger.switch.mood').tier, 'mood');
	assert.equal(parseEntry('slinga_mette.light.night').tier, 'night');
	assert.equal(parseEntry('badrum_1_tak.light.mood.20').level, 20);
	//A tier with no level is a plain on/off, not level 0.
	assert.equal(parseEntry('lampa_kai.light.mood').level, undefined);
});

test('parseEntry: the object form is taken as written', () => {
	const e = parseEntry({ device: 'badrum_1_tak', type: 'light', steps: { kvall: 20, stad: 100 } });
	assert.equal(e.device, 'badrum_1_tak');
	assert.equal(e.entity, 'light.badrum_1_tak');
	assert.deepEqual(e.steps, { kvall: 20, stad: 100 });
});

test('parseEntry: the object form carries a {level, kelvin} step through untouched', () => {
	const e = parseEntry({ device: 'golvlampa', type: 'light', steps: { kvall: { level: 20, kelvin: 2700 }, stad: 100 } });
	assert.equal(e.device, 'golvlampa');
	assert.deepEqual(e.steps, { kvall: { level: 20, kelvin: 2700 }, stad: 100 });
});

test('the explicit form expresses what a tier could not', () => {
	//Neither of these was reachable before: a tier made `natt` imply `kvall`, and
	//`stad` always lit everything. Now a step absent = ignore, so a device lit
	//only at `natt` is left alone at `kvall`/`stad` and, symmetrically, turned
	//off explicitly only where `false` is written.
	const nattOnly = [{ device: 'a', type: 'light', steps: { natt: true } }];
	assert.deepEqual(sceneFor(nattOnly, 'natt'), [{ entity: 'light.a', state: 'on' }]);
	assert.deepEqual(sceneFor(nattOnly, 'kvall'), []);     // absent -> ignore
	assert.deepEqual(sceneFor(nattOnly, 'stad'), []);      // absent -> ignore

	const notInStad = [{ device: 'b', type: 'light', steps: { kvall: 30 } }];
	assert.deepEqual(sceneFor(notInStad, 'kvall'), [{ entity: 'light.b', level: 30 }]);
	assert.deepEqual(sceneFor(notInStad, 'stad'), []);     // absent -> ignore

	//...and an explicit `false` really does turn it off.
	const offAtKvall = [{ device: 'c', type: 'light', steps: { kvall: false } }];
	assert.deepEqual(sceneFor(offAtKvall, 'kvall'), [{ entity: 'light.c', state: 'off' }]);
	assert.deepEqual(sceneFor(offAtKvall, 'stad'), []);
});

test('sceneFor: kvall lights anything tiered, stad lights everything', () => {
	const zone = ['tak.light', 'lampa.light.mood', 'slinga.light.night'];
	assert.deepEqual(sceneFor(zone, 'off'), [
		{ entity: 'light.tak', state: 'off' },
		{ entity: 'light.lampa', state: 'off' },
		{ entity: 'light.slinga', state: 'off' },
	]);
	//natt counts as kvall -- the original reads "Night && mood"
	assert.deepEqual(sceneFor(zone, 'kvall'), [
		{ entity: 'light.tak', state: 'off' },
		{ entity: 'light.lampa', state: 'on' },
		{ entity: 'light.slinga', state: 'on' },
	]);
	assert.deepEqual(sceneFor(zone, 'natt'), [
		{ entity: 'light.tak', state: 'off' },
		{ entity: 'light.lampa', state: 'off' },
		{ entity: 'light.slinga', state: 'on' },
	]);
	assert.deepEqual(sceneFor(zone, 'stad'), [
		{ entity: 'light.tak', state: 'on' },
		{ entity: 'light.lampa', state: 'on' },
		{ entity: 'light.slinga', state: 'on' },
	]);
});

test('sceneFor: a level dims at its step and goes to 100 at stad', () => {
	const zone = ['spegel.light', 'tak.light.mood.20'];
	assert.deepEqual(sceneFor(zone, 'kvall'), [
		{ entity: 'light.spegel', state: 'off' },
		{ entity: 'light.tak', level: 20 },
	]);
	//⚠ `stad` must say 100 out loud: a plain turn_on restores the level the lamp
	//last had, so after a kvall press it would come back at 20%.
	assert.deepEqual(sceneFor(zone, 'stad'), [
		{ entity: 'light.spegel', state: 'on' },
		{ entity: 'light.tak', level: 100 },
	]);
	//...but `off` is still a plain off, not a dim to zero.
	assert.deepEqual(sceneFor(zone, 'off').at(-1), { entity: 'light.tak', state: 'off' });
});

test('sceneFor: a {level, kelvin} step publishes brightness AND a kelvin', () => {
	const zone = [{ device: 'golvlampa', type: 'light', steps: { kvall: { level: 20, kelvin: 2700 }, stad: 100 } }];
	assert.deepEqual(sceneFor(zone, 'kvall'), [{ entity: 'light.golvlampa', level: 20, kelvin: 2700 }]);
	//The same lamp at `stad` (a plain number) carries no kelvin.
	assert.deepEqual(sceneFor(zone, 'stad'), [{ entity: 'light.golvlampa', level: 100 }]);
	//A malformed object step (no level) is an off, not a NaN payload.
	const broken = [{ device: 'x', type: 'light', steps: { kvall: { kelvin: 2700 } } }];
	assert.deepEqual(sceneFor(broken, 'kvall'), [{ entity: 'light.x', state: 'off' }]);
});

test('stepOf matches a {level, kelvin} step on its level, not its kelvin', () => {
	const stepsValue = steps({ kvall: { level: 20, kelvin: 2700 }, stad: 100 });
	assert.equal(stepOf(model({ gal: { onoff: true, dim: 52, steps: stepsValue } })).step, 'kvall');
	assert.equal(stepOf(model({ gal: { onoff: true, dim: 255, steps: stepsValue } })).step, 'stad');
});

test('sceneFor ignores sensors and occupancy', () => {
	const out = sceneFor(['tak.light', 'hall_temperature.sensor', 'sensorer_alla.occupancy'], 'stad');
	assert.deepEqual(out, [{ entity: 'light.tak', state: 'on' }]);
});

test('stepOf is the inverse of sceneFor for a plain zone', () => {
	//Explicit steps like the migrated config: an untiered light is OFF at the
	//moods it cannot do (`false`), not ignored, so a room can still tell `kvall`
	//(lampa on, tak off) from `stad` (both on).
	const TAK = steps({ kvall: false, stad: true }), LAMPA = steps({ kvall: true, stad: true });
	const m = (o) => model({ tak: { onoff: false, steps: TAK }, lampa: { onoff: false, steps: LAMPA }, ...o });
	assert.equal(stepOf(m()).step, 'off');
	assert.equal(stepOf(m({ lampa: { onoff: true, steps: LAMPA } })).step, 'kvall');
	assert.equal(stepOf(m({ tak: { onoff: true, steps: TAK }, lampa: { onoff: true, steps: LAMPA } })).step, 'stad');
	assert.equal(stepOf(m()).kvallable, true);
	assert.equal(stepOf(m()).nattable, false);
});

test('stepOf really is the inverse of sceneFor, for every step', () => {
	//The property that matters: whatever sceneFor(step) publishes, stepOf must
	//read back as that same step. Checked against the REAL config.
	const cfg = JSON.parse(readFileSync(join(ROOT, 'db/config.json'), 'utf8'));
	for (const [zone, entries] of Object.entries(cfg.zones)) {
		const sw = entries.map(parseEntry).filter(e => e.type === 'light' || e.type === 'switch');
		if (!sw.length) continue;
		for (const step of ['off', 'natt', 'kvall', 'dag', 'stad']) {
			const avail = stepsAvailable(entries);
			if (step === 'natt' && !avail.natt) continue;
			if (step === 'kvall' && !avail.kvall) continue;
			if (step === 'dag' && !avail.dag) continue;
			const actions = sceneFor(entries, step);
			//A scene that IGNORES a switchable device (absent at this step)
			//under-specifies the room: that device's state is arbitrary, so stepOf
			//cannot uniquely reverse it and its dimmest-first reading (a dimmer step
			//that leaves the lamp unconstrained) is as true as this one. The inverse
			//property only holds for scenes that say something about EVERY device.
			if (step !== 'off' && actions.length < sw.length) continue;
			//Likewise, two steps that publish the SAME scene (a single-lamp room at
			//100 in both `dag` and `stad`) are indistinguishable: stepOf reads the
			//dimmer one, so the brighter is not reachable as a distinct reading.
			const ORDER = ['off', 'natt', 'kvall', 'dag', 'stad'];
			const cur = JSON.stringify(actions);
			let dimmerCollides = false;
			for (const s of ORDER.slice(0, ORDER.indexOf(step))) {
				if (JSON.stringify(sceneFor(entries, s)) === cur) { dimmerCollides = true; break; }
			}
			if (dimmerCollides) continue;
			//Build the model the room would be in after pressing `step`.
			/** @type {ZoneModel} */
			const m = {};
			for (const a of actions) {
				const dev = a.entity.split('.')[1];
				const e = sw.find(x => x.device === dev);
				m[dev] = a.level !== undefined
					? { onoff: true, dim: a.level / 100 * 255, steps: e.steps }
					: { onoff: a.state === 'on', steps: e.steps };
			}
			assert.equal(stepOf(m).step, step, `${zone} after pressing ${step}`);
		}
	}
});

test('stepOf tells a dimmed lamp from a full one', () => {
	//The bug this exists for: bad3 has ONE light, so every(onoff) called it `stad`
	//whether it sat at 20% or 100%, and the room could never show its kvall step.
	const at = dim => stepOf(model({ tak: { onoff: true, steps: { kvall: 20, stad: 100 }, dim } })).step;
	assert.equal(at(52), 'kvall');    // 20% of 255
	assert.equal(at(255), 'stad');     // full
	//Brightness not reported yet: both `kvall` and `stad` prescribe "lit", so the
	//state is genuinely ambiguous. Steps are checked dimmest-first, so the
	//quieter reading wins -- the room shows a modest wash rather than claiming
	//to be fully on, and corrects itself the moment brightness arrives.
	assert.equal(at(undefined), 'kvall');
	assert.equal(stepOf(model({ tak: { onoff: false, steps: { kvall: 20, stad: 100 } } })).step, 'off');
});

test('stepOf ignores entries with no onoff (sensors)', () => {
	const s = stepOf(model({ tak: { onoff: true, steps: { stad: true } }, hall_temperature: { state: '21.5' } }));
	assert.deepEqual(s.lights, ['tak']);
	assert.equal(s.step, 'stad');
});

test('a step is offered unless every lamp is unset (ignore) at it', () => {
	//`false` (off) is still a value: "turn everything off" is a real scene, so it
	//keeps the step selectable. Only the ABSENCE (`-`/ignore) leaves a lamp out, so
	//a step disappears only when no lamp says anything about it.
	const off = steps({ natt: false, kvall: false, dag: false, stad: false });
	const unset = steps({});
	//All lamps `false`: every step is still selectable (all-off is meaningful).
	assert.equal(stepOf(model({ a: { onoff: false, steps: off }, b: { onoff: false, steps: off } })).nattable, true);
	assert.equal(stepOf(model({ a: { onoff: false, steps: off } })).stadable, true);
	//Every lamp ignore (`{}`): nothing is said, so the step disappears.
	const empty = stepOf(model({ a: { onoff: false, steps: unset }, b: { onoff: false, steps: unset } }));
	assert.equal(empty.nattable, false);
	assert.equal(empty.kvallable, false);
	assert.equal(empty.dagable, false);
	assert.equal(empty.stadable, false);
	//One lamp `false` at natt, the rest unset: natt is still offered (it means
	//"turn that one lamp off"), but dag is not (no lamp says anything at dag).
	const mixed = stepOf(model({ a: { onoff: false, steps: steps({ natt: false }) }, b: { onoff: false, steps: unset } }));
	assert.equal(mixed.nattable, true);
	assert.equal(mixed.dagable, false);
});

test('⚠ a room with only untiered lights on reads as partial, not stad', () => {
	//The bug: this chain started at `let step = 'stad'` and FELL THROUGH to it, so
	//one wardrobe light reported the whole room on -- full amber wash, and the
	//per-lamp glows hidden by `.zone-lights[light="stad"] .glow`, so the lamp you
	//had just switched on became invisible. Adding a kvall lamp then moved the
	//room backwards from `stad` to `kvall`. Reachable only once untiered lights got
	//their own tap targets.
	//(An untiered light is OFF -- not ignored -- at the moods it cannot do, so a
	//kvall lamp plus a lit untiered light still reads `partial`, not `kvall`.)
	const TAK = steps({ natt: false, kvall: false, dag: false, stad: true });
	const MIKKEL = steps({ natt: false, kvall: true, dag: false, stad: true });
	const GARDEROB = steps({ natt: false, kvall: false, dag: false, stad: true });
	const sov2 = on => model({
		sovrum_2_tak: { onoff: on.includes('tak'), steps: TAK },
		lampa_mikkel: { onoff: on.includes('lampa'), steps: MIKKEL },
		mikkel_garderob: { onoff: on.includes('garderob'), steps: GARDEROB },
	});
	assert.equal(stepOf(sov2([])).step, 'off');
	assert.equal(stepOf(sov2(['garderob'])).step, 'partial');
	assert.equal(stepOf(sov2(['lampa'])).step, 'kvall');
	assert.equal(stepOf(sov2(['garderob', 'lampa', 'tak'])).step, 'stad');
	//⚠ Since stepOf became an exact inverse of sceneFor, the kvall scene plus an
	//extra lamp is NOT the kvall scene -- the wardrobe light is on where kvall says
	//off. That reads as `partial`, and it is the honest answer: pressing `kvall`
	//again would switch the wardrobe light back off.
	assert.equal(stepOf(sov2(['garderob', 'lampa'])).step, 'partial');
	//Same shape in a bathroom: mirror untiered, ceiling kvall.
	assert.equal(stepOf(model({
		badrum_1_spegel: { onoff: true, steps: steps({ natt: false, kvall: false, dag: false, stad: true }) },
		badrum_1_tak: { onoff: false, steps: steps({ natt: false, kvall: 20, dag: false, stad: 100 }) },
	})).step, 'partial');
	//`stad` still means every light, and nothing produces `partial` as a command.
	assert.ok(!sceneFor(['a.light', 'b.light.mood'], 'partial').some(x => x.state === 'on'));
});

test('sceneStates predicts each lamp for a room press', () => {
	//The optimistic render: what each switchable device should look like once the
	//step has applied. `off` sweeps everything off; an ABSENT step leaves the
	//device as it is; `false` means off; anything else means on. Sensors are
	//skipped. This is what stops a room press blanking every lamp to off.
	const z = model({
		a: { onoff: true, steps: steps({ natt: false, kvall: 30, stad: 100 }) },
		b: { onoff: false, steps: steps({ stad: 100 }) },            // natt/kvall/dag absent
		c: { onoff: true, steps: steps({ stad: true, kvall: false }) },
		hall_temperature: { state: '21.5' },
	});
	assert.deepEqual(sceneStates(z, 'stad'), { a: 'on', b: 'on', c: 'on' });
	assert.deepEqual(sceneStates(z, 'kvall'), { a: 'on', b: 'off', c: 'off' });
	assert.deepEqual(sceneStates(z, 'natt'), { a: 'off', b: 'off', c: 'on' });
	assert.deepEqual(sceneStates(z, 'off'), { a: 'off', b: 'off', c: 'off' });
});

test('nextStep walks the cycle', () => {
	const all = { nattable: true, kvallable: true, dagable: true, stadable: true };
	assert.equal(nextStep('off', all), 'natt');
	assert.equal(nextStep('natt', all), 'kvall');
	assert.equal(nextStep('kvall', all), 'dag');
	assert.equal(nextStep('dag', all), 'stad');
	assert.equal(nextStep('stad', all), 'off');
	//A zone with no moods is a plain two-step (off <-> stad) -- but only while
	//`stad` actually turns anything on.
	assert.equal(nextStep('off', { stadable: true }), 'stad');
	assert.equal(nextStep('stad', { stadable: true }), 'off');
	//A `stad` no lamp turns on at is skipped, stepping to off instead of a dead press.
	assert.equal(nextStep('off', {}), 'off');
	assert.equal(nextStep('dag', { dagable: true }), 'off');
	assert.equal(nextStep('kvall', { kvallable: true }), 'off');
	assert.equal(nextStep('natt', { nattable: true }), 'off');
	//Skipping a mood the room cannot do.
	assert.equal(nextStep('off', { kvallable: true, dagable: true, stadable: true }), 'kvall');
	assert.equal(nextStep('natt', { nattable: true, dagable: true, stadable: true }), 'dag');
	//A partially-lit room presses to off, which is what it did while it was
	//mislabelled as `stad`.
	assert.equal(nextStep('partial', { dagable: true }), 'off');
	assert.equal(nextStep('partial', {}), 'off');
});

test('Zigbee group overlap: a device shares lamps with every group that lists it', () => {
	//The group map is fetched from zigbee2mqtt at boot; members are the physical
	//lamps each group casts one command to. Overlap (shared members) is what makes
	//two devices conflict, so the editor/save clears one when the other is set.
	const groups = {
		z_lampor_v: ['v1', 'v2'],
		z_lampor_vardagsrum: ['matbord', 'golvlampa', 'v1', 'v2', 'unused_1'],
		z_lampor_alla: ['matbord', 'golvlampa', 'v1', 'v2', 'unused_1', 'lampa_mette', 'kai_garderob', 'mikkel_garderob', 'sovrum_1_byra'],
	};
	assert.deepEqual(leafSet(groups, 'z_lampor_v'), new Set(['v1', 'v2']));
	//A group overlaps the bigger groups containing it, and a member overlaps its groups.
	assert.deepEqual(overlappingDevices(groups, 'z_lampor_v').sort(), ['z_lampor_alla', 'z_lampor_vardagsrum']);
	assert.deepEqual(overlappingDevices(groups, 'matbord').sort(), ['z_lampor_alla', 'z_lampor_vardagsrum']);
	assert.deepEqual(overlappingDevices(groups, 'lampa_mette'), ['z_lampor_alla']);
	//A lamp in no group overlaps nothing.
	assert.deepEqual(overlappingDevices(groups, 'vardagsrum_vaggar'), []);
	//Two unrelated lamps do not overlap each other.
	assert.deepEqual(overlappingDevices(groups, 'golvlampa').filter(x => x === 'lampa_mette'), []);
});

test('nestGroupRows: a zone\'s devices become a tree, members indented under their group', () => {
	const groups = {
		z_lampor_v: ['v1', 'v2'],
		z_lampor_vardagsrum: ['matbord', 'golvlampa', 'v1', 'v2', 'unused_1'],
		z_lampor_alla: ['matbord', 'golvlampa', 'v1', 'v2', 'unused_1', 'lampa_mette'],
	};
	const zone = ['vaggar', 'matbord', 'golvlampa', 'z_lampor_v', 'z_lampor_vardagsrum'];
	const rows = nestGroupRows(groups, zone);
	//The group nests its members; the subgroup z_lampor_v nests under it too.
	assert.deepEqual(rows.map(r => r.device), ['vaggar', 'z_lampor_vardagsrum', 'matbord', 'golvlampa', 'z_lampor_v']);
	assert.deepEqual(rows.map(r => r.depth), [0, 0, 1, 1, 1]);
	//A group is the smallest containing group, so a member under z_lampor_alla
	//whose only group-in-zone is z_lampor_vardagsrum nests there.
	assert.equal(groupParent(groups, 'matbord', zone), 'z_lampor_vardagsrum');
	assert.equal(groupParent(groups, 'z_lampor_v', zone), 'z_lampor_vardagsrum');
	//A lamp in no group has no parent.
	assert.equal(groupParent(groups, 'vaggar', zone), null);
});
