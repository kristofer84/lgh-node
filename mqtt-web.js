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
import { validate, validateKey } from './user.js';
import { getSubscriptions, saveSubscription } from './subscription.js'
import { sendNotifications } from './notifications.js';
// import bodyParser from 'body-parser';

import { Server } from 'socket.io';

process.stdin.resume();

// START Init
var devices;
var config;


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
			let split = light.split('.');
			let device = split[0];

			if (!devices.hasOwnProperty(device)) devices[device] = {};
			devices[device].zone = zone;
			devices[device].type = split[1];

			if (split.length === 3) {
				if (split[2] === 'mood') {
					devices[device].mood = true;
				}

				if (split[2] === 'night') {
					devices[device].night = true;
				}
			}
		});
	});
}

init();
const client = connect(config.config.mqttAddress);
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

let csp = [];
csp.push("default-src 'none'");
csp.push("script-src-elem 'self' https://alcdn.msauth.net/browser/2.27.0/js/msal-browser.min.js https://ajax.googleapis.com/ajax/libs/jquery/3.5.1/jquery.min.js");
csp.push("connect-src 'self' https://login.microsoftonline.com");
csp.push("manifest-src 'self'");
csp.push("img-src 'self'");
csp.push("worker-src 'self'");
csp.push("script-src 'self'");
csp.push("frame-src 'self' https://login.live.com/ https://login.microsoftonline.com/");
csp.push("style-src 'self' https://fonts.googleapis.com https://cdnjs.cloudflare.com/ajax/libs/font-awesome/5.4.1/css/");
csp.push("font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com/ajax/libs/font-awesome/5.4.1/webfonts/");

app.use(logMiddleware);
app.use(function (req, res, next) {
	res.header('content-security-policy', csp.join(';'))
	res.header('permissions-policy', 'accelerometer=(), autoplay=(), camera=(), cross-origin-isolated=(), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), keyboard-map=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), publickey-credentials-get=(), screen-wake-lock=(self), sync-xhr=(), usb=(), web-share=(), xr-spatial-tracking=()')
	next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: false }));


app.get('/', async (req, res) => {
	//	res.header('content-type', 'text/html');
	//	res.end('<html><body style="background-color: black;"><center><img src="/file-FpWsQygSjs8CQvMyl2IymmpE.webp" /></center></body></html>');
	res.sendfile('./web/index.html');
});

app.get('/moja', async (req, res) => {
	const temperature = devices['moja_utomhus_temperature']?.state
	const pressure = devices['moja_utomhus_pressure']?.state
	const humidity = devices['moja_utomhus_humidity']?.state
	const ret = { moja_utomhus: { temperature, pressure, humidity } }

	res.header('content-type', 'application/json');
	res.end(JSON.stringify(ret, null, 2));
});

app.use(cookieParser('abdjhoejsjcudnruvuejd#jdjf38txjjejgh'));
app.use(passport.initialize());
app.use(express.json());
app.use(cookieMiddleware);
const server = createServer(app);


app.options('*', (res, req) => {
	res.statusCode = 204;
});
/*
app.get('/favicon.ico', (req, res) => {
	res.statusCode = 204;
	res.setHeader('etag', 'favicon-none');
	res.end();
});
*/
app.get('/key', passport.authenticate('oauth-bearer', { session: false }), async (req, res) => {
	const key = await validate(req.user.oid, req.user.preferred_username);
	setCookie(key, res);
});

app.get('/refresh-key', async (req, res) => {
	const key = req.signedCookies?.key;
	setCookie(key, res);
});

function setCookie(key, res) {
	res.cookie('key', key, { signed: true, httpOnly: true, sameSite: 'strict', maxAge: 1000 * 60 * 60 * 24 * 7 });
	res.statusCode = 204;
	res.end();
}

app.get('/key-from-cookie', async (req, res) => {
	const key = req.signedCookies?.key;
	res.end(JSON.stringify({ key }));
});

app.get('/cookies', async (req, res) => {
	const key = req.headers.cookie;
	res.end(JSON.stringify({ key }));
});

app.get('/push', async (req, res) => {
	const subs = await getSubscriptions();
	console.log(subs)
	sendNotifications(subs);
	res.end(JSON.stringify({ status: 'ok' }));
});


app.post('/subscribe', async (req, res) => {
	const data = req.body;
	console.log(data)
	saveSubscription(data, req.user.preferred_username);
	res.end(JSON.stringify({ status: 'ok' }));

	// res.end(JSON.stringify({ key }));
});

async function logMiddleware(req, res, next) {
	log(req.headers['x-forwarded-for'] + ': ' + req.path)
	next();
}

async function cookieMiddleware(req, res, next) {
	const bypass = ['/style.css', '/code.png', '/favicon-192.png', '/sk.jpeg', '/favicon.ico', '/login', '/login.js', '/key', '/config.json', '/manifest.json', '/scripts/sw.js', '/scripts/sw-init.js', '/init.js', '/dashboard'];

	if (bypass.includes(req.path) || req.path && req.path.startsWith('/static/')) {
		return next();
	}

	let key = req.signedCookies?.key;
	if (!key) {
		key = req.headers.authorization?.key
		//		console.log('Sockey key: ' + key)
	}

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
function middlewareTransform(middleware) {
	return (socket, next) => {
		const res = {};

		//Transfer token from handshake to headers for passport
		const token = socket.handshake.auth.token;
		socket.request.headers.authorization = token;

		let type = 'token';
		if (!token) {
			const key = socket.handshake.auth.key;
			socket.request.headers.authorization = key;
			type = 'key';
		}

		//lg.log(token)
		res.setHeader = (...params) => log(params);
		res.end = (...params) => {
			log('Authentication error', params);
			next(new Error('authentication_error'));
		}

		const n = async () => {
			log(`${socket.id} socket ${type} validated`)
			//			lg.log(`${socket.request.user.preferred_username} connected`)
			connections.set(socket.id, { user: socket.request.user?.preferred_username ?? '', connected: Date.now() });
			/*
						const user = socket.request.user;
						const existing = await us.validate(user.oid, user.preferred_username);
						lg.log(existing);
			*/
			next();
		}

		return middleware(socket.request, res, n);
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
		const valueTypes = ['state', 'current_temperature', 'current_humidity', 'current_pressure'];
		const valueType = split[3];

		//homeassistant/light/entre/state: on
		if (split[0] === 'homeassistant' && valueTypes.includes(valueType) && message.toString() !== 'unavailable' && message.toString() !== 'unknown') {
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

			console.log(device, colorCode, message.toString(), colorEnd);
			//Implicit change of known values (onoff and dim)
			//		if (valueType === 'state' && message.toString() === 'off' && devices[device].hasOwnProperty('dim')) {
			//			let prev = devices[device]['dim'];
			//			if (prev !== '0') {
			//				devices[device]['dim'] = '0';
			//			}
			//		}
			if (devices.hasOwnProperty(device) && devices[device].hasOwnProperty('zone')) {
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
	const user = connections.get(client.id);
	clientConnected(user.user, client);
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

	client.on('disconnect', () => { log(`${client.id} disconnected`); });
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

function getDevice(dev) {
	let retObj = {}

	if (dev) {
		let d = devices[dev];
		let r = {};

		let zone = d.zone === undefined ? 'nozone' : d.zone;
		r[zone] = {};

		if (d.type === 'light') {
			let dim = d.hasOwnProperty('dim') ? d['dim'] : undefined;
			let mood = d.mood;
			let night = d.night;
			r[zone][dev] = {
				onoff: d['onoff'] === 'true',
				dim: dim,
				night: night,
				mood: mood
			};

		}
		else if (d.type === 'occupancy') {
			r[zone][dev] = {
				// lastChange: d['lastChange']
			}
		}
		else if (d.type === 'sensor') {
			r[zone][dev] = {
				state: d['state']
			}
		}
		else if (d.hasOwnProperty('onoff')) {
			r[zone][dev] = {
				onoff: d['onoff'] === 'true'
			}
		}
		else if (d.hasOwnProperty('alarm-contact')) {
			r[zone][dev] = {
				onoff: d['alarm-contact'] === 'true'
			}
		}
		else if (d.hasOwnProperty('alarm-motion')) {
			r[zone][dev] = {
				onoff: d['alarm-motion'] === 'true'
			}
		}
		else {
			return {};
		}

		r[zone][dev].lastChange = d.lastChange;

		return r;
	}

	Object.keys(config.zones).forEach(zone => {
		const zoneDevices = {};
		let values = config.zones[zone];

		values.forEach(light => {
			let split = light.split('.');

			if (dev && dev !== split[0]) return;

			let ret = {};
			let type = split[1];
			let device = devices[split[0]];
			if (type === 'light' || type === 'switch') {
				ret.mood = (split.length > 2 && split[2] === 'mood') ? true : undefined;
				ret.night = (split.length > 2 && split[2] === 'night') ? true : undefined;
			}

			if (device != undefined) {
				if (type === 'light' || type === 'switch') {
					ret.onoff = device['onoff'] === 'true';
					ret.dim = device['dim'];
				}
				else if (type === 'occupancy') {
					ret.lastChange = device['lastChange'];
				}
				else {
					ret.state = device['state'];
				}
			}

			zoneDevices[split[0]] = ret;
		});

		if (Object.keys(zoneDevices).length > 0) {
			retObj[zone] = zoneDevices;
		}
	});

	return retObj;
}

//Save all on exit
function exitHandler(options, exitCode) {
	//Close MQTT
	client.end();

	let str = JSON.stringify(devices, null, '\t');
	if (str) {
		writeFileSync('./log/mqtt.log', str);
	}

	if (options.exit) {
		log(`Exiting: ${exitCode}`);
		process.exit();
	}
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

	if (value === "night") {
		config.zones[zone].forEach(device => {
			var split = device.split('.');
			if (split[1] !== 'light' && split[1] !== 'switch') return;
			var toState = split.length > 2 && split[2] === 'night' ? 'on' : 'off';
			publish(split[1] + '.' + split[0], 'state', toState);
		});
	}
	else if (value === "mood") {
		config.zones[zone].forEach(device => {
			var split = device.split('.');
			if (split[1] !== 'light' && split[1] !== 'switch') return;
			var toState = split.length > 2 ? 'on' : 'off'; //Night && mood
			publish(split[1] + '.' + split[0], 'state', toState);
		});
	}
	else {
		config.zones[zone].forEach(device => {
			var split = device.split('.');
			if (split[1] !== 'light' && split[1] !== 'switch') return;
			publish(split[1] + '.' + split[0], 'state', value)
		});
	}
}


function toggleItem(item, value) {
	if (value === undefined) {
		log(`Missing value`);
		return;
	}

	Object.values(config.zones).forEach(zone => zone.forEach(device => {
		var split = device.split('.');
		if (split[0] !== item) return;
		console.log(split)
		if (split[1] !== 'light' && split[1] !== 'switch') return;
		publish(split[1] + '.' + split[0], 'state', value)
	}));

	// publish(split[1] + '.' + split[0], 'state', toState);
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
process.on('SIGINT1', exitHandler.bind(null, { devices: devices, exit: true }));
process.on('SIGINT2', exitHandler.bind(null, { devices: devices, exit: true }));
process.on('uncaughtException', exitHandler.bind(null, { devices: devices, exit: true }));

const port = 8080;
server.listen(port, () => log(`Server started on port ${port}`));
