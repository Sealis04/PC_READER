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

## builder-1 — FIX REQUEST (2026-10-19, round 5)

Base: round 4 (`claude/cool-volta-7qyt93`, commit fec66aa, CI green). The user clarified how settings and the PIN should work.

**What the user wants:**
- The **IT PIN is a one-time setup**: set once during IT setup and **not changeable from the app**.
- The PIN **locks a "Settings" screen** whose only job is changing the **server address**.
- **User details** ("Update my details") are a separate user feature. Keep them as they are.

**Changes:**
1. Rename "IT settings" to **"Settings"** (link text on My computer and the screen title). Keep the PIN prompt and the 5-tries / 60-second lockout.
2. After the PIN, Settings shows **only the server address** with "Check connection" and Save. **Remove** the "Register this computer again" and "Change the IT PIN" cards, and remove the change-PIN bound method and its tests (or leave it unexported and unused, but not reachable from the UI).
3. Keep the error path where the server rejects this computer's token (401): the banner on My computer still offers re-registration behind the PIN. It's not a setting.
4. "Update my details" stays unchanged and reachable from My computer for the user (no PIN).
5. Update `agent/README.md`. If IT forgets the PIN, the documented reset is deleting `config.json` in the app data folder and running IT setup again.

**Done when:** CI is green on your PR (desktop jobs included).

**Branching:** reset your assigned branch onto `origin/claude/cool-volta-7qyt93`, implement, push, and **open a PR into `ccr-510da39c-6w5qgz`** that supersedes #3 and round 4. Opening the PR is required this time. Do not fire the reviewer.

---

## builder-1 — round 4 (DONE on claude/cool-volta-7qyt93)

Base: the PR from round 3 (supersedes #2). Requested by the user after testing on a real PC.

**IT settings with a PIN.**
1. **IT setup asks for a PIN.** Add an "IT PIN" (4–8 digits, entered twice) to the IT setup screen. Store only a salted, slow hash in `config.json` (e.g. `golang.org/x/crypto/scrypt` or PBKDF2-SHA256 with ≥100k iterations, random 16-byte salt). Never store or log the PIN itself.
2. **When IT setup shows:** whenever no IT PIN is stored, not only when the computer is unregistered. On an already-registered computer (e.g. registered with the CLI), IT setup prefills the saved server URL, asks only for the server URL and the PIN (no enrollment key or signup, because the device stays registered), checks the connection, saves, and goes to "My computer".
3. **"IT settings" link** (small, at the bottom of "My computer"): asks for the PIN. After 5 wrong attempts, lock for 60 seconds (state in memory is enough). When unlocked: edit the server URL with "Check connection" and save; "Re-register this computer" (back to IT setup with enrollment key + signup, keeping the PIN); "Change PIN".
4. Users see neither the enrollment key nor the address editor without the PIN.
5. Tests for the bound methods: PIN set/verify, wrong-PIN lockout, setup-shown-when-no-PIN on a registered config, server URL change, and that the PIN never appears in `config.json` in plain text.

**Done when:** CI is green on your PR (desktop jobs included).

**Branching:** reset your assigned branch onto the round-3 PR's branch, implement, push, and open a new PR into `ccr-510da39c-6w5qgz` that supersedes it. Do not fire the reviewer.

---

## builder-1 — FIX REQUEST (2026-10-19, round 3)

Base: PR #2 (`claude/cool-volta-w8ogw1`, CI green). Round 2 (desktop builds) is done.

**1. Console windows pop up on Windows (bug, from the user's real-PC test).** The desktop app starts `powershell.exe` and `netsh` through `scan.Exec` (`agent/internal/scan/scan.go`) without hiding them, so Windows opens a console window for every command. Fix:
- Add `agent/internal/scan/exec_windows.go` setting `cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000 /* CREATE_NO_WINDOW */}`, and `exec_other.go` (`//go:build !windows`) as a no-op, called from `Exec`.
- Apply it to every command the agent starts (search for other `exec.Command` uses).
- Add a Windows-only unit test that `Exec` sets those flags (`GOOS=windows go vet` must pass; the live-scan job on `windows-latest` runs the test).

**2. Clearer "cannot reach the server" message in IT setup.** The user didn't realise the server is their own Docker Compose stack. In `agent/internal/bound/bound.go` (and its test), for the IT-setup connection check, say: "Cannot reach the server at <url>. Make sure the PC_READER server is running (docker compose up -d on the server computer) and that this address is correct, e.g. http://192.168.1.10:3000." Keep the existing wording for errors after signup.

**Done when:** CI is green on your PR (desktop jobs included).

**Branching:** reset your assigned branch onto `origin/claude/cool-volta-w8ogw1`, fix, push, and open a new PR into `ccr-510da39c-6w5qgz` that supersedes #2. Do not fire the reviewer.

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

### From builder-1

**Files changed:** `contracts/agent-api/user.request.schema.json`, `contracts/fixtures/user/windows-desktop.json`, `contracts/index.ts`, `contracts/test/fixtures.test.ts`; `server/src/lib/agent/user.ts`, `server/src/app/api/agent/user/route.ts`, `server/test/user-api.test.ts`; `agent/internal/app/{app.go,app_test.go}`, `agent/internal/api/{client.go,client_test.go}`, `agent/internal/config/config.go`, `agent/internal/payload/payload.go`, `agent/cmd/pcreader/main.go`; `agent/desktop/{main.go,wails.json,bound/*,frontend/*}`, `agent/go.mod`, `agent/go.sum`; `.github/workflows/agent.yml`, `.gitignore`, `agent/README.md`, `CLAUDE.md`.
**What was done:** (1) `PUT /api/agent/user` (body = user details, 200 returns stored user; same employee_id updates in place, different one reassigns with `assigned_by = "self-service"`). (2) `internal/app` service layer used by the CLI (behaviour/tests unchanged) and the desktop app; `api.Client.UpdateUser`/`Ping`; config keeps user, `last_report_at`, last payload. (3) Wails v2 app: `desktop/bound` (untagged, tested) + tagged shell + Vite/plain-JS frontend. (4) CI jobs `desktop` (windows-latest, macos-latest) merged into artifact `pcreader-desktop`; docs.
**What to check:** GUI never run (no display here): verified with bound-method tests, server integration tests (local Postgres), CLI end-to-end against a local server, `GOOS=windows CGO_ENABLED=0 go vet -tags desktop`, and a Vite build against stub bindings. Unverified until CI: `wails build` on both runners (Wails v2.10.2 pinned; bindings generated by wails, `frontend/dist/.gitkeep` is force-added so `go:embed` works before the frontend builds), and the `build:tags` key in `wails.json` (the CLI also passes `-tags desktop`). "Check connection" only pings `GET /devices`; a wrong key shows at signup. CLI-registered machines have no local user details until "Update my details". `bun run lint`/`test` pass locally.
