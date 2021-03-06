const mqtt = require('mqtt');
const fs = require('fs').promises;
const fssync = require('fs');
const http = require('http');
const https = require('https');
const concat = require('concat-stream');
const qs = require('querystring');
const url = require('url');
const lg = require('./log.js');
const us = require('./user.js');

process.stdin.resume();

// START Init
var devices;
var config;

function init() {
	let buffer = fssync.readFileSync('./log/mqtt.log');
	let json = buffer.toString();
	devices = JSON.parse(json);

	let buffer2 = fssync.readFileSync('./db/config.json');
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
const client = mqtt.connect(config.config.mqttAddress);
const certFolder = config.config.certFolder;
// END Init

// START Http config
async function webLog(req, data, port) {
	let { headers, method, url } = req;
	let date = new Date();
	if (data !== undefined && data.length > 0) {
		data = '_POST-data: ' + data;
	}

	fs.appendFile('./log/web-raw.log', `${date.toISOString()}_${port}_${method}_(${req.connection.remoteAddress}:${req.connection.remotePort})_${url}${data}\n`, function(err) {
		if (err) lg.log(err);
	});
}

const server = http.createServer({
}, (res, req) => {
}).listen(8080);

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
			lg.log('MQTT connected');
		}
		else {
			lg.log(err);
		}
	});
});

client.on('message', function (topic, message) {
	try {
	let split = topic.split('/');

    //homeassistant/light/entre/state: on
	if (split[0] === 'homeassistant') {
		let device = split[2];
		let deviceType = split[1];
		let valueType = split[3];

		let values = split.slice(2);

		//Convert '/'-separated string to object properties
		const reducer = (prev, curr, count) => prev[curr] = count === values.length - 1 ? message.toString() : prev.hasOwnProperty(curr) ? prev[curr] : {};
		values.reduce(reducer, devices);

		//Implicit change of known values (onoff and dim)
//		if (valueType === 'state' && message.toString() === 'off' && devices[device].hasOwnProperty('dim')) {
//			let prev = devices[device]['dim'];
//			if (prev !== '0') {
//				devices[device]['dim'] = '0';
//			}
//		}

		if (devices[device].hasOwnProperty('zone')) {
			if (valueType === 'state') {
				if (deviceType === 'light' || deviceType === 'switch') {
					let prev = devices[device]['onoff'];
					let val = message.toString() === 'on' ? 'true' : 'false';
					if (prev !== val) {
						devices[device]['onoff'] = val;
					}
				}
				else {
					let prev = devices[device]['state'];
					let val = devices[device].zone === 'devices'
						? parseFloat(message.toString()) > 0.00001
						: message.toString();

					if (prev !== val) {
						devices[device]['state'] = val;
					}
				}

				queueSend(device);
			}
		}
	}

	let date = new Date();
	fs.appendFile('./log/mqtt-raw.log', `${date.toISOString()}-${topic}: ${message.toString()}\n`, function(err) {
		if (err) lg.log(err);
	});
	}
	catch(e) {
		console.log(e);
	}
});

var toSend = {};

function queueSend(device) {
	let dev = getDevice(device);
	if (Object.keys(dev).length > 0) {
		let json = JSON.stringify(dev);
		//console.log(`json: ${json}`);
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
const fileCache = {};

async function returnFile(res, file) {
	try {
		let cf = fileCache[file];
		let mtimeStat = await fs.stat(file, function(err, stat) {
			if (err == null) return stat;
			else lg.log(err);
		});
		let mtime = mtimeStat.mtime.toISOString();
		let data;
		let etag;

		if (cf === undefined || mtime !== cf.mtime) {
			data = await fs.readFile(`${file}`, 'binary');
			etag = rand();
			fileCache[file] = { data: data, mtime: mtime, etag: etag };
		}
		else {
			data = cf.data;
			etag = cf.etag;
			lg.debug(`Read ${file} from cache`);
		}

		let ct = undefined;
		if (file.endsWith('.html')) ct = 'text/html'
		if (file.endsWith('.json')) ct = 'application/json'
		if (file.endsWith('.js')) ct = 'application/javascript'
		if (file.endsWith('.css')) ct = 'text/css'
		if (file.endsWith('.svg')) ct = 'image/svg+xml'
		if (file.endsWith('.jpeg')) ct = 'image/jpeg'
		res.statusCode = 200;
		if (ct !== undefined) res.setHeader('Content-Type', ct);
	//	res.setHeader('Cache-Control', 'max-age=600');
		res.setHeader('etag', etag);

		if (ct === 'image/jpeg') {
			res.end(data, 'binary');
		}
		else {
			res.end(data.toString());
		}
	}
	catch(e) {
		console.log(e);
	}
}

function returnContent(res, json) {
	let ct = 'application/json'
	res.setHeader('Content-Type', 'application/json');
	res.end(json);
}

async function verifyUser(headers) {
	if (headers.cookie !== undefined) {
		let split = headers.cookie.split(';');
		var ac = split.find(s => s.trim().split('=')[0] === 'socketKey');
		if (ac !== undefined) {
			let key = ac.trim().split('=')[1];
			let user = await us.validateKey(key);
			if (user !== undefined) return true;
		}
	}
	return false;
}

async function verifyLogin(req, res, data) {
//	const chunks = [];

//	req.on('data', chunk => chunks.push(chunk));
//	return await req.on('end', async () => {
//		const data = Buffer.concat(chunks);
		let strings = data.split('&');

		let userVar = strings.find(s => s.split('=')[0] === 'username');
		let passVar = strings.find(s => s.split('=')[0] === 'password');
		let username = userVar ? userVar.split('=')[1] : undefined;
		let password = passVar ? passVar.split('=')[1] : undefined;

		if (username && password) {
			let socketKey = await us.validate(username, password);
			if (socketKey) {
				let date = new Date((new Date()).valueOf() + 1000 * 60 * 60 * 24 * 7 * 2);
				res.writeHead(302, {
					location: './dashboard',
					'Set-Cookie': `socketKey=${socketKey}; Expires=${date.toUTCString()}`
				});

				lg.log(`${username} logged in`);
				res.end();
				return;
			}
			else {
				lg.log(`Failed login attempt ${username}:${password} (${req.connection.remoteAddress})`);
			}
		}

		returnFile(res, './web/login.html');
		return;
//	});
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

server.on('request', async (req, res) => {
	const chunks = [];
	var data = '';
	req.on('data', chunk => chunks.push(chunk));
	await req.on('end', async () => {

		if (chunks.length > 0) { data = Buffer.concat(chunks).toString(); }

		webLog(req, data, 8443);
		await handleRequest(req, res, data);
	});
});

async function handleRequest(req, res, data) {
	let { headers, method, url } = req;
	if (method === 'OPTIONS') {
		res.statusCode = 204;
//		res.setHeader('Cache-Control', 'max-age=600');
		res.end();
		return;
	}

	if (url === '/favicon.ico') {
		res.statusCode = 204;
//		res.setHeader('Cache-Control', 'max-age=600');
		res.setHeader('etag', 'favicon-none');
		res.end();
		return;
	}

	//Verify user
	let loggedIn = await verifyUser(headers);

 	let logInUrl = url.startsWith('/login4321');

	if (!loggedIn && !logInUrl && url !== '/dashboard') {
		res.statusCode = 403;
		res.end();
		return;
	}

	if (!loggedIn && (logInUrl || url === '/dashboard')) {
		if (method === 'POST') {
			await verifyLogin(req, res, data);
			return;
		}
		else {
			returnFile(res, './web/login.html');
			return;
		}
	}

	if (url === '/dashboard') {
		returnFile(res, './web/dashboard.html');
		return;
	}

	if (url === '/styles/style.css') {
		returnFile(res, './web/styles/style.css');
		return;
	}

	if (url === '/scripts/home.js') {
		returnFile(res, './web/scripts/home.js');
		return;
	}

	if (url.startsWith('/images/')) {
		returnFile(res, `./web${url}`);
		return;
	}

	if (url.startsWith('/node_modules/')) {
		returnFile(res, `.${url}`);
		return;
	}

	if (url === '/api/all') {
		var json = JSON.stringify(devices, null, '  ');
		returnContent(res, json);
		return;
	}

	res.statusCode = 403;
//	res.setHeader('Content-Type', 'text/plain');
	res.end();
}

// END HTTP Server functions

// START socket.io
const io = require('socket.io')(server);

io.on('connection', async client => {
	client.emit('auth', async (answer) => {
		let a = JSON.stringify(answer);
		let user = await us.validateKey(answer.socketKey);
		if (user === undefined) {
			lg.log(`Wrong socket key, closing connection`);
			client.disconnect();
		} else {
			clientConnected(user, client);
		}
	});
});

function clientConnected(user, client) {
 	lg.log(`${client.id} (${user}) connected, sending data`);

	let lights = getDevice(null);
	var json = JSON.stringify(lights, null, '  ');
	var cson = JSON.stringify(config, null, '  ');
	client.emit('device.all', json);

	client.on('toggle', data => {
		  var obj = JSON.parse(data.toString());
		  toggle(obj.name, obj.value);
	});

	client.on('disconnect', () => { lg.log(`${client.id} disconnected`); });
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

		return r;
	}

	Object.keys(config.zones).forEach(zone => {
		zoneDevices = {};
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
		fssync.writeFileSync('./log/mqtt.log', str);
	}

	if (options.exit) {
		lg.log(`Exiting: ${exitCode}`);
		process.exit();
	}
}

function toggle(zone, value) {
	if (config.zones[zone] === undefined) {
		lg.log(`Missing zone: ${zone}`);
		return;
	}

	if (value === undefined) {
		lg.log(`Missing value`);
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

function publish(device, property, message) {
	lg.log(`homeassistant/light/${device}/${property}/set: ${message.toString()}`);
	if (message === undefined) return;
	var topic = `home/switch/${device}/${property}/set`;
	client.publish(topic, message.toString());
}

process.on('exit', exitHandler.bind(null, { devices: devices }));
process.on('SIGINT', exitHandler.bind(null, { devices: devices, exit: true }));
process.on('SIGINT1', exitHandler.bind(null, { devices: devices, exit: true }));
process.on('SIGINT2', exitHandler.bind(null, { devices: devices, exit: true }));
process.on('uncaughtException', exitHandler.bind(null, { devices: devices, exit: true }));
