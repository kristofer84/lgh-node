# Where things live — the full concern → file map

> The root `CLAUDE.md` keeps a one-line-per-concern index; **this file is the authoritative
> detail**. Before you touch a domain listed here, read its row.
>
> ⚠ marks a landmine: a confirmed bug, or a discipline that is load-bearing.
>
> **Verified 2026-08-25 against the working tree** — commit `eb19c0d` plus the uncommitted
> auth-hardening pass (`env.js`, `.env.example`, `mqtt-web.js`, `user.js`, `server-webn.js`,
> `notifications.js`, `web/login.html`, `web/scripts/home.js`, `web/public/login/*`). Line
> numbers refer to that working tree, so `git diff`/`git stash` will move them.
>
> Keep it current: when you change how a concern works, update the row here, not in `CLAUDE.md`.

## Repo inventory

| Path | What it is |
|---|---|
| `mqtt-web.js` | **The whole server.** ~756 lines: express pipeline, routes, MQTT client, socket.io, device model, exit handler. |
| `server-webn.js` | WebAuthn registration + login routes, mounted by `registerWebnMethods(app)`. Owns `webauthn.json`. Exports `webauthnOid()`. |
| `user.js` | Session identity: `validate()`, `validateKey()`, `setCookie()`. Owns `db/users.json`. |
| `env.js` | ~45-line dependency-free `.env` parser. `loadEnv()` is the first thing `mqtt-web.js` runs. |
| `subscription.js` | Web-push subscription store. Owns `db/subscriptions.json`. |
| `notifications.js` | Sends a hardcoded demo web-push notification. Reads VAPID from `process.env`, lazily. |
| `log.js` | `log()` (prints), `mqtt()` (no-op — body commented out), `debug()` (gated by `const d = false`). |
| `server.js` | **Dead.** Every line commented out. A `node server.js` process runs in production and does nothing. |
| `user.js.old` | Dead. Pre-ESM version of `user.js`. |
| `.env` | **Gitignored** (`.gitignore` line 79), present, mode 0600. `COOKIE_SECRET` + `VAPID_*`. |
| `.env.example` | Committed template. |
| `db/` | **Gitignored** (line 5). `config.json` (zones/devices/mqtt address), `users.json` (+ `.bak-*`), `subscriptions.json`, `key.secret`. |
| `log/` | **Gitignored** (line 4). `log/mqtt.log` is not a log — it is the device-state snapshot. |
| `keys.txt` | **Gitignored** (line 1). Plain-text copy of the old VAPID keypair. |
| `webauthn.json` | **Tracked in git.** Registered passkeys per username. |
| `web/` | Static root, served by `express.static('./web', { index: false, extensions: ['html'] })`. |
| `web/public/relative.html`, `web/manifest.json2` | Dead scratch files — but see the ⚠ dead-code row. |
| `web/script.js` | Dead — entirely commented out, but still `<script src>`-ed by `index.html`. |

---

## Concern rows

### Process entry + express pipeline ⚠ — `mqtt-web.js`

The registration order between lines 116 and 252 **is the authorization model**. There is no
per-route guard anywhere in the codebase. In order:

| # | Line | What | Effect on authz |
|---|---|---|---|
| 1 | 116 | `bodyParser.json()` | parses JSON body for everything below |
| 2 | 117 | `logMiddleware` | `log(x-forwarded-for + ': ' + path)` |
| 3 | 118 | security headers: **CSP (now actually sent)**, `x-content-type-options`, `referrer-policy`, `permissions-policy` | |
| 4 | 126–127 | `express.json()`, `express.urlencoded()` | redundant with (1) |
| 5 | 129 | `GET /` → `web/index.html` | **public** |
| 6 | 133 | `GET /moja` → outdoor temp/pressure/humidity JSON | **public**, deliberately (external consumer) |
| 7 | 143–147 | `COOKIE_SECRET` read, **`process.exit(1)` if unset** | fail-fast, not authz |
| 8 | 149 | `cookieParser(cookieSecret)` | |
| 9 | 150 | `registerWebnMethods(app)` | **all `/register/*` and `/login/*` are public — deliberately, they must be reachable pre-auth** |
| 10 | 151 | `passport.initialize()` | |
| **11** | **153** | **`cookieMiddleware`** | ← **the auth gate**. Everything registered after this line is authenticated unless it is in the bypass allowlist. |
| 12 | 158 | `app.options('*')` | now has its parameters the right way round and ends the response with 204 |
| 13 | 170 | `GET /key-msal` (+ `passport.authenticate('oauth-bearer')`) | in the bypass list, then guarded by passport instead |
| 14 | 176–202 | `/refresh-key`, `/push`, `POST /subscribe` | **authenticated** |
| 15 | 238 | `express.static('./web')` | **authenticated**, except bypassed paths |
| 16 | 244 | **terminal 4-arg error handler** | must stay last |

⚠ **Every async route is wrapped in `wrap()`** (line 95): `Promise.resolve(handler(...)).catch(next)`.
Express 4 does not catch rejections from `async` handlers, so an unwrapped one becomes an
unhandled rejection. **Add `wrap()` to any async route you write** — the same helper exists
separately in `server-webn.js` (line 59) for that file's routes.

The error handler (line 244) honours `err.status` / `err.statusCode`, so body-parser's own errors
surface correctly (malformed JSON → 400, oversized body → 413) and everything else is a 500 with
a generic `{"error":"internal error"}` body. It logs the stack only for 500s.

`const server = createServer(app)` is created at line 154 — *before* the routes below it are
registered. That is fine (express resolves at request time) but it reads misleadingly.

### The auth gate + bypass allowlist ⚠ — `cookieMiddleware`, `mqtt-web.js` ~209

```js
const bypass = ['/style.css', '/code.png', '/favicon-192.png', '/login', '/sk.jpeg',
                '/favicon.ico', '/key-msal', '/config.json', '/manifest.json',
                '/scripts/sw.js', '/scripts/sw-init.js', '/init.js', '/dashboard'];
```
Plus any path starting with `/static/` or `/public/`. Everything else needs a valid signed cookie.

- ⚠ **`/dashboard` is in the allowlist**, so the dashboard HTML is served to anyone. What
  actually keeps it useless to an anonymous visitor is that its sub-resources are *not*
  allowlisted: `/styles/style.css` and `/scripts/home.js` 401, and `init.js` (which *is*
  allowlisted) fetches `/refresh-key`, gets 401, and does `window.location.href = '/login'`.
  So "the dashboard 401s" is shorthand — the page returns 200 and then bounces. Be precise
  about this when reasoning about a login bug.
- ⚠ **`/public/` is allowlisted as a prefix**, which is what makes the login JS modules
  reachable pre-auth — and also makes every other file under `web/public/` anonymously
  reachable. See the dead-code row.
- `/socket.io/*` is **not** in the list and does not need to be: `new Server(server)` installs
  its own request listener ahead of express, so those requests never reach `cookieMiddleware`.
  Do not "fix" this by adding it to the list.
- Key lookup is now **only** `req.signedCookies?.key`. The old
  `req.headers.authorization?.key` fallback is gone, and so is the object-in-a-header-slot
  quirk that used to depend on it.
- On failure: `res.statusCode = 401; res.end()`. No body, no `WWW-Authenticate`.

### Secrets and `.env` ⚠ — `env.js`, `.env`, `.env.example`

`loadEnv()` runs as the first statement of `mqtt-web.js`, before any other import's side effects
can matter. It is deliberately hand-written: ⚠ `process.loadEnvFile()` would do the same job but
needs **Node ≥20.12**, and production ran Node 18 when this was written (see the Node row).
Production is now v22, where `process.loadEnvFile()` would work — `env.js` is kept deliberately,
because it is version-proof and documents the `#`-quoting trap below.

- ⚠ **Quoting.** `.env.example` and `env.js`'s own header say an unquoted value is truncated at
  the first `#`. **The code is actually looser than that**: `env.js` strips a trailing comment
  only at `' #'` (space-then-hash, line 38), so `abc#def` unquoted survives. Follow the
  documented rule anyway — quote anything containing `#`. Real environment variables win over
  the file (line 43), so an env var set in the shell overrides `.env`.
- ⚠ **`notifications.js` must read `process.env` lazily.** ESM hoists imports, so every imported
  module is evaluated *before* `loadEnv()` runs. `getVapidDetails()` is called inside
  `sendNotifications()` for exactly this reason — **do not hoist it back to module scope.**
  If the vars are missing, push is skipped with a log line rather than throwing.
- ⚠ **The old VAPID private key is still in git history at commit `ce9d9e3`.** It is out of the
  source now, but history is history. The operator has decided **not to rotate** it (private
  repo). Rotating would force every push client to re-subscribe. Do not reproduce the value.
- ⚠ **`webauthn.json` is tracked in git** and holds credential IDs, public keys, AAGUIDs and
  usernames. Public keys are not secret, but this is credential metadata / PII living in git.
  Do not make it worse.
- The cookie secret is no longer a source literal — it comes from `COOKIE_SECRET`, and the
  process **exits 1 at startup if it is unset**. The old literal is still in git history.
- `db/key.secret` exists (194 bytes) and is read by `getHmacKey()` — which is only called by
  `getHash()`, which **nothing calls**. It is a leftover of a removed password path.

### The Node runtime ⚠ — history worth knowing

**Production runs Node v22.0.0, and it is the only version installed.** As of 2026-08-25,
v18.7.0 and v19.8.1 were uninstalled from nvm; `default -> node -> stable -> v22.0.0`.

⚠ **Nothing may hardcode a version path again.** `/media/storage/code/home-config/home/scripts/nodeweb.sh`
(the `@reboot` cron that starts this app *and* `www-node` in byobu session `pi`) used to pin
`/home/ha/.nvm/versions/node/v18.7.0/bin/node`. Uninstalling v18 would have broken **both** apps
at the next reboot. It now resolves `NODE="$(. "$HOME/.nvm/nvm.sh"; nvm which default)"`, verified
to work under a minimal cron environment. If you add a service, resolve node the same way.

The v18 era left two pieces of defensive code. **Both stay** — they are no-ops on v22 and cost
nothing:

- ⚠ **`server-webn.js` assigns `globalThis.crypto = webcrypto`** from `node:crypto`. Node 18 did
  not expose `globalThis.crypto` without `--experimental-global-webcrypto`, and
  `@simplewebauthn/server` v10 resolves it lazily — so **every passkey operation failed** with
  *"An instance of the Crypto API could not be located"* and `/login/start` returned 500. That
  was a live outage and the main reason passkeys "worked so-so". The guard is `if (!globalThis.crypto)`,
  so on v22 it does nothing.
- ⚠ `process.loadEnvFile()` needs Node ≥20.12 — `env.js` predates the upgrade and is kept.
- `@simplewebauthn/server@10` declares `engines: >=20`, which v22 now genuinely satisfies.
- Node ≥16 is the hard floor regardless (`atob`/`btoa` globals, used by both base64url helpers).

### Session identity + the enable gate ⚠ — `user.js` → `db/users.json`

Shapes, the manual enable step and the full auth sequences are in **`docs/auth.md`** — read that
file, not this row, before touching auth.

- ⚠ **New users are created with `enabled: false` and must be flipped by hand.** That *is* the
  access-control mechanism; there is no admin UI, no invite, no allowlist of emails.
- ⚠ **`validate()` caches `config` in a module-level variable** and only re-reads it on first
  use. **Editing `db/users.json` while the process is running is silently overwritten** by the
  next `saveDb()`. Stop the process, edit, restart. (Still true after the hardening pass.)
- `validateKey()` now rejects non-string keys **and re-checks `enabled`**, so disabling an
  account revokes live cookies on the next request. Setting `enabled: false` is now sufficient
  to revoke — the older advice to also delete `generatedKey` and its `keys` entry no longer
  applies (it is still a reasonable belt-and-braces step).
- `setCookie()` returns **403 and sets no cookie** when the key is falsy, instead of signing the
  string `"undefined"` and answering 204.
- `generatedKey` is a `randomUUID()`, never rotated and never expiring. The cookie's 7-day
  `maxAge` is the only expiry, and `/refresh-key` re-issues it on every dashboard load.

### WebAuthn ⚠ — `server-webn.js` → `webauthn.json`

Full sequences and data shapes: **`docs/auth.md`**. What matters here:

- ⚠ **Registering a passkey onto an *existing* username requires being signed in as that user**
  (`currentUser(req)` vs `caller.preferred_username !== username`, checked in **both**
  `/register/start` and `/register/finish`). This closes a real account-takeover path: anyone
  could previously POST `/register/finish` for an existing username, get their credential
  appended to that user's key list, and then log in as them. **Do not relax this check**, and if
  you add another registration entry point, replicate it.
- Registration for a **brand-new** username is still open to the internet (`allowNewUsers = true`,
  line 53). New accounts land `enabled: false`, and `/register/finish` now also calls
  `validate(webauthnOid(username), username)` so the `db/users.json` record exists to be enabled.
- ⚠ **Identity keyspace**: passkey accounts are keyed **`webauthn:<username>`** via the exported
  `webauthnOid()`, so all of one person's passkeys are **one** account enabled once. MSAL
  accounts remain keyed by the Entra `oid`. The two keyspaces are still unlinked — the same human
  signing in both ways is still two records, by design.
- `ExpiringStore` (5-minute TTL, single-use `take()`) replaces the two `new Map()` objects that
  were used with `map[key] = value` property syntax and therefore never cleaned up. `take()`
  deletes on read, so a challenge is not replayable.
- The signature counter is persisted after each successful login
  (`authenticator.counter = authenticationInfo.newCounter; saveDb()`), so replay detection is
  live. `saveDb()` there is intentionally not awaited — writes are serialized through
  `writeChain`.
- `serialize()` builds a fresh object instead of mutating the live one. The old code encoded
  every key in place, wrote, then decoded again — a throw between those loops left every public
  key in memory as a string.
- `userVerification: 'required'` is now set on **both** ends. It was `'preferred'` on the server
  while `verifyRegistrationResponse` defaults to requiring it, which produced registrations the
  server then refused.
- ⚠ `currentUser()` compares `caller.preferred_username` to the requested `username`. An
  MSAL-authenticated caller's `preferred_username` is an **email address**, so an MSAL session
  cannot add a passkey to a `webauthn:<name>` account unless the strings happen to match. That
  is the current behaviour, not necessarily the intended one — treat it as a known edge, not a
  bug to silently "fix".

### socket.io wiring + the auth bridge — `mqtt-web.js` 296–333, 495–542

- `io.use(middlewareTransform(cookieMiddleware))` — the socket handshake reuses **the same**
  express middleware. `middlewareTransform` now runs a dedicated `cookieParser(cookieSecret)`
  over `socket.request` first, so `req.signedCookies` is populated, then calls the middleware
  with a faked `res` (`setHeader` → no-op, `end` → `next(new Error('authentication_error'))`)
  behind a `settled` flag so `next` can only fire once.
- The handshake is same-origin, so the browser sends the session cookie automatically.
  `web/scripts/home.js` just calls `io()` with no auth callback. Nothing exposes the session key
  to page JavaScript any more — `/key-from-cookie` and `/cookies` have been **deleted**.
- `socket.request` is a raw `IncomingMessage` and has no `.path`, so the bypass allowlist is
  inert for sockets — correctly so: every socket must present a cookie.
- `connections` is `set` in `middlewareTransform` and **deleted** in the `disconnect` handler;
  `io.on('connection')` reads it as `user?.user ?? ''`. Both were leaks/crashes before.

### Web push — `notifications.js`, `subscription.js`, `web/scripts/sw*.js`

- `GET /push` (authenticated) sends a hardcoded `"Hello, Notifications!"` demo payload to
  **every** stored subscription. There is no real notification feature.
- `POST /subscribe` (authenticated) rejects a body without `endpoint` with a 400, then stores the
  subscription keyed by `req.user?.preferred_username`. That key is now reliably a string (the
  array leak is fixed in `validate()` and at `keyUserMap`'s source).
- ⚠ The VAPID **public** key is duplicated in `web/scripts/sw-init.js` as a literal and in `.env`
  as `VAPID_PUBLIC_KEY`. **Keep them in sync** — `.env.example` says so too. A mismatch makes
  every push silently undeliverable.
- `sw-init.js` unconditionally does `document.getElementById('subscribe').addEventListener(...)`
  — it is loaded at the bottom of `dashboard.html`, which has that element, so it works there
  and would throw on any other page. It also still has a debug `alert('click')`.

### Content Security Policy — `mqtt-web.js` 99–124

The CSP **is now sent** (`res.header('content-security-policy', csp.join('; '))`, line 119). It
was assembled and then never emitted before.

⚠ **The policy has no `'unsafe-inline'` anywhere, and that is only viable because `web/` has no
inline `<script>`/`<style>` and no `style=""` attributes.** Removing eruda from `login.html` is
what made it viable. **Adding any inline script or style will break the page silently** — put it
in a file under `web/` instead. `default-src 'none'`, plus `base-uri 'none'`,
`frame-ancestors 'none'`, `form-action 'self'`.

Allowed third-party origins, all of which the pages genuinely use: `alcdn.msauth.net` and
`ajax.googleapis.com` (script), `login.microsoftonline.com` (connect + frame),
`login.live.com` (frame), `fonts.googleapis.com` + `cdnjs.cloudflare.com` (style),
`fonts.gstatic.com` + `cdnjs.cloudflare.com` (font).

### Dead code ⚠

- `server.js` and `user.js.old` are inert; nothing imports them.
- ⚠ **`web/public/relative.html` is a dead scratch page that is anonymously reachable**, because
  the bypass allowlist passes everything under `/public/`. It also contains a real inline
  `<script>`, which the new CSP will block — so it is now a broken page served to the public.
  Deleting it is the obvious call, but it is a source file, so ask first.
- `web/manifest.json2` is unreferenced. `web/script.js` is fully commented out yet still loaded
  by `index.html`.
- `getHash()` / `getHmacKey()` in `user.js` are called by nothing (see the secrets row).
- `getAuthenticationOptions()` used to sit unused at the bottom of `server-webn.js` and is gone
  in the rewrite.

### Dashboard ⚠ — `web/dashboard.html`, `web/scripts/home.js`, `web/styles/style.css`

- One inline SVG floorplan (`viewBox="0 0 342 620"`); each room is a `<g class="room" id="<zone>">`
  whose `id` **must match a key of `config.zones`** in `db/config.json`, and each
  `class="item"` element's `id` **must match a device name** in that zone's list.
- ⚠ **There is a live mismatch right now** (from an uncommitted edit that predates the auth pass,
  not part of it): `dashboard.html` renames three item ids — `sovrum_byra` → `sovrum_1_byra`,
  `kontor_hoger` → `sovrum_3_hoger`, `kontor_vanster` → `sovrum_3_vanster` — while
  `db/config.json` still lists `sovrum_byra.light.mood`, `kontor_hoger.light.mood` and
  `kontor_vanster.light.mood`. `toggleItem()` matches on the config name, so **those three
  items are currently dead clicks**. Either the SVG ids or the config must move; ask the
  operator which way.
- `updateView()` does `document.getElementById(zone)` per zone and `updateArea()` swallows a miss
  with `?.`, so a renamed *zone* fails silently too.
- Room click cycles `off → night → mood → on → off` via `getNextStateRoom()`, driven by the
  `moodable` / `nightable` attributes that `updateView()` sets from the `.mood` / `.night`
  suffixes in `db/config.json`.
- Loads jQuery, msal-browser and font-awesome from three different CDNs, plus
  `/socket.io/socket.io.js` from the server. `home.js` is `type="module"` but relies on the
  jQuery global — module ordering happens to work because modules are deferred.
- UI checkbox state persists in **unsigned document cookies** named after the element ids
  (`cb-lock`, `cb-mood`, `cb-temp`, `cb-devi`, `cb-raw`, `cb-nightmode`), read back on load.
- Screen wake lock: `lock()`/`unlock()` via `navigator.wakeLock`, tied to window focus/blur.
  Blur also **disconnects the socket**; focus reconnects and re-fetches `/refresh-key`.

### MQTT ingest + the in-memory device model — `mqtt-web.js` 352–457

See **`docs/mqtt-and-devices.md`** for the topic convention, config format and output shapes.

### Device state persistence ⚠ — `exitHandler`, `mqtt-web.js` 662

- ⚠ **`log/mqtt.log` is written only inside `exitHandler`.** There is no periodic flush. A
  `SIGKILL`, an OOM kill or a power cut loses every state change since the last clean exit; on
  restart the app reloads a stale snapshot and repopulates only as MQTT re-delivers retained
  messages.
- Registered on `exit`, `SIGINT` and **`SIGTERM`** (lines 739–741). The bogus `SIGINT1`/`SIGINT2`
  registrations are gone, so `kill` and `systemctl stop` now save state.
- ⚠ `uncaughtException` and `unhandledRejection` now **log and keep serving** (lines 747–753)
  instead of exiting. That removes the class of remote-kill bugs, but it also means a crashed
  request no longer flushes state — and that a wedged process will keep running. Watch the log.

### Logging — `log.js`

`log()` is the only function that prints. `mqtt()` has its body commented out (so per-message
MQTT logging is off) and `debug()` is gated by `const d = false`. There is no log file, no
rotation and no levels — output goes to the tmux pane's stdout. `logMiddleware` logs
`x-forwarded-for` (populated by nginx) plus the path for every request.

---

## Fixed in the 2026-08-25 hardening pass (do not re-report as bugs)

Kept as a short record so a future reader does not "rediscover" them from stale notes. Each was
real; each is verified fixed in the working tree.

| Was | Now |
|---|---|
| `uncaughtException` bound to `exitHandler({exit:true})` — any async throw killed the server | logs and keeps serving; every async route is `wrap()`ped and there is a terminal error handler |
| `POST /login/finish` with `{}` exited the process (unauthenticated one-request DoS) | all `req.body` reads guarded; 400 with `{error}` |
| `registrationOptions`/`authenticationOptions` were `Map`s used as property bags | `ExpiringStore`, 5-min TTL, single-use `take()` |
| `keyUserMap` array-vs-string split; `preferred_username: ['lalalainput']` on disk | always a string; `validate()` also unwraps an array; `db/users.json` migrated |
| Disabled user's passkey login returned 204 + an `"undefined"` cookie | `setCookie()` 403s on a falsy key; `/login/finish` 403s with "Account is awaiting approval" |
| Each passkey was its own user record | one `webauthn:<username>` record per person; `db/users.json` migrated (backup `db/users.json.bak-20260825-095913`) |
| Passkey counter never persisted (`//TODO counter`) | persisted after each login |
| Client login gated behind `isConditionalMediationAvailable()` → silent no-op button | gate removed; `!window.PublicKeyCredential` reports a message |
| Debug `alert('hmh')` / `alert('finally')` during login | removed |
| `/login/finish` status never checked before redirecting | checked; server `{error}` surfaced |
| Cookie secret and VAPID private key hardcoded in source | `.env` (`COOKIE_SECRET`, `VAPID_*`); fail-fast if the cookie secret is missing |
| CSP built but the header commented out; eruda loaded from a CDN on the login page | CSP sent; eruda removed |
| `/key-from-cookie` + `/cookies` exposed the session key to JS | both deleted; socket.io authenticates from the cookie server-side |
| `connections` never deleted; unguarded `.user` read | deleted on disconnect; read guarded |
| `SIGINT1`/`SIGINT2` (not real signals); no `SIGTERM` | `SIGTERM` handled |
| `app.options('*')` params swapped, response never ended | fixed |
| `res.sendfile` (deprecated) | `res.sendFile('index.html', { root: './web' })` |
| Adding a passkey to an existing username was unauthenticated (account takeover) | requires a session as that same user |
