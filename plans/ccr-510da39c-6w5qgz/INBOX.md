# INBOX — agent coordination

**Repository:** `Sealis04/PC_READER` — if your working directory is another repository, switch to a checkout of this one (`git remote -v`).
**Feature branch:** `ccr-510da39c-6w5qgz`
**Active builders:** builder-1 only
**Reviewer:** not used for M2. **Do not fire the reviewer routine.** When done, open your PR and stop; the planner checks CI and reports to the user.
**Milestone:** M2 — desktop app demo. Plan: [`plans/m2-desktop-demo/plan.md`](../m2-desktop-demo/plan.md). M1 history: [`plans/m1-thin-slice/inbox-log.md`](../m1-thin-slice/inbox-log.md).

## Branch to work on (overrides the routine prompts)

Your session is assigned its own branch (e.g. `claude/<name>`) and must not push elsewhere. **Use that assigned branch as your working branch** instead of `<branch>/builder-1` (which Git cannot create next to `ccr-510da39c-6w5qgz` anyway):

1. `git fetch origin ccr-510da39c-6w5qgz && git checkout -B <your-assigned-branch> origin/ccr-510da39c-6w5qgz` (your assigned branch starts from `main`; reset it onto the feature branch before working)
2. Commit and push only to your assigned branch: `git push -u origin <your-assigned-branch>` (use `--force-with-lease` once after the reset if the push is rejected)
3. Open the PR from your assigned branch into `ccr-510da39c-6w5qgz`.

## Repo conventions

See the repo `CLAUDE.md`. In short: bun + Drizzle (no Prisma, no `db:push`/`db:genAll`; use `cd server && bun run db:generate` after schema changes, `bun run db:migrate` to apply); Go tests with `-count=1`; `bun run lint` and `bun run test` from the root run everything (server tests need Postgres, `DATABASE_URL` defaults to `postgres://postgres@127.0.0.1:5432/pcreader_test`). There is no `scripts/ccr-session-init.sh`, MariaDB or SQL Server in this repo.

---

## builder-1 — FIX REQUEST (2026-10-19, round 2)

PR #1 (`claude/cool-volta-4q6iev` → `ccr-510da39c-6w5qgz`) is complete except the desktop builds. Both `desktop (windows-latest)` and `desktop (macos-latest)` fail in `wails build` at **Generating bindings**:

```
package github.com/sealis04/pc_reader/agent/desktop: build constraints exclude all Go files in .../agent/desktop
```

Wails' bindings generator compiles `agent/desktop` without the `desktop` tag, so the `//go:build desktop` constraint hides `main.go`. The frontend imports the generated `wailsjs/go/bound/App`, so bindings can't be skipped.

**Fix (pick one, keep the reason in a code comment):**
- Preferred: make `agent/desktop` its own Go module (`module github.com/sealis04/pc_reader/agent/desktop`, `replace github.com/sealis04/pc_reader/agent => ../`), drop the build tag and `build:tags`. Go's `internal/` rule is path-based, so it can still import `agent/internal/...`. Keep `bound` unit-tested: move it into the agent module (e.g. `agent/internal/bound`, package name still `bound` so `wailsjs/go/bound/App` doesn't change) or run its tests from the new module in CI.
- Or: drop the tag and exclude `./desktop` from Linux `go vet` / `go test` in CI and the root scripts.

**Done when:** both CI desktop jobs build and the `pcreader-desktop` artifact is uploaded; the `test`, `live-scan`, `build` jobs and the server workflow stay green; `bun run lint` and `bun run test` pass.

**Branching:** you cannot push to `claude/cool-volta-4q6iev`. Reset your assigned branch onto `origin/claude/cool-volta-4q6iev` (not the feature branch), add the fix, push, and open a new PR into `ccr-510da39c-6w5qgz` that says it supersedes #1. Check the CI result on your PR before you stop. Do not fire the reviewer.

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
