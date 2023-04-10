import { promises as fs } from 'fs';
import { randomUUID, createHmac } from 'crypto';
import { log } from './log.js';
const db = './db/users.json';
const keyfile = './db/key.secret';

var config;

export async function validate(oid, username) {
	if (!config) config = await loadDb();
	if (!config.users.hasOwnProperty(oid)) {
		config.users[oid] = { preferred_username: username, enabled: false };
		await saveDb();
	}

	if (!config.users[oid].enabled) {
		log(`Unauthorized login attempt for ${username}`);
		return;
	}
	//	let hash = await getHash(pwd);

	//Save the password first time
	//	if (config.users[username].password === undefined) {
	//		config.users[username].password = hash;
	//		await saveDb();
	//	}

	//	if (config.users[username].password !== hash) return;

	if (!config.users[oid].generatedKey) {
		let gk = rand();
		config.users[oid].generatedKey = gk;
		let date = (new Date()).toISOString();
		config.keys[gk] = { oid: oid, generated: date };
		await saveDb();
	}

	return config.users[oid].generatedKey;
}

export async function validateKey(key) {
	if (!config) config = await loadDb();
	if (!config.keys.hasOwnProperty(key)) return;

	const oid = config.keys[key].oid;
	return config.users[oid];
}

function rand() {
	return randomUUID();
	//    return Math.random().toString(36).replace(/[^a-z]+/g, '').substr(0, 7);
}

async function loadDb() {
	log('Loading config');
	let binary = await fs.readFile(db, 'binary');
	return JSON.parse(binary.toString());
}

async function saveDb() {
	let content = JSON.stringify(config, null, 2);
	await fs.writeFile(db, content)
}


var key;
async function getHash(str) {
	await getHmacKey();
	return createHmac('sha256', key).update(str).digest('hex');
}

async function getHmacKey() {
	if (key !== undefined) return key;
	//TODO file exists
	let binary = await fs.readFile(keyfile, 'binary');
	key = binary.toString();
	return key;
}
