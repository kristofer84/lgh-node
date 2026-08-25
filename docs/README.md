# `docs/` — annotated index

> Written 2026-08-25, the first documentation this repo has ever had. The root `CLAUDE.md`
> holds only the rules and the concern index; the detail lives here so the always-loaded
> context stays small.
>
> **Scope stamp: these docs describe the working tree** — commit `eb19c0d` plus two uncommitted
> passes of 2026-08-25:
>
> 1. the **auth-hardening pass** (`env.js`, `.env.example`, `mqtt-web.js`, `user.js`,
>    `server-webn.js`, `notifications.js`, `web/login.html`, `web/public/login/*`);
> 2. the **new-apartment pass** — the floorplan was replaced with a larger, 18-room layout,
>    `db/config.json` was rebuilt from the Home Assistant registries, and `web/dashboard.html`
>    became **generated output** of the new `tools/floorplan/` pipeline — which also rewrites the
>    artwork's inline `style=""` attributes into presentation attributes, so the strict CSP
>    survives unchanged. Alongside it: the `switch` branch in `getDevice()`, a null guard in
>    `updateView()`, and retuned room opacities in `style.css`.
>
> **Nothing here is committed yet**, so line numbers and behaviour move with `git stash`.
> `where-things-live.md` ends with a before/after table per pass, so a stale note from before
> them can be reconciled rather than re-reported as a live bug.
>
> ⚠ **Every room, zone and device name in these docs is the *new* apartment's.** A note that
> uses `sovrum`, `kontor`, `dusch`, `garderob`, `entre`, `vardagsrum-kok`, `hall-sovrum`,
> `hall-tvattstuga`, `sovrum-mk`, `garderob-kontor`, `tvattstuga` or `schakt` as a *zone name*
> predates this pass. (`orangeri` and `balkong` exist in both plans — those two are not a tell.)
>
> Each entry says what the doc *establishes*, not just what it covers — read the line before
> deciding whether you need the doc.

## Deep-dive docs

- `where-things-live.md` — **the authoritative concern → file map**, and the single place every
  ⚠ landmine is recorded in full. The current ones: **`web/dashboard.html` being generated
  output that must never be hand-edited**, the **Web Crypto shim** (a Node 18 legacy, kept for
  portability) that passkey login cannot run without, route order being the authorization model,
  `/dashboard` and all of `web/public/` being anonymously served, exit-only `log/mqtt.log`
  persistence, `validate()` caching `db/users.json` so hand-edits during a run are lost, open
  registration for new usernames, `webauthn.json` tracked in git plus secrets still in git
  history, the `.env` quoting rule, the HA area registry being untrustworthy, and the CSP
  having **no `'unsafe-inline'` anywhere** — which now also constrains the floorplan generator,
  since `style-src` governs `style=""` attributes and Inkscape artwork is full of them. Ends
  with a fixed-in-this-pass table per pass. **Read the matching row before touching a domain.**
- `auth.md` — **read before touching anything under `/login`, `/register`, `/key-*`, `env.js` or
  `cookieMiddleware`.** The full request/response sequence for MSAL and for WebAuthn
  registration and login; how both converge on `user.js` `validate()` → generated key → signed
  httpOnly cookie → `validateKey()` (which now re-checks `enabled` on every request); the exact
  `db/users.json` and `webauthn.json` shapes including the `webauthn:<username>` keyspace and the
  live migration that produced it; the manual `enabled: true` flip that *is* the access-control
  mechanism, in §7. §3 carries the **account-takeover fix** — adding a passkey to an existing
  username now requires a session as that user; do not relax it. §6 is the current landmine list,
  §8 the before/after.
- `mqtt-and-devices.md` — **read before touching MQTT ingest, `db/config.json`, `getDevice()`
  or the dashboard's data contract.** §2 is what Home Assistant publishes *at all* (a pure
  allowlist in `configuration.yaml`, outside this repo — `sensor` is not a domain,
  `binary_sensor` is never published, and two globs in it match nothing). Then the
  `homeassistant/<type>/<device>/<valueType>` inbound convention (including the ⚠ `climate`
  remap) and the `webapp/switch/...` outbound one, the dotted `zone` → device-string format with
  its `.mood` / `.night` suffixes, **the 22 zones of the new apartment and why `db/config.json`
  is now the floorplan's source of truth**, the two different shapes `getDevice()` returns, the
  `device` / `device.all` / `toggle` socket.io events, ⚠ §8 on the untrustworthy HA area
  registry plus **the list of still-open gaps**, and the ⚠ quirk that device state is persisted
  to `log/mqtt.log` **only in `exitHandler`** — `SIGINT`/`SIGTERM` now save, `SIGKILL` and OOM
  still lose everything.

## Outside `docs/`, but read like a deep dive

- `../tools/floorplan/README.md` — **the dashboard generator.** `web/dashboard.html` is its
  output; `node tools/floorplan/generate.mjs --check` tells you whether the checked-in file is
  stale. Covers the four naming contracts it makes true by construction, the inputs
  (`geometry.json`, `base.svg`, `lights.json`, `dashboard.template.html`, `db/config.json`),
  re-extracting geometry from a new Inkscape drawing, and the landmines: outline polygons must
  live in `<defs>` or the clip is a circular reference and glows bleed through walls; the
  `viewBox` `0 0 354 692` is the implicit unit for every size in `style.css`; room names come
  from rendered `<text>`, not from the stale `inkscape:label` attributes.

## Not documented here

There is no build, test, migration, deployment or CI documentation because none of those things
exist in this repo. Deploy = edit the file, restart the process in tmux session `pi`.
**Nothing in the working tree is live until that restart.**

⚠ **As of this writing the live site is in a split state and needs a restart.** The
`node --trace-warnings mqtt-web.js` process started 2026-08-25 10:49, so it has the hardened
server code but holds the **old** `db/config.json` in memory (that file was rebuilt at 13:16 and
is only read at startup). Meanwhile `express.static` serves the **new** generated
`web/dashboard.html` from disk on every request. So every room on the page currently resolves
against zones the server no longer has. Restart the process in tmux session `pi`. Note that the
next clean exit will also write the *old* device model back over `log/mqtt.log`; that is
harmless (`init()` recreates missing entries) but leaves dead entries for removed devices.

The one thing that behaves like a build step is `node tools/floorplan/generate.mjs`, and it is
not wired into anything: no hook, no CI, no pre-commit. Run it by hand after editing
`db/config.json`, and `--check` before committing.
