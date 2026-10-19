# Milestone 2 — Desktop app demo

Source spec: [`docs/technical-spec.md`](../../docs/technical-spec.md). M1 plan and results: [`plans/m1-thin-slice/plan.md`](../m1-thin-slice/plan.md). Visual plan: https://claude.ai/artifact/UnymAgxyNK6brKnbYmnnyz

## Goal

Show the desktop app working on a few Windows PCs and Macs: IT enters the server and enrollment key once, the user signs up in a window, sees their computer's specs, can correct their details, and can press "Report now". Everything reuses the M1 scanners and server.

**Out of scope for M2:** installer (MSI/pkg), background reporter (Windows Service / LaunchAgent, 24-hour schedule, `/checkin`, `/logs`), dashboard staff login, HTTPS, code signing.

## Decisions

| Topic | Decision |
| --- | --- |
| M2 goal | Desktop app demo on a few machines (decided 2026-10-19) |
| Mac real-machine test | Skipped for now; Windows passed on a real PC and CI live-scans a macOS VM. Open item. |
| First launch | "IT setup" screen: server URL + enrollment key, with a connection check, then the user's signup form |
| Signup fields | Required: full name, employee ID, department. Optional: email, position, phone (current split kept; user can change later) |
| Data-use notice | Shown on the signup form; a checkbox must be ticked to submit (same text as the CLI notice) |
| Specs screen | Summary card (computer name, model, serial, OS, CPU, memory, disks with free space, IP address, assigned user, last report time) plus an expandable "Full details" view of the whole scan, grouped by section |
| Update my details | Included. New endpoint `PUT /api/agent/user` |
| Report now | Button on the specs screen: scan + upload, shows result |
| Desktop framework | Wails v2 (Go + HTML/JS), as in the spec. Frontend: plain HTML/CSS/JS via Vite, built with bun |
| Builders | Builder 1 only, then the Reviewer routine |

## Work breakdown (Builder 1, in this order)

### 1. Contract + server: `PUT /api/agent/user`
- `contracts/agent-api/user.request.schema.json`: the `user` object from `register.request` (same fields and rules, `policy_acknowledged` not required here). Add a fixture and contract test.
- `server/src/app/api/agent/user/route.ts` → handler in `server/src/lib/agent/user.ts`. Bearer device token (401 otherwise), schema validation (400).
  - Same `employee_id` as the device's open assignment's user → update that user's fields.
  - Different `employee_id` → upsert that user, close the old assignment and open a new one with `assigned_by = "self-service"`.
  - Returns `200` with the stored user (same shape as the request).
- Integration tests for both paths, 401 and 400.

### 2. Agent: shared service layer
- Move the register / scan / upload / status logic out of `agent/cmd/pcreader/main.go` into a package (e.g. `agent/internal/app`) that both the CLI and the desktop app call. The CLI's behaviour and tests must not change.
- Add `api.Client.UpdateUser`.
- Keep locally (in `config.json`, never in logs): the user's details as last sent, `last_report_at`, and the last scan payload (for the specs screen without rescanning on every launch).

### 3. Desktop app (Wails v2)
- Lives in the agent module so it can use `internal/` packages, e.g. `agent/desktop/` with `wails.json` and `frontend/`. **All Wails-dependent Go files carry a build tag (e.g. `//go:build desktop`) so `go vet ./...` and `go test ./...` on Linux keep passing without GTK/WebKit.** The Go methods bound to the UI must be in an untagged, unit-tested package.
- Screens:
  1. **IT setup** (shown when no server is configured): server URL, enrollment key, "Check connection" (calls the server, e.g. `GET /devices` or a cheap request), Continue. The key is held in memory until signup, not written to disk.
  2. **Signup**: the six fields with required markers, data-use notice + checkbox, Submit → runs a scan, registers, uploads the first scan, saves state. Inline field errors; server errors shown in plain words (wrong key, server unreachable).
  3. **My computer** (home once registered): summary card, "Full details" expandable sections, "Report now" (shows progress and the result time), "Update my details", and a re-registration message if the server returns 401.
  4. **Update my details**: prefilled form, Save → `PUT /api/agent/user`.
- Window title "PC_READER", plain agency-appropriate styling; must work in light and dark OS themes.
- Uses the same config folder and token store as the CLI, so a machine registered by the CLI opens straight to "My computer".

### 4. CI + docs
- New workflow job(s) that build the desktop app on `windows-latest` (`wails build -platform windows/amd64`) and `macos-latest` (`darwin/universal`) and upload them as the `pcreader-desktop` artifact. Existing agent and server jobs must stay green.
- `agent/README.md`: how to run and build the desktop app; how IT does first-time setup; Gatekeeper / SmartScreen notes.
- Update `CLAUDE.md` commands.

## Done when
- `bun run lint` and `bun run test` pass (including new server tests and Go tests for the service layer and bound methods).
- CI builds the Windows `.exe` and macOS `.app` and uploads them.
- On a real PC: first launch → IT setup → signup → the device appears in the dashboard with the user; "Update my details" changes the dashboard's assigned user; "Report now" updates the last scan time.

## Risks
- Wails needs CGO and the OS webview, so it can't be built in a Linux container → build in CI on Windows/macOS runners; keep logic in testable Go.
- WebView2 is preinstalled on Windows 10/11 recent builds; older machines may need the runtime.
- Unsigned `.app` needs "Open Anyway" on each Mac.
