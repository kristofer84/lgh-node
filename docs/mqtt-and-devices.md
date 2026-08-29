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

⚠ `valueTypes` is an **allowlist** — `['state', 'brightness', 'current_temperature',
'current_humidity', 'current_pressure']`. Anything else HA publishes (and with
`publish_attributes: true` it publishes a lot) is dropped on the floor. `brightness` was added
2026-08-27; before that `getDevice()` returned `dim: device['dim']`, a key **nothing ever
wrote**, so every lamp reported `dim: undefined` for as long as the model has existed. If you
need another attribute client-side, adding it here is step one.

**(b) A typed update, only for devices that have a `zone`** (i.e. that appear in
`db/config.json`):

| `deviceType` | What is written |
|---|---|
| `light`, `switch`, `valueType === 'state'` | `devices[d].onoff = payload === 'on' ? 'true' : 'false'` — **the string `'true'`/`'false'`, not a boolean**. ⚠ The `valueType` test is load-bearing: this branch used to run for *every* value type, so the moment `brightness` joined `valueTypes` a payload of `"178"` read as "not on" and flipped `onoff` to false. |
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
  ⚠ **The untiered devices in a zone are what makes `on` different from `mood`** — `mood`
  switches the tiered ones on and the untiered ones *off*, so a zone in which **every** light
  is tiered has no `on` step at all: `mood` and `on` publish the identical scene and the extra
  press does nothing. `kok` and `bad3` were both in that state until 2026-08-27. Whenever you
  add a tier, check the zone still has at least one plain `.light` / `.switch` left — **or**
  that the tiered ones carry a brightness (`[3]`), which separates the two steps by level
  instead of by membership. `bad3`, `entre1`, `entre2` and `gang` all rely on that: every
  light in them carries `.mood.20`, so `mood` is 20% and `on` is 100%.
  The same trap one level down: if the only tiered device in a zone is `.night`, then `night`
  and `mood` are also identical (night counts as mood), which is what `orangeri` did.

> ⚠ **The string form above is the LEGACY one.** Since 2026-08-28 a switchable entry is an
> **object**, which is what the config page reads and writes:
> ```json
> { "device": "badrum_1_tak", "type": "light", "steps": { "mood": 20, "on": 100 } }
> ```
> A step key that is **absent means off at that step**; `true` means on; a number means on at
> that brightness in percent. The `off` step is implicit. Sensor and occupancy entries keep the
> plain string form — they have no steps and the page never touches them.
> `parseEntry()` still reads the string form and translates a tier into the steps it used to
> imply, so an old config keeps working. That translation is where the old model was least
> obvious: **`night` also lit at `mood`**, and **`on` lit everything regardless of tier**.
> ⚠ The step values are now authoritative and independent, which is the point: a device can be
> lit at `night` but not `mood`, or left out of `on` entirely. Neither was expressible before.

- `[3]` **brightness** (optional, and only meaningful with `[2]`) — percent, e.g.
  `badrum_1_tak.light.mood.20`. Sets `devices[d].level`; makes that light dim to 20% at its
  step and to 100% at `on`. See `toggle()` in §7 for why `on` has to say 100 out loud.

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
- ⚠ A light gets its own `class="item"` group when it carries a **`.mood` / `.night` flag**
  **or** has a hand-placed entry in `tools/floorplan/lights.json` (27 items as of 2026-08-27).
  The two are deliberately independent: the flag decides whether the lamp joins the room's
  mood/night scene, the `lights.json` entry decides whether you can see and tap it. A plain
  `.light` with no entry is toggled with the room and has no individual click target.
  See `tools/floorplan/README.md` for the full rule.
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
| `d.type === 'light'` **or `'switch'`** | `onoff` (**boolean**, `d.onoff === 'true'`), `dim` (0–255 number or `undefined`, via `brightnessOf()` — HA sends the literal string `"null"` while the lamp is off), `level` (percent from the device string's 4th segment), `night`, `mood` |
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

### ⚠ The grammar and the step semantics live in `web/scripts/zones.js`

Everything in this section — how a device string is read, what each step publishes, and which
step a room is currently displaying — is **one shared module**, `web/scripts/zones.js`,
imported by `mqtt-web.js`, `tools/floorplan/generate.mjs` and (in the browser)
`web/scripts/home.js`. It lives under `web/` because `express.static('./web')` serves it and
`dashboard.html` loads `home.js` with `type="module"`, so that is the only path all three can
reach without a build step. Keep it import-free and free of Node/DOM specifics.

It exists because the grammar used to be re-implemented in **seven** places and the meaning of
a step in three, with nothing holding them in agreement — and they did not agree. `sceneFor()`
(what a step publishes) and `stepOf()` (which step a room is in) are inverses of each other;
`npm test` checks them against the real `db/config.json`.

⚠ **`stepOf()` can return a fifth value, `partial`, that no press ever produces.** It means
some lights in the room are on, not all of them are, and none of the lit ones belongs to a
mood/night scene — one wardrobe light, or a bathroom mirror. Until 2026-08-28 that case fell
through to `on`, because the chain was written as `let step = 'on'` followed by four `if`s
that could all miss. The room then washed full amber **and** hid its own per-lamp glows
(`.zone-lights[light="on"] .glow`), so the lamp you had just switched on disappeared; adding a
second, mood-tiered lamp moved the room *backwards* from `on` to `mood`. The case only became
reachable when untiered lights got their own tap targets. `partial` renders a fainter wash
(0.12 against mood's 0.22) and keeps the glows, and presses to `off` — which is what it did
while it was mislabelled.

### The config page — `web/config.html`, `/config/zones`

Pick a room, tick which lights each step turns on, type a percentage where the hardware takes
one. It edits `steps` and nothing else: which devices are in a zone, **their order**, and the
sensor entries are all preserved. Order matters — the floorplan generator uses it to place a
lamp that has no position of its own yet.

- `GET /config/zones` → one row per switchable device per zone: `steps`, the HA friendly name,
  and `dimmable`.
- `POST /config/zones` with `{zone: {device: steps}}` → validates, backs up, writes, reloads
  in-process and broadcasts a fresh `device.all` so open dashboards follow immediately.

⚠ **Both routes are registered below `cookieMiddleware`, and must stay there** — in this file
the registration order *is* the authorization model, and above the gate these would let anyone
rewrite what every light in the flat does.

⚠ **`dimmable` comes from HA, not from a model list.** `supported_color_modes` is ingested for
exactly this; anything whose only mode is `onoff` gets no percentage box. Guessing from the
device model is wrong — it misses that the garderob drivers dim and that `lampa_mikkel`,
`lampa_kai`, `sang_*` and `tvattstuga_bank` do not.

⚠ **A dimmable device is stored as a NUMBER at every step it is on at, never `true`.** A plain
`turn_on` restores whatever level the lamp last had, so a dimmable light recorded as `true` at
`on` would come back at whatever the dimmed step set it to.

⚠ **`reloadConfig()` exists because `init()` cannot be reused for this.** init() starts by
reading `log/mqtt.log` over `devices`, which would discard every state MQTT has reported since
boot. reloadConfig() re-stamps only the `SCHEMA_KEYS` and leaves observations alone; a test
covers it, and reverting it to call `init()` makes that test fail.

Writes go through `saveConfig()`: timestamped backup, temp file, atomic rename. `db/config.json`
is read unguarded at boot, so a half-written file is a startup crash later.

### `toggle(zone, value)` — room-level

Rejects an unknown zone and an `undefined` value with a log line. Then, for every `light` /
`switch` in that zone:

- `value === 'night'` → turn on devices flagged `.night`, `off` to the rest
- `value === 'mood'` → turn on devices with **any** third segment (`.mood` *or* `.night` —
  the comment says "Night && mood"), `off` to the rest
- otherwise → publish `value` verbatim to all of them

⚠ **A device may name the brightness it takes at its step** — a *fourth* segment,
`badrum_1_tak.light.mood.20`. Such a light is **dimmed** at that step rather than merely
switched on, and at the `on` step `toggle()` drives it to **100 explicitly**. That last part
is not optional: a plain `turn_on` restores the level the lamp last had, so after a mood press
`on` would leave it sitting at the dimmed level. Measured on the real dimmer 2026-08-27,
not assumed.
Used today by `badrum_{1,2,3}_tak`, `entre_1`, `entre_2` and `hall_tvattstuga` — all
Fibaro FGD-212 wall dimmers, all at **20/100** (70 was tried first
and was far too bright for the step; 20 verified to strike cleanly on the real dimmer —
`brightness_pct 20` → Z-Wave `currentValue 20` of 99 → HA 52/255, no drop-out).
⚠ Reaching the 100% step needs the **Max brightness** checkbox (`#cb-mood`, the sun icon):
`getNextStateRoom()` goes `mood → on` only when it is ticked, otherwise `mood → off`. With it
off, a room whose lights all carry a level cycles `off → 20% → off` and full brightness is
unreachable from the floorplan.

⚠ **Brightness leaves on a different topic and needs a second HA automation.**
`toggle()` itself is now four lines — it asks `sceneFor()` what the step means and puts the
answer on the wire. `publish()` writes `webapp/switch/<entity>/<property>/set`, which the long-standing HA
automation **`(mqtt in) Kontrollera enhet`** picks up — and that automation runs
`homeassistant.turn_{{trigger.payload}}` and **discards the property segment entirely**, so
that path can only ever carry `on`/`off`. A payload of `70` would call
`homeassistant.turn_70`. `publishDim()` therefore writes **`webapp/dim/<entity>/set`**, which
the old trigger pattern (`webapp/switch/+/+/set`) cannot match, and a second automation added
2026-08-27, **`(mqtt in) Dimma enhet`**, calls `light.turn_on` with `brightness_pct`.
Both live in `/media/storage/ha/homeassistant/automations.yaml` — **outside this repo**. If
dimming stops working, check that automation exists and is enabled before touching this code.

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
  | `Kök` | `light.orangeri_tak`, `light.vardagsrum_linje`†, `light.vardagsrum_tak_lampa` |
  | `Dusch` | `light.badrum_2_spegel`, `light.badrum_2_tak` |
  | `Kontor` | `light.sovrum_3_tak` |
  | `garderob_kontor` | `light.sovrum_4_tak` |

  There are also stale one-device areas left over from Sonos speakers (`Kök tak`,
  `Vardagsrum tak`, `Soundbar`) and from the old plan (`Sovrum MK`, `Nytt kök`, `Matsal`).

  † `light.vardagsrum_linje` no longer exists in HA — it and
  `light.vardagsrum_taklampa_ovan_matbord` were removed from HA's own scripts 2026-08-28, and
  survive only as orphaned retained MQTT topics. Neither is in `db/config.json`. If you meet
  either name elsewhere it is **stale, not a typo**: they were real entities once.

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
- **RESOLVED 2026-08-27: `switch.lampa_orangeri` was a duplicate of `light.bordslampa_orangeri`
  and has been dropped from the zone.** They are the *same* physical Everspring AD147 plug —
  same `device_id`, unique ids `3611387181.30-37-0` (binary switch, CC 37) and
  `3611387181.30-38-0` (multilevel switch, CC 38). Keeping both meant every `orangeri` room
  press published two commands to one plug and the model carried it twice. If you re-derive
  zones from the HA registry, expect this shape again wherever a Z-Wave plug exposes both
  command classes.
- **2026-08-28: `v1` and `v2` are driven as one device through the zigbee2mqtt group
  `light.z_lampor_v`** (z2m group **5**). The operator created the group so the two bench
  lamps switch together. `db/config.json` carries `z_lampor_v.light.mood` instead of the two
  entries, and `lights.json` gives it `points: [[55.18,135.57],[55.18,118.78]]` — the old v1
  and v2 positions — so it draws as **two dots inside one `<g class="item">`** and both toggle
  the group. `light.v1` and `light.v2` still exist in HA and still publish their own state;
  they are simply no longer on the floorplan.
  ⚠ **A freshly created z2m group publishes `state: unknown` until something commands it**,
  and the ingest drops `unknown` along with `unavailable` — so a brand-new group reads as
  permanently off on the dashboard until its first press. Commanding it once fixes that, and the
  woken state survives the entity being renamed — it belongs to the z2m group, not to the HA
  entity. z2m retains nothing on `zigbee2mqtt/<group>`, so if HA ever restores the entity as
  `unknown` after a restart, expect the same until the next command.
  ⚠ **A z2m group entity's `unique_id` is its group NUMBER** (`5_light_zigbee2mqtt`), not its
  name — so renaming a group does not move the entity, and a replacement created under a name
  that is already taken lands as `light.<name>_2`. That happened here: "z lampor v" had been
  reused on an old **group 1**, which still held `light.z_lampor_v`, so the new group 5 arrived
  as `light.z_lampor_v_2` — and group 1, by then containing only `light.v1`, was the entity
  that *looked* right while driving half the pair. Deleting group 1 freed the id.
  **If a group entity seems to drive the wrong lamps, check `group_entities` and the
  `unique_id` before you trust the name.**
  Deleting an entity leaves its `homeassistant/light/<name>/*` topics **retained on the broker**
  (15 of them in this case). `mqtt-web.js` subscribes to `#` and its reducer stores every
  matching topic, so that debris accumulates in the model and in `log/mqtt.log` on every boot —
  clear it with `mosquitto_pub -t <topic> -r -n` per topic.
- **2026-08-28: `hall_sovrum` moved from `gang` to `vardagsrum`, untiered.** It is *not* a
  corridor light — the operator confirms it lights the small square landing just outside
  `sov1` and `sov2`, which the room extraction assigns to the **vardagsrum** polygon. That
  matters beyond tidiness: `#lights` is clipped per zone (`clip-path="url(#<zone>-clip)"`), so
  a lamp positioned outside its own zone's polygon is **clipped away and renders nothing at
  all** — silently. If a lamp you have placed does not appear, check which room's polygon
  actually contains the point before touching anything else.
  It is untiered and carries a `lights.json` entry, which makes it an individually tappable
  light (symbol + tap target) without joining the living room's mood scene — a landing light
  has no business coming on with the sofa lamps. `gang` is left with `hall_tvattstuga` alone,
  a row of three across the corridor; its two steps stay distinct because the level separates
  them (20% vs 100%), not because an untiered device does.
- **`orangeri` has entities but no HA area** — they are scattered across `Kök`
  (`light.orangeri_tak`) and `Nattbelysning` (`light.bordslampa_orangeri`). The zone was
  assembled by name.
- ⚠ **REMOVED 2026-08-29: `bordslampa_orangeri` is dead hardware and was pinning the room
  lit.** Node 30 ("Lampa orangeri", an Everspring AD147) is `dead`, last seen
  **2026-04-14T14:04:29Z**, and every entity it owns is `unavailable` / `restored: true`.
  Because the model had it at `state: on` from **2026-04-01T04:01:25Z** and never received
  another message, the `orangeri` zone contained a permanently-lit device and **the room could
  never render as off** — it read as partly lit forever. Dropped from `config.zones.orangeri`
  and from `lights.json` (its glow was still auto-placed at `62.09, 174.34, r 26` — restore
  that if the plug is ever replaced). The zone is now `orangeri_tak` alone, which costs it its
  `mood` step; **`light.orangeri_brytare` (node 36) is alive and `off` and is the obvious
  candidate to take that step over**, but which physical lamp it drives is unconfirmed, so it
  is deliberately not wired in.
  ⚠ **EMPTIED 2026-08-29 (operator): the orangeri physically contains no lights at all** — no
  bulbs, nothing — and its multisensors and the IKEA sensor are disconnected too. The zone is
  now `[]`, like `loggia` and `balkong`: the room still draws and is still clipped, it simply
  has nothing in it. That removed the last light (`orangeri_tak`) and both sensor readouts,
  which were showing a **retained** 29.3 °C and 66 % for a sensor that is unplugged — MQTT
  retains the last value forever, so a disconnected sensor reads plausibly rather than blank.
  To restore the room when it is fitted out again, the entries were verbatim:
  `{"device": "orangeri_tak", "type": "light", "steps": {"on": true}}`,
  `"orangeri_temperature.sensor"`, `"orangeri_humidity.sensor"`.
  `light.orangeri_brytare` (node 36) is the Fibaro dimmer feeding the mains to whatever bulb is
  fitted — **not a lamp in its own right**, and not to be given a mood step: of 34 times it went
  unavailable, 25 took `orangeri_tak` down within 60 s (median 5 s), and the bulb dropped out
  111 times to the dimmer's 34. Same wiring as `vardagsrum_tak`, which has an automation forcing
  its dimmer to 100 % precisely because dimming the feed browns out the bulb; the orangeri has
  no such automation.
  ⚠ **This is the general failure mode, not a one-off: the model has no notion of staleness.**
  An `unavailable` / `unknown` payload is *dropped* at the top of `client.on('message')`
  (`mqtt-web.js` ~line 511) — deliberately, so a lamp does not flicker off during a restart —
  which means a device that dies keeps its last known state **forever**, and a device that died
  while lit stays lit in the model for as long as the config references it. `log/mqtt.log`
  carries it across restarts. When a room will not go off, check `lastChange` on its devices
  before you check anything else.
- ⚠ **Three Z-Wave nodes are dead. Anything referencing them is inert** (registry sweep by a
  second session, 2026-08-29):

  | node | name | last seen | owns |
  |---|---|---|---|
  | 30 | Lampa orangeri (AD147) | 2026-04-14 | `light.bordslampa_orangeri`, `switch.lampa_orangeri` |
  | 79 | Multisensor | **2023-12-19** | every `multisensor_*` entity, ~95 of them |
  | 96 | Vinkyl (Smart Plug 16A) | 2026-08-28 | `switch.vinkyl`, `sensor.vinkyl_*` |

  Node 96 is the only one plausibly recoverable — it was alive the previous afternoon and may
  simply be unplugged. Nothing in the app depends on it: its power sensor is in
  `config.zones.devices` but has no marker in the drawing, which is the `! power sensor
  "vinkyl_*" has no marker in the plan` warning the generator prints on every run.
  ⚠ **`multisensor_6_*` is not a separate live device — it is node 79 as well.** There is
  exactly one such entity (`sensor.multisensor_6_power`) and it is `restored: true` like the
  rest. There is no working multisensor anywhere in this installation; the only two
  `multisensor_*` entities carrying a real state are node 79's own diagnostics, which say
  `node_status = dead` and a frozen `last_seen`. Do not read the `_6` suffix as a replacement
  device.
  **Detecting this class needs three signals, not two.** `sensor.<node>_node_status` gives the
  *device*-level truth and `restored: true` the *entity*-level truth — both are necessary,
  because a live node can still own dead entities (node 36 is alive and owns
  `light.orangeri_tak_basic` / `_basic_2`, both dead mirrors). But neither catches a **battery**
  device, and ⚠ **`sensor.<name>_last_seen` is the only reliable signal.**
  The case that proves it is node 2, `motion_sensor_eye`, **last seen 2025-11-11 — gone for ten
  months and both other signals call it healthy**: battery nodes are marked `asleep`, never
  `dead` (correct for a sleeping node, so `node_status` cannot separate "asleep 20 minutes" from
  "gone since November"), and because its entities were never `unavailable` at a restart,
  `restored` is never set on them either. It is at this moment publishing permanent motion, a
  plausible 23.7 °C and a 92 % battery, all frozen last November.
  **The app does not consume it** — checked 2026-08-29. The only occupancy entry in the config
  is `home` → `sensorer_alla.occupancy`, and that HA group contains
  `binary_sensor.rorelsesensor_{ytterdorr,entre,hall,garderob_1,garderob_2}_occupancy` plus
  `input_boolean.dummy`; node 2 is not a member, and the group currently reads `off`. Node 2's
  entities are in `log/mqtt.log` as debris only, with no `zone`, so they are never served. Keep
  it that way: wiring `motion_sensor_eye*` into a zone would import a permanently-on sensor, and
  the "senaste aktivitet" readout on the dashboard is driven by that group's `lastChange`.
  Full stale list as of 2026-08-29 — only four Z-Wave nodes unseen in over 7 days, and one is
  the controller: **79** (dead, 983 days), **2** (asleep, 290 days), **30** (dead, 136 days),
  1 (controller). Everything else was seen the same day.
  ⚠ Those two are node **36**, not the zigbee `light.orangeri_tak`; a name-prefix match on
  `orangeri_tak` picks up the wrong device. Match on `unique_id`.
- **RESOLVED 2026-08-25 (operator): the bedrooms are named after their occupants** —
  `sov2` = Mikkel, `sov3` = Kai, `sov4` = Mette. This settles the `light.lampa_mikkel`
  ambiguity (its *device* area said `Nytt kök`, its `switch.` *entity* area said `Sovrum MK`):
  it is **Mikkel's room, `sov2`**, and the HA device area is simply wrong — one more reason not
  to trust that registry. `lampa_kai` → `sov3` and `lampa_mette` → `sov4` follow the same rule.
  **CONFIRMED 2026-08-27 (operator):** `mikkel_garderob` is the wardrobe in `sov2` (the
  **upper** of that room's two wardrobes — the run along the top wall, not the one on the left
  wall), and `kai_garderob` is the wardrobe in `sov3`. Both are placed in `lights.json` and are
  now their own tappable symbols; neither carries a mood/night tier, so they glow only when
  they themselves are on and never join the room's mood scene.
- ⚠ **A Z-Wave plug or dimmer often exposes MORE THAN ONE entity, and only one of them
  works.** This has now bitten three times, so check it first whenever a button does nothing:
  the node presents command class **37** (binary switch) as `switch.<name>` and **38**
  (multilevel switch) as `light.<name>`, and HA keeps a registry entry for whichever it once
  saw even after the device stops providing it — showing `state: unavailable` with
  `restored: true`. Publishing to that one is silently inert.
  **`slinga_mette` (fixed 2026-08-28)**: node 34 is a binary plug with only CC 37, so
  `light.slinga_mette` was a dead leftover and the config now says `"type": "switch"`.
  Confirmed by publishing to both: the `switch.` topic toggles the lamp, the `light.` topic
  does nothing at all.
  To diagnose: `zwave/<Node_Name>/37/0/currentValue` vs `zwave/<Node_Name>/38/0/currentValue`
  tells you which command classes actually exist, and `restored: true` in HA marks the dead
  entity.
  ⚠ **The two entities share a device name, and the ingest keys the model by device name**, so
  they wrote into the same entry and clobbered each other — the dead `light.` half published
  `supported_color_modes: ["brightness"]`, which made a binary plug look dimmable and offered a
  percentage box for it. The ingest now refuses a `light` message for a device the config calls
  a `switch` and vice versa, and `dimmableFrom()` answers `false` for a switch outright, so a
  stale attribute in `log/mqtt.log` cannot resurrect the problem. Sensors and occupancy are
  deliberately outside that guard: an `occupancy` entry legitimately arrives on a `group/` topic.
- ⚠ **`entre2` uses `light.entre_2` (node 35, endpoint 1). CHANGED 2026-08-28 — and the
  opposite instruction stood here until then, correctly.** Until that date the config used
  `light.entre_2_3`, which is endpoint **0**, the root, and that genuinely was the only live
  entity. This is not a doc that went stale; the hardware view moved underneath it.
  **Cause** (established by a second session sweeping the Z-Wave network, 2026-08-28): node 35
  had its **Multi Channel CC cached at version 1**. Endpoint discovery needs v2+, so zwave-js
  never enumerated the node and reported `endpoints=[0]`. With endpoint 1 non-existent,
  `light.entre_2` (`35-38-1`) was `unavailable` and the root entity was all there was. A
  `node.refresh_info` on node 35 re-queried the CC version and the node re-enumerated:

  | | interviewStage | endpoints | Multi Channel version |
  |---|---|---|---|
  | before | Complete | `[0]` | 1 |
  | +60 s | Complete | `[0, 1, 2]` | 4 |

  Node 35 is now structurally identical to node 5 (Entré 1), which never had the defect and
  has always driven its lamps from endpoint 1. **`light.entre_2_3` is now the dead one** —
  `restored: true`, accepts a `turn_on` with no error whatsoever, stays `unavailable`, node
  never moves. Endpoint 2 (`light.entre_2_2`) did not exist before the re-interview and is a
  phantom; do not wire it to anything.
  ⚠ **Five more nodes carry the same cached-v1 defect in other command classes — 7, 8, 31, 37
  and 100.** If a device answers on the root endpoint only and that looks wrong, suspect a
  stale CC version before you suspect the wiring; the cache survives restarts indefinitely.
  ⚠ **The numeric suffix in an entity_id does NOT encode the endpoint.** `light.entre_1_3` is
  node 5 endpoint **3**; `light.entre_2_3` is node 35 endpoint **0**. Same suffix, different
  endpoints — inferring one from the other gets entré-2 exactly backwards. Resolve via
  `unique_id` in `core.entity_registry` (`<node>-<cc>-<endpoint>`), never via the name.
  ⚠ **Do not use `currentValue` to tell a phantom endpoint from a real one.** Endpoint 2 reads
  a permanent `99` on Fibaro dimmers 5, 35, 98, 100 and 16 — but `0` on 105 and 20. Neither
  "non-zero means live" nor "always 99 means phantom" holds. `restored: true` plus the driver's
  own endpoint list is the reliable filter.
  A click on a dead entity fails silently as far as the dashboard is concerned — `mqtt-web.js`
  ignores `unavailable`, so the room simply keeps its last known state, and the refusal appears
  only in `home-assistant.log`:
  `Referenced entities light.entre_2_3 are missing or not currently available`.
  That log line is the fastest way to diagnose "room X does nothing".
  **CONFIRMED on the hardware 2026-08-29T05:17Z, operator present.** Better than an eyeball:
  the operator first pressed the *physical wall button*, and `zwave/Entré_2/38/**1**/currentValue`
  went to 59 and back to 0 — the actuator itself drives endpoint 1, which is not something a
  registry can tell you. Endpoints 0 and 2 did not move at any point. Then three taps on the
  floorplan, round-tripping cleanly through the app:

  | tap | published | endpoint 1 | HA |
  |---|---|---|---|
  | 1 | `webapp/dim/light.entre_2/set 20` | `20` | `on`, brightness 52 |
  | 2 | `webapp/dim/light.entre_2/set 100` | `99` | `on`, brightness 255 |
  | 3 | `webapp/switch/light.entre_2/state/set off` | `0` | `off` |

  Command to Z-Wave confirmation was ~200 ms throughout. Nothing about entré 2 is now inferred.
  ⚠⚠ **Never read `restored` over MQTT — on this broker it is wrong more often than right.**
  Noticed as one stale topic here (`homeassistant/light/entre_2/restored true`, left over from
  before the re-interview) and then audited across the whole broker, 2026-08-29:

  | retained `restored: true` | |
  |---|---|
  | **74** | HA says the entity is **live** — the topic is lying |
  | 70 | still accurate |
  | 11 | entity no longer exists in HA at all |

  The 74 include `light.entre_1`, `light.entre_2`, `light.koksbank`, `light.kokso`,
  `light.garderob_2_tak`, `light.vardagsrum_soffa`, `switch.kylskap`, `switch.tvattmaskin` —
  ordinary working devices. **A dead-entity filter built on MQTT `restored` would discard more
  live entities than dead ones.** Mechanism: `mqtt_statestream` runs with
  `publish_attributes: true` and publishes each attribute as its own retained topic;
  `restored` exists in the attribute dict only *while* the entity is restored, and when it
  recovers the attribute simply vanishes — statestream has no retraction path, so the retained
  `true` is permanent. Registry-side `restored` is still correct; the divergence is purely in
  the retained layer. Use the registry, or `_last_seen` for battery devices.
  The app is unaffected — it reads only `state`, and `restored` is not in `VALUE_TYPES`. Keep it
  that way. (The retained set has not been cleared: other consumers read this broker, so that is
  the operator's call.)
- **`switch.ytterdorr_1_brytare` / `light.ytterdorr_2` have no area at all** — which of
  `entre1` / `entre2` each belongs to is inference, not fact.
- **`vinkyl` has a power sensor in `config.zones.devices` but no marker in the drawing**, so it
  is never rendered. The generator prints
  `! power sensor "vinkyl_*" has no marker in the plan` on **every** run — that warning is
  expected until a fixture marker is added to `geometry.json`.
- **RESOLVED 2026-08-27 (operator): the tiers follow the hardware.** The `on` step is the
  room's **main ceiling circuit** — in every room but `orangeri` that is a Fibaro **FGD-212**,
  a wall dimmer wired behind the light switch. Everything else is `.mood`: IKEA TRÅDFRI bulbs,
  Plejd dimmers, and the Fibaro **FGWP-102** *wall plugs* (`lampa_mikkel`, `lampa_kai`,
  `sang_*`, `skapbelysning`, `slinga_mette`, `tvattstuga_bank` — plugs, so table/floor lamps,
  **not** switches; do not read "Fibaro" as one category). `.night` is reserved for the one
  thing you would leave on overnight.
  Three deliberate exceptions: **`koksbank`, `kok_kokshylla` and `garderob_1_skap` are `.mood`
  even though they are FGD-212** — counter, shelf and wardrobe accent strips, not the main
  light; and the two **wardrobe lights in `sov2`/`sov3` stay untiered** — task lights inside a
  closed closet have no business in a mood scene, and since 2026-08-27 they are visible and
  tappable without a tier.
  `garderob_1_skap` runs **along `klk1`'s two outer walls** (operator, 2026-08-27) — the
  sloping facade wall and the right-hand wall — so its `lights.json` entry is five `points`,
  three following the slope and two down the right wall, not a single `cx`/`cy`.
- **Glow positions in `tools/floorplan/lights.json` start auto-seeded**, in a ring around the
  room's text anchor, and carry `"auto": true` until placed by hand. Two are still unplaced:
  `slinga_mette` — it belongs to a device that is physically disconnected, so nobody has
  noticed it sitting in the wrong spot. (`bordslampa_orangeri` was the other; it was removed
  2026-08-29 along with its dead node.) `tvattstuga_bank` is
  placed but **inferred**: no bench is outlined in the drawing, so it sits on the worktop over
  the washer/dryer (the `TM`/`TT` fixtures at ~110.8, 181/187). Worth confirming. Neither it
  nor `garderob_1_skap` has a run on the drawing's `Rum` layer; if either is redrawn there,
  switch its entry to `{"run": …, "count": …}` so spacing tracks the drawing.

## 9. State persistence ⚠

`devices` — the entire in-memory model — is written to **`log/mqtt.log`** (JSON, tab-indented)
**only inside `exitHandler`** (line 626). There is no periodic flush and no write on change.

⚠ **`init()` restores `devices` from that file and then stamps the config over it — so it must
DELETE a flag as well as set one.** It did not until 2026-08-27: `mood` / `night` were only
ever assigned, so a light whose tier had been *removed* from `db/config.json` came back still
carrying `mood: true` from the last exit. `toggle()` reads the config and would no longer
publish it as a mood light, but `updateView()` reads the *model* and went on rendering a mood
step for it — a split brain that survives every restart and cannot be seen in the config.
Retiering five lights that day is what surfaced it.

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
