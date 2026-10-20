# Milestone 5 — Hourly IT PIN from the dashboard

Source spec: [`docs/technical-spec.md`](../../docs/technical-spec.md). Builds on M4 ([`plans/m4-inventory-tags/plan.md`](../m4-inventory-tags/plan.md), PR #8) and the M2 Settings screen ([`plans/m2-desktop-demo/plan.md`](../m2-desktop-demo/plan.md)). Visual plan: https://claude.ai/artifact/UnymAgxyNK6brKnbYmnnyz

## Goal

IT no longer sets a PIN on each PC. The dashboard shows one current **IT PIN** for all PCs that changes every hour. On a PC, Settings asks for that PIN and the server checks it. If the PC cannot reach the server, the enrollment key unlocks Settings instead, so IT can still fix a wrong server address.

**Out of scope for M5:** staff login and roles, per-PC PINs, offline (authenticator-style) PIN codes on the PC.

## Decisions

| Topic | Decision |
| --- | --- |
| Source of the PIN | Server only. 6 digits, derived from a server-side secret and the current hour (HMAC of the hour number, like TOTP with a 1-hour step). Nothing about the hourly PIN is stored on the PC |
| Scope | One PIN for all PCs |
| Rotation | Changes at the top of every hour in `DISPLAY_TIMEZONE` (Asia/Manila). "Change now" on the dashboard rotates it immediately (bumps a stored generation/epoch so the derived PIN changes; the next hour still rotates normally) |
| Verification | PC sends the typed PIN with its device token; the server answers ok / wrong. Only the current PIN is valid (no grace window) |
| Lockout | Keep the PC's 5 wrong tries → 60 s lockout. Server also rate-limits wrong attempts per device (e.g. 5 per minute → 429) |
| Offline fallback | When the server is unreachable (network error / timeout / 5xx), Settings asks for the **enrollment key** instead. The PC checks it against a salted slow hash saved at IT setup (reuse `config.PinHash`). The key itself is never stored |
| Re-registration (401 banner) | Uses the hourly PIN path when the server answers; when the server rejects the token the PIN check can't succeed, so this path asks for the enrollment key (it is needed to re-register anyway) |
| IT setup | No longer asks IT to choose a PIN. Saves the enrollment-key hash instead. Existing local PIN hashes in `config.json` are dropped on upgrade; a PC without an enrollment-key hash (CLI-registered or M2/M3) gets it the next time IT runs setup or re-registers, and until then offline unlock is unavailable (show a clear message) |
| Unlock log | Server records each unlock attempt: device, time, success/failure, method (`hourly_pin`). Device page shows recent attempts. Offline enrollment-key unlocks are written to the PC's local log and uploaded on the next Send logs |
| Accepted risk | No dashboard login yet: anyone on the LAN who opens the dashboard can read the current PIN. Documented in the README; fixed when staff login arrives |
| Details need the PIN | (added 2026-10-20) First-time signup and Update my details also need the hourly IT PIN, enforced by the server (`register`, `PUT /user`). Exception: confirming details after a dashboard "Ask user to confirm details" request needs no PIN. No offline fallback for these forms |
| View-only without PIN | (2026-10-20, overrides the exception above) Without the IT PIN the desktop app is view-only. Report now (window and tray), signup, Update my details (also after a dashboard prompt) and Settings all need the PIN; the server enforces it for manual scans, register and `PUT /user`. Dashboard-requested work (scan_now, send_logs) needs none. One correct PIN unlocks the app for 10 minutes or until the window is hidden |
| Confirm-details approval | (2026-10-20, round 4) "Ask user to confirm details" reaches the PC with a one-time approval code from the server (HMAC of the request id). With it the user saves once without the PIN, within 24 h, with the employee ID read-only (reassignment still needs the PIN). The server checks all of it, the save closes the request, unanswered requests expire after 24 h, and every such save is logged as `confirm_details` |
| Builders | Builder 1 only; no reviewer routine. Stacks on PR #8 (M4) |

## Work breakdown (Builder 1, in this order, separate commits)

### 1. Contract + server
- Contract `contracts/agent-api/settings-unlock.request.schema.json` (`{ pin: "6 digits" }`) and response (`{ ok: true }`), fixtures, contract test. Errors: `401` bad device token, `403` wrong PIN (`error: "wrong_pin"`), `429` too many attempts.
- Server secret: a random 32-byte secret generated on first use and stored in the DB (e.g. `settings` table), or `IT_PIN_SECRET` env var if set. Never logged, never sent to PCs.
- `it_pin_state` (secret reference, `generation`, `rotated_at`) and append-only `settings_unlock_attempts` (device_id, attempted_at, success, method).
- `lib/it-pin.ts`: `currentPin(now)`, `expiresAt(now)`, `rotateNow()`, `verify(deviceId, pin)` with constant-time compare and rate limit.
- `POST /api/agent/settings-unlock` (bearer device token).
- Dashboard: an "IT PIN" box (on the device list page header or a small `/settings` page linked from the nav) with the PIN, "changes at 3:00 PM", a live countdown, and "Change now". No login (same as other dashboard actions).
- Device page: recent unlock attempts.
- Tests: PIN changes at the hour boundary in Asia/Manila, same PIN within the hour, "Change now" changes it, wrong/right verify, rate limit, attempts recorded, 401.

### 2. Agent
- `api.Client.UnlockSettings(pin)`.
- `config`: replace `ITPin` with `EnrollmentKeyHash` (reuse `PinHash` hashing; allow the enrollment key's format, not only digits). Drop an old `ITPin` value when loading.
- IT setup and re-registration store the enrollment-key hash after a successful register (or a successful connection check on an already-registered PC where IT enters the key).
- `bound`: `UnlockSettings(input)` → try the server; on 403 count a wrong try; on network error / 5xx switch to "offline" mode and check the enrollment-key hash; keep the 5-try / 60 s lockout across both. Remove PIN creation from IT setup.
- Tests for each path, including "no enrollment-key hash stored and server unreachable" (clear message, no unlock).

### 3. Desktop app
- IT setup: remove the PIN fields.
- Settings prompt: "Enter the IT PIN shown on the PC_READER dashboard". When offline: "Can't reach the server. Enter the enrollment key to change the server address."
- 401 banner: asks for the enrollment key, then re-registration as today.

### 4. CI + docs
- `agent/README.md` and root README: where IT finds the PIN, the offline fallback, the reset (delete `config.json` and run IT setup), and the no-login risk.
- Update `CLAUDE.md`.

## Done when
- `bun run lint` and `bun run test` pass; CI (desktop builds included) is green.
- User test: dashboard shows a PIN that changes on the hour and with "Change now"; Settings on a real PC opens with the current PIN and refuses an old one; with the server stopped, Settings opens with the enrollment key and the server address can be changed; attempts show on the device page.

## Risks
- Clock skew on the server only matters for the dashboard display; verification happens on the server, so PC clocks don't matter.
- Enrollment key rotated by IT later → PCs keep the old key's hash until IT setup runs again; document it.
- Dashboard without login exposes the PIN (accepted for now).

----

## v2 — The desktop app is view-only without the hourly IT PIN

**Problem.** v1 only protected Settings. New rule: without the IT PIN, users can only view My computer and Full details.

**Fix.**
- Server enforces the PIN on `POST /register` (after the enrollment key; rate limit per client IP, attempts with `device_id` null), `PUT /user`, and `POST /scans` when `scan_type` is `manual`. Dashboard-requested scans (`on_demand`) and Send logs need none. Attempts table gains `client_ip`, nullable `device_id` and methods `register` / `update_details` / `manual_scan` (migration 0004).
- Contracts: `it_pin` on register and user requests (required), on scans (optional, required for manual by the handler).
- Agent: one correct PIN unlocks the app for 10 minutes or until the window is hidden; the PIN stays in memory only; shared 5-tries/60 s lockout; no offline fallback except Settings' enrollment key; `pcreader register --pin`, `scan --upload --pin`.
- Window: PIN dialog, "Unlocked for IT · Lock" indicator, PIN fields on signup and Update my details, tray Report now asks first, dashboard prompt also needs the PIN.

**Affected files.** See "Round 2" in `plans/ccr-510da39c-6w5qgz/INBOX.md`.

**Deviations from the first round-2 text.** The "confirm details prompt needs no PIN" exception was dropped (addendum).
