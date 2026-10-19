# INBOX — agent coordination

**Repository:** `Sealis04/PC_READER` — if your working directory is another repository, switch to a checkout of this one (`git remote -v`).
**Feature branch:** `ccr-510da39c-6w5qgz`
**Active builders:** builder-1 only
**Reviewer:** not used for M3. **Do not fire the reviewer routine.** When done, open your PR and stop; the planner checks CI and reports to the user.
**Milestone:** M3 — background app and on-request actions. Plan: [`plans/m3-background-reporter/plan.md`](../m3-background-reporter/plan.md). History: [`plans/m1-thin-slice/inbox-log.md`](../m1-thin-slice/inbox-log.md), [`plans/m2-desktop-demo/inbox-log.md`](../m2-desktop-demo/inbox-log.md).

## Branch to work on (overrides the routine prompts)

Your session is assigned its own branch (e.g. `claude/<name>`) and must not push elsewhere. Use that assigned branch as your working branch:

1. `git fetch origin claude/fervent-mendel-9y30q4 && git checkout -B <your-assigned-branch> origin/claude/fervent-mendel-9y30q4` — that branch is `ccr-510da39c-6w5qgz` (M2 merged) plus the M3 plan and this INBOX.
2. Commit and push only to your assigned branch: `git push -u origin <your-assigned-branch>` (use `--force-with-lease` once after the reset if the push is rejected).
3. Open the PR from your assigned branch into `ccr-510da39c-6w5qgz`. Opening the PR is required.

## Repo conventions

See the repo `CLAUDE.md`. In short: bun + Drizzle (no Prisma, no `db:push`; `cd server && bun run db:generate` after schema changes, `bun run db:migrate` to apply); Go tests with `-count=1`; `bun run lint` and `bun run test` from the root run everything (server tests need Postgres, `DATABASE_URL` defaults to `postgres://postgres@127.0.0.1:5432/pcreader_test`). The desktop app is its own Go module in `agent/desktop/` (Wails v2); shared logic lives in `agent/internal/` and is unit-tested on Linux.

---

## builder-1 — M3 (2026-10-19)

Implement sections 0–5 of `plans/m3-background-reporter/plan.md`, in order, as separate commits:

0. **Tray spike first.** Choose Wails v3 or a tray library that works next to Wails v2 on both Windows and macOS; prove it with the CI desktop builds; write the choice and reason under `### From builder-1` below before continuing with section 3.
1. **Contract + server:** network snapshot, events hello/messages, logs, request-complete schemas (+ fixtures, contract tests); `device_requests`, `network_logs`, `device_logs` tables and device online/agent-version fields; `GET /api/agent/events` (SSE, pushes pending requests instantly, heartbeat, online/offline on open/close), `POST /api/agent/network`, `POST /api/agent/logs`, `POST /api/agent/requests/{id}/complete`; dashboard request queueing (no login); integration tests.
2. **Agent shared packages:** SQLite local log (pure-Go driver, 5,000 cap), confirm-then-clear upload, events client with reconnect/backoff and 401 handling, network snapshot collectors + change detection, request handlers; `pcreader listen` for tests.
3. **Desktop app:** start at login (hidden), tray / menu-bar icon with "Open PC_READER" + status and **no quit item**, close hides the window, single instance, details prompt opens "Update my details".
4. **Dashboard:** Online/Offline pill, last seen, agent version, Stale after 48 h, filter; device detail request buttons with state; Logs and Network sections.
5. **CI + docs:** desktop builds green with the tray; `agent/README.md`, `CLAUDE.md`, data-use notice if needed.

**No polling:** there is no periodic check-in. The only automatic traffic is the long-lived events connection, a network snapshot on connect and on network change, and reconnects. Scans and log uploads happen only on request (or the user's Report now).

You cannot run the GUI in your container. Verify with server integration tests, Go unit tests, the Go end-to-end test (`pcreader listen` against a running server receives `scan_now`, uploads, completes), and the CI desktop build jobs (check them with the GitHub tools after pushing). Note anything you could not verify.

**Done when:** `bun run lint` and `bun run test` pass, the CI desktop builds succeed on both runners, and the PR into `ccr-510da39c-6w5qgz` is open with a summary below.

---

## reviewer

Not used for M3. builder-1: write your summary here under `### From builder-1` (tray choice, files changed, what was done, what to check, what you could not verify), then stop.

### From builder-1

**Tray choice:** `fyne.io/systray` v1.12.2 next to Wails v2.10.2 (`RunWithExternalLoop`, started from Wails' `OnStartup` so Wails keeps the main thread macOS needs). Wails v3 is still alpha, so it was not used. Proven by the CI desktop builds on `windows-latest` and `macos-latest` (run on commit `c563bc8`, and again with the full app). The tray has "Open PC_READER" and a status line, and no Quit item. The icons are generated 32 px images in `agent/desktop/assets/`.

**Files changed (by area)**
- Contracts: `contracts/agent-api/{network-snapshot,network.request,events.request,events.message,logs.request,logs.response,request-complete.request,request-complete.response}.schema.json`, `contracts/index.ts`, fixtures `network/ events/ logs/ request-complete/`, `contracts/test/fixtures.test.ts`. The hello is the query string `agent_version` (a GET has no body); the network snapshot is sent with `POST /network` right after the stream opens.
- Server: `src/db/schema.ts` and migration `drizzle/0001_lush_the_renegades.sql` (`device_requests`, `network_logs`, `device_logs`; `devices.agent_version/online/connection_id/connected_at`; index on `last_seen_at`; one open request per type per device via a partial unique index), `src/lib/{notifier,requests,dashboard-requests}.ts`, `src/lib/agent/{events,network,logs,complete}.ts` (+ `auth.ts` now refreshes `last_seen_at` on every agent call), routes `api/agent/{events,network,logs,requests/[id]/complete}` and `api/dashboard/devices/[id]/requests` (POST queue, GET list), `src/instrumentation.ts` (clears stale online flags at start), dashboard pages and `devices/_components/request-actions.tsx`, `lib/{format,queries}.ts`, tests `events-api.test.ts` and `dashboard.test.ts`.
- Agent: `internal/{locallog,events,netinfo,background,autostart}` (new), `internal/api/client.go` (network, logs, complete), `internal/app/app.go` (`Log` hook, `Credentials`, `APIClient`, updated data-use notice), `internal/scan/{windows,darwin}` (light network collection and `ParseNetwork`, same parsers as the full scan), `internal/bound` (connection status, details prompt, `OnReady`), `cmd/pcreader` (`listen`, end-to-end test), `desktop/{main.go,tray.go,assets,frontend}`.
- Docs: `agent/README.md` (Background app section), `CLAUDE.md`.

**What was done**
- Section 0: tray spike, hide on close, single instance (`SingleInstanceLock`), `--background` starts hidden.
- Section 1: contracts, tables, SSE endpoint (heartbeat every 25 s; on open marks online and sends pending requests, and delivered-but-unfinished ones again; new requests pushed through an in-process notifier; the DB stays the source of truth; a newer stream replaces an older one and a `connection_id` stops the old stream's close from flipping the device offline), network, logs (413 above 500, dedupe on device and `local_entry_id`), idempotent complete (404 for another device's request), dashboard queueing without login (201 new / 200 existing).
- Section 2: SQLite log (pure Go `modernc.org/sqlite` v1.38.2, the newest that builds with go 1.24; cap 5,000 plus a warning entry), confirm-then-clear upload with 413 splitting, SSE client with the 1/5/15/60 s backoff, reset after a healthy minute, 75 s idle drop and 401 stop; network snapshot and a change detector (30 s local interface fingerprint, collects and sends only on a real change); request handlers; `pcreader listen [--from-raw DIR]`.
- Section 3: start at login (HKCU Run value / per-user LaunchAgent, both with `--background`, re-asserted on every launch, `PCREADER_NO_AUTOSTART=1` and `--remove-autostart` for testing), background connection started when a set-up computer launches and after IT setup, signup and a changed server address, tray status line, connection chip in the window, "Update my details" opened with a message on `prompt_details_update`.
- Section 4: Online/Offline/Stale pills (stale after 48 h), last seen, agent version, filter, request buttons with state (the page refreshes every 3 s only while a request is open), Logs (level filter) and Network sections.
- Section 5: docs and data-use notice (connection, network on connect/change, logs and scans on request).

**Verified**
- `bun run lint` and `bun run test` pass (contracts 30, server 62, Go all packages, including `-race` on the new packages).
- End-to-end against a production `next start` server and real Postgres: `TestEndToEndListen` queues `scan_now`, `send_logs` and `prompt_details_update` after `pcreader listen` connected; all three arrive and complete, and `scan_now` carries a `scan_id`.
- Desktop CI builds on both runners (see the PR for the final run).

**What to check**
- `src/lib/agent/events.ts` stream lifecycle (`cleanup`, `connection_id`, abort and cancel paths); Next route handlers with a long-lived response behaved correctly in production mode locally, but not behind a proxy.
- Requests are marked `delivered` before they are written to the stream, so a lost write is recovered by the redelivery on reconnect (the agent ignores a duplicate id while it is handling it).
- Network changes that keep the same IPs (a gateway or Wi-Fi name change on the same address) are not noticed until the next reconnect, because the cheap fingerprint is addresses only.
- The migration adds columns with defaults and new tables; it can be applied to an M2 database.

**Could not verify (no GUI in the container)**
- The tray icon, the hidden start, the single-instance focus and the window opening on the details prompt on real Windows and macOS.
- The Windows Run entry and the macOS LaunchAgent are written and unit-tested for content only. The macOS plist starts the executable inside the bundle directly; if a Mac needs the bundle opened via `open`, adjust `autostart.plist`.
- The real Windows and macOS network collectors only run in CI as compile checks; the parsers are fixture-tested, and the light collection reuses the full scan's commands.
- Unplugging and replugging the network on a real PC (the user test in the plan).

