//The zone/device grammar and the light-step semantics, in ONE place.
//
//Shared by all three things that need them:
//  - the server            mqtt-web.js                  (Node ESM)
//  - the floorplan builder tools/floorplan/generate.mjs  (Node ESM)
//  - the dashboard         web/scripts/home.js           (the browser)
//
//It lives under web/ because that is the only directory all three can reach
//without a build step: `express.static('./web')` serves this file at
///scripts/zones.js, and dashboard.html loads home.js with type="module", so the
//browser imports it directly. Keep it free of imports and of anything Node- or
//DOM-specific, or the browser copy stops loading.
//
//Why it exists. The grammar below used to be re-implemented in seven places
//(mqtt-web.js x6 + generate.mjs), each with its own `split.length > 2` tests,
//and the meaning of a step was spread across three of them: toggle() decided
//what a step publishes, getNextStateRoom() decided which step came next, and
//updateView() reverse-engineered which step a room was currently in. Every one
//of those had to agree, and nothing made them. They did not:
//  - a switch declared `.mood` advertised mood:true in the device.all snapshot
//    and then lost it on the next per-device update, because the two paths
//    parsed the entry differently;
//  - adding a brightness segment meant editing five call sites, and missing one
//    would have failed silently;
//  - updateView() could not tell a lamp at its mood brightness from one at full,
//    so a room whose lights all carry a level never showed its mood step.

//----------------------------------------------------------------- types

/**
 * One parsed zone entry.
 * @typedef {object} Entry
 * @property {string} entry   the raw dotted string, as it appears in db/config.json
 * @property {string} device  [0] -- matches split[2] of the MQTT topic
 * @property {string} type    [1] -- light | switch | sensor | occupancy
 * @property {'mood'|'night'|undefined} tier   [2]
 * @property {number|undefined} level          [3], brightness percent
 * @property {string} entity  the HA entity_id, `type.device`
 */

/**
 * One thing to publish: a plain on/off, or a brightness.
 * @typedef {{entity: string, state: string, level?: undefined}
 *         | {entity: string, level: number, state?: undefined}} Action
 */

/**
 * A device as the socket sends it. Sensors carry `state` and no `onoff`.
 * @typedef {object} DeviceState
 * @property {boolean} [onoff]
 * @property {number}  [dim]    0-255, straight from HA
 * @property {number}  [level]  the brightness this device takes at its step
 * @property {boolean} [mood]
 * @property {boolean} [night]
 * @property {string}  [state]  sensors only -- the raw payload
 */

/** @typedef {Record<string, DeviceState>} ZoneModel */

/**
 * `partial` is a DISPLAY-only step: some lights in the room are on, but not all
 * of them, and none of the ones that are on belongs to a mood/night scene. No
 * press produces it -- sceneFor() never sees it -- it only describes what the
 * room currently looks like.
 * @typedef {'off'|'night'|'mood'|'on'|'partial'} Step
 */

//----------------------------------------------------------------- grammar

//A zone entry is a dotted string: `device.type[.tier[.level]]`.
//
//  [0] device — matches split[2] of the MQTT topic (post-`climate` remap)
//  [1] type   — light | switch | sensor | occupancy
//  [2] tier   — mood | night. Optional. Puts the device in that step's scene.
//  [3] level  — brightness percent, optional and only meaningful with a tier.
//               The device is dimmed to it at its step instead of just switched
//               on, and driven to 100 at `on`.
//
//Examples: `sovrum_1_tak.light`, `sang_hoger.switch.mood`,
//`slinga_mette.light.night`, `badrum_1_tak.light.mood.20`.
/**
 * @param {string} entry
 * @returns {Entry}
 */
export function parseEntry(entry) {
	const p = String(entry).split('.');
	const level = p[3] === undefined ? undefined : Number(p[3]);
	return {
		entry,
		device: p[0],
		type: p[1],
		//db/config.json is hand-edited and unvalidated, so this is an assertion,
		//not a guarantee. A typo like `.moood` parses to a tier nothing matches,
		//which reads as untiered -- the device then only comes on at `on`.
		tier: /** @type {'mood'|'night'|undefined} */ (p[2]),
		level: Number.isFinite(level) ? level : undefined,
		//The HA entity_id, which is what every outbound topic is keyed by.
		entity: `${p[1]}.${p[0]}`,
	};
}

//Only these two are switchable; a sensor or occupancy entry is never published
//to and never counts towards a room's step.
/**
 * @param {Entry} parsed
 * @returns {boolean}
 */
export function isSwitchable(parsed) {
	return parsed.type === 'light' || parsed.type === 'switch';
}

/**
 * @param {readonly string[] | undefined} entries
 * @returns {Entry[]}
 */
export function parseZone(entries) {
	return (entries ?? []).map(parseEntry);
}

//------------------------------------------------- what a step publishes

//Given a zone's raw config entries and a step, what should go out on MQTT.
//Returns one action per switchable device: `{entity, state}` for a plain
//on/off, or `{entity, level}` for a brightness. The caller does the publishing.
//
//⚠ The untiered devices in a zone are what makes `on` different from `mood` --
//`mood` switches the tiered ones on and the untiered ones OFF. A zone in which
//every light is tiered therefore has no `on` step at all unless the tiered ones
//carry a level, which separates the two by brightness instead of by membership.
/**
 * @param {readonly string[] | undefined} entries  the zone's raw config entries
 * @param {string} step  off | night | mood | on -- anything else is passed through as the state
 * @returns {Action[]}
 */
export function sceneFor(entries, step) {
	return parseZone(entries).filter(isSwitchable).map(e => {
		//`night` lights the .night tier only; `mood` lights anything tiered at
		//all (night counts as mood -- the original comment reads "Night && mood").
		//Any other value, `on` and `off` included, is passed straight through as
		//the state, which is what this has always done.
		const tiered = step === 'night' ? e.tier === 'night'
			: step === 'mood' ? e.tier !== undefined
				: undefined;

		//A light that names a brightness is DIMMED at its step rather than merely
		//switched on, and is driven to 100 at `on` EXPLICITLY: a plain turn_on
		//restores whatever level the lamp last had, so `on` after a mood press
		//would otherwise leave it sitting dimmed. Measured on the real dimmer
		//2026-08-27, not assumed.
		if (tiered === undefined) {
			if (step === 'on' && e.level !== undefined) return { entity: e.entity, level: 100 };
			return { entity: e.entity, state: step };
		}
		if (tiered && e.level !== undefined) return { entity: e.entity, level: e.level };
		return { entity: e.entity, state: tiered ? 'on' : 'off' };
	});
}

//--------------------------------------------- which step a zone is in now

//The inverse of sceneFor: read a zone's slice of the client model and say which
//step it is displaying. `zoneModel` is `{ device: {onoff, dim, level, mood,
//night}, ... }` -- exactly what the socket sends.
/**
 * @param {ZoneModel} zoneModel
 * @returns {{step: Step, moodable: boolean, nightable: boolean, lights: string[]}}
 */
export function stepOf(zoneModel) {
	const lights = Object.keys(zoneModel).filter(n => Object.hasOwn(zoneModel[n], 'onoff'));
	const moodable = lights.some(n => zoneModel[n].mood);
	const nightable = lights.some(n => zoneModel[n].night);
	const lit = n => Boolean(zoneModel[n].onoff);

	//A light that declares a step brightness is on at BOTH the mood and the on
	//step and only its brightness differs, so every(onoff) alone reported the
	//room fully on the moment the mood step lit it. Compare where the lamp
	//actually sits: nearer its declared level than full means still at the mood
	//step. `dim` is 0-255, straight from HA.
	const atStepLevel = n => {
		const m = zoneModel[n];
		if (!m.onoff || m.level === undefined || m.dim === undefined) return false;
		const target = m.level / 100 * 255;
		return Math.abs(m.dim - target) < Math.abs(m.dim - 255);
	};

	/** @type {Step} */
	//⚠ The last branch is not decoration. This chain used to start at `let step =
	//'on'` and fall through to it, so a room with SOME lights on and none of them
	//tiered reported itself fully on: switching on one wardrobe light washed the
	//whole room amber and -- since `.zone-lights[light="on"] .glow` hides the
	//per-lamp glows -- hid the very lamp that had just been lit. Adding a second,
	//mood-tiered lamp then moved the room BACKWARDS from `on` to `mood`.
	//It only became reachable when untiered lights got their own tap targets.
	/** @type {Step} */
	let step = 'partial';
	if (lights.every(n => !lit(n))) step = 'off';
	else if (lights.every(lit) && !lights.some(atStepLevel)) step = 'on';
	else if (moodable && lights.some(n => lit(n) && zoneModel[n].mood)) step = 'mood';
	else if (nightable && lights.some(n => lit(n) && zoneModel[n].night)) step = 'night';

	return { step, moodable, nightable, lights };
}

//------------------------------------------------------------- the cycle

//What a press moves the room to. `allowMax` is the "Max brightness" checkbox
//(#cb-mood, the sun icon): without it a room never reaches the `on` step, which
//for a room whose lights all carry a level means full brightness is unreachable
//from the floorplan.
/**
 * @param {string|null} current  the room's present step
 * @param {{moodable?: unknown, nightable?: unknown, allowMax?: unknown}} [opts]
 *   Truthiness is all that matters: home.js passes DOM attribute values, which
 *   are strings or null, not booleans.
 * @returns {Step|undefined} undefined when `current` is not a known step
 */
export function nextStep(current, { moodable, nightable, allowMax } = {}) {
	switch (current) {
		case 'on': return 'off';
		//A partially-lit room presses to off, which is what it did while it was
		//mislabelled as `on`. Pressing a room with something on should turn it off.
		case 'partial': return 'off';
		case 'off': return nightable ? 'night' : moodable ? 'mood' : 'on';
		case 'mood': return allowMax ? 'on' : 'off';
		case 'night': return moodable ? 'mood' : allowMax ? 'on' : 'off';
	}
	return undefined;
}
