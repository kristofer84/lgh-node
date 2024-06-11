export function log(str) {
	let date = new Date().toISOString();
	console.log(`INFO: ${date} - ${str}`);
}

export function mqtt(str) {
	let date = new Date().toISOString();
	// console.log(`MQTT: ${date} - ${str}`);
}

const d = false;
export function debug(str) {
	if (d) {
		let date = new Date().toISOString();
		console.log(`DEBUG: ${date} - ${str}`);
	}
}
