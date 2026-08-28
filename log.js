//Variadic. It used to take a single argument, and callers that passed context
//had it silently dropped -- `log('error on login', token, new Error('oid is not
//found in token'))` in mqtt-web.js logged the four words and nothing else, so a
//token arriving without an oid left no diagnostic at all. Found by `npm run
//typecheck` on its first run.
//A one-argument call formats exactly as it always did.
/** @param {...unknown} parts */
export function log(...parts) {
	let date = new Date().toISOString();
	let str = parts.map(p => p instanceof Error ? (p.stack ?? p.message) : typeof p === 'object' && p !== null ? JSON.stringify(p) : String(p)).join(' ');
	console.log(`INFO: ${date} - ${str}`);
}

/** @param {unknown} str */
export function mqtt(str) {
	let date = new Date().toISOString();
	// console.log(`MQTT: ${date} - ${str}`);
}

const d = false;
/** @param {unknown} str */
export function debug(str) {
	if (d) {
		let date = new Date().toISOString();
		console.log(`DEBUG: ${date} - ${str}`);
	}
}
