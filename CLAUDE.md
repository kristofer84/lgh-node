# lgh-node — agent guide

Home-automation web app for one apartment. An MQTT broker (Home Assistant topic tree) feeds a
Node/Express process that holds all device state **in memory**, pushes it over socket.io to an
SVG floorplan dashboard, and publishes toggle commands back to MQTT. Stack: plain **JavaScript
ESM** (no TypeScript, no build step, no tests, no lint) + **Express 4** + **socket.io 4** +
**mqtt.js** + two auth paths (**Microsoft MSAL / passport-azure-ad** and **WebAuthn passkeys /
@simplewebauthn**). ~1,700 lines of real code; served at `https://home.xcds.net`.

> **How this file is organised**: rules and the index only. Per-concern detail, data shapes and
> the full landmine list live in `docs/`. This file is loaded into every context window, so
> **keep it lean** — when you learn something domain-specific, write it into `docs/`, not here.

## Run it

- **Entry point is `mqtt-web.js`.** `server.js` is dead — every line is commented out. (A
  `node server.js` process is running in production and does nothing at all. Do not "fix" it.)
- `package.json` has **no `start` script** and no devDependencies. The actual production
  invocation, in tmux session `pi` window `nodeweb#`, cwd = repo root:
  `node --trace-warnings mqtt-web.js`
- **Requires `.env`.** `mqtt-web.js` calls `loadEnv()` from `env.js` before anything else and
  **exits 1 if `COOKIE_SECRET` is unset**. Copy `.env.example` → `.env` (gitignored) and fill in
  `COOKIE_SECRET` + the three `VAPID_*` vars. Changing `COOKIE_SECRET` invalidates all sessions.
- Listens on **`http://127.0.0.1:8080`**, plain HTTP. TLS + WebSocket upgrade are terminated by
  host nginx (`/etc/nginx/sites-available/xcds.net`, `#HOME 443` block → `base_config_443.conf`)
  at `home.xcds.net`. There is no TLS in this process; the commented-out `https.createServer`
  and `config.config.certFolder` are historical.
- `"type": "module"` — ESM only. `server-webn.js` uses **top-level `await`**.

> ⚠ **Production runs Node v22.0.0 — the only version installed** (2026-08-25: v18.7.0 and
> v19.8.1 were removed). It previously ran v18.7.0, which does not expose `globalThis.crypto`
> without `--experimental-global-webcrypto`; @simplewebauthn resolves it lazily, so *every*
> passkey operation failed until `server-webn.js` started assigning
> `globalThis.crypto = webcrypto` from `node:crypto`. **That shim and the hand-written `env.js`
> stay** — both are no-ops on v22 and are the reason the app is portable across versions.
> Boot resolves node via the nvm `default` alias, so no version path is hardcoded any more.

- Startup also reads `./log/mqtt.log` and `./db/config.json` **synchronously and unguarded** — a
  missing or malformed file is a startup crash. Both are gitignored, so a fresh clone will not
  boot until you create them (see `docs/mqtt-and-devices.md`).
- No dependency manifest agreement: `package-lock.json`, `pnpm-lock.yaml` and `node_modules/`
  all disagree in age. `node_modules/` is committed-adjacent reality — prefer not to reinstall.

## Hard rules

> **Route/middleware registration order in `mqtt-web.js` IS the authorization model.**
> There is no per-route guard. A route registered above `app.use(cookieMiddleware)` is public;
> one registered below it is authenticated. Adding a route in the wrong place silently exposes
> it or silently breaks it, with no error anywhere. Read `docs/auth.md` §1 before you add, move
> or reorder anything in that file. **Wrap every async route in `wrap()`** — that is what routes
> a throw to the terminal error handler instead of leaving it unhandled.

> **Never `git add` `db/`, `log/`, `.env` or `keys.txt`** — all four are gitignored and hold live
> secrets/state. Do not reproduce secret values in docs, commits or issues. `webauthn.json` *is*
> tracked (credential metadata) and the old VAPID private key is still in git history; see the
> ⚠ secrets row in `docs/where-things-live.md`.

> **New accounts are created `enabled: false` and are enabled by hand.** That is the entire
> access-control mechanism — there is no admin UI. `validate()` caches `db/users.json` in a
> module variable, so **stop the process before editing it**. Procedure: `docs/auth.md` §7.

## Where things live

**`docs/where-things-live.md` is the authoritative concern → file map** — per concern it records
the shape, the gotcha, and the bug already paid for. This table is only an index. ⚠ = that row
records a landmine (a confirmed bug, or a discipline that is load-bearing).

| Concern | Primary path |
|---|---|
| Process entry, express pipeline ⚠ | `mqtt-web.js` (lines 89–252 are the whole pipeline) |
| The auth gate + bypass allowlist ⚠ | `cookieMiddleware` in `mqtt-web.js` (~line 209) |
| Secrets / `.env` loading ⚠ | `env.js` + `.env` (gitignored) + `.env.example` (committed) |
| Session keys, users, enable/disable ⚠ | `user.js` → `db/users.json` (gitignored) |
| MSAL / Entra bearer validation | `bearerStrategy` in `mqtt-web.js` (~line 273) + `web/config.json` |
| WebAuthn register + login ⚠ | `server-webn.js` → `webauthn.json` (tracked!) |
| Client login UI | `web/login.html`, `web/public/login/{login,login-msal,login-webn}.js` |
| MQTT ingest + device state | `client.on('message')` in `mqtt-web.js` (~line 363) |
| Zone/device config ⚠ | `db/config.json` (gitignored) — `config.zones`, dotted device strings |
| Device state persistence ⚠ | `exitHandler` in `mqtt-web.js` → `log/mqtt.log`, **written only on exit** |
| socket.io wiring + auth bridge | `middlewareTransform` + `io.use(...)` in `mqtt-web.js` (~line 302) |
| Outbound commands | `publish()` in `mqtt-web.js` → `webapp/switch/<type>.<device>/state/set` |
| Dashboard page (SVG floorplan) ⚠ | `web/dashboard.html` + `web/scripts/home.js` + `web/styles/style.css` |
| Landing page | `web/index.html` + `web/script.js` (script.js is fully commented out) |
| PWA / service worker / web push | `web/manifest.json`, `web/scripts/sw*.js`, `notifications.js`, `subscription.js` |
| Logging | `log.js` — `log()` prints, `mqtt()` is a no-op, `debug()` gated by `const d = false` |
| Dead code ⚠ | `server.js`, `user.js.old`, `web/public/relative.html`, `web/manifest.json2` |

## Deep-dive docs (`docs/`)

**`docs/README.md` is the annotated index.** The three that constrain day-to-day work:

- `docs/where-things-live.md` — full concern → file map + every ⚠ landmine, recorded in full
- `docs/auth.md` — both auth paths end-to-end, `db/users.json` / `webauthn.json` shapes, how to
  enable a user by hand, and the hardening pass's before/after
- `docs/mqtt-and-devices.md` — topic convention, `db/config.json` format, `getDevice()` output,
  the socket.io event contract, and the exit-only persistence quirk

## Conventions

- Tabs in `mqtt-web.js` / `user.js` / `log.js` / `env.js`; 4 spaces in `server-webn.js`,
  `notifications.js` and `web/public/`. Match the file you are in; there is no formatter.
- Device names, zone names and UI strings are **Swedish** (`sovrum`, `kok`, `tvattstuga`).
  Keep them; they are keys, not prose.
- There is no test suite and no CI. Verification means reading the code and restarting the
  process by hand. **Edits are not live until that restart.**
- Commit messages end with: `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
