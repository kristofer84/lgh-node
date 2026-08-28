//The light-settings page: pick a room, tick which lights each step turns on, and
//give a percentage where the hardware can take one.
//
//It edits `steps` and nothing else. Which devices are in a zone, their order and
//the sensor entries are all left alone -- order in particular is load-bearing,
//because the floorplan generator uses it to place a lamp that has no position of
//its own yet.
//
//No imports from zones.js on purpose: this page needs none of the step
//semantics, only the table. The server hands it exactly what it renders.

const STEPS = [
	{ key: 'night', label: 'Natt' },
	{ key: 'mood', label: 'Dämpat' },
	{ key: 'on', label: 'På' },
];

/** @type {Record<string, Array<{device: string, type: string, steps: object, dimmable: boolean, name?: string}>>} */
let zones = {};
/** The edits made since the last save, as {zone: {device: steps}}. */
let dirty = {};

const $ = id => /** @type {HTMLElement} */ (document.getElementById(id));
/** getElementById hands back a plain HTMLElement; these say which kind it is. */
const $btn = id => /** @type {HTMLButtonElement} */ (document.getElementById(id));
const $sel = id => /** @type {HTMLSelectElement} */ (document.getElementById(id));
/** @returns {HTMLInputElement | null} */
const field = (root, sel) => /** @type {HTMLInputElement | null} */ (root.querySelector(sel));

function setStatus(text, kind) {
	const el = $('status');
	el.textContent = text ?? '';
	el.className = kind ?? '';
}

//A tick means: on. For a dimmable device that is a percentage -- always a
//number, never `true`. That is deliberate rather than cosmetic: a plain turn_on
//restores whatever level the lamp last had, so a dimmable light left as `true`
//at the `on` step would come back at whatever the dimmed step set it to.
function readRow(tr) {
	const steps = {};
	for (const { key } of STEPS) {
		const box = field(tr, `input[type=checkbox][data-step="${key}"]`);
		if (!box?.checked) continue;
		const pct = field(tr, `input[type=number][data-step="${key}"]`);
		steps[key] = pct ? clampPct(pct.value) : true;
	}
	return steps;
}

function clampPct(v) {
	const n = Math.round(Number(v));
	if (!Number.isFinite(n)) return 100;
	return Math.min(100, Math.max(1, n));
}

function markDirty(zone, device, tr) {
	dirty[zone] ??= {};
	dirty[zone][device] = readRow(tr);
	$btn('save').disabled = false;
	setStatus('Osparade ändringar', 'warn');
}

function buildRow(zone, row) {
	const tr = document.createElement('tr');

	const name = document.createElement('td');
	name.className = 'light';
	name.textContent = row.name ?? row.device;
	//The entity name is what db/config.json and the MQTT topics use, so it is
	//worth showing even when a friendly name exists.
	const id = document.createElement('span');
	id.className = 'id';
	id.textContent = `${row.type}.${row.device}`;
	name.append(document.createElement('br'), id);
	tr.append(name);

	for (const { key } of STEPS) {
		const td = document.createElement('td');
		const value = row.steps?.[key];

		const box = document.createElement('input');
		box.type = 'checkbox';
		box.dataset.step = key;
		box.checked = value !== undefined;
		box.setAttribute('aria-label', `${row.name ?? row.device} ${key}`);
		td.append(box);

		if (row.dimmable) {
			const pct = document.createElement('input');
			pct.type = 'number';
			pct.dataset.step = key;
			pct.min = '1';
			pct.max = '100';
			pct.step = '1';
			pct.value = String(typeof value === 'number' ? value : 100);
			pct.disabled = !box.checked;
			pct.setAttribute('aria-label', `${row.name ?? row.device} ${key} procent`);
			pct.addEventListener('change', () => {
				pct.value = String(clampPct(pct.value));
				markDirty(zone, row.device, tr);
			});
			td.append(pct, Object.assign(document.createElement('span'), { className: 'pct', textContent: '%' }));
			box.addEventListener('change', () => { pct.disabled = !box.checked; });
		}

		box.addEventListener('change', () => markDirty(zone, row.device, tr));
		tr.append(td);
	}

	return tr;
}

function renderZone(zone) {
	const body = $('rows');
	body.textContent = '';
	for (const row of zones[zone] ?? []) body.append(buildRow(zone, row));
	$('grid').hidden = false;
}

async function save() {
	if (!Object.keys(dirty).length) return;
	$btn('save').disabled = true;
	setStatus('Sparar…');
	try {
		const res = await fetch('/config/zones', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(dirty),
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

		//Re-read rather than trusting the local copy: the server is what decides
		//what was actually stored.
		dirty = {};
		await load($sel('zone').value);
		setStatus(`Sparat (${data.changed?.length ?? 0} lampor)`, 'ok');
	} catch (err) {
		setStatus(`Kunde inte spara: ${err.message}`, 'error');
		$btn('save').disabled = false;
	}
}

async function load(keepZone) {
	const res = await fetch('/config/zones');
	if (!res.ok) {
		$('loading').textContent = res.status === 401
			? 'Inte inloggad — öppna planritningen först.'
			: `Kunde inte hämta inställningar (HTTP ${res.status}).`;
		return;
	}
	zones = await res.json();

	const select = $sel('zone');
	select.textContent = '';
	for (const zone of Object.keys(zones)) {
		const opt = document.createElement('option');
		opt.value = zone;
		opt.textContent = zone;
		select.append(opt);
	}
	if (keepZone && zones[keepZone]) select.value = keepZone;

	$('loading').hidden = true;
	renderZone(select.value);
}

$sel('zone').addEventListener('change', e => renderZone(/** @type {HTMLSelectElement} */ (e.target).value));
$btn('save').addEventListener('click', save);
//An unsaved change is easy to walk away from on a phone.
window.addEventListener('beforeunload', e => {
	if (Object.keys(dirty).length) e.preventDefault();
});

load();
