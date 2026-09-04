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
 * One thing to publish: a plain on/off, or a brightness (optionally with a
 * white balance / colour temperature in kelvin).
 * @typedef {{entity: string, state: string, level?: undefined, kelvin?: undefined}
 *         | {entity: string, level: number, kelvin?: number, state?: undefined}} Action
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
 * What a device does at each named step. Three possibilities, distinguished by
 * which form the key takes:
 *   - ABSENT            -> ignore: the scene leaves this device exactly as it is.
 *   - `false`           -> off: the scene turns the device off.
 *   - `true`            -> on (full).
 *   - a number          -> on at that brightness, in percent.
 *   - `{level, kelvin}` -> on at that brightness AND at that colour temperature
 *                          (kelvin), for lamps that support white balance.
 * The `off` step (whole-flat all-off, and a room's off press) is implicit and
 * ALWAYS turns every switchable device off, regardless of these keys.
 * The four named steps mirror Home Assistant's scene_mode: `natt` (night),
 * `kvall` (evening), `dag` (day), `stad` (cleaning/full).
 * @typedef {{level: number, kelvin: number}} StepLevel
 * @typedef {{natt?: true|false|number|StepLevel, kvall?: true|false|number|StepLevel, dag?: true|false|number|StepLevel, stad?: true|false|number|StepLevel}} Steps
 */

/** @typedef {Record<string, DeviceState>} ZoneModel */

/**
 * `partial` is a DISPLAY-only step: some lights in the room are on, but not all
 * of them, and none of the ones that are on belongs to a mood/night scene. No
 * press produces it -- sceneFor() never sees it -- it only describes what the
 * room currently looks like.
 * @typedef {'off'|'natt'|'kvall'|'dag'|'stad'|'partial'} Step
 */

//----------------------------------------------------------------- grammar

//A zone entry is either an OBJECT (the current form, written by the config page)
//or a dotted STRING (the original form, still used for sensors and still read so
//old configs keep working).
//
//Object form -- one row of the config page's table:
//    { "device": "badrum_1_tak", "type": "light", "steps": { "kvall": 20, "stad": 100 } }
//  device  matches split[2] of the MQTT topic (post-`climate` remap)
//  type    light | switch | sensor | occupancy
//  steps   what the device does at each named step. Three-state:
//          ABSENT=ignore (left alone), `false`=off, `true`=on, a number=on at
//          that percent, `{level, kelvin}`=on at brightness + white balance.
//          The `off` step is implicit and always turns everything off.
//
//String form -- `device.type[.tier[.level]]`, e.g. `sovrum_1_tak.light`,
//`sang_hoger.switch.mood`, `badrum_1_tak.light.mood.20`. A tier is translated to
//the steps it used to imply, which is where the old model was least obvious:
//`night` also lit at `mood` (the comment in toggle() read "Night && mood"), and
//`on` lit EVERYTHING regardless of tier. The legacy tiers are `mood` and `night`;
//they map onto the new HA-derived names: `night`→`natt`, `mood`→`kvall`, `on`→`stad`.
//Written out, that is:
//    (no tier)     -> { natt: false, kvall: false, dag: false,                       stad: true }
//    .mood         -> { natt: false, kvall: true,  dag: false,                       stad: true }
//    .night        -> { natt: true,  kvall: true,  dag: false,                       stad: true }
//    .mood.20      -> { natt: false, kvall: 20,    dag: false,                       stad: 100 }
//⚠ The unlit steps are written as explicit `false` (off) rather than left absent,
//because absent now means IGNORE (leave alone); the old string form meant the
//device off at every step it did not light, which is `false`, not absent.
//⚠ The step values are now authoritative and independent: a device can be lit at
//`natt` but not `kvall`, or left out of `stad` entirely. Neither was expressible
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
	//reads as untiered -- the device then only comes on at `stad`.
	const tier = /** @type {'mood'|'night'|undefined} */ (p[2]);
	const lvl = Number.isFinite(level) ? level : undefined;

	/** @type {Steps} */
	const steps = {};
	if (p[1] === 'light' || p[1] === 'switch') {
		//The unlit named steps are explicit `false` (off), because absent now means
		//IGNORE and the string form meant the device off at every step it did not
		//light. `stad` always lights. `off` is implicit (always off).
		steps.natt = tier === 'night' ? (lvl ?? true) : false;
		steps.kvall = (tier === 'night' || tier === 'mood') ? (lvl ?? true) : false;
		steps.dag = false;
		steps.stad = lvl === undefined ? true : 100;
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
//one action per switchable device EXCEPT those whose step is absent (= ignore,
//left alone): the scene only names the lights it turns on or off, so pressing a
//step changes exactly the lights it says something about and leaves the rest as
//they are. The `off` step is the exception -- it is the all-off sweep and names
//EVERY switchable device as off.
/**
 * @param {readonly (string|object)[] | undefined} entries
 * @param {string} step  off | natt | kvall | dag | stad
 * @returns {Action[]}
 */
export function sceneFor(entries, step) {
	/** @type {Action[]} */
	const out = [];
	for (const e of parseZone(entries).filter(isSwitchable)) {
		//The all-off sweep always names every device, regardless of its step keys.
		if (step === 'off') { out.push({ entity: e.entity, state: 'off' }); continue; }

		const v = e.steps?.[/** @type {'natt'|'kvall'|'dag'|'stad'} */ (step)];
		//ABSENT -> ignore: omit the device, leave it exactly as it is.
		if (v === undefined) continue;
		//`false` -> explicit off. `true` -> on.
		if (v === false) { out.push({ entity: e.entity, state: 'off' }); continue; }
		//A number is a brightness; an object is a brightness + a kelvin. ⚠ The
		//level must be published even at `on`, and the config page writes 100 there
		//for a dimmable device rather than `true`, because a plain turn_on restores
		//whatever level the lamp last had -- so `on` after a dimmed step would
		//otherwise leave it dimmed. Measured on the real dimmer 2026-08-27.
		if (typeof v === 'number') { out.push({ entity: e.entity, level: v }); continue; }
		if (v !== null && typeof v === 'object') {
			const level = Number(v.level);
			const kelvin = Number(v.kelvin);
			if (!Number.isFinite(level)) { out.push({ entity: e.entity, state: 'off' }); continue; }
			out.push(Number.isFinite(kelvin)
				? { entity: e.entity, level, kelvin }
				: { entity: e.entity, level });
			continue;
		}
		out.push({ entity: e.entity, state: 'on' });
	}
	return out;
}

//Which steps this zone actually offers -- a step is available when at least one
//device is lit at it (has a value that turns it on). `stad` is always offered.
/**
 * @param {readonly (string|object)[] | undefined} entries
 * @returns {{natt: boolean, kvall: boolean, dag: boolean, stad: boolean}}
 */
export function stepsAvailable(entries) {
	const sw = parseZone(entries).filter(isSwitchable);
	//A step is offered when at least one lamp has it SET (`false`=off counts, only
	//the absence/ignore `-` leaves the lamp out), so a step is hidden only when
	//every lamp is `-` at it. A "turn everything off" step is still a real scene.
	const set = (/** @type {unknown} */ v) => v !== undefined;
	const any = (/** @type {'natt'|'kvall'|'dag'|'stad'} */ k) => sw.some(e => set(e.steps?.[k]));
	return { natt: any('natt'), kvall: any('kvall'), dag: any('dag'), stad: any('stad') };
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
 * @returns {{step: Step, nattable: boolean, kvallable: boolean, dagable: boolean, stadable: boolean, lights: string[]}}
 */
export function stepOf(zoneModel) {
	const lights = Object.keys(zoneModel).filter(n => Object.hasOwn(zoneModel[n], 'onoff'));
	//A step is "available" when at least one lamp has it SET -- i.e. it says
	//SOMETHING about the lamp, whether off (`false`) or on (`true`/number/level).
	//Only the ABSENCE (ignore, `-`) leaves the lamp out, so a step is hidden only
	//when EVERY lamp is `-` at it -- a "turn everything off" step (all `false`) is
	//still a real scene and stays selectable.
	const set = (/** @type {unknown} */ v) => v !== undefined;
	const nattable = lights.some(n => set(zoneModel[n].steps?.natt));
	const kvallable = lights.some(n => set(zoneModel[n].steps?.kvall));
	const dagable = lights.some(n => set(zoneModel[n].steps?.dag));
	const stadable = lights.some(n => set(zoneModel[n].steps?.stad));

	//Does the room currently match what this step prescribes? A lamp the step
	//IGNORES (absent) imposes no constraint; `false` demands off; anything else
	//demands on (at its brightness, when one is authored).
	const matches = (/** @type {'natt'|'kvall'|'dag'|'stad'} */ step) => lights.every(n => {
		const m = zoneModel[n];
		const want = m.steps?.[step];
		if (want === undefined) return true;   // ignore: no constraint
		if (want === false) return !m.onoff;    // explicit off
		if (!m.onoff) return false;
		//A brightness only counts as matched when the lamp is actually near it.
		//Without this a room at 20% and the same room at 100% are the same state,
		//which is what made a dimmed bathroom report itself fully on. An object
		//step `{level, kelvin}` matches on its level (kelvin never changes which
		//step a room is in -- the step is brightness/onoff, not tint).
		const wantLevel = typeof want === 'number' ? want
			: (want !== null && typeof want === 'object' && Number.isFinite(Number(want.level)) ? Number(want.level) : undefined);
		if (wantLevel !== undefined && m.dim !== undefined) {
			return Math.abs(m.dim - wantLevel / 100 * 255) < 255 * 0.15;
		}
		return true;
	});

	/** @type {Step} */
	let step = 'partial';
	if (lights.every(n => !zoneModel[n].onoff)) step = 'off';
	else if (nattable && matches('natt')) step = 'natt';
	else if (kvallable && matches('kvall')) step = 'kvall';
	else if (dagable && matches('dag')) step = 'dag';
	else if (matches('stad')) step = 'stad';
	//...otherwise `partial`: lit, but not in any scene the room defines. No press
	//produces it; it only describes what is on screen.

	return { step, nattable, kvallable, dagable, stadable, lights };
}

//What each switchable device in a zone should LOOK LIKE (on/off) once `step`
//has been applied -- the optimistic render for a room press, so the lamps do
//not all flash off while the server echoes them back one by one. Mirrors
//sceneFor(): `off` sweeps everything off; an ABSENT step leaves the device as it
//is; `false` means off; anything else (true / number / {level, kelvin}) means on.
/**
 * @param {ZoneModel} zoneModel
 * @param {Exclude<Step, 'partial'>} step
 * @returns {Record<string, 'on'|'off'>}  only switchable devices, keyed by name
 */
export function sceneStates(zoneModel, step) {
	/** @type {Record<string, 'on'|'off'>} */
	const out = {};
	for (const name of Object.keys(zoneModel)) {
		if (!Object.hasOwn(zoneModel[name], 'onoff')) continue;
		let on;
		if (step === 'off') {
			on = false;
		} else {
			const v = zoneModel[name].steps?.[/** @type {'natt'|'kvall'|'dag'|'stad'} */ (step)];
			// ABSENT -> ignore: keep the device exactly as it is now.
			if (v === undefined) on = !!zoneModel[name].onoff;
			else on = v !== false;
		}
		out[name] = on ? 'on' : 'off';
	}
	return out;
}

//------------------------------------------------------------ groups

//Zigbee groups cast ONE command to every member lamp at once, so a scene that
//addresses BOTH a group and one of its members (or two overlapping groups) sends
//the same physical lamps two conflicting commands. The `groups` map records what
//each group drives so the rest of the system can avoid that: a step given a value
//on one device must be cleared (left absent = ignore) on every device that shares
//a member lamp with it.
//
//`groups` is { groupName: [memberDevice, ...] } -- the member list is FLAT (the
//physical lamps), and nesting/overlap is READ OUT of it: z_lampor_v (v1,v2) sits
//inside z_lampor_vardagsrum (matbord,golvlampa,v1,v2,unused_1) because the latter
//lists v1 and v2 too. A leaf device is any name that is not a group key.

/** The physical lamps a config device drives: itself when it is a leaf, else its
 *  group's member list. */
/**
 * @param {Record<string, string[]>} groups
 * @param {string} device
 * @returns {Set<string>}
 */
export function leafSet(groups, device) {
	return new Set(groups[device] ?? [device]);
}

/** Every OTHER device whose physical lamps overlap `device`'s -- i.e. every group
 *  that shares a member with it. Two leaf lamps never overlap. */
/**
 * @param {Record<string, string[]>} groups
 * @param {string} device
 * @returns {string[]}
 */
export function overlappingDevices(groups, device) {
	const mine = leafSet(groups, device);
	const out = [];
	for (const [g, members] of Object.entries(groups)) {
		if (g === device) continue;
		if (members.some(m => mine.has(m))) out.push(g);
	}
	return out;
}

//The group a device nests UNDER in the config editor, restricted to the devices
//of ONE zone. A group nests under the SMALLEST other group whose member set
//CONTAINS it (so z_lampor_v sits under z_lampor_vardagsrum, not z_lampor_alla);
//a leaf member nests under the group that lists it. Returns the parent device
//name, or null when the device sits at the top level of this zone.
/**
 * @param {Record<string, string[]>} groups
 * @param {string} device
 * @param {string[]} zoneDevices   the devices present in this one zone
 * @returns {string|null}
 */
export function groupParent(groups, device, zoneDevices) {
	const mine = leafSet(groups, device);
	let best = null;
	for (const g of zoneDevices) {
		if (g === device || !(g in groups)) continue;
		const gm = new Set(groups[g]);
		//`g` contains `device` iff every physical lamp `device` drives is in g.
		if ([...mine].every(m => gm.has(m))) {
			if (best === null || groups[g].length < groups[best].length) best = g;
		}
	}
	return best;
}

//Reorder a zone's device list into a tree for the config editor: each group is
//followed by the members that nest under it (recursively), and each row carries
//a `depth` so the UI can indent it. Top-level devices keep their config order;
//a group's children keep theirs. Only nests within the SAME zone -- a group
//whose members live in other rooms (z_lampor_alla) shows them as separate rows
//there, not here.
/**
 * @param {Record<string, string[]>} groups
 * @param {string[]} devices
 * @returns {{device: string, depth: number}[]}
 */
export function nestGroupRows(groups, devices) {
	const set = new Set(devices);
	const parentOf = /** @type {(d: string) => string|null} */ (d => {
		const p = groupParent(groups, d, devices);
		return p && set.has(p) ? p : null;
	});
	/** @type {Map<string, string[]>} */
	const children = new Map();
	for (const d of devices) {
		const p = parentOf(d);
		if (p) {
			if (!children.has(p)) children.set(p, []);
			children.get(p).push(d);
		}
	}
	/** @type {{device: string, depth: number}[]} */
	const out = [];
	const visit = (/** @type {string} */ d, /** @type {number} */ depth) => {
		out.push({ device: d, depth });
		for (const c of children.get(d) ?? []) visit(c, depth + 1);
	};
	for (const r of devices) if (!parentOf(r)) visit(r, 0);
	return out;
}

//------------------------------------------------------------- the cycle

//What a press moves the room to, darkest to brightest: off -> natt -> kvall ->
//dag -> stad -> off. A step is skipped when the room's lamps cannot do it (the
//mood/night flags come from stepsAvailable via stepOf). A step no lamp turns ON
//at -- including `stad` -- is skipped the same way, so an empty `stad` falls
//through to `off` rather than a press that lights nothing.
/**
 * @param {string|null} current  the room's present step
 * @param {{nattable?: unknown, kvallable?: unknown, dagable?: unknown, stadable?: unknown}} [opts]
 *   Truthiness is all that matters: home.js passes DOM attribute values, which
 *   are strings or null, not booleans.
 * @returns {Exclude<Step, 'partial'>|undefined} undefined when `current` is not a known step
 */
export function nextStep(current, { nattable, kvallable, dagable, stadable } = {}) {
	switch (current) {
		case 'stad': return 'off';
		//A partially-lit room presses to off, which is what it did while it was
		//mislabelled as `on`. Pressing a room with something on should turn it off.
		case 'partial': return 'off';
		case 'off': return nattable ? 'natt' : kvallable ? 'kvall' : dagable ? 'dag' : (stadable ? 'stad' : 'off');
		case 'dag': return stadable ? 'stad' : 'off';
		case 'kvall': return dagable ? 'dag' : (stadable ? 'stad' : 'off');
		case 'natt': return kvallable ? 'kvall' : dagable ? 'dag' : (stadable ? 'stad' : 'off');
	}
	return undefined;
}
