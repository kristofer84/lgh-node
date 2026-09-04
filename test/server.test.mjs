//The parts still living inside mqtt-web.js, exercised against the REAL
//db/config.json and log/mqtt.log via the source-extraction harness. See
//helpers.mjs for why it works that way.
//
//Several of these encode a bug that actually happened. Those are marked ⚠.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, source, grabCallback, preamble, ROOT } from './helpers.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEntry, sceneFor } from '../web/scripts/zones.js';

const boot = body => load(['init', 'brightnessOf', 'kelvinOf', 'dimmableFrom', 'friendlyName', 'shapeOf', 'getDevice', 'toggle'], `init();\n${body}`, { parseEntry, sceneFor });

test('init() stamps zone, type and tier from the config', () => {
	const { result } = boot('return { devices, config };');
	const { devices, config } = result;
	for (const [zone, entries] of Object.entries(config.zones)) {
		for (const entry of entries) {
			const e = parseEntry(entry);
			const d = devices[e.device];
			assert.ok(d, `${e.device} missing from the model`);
			assert.equal(d.zone, zone, `${e.device} zone`);
			assert.equal(d.type, e.type, `${e.device} type`);
			assert.deepEqual(d.steps, e.steps, `${e.device} steps`);
		}
	}
});

test('⚠ init() CLEARS a tier the config no longer declares', () => {
	//The bug: `devices` is restored from log/mqtt.log, and mood/night were only
	//ever set, never deleted. A light that lost its tier came back still
	//advertising mood:true, so toggle() (config) and updateView() (model)
	//disagreed permanently, across every restart.
	//
	//The stale flag has to come from the FILE, not from a mutation after boot:
	//init() reassigns `devices` wholesale from log/mqtt.log, so anything set
	//in memory beforehand is discarded and the test would prove nothing.
	const real = readFileSync(join(ROOT, 'db/config.json'), 'utf8');
	const config = JSON.parse(real);
	const victim = Object.values(config.zones).flat()
		.map(parseEntry).find(e => !e.tier && (e.type === 'light' || e.type === 'switch'));
	assert.ok(victim, 'no untiered light in the config to test with');

	//The stale keys include the pre-2026-08-28 names, which is exactly what an
	//old log/mqtt.log contains.
	const doctored = { [victim.device]: { mood: true, night: true, level: 99, steps: { night: true }, onoff: 'true' } };
	const { result } = load(['init', 'brightnessOf', 'kelvinOf', 'dimmableFrom', 'friendlyName', 'shapeOf', 'getDevice', 'toggle'],
		'init(); return devices;',
		{
			parseEntry, sceneFor,
			readFileSync: p => String(p).includes('mqtt.log') ? Buffer.from(JSON.stringify(doctored)) : Buffer.from(real),
		});

	assert.equal(result[victim.device].mood, undefined, `${victim.device} kept a stale mood flag`);
	assert.equal(result[victim.device].night, undefined, `${victim.device} kept a stale night flag`);
	assert.equal(result[victim.device].level, undefined, `${victim.device} kept a stale level`);
	assert.deepEqual(result[victim.device].steps, victim.steps, `${victim.device} steps came from the config`);
	//...while the observations from the file survive.
	assert.equal(result[victim.device].onoff, 'true');
});

test('⚠ the snapshot and the per-device payload agree', () => {
	//The bug: the two paths built the payload separately, so a `switch` declared
	//.mood advertised mood:true in device.all and then lost it on the next
	//per-device update. They are one function now; this holds them to it.
	const { result } = boot(`
		const out = {};
		const all = getDevice(null);
		for (const zone of Object.keys(config.zones))
			for (const entry of config.zones[zone]) {
				const name = parseEntry(entry).device;
				const one = getDevice(name);
				out[name] = [all[zone]?.[name], one[Object.keys(one)[0]]?.[name]];
			}
		return out;`);
	for (const [name, [fromAll, fromOne]] of Object.entries(result)) {
		if (!fromAll || !fromOne) continue;
		for (const k of ['steps', 'onoff', 'dim', 'state', 'dimmable']) {
			assert.deepEqual(fromAll[k], fromOne[k], `${name}.${k}: snapshot ${JSON.stringify(fromAll[k])} vs per-device ${JSON.stringify(fromOne[k])}`);
		}
	}
});

test('toggle() publishes the whole room scene as one message, for every zone and step', () => {
	for (const step of ['off', 'natt', 'kvall', 'dag', 'stad']) {
		const { result, published, scenes } = load(
			['init', 'brightnessOf', 'kelvinOf', 'dimmableFrom', 'friendlyName', 'shapeOf', 'getDevice', 'toggle'],
			`init(); const zones = Object.keys(config.zones);
			 for (const z of zones) toggle(z, ${JSON.stringify(step)});
			 return config;`,
			{ parseEntry, sceneFor });
		//No per-device publishes any more -- the room goes out as one JSON message.
		assert.deepEqual(published, [], `step ${step} should not publish per device`);
		const zones = Object.keys(result.zones);
		assert.equal(scenes.length, zones.length, `step ${step} should publish one scene per zone`);
		for (const [i, z] of zones.entries()) {
			assert.equal(scenes[i].topic, `webapp/scene/${z}/set`);
			const want = sceneFor(result.zones[z], step);
			assert.deepEqual(JSON.parse(scenes[i].msg), want, `zone ${z} at ${step}`);
		}
	}
});

test('toggle() rejects an unknown zone and a missing value without publishing', () => {
	const { published, scenes } = load(['init', 'brightnessOf', 'kelvinOf', 'dimmableFrom', 'friendlyName', 'shapeOf', 'getDevice', 'toggle'],
		`init(); toggle('no_such_zone', 'stad'); toggle(Object.keys(config.zones)[0], undefined); return null;`,
		{ parseEntry, sceneFor });
	assert.deepEqual(published, []);
	assert.deepEqual(scenes, []);
});

test('every zone has steps that differ from one another', () => {
	//⚠ The untiered devices are what makes `stad` differ from `kvall`. kok and bad3
	//once had every light tiered, so the two steps published an identical scene
	//and the extra press did nothing. orangeri had the same at natt-vs-kvall.
	const { result } = boot('return config;');
	for (const [zone, entries] of Object.entries(result.zones)) {
		const scenes = {};
		for (const step of ['natt', 'kvall', 'dag', 'stad']) scenes[step] = JSON.stringify(sceneFor(entries, step));
		if (!JSON.parse(scenes.stad).length) continue;
		assert.notEqual(scenes.kvall, scenes.stad, `${zone}: kvall and stad publish the same scene`);
		assert.notEqual(scenes.dag, scenes.stad, `${zone}: dag and stad publish the same scene`);
		const tiers = entries.map(parseEntry).filter(e => e.tier);
		if (tiers.some(e => e.tier === 'night') && tiers.some(e => e.tier === 'mood'))
			assert.notEqual(scenes.natt, scenes.kvall, `${zone}: natt and kvall publish the same scene`);
	}
});

test('⚠ a brightness message must not change onoff', () => {
	//The bug: the typed pass ran for EVERY value type, so once brightness was
	//ingested a payload of "178" read as "not on" and flipped onoff to false.
	const src = source();
	const handler = grabCallback("client.on('message'", src);
	const run = (devices, topic, payload) => {
		const fn = new Function('devices', 'lgMqtt', 'log', 'queueSend', 'console',
			`${preamble(src)}\nconst h = ${handler}; h(${JSON.stringify(topic)}, Buffer.from(${JSON.stringify(payload)}));`);
		fn(devices, () => {}, () => {}, () => {}, { log() {} });
		return devices;
	};
	const d = { badrum_1_tak: { zone: 'bad1', type: 'light', onoff: 'true' } };
	run(d, 'homeassistant/light/badrum_1_tak/brightness', '178');
	assert.equal(d.badrum_1_tak.onoff, 'true', 'brightness clobbered onoff');
	assert.equal(d.badrum_1_tak.brightness, '178', 'brightness was not stored');

	run(d, 'homeassistant/light/badrum_1_tak/state', 'off');
	assert.equal(d.badrum_1_tak.onoff, 'false', 'state did not update onoff');
});

test('⚠ a light message cannot land on a same-named switch', () => {
	//The reducer keys the model by DEVICE NAME, not by entity, so one Z-Wave plug
	//exposing both command classes -- light.slinga_mette and switch.slinga_mette
	//-- wrote into the same entry. The dead `light.` half published
	//supported_color_modes: ["brightness"], which made a binary plug look
	//dimmable and offered a percentage box for it on the config page.
	const src = source();
	const handler = grabCallback("client.on('message'", src);
	const run = (devices, topic, payload) => {
		const fn = new Function('devices', 'lgMqtt', 'log', 'queueSend', 'console',
			`${preamble(src)}\nconst h = ${handler}; h(${JSON.stringify(topic)}, Buffer.from(${JSON.stringify(payload)}));`);
		fn(devices, () => {}, () => {}, () => {}, { log() {} });
		return devices;
	};
	const d = { slinga_mette: { zone: 'sov4', type: 'switch', onoff: 'true' } };
	run(d, 'homeassistant/switch/slinga_mette/state', 'off');
	assert.equal(d.slinga_mette.onoff, 'false', 'the switch domain must be accepted');

	run(d, 'homeassistant/light/slinga_mette/state', 'on');
	assert.equal(d.slinga_mette.onoff, 'false', 'a light message must NOT touch a switch device');

	//A sensor/occupancy entry legitimately arrives on another domain's topic, so
	//the guard must not reach those.
	const g = { sensorer_alla: { zone: 'home', type: 'occupancy' } };
	run(g, 'homeassistant/group/sensorer_alla/state', 'on');
	assert.equal(g.sensorer_alla.onoff, undefined);
	assert.equal(g.sensorer_alla.state, 'on', 'occupancy still ingests from its own domain');
});

test('the On/Off Mode select marks its own device non-dimmable', () => {
	//Fibaro config param 32 ships as select.<name>_on_off_mode; the verdict is
	//copied onto the real device key because the select lands under its own.
	const src = source();
	const handler = grabCallback("client.on('message'", src);
	const run = (devices, topic, payload) => {
		const fn = new Function('devices', 'lgMqtt', 'log', 'queueSend', 'console',
			`${preamble(src)}\nconst h = ${handler}; h(${JSON.stringify(topic)}, Buffer.from(${JSON.stringify(payload)}));`);
		fn(devices, () => {}, () => {}, () => {}, { log() {} });
		return devices;
	};
	const d = { badrum_2_spegel: { zone: 'bad2', type: 'light', supported_color_modes: '["brightness"]' } };

	run(d, 'homeassistant/select/badrum_2_spegel_on_off_mode/state', 'Enable (Dimming not possible)');
	assert.equal(d.badrum_2_spegel.onoffMode, true, 'on/off mode not recorded');

	//⚠ The same entity also publishes friendly_name/options; those must NOT
	//clobber the verdict -- friendly_name would leave it false.
	run(d, 'homeassistant/select/badrum_2_spegel_on_off_mode/friendly_name', '"Badrum 2 spegel On/Off Mode"');
	assert.equal(d.badrum_2_spegel.onoffMode, true, 'friendly_name clobbered on/off mode');

	run(d, 'homeassistant/select/badrum_2_spegel_on_off_mode/state', 'Disable (Dimming possible)');
	assert.equal(d.badrum_2_spegel.onoffMode, false, 'on/off mode not cleared');
});

test('a switch is never dimmable, whatever attributes linger', () => {
	const { result } = boot(`return [
		dimmableFrom({ type: 'switch', supported_color_modes: '["brightness"]' }),
		dimmableFrom({ type: 'light',  supported_color_modes: '["brightness"]' }),
		dimmableFrom({ type: 'light',  supported_color_modes: '["onoff"]' }),
		dimmableFrom({ type: 'light' }),
	];`);
	assert.deepEqual(result, [false, true, false, false]);
});

test('a Fibaro dimmer in on/off mode is not dimmable (config param 32)', () => {
	//supported_color_modes still reads ["brightness"] for a dimmer wired to a
	//non-dimmable load; the select entity's verdict must override it.
	const { result } = boot(`return [
		dimmableFrom({ type: 'light', supported_color_modes: '["brightness"]', onoffMode: true }),
		dimmableFrom({ type: 'light', supported_color_modes: '["brightness"]', onoffMode: false }),
		dimmableFrom({ type: 'light', supported_color_modes: '["brightness"]' }),
	];`);
	assert.deepEqual(result, [false, true, true]);
});

test('⚠ dim reaches the payload (brightness is an ingested value type)', () => {
	//The bug: getDevice returned device['dim'], a key nothing ever wrote, so
	//every lamp reported dim: undefined for as long as the model existed.
	const { result } = boot(`
		const name = Object.keys(config.zones).flatMap(z => config.zones[z])
			.map(parseEntry).find(e => e.type === 'light').device;
		devices[name].brightness = '178';
		devices[name].onoff = 'true';
		const one = getDevice(name);
		return one[Object.keys(one)[0]][name];`);
	assert.equal(result.dim, 178);
	assert.equal(result.onoff, true);
});

test('the payload carries the steps for a levelled light', () => {
	//Not covered by the snapshot-vs-per-device test: both callers share shapeOf
	//now, so dropping a field there loses it from both and they still agree.
	const { result } = boot(`
		const out = {};
		for (const zone of Object.keys(config.zones))
			for (const entry of config.zones[zone]) {
				const e = parseEntry(entry);
				if (!Object.values(e.steps ?? {}).some(v => typeof v === 'number')) continue;
				const one = getDevice(e.device);
				out[e.device] = [e.steps, one[Object.keys(one)[0]][e.device], getDevice(null)[zone][e.device]];
			}
		return out;`);
	assert.ok(Object.keys(result).length, 'no levelled light in the config to test with');
	for (const [name, [want, one, all]] of Object.entries(result)) {
		assert.deepEqual(one.steps, want, `${name} per-device steps`);
		assert.deepEqual(all.steps, want, `${name} snapshot steps`);
	}
});

test('brightnessOf survives HA sending the string "null"', () => {
	const { result } = boot(`return [brightnessOf({brightness:'178'}), brightnessOf({brightness:'null'}),
		brightnessOf({}), brightnessOf(undefined), brightnessOf({brightness:'nonsense'})];`);
	assert.deepEqual(result, [178, undefined, undefined, undefined, undefined]);
});

test('kelvinOf reads colour-temperature attributes as numbers or nothing', () => {
	const { result } = boot(`return [
		kelvinOf({color_temp_kelvin:'2403'}, 'color_temp_kelvin'),
		kelvinOf({color_temp_kelvin:'null'}, 'color_temp_kelvin'),
		kelvinOf({}, 'color_temp_kelvin'), kelvinOf(undefined, 'color_temp_kelvin'),
		kelvinOf({color_temp_kelvin:'warm'}, 'color_temp_kelvin')
	];`);
	assert.deepEqual(result, [2403, undefined, undefined, undefined, undefined]);
});

test('validateSteps accepts {level, kelvin} and clamps kelvin to the lamp range', () => {
	const { result } = load(['validateSteps'], `return [
		validateSteps({ kvall: 20 }),
		validateSteps({ kvall: { level: 20, kelvin: 2700 } }, [2202, 4000]),
		validateSteps({ stad: { level: 100, kelvin: 4000 } }, [2202, 4000]),
		validateSteps({ kvall: { level: 20, kelvin: 5000 } }, [2202, 4000]),
		validateSteps({ kvall: { level: 20, kelvin: 1000 } }, [2202, 4000]),
		validateSteps({ kvall: { kelvin: 2700 } }),
		validateSteps({ kvall: { level: 0, kelvin: 2700 } }),
		validateSteps({ kvall: { level: 20, kelvin: 'warm' } }),
		validateSteps({ bogus: true }),
	];`);
	assert.deepEqual(result, [
		undefined,
		undefined,
		undefined,
		'kvall.kelvin 5000 above lamp range 4000',
		'kvall.kelvin 1000 below lamp range 2202',
		'kvall.level must be a whole percent 1-100',
		'kvall.level must be a whole percent 1-100',
		'kvall.kelvin must be a positive number',
		'unknown step bogus',
	]);
});

test('color_temp lamps carry colorTemp and its kelvin range in the payload', () => {
	//The range is what drives the white-balance slider on the dashboard; it must
	//be a number or absent, never the raw string HA publishes.
	const { result } = boot(`
		const name = Object.keys(config.zones).flatMap(z => config.zones[z])
			.map(parseEntry).find(e => e.type === 'light').device;
		devices[name].color_temp_kelvin = '2403';
		devices[name].min_color_temp_kelvin = '2202';
		devices[name].max_color_temp_kelvin = '4000';
		const one = getDevice(name);
		return one[Object.keys(one)[0]][name];`);
	assert.equal(result.colorTemp, 2403);
	assert.equal(result.colorMin, 2202);
	assert.equal(result.colorMax, 4000);
});

test('a light with no colour data reports none of the colour fields', () => {
	const { result } = boot(`
		const name = Object.keys(config.zones).flatMap(z => config.zones[z])
			.map(parseEntry).find(e => e.type === 'light').device;
		delete devices[name].color_temp_kelvin;
		const one = getDevice(name);
		return one[Object.keys(one)[0]][name];`);
	assert.equal(result.colorTemp, undefined);
	assert.equal(result.colorMin, undefined);
	assert.equal(result.colorMax, undefined);
});


test('⚠ reloadConfig() re-stamps the config without discarding observed state', () => {
	//The config page saves and then reloads in-process. init() cannot be reused
	//for that: its first act is to read log/mqtt.log over `devices`, which would
	//throw away every state MQTT has reported since boot -- the whole model would
	//blank until each device next published.
	const { result } = load(
		['init', 'brightnessOf', 'kelvinOf', 'dimmableFrom', 'friendlyName', 'shapeOf', 'getDevice', 'toggle', 'reloadConfig'],
		`init();
		 const name = Object.keys(config.zones).flatMap(z => config.zones[z])
			.map(parseEntry).find(e => e.type === 'light').device;
		 devices[name].onoff = 'true';
		 devices[name].brightness = '178';
		 devices[name].lastChange = 12345;
		 devices[name].steps = { mood: 99 };            // stale, as if the file changed
		 reloadConfig();
		 return { name, d: devices[name], cfg: config.zones[devices[name].zone] };`,
		{ parseEntry, sceneFor });

	const { name, d, cfg } = result;
	const want = parseEntry(cfg.find(e => parseEntry(e).device === name)).steps;
	assert.deepEqual(d.steps, want, `${name} steps re-stamped from the config`);
	assert.equal(d.onoff, 'true', 'observed onoff survived');
	assert.equal(d.brightness, '178', 'observed brightness survived');
	assert.equal(d.lastChange, 12345, 'lastChange survived');
});

test('⚠ exitHandler persists observations, never schema', () => {
	//The bug this closes for good: log/mqtt.log seeds `devices` on the next boot,
	//so anything schema-shaped written here comes back as a fact that outlives
	//the config that produced it.
	const src = source();
	let written = null;
	const fn = new Function('devices', 'client', 'log', 'writeFileSync', 'process',
		`${preamble(src)}\n${src.slice(src.indexOf('function exitHandler('), src.indexOf('function brightnessOf('))}
		 exitHandler({}, 0);`);
	fn({ lampa: { zone: 'sov1', type: 'light', mood: true, level: 20, onoff: 'true', brightness: '52', lastChange: 1 } },
		{ end() {} }, () => {}, (_p, s) => { written = JSON.parse(s); }, { exit() {} });
	assert.deepEqual(written, { lampa: { onoff: 'true', brightness: '52', lastChange: 1 } });
});
