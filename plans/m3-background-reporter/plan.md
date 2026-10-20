# Milestone 3 — Background app and on-request actions

Source spec: [`docs/technical-spec.md`](../../docs/technical-spec.md). M2 plan: [`plans/m2-desktop-demo/plan.md`](../m2-desktop-demo/plan.md). Visual plan: https://claude.ai/artifact/UnymAgxyNK6brKnbYmnnyz

## Goal

The desktop app starts when the user logs in, stays in the tray / menu bar, and holds one quiet outbound connection to the server. Staff open a device in the dashboard and press **Scan now**, **Send logs** or **Ask user to confirm details**; the server sends a wakeup down that connection and the PC acts within seconds. The dashboard shows which PCs are online, when each was last seen, its agent version, its network snapshots and its uploaded logs.

**Out of scope for M3:** a separate Windows Service / LaunchAgent, a periodic check-in, a daily automatic scan or log upload, staff login and roles, status history, online/offline history, tagging, PM reports, macOS `.pkg` installer, HTTPS, code signing, server retention cleanup (waits for the nightly job).

## Decisions

| Topic | Decision |
| --- | --- |
| Focus | Background reporting first; staff features and rollout later (decided 2026-10-19) |
| How it runs | One program: the M2 Wails desktop app. Starts at user login (Windows `HKCU\...\Run` entry; macOS login item / per-user LaunchAgent that launches the app). No separate service. Reports only while a user is logged in |
| Tray | Tray / menu-bar icon stays: "Open PC_READER" (and status text such as "Connected"). No quit item |
| Window | Closing the window hides it; the app keeps running until logout. Single instance: launching PC_READER again shows the existing window |
| Automatic traffic | No polling. At login the app opens one long-lived outbound connection (e.g. Server-Sent Events). The server pushes pending requests the moment they are queued. Reconnect with backoff after sleep, network loss or server restart. PCs never accept incoming connections |
| Network snapshot | Sent when the connection opens and when the PC's network changes (IP, gateway, DNS, connection type, SSID or null) |
| On request only | Full scan (`scan_now`), log upload (`send_logs`), details prompt (`prompt_details_update`, opens the window on "Update my details" with a message). The user's own "Report now" stays |
| Online state | Online while the connection is open. `last_seen_at` updates on connect, on disconnect and on any agent call. Stale badge after 48 h offline |
| Token | Unchanged from M2 (user's Credential Manager / Keychain). Nothing to migrate |
| Dashboard login | None in M3. Requests are not attributed (`requested_by` null) |
| History | No status history and no online/offline history in M3 |
| Windows install | NSIS setup built by Wails (`-nsis`): Program Files, Start menu + desktop shortcut, uninstall entry; start-at-login points at the installed exe. Mac stays drag-to-Applications (decided 2026-10-19 after the first real-PC test) |
| Tray clicks | Left-click opens the window; right-click menu: Open PC_READER, Report now, status line; no Quit |
| Builders | Builder 1 only; no reviewer routine. The planner checks the PR and CI; the user reviews and merges |

## Work breakdown (Builder 1, in this order, separate commits)

### 0. Spike: tray icon (do first, report in INBOX)
Wails v2 has no tray API. Pick one and note why in INBOX.md under `### From builder-1`:
- upgrade the desktop module to Wails v3 (only if a non-alpha release exists and builds on both CI runners), or
- add a tray library (e.g. `fyne.io/systray` / `energye/systray`) that runs alongside Wails v2 on Windows **and** macOS (macOS main-thread rules are the usual problem).
Prove it with the CI desktop build on both runners before building the rest of section 3.

### 1. Contract + server
- Contracts (`contracts/agent-api/`), each with fixtures and contract tests:
  - `network-snapshot.schema.json`: `collected_at`, `ip_addresses`, `mac_addresses`, `gateway`, `dns_servers`, `connection_type` (ethernet / wifi / other), `ssid` (nullable).
  - `events.request` (connect/hello body: `agent_version`, network snapshot) and the event stream messages (`request` with `id`, `type`, `created_at`).
  - `network.request.schema.json` for snapshots sent on network change.
  - `logs.request` / `logs.response` (spec: batches ≤ 500, response lists stored `local_entry_id`s; `413` when too large).
  - `request-complete.request.schema.json` (`result`: done / failed, optional `scan_id`, optional `message`).
- DB (Drizzle, `bun run db:generate`): `device_requests` (device_id, type, status pending / delivered / done / failed, created_at, delivered_at, completed_at, scan_id, message, requested_by nullable), `network_logs` (per spec), `device_logs` (per spec, unique on device_id + local_entry_id). On `devices`: `agent_version`, `last_seen_at` (exists), `online` / `connected_at` as needed.
- Endpoints (bearer device token; JSON errors per spec):
  - `GET /api/agent/events` — long-lived SSE stream (Node runtime, `dynamic = "force-dynamic"`). On open: mark online, send all pending requests, then push new ones as they are queued. Heartbeat comment every ~25 s so proxies keep it open. On close: mark offline, set `last_seen_at`. Single server instance is fine (in-process notifier + DB as the source of truth).
  - `POST /api/agent/network` — store a snapshot.
  - `POST /api/agent/logs` — dedupe on (device_id, local_entry_id), return stored ids, `413` above the batch limit.
  - `POST /api/agent/requests/{id}/complete` — only the owning device; idempotent.
  - Agent version comes with the stream's hello (query or header — define it in the contract).
- Dashboard actions (no login): server actions or `/api/dashboard/devices/{id}/requests` to queue `scan_now`, `send_logs`, `prompt_details_update`. One pending request per type per device (pressing again returns the existing one).
- Integration tests: stream delivers a pending request on connect and a new one while connected; complete flow; logs dedupe and 413; network snapshot stored; 401 on every endpoint; online flag flips on connect/disconnect.

### 2. Agent (shared Go packages)
- Local log store: SQLite file in the app data folder (pure-Go driver, e.g. `modernc.org/sqlite`, so no CGO for the CLI). Entries per spec, cap 5,000 with a warning entry when trimming, never log tokens or personal details. Log scan, sync, signup, update, system events.
- Confirm-then-clear upload (`send_logs`): batches of 500, delete only the ids the server returns, split on 413.
- Events client: connects, parses SSE, reconnects with backoff (1 s → 5 s → 15 s → 60 s cap, reset after a healthy minute), stops and reports "re-registration needed" on 401.
- Network snapshot collector (Windows and macOS, pure parsers with fixtures like the scanners) and a change detector (poll local interfaces every ~30 s or OS notifications; no network traffic unless changed).
- Request handlers: `scan_now` → scan + upload (`scan_type: on_demand`) + complete with `scan_id`; `send_logs` → upload + complete; `prompt_details_update` → set a flag the UI reads, complete as done once delivered to the UI.
- CLI: add `pcreader listen` (runs the events loop in the foreground) for testing on Linux/CI; existing commands unchanged.
- Unit tests for all of the above with a fake server.

### 3. Desktop app
- Starts the events loop at launch when the device is registered (after IT setup/signup on first run).
- Start at login: enabled automatically after successful signup or IT setup; Windows `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, macOS login item (or `~/Library/LaunchAgents` plist that opens the app). Re-asserted on every launch.
- Launched at login → starts hidden (tray only). Launched by the user → shows the window.
- Tray / menu-bar icon with "Open PC_READER" and a status line (Connected / Offline / Re-registration needed). No quit item.
- Close button hides the window (`HideWindowOnClose` or equivalent). Single instance lock; a second launch focuses the existing window.
- `prompt_details_update` → show the window on "Update my details" with a short message ("IT asked you to confirm your details").
- "Report now" keeps working as in M2.
- Bound-method tests for the new state (connection status, prompt flag).

### 4. Dashboard
- Device list: Online / Offline pill, "last seen" (formatted in `DISPLAY_TIMEZONE`), agent version, Stale badge after 48 h offline, Online/Offline/Stale filter.
- Device detail: buttons "Scan now", "Send logs", "Ask user to confirm details" with the latest request's state (pending / delivered / done / failed, times); tabs or sections for **Logs** (newest first, level filter) and **Network** (snapshot history, newest first).
- Pages stay fast for 1,000 devices (index on `last_seen_at`, no N+1 queries).

### 5. CI + docs
- Existing jobs stay green; desktop builds include the tray.
- `agent/README.md`: start-at-login behaviour, how to turn it off for testing, tray, `pcreader listen`, what is sent and when.
- Update `CLAUDE.md` commands and the data-use notice text if the collected fields changed (network snapshot on connect/change, logs on request).

## Done when
- `bun run lint` and `bun run test` pass, including the new server and Go tests.
- CI builds the Windows `.exe` and macOS `.app` with the tray icon.
- An end-to-end test (Go `pcreader listen` against the test server) receives a `scan_now` queued after it connected, uploads the scan and completes the request.
- On a real PC (user test): log in → app starts hidden in the tray → device shows Online → Scan now updates the last scan within seconds → Send logs fills the Logs tab → Ask to confirm details opens the window → closing the window leaves it running → unplugging the network makes it Offline, plugging back in brings it Online with a new network snapshot.

## Risks
- Tray on macOS alongside Wails v2 (main thread) → spike first (section 0).
- Long-lived connections through proxies or sleep → heartbeat comments, reconnect with backoff, server marks offline on close.
- Next.js route handlers and streaming → Node runtime, no caching, tested in the integration suite and in Docker Compose.
- Users can still end the app in Task Manager or remove the login item → shows as Offline/Stale; acceptable for M3.

## Result
Built in two rounds (PR #6, then #7 with the Windows tray-click fix and the NSIS installer) and merged into `ccr-510da39c-6w5qgz`. Tested by the user on a real Windows PC (2026-10-19). Open: Mac real-machine test of the tray and start at login.
