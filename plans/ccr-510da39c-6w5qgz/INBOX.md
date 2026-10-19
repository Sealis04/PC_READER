# INBOX — agent coordination

**Feature branch:** `ccr-510da39c-6w5qgz`
**Active builders:** builder-1 only
**Reviewer:** not used for M2. **Do not fire the reviewer routine.** When done, open your PR and stop; the planner checks CI and reports to the user.
**Milestone:** M2 — desktop app demo. Plan: [`plans/m2-desktop-demo/plan.md`](../m2-desktop-demo/plan.md). M1 history: [`plans/m1-thin-slice/inbox-log.md`](../m1-thin-slice/inbox-log.md).

## Branch naming (overrides the routine prompts)

Git cannot hold both `ccr-510da39c-6w5qgz` and `ccr-510da39c-6w5qgz/builder-1` (`cannot lock ref`). Wherever your prompt says `<branch>/builder-1`, use **`ccr-510da39c-6w5qgz-builder-1`** instead: create it with `git checkout -b ccr-510da39c-6w5qgz-builder-1`, push it with `git push -u origin ccr-510da39c-6w5qgz-builder-1`, and open the PR from it into `ccr-510da39c-6w5qgz`.

## Repo conventions

See the repo `CLAUDE.md`. In short: bun + Drizzle (no Prisma, no `db:push`/`db:genAll`; use `cd server && bun run db:generate` after schema changes, `bun run db:migrate` to apply); Go tests with `-count=1`; `bun run lint` and `bun run test` from the root run everything (server tests need Postgres, `DATABASE_URL` defaults to `postgres://postgres@127.0.0.1:5432/pcreader_test`). There is no `scripts/ccr-session-init.sh`, MariaDB or SQL Server in this repo.

---

## builder-1

Implement sections 1–4 of `plans/m2-desktop-demo/plan.md`, in order, as separate commits:

1. **Contract + server:** `contracts/agent-api/user.request.schema.json` (+ fixture, contract test); `PUT /api/agent/user` (handler in `server/src/lib/agent/user.ts`, route in `server/src/app/api/agent/user/route.ts`); same-employee update and different-employee reassignment (`assigned_by = "self-service"`); integration tests incl. 401 and 400.
2. **Agent service layer:** move register/scan/upload/status logic from `agent/cmd/pcreader/main.go` into a shared package used by the CLI and desktop app (CLI behaviour and tests unchanged); add `api.Client.UpdateUser`; keep user details, `last_report_at` and the last payload in `config.json` (never logged).
3. **Desktop app (Wails v2)** in the agent module (e.g. `agent/desktop/`): IT setup → signup (required: full name, employee ID, department; optional: email, position, phone; data-use notice checkbox) → "My computer" (summary card + expandable full details, Report now, re-registration message on 401) → Update my details. Wails-dependent files behind a build tag so Linux `go vet`/`go test ./...` still pass; bound methods in an untagged, unit-tested package. Same config folder and token store as the CLI.
4. **CI + docs:** build jobs on `windows-latest` and `macos-latest` uploading `pcreader-desktop`; README and `CLAUDE.md` updates.

You cannot run the GUI in your container. Verify with unit tests of the bound methods, the server integration tests, the Go end-to-end test, and the CI desktop build jobs (check their results with the GitHub tools after pushing). Note anything you could not verify.

**Done when:** `bun run lint` and `bun run test` pass, and the CI desktop builds succeed on both runners.

---

## reviewer

Not used for M2. builder-1: still write your summary here under `### From builder-1` (files changed, what was done, what to check), then stop.
