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
			console.log('connected');
		}
		else {
			console.log(err);
		}
	});
});

//var devices = {};

var devices;
var config;

function init() {
	let buffer = fs.readFileSync('mqtt.log');
	let json = buffer.toString();
	devices = JSON.parse(json);

	let buffer2 = fs.readFileSync('config.json');
	config = JSON.parse(buffer2.toString());
}

init();

var configValues = 0;
var values = 0;
var messages = 0;
var requests = 0;

client.on('message', function (topic, message) {
	let split = topic.split('/');
	messages++;
	if (split[1] === 'homey') {

		let device = split[2];
		let valueType = split[3];

		if (devices[device] === undefined) { devices[device] = {}; }


		if (split.length >= 5 || device.startsWith('$') || valueType.startsWith('$')) {
				configValues++;
		}
		else {
			values++;
			devices[device][valueType] = message.toString();
		}
	}

	fs.appendFile('mqtt-raw.log', `${topic}: ${message.toString()}\n`, function(err) {
		if (err) console.log(err);
	});;
});

const server = http.createServer((req, res) => {
	requests++;

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

	if (url.startsWith('/toggle')) {
		var params = url.split('/');
		publish(`homie/homey/${params[2]}/onoff/set`, params[3]);
		res.setHeader('Content-Type', 'text/html');
		res.end('ok');
		return;
	}

	if (url === '/temp') {
		res.setHeader('Content-Type', 'application/json');
		let temp = getTemperatures();
		var json = JSON.stringify(temp, null, '  ');
		res.end(json);
		return;
	}

	if (url === '/light') {
		res.setHeader('Content-Type', 'application/json');
		let lights = getLights();
		var json = JSON.stringify(lights, null, '  ');
		res.end(json);
		return;
	}

	if (url === '/all') {
		res.setHeader('Content-Type', 'application/json');
		var json = JSON.stringify(devices, null, '  ');
		res.end(json);
		return;
	}

	res.setHeader('Content-Type', 'text/plain');
	res.end(method);
});

// server.listen(port, hostname, () => {
// console.log(`Server running at http://${hostname}:${port}/`);
server.listen(port, () => {
	console.log(`Server running at port ${port}`);
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

function getLights() {
	let retObj = {}

	Object.keys(config.zones).forEach(zone => {
		zoneDevices = {};
		let values = config.zones[zone];

		values.forEach(light => {
			let split = light.split('.');
			let device = devices[split[0]];
			let onoff = undefined;
			let dim = undefined;
			let mood = (split.length > 1 && split[1] === 'mood') ? true : undefined;
			let night = (split.length > 1 && split[1] === 'night') ? true : undefined;
			if (device != undefined) {
				onoff = device['onoff'];
				dim = device['dim'];
			}
			zoneDevices[split[0]] = { onoff: (onoff === 'true'), mood: mood, night: night, dim: dim };
		});
		retObj[zone] = zoneDevices;
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
		console.log(`Exiting: ${exitCode}`);
		process.exit();
	}
}

function toggle(zone, value) {
	if (config.zones[zone] === undefined) {
		console.log(`Missing zone: ${zone}`);
		return;
	}

	if (value === "night") {
		config.zones[zone].forEach(device => {
			var split = device.split('.');
			var toState = (split.length > 1 && split[1] === 'night');
			publish(split[0], 'onoff', toState);
		});
	}
	else if (value === "mood") {
		config.zones[zone].forEach(device => {
			var split = device.split('.');
			var toState = (split.length > 1); //Night && mood
			publish(split[0], 'onoff', toState);
		});
	}
	else {
		config.zones[zone].forEach(device => publish(device.split('.')[0], 'onoff', value));
	}
}

function publish(device, property, message) {
	console.log(`homie/homey/${device}/${property}/set: ${message.toString()}`);
	if (message === undefined) return;
	var topic = `homie/homey/${device}/${property}/set`;
	client.publish(topic, message.toString());
}

process.on('exit', exitHandler.bind(null, { devices: devices }));
process.on('SIGINT', exitHandler.bind(null, { devices: devices, exit: true }));
process.on('SIGINT1', exitHandler.bind(null, { devices: devices, exit: true }));
process.on('SIGINT2', exitHandler.bind(null, { devices: devices, exit: true }));
process.on('uncaughtException', exitHandler.bind(null, { devices: devices, exit: true }));
