//Secrets come from .env (gitignored). Must run before any module that reads
//process.env at import time (notifications.js does).
//Values containing '#' must be QUOTED in .env or they are truncated at the '#'.
import { loadEnv } from './env.js';
loadEnv();

// import { BearerStrategy } from 'passport-azure-ad'
import passportAzureAd from 'passport-azure-ad';
const { BearerStrategy } = passportAzureAd;
import passport from 'passport';
import express from 'express';
import cookieParser from 'cookie-parser';

import { connect } from 'mqtt';
import { promises as fs } from 'fs';
import { readFileSync, writeFileSync } from 'fs';
import { createServer } from 'http';
// const https = require('https');
// const concat = require('concat-stream');
// const qs = require('querystring');
// const url = require('url');
import { log, mqtt as lgMqtt } from './log.js';
import { validate, validateKey, setCookie } from './user.js';
import { getSubscriptions, saveSubscription } from './subscription.js'
import { sendNotifications } from './notifications.js';
import bodyParser from 'body-parser';

import { Server } from 'socket.io';
import { registerWebnMethods } from './server-webn.js';
//The zone/device grammar and the step semantics. The same file is served to the
//browser at /scripts/zones.js and imported by tools/floorplan/generate.mjs, so
//all three agree by construction instead of by hand. See its header.
import { parseEntry, sceneFor } from './web/scripts/zones.js';

process.stdin.resume();

// START Init
var devices;
var config;


//Everything init() stamps onto a device from db/config.json. These describe what
//the device IS, not what it is doing, so they must never be persisted: the
//config is their only source, on every boot.
const SCHEMA_KEYS = ['zone', 'type', 'mood', 'night', 'level'];

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
			if (e.tier === 'mood') devices[device].mood = true;
			if (e.tier === 'night') devices[device].night = true;
			if (e.level !== undefined) devices[device].level = e.level;
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

app.use(bodyParser.json());
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
app.use(passport.initialize());
app.use(express.json());
app.use(cookieMiddleware);
const server = createServer(app);


//Parameters were the wrong way round here, and the response was never ended
app.options('*', (req, res) => {
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

app.get('/key-msal', passport.authenticate('oauth-bearer', { session: false }), wrap(async (req, res) => {
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
	const bypass = ['/style.css', '/code.png', '/favicon-192.png', '/login', '/sk.jpeg', '/favicon.ico', '/key-msal', '/config.json', '/manifest.json', '/scripts/sw.js', '/scripts/sw-init.js', '/init.js', '/dashboard'];

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

var options = {
	//identityMetadata: 'https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration',
	identityMetadata: 'https://login.microsoftonline.com/consumers/v2.0/.well-known/openid-configuration',
	clientID: 'bcb616b9-0f38-47ee-aeed-68dcffa68d67',
	// validateIssuer: config.creds.validateIssuer,
	issuer: 'https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0',
	//	issuer: 'https://login.microsoftonline.com/consumers/v2.0',
	// passReqToCallback: config.creds.passReqToCallback,
	// isB2C: config.creds.isB2C,
	// policyName: config.creds.policyName,
	// allowMultiAudiencesInToken: config.creds.allowMultiAudiencesInToken,
	// audience: 'https://graph.windows.net/',
	// loggingLevel: 'debug',
	loggingLevel: 'warn',
	//loggingNoPII: 'false',
	// clockSkew: config.creds.clockSkew,
	// scope: ['/user_impersonation']
};

var bearerStrategy = new BearerStrategy(options,
	async function (token, done) {
		log('Token verified');
		//console.log(token, 'was the token retreived');
		if (!token.oid) {
			log('error on login', token, new Error('oid is not found in token'));
			return done(null, false);
		}

		const gk = await validate(token.oid, token.preferred_username);
		if (!gk) {
			const msg = `User ${token.preferred_username} has not been granted access`;
			log(msg);
			return done(null, false);
		}

		// lg.log('oid', token.oid);
		// lg.log('preferred_username', token.preferred_username)
		return done(null, token);
	}
);

passport.use(bearerStrategy);
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
			if (VALUE_TYPES[valueType].derives
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
		const ret = { mood: meta.mood, night: meta.night, level: meta.level };
		if (seen) {
			ret.onoff = d['onoff'] === 'true';
			//`dim` was read from d['dim'], a key nothing ever wrote: 'brightness'
			//was not an ingested value type, so it was undefined for every lamp
			//for as long as the model has existed.
			ret.dim = brightnessOf(d);
		}
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
			zoneDevices[e.device] = shapeOf(devices[e.device], {
				type: e.type,
				mood: e.tier === 'mood' ? true : undefined,
				night: e.tier === 'night' ? true : undefined,
				level: e.level,
			}) ?? {};
		});

		if (Object.keys(zoneDevices).length > 0) retObj[zone] = zoneDevices;
	});

	return retObj;
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
function brightnessOf(d) {
	let raw = d === undefined ? undefined : d['brightness'];
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

function publishDim(device, percent) {
	if (percent === undefined) return;
	var topic = `webapp/dim/${device}/set`;
	log(`${topic}: ${percent}`);
	client.publish(topic, String(percent));
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

const port = 8080;
server.listen(port, () => log(`Server started on port ${port}`));
