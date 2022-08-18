//import Auth from './auth.js';

// START socket.io
var socket;
var reconnect = false;
var raw = [];
var socketKey;
let auth;
/*
async function init() {
	auth = new Auth();
	await auth.login();

	const myHeaders = new Headers({
		'Authorization': `Bearer ${await auth.getAccessToken()}`
	});

	fetch('/key', { headers: myHeaders, method: 'GET' });

}
*/

async function connect() {
	/*
		if (!auth) {
			await init();
		}
	*/

	//console.log(await auth.getAccessToken())
	await fetch('/refresh-key');

	if (socket) return;

	const key = await (await fetch('/key-from-cookie')).json();
	socket = io({
		auth: async (cb) => {
			cb({
				//				token: `Bearer ${await auth.getAccessToken()}`
				key
			});
		}
	});

	appendLog('connected');

	// socket.on('auth', (callback) => {
	// 	appendLog('authenticating');
	// 	callback({ socketKey: socketKey });
	// });

	socket.on('device.all', function (msg) {
		let obj = JSON.parse(msg);
		updateMap(obj);

		appendLog('authenticated, complete state received');
	});

	socket.on('device', function (msg) {
		let obj = JSON.parse(msg);
		updateMap(obj);
		appendLog(msg);
	});

	socket.on("connect_error", (err) => appendLog(err));

	socket.on('disconnect', () => appendLog('disconnected'));
}

function appendLog(msg) {
	if (raw.length >= 40) { raw.shift(); }
	raw.push(`${getTime()} ${msg}`);
	$('#raw').html(raw.join("<br />"));
}

function disconnect() {
	socket.disconnect();
	socket = null;
}

$(window).focus(function () {
	if (reconnect) connect();
});

$(window).blur(function () {
	if (socket) disconnect();
});

// END socket.io

// START Generic helpers
Number.prototype.pad = function (size) {
	var s = String(this);
	while (s.length < (size || 2)) { s = "0" + s; }
	return s;
}

function getTime() {
	let now = new Date();
	return formatDate(now);
}

function formatDate(date) {
	return `${date.getHours().pad()}:${date.getMinutes().pad()}:${date.getSeconds().pad()}`;
}

function rand() {
	return Math.random().toString(36).replace(/[^a-z]+/g, '').substr(0, 7);
}
// END Generic helpers

// START SVG helpers
function polarToCartesian(centerX, centerY, radius, angleInDegrees) {
	var angleInRadians = (angleInDegrees - 90) * Math.PI / 180.0;

	return {
		x: centerX + (radius * Math.cos(angleInRadians)),
		y: centerY + (radius * Math.sin(angleInRadians))
	};
}

function describeSector(x, y, radius, startAngle, endAngle) {

	var start = polarToCartesian(x, y, radius, endAngle);
	var end = polarToCartesian(x, y, radius, startAngle);

	var largeArcFlag = endAngle - startAngle <= 180 ? "0" : "1";

	var d = [
		"M", x, y,
		"L", start.x, start.y,
		"A", radius, radius, 0, largeArcFlag, 0, end.x, end.y,
		"Z"
	].join(" ");

	return d;
}


$(document).ready(function () {
	var els = document.getElementsByClassName("lampa-horn");
	Array.prototype.forEach.call(els, function (el) { el.setAttribute("d", describeSector(0, 0, 100, 0, 90)) });

	var els2 = document.getElementsByClassName("lampa-vagg");
	Array.prototype.forEach.call(els2, function (el) { el.setAttribute("d", describeSector(0, 0, 50, 0, 180)) });
});
// END SVG helpers

/*
var onlongtouch;
var timer;
var touchduration = 1000;

function touchstart() {
	timer = setTimeout(onlongtouch, touchduration);
}

function touchend() {
	if (timer) {
		clearTimeout(timer);
	}
}

onlongtouch = function(event) { alert(JSON.stringify(event)); }

window.addEventListener("touchstart", touchstart, false);
window.addEventListener("touchend", touchend, false);
*/

// START Sending updates
var toSend = {};

//Queues multiple event for the same zone and sends the last one
function queue(item) {
	//Only wait if max is checked
	if (!$('#cb-mood').is(':checked')) {
		send(item);
		return;
	}

	//Set a new key for every click
	let key = rand();
	toSend[item.name] = { "value": item.value, "lastKey": key };

	setTimeout(function () {
		//Only send if the latest event (click)
		if (key === toSend[item.name].lastKey) send(item);
	}, 500);
}

var updateViewFlagKey;
var updateViewFlag = true;

function send(item) {
	//If auto-refresh, disable view updates for a few seconds
	if ($('#cb-refresh').is(':checked')) {
		//To avoid overlapping updates, set a key
		let key = rand();
		updateViewFlagKey = key;

		//Toggle skipView and schdule a reset
		updateViewFlag = false;
		setTimeout(function () {
			if (updateViewFlagKey == key) updateViewFlag = true;
		}, 2000);
	}

	socket.emit('toggle', JSON.stringify(item));
}
// END Sending updates

// START Update model and view
function updateEntity(data) {
	Object.keys(data).forEach(name => {
		//if (!data[dev].hasOwnProperty('state')) return;
		if (name.endsWith('temperature')) {
			//			console.log(`temp: ${name}`);
			let tDef = $("#th-" + name).attr("default") ?? '';
			$("#th-" + name).html(tDef + Number(data[name].state).toFixed(1) + "&deg;")
		}
		else if (name === 'sensorer_alla') {
			let def = $("#info-senaste_aktivitet").attr("default") ?? '';
			let d = formatDate(new Date(data[name].lastChange))
			$("#info-senaste_aktivitet").html(def + d)
		}
		else if (name.endsWith('humidity')) {
			//			console.log(`humi: ${name}`);
			let hDef = $("#th-" + name).attr("default") ?? '';
			$("#th-" + name).html(hDef + Number(data[name].state).toFixed(0) + "%")
		}
		else if (name.endsWith('_w')) {
			//			console.log(`${name}: ${data[name].state}`);
			let en = name.split('_')[0];
			let ent = $("#" + en);
			//			console.log(ent.hasClass('active-outline'));
			if (data[name].state === true && !ent.hasClass('active-outline')) {
				ent.addClass('active-outline');
			}
			else if (data[name].state !== true && ent.hasClass('active-outline')) {
				ent.removeClass('active-outline');
			}

			//			console.log(ent.hasClass('active-outline'));
		}
		else {
			//			console.log(`wunknow: ${name}`);
		}
	});
}

var model = {};

//Update model
function updateMap(data) {
	//model = { ...model, ...data };
	Object.keys(data).forEach(zone => {
		if (model[zone] === undefined) { model[zone] = {}; }

		let keys = Object.keys(data[zone]);
		keys.forEach(device => {
			if (model[zone][device] === undefined) { model[zone][device] = {}; }
			Object.keys(data[zone][device]).forEach(valueKey => {
				model[zone][device][valueKey] = data[zone][device][valueKey];
				model[zone][device].lastChange = data[zone][device].lastChange;
			});
		});
	});

	if (updateViewFlag) updateView();
}

//Update view from model
function updateView() {
	Object.keys(model).forEach(zone => {
		let lights = Object.keys(model[zone]).filter(light => model[zone][light].hasOwnProperty('onoff'));
		let moodable = lights.some(light => model[zone][light].mood);
		let nightable = lights.some(light => model[zone][light].night);

		let ar = document.getElementById(zone);
		if (moodable && !ar.hasAttribute("moodable")) ar.setAttribute("moodable", "moodable");
		if (nightable && !ar.hasAttribute("nightable")) ar.setAttribute("nightable", "nightable");

		let value = "on";
		if (lights.every(light => !model[zone][light].onoff)) {
			value = "off";
		}
		else if (lights.every(light => model[zone][light].onoff)) {
			value = "on";
		}
		else if (moodable && lights.some(light => model[zone][light].onoff && model[zone][light].mood)) {
			value = "mood";
		}
		else if (nightable && lights.some(light => model[zone][light].onoff && model[zone][light].night)) {
			value = "night";
		}

		updateArea(ar, value);

		let th = Object.keys(model[zone]).filter(th => !model[zone][th].hasOwnProperty('onoff'));
		let entities = {};
		th.forEach(name => entities[name] = model[zone][name]);

		updateEntity(entities);
	});
}

/*
function get() {
	$.ajax({
		url: "/api/temp",
		type: "get",
		dataType: "json",
		contentType: "application/json",
		success: function (data) {
			updateTemp(data);
		},
		error: function(data) {
		//	$('#target').html('err');
		}
	});
}*/

function getNextState(element) {
	var current = element.getAttribute("light");
	var moodable = element.getAttribute("moodable");
	var nightable = element.getAttribute("nightable");
	var allowMax = $("#cb-mood").is(':checked');

	switch (current) {
		case "on":
			return "off";
		case "off":
			if (nightable) return "night";
			if (moodable) return "mood";
			return "on";
		case "mood":
			return allowMax ? "on" : "off";
		case "night":
			if (moodable) return "mood";
			return allowMax ? "on" : "off";
	}
}

function updateArea(element, value) {
	if (element) element.setAttribute("light", value);
}

// END Update model and view

// START Buttons
$(document).ready(function () {
	$(".room").click(e => {
		let ar = e.currentTarget;
		var name = ar.id;

		let nextState = getNextState(ar);
		var item = {
			name: name,
			value: nextState
		};

		updateArea(ar, nextState);
		queue(item);
	});
});


function ensureState(cb) {
	var state = cb.is(':checked')
	let hasClass;
	switch (cb.prop('id')) {
		case 'cb-refresh':
			if (state && !socket) {
				connect();
				reconnect = true;
			}
			else if (!state && socket) {
				disconnect();
				reconnect = false;
			}
			break;

		case 'cb-settings':
			hasClass = $("#cb-settings").hasClass("rotate");
			if (state && !hasClass) {
				$("#cb-settings").addClass("rotate");
				$("#settings").addClass("slide");
			}
			else if (!state && hasClass) {
				$("#cb-settings").removeClass("rotate");
				$("#settings").removeClass("slide");
			}
			break;

		case 'cb-nightmode':
			hasClass = $('body').hasClass('nightmode');
			if (state && !hasClass) {
				$("body").addClass("nightmode");
				var metaThemeColor = document.querySelector("meta[name=theme-color]");
				metaThemeColor.setAttribute("content", "#222");
			}
			else if (!state && hasClass) {
				$("body").removeClass("nightmode");
				var metaThemeColor = document.querySelector("meta[name=theme-color]");
				metaThemeColor.setAttribute("content", "#eee");
			}
			break;

		case 'cb-temp':
			hasClass = $('.temp').hasClass('hidden');
			if (state && hasClass) {
				$('.temp').removeClass("hidden");
				$('.name-blocker').removeClass("hidden");
			}
			else if (!state && !hasClass) {
				$('.temp').addClass("hidden");
				$('.name-blocker').addClass("hidden");
			}
			break;

		case 'cb-raw':
			hasClass = $('#raw').hasClass('display');
			if (state && !hasClass) {
				$('#raw').removeClass('removed');
				$('#raw-bg').removeClass('removed');
				setTimeout(function () {
					$('#raw').addClass('display');
					$('#raw-bg').addClass('display');
				}, 20);
			}
			else if (!state && hasClass) {
				$('#raw').removeClass('display');
				$('#raw-bg').removeClass('display');
				setTimeout(function () {
					$('#raw').addClass('removed');
					$('#raw-bg').addClass('removed');
				}, 500);
			}
			break;

		case 'cb-devi':
			hasClass = $('.device').hasClass('hidden');
			if (state && hasClass) {
				$('.device').removeClass("hidden");
			}
			else if (!state && !hasClass) {
				$('.device').addClass("hidden");
			}
			break;
	}
}


$(document).ready(function () {
	$('input[type=checkbox]').change(e => {
		let cb = $('#' + e.currentTarget.id);
		ensureState(cb);
	});

	$('#raw-bg').click(e => {
		let cb = $('#cb-raw');
		cb.click();
	});
});


// END Buttons

//START Cookies
$(document).ready(function () {
	//Set checkboxes from cookie
	let cookieData = decodeURIComponent(document.cookie).split(';');
	cookieData.forEach(data => {
		if (data.includes('=')) {
			let split = data.split('=');
			if (split[0].trim() === 'socketKey') {
				socketKey = split[1];
			}

			var cb = $("#" + split[0].trim());
			if (cb !== undefined) {
				cb.prop('checked', split[1] == 'true' ? 'checked' : undefined);
				ensureState(cb);
			}
		}
	});

	//Monitor checkboxes
	let checkboxes = $('input[type=checkbox]').click(e => {
		let cb = e.currentTarget;
		let d = new Date();
		d.setTime(d.getTime() + (7 * 24 * 60 * 60 * 1000)); //seconds
		let cookie = `${cb.id}=${cb.checked}; expires=${d.toGMTString()};path=/`;
		document.cookie = cookie;
		if (cb.id === 'cb-refresh' || cb.id === 'cb-mood') {
			popup(cb);
		}
	});
});

// END Cookies

//Message on click
var popupTimer;
var popupTimerInner;
function popup(cb) {
	let name = cb.getAttribute('name');
	let message = `${name}: ${cb.checked ? 'on' : 'off'}`;
	$('#popup').text(message);
	$('#popup').removeClass('removed');
	$('#popup').addClass('display');

	clearTimeout(popupTimer);
	clearTimeout(popupTimerInner);
	popupTimer = setTimeout(function () {
		$('#popup').removeClass('display');
		popupTimerInner = setTimeout(function () { $('#popup').addClass('removed'); }, 1200);
	}, 300);
}
