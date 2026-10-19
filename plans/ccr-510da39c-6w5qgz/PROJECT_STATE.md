# Project state — ccr-510da39c-6w5qgz

**Goal (current):** Milestone 3 — background app and on-request actions (see `plans/m3-background-reporter/plan.md`).

## In progress
- Nothing; next milestone not planned yet

## Queued
- Merge `ccr-510da39c-6w5qgz` (M2 + M3) into `main`
- Later milestones: staff login and roles, status history, tagging, PM reports, installer, HTTPS

## Open items
- Mac real-machine test skipped for M1–M3 (CLI, desktop app, tray, start at login) (CI live-scans a macOS VM only)

## Done
- M3: background app (start at login, tray, SSE wakeups, on-request scan/logs/details prompt, network snapshots, local log), dashboard online/stale/requests/logs/network, Windows NSIS installer; PRs #6 and #7 merged; tested on a real Windows PC (2026-10-19)
- M2: desktop app (IT setup with one-time PIN, signup, My computer, Report now, Update my details, Settings), `PUT /api/agent/user`; tested on a real Windows PC; PR #4 merged into the feature branch (2026-10-19)
- M1: contracts, server (register, scans, dashboard), Go CLI agent with Windows/macOS scanners, CI with live scans and cross-compiled builds
- M1 real-machine test on Windows: passed (2026-10-19)

## Files touched
- `contracts/**`, `server/**`, `agent/**`, `.github/workflows/*`, `docker-compose.yml`, `CLAUDE.md`, `README.md`
- `plans/m1-thin-slice/*`, `plans/m2-desktop-demo/*`, `plans/m3-background-reporter/plan.md`, `plans/ccr-510da39c-6w5qgz/*`
