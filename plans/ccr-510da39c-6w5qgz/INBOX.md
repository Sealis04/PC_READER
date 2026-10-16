# INBOX — agent coordination

**Feature branch:** `ccr-510da39c-6w5qgz`
**Active builders:** builder-1 only (Run 1 done; Run 2 queued)
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

(Run 1 completed — see reviewer section for summary. Run 2 is queued below.)

---

## Queued (planner will assign after Run 1 merges — builder-1 do not start these)

**Run 2 — Go agent.** See plan section "Run 2". The planner merges the Run 1 PR into the feature branch, moves these tasks under `## builder-1`, and fires builder-1 again.

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
