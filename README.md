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

Open http://localhost:3000. Other computers on the same network use `http://<this computer's IP>:3000` (allow port 3000 through the firewall). Milestone 1 uses plain HTTP and has no dashboard login, so run it only on a trusted network.

## Develop

Requires [bun](https://bun.sh) 1.4 and PostgreSQL 16.

```sh
bun install
bun run lint
bun run test                       # uses DATABASE_URL, default postgres://postgres@127.0.0.1:5432/pcreader_test
cd server && DATABASE_URL=... ENROLLMENT_KEY=... bun run db:migrate && bun run dev
```

See [CLAUDE.md](CLAUDE.md) for layout and conventions.

## Inventory numbers, statuses and labels (Milestone 4)

Devices (not components yet) get an inventory number, a status and a location from the device page.

- **Format:** generated numbers are `IA-YYYY-NNNNN` (e.g. `IA-2026-00123`): the year in `DISPLAY_TIMEZONE`, then a 5-digit counter that restarts each year. Staff can instead type an existing sticker number (trimmed, at most 50 characters, unique ignoring case).
- **Counter:** `inventory_counters` holds the highest value issued per year and only goes up. "Assign next number" bumps it inside the transaction (row-locked), so two staff cannot get the same number; a typed number that matches the pattern raises the counter to at least its value. Clearing or changing a number never lowers the counter, so a number is not issued twice. Year 2026 stops at `IA-2026-99999`.
- **Statuses:** In use, Spare, Under repair, For disposal, Disposed, Lost. Changes are one device at a time with an optional reason.
- **History:** `status_history` (status) and `device_field_history` (number, location) are append-only; the device page merges them with assignment changes into one timeline. `changed_by` is null until the dashboard has staff login.
- **API:** `POST /api/dashboard/devices/{id}/inventory` with `{ "action": "assign_next" | "set_number" | "clear_number" | "set_status" | "set_location", "value"?, "status"?, "reason"? }`. Errors: 400 bad input, 404 unknown device, 409 number taken or device already numbered.
- **Label:** `/devices/{id}/label` is a print-friendly page (number, QR code of the number, hostname, serial number) that uses the browser's print dialog. The QR code is generated on the server; no external service is used.
- **List:** `/devices` shows number, status and location, can be filtered by status, department, OS and connection, and searched by number, hostname, serial number, user name or employee ID.

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
- **Accepted risk:** there is no dashboard login yet, so anyone who can open the dashboard can read the current PIN. This is fixed when staff login arrives.
- **Reset a PC:** delete `config.json` in the app data folder and run IT setup again.
