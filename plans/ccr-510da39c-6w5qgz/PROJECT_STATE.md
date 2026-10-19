# Project state — ccr-510da39c-6w5qgz

**Goal (current):** Milestone 3 — background app and on-request actions (see `plans/m3-background-reporter/plan.md`).

## In progress
- builder-1: M3 — tray spike, SSE events stream + on-request scan/logs/details prompt, local log, network snapshots, start at login, dashboard online/requests/logs/network

## Queued
- Planner checks builder-1's PR and CI; user reviews and merges
- Real-machine test of M3 on Windows (and a Mac)
- Later milestones: staff login and roles, status history, tagging, PM reports, installer, HTTPS

## Open items
- Mac real-machine CLI test skipped (CI live-scans a macOS VM only)

## Done
- M2: desktop app (IT setup with one-time PIN, signup, My computer, Report now, Update my details, Settings), `PUT /api/agent/user`; tested on a real Windows PC; PR #4 merged into the feature branch (2026-10-19)
- M1: contracts, server (register, scans, dashboard), Go CLI agent with Windows/macOS scanners, CI with live scans and cross-compiled builds
- M1 real-machine test on Windows: passed (2026-10-19)

## Files touched
- `contracts/**`, `server/**`, `agent/**`, `.github/workflows/*`, `docker-compose.yml`, `CLAUDE.md`, `README.md`
- `plans/m1-thin-slice/*`, `plans/m2-desktop-demo/*`, `plans/m3-background-reporter/plan.md`, `plans/ccr-510da39c-6w5qgz/*`
