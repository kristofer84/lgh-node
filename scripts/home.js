// START socket.io
var socket;
var reconnect = false;
var raw = [];

function connect() {
	socket = io();
	appendLog('connected');
	socket.on('device.all', function(msg) {
		let obj = JSON.parse(msg);
		updateMap(obj);
		appendLog('complete state received');
	});

	socket.on('device', function(msg) {
		let obj = JSON.parse(msg);
		updateMap(obj);
		appendLog(msg);
	});
}

function appendLog(msg) {
	if (raw.length >= 40) { raw.shift(); }
	raw.push(`${getTime()} ${msg}`);
	$('#raw').html(raw.join("<br />"));
}

function disconnect() {
	socket.disconnect();
	socket = null;
	appendLog('disconnected');
}

$(window).focus(function() {
	if (reconnect) connect();
});

$(window).blur(function() {
	if (socket) disconnect();
});

// END socket.io

// START Generic helpers
Number.prototype.pad = function(size) {
    var s = String(this);
    while (s.length < (size || 2)) {s = "0" + s;}
    return s;
}

function getTime() {
	let now = new Date();
	return `${now.getHours().pad()}:${now.getMinutes().pad()}:${now.getSeconds().pad()}`;
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
	Array.prototype.forEach.call(els, function(el) { el.setAttribute("d", describeSector(0, 0, 100, 0, 90))});

	var els2 = document.getElementsByClassName("lampa-vagg");
	Array.prototype.forEach.call(els2, function(el) { el.setAttribute("d", describeSector(0, 0, 50, 0, 180))});
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

	setTimeout(function() {
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
		setTimeout(function() {
			if (updateViewFlagKey == key) updateViewFlag = true;
		}, 2000);
	}

	socket.emit('toggle', JSON.stringify(item));
}
// END Sending updates

// START Update model and view
function updateTemp(data) {
	Object.keys(data).forEach(name => {
		let tDef = $("#" + name + "-t").attr("default") ?? '';
		$("#" + name + "-t").html(tDef + Number(data[name].temperature).toFixed(1) + "&deg;")
		let hDef = $("#" + name + "-h").attr("default") ?? '';
		$("#" + name + "-h").html(hDef + Number(data[name].humidity).toFixed(0) + "%")
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
		let temp = {};
		th.forEach(name => temp[name] = model[zone][name]);

		updateTemp(temp);
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

//	get();
});

$(document).ready(function () {
	//Auto refresh
	var intervalId = 0;

	$('#cb-refresh').change(function() {
	if (this.checked) {
			connect();
			reconnect = true;
		}
		else {
			disconnect();
			reconnect = false;
		}
	});

	$('#cb-settings').change(function() {
		if (this.checked) {
			$("#cb-settings").addClass("rotate");
			$("#settings").addClass("slide");
	}
		else {
			$("#cb-settings").removeClass("rotate");
			$("#settings").removeClass("slide");
		}
	});

	$('#cb-nightmode').change(function() {
		if (this.checked) {
			$("body").addClass("nightmode");
		}
		else {
			$("body").removeClass("nightmode");
		}
	});

	$('#cb-temp').change(function() {
		if (this.checked) {
			$('.temp').removeClass("hidden");
			$('.name-blocker').removeClass("hidden");
		}
		else {
			$('.temp').addClass("hidden");
			$('.name-blocker').addClass("hidden");
		}
	});

	$('#cb-raw').change(function() {
		if (this.checked) {
			$('#raw').removeClass('removed');
			$('#raw').addClass('raw');
		}
		else {
			$('#raw').removeClass('raw');
			$('#raw').addClass('removed');
		}
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
			if (split[1] == 'true') {
				var cb = $("#" + split[0].trim());
				//alert(data);
				cb.click();
			}
		}
	});

	//Monitor checkboxes
	let checkboxes = $('input[type=checkbox]').click(e => {
		let cb = e.currentTarget;
		let d = new Date();
		d.setTime(d.getTime() + (7*24*60*60*1000)); //seconds
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
	$('#popup').addClass('popup');

	clearTimeout(popupTimer);
	clearTimeout(popupTimerInner);
	popupTimer = setTimeout(function() {
		$('#popup').removeClass('popup');
		popupTimerInner = setTimeout(function() { $('#popup').addClass('removed'); }, 1200);
	}, 300);
}
