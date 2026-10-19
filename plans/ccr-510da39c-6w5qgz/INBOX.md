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

## builder-1 — FIX REQUEST (2026-10-19, M3 round 2)

Base: PR #6 (`claude/cool-volta-kmltjl`, commit ef80c02). The user tested the `pcreader-desktop` build on a real **Windows** PC, launched directly from Downloads (no install).

**1. Tray icon does not respond (bug).** The icon shows in the notification area, but left-click does nothing and right-click shows no menu. Likely cause: `agent/desktop/tray.go` uses `systray.RunWithExternalLoop` and calls `start()` from Wails' `OnStartup`, which runs on a goroutine with no Windows message loop, so the tray's hidden window never gets its messages. Fix:
- On Windows, run the tray on its own goroutine with `runtime.LockOSThread()` and the library's own message loop (`systray.Run`, or the external-loop variant plus a pump on that locked thread). Keep the macOS path on Wails' main thread.
- **Left-click** (and double-click) opens the window (`systray.SetOnTapped` / `SetOnClick` or the library's equivalent). **Right-click** shows the menu.
- Menu: "Open PC_READER", "Report now", a disabled status line ("Connected" / "Offline" / "Re-registration needed"). Still no Quit item.
- "Open PC_READER" must show and focus the window even when it was started hidden with `--background` or closed (hidden) by the user. Launching the app again (Start menu, desktop shortcut or the exe) must also bring the window back through the single-instance lock.
- Add a Windows-only test where practical (e.g. that the tray is started on a locked thread / the open callback shows the window), and note in your summary exactly what you could and could not verify without a GUI.

**2. Windows installer (new, user decision).** Running the exe from Downloads means the start-at-login entry points at Downloads and there is no Start menu entry.
- Build an NSIS setup with Wails (`wails build -nsis -platform windows/amd64`; install NSIS on the runner if `makensis` is missing). Upload it in the `pcreader-desktop` artifact next to the plain exe (e.g. `PC_READER-setup.exe`).
- Installs to Program Files, adds a Start menu shortcut and a desktop shortcut, and an uninstall entry. Product name "PC_READER", version from `wails.json`.
- After install, start the app (normal window, so IT can do setup). Start-at-login keeps pointing at the **installed** exe (the app already re-asserts the Run value on each launch; make sure it uses the current exe path).
- Uninstall: close the running app, remove the Run value, remove shortcuts. Leave `config.json`, the local log and the credential-store token in place (document how to remove them).
- macOS stays drag-to-Applications; check that the LaunchAgent points at the app inside `/Applications` when installed there.
- Update `agent/README.md`: "Install on Windows" (SmartScreen note for the unsigned setup) and "Install on Mac".

**Done when:** CI is green on your PR, including the desktop jobs, and the artifact contains the Windows setup.

**Branching:** reset your assigned branch onto `origin/claude/cool-volta-kmltjl`, fix, push, and **open a PR into `ccr-510da39c-6w5qgz`** that supersedes #6 (say so in the PR body). Keep your M3 summary below and add a `#### Round 2` part to it. Do not fire the reviewer.

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

#### Round 2 (2026-10-19)

Branch `claude/cool-volta-jtexlv`, based on PR #6 (`claude/cool-volta-kmltjl`, ef80c02); this PR supersedes #6.

**Tray fix** (`agent/desktop/tray.go`, `main.go`, `tray_test.go`). Cause as suspected: `systray.RunWithExternalLoop` starts the Windows message pump (`nativeStart`) on an ordinary goroutine, from Wails' `OnStartup`, which is not locked to the thread that owns the tray's hidden window. On Windows the tray now runs `systray.Run` on its own goroutine under `runtime.LockOSThread()` (`runPinned`), so window and loop share a thread. macOS is unchanged (`RunWithExternalLoop` on Wails' main thread). Left-click/double-click calls `systray.SetOnTapped(open)`; right-click uses the library menu: "Open PC_READER", "Report now" (new, runs `bound.App.ReportNow`), disabled status line, no Quit. `showWindow` does Unminimise + Show and a brief always-on-top toggle so the window comes to the front even when started with `--background`; the single-instance callback uses the same function.

**Installer.** `agent/desktop/build/windows/installer/project.nsi` (Wails template, customised; `wails_tools.nsh` is generated by Wails at build): installs to `Program Files\PC_READER`, Start menu + desktop shortcuts, uninstall entry, closes the running app before install/uninstall (`taskkill`, since there is no quit item), starts the app after install through explorer.exe (as the signed-in user, normal window), uninstall removes the Run value and leaves `%AppData%\PCReader` and the stored token (documented). CI: Windows job installs NSIS if missing, builds with `-nsis`, and uploads `PC_READER-setup.exe` next to `pcreader-desktop.exe` in the `pcreader-desktop` artifact. README: "Install on Windows" (SmartScreen note) and "Install on Mac". Start-at-login already uses `os.Executable()` on every launch, so it follows the installed exe; on macOS the LaunchAgent points at the app wherever it runs from (documented: install into /Applications before first launch).

**Verified:** `GOOS=windows go vet` and test compilation of the desktop module; gofmt; `makensis` compiles `project.nsi` with a rendered `wails_tools.nsh` and a dummy exe on Linux (NSIS 3.09).
**Not verified (no GUI/Windows here):** that clicks now reach the tray on a real Windows PC; the installer actually running, shortcuts, uninstall, the explorer launch; that CI's NSIS step finds `makensis` on the runner (the step adds `C:\Program Files (x86)\NSIS` to PATH after choco). The unit tests only cover `runPinned` and the callbacks, not the Windows message loop. Please click-test on a real PC.
