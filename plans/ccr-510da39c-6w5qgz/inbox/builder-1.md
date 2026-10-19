# builder-1 tasks — Milestone 3 (background app and on-request actions)

**Current task: `## builder-1 — M3` in `../INBOX.md`.** Base your work on `origin/claude/fervent-mendel-9y30q4` (feature branch with M2 merged, plus the M3 plan).

**Repository:** `Sealis04/PC_READER` (https://github.com/Sealis04/PC_READER). If your working directory is a different repository, switch to a checkout of this one first (`git remote -v` must show Sealis04/PC_READER).
**Feature branch:** `ccr-510da39c-6w5qgz`

The full assignment is in [`../INBOX.md`](../INBOX.md) (section `## builder-1 — M3`, plus "Branch to work on" and "Repo conventions"), and the plan is in [`../../m3-background-reporter/plan.md`](../../m3-background-reporter/plan.md). Read both; this file only points to them.

Summary:
0. Tray spike (Wails v3 or a tray library next to Wails v2), proven by CI on Windows and macOS.
1. Contract + server: SSE events stream that pushes dashboard requests, network snapshots, logs, request completion; dashboard request queueing.
2. Agent: local SQLite log, events client, network snapshots on connect/change, request handlers, `pcreader listen`.
3. Desktop: start at login hidden, tray icon (no quit), close hides, single instance, details prompt.
4. Dashboard: online/last seen/stale, request buttons, Logs and Network sections.
5. CI + docs.

Work on your session's assigned branch, open the PR into `ccr-510da39c-6w5qgz`, and do **not** fire the reviewer.
