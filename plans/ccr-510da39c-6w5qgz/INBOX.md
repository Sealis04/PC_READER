# INBOX — agent coordination

**Repository:** `Sealis04/PC_READER` — if your working directory is another repository, switch to a checkout of this one (`git remote -v`).
**Feature branch:** `ccr-510da39c-6w5qgz`
**Active builders:** builder-1 only
**Reviewer:** not used for M5. **Do not fire the reviewer routine.** When done, open your PR and stop; the planner checks CI and reports to the user.
**Milestone:** M5 — hourly IT PIN from the dashboard. Plan: [`plans/m5-hourly-it-pin/plan.md`](../m5-hourly-it-pin/plan.md). History: `plans/m{1..4}-*/inbox-log.md`.

## Branch to work on (overrides the routine prompts)

Your session is assigned its own branch (e.g. `claude/<name>`) and must not push elsewhere. Use that assigned branch as your working branch:

1. `git fetch origin claude/fervent-mendel-9y30q4 && git checkout -B <your-assigned-branch> origin/claude/fervent-mendel-9y30q4` — that branch is PR #8 (M4, not yet merged into `ccr-510da39c-6w5qgz`) plus the M5 plan and this INBOX.
2. Commit and push only to your assigned branch: `git push -u origin <your-assigned-branch>` (use `--force-with-lease` once after the reset if the push is rejected).
3. Open the PR from your assigned branch into `ccr-510da39c-6w5qgz`. Opening the PR is required.

## Repo conventions

See the repo `CLAUDE.md`. In short: bun + Drizzle (no Prisma, no `db:push`; `cd server && bun run db:generate` after schema changes, `bun run db:migrate` to apply); Go tests with `-count=1`; `bun run lint` and `bun run test` from the root run everything (server tests need Postgres, `DATABASE_URL` defaults to `postgres://postgres@127.0.0.1:5432/pcreader_test`). The desktop app is its own Go module in `agent/desktop/` (Wails v2); shared logic lives in `agent/internal/` and is unit-tested on Linux.

---

## builder-1 — M5 (2026-10-19)

Implement sections 1–4 of `plans/m5-hourly-it-pin/plan.md`, in order, as separate commits:

1. **Contract + server:** `settings-unlock` request/response schemas; server secret (DB or `IT_PIN_SECRET`); hourly 6-digit PIN (hour in `DISPLAY_TIMEZONE`, "Change now" bumps a generation); `POST /api/agent/settings-unlock` with constant-time compare, per-device rate limit (429) and an append-only attempts table; dashboard "IT PIN" box with countdown and Change now; attempts on the device page; tests.
2. **Agent:** `api.Client.UnlockSettings`; `config.EnrollmentKeyHash` replaces `ITPin` (old value dropped); hash saved after IT setup / re-registration; `bound.UnlockSettings` tries the server and falls back to the enrollment key only when the server is unreachable; keep 5 tries / 60 s lockout; tests.
3. **Desktop app:** remove PIN fields from IT setup; new Settings prompt texts; 401 banner asks for the enrollment key.
4. **CI + docs:** READMEs (where to find the PIN, offline fallback, reset, no-login risk), `CLAUDE.md`.

This stacks on PR #8 (M4). Keep M4 files untouched except where M5 needs them.

**Done when:** `bun run lint` and `bun run test` pass, CI (desktop builds included) is green, and your PR into `ccr-510da39c-6w5qgz` is open with a summary below. In the PR body say it stacks on #8 and should be merged after it.

---

## reviewer

Not used for M5. builder-1: write your summary here under `### From builder-1` (files changed, what was done, what to check, what you could not verify), then stop.

### From builder-1 (M5)

**Status:** DONE — PR into `ccr-510da39c-6w5qgz`, stacked on #8 (merge after it). `bun run lint` and `bun run test` pass locally (contracts 34, server 98, Go all packages); `next build` and the desktop frontend (`vite build` with stubbed Wails bindings) build; `GOOS=windows go vet` of `agent/desktop` is clean; `db:generate` reports no drift.

**Files changed**
- Contracts: `contracts/agent-api/settings-unlock.{request,response}.schema.json`, `contracts/fixtures/settings-unlock/*`, `contracts/index.ts`, `contracts/test/fixtures.test.ts`, `contracts/fixtures/README.md`.
- Server: `src/db/schema.ts` + migration `drizzle/0003_nostalgic_luminals.sql` (+ snapshot/journal), `src/lib/it-pin.ts`, `src/lib/agent/settings-unlock.ts`, `src/app/api/agent/settings-unlock/route.ts`, `src/app/api/dashboard/it-pin/route.ts`, `src/app/it-pin/{page,pin-box}.tsx`, `src/app/layout.tsx` (nav link), `src/app/devices/[id]/page.tsx` (attempts list), `src/lib/http.ts` (error codes), `test/it-pin.test.ts`, `test/helpers.ts` (truncate list), `.env.example`, `docker-compose.yml` (`IT_PIN_SECRET`).
- Agent: `internal/config/{config.go,secrethash.go,secrethash_test.go}` (pin.go renamed; `PinHash` → `SecretHash`, `ITPin` → `EnrollmentKeyHash`, old `it_pin` dropped on load), `internal/api/client.go` (+test), `internal/payload/payload.go`, `internal/contract/contract.go`, `internal/app/app.go`, `internal/bound/bound.go` (+test), `desktop/main.go`, `desktop/frontend/src/main.js`.
- Docs: `README.md`, `agent/README.md`, `CLAUDE.md`.

**What was done**
1. Server: 6-digit PIN = HMAC-SHA256(secret, local-hour + generation) with RFC 4226 truncation; hour read in `DISPLAY_TIMEZONE`; secret from `IT_PIN_SECRET` or a random one stored in `it_pin_state`; "Change now" bumps the generation. `POST /api/agent/settings-unlock` (401/400/403 `wrong_pin`/429 `too_many_attempts`), constant-time compare, 5 wrong per device per minute, append-only `settings_unlock_attempts`. Dashboard `/it-pin` page (PIN, "changes at", live countdown, Change now) plus `GET/POST /api/dashboard/it-pin`; device page lists recent attempts.
2. Agent: `api.Client.UnlockSettings` (no retries); `bound.UnlockITSettings` asks the server first and only falls back to the enrollment-key hash on no reply/timeout/5xx, or when the token is rejected/missing; shared 5-tries/60 s lockout; offline unlock written to the local log (uploaded with Send logs); IT setup and `CheckConnection(serverURL, key)` no longer take a PIN; hash saved after a successful `Signup`.
3. Desktop: PIN fields removed from IT setup; Settings prompt "Enter the IT PIN shown on the PC_READER dashboard." switching to "Can't reach the server. Enter the enrollment key to change the server address."; 401 banner / re-register asks for the enrollment key.
4. Docs updated as listed.

**What to check / decisions**
- A registered computer always opens home now (no forced setup for a missing PIN). A PC without an enrollment-key hash (CLI/M2/M3) gets it from *Register this computer again*; I did not add a separate "enter the key on an already-registered PC" path because the key cannot be verified without registering (a typo would silently break the fallback). Offline unlock on such a PC says so plainly and is not counted as a wrong try.
- A wrong-PIN 429 from the server is shown but not counted locally; "unreachable" does not count either. The prompt stays on the key until Settings is left (Cancel/Done call `LockITSettings`, which also abandons a started re-registration).
- Offline key unlocks reach the server only as log lines (category `system`), not as `settings_unlock_attempts` rows; the device page says so.
- The server's rate-limited attempts are not recorded (so they don't extend the window).
- Accepted risk (documented): no dashboard login, so the PIN is visible to anyone who can open the dashboard.

**Could not verify**
- Real desktop builds (`wails build` on Windows/macOS) and a click-through on a real PC with the server stopped; only unit tests, `vite build` with stubbed bindings and `GOOS=windows go vet` were possible here. CI should cover the builds.
- Local Postgres had password auth set for the test run; no `.env` was touched.
