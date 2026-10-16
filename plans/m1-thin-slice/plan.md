# Milestone 1 — End-to-end thin slice

Source spec: [`docs/technical-spec.md`](../../docs/technical-spec.md). Visual version of this plan: https://claude.ai/artifact/UnymAgxyNK6brKnbYmnnyz

## Goal

A real Windows PC and a real Mac each run `pcreader register` (enrollment key + user details), then `pcreader scan --upload`. The server stores the device, user, assignment, raw scan and parsed components. A staff member opens the dashboard and sees both machines with their specs.

**Out of scope for M1:** Wails desktop UI, background service / LaunchAgent, `/checkin`, `/logs`, tagging, statuses, PM reports, exports, staff roles and login.

## Decisions

| Topic | Decision |
| --- | --- |
| First milestone | End-to-end thin slice |
| Platforms | Windows 10/11 and macOS (Intel + Apple Silicon); the user tests on real machines |
| Device side | Go reporter CLI only; Wails signup form moves to M2 |
| Test server | Docker Compose on the user's own computer; test PC and Mac connect over the LAN. Plain HTTP (or self-signed) is acceptable for M1. The agent takes a `--server` URL |
| Dashboard login | None in M1 (local only). Auth.js staff login arrives in M2 |
| Server ORM | Drizzle (with drizzle-kit migrations) |
| Windows scans | Go agent runs PowerShell `Get-CimInstance <Class> \| ConvertTo-Json`; the same command captures raw fixtures |
| macOS scans | `system_profiler -json <DataTypes>`, `sysctl`, `sw_vers`, `scutil` |
| Build delivery | GitHub Actions artifacts: Windows `.exe` (amd64) and macOS universal binary |
| Staffing | Builder 1 only, in two sequential runs. Builder 2 and reviewer not used in M1 |

## Repository layout

```
contracts/            # JSON Schemas + fixtures shared by server and agent
  scan-payload.v1.schema.json
  agent-api/register.request.schema.json, register.response.schema.json
  agent-api/scans.request.schema.json, scans.response.schema.json
  fixtures/payload/windows-desktop.json, macos-apple-silicon.json, macos-intel.json
  fixtures/raw/windows/*.json   # raw Get-CimInstance output per class
  fixtures/raw/macos/*.json|txt # raw system_profiler / sysctl output
server/               # Next.js (App Router) + Drizzle + PostgreSQL
agent/                # Go module: cmd/pcreader, internal/scan/{windows,darwin}, internal/api, internal/store
docker-compose.yml    # app + postgres for local testing
.github/workflows/    # server tests, agent tests, agent cross-compile
```

## Phases

### Run 1 — Builder 1: Phase 0 (contract + scaffold), then server

**Phase 0 — contract and scaffold (do first, commit separately)**
1. Repo layout above, root README updated with how to run.
2. `contracts/scan-payload.v1.schema.json` covering every field in the spec's "Scan field mapping" table. Fields a platform can't supply are `null`, never omitted. Include `schema_version: 1`.
3. Request/response schemas for `POST /api/agent/register` and `POST /api/agent/scans` as in the spec's Agent API table.
4. Payload fixtures: one Windows desktop, one Apple Silicon Mac, one Intel Mac. Realistic but invented values; mark them as samples.
5. Raw-output fixtures for the Windows CIM classes and macOS commands the scanners will parse (best-effort realistic samples; the user replaces them with real captures later).
6. A schema check (script or test) that validates all payload fixtures.

**Phase 1 — server**
1. Next.js App Router app in `server/`, Drizzle schema + migrations for `users`, `devices`, `components`, `assignments`, `scans` (fields per spec Data model; all with `id` UUID, `created_at`, `updated_at`).
2. `POST /api/agent/register`: checks the enrollment key (from env var `ENROLLMENT_KEY` in M1), creates/updates user, device and an open assignment, returns `201` with device_id, device token (once) and check-in interval. Stores only a hash of the token.
3. `POST /api/agent/scans`: bearer token auth, validates against the contract schema (`400` on invalid), dedupes on `scan_uuid` (`409`), stores raw payload as JSONB, syncs `components` (insert new, set `removed_at` on missing; Apple Silicon CPU/RAM/storage `is_integrated = true`, no motherboard row on Mac), updates `last_full_scan_at` / `last_seen_at`.
4. Dashboard: device list (hostname, OS, assigned user, department, last scan) and device detail (system info, components, latest raw scan). No login in M1.
5. `docker-compose.yml` running app + Postgres; listens on `0.0.0.0` so LAN machines can reach it.
6. Integration tests posting the payload fixtures through register + scans and asserting the DB state. CI workflow runs them.

**Done when:** schemas validate fixtures, migration runs on a fresh Postgres, integration tests pass in CI, `docker compose up` serves the dashboard.

### Run 2 — Builder 1: Go agent

1. Go module in `agent/`. `Scanner` interface; `windows` and `darwin` implementations behind build tags; pure parser functions that take raw command output and return the payload struct, so they are testable on Linux.
2. Parser unit tests against `contracts/fixtures/raw/*`; generated payloads must validate against `scan-payload.v1.schema.json`.
3. CLI: `pcreader register --server URL --key KEY --name ... --employee-id ... --email ... --department ... --position ... --phone ...`, `pcreader scan [--upload] [--out file.json]`, `pcreader capture-raw --out dir/` (dumps raw command output so the user can send real fixtures back).
4. `device_uuid` generated at first registration and stored in a local config file in the OS app-data folder; token stored with the OS credential store (Windows Credential Manager / macOS Keychain, e.g. via `github.com/zalando/go-keyring`).
5. Error handling per spec table (400 no retry, 401 stop, 409 success, 429/5xx/timeout backoff 1/5/15/60 min — for the CLI, a bounded retry then exit non-zero is acceptable).
6. GitHub Actions: `go test ./...`, cross-compile `pcreader.exe` (windows/amd64) and a macOS universal binary (`lipo` on a macOS runner, ad-hoc signed), uploaded as workflow artifacts.

**Done when:** parser tests pass, CI produces downloadable Windows and Mac binaries, and a scan from the fixtures uploads successfully to the local server in an end-to-end test.

### Phase 2 — User real-machine test

1. User runs `docker compose up` on their computer.
2. On a Windows PC and a Mac: download builds, `pcreader capture-raw`, `pcreader register`, `pcreader scan --upload`.
3. Both machines show in the dashboard with correct specs. Raw captures are committed as fixtures; parser fixes follow.

## Risks

- WMI / `system_profiler` keys differ from expectations → parsers are pure and fixture-driven; real captures from Phase 2 replace samples.
- Wi-Fi SSID needs Location permission → stored as `null`, not an error.
- Unsigned macOS binary blocked by Gatekeeper → ad-hoc signature + "Open Anyway" instructions in the README.
