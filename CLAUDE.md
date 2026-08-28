# lgh-node — agent guide

Home-automation web app for one apartment. An MQTT broker (Home Assistant topic tree) feeds a
Node/Express process that holds all device state **in memory**, pushes it over socket.io to an
SVG floorplan dashboard, and publishes toggle commands back to MQTT. Stack: plain **JavaScript
ESM**, type-checked in place — JSDoc types + `npm run typecheck`, **still no build step and no
`.ts` files**; tests are `npm test`, zero-dependency `node --test` — + **Express 4** + **socket.io 4** +
**mqtt.js** + two auth paths (**Microsoft MSAL / passport-azure-ad** and **WebAuthn passkeys /
@simplewebauthn**). ~1,700 lines of real code; served at `https://home.xcds.net`.

> **How this file is organised**: rules and the index only. Per-concern detail, data shapes and
> the full landmine list live in `docs/`. This file is loaded into every context window, so
> **keep it lean** — when you learn something domain-specific, write it into `docs/`, not here.

## Run it

- **Entry point is `mqtt-web.js`.** `server.js` is dead — every line is commented out. (A
  `node server.js` process is running in production and does nothing at all. Do not "fix" it.)
- `package.json` still has **no devDependencies** — the scripts it does have wrap the plain
  commands and add nothing: `npm start` is exactly the production invocation, in tmux session
  `pi` window `nodeweb#`, cwd = repo root: `node --trace-warnings mqtt-web.js`.
  `npm run dev` is the same under `node --watch`. `npm test`, `npm run typecheck[:watch]`,
  `npm run floorplan[:check]`.
- ⚠ **TypeScript is installed in `tools/typecheck/`, deliberately outside the app's tree.**
  `npm install --save-dev typescript` at the root wants to add **225 packages and change 13** —
  express 4.19.2→4.22.2, socket.io 4.7.5→4.8.3, body-parser 1.20.2→1.20.6 — because
  `package-lock.json` is from 2022, `pnpm-lock.yaml` from 2024 and `node_modules/` agrees with
  neither. Do not install it at the root. A fresh clone runs
  `npm install --prefix tools/typecheck` once. `npx tsc` will NOT find it; use
  `npm run typecheck:watch`.
- **Requires `.env`.** `mqtt-web.js` calls `loadEnv()` from `env.js` before anything else and
  **exits 1 if `COOKIE_SECRET` is unset**. Copy `.env.example` → `.env` (gitignored) and fill in
  `COOKIE_SECRET` + the three `VAPID_*` vars. Changing `COOKIE_SECRET` invalidates all sessions.
- Listens on **`http://127.0.0.1:8080`**, plain HTTP — or `$PORT` if set, which exists so the
  app can be smoke-tested without fighting the running process for the port. TLS + WebSocket upgrade are terminated by
  host nginx (`/etc/nginx/sites-available/xcds.net`, `#HOME 443` block → `base_config_443.conf`)
  at `home.xcds.net`. There is no TLS in this process; the commented-out `https.createServer`
  and `config.config.certFolder` are historical.
- `"type": "module"` — ESM only. `server-webn.js` uses **top-level `await`**.

> ⚠ **Production runs Node v22.0.0 — the only version installed** (2026-08-25: v18.7.0 and
> v19.8.1 were removed). **The `globalThis.crypto = webcrypto` shim in `server-webn.js` and the
> hand-written `env.js` stay** — no-ops on v22, but without them every passkey operation failed
> on v18. Boot resolves node via the nvm `default` alias; never hardcode a version path.
> Why, in full: `docs/where-things-live.md` → "The Node runtime".

- Startup also reads `./log/mqtt.log` and `./db/config.json` **synchronously and unguarded** — a
  missing/malformed file is a startup crash. Both are gitignored, so a fresh clone will not boot
  until you create them, and the floorplan cannot be regenerated without `db/config.json`
  either (see `docs/mqtt-and-devices.md`).
- **Dependencies were rebuilt 2026-08-28** — `package-lock.json` is now authoritative and
  `pnpm-lock.yaml` is gone (it was two years out of step). `npm audit`: **0 vulnerabilities**,
  down from 23 (14 high). 13 dependencies → **7**: `@simplewebauthn/server` 13, `cookie-parser`,
  `express` **5**, `jose`, `mqtt` **5**, `socket.io`, `web-push`.
  ⚠ **`passport` and `passport-azure-ad` are gone.** Microsoft deprecated the latter ("no longer
  supported", no release left to take) and it pulled in `jsonwebtoken`/`jws`/`lodash` carrying
  *signature-validation-bypass* advisories — on the token-verification path. Entra tokens are
  now verified by `requireEntraToken()` in `mqtt-web.js` using **`jose`** (zero-dependency,
  does JWKS fetch/cache/rotation itself). Do not reach for `@azure/msal-node` here: MSAL Node
  *acquires* tokens and has no resource-server validation API. The browser side is unchanged —
  `login.html` still loads `msal-browser` from the CDN to get the token.
  ⚠ Also removed as **entirely unused**: `@azure/msal-node`, `@microsoft/microsoft-graph-client`,
  `isomorphic-fetch`, `concat-stream` (only ever in a commented-out line), and `body-parser`
  (redundant — `express.json()` was already registered ten lines later).

## Hard rules

> **Route/middleware registration order in `mqtt-web.js` IS the authorization model.**
> There is no per-route guard. A route registered above `app.use(cookieMiddleware)` is public;
> one registered below it is authenticated. Adding a route in the wrong place silently exposes
> it or silently breaks it, with no error anywhere. Read `docs/auth.md` §1 before you add, move
> or reorder anything in that file. **Wrap every async route in `wrap()`** — that is what routes
> a throw to the terminal error handler instead of leaving it unhandled.

> ⚠ **`web/dashboard.html` is GENERATED — never hand-edit it.** `node tools/floorplan/generate.mjs`
> builds it from `db/config.json` + the drawing (`--check` fails when it is stale) and silently
> discards any hand edit. **`db/config.json` is the source of truth for what appears on the
> floorplan** — change it (or `tools/floorplan/lights.json`), then regenerate.
> **`tools/floorplan/README.md` is that pipeline's own doc; read it first.**

> **Never `git add` `db/`, `log/`, `.env` or `keys.txt`** — all four are gitignored and hold live
> secrets/state. Do not reproduce secret values in docs, commits or issues. `webauthn.json` *is*
> tracked (credential metadata) and the old VAPID private key is still in git history; see the
> ⚠ secrets row in `docs/where-things-live.md`.

> **New accounts are created `enabled: false` and are enabled by hand.** That is the entire
> access-control mechanism — there is no admin UI. `validate()` caches `db/users.json` in a
> module variable, so **stop the process before editing it**. Procedure: `docs/auth.md` §7.

## Where things live

**`docs/where-things-live.md` is the authoritative concern → file map** — per concern it records
the shape, the gotcha, and the bug already paid for. This table is only an index; ⚠ = that row
records a landmine (a confirmed bug, or a load-bearing discipline).

| Concern | Primary path |
|---|---|
| Process entry, express pipeline ⚠ | `mqtt-web.js` (lines 89–252 are the whole pipeline) |
| The auth gate + bypass allowlist ⚠ | `cookieMiddleware` in `mqtt-web.js` (~line 209) |
| Secrets / `.env` loading ⚠ | `env.js` + `.env` (gitignored) + `.env.example` (committed) |
| Session keys, users, enable/disable ⚠ | `user.js` → `db/users.json` (gitignored) |
| MSAL / Entra bearer validation | `bearerStrategy` in `mqtt-web.js` (~line 273) + `web/config.json` |
| WebAuthn register + login ⚠ | `server-webn.js` → `webauthn.json` (tracked!) |
| Client login UI | `web/login.html`, `web/public/login/{login,login-msal,login-webn}.js` |
| MQTT ingest + device state | `client.on('message')` in `mqtt-web.js` (~line 363); ⚠ **what HA publishes at all** is `mqtt_statestream:` in `/media/storage/ha/homeassistant/configuration.yaml`, outside this repo |
| Zone/device config ⚠ | `db/config.json` (gitignored) — `config.zones`. Switchable devices are objects with explicit `steps`; sensors keep the legacy dotted string. **Source of truth for the floorplan** |
| Light settings page ⚠ | `web/config.html` + `web/scripts/config.js` + `web/styles/config.css`; `GET`/`POST /config/zones` in `mqtt-web.js` — **must stay below `cookieMiddleware`** |
| Zone grammar + step semantics ⚠ | `web/scripts/zones.js` — **shared by the server, the floorplan builder and the browser**. Parses `device.type[.tier[.level]]`, decides what a step publishes (`sceneFor`) and which step a room is in (`stepOf`). Under `web/` because that is the only place all three can import it without a build step |
| Tests | `test/` — `npm test`. `helpers.mjs` documents the source-extraction harness |
| Type checking ⚠ | `tsconfig.json` (`checkJs` + `noEmit`) + `types/globals.d.ts` + `tools/typecheck/` (isolated install). Types live in JSDoc comments in the `.js` files; nothing is compiled and nothing is emitted |
| Floorplan generator ⚠ | `tools/floorplan/` — `generate.mjs`, `geometry.json`, `lights.json`, `base.svg`, its own `README.md` |
| Device state persistence ⚠ | `exitHandler` in `mqtt-web.js` → `log/mqtt.log`, **written only on exit** |
| socket.io wiring + auth bridge | `middlewareTransform` + `io.use(...)` in `mqtt-web.js` (~line 302) |
| Outbound commands | `publish()` in `mqtt-web.js` → `webapp/switch/<type>.<device>/state/set` |
| Dashboard page (SVG floorplan) ⚠ | `web/dashboard.html` (**generated**) + `web/scripts/home.js` + `web/styles/style.css` |
| Landing page | `web/index.html` + `web/script.js` (script.js is fully commented out) |
| PWA / service worker / web push | `web/manifest.json`, `web/scripts/sw*.js`, `notifications.js`, `subscription.js` |
| Logging | `log.js` — `log()` prints, `mqtt()` is a no-op, `debug()` gated by `const d = false` |
| Dead code ⚠ | `server.js`, `user.js.old`, `web/public/relative.html`, `web/manifest.json2` |

## Deep-dive docs (`docs/`)

**`docs/README.md` is the annotated index.** The four that constrain day-to-day work:

- `docs/where-things-live.md` — full concern → file map + every ⚠ landmine, recorded in full
- `docs/auth.md` — both auth paths end-to-end, `db/users.json` / `webauthn.json` shapes, how to
  enable a user by hand, and the hardening pass's before/after
- `docs/mqtt-and-devices.md` — what HA publishes and what it does not, the topic convention,
  `db/config.json` + the 22 zones, `getDevice()`, the socket.io contract, and §8: where the
  config came from and what is still guesswork
- `tools/floorplan/README.md` — the dashboard generator: inputs, geometry re-extraction from the
  Inkscape drawing, and the clip/scale/label landmines

## Conventions

- Tabs in `mqtt-web.js` / `user.js` / `log.js` / `env.js`; 4 spaces in `server-webn.js`,
  `notifications.js` and `web/public/`. Match the file you are in; there is no formatter.
- Device/zone names and UI strings are **Swedish** (`vardagsrum`, `kok`, `tvatt`, `klk1`) — keys,
  not prose. The apartment changed; the old `sovrum` / `kontor` / `dusch` / `garderob` / `entre`
  names are gone. Current zone list: `docs/mqtt-and-devices.md` §5.
- **`npm run typecheck` — 0 errors, and it must stay that way.** `checkJs` with `noEmit`: the
  `.js` on disk is what runs, the browser still loads `web/scripts/*.js` directly, and types are
  JSDoc comments. Deliberately lenient (`strict: false`, `noImplicitAny: false`) because most
  dependencies here ship no types and turning those on drowns the signal; what it does catch is
  typos, wrong arity, calling a non-function and reading through an undefined. It found a real
  bug on its first run — see the `log()` note in `log.js`.
- **`npm test` — 19 tests, no dependencies, ~0.4 s.** Still no CI, and the tests cover the
  device/zone logic only, not the express pipeline or auth. They run against the *real*
  `db/config.json`, so a bad config edit fails them. Several encode a bug that actually
  happened and are marked ⚠; every one has been checked by reintroducing its bug and watching
  it fail. `test/helpers.mjs` explains why they evaluate `mqtt-web.js`'s source text rather
  than importing it. Beyond that, verification still means reading the code and restarting the
  process by hand. **Edits are not live until that restart.**
- Commit messages end with: `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
