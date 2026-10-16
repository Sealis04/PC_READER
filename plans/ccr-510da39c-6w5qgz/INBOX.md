# INBOX — agent coordination

**Feature branch:** `ccr-510da39c-6w5qgz`
**Active builders:** none (Runs 1 and 2 done; next is the user's real-machine test)
**Reviewer:** not used in M1. **Do not fire the reviewer routine** — when done, stop after opening your PR. The planner takes it from there.

Full plan: [`plans/m1-thin-slice/plan.md`](../m1-thin-slice/plan.md). Spec: [`docs/technical-spec.md`](../../docs/technical-spec.md).

## Repo conventions (no repo CLAUDE.md yet — these apply)

- Package manager: **bun**. Root `package.json` is a bun workspace (`server/`) with scripts `lint` and `test` that also run Go checks once `agent/` exists, so `bun run lint` and `bun run test` from the root cover everything.
- ORM is **Drizzle** with drizzle-kit migrations (there is no Prisma in this repo; ignore any Prisma rule).
- TypeScript strict mode; ESLint via `next lint` or flat config.
- Times stored as `timestamptz` in UTC.
- Never log tokens or personal details.
- Create a repo `CLAUDE.md` documenting the commands you set up.

---

## builder-1

(Runs 1 and 2 completed — see reviewer section for summaries.)

---

## Next: user real-machine test (Phase 2)

1. `cp .env.example .env`, set `ENROLLMENT_KEY` and `POSTGRES_PASSWORD`, then `docker compose up -d --build`.
2. Download `pcreader-binaries` from the latest **agent** workflow run.
3. On a Windows PC and a Mac: `capture-raw --out pcreader-raw`, `register ...`, `scan --upload` (see `agent/README.md`).
4. Check both machines in the dashboard. Send back the `pcreader-raw` folders; they replace the sample fixtures, and parser fixes follow.

---

## reviewer

(Reviewer not used in M1. Builder summaries are kept here per the routine's instructions.)

### From builder-1 — Run 1 (built directly in the planner session at the user's request)

**Status:** DONE on `ccr-510da39c-6w5qgz` (Phase 0 commit `ba62f37`, server commit follows it).

**Files changed:** `package.json`, `bun.lock`, `.gitignore`, `.dockerignore`, `.env.example`, `docker-compose.yml`, `CLAUDE.md`, `README.md`, `.github/workflows/server.yml`, `agent/README.md`, `contracts/**`, `server/**`.

**What was done:**
- Phase 0: JSON Schemas for scan payload v1 and register/scans requests and responses, Ajv validators and TS types in `@pcreader/contracts`, payload/register/raw fixtures for Windows, Apple Silicon and Intel Mac, and fixture validation tests (14).
- Server: Drizzle schema and migration (users, devices, components, assignments, scans), `POST /api/agent/register`, `POST /api/agent/scans` with component sync, device list and detail pages, Docker Compose (db + migrate job + app), CI (lint, tests against Postgres, migration drift check, build). 27 server tests.
- Verified: `bun run lint` and `bun run test` pass; `next build` passes; `docker compose up --build` serves the dashboard and accepts register → scan (201) → duplicate (409) over HTTP.

**Contract decisions Run 2 must follow:**
- Payload uses arrays `cpus`, `gpus`, `storage`, `volumes`, `network.adapters`; `motherboard` is `null` on macOS; `memory.modules` is `null` on Apple Silicon.
- Every property is required (nullable instead of omitted); unknown properties are rejected. MAC addresses are upper-case, colon-separated.
- `system.chip_name` carries the Apple Silicon chip name. macOS `system.model` is `"<machine_name> (<machine_model>)"`.
- `storage[].is_internal: false` (USB drives) and `network.adapters[].is_physical: false` are stored in the scan but not turned into components.
- `payload.os_type` must equal the registered device's OS (else 400).
- Register: `403 invalid_enrollment_key`, `503 enrollment_disabled` (server has no key), `415` for a non-JSON content type. Scans: `409` returns `{ scan_id }` of the original. Body limit 2 MB (`413`).
- Token format `pcr_<43 base64url chars>`. Re-registering the same `device_uuid` rotates the token.
- `payload/windows-desktop.json` is the expected parser output for `raw/windows/`, and `payload/macos-apple-silicon.json` for `raw/macos/`.

**Deviations from the spec's data model:**
- `components.capacity` is `capacity_bytes` (bigint), with extra per-category fields in `details` (jsonb) and a `match_key` for identity across scans.
- `devices` also stores `manufacturer`, `model`, `serial_number` (from the registration summary, then the latest scan).
- `assignments.assigned_by` is text (`"self-registration"` for agent-created assignments) until staff accounts exist in M2.

**What to check:**
- Users are upserted by `employee_id`, so a registration can overwrite that employee's contact details. This is acceptable while registration needs the IT enrollment key; revisit with the Wails "update my details" flow.
- No dashboard login in M1 and plain HTTP: LAN test use only.
- Inside the cloud sandbox, Docker builds need the proxy CA (handled with a scratch override, not committed). On a normal computer, `docker compose up --build` works as is.


### From builder-1 — Run 2 (built directly in the planner session at the user's request)

**Status:** DONE on `ccr-510da39c-6w5qgz`.

**Files changed:** `agent/**` (new Go module), `.github/workflows/agent.yml` (new), `.github/workflows/server.yml`, `package.json`, `.gitignore`, `CLAUDE.md`, `contracts/scan-payload.v1.schema.json` (description only), `contracts/fixtures/payload/windows-desktop.json`, `contracts/fixtures/raw/*/README.md`.

**What was done:**
- `pcreader` CLI with `register`, `scan [--upload] [--out]`, `capture-raw`, `status`, `version`. `--from-raw DIR` parses a saved capture instead of scanning.
- Windows collector: one PowerShell process queries all CIM classes (`-EncodedCommand`), plus `netsh wlan`. macOS collector: one `system_profiler -json` call plus `sysctl`, `sw_vers`, `scutil`, `networksetup`, `ifconfig`, `route`, `ipconfig getsummary`, `df`.
- Pure parsers. Expected-output tests: `raw/windows` → `payload/windows-desktop.json` and `raw/macos` → `payload/macos-apple-silicon.json` must match exactly and validate against the schema. Edge-case tests cover Intel Macs, SATA HDDs, USB drives, a missing storage namespace, bridge ports, redacted SSIDs and PowerShell's single-object and wrapped-array outputs.
- API client implements the spec's error rules (400 no retry, 401 stop, 409 success, 429/5xx/network bounded retry). Token goes in Credential Manager / Keychain via go-keyring; config in the OS app-data folder.
- CI (`agent.yml`): gofmt, `go vet` for linux/windows/darwin, tests, an end-to-end test against a real server + Postgres, live scans on `windows-latest` and `macos-latest` runners (raw output uploaded as artifacts), and cross-compiled binaries with SHA256SUMS as the `pcreader-binaries` artifact.
- Verified locally: all Go tests pass; the end-to-end test against a local server registered both fixtures and uploaded two scans each (9 and 5 active components); all three binaries build; the darwin/arm64 binary carries an ad-hoc signature.

**Deviations from the plan:**
- macOS ships as two binaries (`darwin-arm64`, `darwin-amd64`) instead of one universal binary; building universal needs `lipo` on a macOS runner and isn't required for M1.
- IPv6 link-local (`fe80::/10`) addresses are left out on both platforms, so the Windows payload fixture lost its `fe80::` entry. The schema now documents this.
- `register` doesn't upload a first scan; run `scan --upload` after it.

**What to check:**
- The collectors have not yet run on real hardware. The CI live-scan jobs are the first real run; the user's machines are the second.
- Windows: the SSID is parsed from English `netsh` output only; other locales give null.
- macOS: DNS servers and gateway are only attached to the default-route interface.
