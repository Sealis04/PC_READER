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
