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
