# `docs/` — annotated index

> Written 2026-08-25, the first documentation this repo has ever had. The root `CLAUDE.md`
> holds only the rules and the concern index; the detail lives here so the always-loaded
> context stays small.
>
> **Scope stamp: these docs describe the working tree** — commit `eb19c0d` plus the uncommitted
> auth-hardening pass of 2026-08-25 (`env.js`, `.env.example`, `mqtt-web.js`, `user.js`,
> `server-webn.js`, `notifications.js`, `web/login.html`, `web/scripts/home.js`,
> `web/public/login/*`). **Nothing here is committed yet**, so line numbers and behaviour move
> with `git stash`. Both deep-dive docs end with a before/after table of that pass, so a stale
> note from before it can be reconciled rather than re-reported as a live bug.
>
> Each entry says what the doc *establishes*, not just what it covers — read the line before
> deciding whether you need the doc.

## Deep-dive docs

- `where-things-live.md` — **the authoritative concern → file map**, and the single place every
  ⚠ landmine is recorded in full. The current ones: the **Web Crypto shim** (a Node 18 legacy, kept for portability) that passkey
  login cannot run without, route order being the authorization model, `/dashboard` and all of
  `web/public/` being anonymously served, exit-only `log/mqtt.log` persistence,
  `getDevice('<name>')` missing its `switch` branch, `validate()` caching `db/users.json` so
  hand-edits during a run are lost, open registration for new usernames, `webauthn.json` tracked
  in git plus secrets still in git history, the `.env` quoting rule, and a **live
  dashboard-id/config mismatch that makes three floorplan items dead clicks**. Ends with the
  fixed-in-the-hardening-pass table. **Read the matching row before touching a domain.**
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
  or the dashboard's data contract.** The `homeassistant/<type>/<device>/<valueType>` inbound
  convention and the `webapp/switch/...` outbound one, the dotted `zone` → device-string format
  (including the `.mood` / `.night` suffixes), the two different shapes `getDevice()` returns
  depending on whether you pass a device name or `null`, the `device` / `device.all` / `toggle`
  socket.io events, and the ⚠ quirk that device state is persisted to `log/mqtt.log` **only in
  `exitHandler`** — `SIGINT`/`SIGTERM` now save, but `SIGKILL` and OOM still lose everything.

## Not documented here

There is no build, test, migration, deployment or CI documentation because none of those things
exist in this repo. Deploy = edit the file, restart the process in tmux session `pi`.
**Nothing in the working tree is live until that restart** — the running process (PID from
`ps`, started 2026-08-20) is still on the pre-hardening code.
