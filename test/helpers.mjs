//Test harness for a repo with no build step, no bundler and no test framework.
//
//`mqtt-web.js` is a single script that connects to MQTT and starts listening the
//moment you import it, so the tests cannot import it. Instead they pull a
//function's SOURCE TEXT out of the file and evaluate it with stubs in scope.
//That sounds fragile and is, a little -- rename a function and its test stops
//finding it, loudly -- but it needs no refactor to exist, no dependency, and it
//tests the real code rather than a copy of it. Three real bugs were found this
//way before any of them had a test.
//
//Run: node --test test/

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function source(file = 'mqtt-web.js') {
	return readFileSync(join(ROOT, file), 'utf8');
}

//The text of `function <name>(...) { ... }`, brace-matched.
export function grab(name, src = source()) {
	const i = src.indexOf(`function ${name}(`);
	if (i < 0) throw new Error(`no function ${name}() in mqtt-web.js -- renamed?`);
	let depth = 0;
	for (let k = src.indexOf('{', i); k < src.length; k++) {
		if (src[k] === '{') depth++;
		else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1);
	}
	throw new Error(`unbalanced braces in ${name}()`);
}

//The text of an anonymous callback passed to something, as a usable function
//expression -- e.g. client.on('message', function (topic, message) { ... }).
export function grabCallback(marker, src = source()) {
	const i = src.indexOf(marker);
	if (i < 0) throw new Error(`no ${marker} in mqtt-web.js -- moved?`);
	const f = src.indexOf('function', i);
	if (f < 0) throw new Error(`no function expression after ${marker}`);
	let depth = 0;
	for (let k = src.indexOf('{', f); k < src.length; k++) {
		if (src[k] === '{') depth++;
		else if (src[k] === '}' && --depth === 0) return src.slice(f, k + 1);
	}
	throw new Error(`unbalanced braces after ${marker}`);
}

//Module-level consts the extracted functions close over.
export function preamble(src = source()) {
	const i = src.indexOf('const SCHEMA_KEYS');
	return i < 0 ? '' : src.slice(i, src.indexOf('function init(', i));
}

//Build a scope containing the named functions from mqtt-web.js plus the stubs,
//run `body` in it, and return whatever body returns. `published` collects
//everything publish()/publishDim() would have sent.
export function load(names, body, extra = {}) {
	const src = source();
	const published = [];
	const scope = {
		readFileSync: p => readFileSync(join(ROOT, String(p).replace(/^\.\//, ''))),
		log: () => {},
		queueSend: () => {},
		writeFileSync: () => {},
		publish: (entity, prop, msg) => published.push({ entity, [prop]: msg }),
		publishDim: (entity, level) => published.push({ entity, dim: level }),
		published,
		...extra,
	};
	const fn = new Function(
		...Object.keys(scope),
		`let devices, config;\n${preamble(src)}\n${names.map(n => grab(n, src)).join('\n')}\n${body}`
	);
	return { result: fn(...Object.values(scope)), published };
}
