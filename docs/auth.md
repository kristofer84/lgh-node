# Auth — the two paths, end to end

> Read this before touching anything under `/login`, `/register`, `/key-*`, `user.js`,
> `server-webn.js`, `env.js` or `cookieMiddleware`.
>
> **Verified 2026-08-25 against the working tree** — commit `eb19c0d` plus the uncommitted
> auth-hardening pass. §8 records what that pass changed, so a stale note elsewhere can be
> reconciled against it. Line numbers move with `git stash`.

There are two ways in — **Microsoft MSAL / Entra** and **WebAuthn passkeys**. They are entirely
separate up front and converge on one function: `validate()` in `user.js`.

```
MSAL     → GET  /key-msal   (passport oauth-bearer)  → validate(oid, preferred_username) ──┐
WebAuthn → POST /login/finish (verifyAuthenticationResponse)                                │
                              → validate(webauthnOid(username), username) ─────────────────┤
                                                                                            ▼
                       generatedKey (randomUUID, stored in db/users.json)   [403 if disabled]
                                                                                            ▼
                     setCookie()  →  signed, httpOnly, sameSite=strict, maxAge 7d  cookie `key`
                                                                                            ▼
              cookieMiddleware (HTTP and socket.io) → validateKey(key) → req.user = the record
```

`validateKey()` re-checks `enabled` on every request, so the cookie is a pointer to a live
account rather than a bearer grant.

---

## 1. The pipeline (why order is the authorization model)

`mqtt-web.js` has **no per-route guard**. Position relative to `app.use(cookieMiddleware)`
(line 153) is the only thing that decides whether a route is public.

| Order | Line | Registered | Authenticated? |
|---|---|---|---|
| 1 | 116 | `bodyParser.json()` | — |
| 2 | 117 | `logMiddleware` | — |
| 3 | 118 | CSP + `x-content-type-options` + `referrer-policy` + `permissions-policy` | — |
| 4 | 126–127 | `express.json()`, `express.urlencoded()` | — |
| 5 | 129 | `GET /` | **public** |
| 6 | 133 | `GET /moja` | **public** (deliberate — external consumer reads outdoor sensors) |
| 7 | 143–147 | `COOKIE_SECRET` or `process.exit(1)` | — |
| 8 | 149 | `cookieParser(cookieSecret)` | — |
| 9 | 150 | `registerWebnMethods(app)` → all `/register/*`, `/login/*` | **public — deliberately.** They must be reachable before you have a session. |
| 10 | 151 | `passport.initialize()` | — |
| **11** | **153** | **`cookieMiddleware`** | **← the gate** |
| 12 | 158 | `app.options('*')` | 204 |
| 13 | 170 | `GET /key-msal` | bypassed here, guarded by `passport.authenticate('oauth-bearer')` instead |
| 14 | 176–202 | `/refresh-key`, `/push`, `POST /subscribe` | **authenticated** |
| 15 | 238 | `express.static('./web')` | **authenticated**, minus the bypass list |
| 16 | 244 | terminal 4-arg error handler | must stay last |

**Adding a route above line 153 makes it public with no warning; adding it below breaks any
pre-auth flow it belongs to.** That is the entire mechanism. **Wrap async routes in `wrap()`.**

### The bypass allowlist

`cookieMiddleware` short-circuits for an explicit array of paths plus two prefixes:

```js
['/style.css', '/code.png', '/favicon-192.png', '/login', '/sk.jpeg', '/favicon.ico',
 '/key-msal', '/config.json', '/manifest.json', '/scripts/sw.js', '/scripts/sw-init.js',
 '/init.js', '/dashboard']
// plus:  req.path.startsWith('/static/')  ||  req.path.startsWith('/public/')
```

- `/login` and `/dashboard` resolve through `express.static(..., { extensions: ['html'] })` to
  `web/login.html` and `web/dashboard.html`.
- `/public/` is allowlisted because the login JS modules live in `web/public/login/` — which
  also makes every other file under `web/public/` anonymously reachable.
- `/socket.io/*` is **not** in the list and does not need to be: `new Server(server)` installs
  its own request listener ahead of express, so those requests never reach the middleware.
- ⚠ `/dashboard` being allowlisted means the page returns **200** to anyone; its sub-resources
  (`/styles/style.css`, `/scripts/home.js`) 401 and `init.js` bounces the visitor to `/login`.
  Do not describe this as "the dashboard 401s" when debugging.

### socket.io reuses the same gate

`io.use(middlewareTransform(cookieMiddleware))`. `middlewareTransform` runs a dedicated
`cookieParser(cookieSecret)` over `socket.request` — populating `req.signedCookies` — then calls
`cookieMiddleware` with a faked `res` (`setHeader` → no-op, `end` → `next(Error('authentication_error'))`),
guarded by a `settled` flag so `next` fires exactly once. The handshake is same-origin, so the
browser sends the cookie by itself; `web/scripts/home.js` calls plain `io()` with no auth
callback. Verified behaviour: no cookie → `authentication_error`; valid cookie → connects and is
identified in `connections`.

---

## 2. Path A — MSAL / Entra

**Client** (`web/login.html` → `web/public/login/login-msal.js`, msal-browser 2.27 from CDN):

1. `initMsal()` fetches `/config.json` (public) → `msalConfig` with
   `clientId: bcb616b9-…`, `authority: https://login.microsoftonline.com/consumers`,
   `redirectUri: https://home.xcds.net/login`, cache in `localStorage`. The module stores the
   promise as `msalReady`.
2. Click "Sign in with MSAL" → `loginMsal()`, which **awaits `msalReady`** first (a click before
   init finished used to throw on `undefined`). If no cached account it `await`s
   `loginRedirect()` and **returns**.
3. `getAccessToken()` → `acquireTokenSilent({ scopes: ['openid','email'] })`, returning
   **`tokenResponse.idToken`** (not the access token — deliberate).
4. `fetch('/key-msal', { headers: { Authorization: 'Bearer <idToken>' } })`.
5. **The status is checked**: `403` renders "This account is awaiting approval", any other
   non-OK renders `Sign in failed (<status>)`. Only on success does it go to `/dashboard`.

**Server** (`mqtt-web.js`):

- `bearerStrategy` (line 273) with `passport-azure-ad`:
  `identityMetadata: …/consumers/v2.0/.well-known/openid-configuration`,
  `clientID: bcb616b9-…`,
  `issuer: https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0`
  (the well-known "personal Microsoft accounts" tenant).
- The verify callback rejects a token with no `oid`, then calls
  `validate(token.oid, token.preferred_username)`; a falsy return logs
  `User <name> has not been granted access` and `done(null, false)` → passport answers 401.
- `GET /key-msal` (line 170) calls `validate()` **again** with the same arguments and
  `setCookie(key, res)` → 204 + signed cookie, or **403** if the account is not enabled.

Identity key for this path: the **Entra `oid`** (a GUID).

---

## 3. Path B — WebAuthn registration

`server-webn.js`, rpID `home.xcds.net`, expected origin `https://home.xcds.net`, rpName
`Home map`. `allowNewUsers = true` (line 53).

> ⚠ **Registering a passkey onto an existing username requires being signed in as that user.**
> Checked in **both** `/register/start` and `/register/finish` via `currentUser(req)` (which
> reads the signed cookie and calls `validateKey`) against `caller.preferred_username`. Before
> this check, anyone could POST `/register/finish` for an existing username, get their
> credential appended to that user's key list, and log in as them. **Do not relax it**, and
> replicate it in any new registration entry point.
> A **brand-new** username is still open to the internet; those accounts land disabled.

1. `POST /register/start` `{ username, displayName }` — 400 if `username` is not a non-empty
   string; 403 if it exists and you are not that user. Then
   `generateRegistrationOptions({ rpName, rpID, userName, userID: sha256(username),
   attestationType: 'none', excludeCredentials: <existing keys>,
   authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' } })`,
   stored as `registrationOptions.set(username, options)`.
   `userID` is a **stable per-username hash**, so re-registering does not create a second
   discoverable-credential entry for the same person.
2. Client (`login-webn.js` `registerWebn`) base64url-decodes `challenge`, `user.id` and each
   `excludeCredentials[].id` (optional-chained — absent for a new user), calls
   `navigator.credentials.create()`, re-encodes `rawId` / `attestationObject` / `clientDataJSON`.
3. `POST /register/finish` `{ data, username }` — same guards, then
   `registrationOptions.take(username)` (single-use; 400 "No pending registration" if missing or
   expired) and `verifyRegistrationResponse({ response: data, expectedChallenge, expectedOrigin,
   expectedRPID })` inside a try/catch → 400 with `{error}` on failure.
4. On `verified`: `counter ??= 0`, `await setUser(...)` (appends to `users[username].keys`, sets
   `keyUserMap[credentialID] = username`, writes `webauthn.json` through the serialized
   `writeChain`), then **`validate(webauthnOid(username), username)`** so the `db/users.json`
   record exists and can be enabled by hand.
5. Response `200 { ok: true, enabled: <bool> }`. The client renders either
   "You can sign in now" or "the account still needs to be enabled".

`userVerification: 'required'` on the client side matches
`verifyRegistrationResponse`'s default of requiring it. They were out of step before.

---

## 4. Path C — WebAuthn login

Two buttons: "resident passkey" (no username) and "username and passkey".

1. `POST /login/start` `{ username? }` → `{ rpID, userVerification: 'required' }`, plus
   `allowCredentials` when a username is given (404 `{error:'User not found'}` if unknown).
   `generateAuthenticationOptions()` → stored as `authenticationOptions.set(reqId, options)`
   where **`reqId = randomBytes(32).toString('base64url')`**. Returns `{ publicKey, reqId }`.
2. Client decodes `challenge` and `allowCredentials[].id`, calls `navigator.credentials.get()`.
   There is **no conditional-mediation gate** — only a `!window.PublicKeyCredential` check that
   reports "This browser does not support passkeys".
3. `POST /login/finish` `{ data, reqId }`:
   - all reads guarded → 400 `{error:'data.id and reqId required'}` if `data`, `data.id` or
     `reqId` is missing or the wrong type
   - `keyUserMap[keyId]` → 401 `{error:'Unknown credential'}` if unknown
   - `authenticationOptions.take(reqId)` → 400 `{error:'Login expired, try again'}` if missing or
     past its 5-minute TTL (single use — a challenge is never replayable)
   - `verifyAuthenticationResponse({...})` in a try/catch → 401 with `{error}`
   - counter persisted: `authenticator.counter = authenticationInfo.newCounter; saveDb()`
   - `validate(webauthnOid(username), username)`; if falsy → **403
     `{error:'Account is awaiting approval'}`** (this is the case that used to be a 204 with an
     `"undefined"` cookie)
   - otherwise `setCookie(key, res)` → 204 + signed cookie
4. The client **checks the status** before redirecting and surfaces the server's `{error}` text.

Identity key for this path: **`webauthn:<username>`** — one record per person, not per passkey.

---

## 5. Data shapes

### `db/users.json` (gitignored, not in the repo)

```jsonc
{
  "users": {
    "00000000-0000-0000-8eb1-…":  { "preferred_username": "someone@outlook.com",
                                    "enabled": true, "generatedKey": "<uuid>" },
    "webauthn:kristofer":         { "preferred_username": "kristofer", "enabled": false }
  },
  "keys": {
    "<uuid>": { "oid": "<oid-or-webauthn:username>", "generated": "2022-08-12T14:37:30.132Z" }
  }
}
```

- MSAL records are keyed by the Entra `oid` (a GUID). Passkey records are keyed
  **`webauthn:<username>`**. Same map, two keyspaces, no linkage between them — the same human
  signing in both ways is two records, by design.
- `generatedKey` is absent until the first successful (enabled) login.
- `keys` is the reverse index `validateKey()` walks: `keys[cookieValue].oid` → `users[oid]`,
  returned as `req.user` — **but only if that record is still `enabled`**.

**Migration note.** The keyspace change was applied to the live file on 2026-08-25 (backup
`db/users.json.bak-20260825-095913`). The two credential-ID-keyed `kristofer` records collapsed
into a single `webauthn:kristofer` (still `enabled: false`), `webauthn:lalalainput` kept its
`generatedKey` so its session survived, and the array `preferred_username` became a string. MSAL
records were untouched.

### `webauthn.json` (tracked in git)

```jsonc
{
  "<username>": {
    "keys": [
      {
        "registrationInfo": {
          "fmt": "…", "counter": 3,            // now persisted per login
          "aaguid": "…",
          "credentialID": "<base64url>",       // the keyUserMap key for this passkey
          "credentialPublicKey": "<base64url>",// held in memory as a Uint8Array
          "credentialType": "public-key",
          "attestationObject": "<base64url>",  // ditto
          "userVerified": true,
          "credentialDeviceType": "…", "credentialBackedUp": true,
          "origin": "https://home.xcds.net", "rpID": "home.xcds.net"
        },
        "options": { "challenge": "…", "rp": {…}, "user": {…}, "pubKeyCredParams": […],
                     "timeout": …, "attestation": "none", "excludeCredentials": […],
                     "authenticatorSelection": {…}, "extensions": {…} }
      }
    ]
  }
}
```

On load, `attestationObject` and `credentialPublicKey` are decoded to `Uint8Array` in place and
`counter ??= 0` is applied. `serialize()` builds a **fresh** object for writing rather than
mutating the live one. Never write this file from anywhere but `saveDb()`.

### `db/subscriptions.json` (gitignored)

`{ "<preferred_username>": [ <PushSubscription>, … ] }`.

---

## 6. Current landmines in the auth path

These are live, in the working tree.

1. ⚠ **The Web Crypto shim.** Production is now Node v22 (v18/v19 removed 2026-08-25), where
   this is a no-op — but keep it; it is what makes the app version-portable.
   `server-webn.js` must keep
   `if (!globalThis.crypto) globalThis.crypto = webcrypto;`. Node 18 does not expose
   `globalThis.crypto` without `--experimental-global-webcrypto`, @simplewebauthn resolves it
   lazily, and without the shim **every passkey operation fails** with "An instance of the Crypto
   API could not be located" (`/login/start` → 500). This was the live outage behind much of the
   "passkey works so-so" report. Same reason `env.js` exists instead of `process.loadEnvFile()`.
2. ⚠ **Route order is the authorization model** (§1). No per-route guard exists.
3. ⚠ **`/dashboard` is anonymously served** (§1, bypass list) and so is everything under
   `web/public/` — including the dead `relative.html`.
4. ⚠ **`validate()` caches `db/users.json` in a module variable.** Hand-edits during a run are
   silently overwritten. Stop the process before editing (§7).
5. ⚠ **Brand-new passkey registration is open to the internet.** Accounts land disabled, but
   `webauthn.json` (a tracked file) grows with whatever anyone registers.
6. ⚠ **`currentUser()` compares `caller.preferred_username` to the requested username.** An MSAL
   session's `preferred_username` is an email, so it cannot add a passkey to a `webauthn:<name>`
   account unless the strings match. Current behaviour, possibly not the intended one — treat it
   as a known edge, not something to silently change.
7. ⚠ **`webauthn.json` is tracked in git** (credential metadata / usernames), and the old VAPID
   private key and cookie secret remain in git history at `ce9d9e3`. The operator has decided
   **not to rotate** the VAPID key (private repo). Do not reproduce any of these values.
8. ⚠ **`.env` quoting.** `.env.example` and `env.js`'s header say an unquoted value is truncated
   at the first `#`; the code actually truncates only at `' #'` (space-then-hash). Follow the
   documented rule — quote anything containing `#` — because the loosest reading is the one that
   bites when the loader changes.

---

## 7. How to enable a new user by hand

This is the intended access-control mechanism. There is no UI.

1. Have the person sign in once (MSAL) or **register a passkey** — registration now creates the
   `db/users.json` record itself, so a login attempt is no longer required. Either way the record
   arrives `"enabled": false` and `log()` prints
   `Created disabled account for <name> (<oid>) -- enable it in ./db/users.json`.
   The user sees "This account is awaiting approval" (MSAL) or "the account still needs to be
   enabled" / "Account is awaiting approval" (passkey).
2. **Stop the process.** `user.js` caches the whole file in a module variable and rewrites it on
   the next `saveDb()`, so editing it live is silently reverted.
3. Set `"enabled": true` on the record. Passkey accounts are keyed `webauthn:<username>` — **one
   record per person**, so one flip covers all of that person's passkeys.
   *Currently outstanding: `webauthn:kristofer` is still `enabled: false`; the operator must flip
   it (and restart) for those passkeys to work.*
4. Restart (`node --trace-warnings mqtt-web.js`, tmux session `pi`, window `nodeweb#`, cwd = repo
   root). Restarting also drops every in-flight WebAuthn challenge (`ExpiringStore` is in-memory).
5. Verify: the next login writes a `generatedKey` and a matching `keys` entry.

**To revoke**, set `"enabled": false` and restart. `validateKey()` re-checks `enabled` on every
request, so live cookies stop working immediately — no need to delete `generatedKey` or its
`keys` entry (still fine as belt-and-braces).

---

## 8. What the 2026-08-25 hardening pass changed

Kept so stale notes can be reconciled. Each item was real and is verified fixed.

| Was | Now |
|---|---|
| `uncaughtException` → `exitHandler({exit:true})`; any async throw killed the server | logs and keeps serving; `wrap()` on every async route + terminal error handler |
| `POST /login/finish` `{}` exited the process — unauthenticated one-request DoS | all `req.body` reads guarded; 400 `{error}` |
| Challenge stores were `Map`s used with `map[key] =` property syntax — never cleaned, lost on restart | `ExpiringStore`: 5-min TTL, single-use `take()` |
| `reqId = makeid(50)` from `Math.random()` | `randomBytes(32).toString('base64url')` |
| `keyUserMap` array at load / string in `setUser`; `preferred_username: ['lalalainput']` on disk | always a string; `validate()` unwraps an array; file migrated |
| Disabled user's passkey login → 204 + signed `"undefined"` cookie, client redirected anyway | `setCookie()` 403s on a falsy key; `/login/finish` 403 "Account is awaiting approval"; client checks status |
| One `db/users.json` record **per passkey** | one `webauthn:<username>` record per person; file migrated |
| Passkey counter never persisted (`//TODO counter`) | persisted after each login |
| `userVerification: 'preferred'` server-side vs verification defaulting to required | `'required'` on both ends |
| `setUser()` mutated live objects to serialize; a throw mid-way corrupted in-memory keys | `serialize()` builds a fresh object; writes serialized through `writeChain` |
| Anyone could append a passkey to an existing username → account takeover | requires a session as that same user, checked in both register routes |
| Client login nested in `isConditionalMediationAvailable()` → silent no-op button | gate removed |
| `alert('hmh')` / `alert('finally')` during login | removed |
| Cookie secret + VAPID private key hardcoded in source | `.env` via `env.js`; fail-fast if `COOKIE_SECRET` is unset |
| CSP assembled but header commented out; eruda from a CDN on the login page | CSP sent; eruda removed (which is what makes a no-`unsafe-inline` policy viable) |
| `/key-from-cookie` + `/cookies` handed the session key to page JS; socket auth depended on it | both deleted; socket.io parses the cookie server-side; `home.js` calls plain `io()` |
| `validateKey()` did not re-check `enabled`, so disabling left cookies live for 7 days | re-checks `enabled` |
| MSAL client threw on a click before init; never returned after `loginRedirect()`; ignored the response | awaits `msalReady`, returns after redirect, reports 403 as "awaiting approval" |
