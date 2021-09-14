const mqtt = require('mqtt');
const client = mqtt.connect('mqtt://192.168.0.116');
const fs = require('fs').promises;
const fssync = require('fs');
const http = require('http');
const concat = require('concat-stream');
const qs = require('querystring');
const hostname = 'localhost';
const port = 8080;

process.stdin.resume();

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

var devices;
var config;

async function init() {
	let buffer = await fs.readFile('mqtt.log');
	let json = buffer.toString();
	devices = JSON.parse(json);

	let buffer2 = await fs.readFile('config.json');
	config = JSON.parse(buffer2.toString());


	//Save zone for each light for faster processing
	Object.keys(config.zones).forEach(zone => {
		let values = config.zones[zone];

		values.forEach(light => {
			let split = light.split('.');
			let device = split[0];
			devices[device].type = split[1];

			if (split.length === 3) {
				if (split[2] === 'mood') {
					devices[device].mood = true;
				}

				if (split[2] === 'night') {
					devices[device].night = true;
				}
			}
			if (!devices.hasOwnProperty(device)) devices[device] = {};
			devices[device].zone = zone;
		});
	});
}

init();

client.on('message', function (topic, message) {
	let split = topic.split('/');

	if (split[1] === 'homey') {

		let device = split[2];
		let valueType = split[3];

		let values = split.slice(2);

		//Convert '/'-separated string to object properties
		const reducer = (prev, curr, count) => prev[curr] = count === values.length - 1 ? message.toString() : prev.hasOwnProperty(curr) ? prev[curr] : {};
		values.reduce(reducer, devices);

		//if (devices[device] === undefined) { devices[device] = {}; }

		//if (split.length == 4 && !device.startsWith('$') && !valueType.startsWith('$')) {
		//	devices[device][valueType] = message.toString();

		//Implicit change of known values (onoff and dim)
		if (valueType === 'onoff' && message.toString() === 'false' && devices[device].hasOwnProperty('dim')) {
			let prev = devices[device]['dim'];
			if (prev !== '0') {
				//log(`Implicit change of dim for ${device} from ${prev} to 0`);
				devices[device]['dim'] = '0';
			}
		}

		if (valueType === 'dim') {
			let prev = devices[device]['onoff'];
			let val = parseInt(message.toString()) > 0 ? 'true' : 'false';
			if (prev !== val) {
				//log(`Implicit change of onoff for ${device} from ${prev} to ${val}`);
				devices[device]['onoff'] = val;
			}
		}

		queueSend(device);
		//}
	}

	let date = new Date();
	fs.appendFile('mqtt-raw.log', `${date.toISOString()}-${topic}: ${message.toString()}\n`, function(err) {
		if (err) log(err);
	});
});

var toSend = {};

function queueSend(device) {
	let dev = getDevice(device);
	if (Object.keys(dev).length > 0) {
		let json = JSON.stringify(dev);

		//Don't send if same as last emitted message
		if (toSend[device] !== json) {
			io.emit('device', json);
			toSend[device] = json;
		}
		else {
			//log(`Skipping duplicate for ${device}`);
		}
	}
}

const keys = {};

async function validateUser(pwd) {
	var users = (await fs.readFile('users.conf', 'binary')).toString().split('\n');
	let user = users.find(s => s.split(';')[1] === pwd);
	if (user !== undefined) return user.split(';')[0];
	return undefined;
}

async function returnFile(res, file) {
	data = await fs.readFile(file, 'binary');

	let ct = undefined;
	if (file.endsWith('.html')) ct = 'text/html'
	if (file.endsWith('.json')) ct = 'application/json'
	if (file.endsWith('.js')) ct = 'application/javascript'
	if (file.endsWith('.css')) ct = 'text/css'
	res.statusCode = 200;
	if (ct !== undefined) res.setHeader('Content-Type', ct);
	res.end(data.toString());
}

function returnContent(res, json) {
	let ct = 'application/json'
	res.setHeader('Content-Type', 'application/json');
	res.end(json);
}

const server = http.createServer();

server.on('request', async (req, res) => {
	let { headers, method, url } = req;
	if (method === 'OPTIONS') {
		res.statusCode = 204;
		res.end();
		return;
	}

	//Verify user
	let loggedIn = false;
	let user = 'kristofer';
	if (headers.cookie !== undefined) {
		let split = headers.cookie.split(';');
		var kaka = split.find(s => s.trim().split('=')[0] === 'minkaka');
		if (kaka !== undefined && kaka.split('=')[1] === 'kaka') {
			loggedIn = true;
		}
	}

	if (!loggedIn || url.startsWith('/login')) {
		if (method === 'POST') {
			const chunks = [];
			req.on('data', chunk => chunks.push(chunk));
			req.on('end', async () => {
				const data = Buffer.concat(chunks);
				let split = data.toString().split('=');
				if (split[0] === 'password') {
					let user = await validateUser(split[1]);

					if (!user) {
						res.statusCode = 403;
						res.setHeader('Content-Type', 'text/plain');
						res.end();
						return;
					}

					let date = new Date((new Date()).valueOf() + 1000 * 60 * 60 * 24 * 7 * 2);
					res.writeHead(302, {
						location: './dashboard',
						'Set-Cookie': `minkaka=kaka; Expires=${date.toUTCString()}`
					});
					console.log(`${user} logged in`);
					res.end();
				}
				else {
					res.statusCode = 400;
					res.end();
				}
			});

			return;
		}
		else {
			returnFile(res, './login.html');
			return;
		}
	}

	let token = 'ancioewowefiwe';
	keys[user] = token;
	res.setHeader('token', token);

	if (url.startsWith('/dashboard')) {
		returnFile(res, './dashboard.html');
		return;
	}

	if (url.endsWith('.js') || url.endsWith('.css')) {
		returnFile(res, `./${url}`);
		return;
	}

	if (url === '/api/all') {
		var json = JSON.stringify(devices, null, '  ');
		returnContent(res, json);
		return;
	}

	res.statusCode = 403;
	res.setHeader('Content-Type', 'text/plain');
	res.end();
});

function log(str) {
	let date = new Date().toISOString();
	console.log(`${date} - ${str}`);
}

// START socket.io
const io = require('socket.io')(server);
io.on('connection', client => {
	log(`${client.id} connected, sending data`);

	let lights = getDevice(null);
	var json = JSON.stringify(lights, null, '  ');
	var cson = JSON.stringify(config, null, '  ');
	client.emit('device.all', json);
//	client.emit('config', cson);

	client.on('toggle', data => {
		  var obj = JSON.parse(data.toString());
		  toggle(obj.name, obj.value);
	});

	client.on('disconnect', () => { log(`${client.id} disconnected`); });
});
// END socket.io

server.listen(port, () => {
	log(`Server running at port ${port}`);
});

function getTemperatures() {
	let retObj = {}
	Object.keys(devices).forEach(function (key) {
		var device = devices[key];
		Object.keys(device).forEach(function (valueKey) {
			if (valueKey === 'measure-temperature') {
				if (retObj[key] === undefined) retObj[key] = {};
				retObj[key].temperature = device[valueKey];
			}

			if (valueKey === 'measure-humidity') {
				if (retObj[key] === undefined) retObj[key] = {};
				retObj[key].humidity = device[valueKey];
			}
		});
	});
	return retObj;
}

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

		else if (d.type === 'th') {
			r[zone][dev] = {
				temperature: d['measure-temperature'],
				humidity: d['measure-humidity']
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
			if (type === 'light') {
				ret.mood = (split.length > 2 && split[2] === 'mood') ? true : undefined;
				ret.night = (split.length > 2 && split[2] === 'night') ? true : undefined;
			}

			if (device != undefined) {
				if (type === 'light') {
					ret.onoff = device['onoff'] === 'true';
					ret.dim = device['dim'];
				}
				else {
					ret.temperature = device['measure-temperature'];
					ret.humidity = device['measure-humidity'];
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
	fssync.writeFileSync('mqtt.log', str);

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
			if (split[1] !== 'light') return;
			var toState = (split.length > 2 && split[2] === 'night');
			publish(split[0], 'onoff', toState);
		});
	}
	else if (value === "mood") {
		config.zones[zone].forEach(device => {
			var split = device.split('.');
			if (split[1] !== 'light') return;
			var toState = (split.length > 2); //Night && mood
			publish(split[0], 'onoff', toState);
		});
	}
	else {
		config.zones[zone].forEach(device => {
			var split = device.split('.');
			if (split[1] !== 'light') return;
			publish(split[0], 'onoff', value)
		});
	}
}

function publish(device, property, message) {
	log(`homie/homey/${device}/${property}/set: ${message.toString()}`);
	if (message === undefined) return;
	var topic = `homie/homey/${device}/${property}/set`;
	client.publish(topic, message.toString());
}

process.on('exit', exitHandler.bind(null, { devices: devices }));
process.on('SIGINT', exitHandler.bind(null, { devices: devices, exit: true }));
process.on('SIGINT1', exitHandler.bind(null, { devices: devices, exit: true }));
process.on('SIGINT2', exitHandler.bind(null, { devices: devices, exit: true }));
process.on('uncaughtException', exitHandler.bind(null, { devices: devices, exit: true }));
