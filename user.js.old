const fs = require('fs').promises;
const crypto = require('crypto');

const lg = require('./log.js');

const db = './db/users.json';
const keyfile = './db/key.secret';

var config;

exports.validate = async function validate(username, pwd) {
	if (!config) config = await loadDb();
	if (!config.users.hasOwnProperty(username)) return;

	let hash = await getHash(pwd);

	//Save the password first time
	if (config.users[username].password === undefined) {
		config.users[username].password = hash;
		await saveDb();
	}

	if (config.users[username].password !== hash) return;

	if (!config.users[username].generatedKey) {
		let gk = rand();
		config.users[username].generatedKey = gk;
		let date = (new Date()).toISOString();
		config.keys[gk] = { user: username, generated: date };
		await saveDb();
	}

	return config.users[username].generatedKey;
}

exports.validateKey = async function validateKey(key) {
	if (!config) config = await loadDb();
	if (!config.keys.hasOwnProperty(key)) return;

	return config.keys[key].user;
}

function rand() {
	return crypto.randomUUID();
	//    return Math.random().toString(36).replace(/[^a-z]+/g, '').substr(0, 7);
}

async function loadDb() {
	lg.log('Loading config');
	let binary = await fs.readFile(db, 'binary');
	return JSON.parse(binary.toString());
}

async function saveDb() {
	let content = JSON.stringify(config);
	await fs.writeFile(db, content)
}


var key;
async function getHash(str) {
	await getHmacKey();
	return crypto.createHmac('sha256', key).update(str).digest('hex');
}

async function getHmacKey() {
	if (key !== undefined) return key;
	//TODO file exists
	let binary = await fs.readFile(keyfile, 'binary');
	key = binary.toString();
	return key;
}
