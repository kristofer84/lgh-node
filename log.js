exports.log = function log(str) {
	let date = new Date().toISOString();
	console.log(`INFO: ${date} - ${str}`);
}

const d = false;
exports.debug = function debug(str) {
	if (d) {
		let date = new Date().toISOString();
		console.log(`DEBUG: ${date} - ${str}`);
	}
}
