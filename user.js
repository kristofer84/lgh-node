import { promises as fs } from 'fs';
import { randomUUID, createHmac } from 'crypto';
import { log } from './log.js';
const db = './db/users.json';
const keyfile = './db/key.secret';

var config;

export async function validate(oid, username) {
	if (!config) config = await loadDb();

	//keyUserMap used to hand us an array here, which was then stored verbatim
	//and flowed on as an object key elsewhere (e.g. db/subscriptions.json).
	if (Array.isArray(username)) username = username[0];

	if (!Object.hasOwn(config.users, oid)) {
		config.users[oid] = { preferred_username: username, enabled: false };
		await saveDb();
		log(`Created disabled account for ${username} (${oid}) -- enable it in ${db}`);
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
	if (typeof key !== 'string' || !Object.hasOwn(config.keys, key)) return;

	const oid = config.keys[key].oid;
	const user = config.users[oid];

	//A key must stop working the moment the account is disabled
	if (!user?.enabled) return;
	return user;
}

//Never issue a cookie for a missing key -- validate() returns undefined for a
//user that exists but is not enabled, and stringifying that produced a signed
//'undefined' cookie plus a 204, i.e. a login that looked like it worked and
//then 401'd on every subsequent request.
export function setCookie(key, res) {
	if (!key) {
		log('Refusing to set cookie: no key (user not enabled?)');
		res.statusCode = 403;
		res.end();
		return false;
	}

	res.cookie('key', key, { signed: true, httpOnly: true, sameSite: 'strict', maxAge: 1000 * 60 * 60 * 24 * 7 });
	res.statusCode = 204;
	res.end();
	return true;
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
