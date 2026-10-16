# INBOX — agent coordination

**Feature branch:** `ccr-510da39c-6w5qgz`
**Active builders:** builder-1 only
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

**Run 1 of 2 — Phase 0 (contract + scaffold), then server.** Details: plan sections "Repository layout" and "Run 1".

1. **Phase 0 — commit separately before anything else:**
   - Repo layout: `contracts/`, `server/`, `agent/` (placeholder `README.md` only), `docker-compose.yml`, `.github/workflows/`, root `package.json` + `CLAUDE.md`.
   - `contracts/scan-payload.v1.schema.json` covering every field in the spec's "Scan field mapping" table; unsupported fields are `null`, never omitted; `schema_version: 1`.
   - Request/response schemas for `POST /api/agent/register` and `POST /api/agent/scans`.
   - Payload fixtures: Windows desktop, Apple Silicon Mac, Intel Mac (invented values, marked as samples).
   - Raw-output fixtures for the Windows CIM classes and macOS commands listed in the spec (best-effort realistic samples).
   - A test that validates every payload fixture against the schema.
2. **Server (`server/`)** — Next.js App Router + Drizzle + PostgreSQL:
   - Schema + migrations for `users`, `devices`, `components`, `assignments`, `scans` per spec Data model.
   - `POST /api/agent/register`: checks `ENROLLMENT_KEY` env var; creates/updates user, device, open assignment; returns `201` with device_id, token (once), check-in interval; stores only the token hash.
   - `POST /api/agent/scans`: bearer auth (`401`), schema validation (`400`), `scan_uuid` dedupe (`409`), raw payload as JSONB, component sync (new rows; `removed_at` on missing; Apple Silicon CPU/RAM/storage `is_integrated = true`; no motherboard row on Mac), updates `last_full_scan_at` / `last_seen_at`.
   - Dashboard: device list (hostname, OS, assigned user, department, last scan) and device detail (system info, components, latest raw scan). No login in M1.
   - `docker-compose.yml`: app + Postgres, app bound to `0.0.0.0` so LAN machines can reach it; `.env.example` (do not create or edit `.env`).
   - Integration tests posting the fixtures through register + scans and asserting DB state.
   - GitHub Actions workflow running lint + tests (Postgres service container).

**Done when:** schemas validate fixtures, migrations run on a fresh Postgres, `bun run lint` and `bun run test` pass, `docker compose up` serves the dashboard.

Out of scope for this run: anything in `agent/` beyond the placeholder.

---

## Queued (planner will assign after Run 1 merges — builder-1 do not start these)

**Run 2 — Go agent.** See plan section "Run 2". The planner merges the Run 1 PR into the feature branch, moves these tasks under `## builder-1`, and fires builder-1 again.

---

## reviewer

(Not used in M1. Builder summaries go here per the routine's instructions.)
