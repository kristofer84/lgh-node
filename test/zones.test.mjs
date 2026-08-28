//The shared grammar and step semantics. Pure functions, no stubs needed --
//this is the payoff for pulling them out of mqtt-web.js and home.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEntry, sceneFor, stepOf, nextStep } from '../web/scripts/zones.js';

test('parseEntry reads all four segments', () => {
	assert.deepEqual(parseEntry('sovrum_1_tak.light'), {
		entry: 'sovrum_1_tak.light', device: 'sovrum_1_tak', type: 'light',
		tier: undefined, level: undefined, entity: 'light.sovrum_1_tak',
	});
	assert.equal(parseEntry('sang_hoger.switch.mood').tier, 'mood');
	assert.equal(parseEntry('slinga_mette.light.night').tier, 'night');
	assert.equal(parseEntry('badrum_1_tak.light.mood.20').level, 20);
	//A tier with no level is a plain on/off, not level 0.
	assert.equal(parseEntry('lampa_kai.light.mood').level, undefined);
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
	const m = (o) => ({ tak: { onoff: false }, lampa: { onoff: false, mood: true }, ...o });
	assert.equal(stepOf(m()).step, 'off');
	assert.equal(stepOf(m({ lampa: { onoff: true, mood: true } })).step, 'mood');
	assert.equal(stepOf(m({ tak: { onoff: true }, lampa: { onoff: true, mood: true } })).step, 'on');
	assert.equal(stepOf(m()).moodable, true);
	assert.equal(stepOf(m()).nightable, false);
});

test('stepOf tells a dimmed lamp from a full one', () => {
	//The bug this exists for: bad3 has ONE light, so every(onoff) called it `on`
	//whether it sat at 20% or 100%, and the room could never show its mood step.
	const at = dim => stepOf({ tak: { onoff: true, mood: true, level: 20, dim } }).step;
	assert.equal(at(52), 'mood');    // 20% of 255
	assert.equal(at(255), 'on');     // full
	assert.equal(at(undefined), 'on'); // no brightness known: fall back to on
	assert.equal(stepOf({ tak: { onoff: false, mood: true, level: 20 } }).step, 'off');
});

test('stepOf ignores entries with no onoff (sensors)', () => {
	const s = stepOf({ tak: { onoff: true }, hall_temperature: { state: '21.5' } });
	assert.deepEqual(s.lights, ['tak']);
	assert.equal(s.step, 'on');
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
});
