# MQTT, devices and the socket.io contract

> Read before touching MQTT ingest, `db/config.json`, `getDevice()` or the dashboard's data
> contract. All of it lives in `mqtt-web.js`.
>
> **Verified 2026-08-25 against the working tree** — commit `eb19c0d` plus the uncommitted
> auth-hardening pass. Only §6 (socket auth) and §7 (signals) were touched by that pass; the
> MQTT and device model are unchanged.

## 1. The MQTT client

`connect(config.config.mqttAddress)` (`mqtt-web.js` 66) — currently `mqtt://127.0.0.1`, i.e. the
Home Assistant broker on the same host. Plain MQTT, no TLS, no credentials.

On connect the app subscribes to **`#`** — *every topic on the broker* — and filters in the
message handler. There is no topic-level filtering; a busy broker means every message crosses
the handler.

## 2. Inbound topic convention

```
homeassistant/<deviceType>/<device>/<valueType>
      split[0]     split[1]   split[2]   split[3]
```

A message is processed only if **all** of:

- `split[0] === 'homeassistant'`
- `split[3]` ∈ `['state', 'current_temperature', 'current_humidity', 'current_pressure']`
- the payload is not `unavailable` and not `unknown`

Everything else is dropped (and `lgMqtt()` — the per-message logger — has its body commented
out in `log.js`, so dropped messages leave no trace).

### Two things happen to a matching message

**(a) A generic nested write.** `values = split.slice(2)` is reduced into `devices`, creating
`devices[<device>][<valueType>] = payload`. This happens for *every* matching message, whether or
not the device is known to `db/config.json`.

**(b) A typed update, only for devices that have a `zone`** (i.e. that appear in
`db/config.json`):

| `deviceType` | What is written |
|---|---|
| `light`, `switch` | `devices[d].onoff = payload === 'on' ? 'true' : 'false'` — **the string `'true'`/`'false'`, not a boolean** |
| anything else, zone `devices` | `devices[d].state = parseFloat(payload) > 2.5` — a **boolean**. "A device is on if it draws more than 2.5 W." |
| anything else, other zones | `devices[d].state = payload` — the raw string |

Then `devices[d].lastChange = Date.now()` and `queueSend(device)`.

⚠ **`climate` topics are remapped**: for `deviceType === 'climate'` the handler shifts two
segments and rebuilds `device` as `split.join('_').replace('current_', '')` — so
`homeassistant/climate/sovrum_mk/current_temperature` becomes device `sovrum_mk_temperature`.
That is why the config lists `sovrum_mk_temperature.sensor` and not a `climate` entry. This
remap happens *after* (a), so the generic nested write lands under the **un-remapped** name and
leaves stray sub-objects in `devices` (visible in `log/mqtt.log`).

## 3. Outbound topic convention

`publish(device, property, message)` (line 695) sends to:

```
webapp/switch/<type>.<device>/<property>/set
```

e.g. `webapp/switch/light.kok_tak/state/set` with payload `on`. Note this is a **different
namespace from the inbound `homeassistant/…` tree** — something on the Home Assistant side
bridges `webapp/switch/...` back into actual device commands. That bridge is not in this repo.

`property` is always `'state'` in current code; `message` is `on` / `off`. `publish()` returns
early if `message` is `undefined`.

## 4. `db/config.json` (gitignored — not in the repo)

```jsonc
{
  "config": {
    "mqttAddress": "mqtt://127.0.0.1",
    "certFolder": "/etc/letsencrypt/live/home.xcds.net/"   // unused; TLS is nginx's job now
  },
  "defaults": { "hsv": { "h": 0, "s": 0, "v": 100 } },      // read by nothing
  "zones": {
    "<zone>": [ "<device>.<type>[.<flag>]", … ]
  }
}
```

### The device string

`"<device>.<type>[.<flag>]"`, split on `.`:

- `[0]` **device** — must match `split[2]` of the MQTT topic (post-`climate` remap).
- `[1]` **type** — `light`, `switch`, `sensor`, `occupancy`. Drives both the ingest branch and
  `getDevice()`'s output shape.
- `[2]` **flag** (optional) — `mood` or `night`. Sets `devices[d].mood = true` /
  `devices[d].night = true` at init, and is what makes a room's click cycle include those steps.

Examples from the live config:
`"sang_hoger.switch.mood"`, `"sovrum_tak.light"`, `"garderob_temperature.sensor"`,
`"sensorer_alla.occupancy"`, `"kylskap_electric_consumption_w.sensor"`.

### Zones

Zone names are the dashboard's SVG group ids (`<g class="room" id="sovrum">`), so a zone rename
must be mirrored in `web/dashboard.html`. `updateView()` swallows a missing element with `?.`,
so a mismatch fails silently. The same applies to individual devices: a `class="item"` element's
`id` must match the device name in the config.

⚠ **There is a live mismatch right now** (an uncommitted `web/dashboard.html` edit that predates
the auth-hardening pass): the SVG now says `sovrum_1_byra`, `sovrum_3_hoger` and
`sovrum_3_vanster`, while `db/config.json` still lists `sovrum_byra.light.mood`,
`kontor_hoger.light.mood` and `kontor_vanster.light.mood`. `toggleItem()` matches on the config
name, so **those three items are currently dead clicks**. Either side can move — ask the operator
which.

The zone **`devices`** is special: everything in it is treated as a power meter and its `state`
becomes the boolean `> 2.5 W` (see §2b). The zone **`home`** holds the single `occupancy` sensor
that drives the "senaste aktivitet" readout.

`init()` (line 32) walks `config.zones` at startup and stamps `zone`, `type`, `mood`, `night`
onto each `devices[<device>]` entry, creating the entry if `log/mqtt.log` did not have it.

⚠ Both `readFileSync('./log/mqtt.log')` and `readFileSync('./db/config.json')` are unguarded — a
missing or malformed file is a startup crash. A fresh clone has neither (both are gitignored), so
it will not boot until you create `log/mqtt.log` (minimum: `{}`) and a `db/config.json`.

## 5. `getDevice()` — two different output shapes

`getDevice(dev)` (line 528) returns **different shapes depending on the argument**. This trips
people up.

### `getDevice('<name>')` — one device, used by `queueSend` → the `device` event

```jsonc
{ "<zone>": { "<device>": { …fields…, "lastChange": 1784407053134 } } }
```
Zone falls back to the literal string `"nozone"` if the device has none. Fields by branch, in
the order the code tests them:

| Condition | Fields |
|---|---|
| `d.type === 'light'` | `onoff` (**boolean**, `d.onoff === 'true'`), `dim`, `night`, `mood` |
| `d.type === 'occupancy'` | *(empty object — `lastChange` alone carries the signal)* |
| `d.type === 'sensor'` | `state` |
| has `onoff` | `onoff` (boolean) |
| has `alarm-contact` | `onoff` from `d['alarm-contact'] === 'true'` |
| has `alarm-motion` | `onoff` from `d['alarm-motion'] === 'true'` |
| otherwise | **`{}`** — and `queueSend` drops it |

⚠ Note `type === 'switch'` is **not** a branch here — a switch falls through to the generic
`has onoff` case and therefore **loses its `mood` / `night` flags** in per-device updates, while
the full-snapshot path (below) does include them. The dashboard only recomputes `moodable` /
`nightable` from whatever it has, and `updateMap` merges rather than replaces, so the flags from
the initial snapshot survive. Do not "simplify" `updateMap` into a replace.

⚠ `getDevice(dev)` does `devices[dev]` with no existence check. It is only ever called from
`queueSend`, which is only called for devices that already passed the `hasOwnProperty` test — but
a new caller passing an unknown name gets a TypeError. Since the hardening pass that no longer
exits the process (`uncaughtException` logs and keeps serving), but it is still an unguarded
read: check the name, or go through `queueSend`.

### `getDevice(null)` — the full snapshot, used by the `device.all` event

Iterates `config.zones` (so it reflects **config**, not `devices`) and returns:

```jsonc
{
  "<zone>": {
    "<device>": {
      // light | switch:
      "onoff": true, "dim": "…", "mood": true|undefined, "night": true|undefined,
      // occupancy:
      "lastChange": 1784407053134,
      // everything else:
      "state": "22.1"
    }
  }
}
```

Empty zones are omitted. Devices present in config but not yet seen on MQTT come back as `{}`
(or `{mood, night}` for lights/switches). The `if (dev && dev !== split[0]) return;` line inside
this loop is dead — this branch is only reached when `dev` is falsy.

## 6. socket.io event contract

Transport: socket.io 4, served at `/socket.io/` (which bypasses express entirely — see
`docs/auth.md` §1). Auth: `io.use(middlewareTransform(cookieMiddleware))`, which runs
`cookieParser(cookieSecret)` over `socket.request` and then validates the signed session cookie
server-side. The handshake is same-origin so the browser sends the cookie by itself;
`web/scripts/home.js` calls plain `io()` with no auth callback. See `docs/auth.md` §1.

| Direction | Event | Payload |
|---|---|---|
| server → client | `device.all` | **a JSON string** of `getDevice(null)`, pretty-printed with two spaces. Sent once, on connect, by `clientConnected()`. |
| server → client | `device` | **a JSON string** of `getDevice('<name>')`. Emitted by `queueSend()` on every state change. |
| client → server | `toggle` | **a JSON string** `{ type: 'room' \| 'item', name, value }`. `type: 'room'` → `toggle(name, value)`; anything else → `toggleItem(name, value)`. |

Both server→client payloads are **strings**, not objects — the client does
`JSON.parse(msg)`. Keep it that way or `web/scripts/home.js` breaks.

`queueSend` de-duplicates: it keeps the last emitted JSON per device in `toSend` and skips an
identical re-emit. `io.emit` broadcasts to **all** connected clients; there is no per-user
filtering (everyone who is `enabled` sees the whole apartment).

### `toggle(zone, value)` — room-level

Rejects an unknown zone and an `undefined` value with a log line. Then, for every `light` /
`switch` in that zone:

- `value === 'night'` → publish `on` to devices flagged `.night`, `off` to the rest
- `value === 'mood'` → publish `on` to devices with **any** third segment (`.mood` *or*
  `.night` — the comment says "Night && mood"), `off` to the rest
- otherwise → publish `value` verbatim to all of them

The client picks the next value with `getNextStateRoom()` (`web/scripts/home.js` 324):
`on → off`, `off → night` (if nightable) else `mood` (if moodable) else `on`,
`mood → on` (if "max brightness" checked) else `off`, `night → mood` (if moodable) else as mood.

### `toggleItem(item, value)` — single device

Scans **all** zones for a device whose first segment matches `item`, and publishes to each match
that is a `light` or `switch`. A device listed in two zones is published to twice.

## 7. State persistence ⚠

`devices` — the entire in-memory model — is written to **`log/mqtt.log`** (JSON, tab-indented)
**only inside `exitHandler`** (line 626). There is no periodic flush and no write on change.

Handlers registered (lines 739–753):

| Event | Behaviour |
|---|---|
| `exit` | flush, no `process.exit()` |
| `SIGINT` | flush, then exit — Ctrl-C in the tmux pane saves |
| `SIGTERM` | flush, then exit — `kill` and `systemctl stop` now save |
| `uncaughtException` | ⚠ **logs only, keeps serving** |
| `unhandledRejection` | ⚠ **logs only, keeps serving** |

The bogus `SIGINT1` / `SIGINT2` registrations (never real signal names, so they never fired) are
gone, and `SIGTERM` is handled — that closes the common "stop the service, lose the state" path.

⚠ **`SIGKILL`, an OOM kill and a power cut still lose everything** since the last clean exit. And
because `uncaughtException` no longer exits, a crashed request no longer flushes state either —
the tradeoff for no longer being remotely killable. On restart the app reloads whatever snapshot
is on disk and only re-converges as the broker re-delivers retained messages; non-retained values
(and `lastChange` timestamps) stay stale until the device next reports.

`exitHandler` also calls `client.end()` to close MQTT before writing. Its second parameter is
named `exitCode` and receives whatever the signal handler passes; it is only logged.
