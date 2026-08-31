//The step semantics live in zones.js, the same file the server and the
//floorplan builder import, so all three cannot drift apart.
import { stepOf, nextStep } from './zones.js';

//import Auth from './auth.js';

// START socket.io
var socket;
var stayOn = false;
var raw = [];
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

	//The handshake is same-origin, so the browser sends the session cookie by
	//itself and the server validates it there. Nothing needs to read the key
	//into JavaScript any more (that used to defeat the httpOnly flag).
	socket = io();

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

//The panel used to be `raw.join('<br />')` of whole JSON payloads, which is how
//a single washing-machine reading became three wrapped lines of
//{"devices":{"tvattmaskin_electric_consumption_w":{"state":false,"lastChange":
//1788161322722}}}. The payload shape is always {zone: {device: {fields}}}, so it
//is split into columns instead, and the full JSON is kept on the row's `title`
//for when the detail is actually wanted.
const RAW_MAX = 300;

//`steps` and `dimmable` are config, not news, and `lastChange` only repeats the
//timestamp already in the first column. What is left is the state itself.
function summarise(d) {
	const bits = [];
	if (d !== null && typeof d === 'object') {
		let lit;
		if (Object.hasOwn(d, 'state')) {
			const v = d.state;
			lit = v === true || v === 'on';
			bits.push(v === true ? 'on' : v === false ? 'off' : String(v));
		}
		else if (Object.hasOwn(d, 'onoff')) {
			lit = !!d.onoff;
			bits.push(lit ? 'on' : 'off');
		}

		//`dim` is raw 0-255 off the wire; a percentage is what the config and the
		//rest of the UI speak. Only shown when the lamp is actually lit: a dimmer
		//keeps reporting its last level after being switched off (that is what
		//Z-Wave targetValue 255 restores), and "off 100%" reads as a fault.
		const n = Number(d.dim);
		if (lit && Object.hasOwn(d, 'dim') && Number.isFinite(n)) bits.push(`${Math.round(n / 255 * 100)}%`);
	}
	return bits.join(' ') || '-';
}

/** @param {unknown} msg @returns {Array<{device: string, value: string, title: string, note?: boolean}>} */
function parseLog(msg) {
	if (typeof msg !== 'string') {
		//connect_error hands us an Error, whose String() is "[object Object]"
		//unless the message is pulled out.
		const e = /** @type {any} */ (msg);
		return [{ device: String(e?.message ?? e), value: '', title: '', note: true }];
	}
	if (!msg.startsWith('{')) return [{ device: msg, value: '', title: '', note: true }];
	try {
		const obj = JSON.parse(msg);
		const rows = [];
		for (const [zone, devices] of Object.entries(obj)) {
			for (const [device, d] of Object.entries(devices ?? {})) {
				rows.push({ device: `${zone} / ${device}`, value: summarise(d), title: JSON.stringify(d) });
			}
		}
		return rows.length ? rows : [{ device: msg, value: '', title: '', note: true }];
	} catch {
		return [{ device: msg, value: '', title: '', note: true }];
	}
}

function appendLog(msg) {
	for (const row of parseLog(msg)) {
		const last = raw[raw.length - 1];
		//Collapse a run of identical messages instead of scrolling the useful ones
		//off the top.
		if (last && last.device === row.device && last.value === row.value) {
			last.n++;
			last.time = getTime();
		}
		else {
			raw.push({ ...row, time: getTime(), n: 1 });
			if (raw.length > RAW_MAX) raw.shift();
		}
	}
	renderLog();
}

function renderLog() {
	const body = document.getElementById('raw-body');
	if (!body) return;

	//Stick to the bottom only if the reader is already there; otherwise leave
	//their scroll position alone while they are reading back.
	const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;

	body.textContent = '';
	if (!raw.length) {
		const empty = document.createElement('div');
		empty.className = 'raw-empty';
		empty.textContent = 'Inga meddelanden än.';
		body.append(empty);
	}
	for (const e of raw) {
		const row = document.createElement('div');
		row.className = e.note ? 'raw-row raw-note' : 'raw-row';
		if (e.title) row.title = e.title;
		//textContent, not innerHTML: these strings come off the wire.
		row.append(
			Object.assign(document.createElement('span'), { className: 'raw-t', textContent: e.time }),
			Object.assign(document.createElement('span'), { className: 'raw-d', textContent: e.device }),
			Object.assign(document.createElement('span'), { className: 'raw-v', textContent: e.value }),
			Object.assign(document.createElement('span'), { className: 'raw-n', textContent: e.n > 1 ? `x${e.n}` : '' }),
		);
		body.append(row);
	}

	const count = document.getElementById('raw-count');
	if (count) count.textContent = raw.length ? `${raw.length} rader` : '';
	if (atBottom) body.scrollTop = body.scrollHeight;
}

function disconnect() {
	socket.disconnect();
	socket = null;
}

$(window).focus(function () {
	connect();
	if (stayOn) lock();
});

$(window).blur(function () {
	if (socket) disconnect();
	unlock();
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
	//Hold the optimistic render for 2s. Publishing a step is not one MQTT
	//message: HA echoes each lamp back as it reaches its new level, so a room
	//briefly reports the step it is *leaving* and the view snaps back before it
	//settles. Suppressing incoming updates for that window hides the flicker.
	//
	//This used to be gated on #cb-lock, the screen wake lock, standing in for
	//"this is the wall panel". The race is not specific to that screen -- a
	//phone saw the flicker the panel was protected from -- and the coupling was
	//not guessable from either name. Unconditional now; #cb-lock only locks.
	//
	//The key is what makes overlapping sends safe: each one takes the flag down
	//and only the newest is allowed to put it back up, so a second tap during
	//the window extends it instead of ending it early.
	let key = rand();
	updateViewFlagKey = key;
	updateViewFlag = false;
	setTimeout(function () {
		if (updateViewFlagKey == key) updateViewFlag = true;
	}, 2000);

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
		//Which step this zone is displaying, and whether it has the lamps to
		//offer a mood/night step at all. Shared with the server, which uses the
		//inverse (sceneFor) to decide what a step publishes.
		const { step: value, moodable, nightable, lights } = stepOf(model[zone]);

		let ar = document.getElementById(zone);
		//Zones without a room drawn for them (home, utomhus, moja, devices) are
		//normal. This used to be unguarded, so any such zone containing a
		//mood/night light threw and aborted the render for every later zone.
		if (!ar) return;
		if (moodable && !ar.hasAttribute("moodable")) ar.setAttribute("moodable", "moodable");
		if (nightable && !ar.hasAttribute("nightable")) ar.setAttribute("nightable", "nightable");

		updateArea(ar, value);

		//Per-lamp state, straight from the model. getNextStateItem falls back to
		//reading the element's computed opacity when there is no state attribute,
		//and that told it nothing once the light symbols became always-visible.
		//It also means a symbol shows whether its own lamp is on, rather than
		//only reflecting the room's mood/night tier.
		lights.forEach(light => setItemState(light, model[zone][light].onoff ? "on" : "off"));

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

function getNextStateRoom(element) {
	return nextStep(element.getAttribute("light"), {
		moodable: element.getAttribute("moodable"),
		nightable: element.getAttribute("nightable"),
		//The "Max brightness" checkbox, the sun icon. Without it a room never
		//reaches the `on` step.
		allowMax: $("#cb-mood").is(':checked'),
	});
}

function getNextStateItem(element) {
	var current = element.getAttribute("state");

	switch (current) {
		case "on":
			return "off";
		case "off":
			return "on";
	}

	//Fallback for an element with no `state` attribute yet. getPropertyValue
	//returns a string, so this was `opacity == 0` -- loose equality, which does
	//coerce and does work. Number() says the same thing without the coercion.
	const cssObj = window.getComputedStyle(element, null);
	let opacity = cssObj.getPropertyValue("opacity");
	return Number(opacity) === 0 ? 'on' : 'off';
}

function updateArea(element, value) {
	element?.setAttribute("light", value);
	//Mirror it onto the zone's lamp group. The lamps live in the #lights layer,
	//not inside the room group, so this attribute is the only way style.css can
	//say anything about "the lamps of a room in state X" -- it is what lets the
	//`on` step drop the individual glows. Doing it here rather than in
	//updateView() means the optimistic update on a room press gets it too.
	if (element?.id) {
		document.getElementById("lights-" + element.id)?.setAttribute("light", value);
		document.getElementById("glows-" + element.id)?.setAttribute("light", value);
	}
}

//A lamp is TWO elements now: its glow in the zone's `glows-` layer and its
//symbol in the `lights-` layer, so that no glow can be painted over a
//neighbour's symbol. Both wrappers carry `state`, because the CSS reaches the
//glow and the point through the same [state=...] descendant selectors.
function updateItem(element, value) {
	element?.setAttribute("state", value);
	if (element?.id) document.getElementById("glow-" + element.id)?.setAttribute("state", value);
}

/** @param {string} id @param {string} value */
function setItemState(id, value) {
	document.getElementById(id)?.setAttribute("state", value);
	document.getElementById("glow-" + id)?.setAttribute("state", value);
}

/** @param {string} id */
function clearItemState(id) {
	document.getElementById(id)?.removeAttribute("state");
	document.getElementById("glow-" + id)?.removeAttribute("state");
}

// END Update model and view

// START Buttons
$(document).ready(function () {
	$(".room").click(e => {
		let ar = e.currentTarget;
		var name = ar.id;
		let nextState = getNextStateRoom(ar);

		//The lamps are drawn in their own layer above the plan, so they are no
		//longer descendants of the room group and $(ar).find() no longer reaches
		//them. Clear this zone's lamps by name instead, so the room-level render
		//takes over until the server echoes the change back.
		Object.keys(model[name] ?? {}).forEach(clearItemState);

		var item = {
			type: 'room',
			name: name,
			value: nextState
		};

		updateArea(ar, nextState);
		queue(item);
	});
});

$(document).ready(function () {
	$(".item").click(e => {
		e.stopPropagation();
		let ar = e.currentTarget;
		var name = ar.id;
		let nextState = getNextStateItem(ar);

		var item = {
			type: 'item',
			name: name,
			value: nextState
		};

		updateItem(ar, nextState);
		queue(item);
	});
});


function ensureState(cb) {
	var state = cb.is(':checked')
	let hasClass;
	switch (cb.prop('id')) {
		case 'cb-lock':
			if (state) {
				stayOn = true;
				lock();
			}
			else if (!state) {
				stayOn = false;
				unlock();
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
			}
			else if (!state && !hasClass) {
				$('.temp').addClass("hidden");
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

	//`.click()` on the checkbox is what the backdrop already uses: it flips the
	//box, fires the change handler and writes the cookie, so closing from the
	//header behaves identically to closing from anywhere else.
	$('#raw-close').click(() => $('#cb-raw').click());
	$('#raw-clear').click(() => { raw.length = 0; renderLog(); });
});


// END Buttons

//START Cookies
$(document).ready(function () {
	//Set checkboxes from cookie
	let cookieData = decodeURIComponent(document.cookie).split(';');
	cookieData.forEach(data => {
		if (data.includes('=')) {
			let split = data.split('=');
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
		d.setTime(d.getTime() + (365 * 24 * 60 * 60 * 1000)); //seconds
		let cookie = `${cb.id}=${cb.checked}; expires=${d.toGMTString()};path=/`;
		document.cookie = cookie;
		if (cb.id === 'cb-lock' || cb.id === 'cb-mood') {
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

// Create a reference for the Wake Lock.
let wakeLock = null;

async function lock() {
	if (!navigator.wakeLock) return;
	// create an async function to request a wake lock
	try {
		wakeLock = await navigator.wakeLock.request("screen");
		//	  statusElem.textContent = "Wake Lock is active!";
	} catch (err) {
		// The Wake Lock request has failed - usually system related, such 
		// as battery.
		console.log(`${err.name}, ${err.message}`);
		//	  statusElem.textContent = `${err.name}, ${err.message}`;
	}
}

function unlock() {
	if (!wakeLock) return;
	wakeLock.release().then(() => { wakeLock = null; });
}

// const push = document.getElementById('push')
// push.addEventListener("click", async () => {
// 	await fetch('/push');
// 	alert('Push sent')
// });

connect();