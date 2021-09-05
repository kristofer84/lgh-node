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

function rand() {
	return Math.random().toString(36).replace(/[^a-z]+/g, '').substr(0, 7);
}

var toSend = {};

function queue(item) {
	//Set a new key for every click
	let key = rand();
	toSend[item.name] = { "value": item.value, "lastKey": key };

	//Only wait if max is checked
	let interval = $("#cb-mood").is(':checked') ? 500 : 0;

	//alert(JSON.stringify(item));
	setTimeout(function() {
		//Only send if the latest update (click)
		if (key === toSend[item.name].lastKey) send(item);
	}, interval);
}

function send(item) {
	//$('#target').html('sending..');

	$.ajax({
		url: "/toggle",
		type: "post",
		dataType: "json",
		contentType: "application/json",
		success: function (data) { },
		data: JSON.stringify(item)
	});
}

function updateTemp(data) {
	Object.keys(data).forEach(name => {
		let tDef = $("#" + name + "-t").attr("default") ?? '';
		$("#" + name + "-t").html(tDef + Number(data[name].temperature).toFixed(1) + "&deg;")
		let hDef = $("#" + name + "-h").attr("default") ?? '';
		$("#" + name + "-h").html(hDef + Number(data[name].humidity).toFixed(0) + "%")
	});
}

function updateMap(data) {
	//alert(JSON.stringify(data));
	Object.keys(data).forEach(zone => {
		let moodable = Object.keys(data[zone]).some(light => data[zone][light].mood);
		let nightable = Object.keys(data[zone]).some(light => data[zone][light].night);

		let ar = document.getElementById(zone);
		if (moodable && !ar.hasAttribute("moodable")) ar.setAttribute("moodable", "moodable");
		if (nightable && !ar.hasAttribute("nightable")) ar.setAttribute("nightable", "nightable");

		let keys = Object.keys(data[zone]);

		let value = "on";
		if (keys.every(light => !data[zone][light].onoff)) {
			value = "off";
		}
		else if (keys.every(light => data[zone][light].onoff)) {
			value = "on";
		}
		else if (moodable && keys.some(light => data[zone][light].onoff && data[zone][light].mood)) {
			value = "mood";
		}
		else if (nightable && keys.some(light => data[zone][light].onoff && data[zone][light].night)) {
			value = "night";
		}

		//Object.keys(data[zone]).forEach(light => alert(`${data[zone][light].mood}`));

		//alert(`${zone}: ${value}`);

		updateArea(ar, value);
	});
}
var skipRefresh = 0;

function get() {
	if (skipRefresh > 0) {
		skipRefresh--;
		return;
	}

	$.ajax({
		url: "/api/light",
		type: "get",
		dataType: "json",
		contentType: "application/json",
		success: function (data) {
			updateMap(data);
		},
		error: function(data) {
		//	$('#target').html('err');
		}
	});

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
}

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
	element.setAttribute("light", value);
}

$(document).ready(function () {
	$(".room").click(e => {
		skipRefresh = 2;
		let ar = e.currentTarget;
		var name = ar.id;

		let nextState = getNextState(ar);
		//alert(nextState);
		var item = {
			name: name,
			value: nextState
		};

		updateArea(ar, nextState);
		queue(item);
	});

	get();

	//setInterval(get, 5000);
});

$(document).ready(function () {
	//Auto refresh
	var intervalId = 0;

	$('#cb-refresh').change(function() {
	if (this.checked) {
			intervalId = setInterval(get, 1000);
		}
		else {
			clearInterval(intervalId);
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
		$('.temp').attr("hidden", this.checked ? "false" : "true");
		$('.name-blocker').attr("hidden", this.checked ? "false" : "true");
	});
});

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

	var els = document.getElementsByClassName("lampa-horn");
	Array.prototype.forEach.call(els, function(el) { el.setAttribute("d", describeSector(0, 0, 100, 0, 90))});

	var els2 = document.getElementsByClassName("lampa-vagg");
	Array.prototype.forEach.call(els2, function(el) { el.setAttribute("d", describeSector(0, 0, 50, 0, 180))});

	//Monitor checkboxes
	let checkboxes = $('input[type=checkbox]').click(e => {
		let cb = e.currentTarget;
		let d = new Date();
		d.setTime(d.getTime() + (7*24*60*60*1000)); //seconds
		let cookie = `${cb.id}=${cb.checked}; expires=${d.toGMTString()};path=/`;
		document.cookie = cookie;
	});
});
