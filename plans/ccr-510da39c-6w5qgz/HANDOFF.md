# Handoff — ccr-510da39c-6w5qgz

PC_READER is an internal device-inventory tool: a Go reporter on agency Windows/Mac PCs sends hardware scans to a Next.js + PostgreSQL server with a staff dashboard. The full design is in `docs/technical-spec.md`.

Milestone 1 proves the pipeline end to end with the smallest surface: a CLI registers a real PC and uploads one scan, and the dashboard lists it. No GUI, no background service, no staff login yet.

Key decisions (details in `plans/m1-thin-slice/plan.md`): bun + Drizzle on the server; PowerShell CIM JSON on Windows and `system_profiler -json` on macOS; parsers are pure functions tested against fixtures in `contracts/fixtures/raw/` so they run on Linux CI; the user tests on real machines against a Docker Compose server on their own computer.

The shared contract in `contracts/` is the source of truth both the server and the agent build against. Changing it requires a note in INBOX.md.

## Milestone 2 (current)

M1 is done: the CLI agent registered and uploaded a real Windows PC, and CI live-scans Windows and macOS runners. M2 adds the Wails desktop app (IT setup, signup, "My computer" specs screen with Report now, Update my details) and `PUT /api/agent/user`. No installer, background reporter, staff login or HTTPS yet. Plan: `plans/m2-desktop-demo/plan.md`.
