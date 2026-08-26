# MQTT, devices and the socket.io contract

> Read before touching MQTT ingest, `db/config.json`, `getDevice()` or the dashboard's data
> contract. All of it lives in `mqtt-web.js`.
>
> **Verified 2026-08-25 against the working tree** — commit `eb19c0d`, the uncommitted
> auth-hardening pass, and the uncommitted **new-apartment pass** (rebuilt `db/config.json`,
> generated `web/dashboard.html`, `tools/floorplan/`, the `switch` fix in `getDevice()`).
> The zone names and room list in this file are **the new apartment's** — the old plan's zones
> (`sovrum`, `kontor`, `dusch`, `garderob`, `entre`, `vardagsrum-kok`, `hall-sovrum`, …) are all
> gone. ⚠ **Device** names were only *partly* renamed: `sovrum_1_tak` and `badrum_2_spegel`
> follow the new scheme, but `sovrum_temperature` (in zone `sov1`) and every power sensor kept
> an old name. Never infer a room from a device name alone — see §8.
>
> The Home Assistant side lives outside this repo, at `/media/storage/ha/homeassistant`.
> `configuration.yaml`, `groups.yaml` and `.storage/core.{entity,device,area}_registry` are the
> upstream truth for what can ever reach the broker; §8 records what was checked and what is
> still guesswork.

## 1. The MQTT client

`connect(config.config.mqttAddress)` (`mqtt-web.js` 66) — currently `mqtt://127.0.0.1`, i.e. the
Home Assistant broker on the same host. Plain MQTT, no TLS, no credentials.

On connect the app subscribes to **`#`** — *every topic on the broker* — and filters in the
message handler. There is no topic-level filtering; a busy broker means every message crosses
the handler.

## 2. What Home Assistant actually publishes ⚠

Nothing in this repo decides what appears on the broker. That is `mqtt_statestream:` in
`/media/storage/ha/homeassistant/configuration.yaml` (~line 56):

```yaml
mqtt_statestream:
  base_topic: homeassistant
  publish_attributes: true
  publish_timestamps: false
  include:
    domains: [light, switch, climate]
    entity_globs:
      - group.sensorer_alla
      - sensor.*_humidity | sensor.*_temperature | sensor.*_pressure
      - sensor.{diskmaskin,element,frys,kaffebryggare,kylskap,torktumlare,tvattmaskin,vinkyl}_electric_consumption_w
      - climate.sensibo_moja_current*
```

`include:` is a **pure allowlist** — anything not named is never published:

- ⚠ **`sensor` is not an included domain.** Only sensors matching one of the globs reach MQTT.
  A new temperature/humidity/pressure sensor works for free; any other sensor needs a new glob
  in the HA config, which is **not in this repo**.
- ⚠ **`binary_sensor` is never published at all.** The only presence signal the dashboard has is
  the YAML group `group.sensorer_alla` (defined in `groups.yaml`, so it is not in the entity
  registry), which arrives as `homeassistant/group/sensorer_alla/state` and is the config's one
  `occupancy` entry.
- ⚠ **Two of those globs match no entity, so two power sensors can never work:**
  `sensor.element_electric_consumption_w` (the real entity is **`sensor.element_power`**) and
  `sensor.kaffebryggare_electric_consumption_w` (the real one is **`..._w_2`**). Both were
  dropped from `db/config.json` rather than left as permanently dead rows. Fixing them means
  editing the HA config, not this repo.
- `climate.sensibo_moja_current*` also matches nothing, but it is harmless: the `climate`
  **domain** is allowlisted, so `climate.sensibo_moja` publishes regardless.

## 3. Inbound topic convention

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
segments and rebuilds `device` as `split.join('_').replace('current_', '')` — equivalently
`split.slice(2).join('_').replace('current_', '')`. So
`homeassistant/climate/sensibo_moja/current_temperature` becomes device
`sensibo_moja_temperature`.

⚠ **That is why `sensibo_moja_temperature.sensor` and `sensibo_moja_humidity.sensor` are valid
config entries even though no such entity exists** — the only real entity is
`climate.sensibo_moja`. Do not "clean them up" against the entity registry; they are the
post-remap names, and the `climate` domain is what publishes them. This remap happens *after*
(a), so the generic nested write lands under the **un-remapped** name and leaves stray
sub-objects in `devices` (visible in `log/mqtt.log`).

## 4. Outbound topic convention

`publish(device, property, message)` (line 695) sends to:

```
webapp/switch/<type>.<device>/<property>/set
```

e.g. `webapp/switch/light.kok_tak/state/set` with payload `on`. Note this is a **different
namespace from the inbound `homeassistant/…` tree** — something on the Home Assistant side
bridges `webapp/switch/...` back into actual device commands. That bridge is not in this repo.

`property` is always `'state'` in current code; `message` is `on` / `off`. `publish()` returns
early if `message` is `undefined`.

## 5. `db/config.json` (gitignored — not in the repo)

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
`"sang_hoger.switch.mood"`, `"sovrum_1_tak.light"`, `"slinga_mette.light.night"`,
`"garderob_1_temperature.sensor"`, `"sensorer_alla.occupancy"`,
`"kylskap_electric_consumption_w.sensor"`.

### Zones — and why `db/config.json` is now the source of truth ⚠

⚠ **`web/dashboard.html` is generated from `db/config.json`** by
`node tools/floorplan/generate.mjs`. **Never hand-edit the dashboard.** Zone ids, item ids,
`th-<sensor>` readout ids and appliance-marker ids used to be four hand-maintained naming
contracts between the markup and this file, none of them validated, and they had drifted; they
are now true by construction. To add, remove or rename anything on the plan, **edit
`db/config.json` (and `tools/floorplan/lights.json` for glow placement) and regenerate.**
`tools/floorplan/README.md` is the pipeline's own doc — read it before touching the drawing.

The 22 zones, matching the apartment as of the new plan:

| Kind | Zones |
|---|---|
| Rooms drawn on the plan (18) | `vardagsrum`, `kok`, `gang`, `entre1`, `entre2`, `sov1`, `sov2`, `sov3`, `sov4`, `bad1`, `bad2`, `bad3`, `klk1`, `klk2`, `orangeri`, `tvatt`, `loggia`, `balkong` |
| Not rooms (4) | `home` (the one `occupancy` group), `utomhus`, `moja`, `devices` |

- ⚠ `loggia` and `balkong` are **drawn and clickable but have empty device lists**, so
  `getDevice(null)` omits them (empty zones are dropped) and they never appear in the snapshot.
  That is expected, not a bug. Clicking them publishes nothing.
- `utomhus` and `moja` have sensors but no room in the drawing, so their readings are in the
  socket payload and are never rendered anywhere. `home` drives the "senaste aktivitet" footer.
- ⚠ Only a light carrying a **`.mood` / `.night` flag** gets its own `class="item"` glow circle
  in the generated markup (currently 17 `mood` + 3 `night` = 20). A plain `.light` is toggled
  with the room and has no individual click target — that is by design; adding a flag is what
  makes an item clickable.
- Zone names are still the SVG group ids and device names still the item ids — `toggleItem()`
  matches on the config name. Since the markup is generated, a mismatch can now only be
  introduced by hand-editing `web/dashboard.html`. `node tools/floorplan/generate.mjs --check`
  exits non-zero when the file is stale; run it after any config change.

The zone **`devices`** is special: everything in it is treated as a power meter and its `state`
becomes the boolean `> 2.5 W` (see §3b). The zone **`home`** holds the single `occupancy` sensor
that drives the "senaste aktivitet" readout.

`init()` (line 32) walks `config.zones` at startup and stamps `zone`, `type`, `mood`, `night`
onto each `devices[<device>]` entry, creating the entry if `log/mqtt.log` did not have it.

⚠ Both `readFileSync('./log/mqtt.log')` and `readFileSync('./db/config.json')` are unguarded — a
missing or malformed file is a startup crash. A fresh clone has neither (both are gitignored), so
it will not boot until you create `log/mqtt.log` (minimum: `{}`) and a `db/config.json`.

## 6. `getDevice()` — two different output shapes

`getDevice(dev)` (line 567) returns **different shapes depending on the argument**. This trips
people up.

### `getDevice('<name>')` — one device, used by `queueSend` → the `device` event

```jsonc
{ "<zone>": { "<device>": { …fields…, "lastChange": 1784407053134 } } }
```
Zone falls back to the literal string `"nozone"` if the device has none. Fields by branch, in
the order the code tests them:

| Condition | Fields |
|---|---|
| `d.type === 'light'` **or `'switch'`** | `onoff` (**boolean**, `d.onoff === 'true'`), `dim`, `night`, `mood` |
| `d.type === 'occupancy'` | *(empty object — `lastChange` alone carries the signal)* |
| `d.type === 'sensor'` | `state` |
| has `onoff` | `onoff` (boolean) |
| has `alarm-contact` | `onoff` from `d['alarm-contact'] === 'true'` |
| has `alarm-motion` | `onoff` from `d['alarm-motion'] === 'true'` |
| otherwise | **`{}`** — and `queueSend` drops it |

**Fixed, do not re-report:** `'switch'` used to be missing from that first branch, so a switch
fell through to the generic `has onoff` case and **dropped its `mood` / `night` flags** on every
per-device update, while the snapshot path (below) included them. It survived only because
`updateMap` on the client merges rather than replaces. The two paths now agree — but the merge
is still load-bearing for other fields, so do **not** "simplify" `updateMap` into a replace.

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

## 7. socket.io event contract

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

## 8. Where `db/config.json` came from — and what is still guesswork ⚠

The current file was rebuilt from the Home Assistant registries under
`/media/storage/ha/homeassistant/.storage/` and checked against a live MQTT sweep: **all 66
device entries resolve to a live retained topic.** If you rebuild it again, use the same method
and the same warnings.

### ⚠ The HA **area registry is unmaintained — do not trust it**

- **117 of 153 devices have no area at all**, so area alone cannot place most entities.
- Several areas are actively *wrong*, and following them would put lights in the wrong room:

  | Area | What it actually contains |
  |---|---|
  | `Kök` | `light.orangeri_tak`, `light.vardagsrum_linje`, `light.vardagsrum_tak_lampa` |
  | `Dusch` | `light.badrum_2_spegel`, `light.badrum_2_tak` |
  | `Kontor` | `light.sovrum_3_tak` |
  | `garderob_kontor` | `light.sovrum_4_tak` |

  There are also stale one-device areas left over from Sonos speakers (`Kök tak`,
  `Vardagsrum tak`, `Soundbar`) and from the old plan (`Sovrum MK`, `Nytt kök`, `Matsal`).

- **The reliable signal is the entity/device naming convention**, which *was* redone for the new
  apartment: `badrum_1_*`, `badrum_2_*`, `sovrum_2_*`, `garderob_1_*`, `entre_1`/`entre_2`.
  Trust the name; use the area only as a weak tiebreaker.

### ⚠ Power sensors kept their **old** names through the rename

A power sensor's name tells you nothing about which room it is in. Two proven examples:

| Sensor | Actually lives on device |
|---|---|
| `sensor.dusch_tak_electric_consumption_w` | **Badrum 2 tak** |
| `sensor.sovrum_mette_tak_electric_consumption_w` | **Sovrum 4 tak** |

Resolve a power sensor through its `device_id` in `core.entity_registry` →
`core.device_registry`, never by parsing its entity id.

### Known gaps — open, not done

Record here rather than rediscovering them:

- **`loggia` and `balkong` have no HA entities identified at all.** Both rooms are drawn and
  clickable with empty device lists.
- **`orangeri` has entities but no HA area** — they are scattered across `Kök`
  (`light.orangeri_tak`) and `Nattbelysning` (`light.bordslampa_orangeri`). The zone was
  assembled by name.
- **RESOLVED 2026-08-25 (operator): the bedrooms are named after their occupants** —
  `sov2` = Mikkel, `sov3` = Kai, `sov4` = Mette. This settles the `light.lampa_mikkel`
  ambiguity (its *device* area said `Nytt kök`, its `switch.` *entity* area said `Sovrum MK`):
  it is **Mikkel's room, `sov2`**, and the HA device area is simply wrong — one more reason not
  to trust that registry. `lampa_kai` → `sov3` and `lampa_mette` → `sov4` follow the same rule.
  ⚠ `mikkel_garderob` (`sov2`) and `kai_garderob` (`sov3`) are placed with their owner's
  bedroom by **inference** — they could belong to `klk1`/`klk2` instead. Confirm before relying
  on them.
- **`switch.ytterdorr_1_brytare` / `light.ytterdorr_2` have no area at all** — which of
  `entre1` / `entre2` each belongs to is inference, not fact.
- **`vinkyl` has a power sensor in `config.zones.devices` but no marker in the drawing**, so it
  is never rendered. The generator prints
  `! power sensor "vinkyl_*" has no marker in the plan` on **every** run — that warning is
  expected until a fixture marker is added to `geometry.json`.
- **The `.mood` / `.night` tier assignments in the current config are inference**, not verified
  against how the rooms are actually used. They decide which lamp is an ambience light and
  therefore what the room's click cycle does; expect the operator to want some moved.
- **Glow positions in `tools/floorplan/lights.json` are auto-seeded**, in a ring around each
  room's text anchor — **all 20 currently carry `"auto": true`**, meaning none has been placed
  by hand yet. Hand-edit that file (and drop the `auto` flag); the generator preserves it.

## 9. State persistence ⚠

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
