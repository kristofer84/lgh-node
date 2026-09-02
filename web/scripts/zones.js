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
 * @property {'mood'|'night'|undefined} tier   [2] -- legacy string form only
 * @property {number|undefined} level          [3] -- legacy string form only
 * @property {Steps} steps    what this device does at each step
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
 * @property {Steps}   [steps]    what this device does at each step
 * @property {boolean} [dimmable] whether a percentage is meaningful for it
 * @property {string}  [state]  sensors only -- the raw payload
 */

/**
 * What a device does at each named step. A key that is absent means OFF at that
 * step; `true` means on; a number means on at that brightness, in percent.
 * The `off` step is implicit and always means everything off.
 * @typedef {{night?: true|number, mood?: true|number, on?: true|number}} Steps
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

//A zone entry is either an OBJECT (the current form, written by the config page)
//or a dotted STRING (the original form, still used for sensors and still read so
//old configs keep working).
//
//Object form -- one row of the config page's table:
//    { "device": "badrum_1_tak", "type": "light", "steps": { "mood": 20, "on": 100 } }
//  device  matches split[2] of the MQTT topic (post-`climate` remap)
//  type    light | switch | sensor | occupancy
//  steps   what the device does at each named step. A key that is ABSENT means
//          off at that step; `true` means on; a number means on at that
//          brightness, in percent. The `off` step is implicit.
//
//String form -- `device.type[.tier[.level]]`, e.g. `sovrum_1_tak.light`,
//`sang_hoger.switch.mood`, `badrum_1_tak.light.mood.20`. A tier is translated to
//the steps it used to imply, which is where the old model was least obvious:
//`night` also lit at `mood` (the comment in toggle() read "Night && mood"), and
//`on` lit EVERYTHING regardless of tier. Written out, that is:
//    (no tier)     -> { on: true }
//    .mood         -> { mood: true,             on: true }
//    .night        -> { night: true, mood: true, on: true }
//    .mood.20      -> { mood: 20,               on: 100 }
//⚠ The step values are now authoritative and independent: a device can be lit at
//`night` but not `mood`, or left out of `on` entirely. Neither was expressible
//before, and both are why the config page needed this form.
/**
 * @param {string|object} entry
 * @returns {Entry}
 */
export function parseEntry(entry) {
	if (entry !== null && typeof entry === 'object') {
		const o = /** @type {any} */ (entry);
		return {
			entry,
			device: String(o.device),
			type: String(o.type),
			tier: undefined,
			level: undefined,
			steps: o.steps ?? {},
			entity: `${o.type}.${o.device}`,
		};
	}

	const p = String(entry).split('.');
	const level = p[3] === undefined ? undefined : Number(p[3]);
	//db/config.json is hand-edited and unvalidated, so this is an assertion, not
	//a guarantee. A typo like `.moood` parses to a tier nothing matches, which
	//reads as untiered -- the device then only comes on at `on`.
	const tier = /** @type {'mood'|'night'|undefined} */ (p[2]);
	const lvl = Number.isFinite(level) ? level : undefined;

	/** @type {Steps} */
	const steps = {};
	if (p[1] === 'light' || p[1] === 'switch') {
		if (tier === 'night') steps.night = lvl ?? true;
		if (tier === 'night' || tier === 'mood') steps.mood = lvl ?? true;
		steps.on = lvl === undefined ? true : 100;
	}

	return { entry, device: p[0], type: p[1], tier, level: lvl, steps, entity: `${p[1]}.${p[0]}` };
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

//Given a zone's config entries and a step, what should go out on MQTT. Returns
//one action per switchable device: `{entity, state}` for a plain on/off, or
//`{entity, level}` for a brightness. The caller does the publishing.
//
//Every switchable device is named in every scene -- the ones the step does not
//light are published `off`, not omitted -- so pressing a step always puts the
//room into exactly that state rather than adding to whatever was already on.
/**
 * @param {readonly (string|object)[] | undefined} entries
 * @param {string} step  off | night | mood | on
 * @returns {Action[]}
 */
export function sceneFor(entries, step) {
	return parseZone(entries).filter(isSwitchable).map(e => {
		const v = step === 'off' ? undefined : e.steps?.[/** @type {'night'|'mood'|'on'} */ (step)];
		//A number is a brightness. ⚠ It must be published even at `on`, and the
		//config page writes 100 there for a dimmable device rather than `true`,
		//because a plain turn_on restores whatever level the lamp last had -- so
		//`on` after a dimmed step would otherwise leave it dimmed. Measured on
		//the real dimmer 2026-08-27.
		if (typeof v === 'number') return { entity: e.entity, level: v };
		return { entity: e.entity, state: v ? 'on' : 'off' };
	});
}

//Which steps this zone actually offers -- a step is available when at least one
//device does something at it. `on` is always offered.
/**
 * @param {readonly (string|object)[] | undefined} entries
 * @returns {{night: boolean, mood: boolean, on: boolean}}
 */
export function stepsAvailable(entries) {
	const sw = parseZone(entries).filter(isSwitchable);
	const any = (/** @type {'night'|'mood'} */ k) => sw.some(e => e.steps?.[k] !== undefined);
	return { night: any('night'), mood: any('mood'), on: true };
}

//--------------------------------------------- which step a zone is in now

//The inverse of sceneFor: read a zone's slice of the client model and say which
//step it is displaying. `zoneModel` is what the socket sends -- per device
//`{onoff, dim, steps, dimmable}`.
//
//It compares the room's ACTUAL state against each step's scene and reports the
//one that matches, rather than inferring from flags. That is what makes the two
//functions genuine inverses: whatever sceneFor(step) publishes, stepOf reads
//back as `step`.
/**
 * @param {ZoneModel} zoneModel
 * @returns {{step: Step, moodable: boolean, nightable: boolean, lights: string[]}}
 */
export function stepOf(zoneModel) {
	const lights = Object.keys(zoneModel).filter(n => Object.hasOwn(zoneModel[n], 'onoff'));
	const moodable = lights.some(n => zoneModel[n].steps?.mood !== undefined);
	const nightable = lights.some(n => zoneModel[n].steps?.night !== undefined);

	//Does the room currently match what this step prescribes?
	const matches = (/** @type {'night'|'mood'|'on'} */ step) => lights.every(n => {
		const m = zoneModel[n];
		const want = m.steps?.[step];
		if (want === undefined) return !m.onoff;
		if (!m.onoff) return false;
		//A brightness only counts as matched when the lamp is actually near it.
		//Without this a room at 20% and the same room at 100% are the same state,
		//which is what made a dimmed bathroom report itself fully on.
		if (typeof want === 'number' && m.dim !== undefined) {
			return Math.abs(m.dim - want / 100 * 255) < 255 * 0.15;
		}
		return true;
	});

	/** @type {Step} */
	let step = 'partial';
	if (lights.every(n => !zoneModel[n].onoff)) step = 'off';
	else if (nightable && matches('night')) step = 'night';
	else if (moodable && matches('mood')) step = 'mood';
	else if (matches('on')) step = 'on';
	//...otherwise `partial`: lit, but not in any scene the room defines. No press
	//produces it; it only describes what is on screen.

	return { step, moodable, nightable, lights };
}

//------------------------------------------------------------- the cycle

//What a press moves the room to. `allowMax` is whether the `on` step is
//reachable. It used to be the "Max brightness" checkbox (#cb-mood, the sun
//icon); that toggle is gone and home.js always passes true, but the parameter
//stays so the cycle grammar remains explicit and testable. Without max, a room
//whose lights all carry a level could never reach full brightness.
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
