# Project state — ccr-510da39c-6w5qgz

**Goal (current):** Milestone 2 — desktop app demo (see `plans/m2-desktop-demo/plan.md`).

## In progress
- builder-1: `PUT /api/agent/user`, agent service layer, Wails desktop app, desktop CI builds

## Queued
- Planner checks builder-1's PR and CI; user reviews and merges
- Real-machine demo of the desktop app on Windows (and a Mac)

## Open items
- Mac real-machine CLI test skipped (CI live-scans a macOS VM only)

## Done
- M1: contracts, server (register, scans, dashboard), Go CLI agent with Windows/macOS scanners, CI with live scans and cross-compiled builds
- M1 real-machine test on Windows: passed (2026-10-19)

## Files touched
- `contracts/**`, `server/**`, `agent/**`, `.github/workflows/*`, `docker-compose.yml`, `CLAUDE.md`, `README.md`
- `plans/m1-thin-slice/*`, `plans/m2-desktop-demo/plan.md`, `plans/ccr-510da39c-6w5qgz/*`
