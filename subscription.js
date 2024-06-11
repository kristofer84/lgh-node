import { promises as fs } from 'fs';
import { log } from './log.js';
const dbFile = './db/subscriptions.json';
var db;

export async function getSubscriptions() {
	if (!db) db = await loadDb();
	return Object.values(db);
}

export async function saveSubscription(subscription, username) {
	if (!db) db = await loadDb();
	if (!db.hasOwnProperty(username)) {
		db[username] = [];
	}

	for (const subsc of db[username]) {
		if (JSON.stringify(subscription) === JSON.stringify(subsc)) {
			console.log(`Subscription for user ${username} already exists`)
			return;
		}
	}

	db[username].push(subscription);
	await saveDb();
}

async function loadDb() {
	log('Loading subscriptions');
	let binary = await fs.readFile(dbFile, 'binary');
	return JSON.parse(binary.toString());
}

async function saveDb() {
	let content = JSON.stringify(db, null, 2);
	await fs.writeFile(dbFile, content)
}