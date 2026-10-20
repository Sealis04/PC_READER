# PC_READER

Internal device-inventory tool. A Go reporter CLI on agency Windows/Mac PCs sends hardware scans to a Next.js + PostgreSQL server with a staff dashboard. Design: `docs/technical-spec.md`. Current milestone plan: `plans/m7-hris-login/plan.md`. Agent coordination: `plans/<branch>/INBOX.md`.

## Layout

- `contracts/` — JSON Schemas (scan payload v1, agent API requests/responses), Ajv validators and TS types (`@pcreader/contracts`), plus fixtures. **Source of truth for server and agent.** Changing a schema needs a note in INBOX.md and updated fixtures.
- `server/` — Next.js App Router (`@pcreader/server`). Agent API (`register`, `scans`, `PUT user`, `GET events` SSE, `network`, `logs`, `requests/{id}/complete`, `POST settings-unlock`) and the dashboard's `api/dashboard/devices/{id}/requests` and `api/dashboard/it-pin`, `api/dashboard/settings[/logo]` and the public `api/branding[/logo]` in `src/app/api/**/route.ts`, which delegate to testable handlers in `src/lib/agent/`. Drizzle schema in `src/db/schema.ts`, migrations in `server/drizzle/`.
- `agent/` — Go agent: CLI `pcreader` and Wails desktop app `pcreader-desktop` (modules `github.com/sealis04/pc_reader/agent`, plus `.../agent/desktop`). Both call the shared service layer `internal/app`; the desktop app also runs in the background (tray, start at login, one SSE connection; `internal/{background,events,locallog,netinfo,autostart}`); the desktop app is in `agent/desktop/` (`desktop/` is its own Go module (Wails' bindings generator compiles it without build tags) holding `main.go` and `frontend/`; the unit-tested UI methods are `internal/bound` = Vite + plain JS). Collectors run OS commands (`internal/scan/{windows,darwin}/collect.go`); parsers are pure and fixture-tested (`parse.go`). See `agent/README.md`.

## Commands (run from repo root unless noted)

CI (`.github/workflows/agent.yml`, `server.yml`) runs only on pushes to `main` (i.e. merges) and by hand (`workflow_dispatch`), not on PRs, to save Actions minutes (macOS counts 10x). Before opening a PR, run `bun run lint` and `bun run test` locally; to build the desktop apps for a PR branch, start the **agent** workflow by hand on that branch.

- `bun install` — install all workspaces
- `bun run lint` — `tsc --noEmit` + ESLint for every workspace, then `go vet` + gofmt for `agent/`
- `bun run test` — contract fixture tests, server tests (needs Postgres; `DATABASE_URL` defaults to `postgres://postgres@127.0.0.1:5432/pcreader_test`), then `go test -count=1 ./...` in `agent/`
- `cd agent && PCREADER_E2E_SERVER=http://127.0.0.1:3000 PCREADER_E2E_KEY=... go test -count=1 -run TestEndToEnd ./cmd/pcreader` — agent CLI against a running server
- `cd server && bun run dev` — dev server on `0.0.0.0:3000` (needs `DATABASE_URL`, `ENROLLMENT_KEY`)
- `cd server && bun run db:generate` — create a migration after editing `src/db/schema.ts` (never hand-edit generated SQL; CI fails if schema and migrations drift)
- `cd server && bun run db:migrate` — apply migrations
- `cd agent/desktop && wails build -platform windows/amd64` — desktop app (Windows/macOS only; CI builds it on `windows-latest`/`macos-latest` as the `pcreader-desktop` artifact). On Linux only `cd agent/desktop && GOOS=windows CGO_ENABLED=0 go vet ./` is possible; `go vet`/`go test ./...` in `agent/` skip the separate desktop module.
- `cd agent && PCREADER_E2E_SERVER=... PCREADER_E2E_KEY=... go test -count=1 -run TestEndToEndListen ./cmd/pcreader` — `pcreader listen` receives requests queued while it is connected
- `docker compose up -d --build` — full local server (needs `.env`, see `.env.example`)

## Conventions

- TypeScript strict. Package manager is bun; ORM is Drizzle (no Prisma).
- All timestamps are `timestamptz`, stored in UTC; the dashboard formats them in `DISPLAY_TIMEZONE` (default Asia/Manila).
- Agent endpoints return JSON errors `{ error, message, details? }` with the status codes in the spec (400 / 401 / 403 / 409 / 413).
- Device tokens are only stored as SHA-256 hashes. Never log tokens or personal details.
- Components are never deleted: a part missing from the latest scan gets `removed_at`. Identity is `match_key` (serial, MAC, or descriptive fields + occurrence counter) — see `src/lib/components.ts`.
- A scan older than the device's `last_full_scan_at` is stored but does not change components.
- History tables are append-only.
- Go: always run tests with `-count=1`; the test cache does not see fixture changes in `contracts/` (outside the module).
- No polling: PCs hold one SSE connection (`/api/agent/events`); scans and log uploads happen only on request. Online = stream open (`devices.online`, `connection_id` guards against an old stream flipping a reconnected device offline); Stale = offline over 48 h. The server assumes one instance (in-process notifier, DB is the source of truth).
- Logs are confirm-then-clear: the agent deletes only the `local_entry_id`s the server returns. Never put tokens or personal details in a log message.
- Raw scanner output → payload changes must keep `contracts/fixtures/payload/windows-desktop.json` and `macos-apple-silicon.json` as the exact parser output for `fixtures/raw/{windows,macos}`.
- IT PIN: without the hourly IT PIN the desktop app is view-only. The PIN is issued by the server (`server/src/lib/it-pin.ts`: HMAC of the `DISPLAY_TIMEZONE` hour + `it_pin_state.generation`; `IT_PIN_SECRET` overrides the stored secret) and shown on `/it-pin`. It gates Report now (server: `scan_type: manual`), signup (`/register`), Update my details (`PUT /user`) and Settings (`/settings-unlock`); `verifyPin` records every attempt in the append-only `settings_unlock_attempts` (method + device, or client IP at signup) and rate-limits 5 wrong per minute. Dashboard-requested work (scan_now, send_logs) needs none. The one exception to the PIN is IT's own "confirm details" request: it reaches the PC with an approval code (`lib/it-pin.ts` `deriveApproval`, HMAC of the request id), and `PUT /user` with `confirm` accepts it once, within 24 h, same employee ID only, closing the request (`lib/agent/user.ts`); the agent never completes `prompt_details_update` itself, and `expireStalePrompts` closes ones left for 24 h. The app keeps a correct PIN in memory only, for 10 minutes or until the window is hidden (`bound.App.Session`); never log, store or send the PIN or the key elsewhere. Only Settings falls back to the enrollment key (`config.json`'s `enrollment_key_hash`, `config.SecretHash`) when the server cannot answer.
- Branding: the single `app_settings` row (agency name, logo bytes, inventory prefix) is read and written only through `server/src/lib/settings.ts`; the dashboard `/settings` page and `/api/dashboard/settings[/logo]` edit it (staff login required), the public `GET /api/branding[/logo]` feeds the desktop app, which caches name and logo in `config.json` (`config.Branding`). Logos: PNG/JPEG/WebP only, max 512 KB, bytes must match the type. Keep agency-specific names out of code, builds and docs; "Asia/Manila" stays only as the default `DISPLAY_TIMEZONE`.
- Inventory numbers: `PREFIX-YYYY-NNNNN` (prefix from `app_settings`, default `INV`, `IA` on servers that already issued `IA-` numbers; year in `DISPLAY_TIMEZONE`), issued only through `server/src/lib/inventory.ts` (locks the device row, raises `inventory_counters`, writes history). Never update `devices.inventory_number`, `status` or `location` directly; history tables are append-only. See the README section "Inventory numbers, statuses and labels".
- Staff login: Better Auth with HRIS as the OIDC provider (`server/src/lib/auth.ts`, mounted at `/api/auth/[...all]`; tables `staff_*`, join key `staff_user.hris_sub`). Only `hris:user_level` in `HRIS_ALLOWED_USER_LEVELS` (default `IT`) gets a session (gate in `databaseHooks.session.create.before`). Every dashboard page calls `requireStaff()` and every `/api/dashboard/*` handler calls `requireStaffApi(req)` (`src/lib/staff-auth.ts`: 401, or 503 when the login env is missing); `src/proxy.ts` is only the cheap cookie check. `/login`, `/api/auth/*`, `/api/agent/*`, `/api/branding*` stay open. A new dashboard route without the guard fails the sweep in `test/staff-protection.test.ts`. Dashboard writes pass the staff id into `lib/*` as a parameter (`changed_by`, `requested_by`) and log `staff_events` (append-only; never tokens or the PIN).
