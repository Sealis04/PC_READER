# PC_READER

Internal device-inventory tool. A Go reporter CLI on agency Windows/Mac PCs sends hardware scans to a Next.js + PostgreSQL server with a staff dashboard. Design: `docs/technical-spec.md`. Current milestone plan: `plans/m1-thin-slice/plan.md`. Agent coordination: `plans/<branch>/INBOX.md`.

## Layout

- `contracts/` — JSON Schemas (scan payload v1, agent API requests/responses), Ajv validators and TS types (`@pcreader/contracts`), plus fixtures. **Source of truth for server and agent.** Changing a schema needs a note in INBOX.md and updated fixtures.
- `server/` — Next.js App Router (`@pcreader/server`). Agent API in `src/app/api/agent/*/route.ts`, which delegate to testable handlers in `src/lib/agent/`. Drizzle schema in `src/db/schema.ts`, migrations in `server/drizzle/`.
- `agent/` — Go reporter (Milestone 1, Run 2).

## Commands (run from repo root unless noted)

- `bun install` — install all workspaces
- `bun run lint` — `tsc --noEmit` + ESLint for every workspace
- `bun run test` — contract fixture tests, then server tests (needs Postgres; `DATABASE_URL` defaults to `postgres://postgres@127.0.0.1:5432/pcreader_test`)
- `cd server && bun run dev` — dev server on `0.0.0.0:3000` (needs `DATABASE_URL`, `ENROLLMENT_KEY`)
- `cd server && bun run db:generate` — create a migration after editing `src/db/schema.ts` (never hand-edit generated SQL; CI fails if schema and migrations drift)
- `cd server && bun run db:migrate` — apply migrations
- `docker compose up -d --build` — full local server (needs `.env`, see `.env.example`)

## Conventions

- TypeScript strict. Package manager is bun; ORM is Drizzle (no Prisma).
- All timestamps are `timestamptz`, stored in UTC; the dashboard formats them in `DISPLAY_TIMEZONE` (default Asia/Manila).
- Agent endpoints return JSON errors `{ error, message, details? }` with the status codes in the spec (400 / 401 / 403 / 409 / 413).
- Device tokens are only stored as SHA-256 hashes. Never log tokens or personal details.
- Components are never deleted: a part missing from the latest scan gets `removed_at`. Identity is `match_key` (serial, MAC, or descriptive fields + occurrence counter) — see `src/lib/components.ts`.
- A scan older than the device's `last_full_scan_at` is stored but does not change components.
- History tables are append-only.
