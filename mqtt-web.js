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
let buffer = fs.readFileSync('mqtt.log');
let json = buffer.toString();
var devices = JSON.parse(json);

let buffer2 = fs.readFileSync('config.json');
var config = JSON.parse(buffer2.toString());

var raw = [];

var configValues = 0;
var values = 0;
var messages = 0;
var requests = 0;

client.on('message', function (topic, message) {
	let split = topic.split('/');
	messages++;
	if (split[1] === 'homey') {

		//		let deviceType = split[2];
		//		let deviceZone = split[3];
		//		let device = split[4];
		//		let valueType = split[5];

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
		//devices[device][valueType] = message.toString();

		//if (deviceType != undefined) { devices[device]['$type'] = deviceType; }
		//if (deviceZone != undefined) { devices[device]['$zone'] = deviceZone; }
	}

	log();

	raw.push(`${topic}: ${message.toString()}`);
	if (raw.length >= 100) { raw.shift(); }
	//console.log(`${topic}: ${message.toString()}`);
});

function log() {
	//console.clear();
	console.log(`Received messages (config/values): ${messages} (${configValues}/${values})`);
	console.log(`Received web requests: ${requests}`);
}

const server = http.createServer((req, res) => {
	requests++;
	log();

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
//		  publish(obj.name, 'onoff', obj.value);
		});

		res.statusCode = 204;
		res.end();
		return;
	}

	res.statusCode = 200;

	if (url.startsWith('/dev')) {
		let html = fs.readFileSync('./dev.html');
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

	if (url === '/temp?h=1') {
		res.setHeader('Content-Type', 'text/html');
		let temp = getTemperatures();
		let sorted = Object.keys(temp).sort();
		var html = `<html><body><table>`;

		Object.values(sorted).forEach(key => {
			html += `<tr><td>`;
			html += key;
			html += `<td><td>`;
			html += temp[key];
			html += `</td></tr>`;
		});

		html += `</table></body></html>`;
		res.end(html);
		return;
	}

	if (url === '/temp') {
		res.setHeader('Content-Type', 'application/json');
		let temp = getTemperatures();
		var json = JSON.stringify(temp, null, '  ');
		res.end(json);
		return;
	}

	if (url === '/raw') {
		res.setHeader('Content-Type', 'application/json');
		var json = JSON.stringify(raw, null, '  ');
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


	//res.setHeader('Content-Type', 'application/json');
	//res.end(JSON.stringify(req, null, '\t'));
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
				let name = device['$name'];
				retObj[name] = device[valueKey];
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
			let device =  devices[light];
			let onoff = undefined;
			let hue = undefined;
			if (device != undefined) {
				onoff = device['onoff'];
				dim = device['dim'];
			}
			zoneDevices[light] = { onoff: (onoff === 'true'), dim: dim, hue: hue };
		});
		retObj[zone] = zoneDevices;
	});

	return retObj;
}

//Save all on exit
function exitHandler(options, exitCode) {
	//Close MQTT
	client.end();

	let rawstr = JSON.stringify(options.raw, null, '\t');
	fs.writeFileSync('mqtt-raw.log', rawstr);

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
	config.zones[zone].forEach(device => publish(device, 'onoff', value));
}

function publish(device, property, message) {
	var topic = `homie/homey/${device}/${property}/set`;
	client.publish(topic, message.toString());
}

process.on('exit', exitHandler.bind(null, { devices: devices, raw: raw }));
process.on('SIGINT', exitHandler.bind(null, { devices: devices, raw: raw, exit: true }));
process.on('SIGINT1', exitHandler.bind(null, { devices: devices, raw: raw, exit: true }));
process.on('SIGINT2', exitHandler.bind(null, { devices: devices, raw: raw, exit: true }));
process.on('uncaughtException', exitHandler.bind(null, { devices: devices, raw: raw, exit: true }));
