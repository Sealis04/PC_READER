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
