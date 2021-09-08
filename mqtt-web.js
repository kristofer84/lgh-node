const mqtt = require('mqtt');
const client = mqtt.connect('mqtt://192.168.0.116');
const fs = require('fs');
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

function init() {
	let buffer = fs.readFileSync('mqtt.log');
	let json = buffer.toString();
	devices = JSON.parse(json);

	let buffer2 = fs.readFileSync('config.json');
	config = JSON.parse(buffer2.toString());

	//Save zone for each light for faster processing
	/*
	Object.keys(config.zones).forEach(zone => {
		let values = config.zones[zone];

		values.forEach(light => {
			let split = light.split('.');
			deviceZones[split[0]] = zone;
		});
	});
	*/
}

init();

client.on('message', function (topic, message) {
	let split = topic.split('/');

	if (split[1] === 'homey') {

		let device = split[2];
		let valueType = split[3];

		if (devices[device] === undefined) { devices[device] = {}; }

		if (split.length == 4 && !device.startsWith('$') && !valueType.startsWith('$')) {
			devices[device][valueType] = message.toString();

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
		}
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

		if (toSend[device] !== json) {
			io.emit('device', json);
			toSend[device] = json;
		}
		else {
			//log(`Skipping duplicate for ${device}`);
		}
	}
}

/*
function rand() {
    return Math.random().toString(36).replace(/[^a-z]+/g, '').substr(0, 7);
}
*/

/*
function queueSend(device) {
	let key = rand();
	toSend[device] = key;

	//Wait a very short while to avoid repeated sends
	setTimeout(function() {
		//Only send if last update
		if (toSend[device] === key) {
			let dev = getDevice(device);
			if (Object.keys(dev).length > 0) {
				let json = JSON.stringify(dev);
				io.emit('device', json);
			}
		} else { log(`${device}: ${toSend[device]} !== ${key}`); }
	}, 200);
}
*/

const server = http.createServer((req, res) => {
	let { method, url } = req;
	if (method === 'OPTIONS') {
		res.statusCode = 204;
		res.end();
		return;
	}

	if (method === 'POST') {
		const chunks = [];
		req.on('data', chunk => chunks.push(chunk));
		req.on('end', () => {
		  const data = Buffer.concat(chunks);
		  var obj = JSON.parse(data.toString());
		  toggle(obj.name, obj.value);
		});

		res.statusCode = 204;
		res.end();
		return;
	}

	res.statusCode = 200;

	if (url.startsWith('/dashboard')) {
		let html = fs.readFileSync('./dashboard.html');
		res.end(html.toString());
		return;
	}

/*	if (url.startsWith('/scripts/') && url.endsWith('.js')) { */
	if (url.endsWith('.js')) {
		let html = fs.readFileSync(`.${url}`);
		res.setHeader('Content-Type', 'application/javascript');
		res.end(html.toString());
		return;
	}

/*	if (url.startsWith('/styles/') && url.endsWith('.css')) { */
	if (url.endsWith('.css')) {
		let html = fs.readFileSync(`.${url}`);
		res.setHeader('Content-Type', 'text/css');
		res.end(html.toString());
		return;
	}

/*
	if (url.startsWith('/toggle')) {
		var params = url.split('/');
		publish(`homie/homey/${params[2]}/onoff/set`, params[3]);
		res.setHeader('Content-Type', 'text/html');
		res.end('ok');
		return;
	}
*/

	if (url === '/api/temp') {
		res.setHeader('Content-Type', 'application/json');
		let temp = getTemperatures();
		var json = JSON.stringify(temp, null, '  ');
		res.end(json);
		return;
	}

	if (url === '/api/light') {
		res.setHeader('Content-Type', 'application/json');
		let lights = getDevice(null);
		var json = JSON.stringify(lights, null, '  ');
		res.end(json);
		return;
	}

	if (url === '/api/all') {
		res.setHeader('Content-Type', 'application/json');
		var json = JSON.stringify(devices, null, '  ');
		res.end(json);
		return;
	}

	res.setHeader('Content-Type', 'text/plain');
	res.end(method);
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

	//client.on('event', data => { log(`data: ${JSON.stringify(data)}`); });
	client.on('disconnect', () => { log(`${client.id} disconnected`); });
});
// END socket.io

// server.listen(port, hostname, () => {
// log(`Server running at http://${hostname}:${port}/`);
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

	let str = JSON.stringify(options.devices, null, '\t');
	fs.writeFileSync('mqtt.log', str);

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
