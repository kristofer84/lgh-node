# Where things live — the full concern → file map

> The root `CLAUDE.md` keeps a one-line-per-concern index; **this file is the authoritative
> detail**. Before you touch a domain listed here, read its row.
>
> ⚠ marks a landmine: a confirmed bug, or a discipline that is load-bearing.
>
> **Verified 2026-08-25 against the working tree** — commit `eb19c0d`, the uncommitted
> auth-hardening pass (`env.js`, `.env.example`, `mqtt-web.js`, `user.js`, `server-webn.js`,
> `notifications.js`, `web/login.html`, `web/scripts/home.js`, `web/public/login/*`) **and the
> uncommitted new-apartment pass** (`tools/floorplan/`, a regenerated `web/dashboard.html`, a
> rebuilt `db/config.json`, the `switch` fix in `getDevice()`, the null guard in `updateView()`,
> the room-tint opacities in `style.css`). Line numbers refer to that working tree, so
> `git diff`/`git stash` will move them.
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
| `web/dashboard.html` | ⚠ **Generated — never hand-edit.** ~11 k lines, ~300 kB, almost all of it the inlined architectural drawing. |
| `tools/floorplan/` | The generator that produces it, plus its inputs and its own `README.md`. Untracked as of this pass. |
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
  about this when reasoning about a login bug. ⚠ Note that the 200 body now contains the
  **entire architectural drawing of the apartment inlined as SVG** — an anonymous visitor cannot
  operate anything, but they can read the floorplan out of the HTML.
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

⚠ **The policy has no `'unsafe-inline'` anywhere, and that is only viable because no page
reachable in normal use has an inline `<script>`, an inline `<style>` or a `style=""` attribute.**
Removing eruda from `login.html` is what made it viable, and the generator (below) is what keeps
it true. **Adding any inline script or style will break the page silently** — put it in a file
under `web/` instead. `default-src 'none'`, plus `base-uri 'none'`, `frame-ancestors 'none'`,
`form-action 'self'`. The comment above the CSP in `mqtt-web.js` (~line 100) states this
accurately; keep it in sync if the policy moves.

The one exception is `web/public/relative.html`, an unreferenced scratch page that has both an
inline `<script>` and inline styles. It is anonymously reachable (the bypass list passes all of
`/public/`) and renders inert under this policy. See the dead-code row.

⚠ **`style-src` governs `style=""` attributes too** — there is no separate `style-src-attr` here,
so the attribute form falls back to `style-src` and a browser refuses it. This is a live
constraint on the floorplan generator, not a theoretical one: Inkscape writes presentation
properties into `style=""`, and the first generated `web/dashboard.html` shipped **34** of them
(the `fill:#808080` wall poché, the door-swing arcs). Those paths carry no `fill` presentation
attribute as a fallback, so the walls would have rendered black instead of grey.

**Fixed in the generator, not by relaxing the CSP** (`tools/floorplan/generate.mjs`, the
`PRESENTATION` set ~line 137): every style declaration in the inlined artwork is rewritten into
the equivalent presentation attribute at build time. `grep -c 'style="' web/dashboard.html` is
**0**, and the CSP needs no exception, no hash and no `style-src-attr`. Two traps if this is ever
re-done, both paid for once:

- ⚠ **Convert per element, not with a global regex.** A style declaration *overrides* a
  presentation attribute of the same name, so an existing `fill="…"` must be **replaced**, not
  appended. Appending yields `Attribute fill redefined` and the document fails to parse at all.
- ⚠ **The kept set must include `stop-color` / `stop-opacity`** (the drawing has gradients) and
  `vector-effect`. Dropping `stop-color` silently breaks the gradients.

8 declarations are still dropped, all cosmetic and Inkscape-only (`font-variation-settings` ×4,
`-inkscape-stroke` ×4). The generator prints both counts on every run:
`rewrote 34 style="" attribute(s) as presentation attributes …, dropped 8 non-presentation decl(s)`.

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

### Dashboard ⚠ — `web/dashboard.html` is **generated**

> ⚠ **`web/dashboard.html` is machine-generated. Do not hand-edit it — the next regeneration
> silently discards your edit.** Change `db/config.json`, `tools/floorplan/lights.json` or
> `tools/floorplan/geometry.json` and re-run the generator.
>
> ```bash
> node tools/floorplan/generate.mjs          # writes web/dashboard.html
> node tools/floorplan/generate.mjs --check  # exit 1 if the file is stale
> ```
>
> **`tools/floorplan/README.md` is the pipeline's own documentation** — inputs, the
> geometry re-extraction from the Inkscape drawing, and the gotchas below in full. Read it
> before touching the plan; this row does not repeat it.

Why it is generated: the markup and `db/config.json` were two hand-maintained lists that had to
agree on **four unvalidated naming contracts** (room `id` ⟷ `config.zones` key; `class="item"`
`id` ⟷ a `.light`/`.switch` device; `id="th-…"` ⟷ a temperature/humidity `.sensor`;
`class="device"` `id` ⟷ a `…_electric_consumption_w` entry). They had already drifted —
`id="sovrum_3_hoger"` and `id="sovrum_3_vanster"` matched no config entry, so those two clicks
were silent no-ops. Deriving the markup from the config makes all four true by construction, and
the generator warns about what it cannot fix. **`db/config.json` is now the source of truth for
what appears on the plan.**

The plan itself is the new, larger apartment: 18 rooms, `viewBox="0 0 354 692"`, drawn as
line-art rather than the old photo. Zone names and the room list are in
`docs/mqtt-and-devices.md` §5.

Landmines carried by the new plan (each recorded in full in `tools/floorplan/README.md`):

- ⚠ **Room outline polygons live in `<defs>`**, referenced by both the room `<g>` and its
  `clipPath` via `<use>`. Putting the polygon inside the group it clips is a circular reference:
  the clip is then silently ignored and glows bleed through walls into neighbouring rooms.
- ⚠ **Every stroke width, font size and glow radius in `style.css` is in user units relative to
  `viewBox="0 0 354 692"`** — there is no `vector-effect` anywhere. Changing the generator's
  `transform.scale` silently rescales the entire UI.
- ⚠ **Room names must be read from rendered `<text>` content, not `inkscape:label`** when
  re-extracting geometry: several labels in `lgh_rot.svg` are stale (the room whose text reads
  `SOV2` carries `inkscape:label="Klk2"`).
- `home.js` binds clicks with `$(".room").click(...)` / `$(".item").click(...)` at ready —
  **direct binding, not delegation** — so the generated markup has to be static in the file.
  Anything injected later is inert.
- `.temp` and `.device` elements are emitted with `hidden`; `home.js` derives
  the checkbox state from `$('.temp').hasClass('hidden')`, so one un-hidden element inverts it.
- ⚠ **The generator rewrites the artwork's `style=""` attributes into presentation attributes**,
  because the CSP forbids inline styles. If you change how `base.svg` is spliced in, keep that
  step — details and the two traps are in the **Content Security Policy** row below.

### Dashboard client ⚠ — `web/scripts/home.js`, `web/styles/style.css`

- `updateView()` now **null-guards `document.getElementById(zone)`**. Before that, the four
  zones with no room drawn for them (`home`, `utomhus`, `moja`, `devices`) threw a TypeError as
  soon as one of them held a mood/night light, aborting the render for **every later zone**.
  Fixed; do not re-report. `updateArea()` still swallows a miss with `?.`.
- The dead `socketKey` cookie branch and its `var` are gone from `home.js` — nothing hands the
  session key to page JS any more (see the socket.io row).
- ⚠ **`style.css` room tints are tuned to line-art, not to the old photo.** `.room-outline` is
  `fill:#000; fill-opacity: 0.06` (was 0.2), nightmode 0.45 (was 0.6), and a new
  `.room[light="mood"] / [light="night"]` rule paints `#ffcc00` at 0.22. At the old 0.2 the room
  tint and the grey wall poché were the same grey and the drawing disappeared. If you raise it
  again, check the walls are still legible.
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


⚠ **Dark mode is `body.nightmode`, and it needs its own values for almost everything —
the light-mode ones do not merely look worse, they disappear.** Fixed 2026-08-28:

- **The plan was invisible.** `#base-plan` is 1137 elements stroked `#000000` with
  `fill: none`, plus 24 walls filled `#808080`. Black line-work on the `#222` page meant every
  wall, door, fixture and furniture outline vanished and only the grey walls survived. CSS beats
  presentation attributes, so `body.nightmode #base-plan [stroke="#000000"] { stroke: #8c8c8c }`
  reaches all of it without touching the generator or the drawing — **keep those selectors in
  step with what `extract.py` emits** if the drawing's palette ever changes.
- **Unlit rooms were holes.** `.room-outline` is `fill: #000` at 0.45, i.e. *darker* than the
  page, so a dark room read as a void rather than a surface. In nightmode it is now white at
  0.05 — a shade lighter than the page.
- **Only `[light="on"]` had a nightmode value**, so `mood`, `night` and `partial` silently used
  the daylight opacities. All four are defined now, and much fainter than in daylight: in the
  dark the *lamp glows* say a room is lit and the wash only has to rank the steps.
- **The wash is `#ffd966` here, not the `#ffcc00` used in daylight.** Pure amber has no blue in
  it, so over a dark ground it lands on olive at every opacity — which is exactly what the
  reported "muddy" look was. Lifting it toward white keeps the meaning without the mud.
- **Readouts get a halo** (`paint-order: stroke` in the page colour), because yellow text over a
  lit room's wash was the worst pairing on the page.

### Zone grammar + step semantics ⚠ — `web/scripts/zones.js` (shared)

**The ONE definition** of the zone entry grammar `device.type[.tier[.level]]`, of what each
light step publishes (`sceneFor`), of which step a room is currently in (`stepOf`, the inverse)
and of what a press moves it to (`nextStep`). Imported by all three consumers:
`mqtt-web.js`, `tools/floorplan/generate.mjs`, and — in the browser — `web/scripts/home.js`.

⚠ **It has to live under `web/`.** There is no build step and no bundler; `express.static('./web')`
serves it at `/scripts/zones.js` and `dashboard.html` loads `home.js` with `type="module"`, so
that directory is the only path all three can import from. Keep it free of imports and of
anything Node- or DOM-specific, or the browser copy stops loading.

⚠ **Why it exists.** The grammar was re-implemented in **seven** places (`mqtt-web.js` ×6 +
`generate.mjs`) and the meaning of a step in three — `toggle()` decided what a step publishes,
`getNextStateRoom()` which step came next, `updateView()` which step a room was in. Nothing
held them in agreement and they were not: a `switch` declared `.mood` advertised `mood: true`
in the `device.all` snapshot and lost it on the next per-device update; `updateView()` could
not tell a lamp at its mood brightness from one at full; and adding the `level` segment meant
editing five call sites, where missing one would have failed silently.

### Dependencies ⚠ — rebuilt 2026-08-28

`npm audit`: **0 vulnerabilities** (was 23, 14 high). 13 dependencies → 7. `pnpm-lock.yaml`
deleted; `package-lock.json` is authoritative.

⚠ **`passport` + `passport-azure-ad` were removed, not upgraded.** Microsoft deprecated the
package outright and there is no version left to move to, and it dragged in `jsonwebtoken`
≤8.5.1, `jws` <3.2.3 and `lodash` — carrying GHSA-qwph-4952-7xr6 (*signature validation bypass
via insecure default algorithm in `jwt.verify()`*), GHSA-hjrf-2m68-5959 (*forgeable tokens, RSA
to HMAC*) and GHSA-869p-cjfg-cm3x. On the path that decides who gets a session.
`requireEntraToken()` in `mqtt-web.js` replaces it with **`jose`**: same two checks the old
strategy callback made (token carries an `oid`; `validate()` grants that oid a key), plus
signature/issuer/audience verified against the JWKS, with the algorithm taken from the *key*
rather than the token's own header — which is precisely the bug class those advisories describe.
⚠ **Do not "restore" `@azure/msal-node` for this.** MSAL Node *acquires* tokens; it has no
resource-server validation API. The browser already uses `msal-browser` (CDN, `login.html`) to
acquire, which is the correct half of MSAL to use here.

Removed as dead weight: `@azure/msal-node`, `@microsoft/microsoft-graph-client`,
`isomorphic-fetch` and `concat-stream` had **zero imports**; `body-parser` was redundant with
the `express.json()` registered ten lines below it.

Major bumps and what they cost:

| package | | what broke |
|---|---|---|
| `express` | 4 → 5 | ⚠ `app.options('*')` is a **startup crash** in Express 5 (`PathError: Missing parameter name at index 1`). It is `'/{*splat}'` now — braced, because the unbraced `/*splat` does not match `/`. That was the only wildcard; every other route is a literal path. |
| `@simplewebauthn/server` | 10 → 13 | v11 moved the credential into a nested `credential: {id, publicKey, counter, transports}`. **`webauthn.json` keeps the old flat shape on purpose** — it holds real working passkeys and a bad format migration locks the operator out of their own home. `toCredential()` / `fromRegistration()` in `server-webn.js` convert at the two API boundaries instead, so nothing on disk changed. |
| `mqtt` | 4 → 5 | nothing. Verified by booting and watching it ingest 434 devices. |
| `socket.io`, `cookie-parser` | minor | nothing. |

How it was verified, since there is no CI and this is the production host: the whole upgrade
was done in a **copy** of the repo so `node_modules/` was never left broken; the app was booted
there on a spare port and every route's status code compared against the running production
instance (identical); `/login/start` was driven against the real stored passkeys and returned
correct `allowCredentials`; `npm run typecheck` passes against @simplewebauthn's **real v13
type definitions**, and reverting the call to the v10 argument name makes it fail, so that
check is live. The previous `node_modules/` was parked rather than deleted.

### Type checking ⚠ — `tsconfig.json`, `types/globals.d.ts`, `tools/typecheck/`

`npm run typecheck` / `npm run typecheck:watch`. **0 errors; keep it there.**

`checkJs` + `noEmit`: TypeScript reads the `.js` files, reports, and writes nothing. There is
no build step and there must not be one — `npm start` is unchanged and the browser still loads
`web/scripts/*.js` directly, which is also why `web/scripts/zones.js` can be shared with it.
Types are JSDoc comments in the source; `zones.js` is fully annotated, the rest is checked
without being annotated.

⚠ **TypeScript is installed under `tools/typecheck/`, not in the root `package.json`, and that
is not tidiness.** `npm install --save-dev typescript` at the root reports *"added 225
packages, and changed 13"* — including express 4.19.2→4.22.2, socket.io 4.7.5→4.8.3 and
body-parser 1.20.2→1.20.6 — because `package-lock.json` (2022), `pnpm-lock.yaml` (2024) and
`node_modules/` all disagree, so npm reconciles the whole tree. This is the production host.
A fresh clone runs `npm install --prefix tools/typecheck` once. `npx tsc` from the repo root
will not find it.

The settings are deliberately lenient — `strict: false`, `noImplicitAny: false` — because
express, passport-azure-ad and body-parser ship no types and `@types/*` for them cannot be
added without that same 225-package reconciliation. With `noImplicitAny` on, every such import
is an error and the real findings are lost in the noise.

`types/globals.d.ts` declares what exists at runtime but has no import to follow: `$` and `io`
(script tags in `dashboard.html`), `Number.prototype.pad` (home.js extends the prototype at
line ~91) and `Date.prototype.toGMTString` (dropped from TS's DOM lib, still implemented
everywhere).

**It found a real bug on its first run.** `log()` in `log.js` took a single argument, so
`log('error on login', token, new Error('oid is not found in token'))` in `mqtt-web.js` logged
those four words and dropped the rest: an MSAL token arriving without an `oid` left no
diagnostic at all. `log()` is variadic now, and formats a one-argument call exactly as before.

### Tests — `test/`, `npm test`

19 tests, zero dependencies, `node --test`, well under a second. **Not** a general safety net:
they cover the device/zone logic and nothing of the express pipeline, auth or sockets.

- `test/zones.test.mjs` imports the shared module directly — the payoff for extracting it.
- `test/server.test.mjs` runs against the **real** `db/config.json` and `log/mqtt.log`, so a
  bad config edit fails the suite. One test asserts no zone has two steps that publish the
  same scene, which is the bug `kok`, `bad3` and `orangeri` all had.
- `test/helpers.mjs` explains the harness: `mqtt-web.js` connects to MQTT and starts listening
  on import, so tests pull a function's **source text** out of the file and evaluate it with
  stubs. Fragile in one specific way — rename a function and its test stops finding it, loudly.
- Tests marked ⚠ encode a bug that actually happened. Each was checked by reintroducing its
  bug and confirming the test fails; do the same for any you add, or you have written a test
  that cannot fail.

### MQTT ingest + the in-memory device model — `mqtt-web.js` 352–457

See **`docs/mqtt-and-devices.md`** for the topic convention, config format and output shapes.

⚠ **What reaches the broker is decided outside this repo**, by `mqtt_statestream:` in
`/media/storage/ha/homeassistant/configuration.yaml` — a pure allowlist of the `light`, `switch`
and `climate` domains plus a handful of entity globs. `sensor` is not an included domain and
`binary_sensor` is never published. `docs/mqtt-and-devices.md` §2 has the block and the two globs
in it that match no entity.

⚠ **The HA area registry is unmaintained and must not be trusted** when mapping an entity to a
room — 117 of 153 devices have no area, and several areas are actively misleading (`Kök` holds
orangeri and vardagsrum lights; `Dusch` holds the badrum_2 lights; `Kontor` holds
`light.sovrum_3_tak`). Use the naming convention. ⚠ **Power sensors kept their old names through
the apartment rename**, so a power sensor's name does not identify its room either — resolve it
through `device_id`. Full detail and the open gaps: `docs/mqtt-and-devices.md` §8.

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


⚠ **It persists observations only.** `exitHandler` used to dump the whole `devices` object,
schema included — and since that file *seeds* `devices` on the next boot, a `mood: true` from a
tier since removed from `db/config.json` came back as a fact that outlived the config which
produced it. `toggle()` reads the config and `updateView()` reads the model, so the two
disagreed permanently, across every restart, with nothing visible in the config to explain it.
`SCHEMA_KEYS` (`zone`, `type`, `mood`, `night`, `level`) are now stripped on the way out and
cleared on the way in, so the file cannot carry them at all.
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

## Fixed in the 2026-08-25 new-apartment pass (do not re-report as bugs)

| Was | Now |
|---|---|
| `getDevice('<name>')` had no `switch` branch, so a switch declared `.mood` advertised `mood: true` in `device.all` and lost it on the next per-device update | the branch is `d.type === 'light' \|\| d.type === 'switch'`; both paths agree |
| `updateView()` did an unguarded `document.getElementById(zone)`; a zone with a mood/night light but no room drawn for it threw and aborted the render for every later zone | null-guarded, `if (!ar) return;` |
| `home.js` still parsed a `socketKey` cookie that nothing sets any more | branch and `var` removed |
| `dashboard.html` item ids `sovrum_3_hoger` / `sovrum_3_vanster` matched no config entry — two dead clicks | markup is generated from `db/config.json`; the contract cannot drift |
| `.room-outline` at `fill-opacity: 0.2` made the room tint and the grey wall poché the same grey, so the line-art plan vanished | 0.06 (0.45 in nightmode), with a separate `#ffcc00` @ 0.22 for mood/night |
| The first generated `dashboard.html` inlined 34 `style=""` attributes from the Inkscape artwork, which `style-src` (no `'unsafe-inline'`) refuses — the grey wall poché would have rendered black | the generator rewrites them as presentation attributes; `grep -c 'style="'` is 0 and the CSP stays strict (see the CSP row) |
