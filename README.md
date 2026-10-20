# PC_READER — Device Inventory & Tracking App

Internal tool for registering agency computers, collecting their hardware specs automatically on Windows and macOS, tagging units and components with inventory numbers, and tracking assignments, status history, network health and Preventive Maintenance reports from a web dashboard.

## Documentation

- [Technical specification](docs/technical-spec.md): goals, architecture, components, data model, scan field mapping, agent API, reporting behavior, security, non-functional requirements, deployment and open questions.
- [Milestone 1 plan](plans/m1-thin-slice/plan.md): the end-to-end thin slice being built now.

## Run the test server (Milestone 1)

Requires Docker Desktop (or Docker Engine with Compose).

```sh
cp .env.example .env        # then set ENROLLMENT_KEY and POSTGRES_PASSWORD
docker compose up -d --build
```

Open http://localhost:3000. Other computers on the same network use `http://<this computer's IP>:3000` (allow port 3000 through the firewall). The dashboard needs an HRIS login (see *Staff login (HRIS)* below); without those settings it shows "Login is not configured". The server speaks plain HTTP, so HTTPS in front of it is still recommended.

## Develop

Requires [bun](https://bun.sh) 1.4 and PostgreSQL 16.

```sh
bun install
bun run lint
bun run test                       # uses DATABASE_URL, default postgres://postgres@127.0.0.1:5432/pcreader_test
cd server && DATABASE_URL=... ENROLLMENT_KEY=... bun run db:migrate && bun run dev
```

See [CLAUDE.md](CLAUDE.md) for layout and conventions.

## Staff login (HRIS)

The whole dashboard (every page and every `/api/dashboard/*` route) needs a staff login. Staff sign in with their **HRIS** account: HRIS is the OpenID Provider and this server is a confidential OIDC client (Better Auth, Authorization Code + PKCE). There are no local passwords.

**Who gets in:** only HRIS users whose user level (`hris:user_level`, from the `account_level` scope) is listed in `HRIS_ALLOWED_USER_LEVELS` (comma list, default `IT`, case-sensitive). The level is read from HRIS at every sign-in. A refused sign-in creates no session, is logged, and shows "Your HRIS account is not allowed to use PC_READER" on `/login`. All allowed staff have full access (no roles inside PC_READER). Removing someone's level in HRIS takes effect at their next sign-in (sessions last 8 hours and refresh with activity); narrowing `HRIS_ALLOWED_USER_LEVELS` takes effect immediately.

**Still open without login:** `/login`, `/api/auth/*`, the PC agent API `/api/agent/*` (device tokens, unchanged) and the public `/api/branding[/logo]` the desktop app reads. The PCs and the desktop app are not affected.

**Register this server in HRIS** (an HRIS admin, at `/admin/oauth-clients`):

1. New client: **confidential**.
2. Redirect URI, exact: `<BETTER_AUTH_URL>/api/auth/oauth2/callback/hris` (e.g. `https://pcreader.example.gov/api/auth/oauth2/callback/hris`).
3. Scopes: `openid profile email account_level`.
4. Copy the client id and the secret (shown once) into `HRIS_CLIENT_ID` / `HRIS_CLIENT_SECRET`.

**Settings** (`.env`, passed through by `docker-compose.yml`):

| Variable | Meaning |
| --- | --- |
| `BETTER_AUTH_SECRET` | Signs the session cookie. `openssl rand -hex 32` |
| `BETTER_AUTH_URL` | This server's own public URL; must match the redirect URI above. Cookies are `secure` when it is https. |
| `HRIS_URL` | HRIS base URL; discovery is read from `$HRIS_URL/.well-known/openid-configuration` |
| `HRIS_CLIENT_ID`, `HRIS_CLIENT_SECRET` | From the HRIS client |
| `HRIS_ALLOWED_USER_LEVELS` | Default `IT` |

If any of the first five is missing, the server still starts (the agent API keeps working) but the dashboard fails closed: pages show "Login is not configured" and `/api/dashboard/*` answers 503. The server must be able to reach HRIS (token and key requests), and staff browsers must reach both.

**Signing out** is in the top bar. **Who did it:** status, location and inventory number changes, requests to a PC and IT PIN rotations record the staff member; the device history shows their name. `staff_events` (append-only) logs sign-ins, refused sign-ins, sign-outs, IT PIN rotations and settings/logo changes (never tokens, codes or the PIN), shown read-only under *Staff activity* on `/settings` (latest 100). Staff tables are `staff_user`, `staff_session`, `staff_account`, `staff_verification`; `hris_sub` (not the email) is the join key, and staff rows are never deleted.

**If sign-in fails with an issuer or token error:** HRIS's issuer is `<HRIS BETTER_AUTH_URL>/api/better-auth`; it must be HRIS's real public URL. That is an HRIS setting, not something to change here.

## Agency name, logo and inventory prefix (Settings)

Every server is set up for one agency on the dashboard's **Settings** page (`/settings`, top-bar link):

- **Agency name** (1-100 characters): shown in the dashboard's top bar and browser tab title, and in the desktop app's window header. Default `PC_READER`.
- **Logo**: PNG, JPEG or WebP, at most 512 KB (no SVG). Stored in the database and served at `GET /api/branding/logo?v=<version>`; replacing it changes the version, so caches refresh. *Remove logo* goes back to the name only.
- **Inventory prefix** (2-10 characters, A-Z and 0-9, saved in capitals): default `INV`. Changing it affects **new** numbers only; numbers already issued stay as they are and the per-year counter carries on. A server that already issued `IA-YYYY-NNNNN` numbers before this feature gets the prefix `IA` from the migration, so nothing changes for it until someone edits it.

The desktop app reads the name and logo from the public `GET /api/branding` (`{ "name", "logo_url" }`, no token needed), on launch and whenever its connection opens, and keeps a copy in `config.json`, so the window shows them even when started offline after one successful fetch. The window title and the tray stay "PC_READER", and printed labels carry no agency name.

API: `GET /api/dashboard/settings`; `POST /api/dashboard/settings` with `{ "agency_name"?, "inventory_prefix"? }`; `POST /api/dashboard/settings/logo` (the image as the request body with its `Content-Type`); `DELETE /api/dashboard/settings/logo`. Errors: 400 bad input, 413 logo too big, 415 wrong type.

`DISPLAY_TIMEZONE` (default `Asia/Manila`) sets the time zone of the dashboard, the inventory year and the IT PIN hour; set it to your own zone in `.env`.

## Inventory numbers, statuses and labels (Milestone 4)

Devices (not components yet) get an inventory number, a status and a location from the device page.

- **Format:** generated numbers are `PREFIX-YYYY-NNNNN` (e.g. `INV-2026-00123`; the prefix is set on the Settings page, see below): the year in `DISPLAY_TIMEZONE`, then a 5-digit counter that restarts each year. Staff can instead type an existing sticker number (trimmed, at most 50 characters, unique ignoring case).
- **Counter:** `inventory_counters` holds the highest value issued per year and only goes up. "Assign next number" bumps it inside the transaction (row-locked), so two staff cannot get the same number; a typed number that matches the pattern raises the counter to at least its value. Clearing or changing a number never lowers the counter, so a number is not issued twice. Year 2026 stops at `PREFIX-2026-99999`. A typed number counts as generated only when it uses the *current* prefix.
- **Statuses:** In use, Spare, Under repair, For disposal, Disposed, Lost. Changes are one device at a time with an optional reason.
- **History:** `status_history` (status) and `device_field_history` (number, location) are append-only; the device page merges them with assignment changes into one timeline. `changed_by` holds the staff member who made the change (the device page shows their name); rows from before the dashboard had a login keep their old text or stay empty.
- **API:** `POST /api/dashboard/devices/{id}/inventory` with `{ "action": "assign_next" | "set_number" | "clear_number" | "set_status" | "set_location", "value"?, "status"?, "reason"? }`. Errors: 400 bad input, 404 unknown device, 409 number taken or device already numbered.
- **Label:** `/devices/{id}/label` is a print-friendly page (number, QR code of the number, hostname, serial number) that uses the browser's print dialog. The QR code is generated on the server; no external service is used.
- **List:** `/devices` shows number, status and location, can be filtered by status, department, OS and connection, and searched by number, hostname, serial number, user name or employee ID.

## Custom fields and secret fields (Milestone 6)

IT defines extra fields once for every computer on the dashboard's **Fields** page (top bar) and fills them in per device on its page, under *Custom fields*.

- **Types:** *Text* (up to 500 characters), *Date* (`YYYY-MM-DD`) and *Secret* (up to 1000 characters, e.g. a local admin password). Fields can be added, renamed, reordered and archived; archiving hides a field but keeps its values, and fields are never deleted. The type cannot change.
- **History and search:** text and date changes are appended to the device history with the old and new value. The device list search also matches text fields, and a date field can be filtered *on or after / on or before*. Secrets are never searchable and never shown in the list.
- **Secrets are encrypted:** each value is stored as AES-256-GCM ciphertext with its own random nonce, bound to its device and field. The key is `SECRETS_KEY` in `.env` (32 random bytes, base64: `openssl rand -base64 32`). Without it the server still starts, but secret fields are disabled and the Fields page says so. **Back the key up together with the database; a lost key means lost secrets**, and changing it makes existing secrets unreadable (no re-encryption step yet).
- **Revealing or changing a secret needs the current IT PIN** (same check and rate limit as everywhere: 403 `wrong_pin`, 429 `too_many_attempts`). *Reveal* shows the value for 30 seconds with a Copy button, then hides it. The device page lists every reveal, change and clear (also refused ones) with time, staff member and client IP in *Secret access*; the history shows secret changes only as "changed". The value is never written to a log or history row, and no response other than `POST /api/dashboard/devices/{id}/fields/{field}/reveal` carries it.
- **Never sent to PCs:** custom fields and secrets are dashboard/server only; the agent and the desktop app do not see them.
- **API (staff login required, 401 without a session):** `GET/POST /api/dashboard/fields`, `PATCH /api/dashboard/fields/{id}`, `POST /api/dashboard/fields/order`, `GET /api/dashboard/devices/{id}/fields`, `PUT .../fields/{field}` (text/date), `PUT .../fields/{field}/secret` and `POST .../fields/{field}/reveal` (both with `pin`).
- **Who did it:** every reveal, set and clear (also refused ones) records the signed-in staff member (`secret_access_log.staff_user_id`), and text/date changes carry the staff id in the device history. Revealing or setting a secret needs the HRIS login *and* the current IT PIN.

## The hourly IT PIN: the desktop app is view-only without it (Milestone 5)

**What users can do without the IT PIN: view only.** The person at the PC can open *My computer* and *Full details*. Everything else needs IT's approval, usually the current PIN typed by IT: **Report now** (window button and tray item), **signup** (and `pcreader register --pin`), **Update my details** and **Settings**. Work the dashboard asks for (*Scan now*, *Send logs*) needs no PIN.

**"Ask user to confirm details" carries IT's approval.** When staff press it on the dashboard, the server sends the request to that PC with a one-time approval code (HMAC of the request id with the IT PIN secret; nothing extra is stored). The window opens on *Confirm my details*, and the user can save their name, email, department, position and phone **once, without the PIN**. The employee ID is read-only there (moving the PC to someone else still needs the PIN). The server accepts the code only for that PC's open request, within 24 hours, with the same employee ID; the save closes the request, so the code is used up. A request the user leaves for 24 hours is closed as failed ("The user did not confirm within 24 hours") and a new one can be sent. These saves appear on the device page as *Confirm details (IT request)*. *Update my details* opened by the user still needs the PIN. A correct PIN keeps the app unlocked for 10 minutes (one PIN covers several actions) or until the window is hidden; a small "Unlocked for IT · Lock" indicator shows it. The server enforces this, not only the app:

| Endpoint | PIN |
| --- | --- |
| `POST /api/agent/register` | `it_pin` required, checked after the enrollment key; no device yet, so wrong PINs are limited per client IP (`X-Forwarded-For`) |
| `PUT /api/agent/user` | `it_pin`, or `confirm` (request id + approval code of an open "confirm details" request, same employee ID): `403 approval_invalid` when used, expired or wrong, `403 pin_required` for a different employee ID |
| `POST /api/agent/scans` | `it_pin` required when `scan_type` is `manual`; `scheduled`, `startup` and `on_demand` need none |
| `POST /api/agent/settings-unlock` | `pin` (Settings) |

A wrong or old PIN is `403 wrong_pin`; 5 wrong PINs per device (per IP at signup) within a minute are `429 too_many_attempts`, across all of these (wrong approval codes count too). Every checked attempt is appended to `settings_unlock_attempts` with its method (Signup, Update my details, Confirm details (IT request), Report now, Settings) and the device page lists the recent ones. There is no offline fallback for these actions (only Settings can use the enrollment key): offline, the app says "Can't reach the server. Try again when this computer is online."

- **Where IT finds it:** the dashboard's **IT PIN** page (`/it-pin`, linked in the top bar) shows one 6-digit PIN for all PCs, when it changes and a live countdown. It is derived from a server-side secret (HMAC of the hour and a generation counter, like a TOTP code with a 1-hour step) and changes at the top of every hour in `DISPLAY_TIMEZONE`. **Change now** bumps the generation, so the PIN changes immediately; the next hour still rotates it as usual. `GET`/`POST /api/dashboard/it-pin` return/rotate it.
- **Secret:** `IT_PIN_SECRET` if set, otherwise a random 32-byte secret the server creates on first use and keeps in `it_pin_state`. It never leaves the server. Changing `IT_PIN_SECRET` changes every PIN.
- **Settings check:** `POST /api/agent/settings-unlock { "pin": "123456" }` with the device token: 200 `{ "ok": true }`, 401 bad token, 403 `wrong_pin`, 429 `too_many_attempts` (5 wrong PINs from a device within a minute). Only the current PIN is accepted. Each checked attempt is appended to `settings_unlock_attempts` and shown on the device page.
- **Server unreachable:** the app falls back to the enrollment key (checked against a salted hash saved at IT setup); see [agent/README.md](agent/README.md).
- The PIN page and its "Change now" are behind the staff login; each rotation is logged (who and when, never the PIN).
- **Reset a PC:** delete `config.json` in the app data folder and run IT setup again.
