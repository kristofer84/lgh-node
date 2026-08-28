//The shared grammar and step semantics. Pure functions, no stubs needed --
//this is the payoff for pulling them out of mqtt-web.js and home.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers.mjs';
import { parseEntry, sceneFor, stepOf, nextStep, stepsAvailable } from '../web/scripts/zones.js';

/** @typedef {import('../web/scripts/zones.js').Steps} Steps */
/** @typedef {import('../web/scripts/zones.js').ZoneModel} ZoneModel */
/** Literal `true` widens to `boolean` in a plain object literal, which is not a Steps. */
const steps = (/** @type {Steps} */ s) => s;
/** @param {ZoneModel} m */
const model = m => m;

test('parseEntry: the legacy string form maps a tier onto the steps it implied', () => {
	assert.deepEqual(parseEntry('sovrum_1_tak.light'), {
		entry: 'sovrum_1_tak.light', device: 'sovrum_1_tak', type: 'light',
		tier: undefined, level: undefined, steps: { on: true }, entity: 'light.sovrum_1_tak',
	});
	//⚠ night implied mood, and `on` lit everything regardless of tier.
	assert.deepEqual(parseEntry('slinga.light.night').steps, { night: true, mood: true, on: true });
	assert.deepEqual(parseEntry('lampa.light.mood').steps, { mood: true, on: true });
	assert.deepEqual(parseEntry('tak.light.mood.20').steps, { mood: 20, on: 100 });
	//A sensor has no steps at all and is never published to.
	assert.deepEqual(parseEntry('hall_temperature.sensor').steps, {});
	assert.equal(parseEntry('sang_hoger.switch.mood').tier, 'mood');
	assert.equal(parseEntry('slinga_mette.light.night').tier, 'night');
	assert.equal(parseEntry('badrum_1_tak.light.mood.20').level, 20);
	//A tier with no level is a plain on/off, not level 0.
	assert.equal(parseEntry('lampa_kai.light.mood').level, undefined);
});

test('parseEntry: the object form is taken as written', () => {
	const e = parseEntry({ device: 'badrum_1_tak', type: 'light', steps: { mood: 20, on: 100 } });
	assert.equal(e.device, 'badrum_1_tak');
	assert.equal(e.entity, 'light.badrum_1_tak');
	assert.deepEqual(e.steps, { mood: 20, on: 100 });
});

test('the explicit form expresses what a tier could not', () => {
	//Neither of these was reachable before: a tier made `night` imply `mood`, and
	//`on` always lit everything. These two cases are the reason for the format.
	const nightOnly = [{ device: 'a', type: 'light', steps: { night: true } }];
	assert.deepEqual(sceneFor(nightOnly, 'night'), [{ entity: 'light.a', state: 'on' }]);
	assert.deepEqual(sceneFor(nightOnly, 'mood'), [{ entity: 'light.a', state: 'off' }]);
	assert.deepEqual(sceneFor(nightOnly, 'on'), [{ entity: 'light.a', state: 'off' }]);

	const notInOn = [{ device: 'b', type: 'light', steps: { mood: 30 } }];
	assert.deepEqual(sceneFor(notInOn, 'mood'), [{ entity: 'light.b', level: 30 }]);
	assert.deepEqual(sceneFor(notInOn, 'on'), [{ entity: 'light.b', state: 'off' }]);
});

test('sceneFor: mood lights anything tiered, on lights everything', () => {
	const zone = ['tak.light', 'lampa.light.mood', 'slinga.light.night'];
	assert.deepEqual(sceneFor(zone, 'off'), [
		{ entity: 'light.tak', state: 'off' },
		{ entity: 'light.lampa', state: 'off' },
		{ entity: 'light.slinga', state: 'off' },
	]);
	//night counts as mood -- the original reads "Night && mood"
	assert.deepEqual(sceneFor(zone, 'mood'), [
		{ entity: 'light.tak', state: 'off' },
		{ entity: 'light.lampa', state: 'on' },
		{ entity: 'light.slinga', state: 'on' },
	]);
	assert.deepEqual(sceneFor(zone, 'night'), [
		{ entity: 'light.tak', state: 'off' },
		{ entity: 'light.lampa', state: 'off' },
		{ entity: 'light.slinga', state: 'on' },
	]);
	assert.deepEqual(sceneFor(zone, 'on'), [
		{ entity: 'light.tak', state: 'on' },
		{ entity: 'light.lampa', state: 'on' },
		{ entity: 'light.slinga', state: 'on' },
	]);
});

test('sceneFor: a level dims at its step and goes to 100 at on', () => {
	const zone = ['spegel.light', 'tak.light.mood.20'];
	assert.deepEqual(sceneFor(zone, 'mood'), [
		{ entity: 'light.spegel', state: 'off' },
		{ entity: 'light.tak', level: 20 },
	]);
	//⚠ `on` must say 100 out loud: a plain turn_on restores the level the lamp
	//last had, so after a mood press it would come back at 20%.
	assert.deepEqual(sceneFor(zone, 'on'), [
		{ entity: 'light.spegel', state: 'on' },
		{ entity: 'light.tak', level: 100 },
	]);
	//...but `off` is still a plain off, not a dim to zero.
	assert.deepEqual(sceneFor(zone, 'off').at(-1), { entity: 'light.tak', state: 'off' });
});

test('sceneFor ignores sensors and occupancy', () => {
	const out = sceneFor(['tak.light', 'hall_temperature.sensor', 'sensorer_alla.occupancy'], 'on');
	assert.deepEqual(out, [{ entity: 'light.tak', state: 'on' }]);
});

test('stepOf is the inverse of sceneFor for a plain zone', () => {
	const TAK = steps({ on: true }), LAMPA = steps({ mood: true, on: true });
	const m = (o) => model({ tak: { onoff: false, steps: TAK }, lampa: { onoff: false, steps: LAMPA }, ...o });
	assert.equal(stepOf(m()).step, 'off');
	assert.equal(stepOf(m({ lampa: { onoff: true, steps: LAMPA } })).step, 'mood');
	assert.equal(stepOf(m({ tak: { onoff: true, steps: TAK }, lampa: { onoff: true, steps: LAMPA } })).step, 'on');
	assert.equal(stepOf(m()).moodable, true);
	assert.equal(stepOf(m()).nightable, false);
});

test('stepOf really is the inverse of sceneFor, for every step', () => {
	//The property that matters: whatever sceneFor(step) publishes, stepOf must
	//read back as that same step. Checked against the REAL config.
	const cfg = JSON.parse(readFileSync(join(ROOT, 'db/config.json'), 'utf8'));
	for (const [zone, entries] of Object.entries(cfg.zones)) {
		const sw = entries.map(parseEntry).filter(e => e.type === 'light' || e.type === 'switch');
		if (!sw.length) continue;
		for (const step of ['off', 'night', 'mood', 'on']) {
			const avail = stepsAvailable(entries);
			if (step === 'night' && !avail.night) continue;
			if (step === 'mood' && !avail.mood) continue;
			//Build the model the room would be in after pressing `step`.
			/** @type {ZoneModel} */
			const m = {};
			for (const a of sceneFor(entries, step)) {
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
	//The bug this exists for: bad3 has ONE light, so every(onoff) called it `on`
	//whether it sat at 20% or 100%, and the room could never show its mood step.
	const at = dim => stepOf(model({ tak: { onoff: true, steps: { mood: 20, on: 100 }, dim } })).step;
	assert.equal(at(52), 'mood');    // 20% of 255
	assert.equal(at(255), 'on');     // full
	//Brightness not reported yet: both `mood` and `on` prescribe "lit", so the
	//state is genuinely ambiguous. Steps are checked dimmest-first, so the
	//quieter reading wins -- the room shows a modest wash rather than claiming
	//to be fully on, and corrects itself the moment brightness arrives.
	assert.equal(at(undefined), 'mood');
	assert.equal(stepOf(model({ tak: { onoff: false, steps: { mood: 20, on: 100 } } })).step, 'off');
});

test('stepOf ignores entries with no onoff (sensors)', () => {
	const s = stepOf(model({ tak: { onoff: true, steps: { on: true } }, hall_temperature: { state: '21.5' } }));
	assert.deepEqual(s.lights, ['tak']);
	assert.equal(s.step, 'on');
});

test('⚠ a room with only untiered lights on reads as partial, not on', () => {
	//The bug: this chain started at `let step = 'on'` and FELL THROUGH to it, so
	//one wardrobe light reported the whole room on -- full amber wash, and the
	//per-lamp glows hidden by `.zone-lights[light="on"] .glow`, so the lamp you
	//had just switched on became invisible. Adding a mood lamp then moved the
	//room backwards from `on` to `mood`. Reachable only once untiered lights got
	//their own tap targets.
	const sov2 = on => model({
		sovrum_2_tak: { onoff: on.includes('tak'), steps: steps({ on: true }) },
		lampa_mikkel: { onoff: on.includes('lampa'), steps: steps({ mood: true, on: true }) },
		mikkel_garderob: { onoff: on.includes('garderob'), steps: steps({ on: true }) },
	});
	assert.equal(stepOf(sov2([])).step, 'off');
	assert.equal(stepOf(sov2(['garderob'])).step, 'partial');
	assert.equal(stepOf(sov2(['lampa'])).step, 'mood');
	assert.equal(stepOf(sov2(['garderob', 'lampa', 'tak'])).step, 'on');
	//⚠ Since stepOf became an exact inverse of sceneFor, the mood scene plus an
	//extra lamp is NOT the mood scene -- the wardrobe light is on where mood says
	//off. That reads as `partial`, and it is the honest answer: pressing `mood`
	//again would switch the wardrobe light back off.
	assert.equal(stepOf(sov2(['garderob', 'lampa'])).step, 'partial');
	//Same shape in a bathroom: mirror untiered, ceiling mood.
	assert.equal(stepOf(model({
		badrum_1_spegel: { onoff: true, steps: { on: true } },
		badrum_1_tak: { onoff: false, steps: { mood: 20, on: 100 } },
	})).step, 'partial');
	//`on` still means every light, and nothing produces `partial` as a command.
	assert.ok(!sceneFor(['a.light', 'b.light.mood'], 'partial').some(x => x.state === 'on'));
});

test('nextStep walks the cycle', () => {
	const both = { moodable: true, nightable: true, allowMax: true };
	assert.equal(nextStep('off', both), 'night');
	assert.equal(nextStep('night', both), 'mood');
	assert.equal(nextStep('mood', both), 'on');
	assert.equal(nextStep('on', both), 'off');
	//A zone with neither tier is a plain two-step.
	assert.equal(nextStep('off', {}), 'on');
	assert.equal(nextStep('on', {}), 'off');
	//⚠ Without Max brightness the `on` step is unreachable -- which for a room
	//whose lights all carry a level means full brightness is too.
	assert.equal(nextStep('mood', { moodable: true, allowMax: false }), 'off');
	assert.equal(nextStep('mood', { moodable: true, allowMax: true }), 'on');
	//A partially-lit room presses to off, which is what it did while it was
	//mislabelled as `on`.
	assert.equal(nextStep('partial', { moodable: true, allowMax: true }), 'off');
	assert.equal(nextStep('partial', {}), 'off');
});
