//Secrets come from .env (gitignored). Must run before any module that reads
//process.env at import time (notifications.js does).
//Values containing '#' must be QUOTED in .env or they are truncated at the '#'.
import { loadEnv } from './env.js';
loadEnv();

//Entra bearer tokens are verified with `jose` -- see requireEntraToken() below.
//This used to be passport + passport-azure-ad. Microsoft DEPRECATED that package
//("no longer supported"), it had no release left to take, and it pulled in
//jsonwebtoken/jws/lodash versions carrying signature-validation-bypass
//advisories (GHSA-qwph-4952-7xr6, GHSA-hjrf-2m68-5959, GHSA-869p-cjfg-cm3x) --
//on the token-verification path, of all places. jose is zero-dependency and
//maintained, and does JWKS fetching, caching and rotation itself.
import { createRemoteJWKSet, jwtVerify } from 'jose';
import express from 'express';
import cookieParser from 'cookie-parser';

import { connect } from 'mqtt';
import { promises as fs } from 'fs';
import { readFileSync, writeFileSync } from 'fs';
import { createServer } from 'http';
// const https = require('https');
// const qs = require('querystring');
// const url = require('url');
import { log, mqtt as lgMqtt } from './log.js';
import { validate, validateKey, setCookie } from './user.js';
import { getSubscriptions, saveSubscription } from './subscription.js'
import { sendNotifications } from './notifications.js';

import { Server } from 'socket.io';
import { registerWebnMethods } from './server-webn.js';
//The zone/device grammar and the step semantics. The same file is served to the
//browser at /scripts/zones.js and imported by tools/floorplan/generate.mjs, so
//all three agree by construction instead of by hand. See its header.
import { parseEntry, parseZone, isSwitchable, sceneFor } from './web/scripts/zones.js';

process.stdin.resume();

// START Init
var devices;
var config;


//Everything init() stamps onto a device from db/config.json. These describe what
//the device IS, not what it is doing, so they must never be persisted: the
//config is their only source, on every boot.
//`mood`, `night` and `level` are the pre-2026-08-28 names. They are kept in this
//list purely so a log/mqtt.log written by the old code has them stripped on the
//way in, rather than carrying a tier the config no longer expresses.
const SCHEMA_KEYS = ['zone', 'type', 'steps', 'mood', 'night', 'level'];

//Every value type this process ingests, and what it means. Anything HA publishes
//that is not listed is dropped on the floor -- and with `publish_attributes:
//true` in mqtt_statestream it publishes a great deal. Adding an attribute
//client-side starts here.
//
//`derives: true` means the typed pass runs for it -- onoff for a light/switch,
//state for anything else -- on top of the raw `devices[d][valueType]` the
//reducer stores for every entry here. `derives: false` is raw-only.
//⚠ That distinction is load-bearing. The typed pass used to run for every value
//type, so the moment `brightness` was ingested a payload of "178" read as "not
//on" and flipped onoff to false. Only `state` may say whether a lamp is lit.
const VALUE_TYPES = {
	state: { derives: true },
	brightness: { derives: false },
	//Not used for switching -- it is what tells the config page whether a device
	//can take a percentage at all. HA publishes e.g. ["brightness"],
	//["color_temp"] or ["onoff"]; only the last means not dimmable.
	supported_color_modes: { derives: false },
	//White balance. HA publishes the LAMP'S CURRENT colour as `color_temp_kelvin`
	//(2202..4000 for every Z-Wave/Tradfri bulb here) as a raw string, and its
	//RANGE as min/max_color_temp_kelvin attributes. Raw-only: a temperature must
	//never be read as "is it on", which is the exact bug that bit `brightness`.
	color_temp_kelvin: { derives: false },
	min_color_temp_kelvin: { derives: false },
	max_color_temp_kelvin: { derives: false },
	//Also raw-only: the config page shows it so a row reads "Lampa Mikkel"
	//rather than `lampa_mikkel`. HA publishes it JSON-quoted.
	friendly_name: { derives: false },
	current_temperature: { derives: true },
	current_humidity: { derives: true },
	current_pressure: { derives: true },
};

function init() {
	let buffer = readFileSync('./log/mqtt.log');
	let json = buffer.toString();
	devices = JSON.parse(json);

	let buffer2 = readFileSync('./db/config.json');
	config = JSON.parse(buffer2.toString());

	//Save zone for each light for faster processing
	Object.keys(config.zones).forEach(zone => {
		let values = config.zones[zone];

		values.forEach(light => {
			const e = parseEntry(light);
			const device = e.device;

			if (!devices.hasOwnProperty(device)) devices[device] = {};

			//SCHEMA_KEYS are stamped here from db/config.json and nowhere else.
			//They are deliberately cleared first: `devices` was just restored from
			//log/mqtt.log, and setting without clearing left a light that had LOST
			//its tier still advertising mood:true to the client, so the room went
			//on rendering a mood step that toggle() -- which reads the config, not
			//the model -- no longer publishes. exitHandler() now strips these keys
			//on the way out too, so the file cannot carry them back at all.
			for (const k of SCHEMA_KEYS) delete devices[device][k];

			devices[device].zone = zone;
			devices[device].type = e.type;
			//parseEntry() normalises both config forms to `steps`, so this does not
			//care which one the file is written in.
			devices[device].steps = e.steps;
		});
	});
}

init();
//`config` and `devices` are assigned by init(), which tsc cannot see running
//before this line -- hence the assertions. If init() has not run the process is
//dead anyway: it reads db/config.json synchronously and unguarded.
const client = connect(/** @type {any} */ (config).config.mqttAddress);
// const certFolder = config.config.certFolder;
// END Init

// // START Http config
// async function webLog(req, data, port) {
// 	let { headers, method, url } = req;
// 	let date = new Date();
// 	if (data !== undefined && data.length > 0) {
// 		data = '_POST-data: ' + data;
// 	}

// 	fs.appendFile('./log/web-raw.log', `${date.toISOString()}_${port}_${method}_(${req.connection.remoteAddress}:${req.connection.remotePort})_${url}${data}\n`, function (err) {
// 		if (err) lg.log(err);
// 	});
// }

const app = express();
app.disable('x-powered-by');

//Express 4 does not catch rejections from async handlers. An uncaught one
//became an unhandledRejection, which Node turns into an uncaughtException --
//and this process used to exit on those. Every async route goes through wrap().
function wrap(handler) {
	return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

//The header below used to be commented out, so none of this was ever sent.
//No page reachable in normal use has an inline <script>/<style> or a style=""
//attribute, so 'unsafe-inline' is not needed -- keep it that way.
//Exception: web/public/relative.html is an unreferenced scratch page (a client
//-side slider demo) that does have both, and is served anonymously because the
//bypass list passes all of /public/. It renders inert under this policy.
let csp = [];
csp.push("default-src 'none'");
csp.push("script-src 'self' https://alcdn.msauth.net https://ajax.googleapis.com");
csp.push("connect-src 'self' https://login.microsoftonline.com");
csp.push("manifest-src 'self'");
csp.push("img-src 'self' data:");
csp.push("worker-src 'self'");
csp.push("frame-src https://login.live.com https://login.microsoftonline.com");
csp.push("style-src 'self' https://fonts.googleapis.com https://cdnjs.cloudflare.com");
csp.push("font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com");
csp.push("form-action 'self'");
csp.push("base-uri 'none'");
csp.push("frame-ancestors 'none'");

app.use(logMiddleware);
app.use(function (req, res, next) {
	res.header('content-security-policy', csp.join('; '))
	res.header('x-content-type-options', 'nosniff')
	res.header('referrer-policy', 'same-origin')
	res.header('permissions-policy', 'accelerometer=(), autoplay=(), camera=(), cross-origin-isolated=(), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), keyboard-map=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), publickey-credentials-get=(self), screen-wake-lock=(self), sync-xhr=(), usb=(), web-share=(), xr-spatial-tracking=()')
	next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.get('/', wrap(async (req, res) => {
	res.sendFile('index.html', { root: './web' });
}));

app.get('/moja', wrap(async (req, res) => {
	const temperature = devices['moja_utomhus_temperature']?.state
	const pressure = devices['moja_utomhus_pressure']?.state
	const humidity = devices['moja_utomhus_humidity']?.state
	const ret = { moja_utomhus: { temperature, pressure, humidity } }

	res.header('content-type', 'application/json');
	res.end(JSON.stringify(ret, null, 2));
}));

const cookieSecret = process.env.COOKIE_SECRET;
if (!cookieSecret) {
	console.error('FATAL: COOKIE_SECRET missing. Copy .env.example to .env and set it.');
	process.exit(1);
}

app.use(cookieParser(cookieSecret));
registerWebnMethods(app);
app.use(express.json());
app.use(cookieMiddleware);
const server = createServer(app);


//Parameters were the wrong way round here, and the response was never ended
//Express 5 renamed the wildcard: a bare '*' is now a parse error at startup
//("Missing parameter name at index 1"), and the splat has to be named.
//'/{*splat}' is the Express 5 spelling of Express 4's '*' -- it matches every
//path INCLUDING '/', which the unbraced '/*splat' does not.
app.options('/{*splat}', (req, res) => {
	res.statusCode = 204;
	res.end();
});
/*
app.get('/favicon.ico', (req, res) => {
	res.statusCode = 204;
	res.setHeader('etag', 'favicon-none');
	res.end();
});
*/

app.get('/key-msal', wrap(requireEntraToken), wrap(async (req, res) => {
	const key = await validate(req.user.oid, req.user.preferred_username);
	//setCookie answers 403 when the account exists but is not enabled
	setCookie(key, res);
}));

app.get('/refresh-key', wrap(async (req, res) => {
	const key = req.signedCookies?.key;
	setCookie(key, res);
}));

//  /key-from-cookie and /cookies used to hand the session key (and the raw
//  cookie header) to page JavaScript, which defeated the httpOnly flag -- any
//  XSS got a 7-day session. socket.io now authenticates from the cookie
//  server-side instead, so nothing needs to read the key from JS.

app.get('/push', wrap(async (req, res) => {
	const subs = await getSubscriptions();
	sendNotifications(subs);
	res.end(JSON.stringify({ status: 'ok' }));
}));


app.post('/subscribe', wrap(async (req, res) => {
	const data = req.body;
	if (!data?.endpoint) {
		res.statusCode = 400;
		return res.end(JSON.stringify({ error: 'not a push subscription' }));
	}

	await saveSubscription(data, req.user?.preferred_username);
	res.end(JSON.stringify({ status: 'ok' }));
}));

async function logMiddleware(req, res, next) {
	log(req.headers['x-forwarded-for'] + ': ' + req.path)
	next();
}

async function cookieMiddleware(req, res, next) {
	//The three icon-*.png entries are here for the same reason /manifest.json and
	///favicon-192.png are: the browser fetches a web app manifest and its icons
	//without credentials when installing or drawing the tab, so an icon behind
	//the gate is a 401 and the PWA silently falls back to a blank square.
	const bypass = ['/style.css', '/code.png', '/favicon-192.png', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/login', '/sk.jpeg', '/favicon.ico', '/key-msal', '/config.json', '/manifest.json', '/scripts/sw.js', '/scripts/sw-init.js', '/init.js', '/dashboard'];

	if (bypass.includes(req.path) || req.path && (req.path.startsWith('/static/') || req.path.startsWith('/public/'))) {
		return next();
	}

	//socket.io requests come through here too; both carry the signed cookie
	const key = req.signedCookies?.key;

	if (key) {
		const user = await validateKey(key);
		if (user) {
			req.user = user;
			//console.log(user)
			//lg.log('Received key: ' + key);
			return next();
		}

		log('Invalid cookie: ' + req.path)
	}
	else {
		log('No cookie: ' + req.path)
	}

	res.statusCode = 401;
	res.end();
}

//---- the config page's two routes -------------------------------------------
//⚠ Registered HERE, below cookieMiddleware, on purpose: in this file the
//registration order IS the authorization model. Moving either of these above
//the gate would let anyone rewrite what every light in the flat does.

//What the page renders: one row per switchable device, per zone.
app.get('/config/zones', wrap(async (req, res) => {
	const out = {};
	for (const [zone, entries] of Object.entries(config.zones)) {
		const rows = parseZone(entries).filter(isSwitchable).map(e => ({
			device: e.device,
			type: e.type,
			steps: e.steps ?? {},
			//Whether a percentage is meaningful, straight from HA's
			//supported_color_modes rather than from a hardcoded model list.
			dimmable: dimmableFrom(devices[e.device]),
			name: friendlyName(devices[e.device]),
		}));
		if (rows.length) out[zone] = rows;
	}
	res.end(JSON.stringify(out));
}));

//Save. Replaces the `steps` of the devices named in the body and touches
//nothing else -- sensors, occupancy entries and device ORDER are preserved,
//because order is what the floorplan generator uses to place unplaced lamps.
app.post('/config/zones', wrap(async (req, res) => {
	const body = req.body;
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		res.statusCode = 400;
		return res.end(JSON.stringify({ error: 'expected {zone: {device: steps}}' }));
	}

	//⚠ Apply to what is ON DISK, not to the in-memory copy. The in-memory config
	//is a snapshot from boot; writing it back would revert any hand edit made to
	//db/config.json since -- which is exactly what happened on 2026-08-29. Reading
	//it here means a save touches only the devices named in the request and leaves
	//every other edit, in any zone, intact.
	const disk = JSON.parse((await fs.readFile('./db/config.json')).toString());

	const changed = [];
	for (const [zone, devs] of Object.entries(body)) {
		const entries = disk.zones[zone];
		if (!entries) {
			res.statusCode = 400;
			return res.end(JSON.stringify({ error: `unknown zone ${zone}` }));
		}
		if (!devs || typeof devs !== 'object') continue;

		for (const [device, steps] of Object.entries(devs)) {
			const bad = validateSteps(steps);
			if (bad) {
				res.statusCode = 400;
				return res.end(JSON.stringify({ error: `${zone}/${device}: ${bad}` }));
			}
			const i = entries.findIndex(e => parseEntry(e).device === device);
			if (i < 0) {
				res.statusCode = 400;
				return res.end(JSON.stringify({ error: `${device} is not in ${zone}` }));
			}
			const e = parseEntry(entries[i]);
			if (!isSwitchable(e)) {
				res.statusCode = 400;
				return res.end(JSON.stringify({ error: `${device} is a ${e.type}, not switchable` }));
			}
			//Always written in the object form, so a saved config stops depending
			//on the legacy string parsing.
			entries[i] = { device: e.device, type: e.type, steps };
			changed.push(`${zone}/${device}`);
		}
	}

	await saveConfig(disk);
	//Memory now follows disk, so the next save starts from the same place and the
	//running model reflects the file that was just written.
	config = disk;
	reloadConfig();
	io.emit('device.all', JSON.stringify(getDevice(null), null, 2));
	log(`config saved by ${req.user?.preferred_username ?? 'unknown'}: ${changed.length} device(s)`);
	res.end(JSON.stringify({ status: 'ok', changed }));
}));

app.use(express.static('./web', { index: false, extensions: ['html'] }));

//Terminal error handler. Anything wrap() catches lands here, so a bad request
//is a 500 for that caller instead of an exception that takes the server down.
//The 4-argument signature is what marks it as an error handler to express.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
	//body-parser tags its own errors (malformed JSON, too large) with a status;
	//those are the caller's fault, not ours
	const status = err?.status ?? err?.statusCode ?? 500;
	log(`Error on ${req.method} ${req.path}: ${status === 500 ? (err?.stack ?? err) : err.message}`);
	if (res.headersSent) return;
	res.statusCode = status;
	res.end(JSON.stringify({ error: status === 500 ? 'internal error' : err.message }));
});

//Entra ID (personal Microsoft accounts) token verification.
//
//`consumers` is the personal-account tenant; 9188040d-... is its fixed tenant
//id, which is what appears as the `iss` claim. Both values were carried over
//from the passport-azure-ad options this replaced.
const ENTRA_ISSUER = 'https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0';
const ENTRA_CLIENT_ID = 'bcb616b9-0f38-47ee-aeed-68dcffa68d67';

//createRemoteJWKSet fetches the signing keys on demand and caches them, and
//re-fetches when it sees a `kid` it does not know -- so key rotation needs no
//code here.
const entraJWKS = createRemoteJWKSet(
	new URL('https://login.microsoftonline.com/consumers/discovery/v2.0/keys')
);

//Replaces passport.authenticate('oauth-bearer'). Verifies the signature, the
//issuer and the audience, then applies the same two checks the old strategy
//callback did: the token must carry an oid, and that oid must belong to an
//account validate() will hand a key to.
async function requireEntraToken(req, res, next) {
	const header = req.headers.authorization ?? '';
	const token = header.startsWith('Bearer ') ? header.slice(7) : undefined;
	if (!token) {
		res.statusCode = 401;
		return res.end(JSON.stringify({ error: 'missing bearer token' }));
	}

	let claims;
	try {
		//jose verifies the algorithm against the JWKS key rather than trusting
		//the token's own `alg` header, which is the class of bug the advisories
		//against the old jsonwebtoken were about.
		({ payload: claims } = await jwtVerify(token, entraJWKS, {
			issuer: ENTRA_ISSUER,
			audience: ENTRA_CLIENT_ID,
		}));
	} catch (err) {
		log('Entra token rejected', err instanceof Error ? err.message : err);
		res.statusCode = 401;
		return res.end(JSON.stringify({ error: 'invalid token' }));
	}

	if (!claims.oid) {
		log('error on login', claims, new Error('oid is not found in token'));
		res.statusCode = 401;
		return res.end(JSON.stringify({ error: 'invalid token' }));
	}

	const gk = await validate(claims.oid, claims.preferred_username);
	if (!gk) {
		log(`User ${claims.preferred_username} has not been granted access`);
		res.statusCode = 403;
		return res.end(JSON.stringify({ error: 'not granted access' }));
	}

	log('Token verified');
	req.user = claims;
	next();
}


const connections = new Map();

//[socket, next] to [req, res, next]
//transformation for socket
const socketCookieParser = cookieParser(cookieSecret);

function middlewareTransform(middleware) {
	return (socket, next) => {
		let settled = false;
		const res = {
			setHeader: () => { },
			end: () => {
				if (settled) return;
				settled = true;
				log(`${socket.id} socket rejected: not authenticated`);
				next(new Error('authentication_error'));
			},
		};

		const n = () => {
			if (settled) return;
			settled = true;
			log(`${socket.id} socket validated`);
			connections.set(socket.id, { user: socket.request.user?.preferred_username ?? '', connected: Date.now() });
			next();
		};

		//The handshake is same-origin, so the browser sends the session cookie
		//automatically. Parsing it here means nothing has to expose the key to
		//page JavaScript.
		socketCookieParser(socket.request, res, () => {
			Promise.resolve(middleware(socket.request, res, n)).catch(err => {
				log(`Socket auth error: ${err.message}`);
				res.end();
			});
		});
	};
}

/*
http.createServer(function(req, res) {
		webLog(req, '', 8080);
		res.writeHead(302, {"location": "https://" + req.headers['host'] + req.url});
		res.end();
}).listen(8080);

const server = https.createServer({
		key: fssync.readFileSync(certFolder + 'privkey.pem'),
		cert: fssync.readFileSync(certFolder + 'fullchain.pem'),
		ca: fssync.readFileSync(certFolder + 'chain.pem')
}, (res, req) => {
}).listen(8443);
*/
// END Http config

// MQTT Start
client.on('connect', function () {
	client.subscribe('#', function (err) {
		if (!err) {
			log('MQTT connected');
		}
		else {
			log(err);
		}
	});
});

client.on('message', function (topic, message) {
	try {
		const split = topic.split('/');
		const valueType = split[3];

		//⚠ An EMPTY payload is a retained-topic deletion, not a value. Publishing a
		//zero-length retained message is how MQTT clears a topic, and every
		//subscriber receives it as an ordinary message. Without this guard the
		//reducer below stored '' over the real value and, worse, the derived pass
		//read '' as "not on" and switched `onoff` to false -- so clearing the
		//broker's retained set turned every light off on the dashboard at once.
		//Observed 2026-08-31 while doing exactly that. There is nothing to learn
		//from a deletion, so drop it and keep what we already know.
		if (message.length === 0) return;

		//homeassistant/light/entre/state: on
		if (split[0] === 'homeassistant' && Object.hasOwn(VALUE_TYPES, valueType) && message.toString() !== 'unavailable' && message.toString() !== 'unknown') {
			let deviceType = split[1];
			let device = split[2];
			let values = split.slice(2);

			//Convert '/'-separated string to object properties
			const reducer = (prev, curr, count) => prev[curr] = count === values.length - 1 ? message.toString() : prev.hasOwnProperty(curr) ? prev[curr] : {};
			values.reduce(reducer, devices);

			if (deviceType === 'climate') {
				split.shift()
				split.shift()
				device = split.join('_').replace('current_', '');
			}

			let colorCode = '';
			const colorEnd = '\x1b[0m';
			if (message.toString() == 'on') {
				colorCode = '\x1b[1m\x1b[32m';
			} else if (message.toString() == 'off') {
				colorCode = '\x1b[1m\x1b[31m';
			}

			// console.log(device, colorCode, message.toString(), colorEnd);
			//Implicit change of known values (onoff and dim)
			//		if (valueType === 'state' && message.toString() === 'off' && devices[device].hasOwnProperty('dim')) {
			//			let prev = devices[device]['dim'];
			//			if (prev !== '0') {
			//				devices[device]['dim'] = '0';
			//			}
			//		}
			//Only a value type declared `derives: true` produces the extra field
			//below; the rest are raw-only and the reducer above has already stored
			//them. That table is what stops a repeat of the brightness bug, where
			//this block ran for EVERY value type and a payload of "178" read as
			//"not on" and switched onoff to false.
			//⚠ The reducer above keys the model by DEVICE NAME, not by entity, so
			//`light.slinga_mette` and `switch.slinga_mette` -- one Z-Wave plug
			//exposing both command classes -- write into the same entry and
			//clobber each other. The dead `light.` half published
			//supported_color_modes: ["brightness"], which made a binary plug look
			//dimmable. Only accept a light/switch message for a device the config
			//says is that domain. Sensors and occupancy are left alone: an
			//`occupancy` entry legitimately arrives on a `group/` topic.
			const domain = devices[device]?.type;
			const crossed = (deviceType === 'light' || deviceType === 'switch')
				&& (domain === 'light' || domain === 'switch')
				&& deviceType !== domain;

			if (!crossed && VALUE_TYPES[valueType].derives
				&& devices.hasOwnProperty(device) && devices[device].hasOwnProperty('zone')) {
				if (deviceType === 'light' || deviceType === 'switch') {
					let prev = devices[device]['onoff'];
					let val = message.toString() === 'on' ? 'true' : 'false';
					if (prev !== val) {
						devices[device]['onoff'] = val;
					}
				}
				// else if (deviceType === 'group') {
				// 	devices[device]['lastChange'] = Date.now();
				// }
				else {
					let prev = devices[device]['state'];

					//Devices are on if consumption is > 2.5
					let val = devices[device].zone === 'devices'
						? parseFloat(message.toString()) > 2.5
						: message.toString();

					if (prev !== val) {
						devices[device]['state'] = val;
					}
				}

				devices[device]['lastChange'] = Date.now();
				queueSend(device);
			}
		}

		let date = new Date();
		lgMqtt(`${topic} - ${message.toString()}`);
		//fs.appendFile('./log/mqtt-raw.log', `${date.toISOString()}-${topic}: ${message.toString()}\n`, function (err) {
		//	if (err) lg.log(err);
		//});
	}
	catch (e) {
		log(e);
	}
});

var toSend = {};

function queueSend(device) {
	let dev = getDevice(device);
	if (Object.keys(dev).length > 0) {
		let json = JSON.stringify(dev);
		//lg.log(`json: ${json}`);
		//Don't send if same as last emitted message
		if (toSend[device] !== json) {
			io.emit('device', json);
			toSend[device] = json;
		}
		else {
			//lg.log(`Skipping duplicate for ${device}`);
		}
	}
}
// MQTT End

// START HTTP Server functions Start
function rand() {
	return Math.random().toString(36).replace(/[^a-z]+/g, '').substr(0, 7);
}

/*
process.on('uncaughtException', (err, origin) => {
	lg.log(origin);
  fs.writeSync(
	process.stderr.fd,
	`Caught exception: ${err}\n` +
	`Exception origin: ${origin}`
  );
});

*/


// server.on('request', async (req, res) => {
// 	const chunks = [];
// 	var data = '';
// 	req.on('data', chunk => chunks.push(chunk));
// 	await req.on('end', async () => {

// 		if (chunks.length > 0) { data = Buffer.concat(chunks).toString(); }

// 		webLog(req, data, 8443);
// 		await handleRequest(req, res, data);
// 	});
// });


// END HTTP Server functions

// START socket.io
const io = new Server(server);

//io.use(middlewareTransform(passport.authenticate('oauth-bearer', { session: false })));
io.use(middlewareTransform(cookieMiddleware));
// io.use(middlewareTransform(utils.checkIsInRole('aog.user')));

io.on('connection', async client => {
	//An unguarded .user here was another async TypeError that could exit the process
	const user = connections.get(client.id);
	clientConnected(user?.user ?? '', client);
	/*	client.emit('auth', async (answer) => {
			let a = JSON.stringify(answer);
			let user = await us.validateKey(answer.socketKey);
			if (user === undefined) {
				lg.log(`Wrong socket key, closing connection`);
				client.disconnect();
			} else {
	//			clientConnected(user, client);
			}
		});
	*/
});

function clientConnected(user, client) {
	log(`${client.id} (${user}) connected, sending data`);

	let lights = getDevice(null);
	var json = JSON.stringify(lights, null, '  ');
	var cson = JSON.stringify(config, null, '  ');
	client.emit('device.all', json);

	client.on('toggle', data => {
		var obj = JSON.parse(data.toString());

		if (obj.type === 'room') {
			toggle(obj.name, obj.value);
		}
		else {
			toggleItem(obj.name, obj.value);
		}
	});

	//The hold-on-a-lamp popup: set one lamp's level or white balance, outside
	//the room's step cycle. `kind` is `dim` (percent 1-100) or `colortemp`
	//(kelvin). Both are validated here -- a malformed payload must log and drop,
	//not take the server down or publish garbage to MQTT.
	client.on('set', data => {
		let obj;
		try { obj = JSON.parse(data.toString()); } catch { log(`set: bad JSON`); return; }
		if (!obj || typeof obj.name !== 'string') { log(`set: missing name`); return; }

		if (obj.kind === 'dim') {
			const pct = Number(obj.value);
			if (!Number.isFinite(pct)) { log(`set: bad dim ${obj.value}`); return; }
			publishItemDim(obj.name, Math.min(100, Math.max(1, Math.round(pct))));
		}
		else if (obj.kind === 'colortemp') {
			const k = Number(obj.value);
			if (!Number.isFinite(k)) { log(`set: bad colortemp ${obj.value}`); return; }
			publishItemColorTemp(obj.name, Math.round(k));
		}
		else {
			log(`set: unknown kind ${obj.kind}`);
		}
	});

	client.on('disconnect', () => {
		//connections used to grow for the lifetime of the process
		connections.delete(client.id);
		log(`${client.id} disconnected`);
	});
}
// END socket.io

//function getTemperatures() {
//	let retObj = {}
//	Object.keys(devices).forEach(function (key) {
//		var device = devices[key];
//		Object.keys(device).forEach(function (valueKey) {
//			if (valueKey === 'measure-temperature') {
//				if (retObj[key] === undefined) retObj[key] = {};
//				retObj[key].temperature = device[valueKey];
//			}
//
//			if (valueKey === 'measure-humidity') {
//				if (retObj[key] === undefined) retObj[key] = {};
//				retObj[key].humidity = device[valueKey];
//			}
//		});
//	});
//	return retObj;
//}

//The ONE place a device's socket payload is built. getDevice() had two callers
//with two separate copies of this -- the per-device path read the tier off the
//model, the snapshot path re-parsed it off the config string -- so every field
//had to be added twice and the two could disagree. They did: a `switch` declared
//.mood advertised mood:true in the snapshot and then lost it on the next
//per-device update, because only one copy had learned that a switch is a light.
//
//`d` is the device's model entry, or undefined if MQTT has never mentioned it.
//`meta` is {type, mood, night, level} -- from the model on one path, from the
//config entry on the other; init() guarantees those agree.
function shapeOf(d, meta) {
	const seen = d !== undefined;

	if (meta.type === 'light' || meta.type === 'switch') {
		const ret = { steps: meta.steps ?? {}, dimmable: dimmableFrom(d) };
		if (seen) {
			ret.onoff = d['onoff'] === 'true';
			//`dim` was read from d['dim'], a key nothing ever wrote: 'brightness'
			//was not an ingested value type, so it was undefined for every lamp
			//for as long as the model has existed.
			ret.dim = brightnessOf(d);
		}
		//White balance, for lamps whose colour mode is color_temp. Kelvin is
		//what the hold-popup slider speaks; mireds are the inverse and not worth
		//exposing (250..454 maps monotonically to 4000..2202 K).
		const ct = kelvinOf(d, 'color_temp_kelvin');
		if (ct !== undefined) ret.colorTemp = ct;
		const mn = kelvinOf(d, 'min_color_temp_kelvin');
		const mx = kelvinOf(d, 'max_color_temp_kelvin');
		if (mn !== undefined && mx !== undefined) { ret.colorMin = mn; ret.colorMax = mx; }
		return ret;
	}
	if (meta.type === 'occupancy') return seen ? { lastChange: d['lastChange'] } : {};
	if (meta.type === 'sensor') return seen ? { state: d['state'] } : {};
	if (!seen) return undefined;

	//No declared type: only the per-device path reaches these, for devices that
	//arrived over MQTT without being in db/config.json.
	if (d.hasOwnProperty('onoff')) return { onoff: d['onoff'] === 'true' };
	if (d.hasOwnProperty('alarm-contact')) return { onoff: d['alarm-contact'] === 'true' };
	if (d.hasOwnProperty('alarm-motion')) return { onoff: d['alarm-motion'] === 'true' };
	return undefined;
}

function getDevice(dev) {
	//One device -> {zone: {device: shape}}, for the `device` event.
	if (dev) {
		const d = devices[dev];
		const shape = shapeOf(d, d);
		if (shape === undefined) return {};

		//⚠ The per-device payload carries lastChange and the snapshot does not.
		//That asymmetry is original behaviour and the client relies on the
		//per-device one for "senaste aktivitet"; it is not worth changing blind.
		shape.lastChange = d.lastChange;
		return { [d.zone === undefined ? 'nozone' : d.zone]: { [dev]: shape } };
	}

	//Everything -> {zone: {device: shape, ...}, ...}, for the `device.all` event.
	//Driven by the config rather than the model, so a device that is configured
	//but has never been heard from still appears.
	const retObj = {};
	Object.keys(config.zones).forEach(zone => {
		const zoneDevices = {};
		config.zones[zone].forEach(entry => {
			const e = parseEntry(entry);
			zoneDevices[e.device] = shapeOf(devices[e.device], { type: e.type, steps: e.steps }) ?? {};
		});

		if (Object.keys(zoneDevices).length > 0) retObj[zone] = zoneDevices;
	});

	return retObj;
}

//A step value is `true` (on), a whole percent 1-100, or absent (off at that
//step). Anything else is refused rather than written -- db/config.json is read
//unguarded at boot, so a bad value written here is a startup crash later.
function validateSteps(steps) {
	if (steps === null || typeof steps !== 'object' || Array.isArray(steps)) return 'steps must be an object';
	for (const [k, v] of Object.entries(steps)) {
		if (!['night', 'mood', 'on'].includes(k)) return `unknown step ${k}`;
		if (v === true) continue;
		if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 100) continue;
		return `${k} must be true or a whole percent 1-100`;
	}
	return undefined;
}

//Write db/config.json without ever leaving a half-written file where the next
//boot would read it: a timestamped backup first, then a temp file, then an
//atomic rename over the original.
//⚠ Takes the object to write. It used to serialise the module-level `config`,
//which meant a save wrote the whole in-memory copy -- the one loaded at boot --
//over whatever was on disk, silently discarding every hand edit made since the
//process started. That is not hypothetical: on 2026-08-29 a config-page save
//reverted an `orangeri` edit made 20 minutes earlier, with nothing in the log to
//say so. The POST handler now re-reads the file and applies its changes to that,
//so a save only ever touches the devices named in the request.
async function saveConfig(next) {
	const json = JSON.stringify(next, null, 2) + '\n';
	const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
	await fs.copyFile('./db/config.json', `./db/config.json.bak-${stamp}`);
	await fs.writeFile('./db/config.json.tmp', json);
	await fs.rename('./db/config.json.tmp', './db/config.json');
}

//Re-stamp the model from the config WITHOUT init()'s other half, which reloads
//log/mqtt.log over `devices` and would throw away every observed state since
//boot. Only the SCHEMA_KEYS are touched; everything MQTT has told us is left
//exactly as it is.
function reloadConfig() {
	for (const d of Object.values(devices)) {
		if (d === null || typeof d !== 'object') continue;
		for (const k of SCHEMA_KEYS) delete d[k];
	}
	Object.keys(config.zones).forEach(zone => {
		config.zones[zone].forEach(entry => {
			const e = parseEntry(entry);
			if (!devices.hasOwnProperty(e.device)) devices[e.device] = {};
			devices[e.device].zone = zone;
			devices[e.device].type = e.type;
			devices[e.device].steps = e.steps;
		});
	});
}

//Save all on exit
function exitHandler(options, exitCode) {
	//Close MQTT
	client.end();

	//Persist what was OBSERVED, never what the config says. log/mqtt.log seeds
	//`devices` on the next boot, so anything schema-shaped written here comes
	//back as a fact that outlives the config that produced it -- which is how a
	//light that had lost its tier kept advertising mood:true across restarts.
	//init() also clears these on the way in; stripping them here as well means
	//the file simply cannot carry them.
	const observed = {};
	for (const [name, d] of Object.entries(devices)) {
		if (d === null || typeof d !== 'object') continue;
		const keep = {};
		for (const [k, v] of Object.entries(d)) if (!SCHEMA_KEYS.includes(k)) keep[k] = v;
		observed[name] = keep;
	}

	let str = JSON.stringify(observed, null, '\t');
	if (str) {
		writeFileSync('./log/mqtt.log', str);
	}

	if (options.exit) {
		log(`Exiting: ${exitCode}`);
		process.exit();
	}
}

//HA statestream publishes brightness as 0-255 -- and literally "null" while the
//lamp is off. Everything downstream wants a number or nothing.
//A device takes a percentage when HA says it has a colour mode other than
//`onoff`. A `switch` publishes no colour modes at all, so it is never dimmable.
function dimmableFrom(d) {
	//A `switch` has no brightness, full stop. Checking the type rather than only
	//the attribute makes this immune to a stale supported_color_modes left in
	//log/mqtt.log by a same-named `light.` entity that no longer exists.
	if (d?.type === 'switch') return false;
	const raw = d === undefined ? undefined : d['supported_color_modes'];
	if (!raw) return false;
	try {
		const modes = JSON.parse(raw);
		return Array.isArray(modes) && modes.some(m => m !== 'onoff');
	} catch {
		return false;
	}
}

//HA publishes friendly_name JSON-quoted, e.g. `"Mikkel garderob"`.
function friendlyName(d) {
	const raw = d === undefined ? undefined : d['friendly_name'];
	if (typeof raw !== 'string') return undefined;
	try { const v = JSON.parse(raw); return typeof v === 'string' ? v : undefined; } catch { return raw; }
}

function brightnessOf(d) {
	let raw = d === undefined ? undefined : d['brightness'];
	if (raw === undefined || raw === null || raw === 'null') return undefined;
	let n = Number(raw);
	return Number.isFinite(n) ? n : undefined;
}

//Same shape as brightnessOf: HA publishes these as raw strings, or nothing if
//the lamp has never reported them. Returns a number or undefined.
function kelvinOf(d, key) {
	let raw = d === undefined ? undefined : d[key];
	if (raw === undefined || raw === null || raw === 'null') return undefined;
	let n = Number(raw);
	return Number.isFinite(n) ? n : undefined;
}

function toggle(zone, value) {
	if (config.zones[zone] === undefined) {
		log(`Missing zone: ${zone}`);
		return;
	}

	if (value === undefined) {
		log(`Missing value`);
		return;
	}

	//What the step means lives in web/scripts/zones.js, shared with the client
	//and the floorplan builder. All this does is put the result on the wire.
	for (const action of sceneFor(config.zones[zone], value)) {
		if (action.level !== undefined) publishDim(action.entity, action.level);
		else publish(action.entity, 'state', action.state);
	}
}

function toggleItem(item, value) {
	if (value === undefined) {
		log(`Missing value`);
		return;
	}

	//A single lamp, from a tap on its own symbol. Deliberately a plain on/off:
	//a device's step brightness belongs to the ROOM's step, not to poking one
	//lamp. The same device can appear in more than one zone, hence the sweep.
	Object.values(config.zones).forEach(zone => zone.forEach(entry => {
		const e = parseEntry(entry);
		if (e.device !== item) return;
		if (e.type !== 'light' && e.type !== 'switch') return;
		publish(e.entity, 'state', value);
	}));
}

//The hold-popup's two sliders. Same device->entity sweep as toggleItem, but the
//action is a dim % or a colour temperature, not on/off.
function itemEntities(item) {
	const out = [];
	Object.values(config.zones).forEach(zone => zone.forEach(entry => {
		const e = parseEntry(entry);
		if (e.device !== item) return;
		if (e.type !== 'light' && e.type !== 'switch') return;
		out.push(e.entity);
	}));
	return out;
}

function publishItemDim(item, percent) {
	itemEntities(item).forEach(entity => publishDim(entity, percent));
}

function publishItemColorTemp(item, kelvin) {
	itemEntities(item).forEach(entity => publishColorTemp(entity, kelvin));
}

function publishDim(device, percent) {
	if (percent === undefined) return;
	var topic = `webapp/dim/${device}/set`;
	log(`${topic}: ${percent}`);
	client.publish(topic, String(percent));
}

//White balance for a color_temp lamp. Kelvin goes out on its own topic the same
//way dim does -- the "Kontrollera enhet" automation only turns on/off, so a
//third topic keeps colour from colliding with either existing path. Needs the
//HA automation `(mqtt in) Vitbalans enhet` (webapp/colortemp/+/set).
function publishColorTemp(device, kelvin) {
	if (kelvin === undefined) return;
	var topic = `webapp/colortemp/${device}/set`;
	log(`${topic}: ${kelvin}`);
	client.publish(topic, String(kelvin));
}

function publish(device, property, message) {
	// lg.log(`homeassistant/light/${device}/${property}/set: ${message.toString()}`);
	if (message === undefined) return;
	var topic = `webapp/switch/${device}/${property}/set`;
	log(`${topic}: ${message.toString()}`);
	client.publish(topic, message.toString());
}

process.on('exit', exitHandler.bind(null, { devices: devices }));
process.on('SIGINT', exitHandler.bind(null, { devices: devices, exit: true }));
process.on('SIGTERM', exitHandler.bind(null, { devices: devices, exit: true }));

//These used to be bound to exitHandler with exit:true, which meant ANY stray
//error anywhere took the whole server down -- a single malformed POST to
//the /login/finish route was enough. Log and keep serving instead; state is
//still flushed by the 'exit' handler on a real shutdown.
process.on('uncaughtException', (err, origin) => {
	log(`Uncaught exception (${origin}): ${err instanceof Error ? err.stack : err}`);
});

process.on('unhandledRejection', (reason) => {
	log(`Unhandled rejection: ${reason instanceof Error ? reason.stack : reason}`);
});

//8080 unless overridden. The override exists so the app can be booted for a
//smoke test without fighting the running production process for the port.
const port = Number(process.env.PORT) || 8080;
server.listen(port, () => log(`Server started on port ${port}`));
