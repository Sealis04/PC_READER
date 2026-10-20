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

## builder-1 — FIX REQUEST (2026-10-20) — macOS app crashes on launch

Base: `main` (f81eaf7, includes #13). **Open your PR into `main`.** Round 4 (confirm-details prompt) may be running in parallel on `bound.go` / `main.js` / server; keep this change to the macOS tray start, CI and docs so the two PRs don't conflict.

**Bug (user's real Mac, Apple Silicon):** `PC_READER.app` dies immediately: `NSInternalInconsistencyException: 'NSWindow should only be instantiated on the main thread!'`. Full diagnosis, trace and a proposed fix are in [`plans/m5-hourly-it-pin/macos-tray-crash.md`](../m5-hourly-it-pin/macos-tray-crash.md) (written on the user's side). Short version: `agent/desktop/main.go` starts the tray from Wails' `OnStartup`, which runs on a goroutine; on macOS `systray.RunWithExternalLoop`'s `start()` → `nativeStart` creates an `NSStatusItem` off the main thread.

**Fix:**
1. On macOS, run the tray start on the main (Cocoa) thread, e.g. `dispatch_async_f(dispatch_get_main_queue(), …)` via cgo as in the handoff (`mainthread_darwin.go` + `mainthread_other.go` no-op), and call it from `OnStartup`. Make sure **everything** in `tray.Start`/`onReady` that touches AppKit (SetTemplateIcon, AddMenuItem, SetTitle, Disable) runs on the main thread; later updates from `SetStatus` too if `fyne.io/systray` doesn't marshal them itself (check its darwin code). Prefer a `cgo.Handle`/queue over a single global function slot.
2. Check the other macOS-only paths for the same problem: showing/focusing the window from the tray click handler and from the single-instance callback, `WindowHide`/`OnBeforeClose`, and the details-prompt "open window" path. Use Wails' runtime calls (they dispatch to the main thread) rather than direct AppKit calls.
3. Windows behaviour unchanged (it runs its own tray thread).
4. **CI launch smoke test (new):** on `macos-latest`, after building the `.app`, start the binary in the background with a throwaway `PCREADER_HOME` and `PCREADER_NO_AUTOSTART=1`, wait ~15 s, assert the process is still alive, then kill it; print its output on failure. Do the same on `windows-latest` for the exe if practical. This would have caught the crash.
5. README: add the macOS first-launch steps that worked for the user (unzip twice, move to Applications, `xattr -cr /Applications/PC_READER.app`, Open Anyway) and how to run the binary from Terminal to see errors (`/Applications/PC_READER.app/Contents/MacOS/pcreader-desktop`).

**Done when:** `bun run lint` and `bun run test` pass and CI is green, including the new macOS launch test. Write a short summary under `### From builder-1`. Do not fire the reviewer.

---

## builder-1 — Agency branding + agency-neutral code (2026-10-20)

Plan: [`plans/branding/plan.md`](../branding/plan.md). Base: `origin/claude/fervent-mendel-9y30q4` (= `main` + PR #15). **Open your PR into `main`, stacked on #15** (say so). Implement sections 1–4 of the plan as separate commits, pushing after each.

The repo is going public: the owner wants each server to set its agency **name**, **logo** and **inventory prefix** on a dashboard Settings page (no PIN/login yet), shown on the dashboard and in the desktop app's window, and no agency-specific names left in code or builds. Existing installs must keep working (IA- numbers, start-at-login).

CI now runs only after merges into `main` (Actions minutes ran out); verify with `bun run lint` and `bun run test` locally and say what you could not verify. Do not fire the reviewer; write a summary under `### From builder-1 (branding)` and stop.

---

## M5 round 4 — DONE by the planner (2026-10-20), approval-code design

Builder runs were stopped twice by their permission check (a PIN exception arriving second-hand). At the owner's request the planner implemented it directly, as **IT's approval travelling with the request** instead of a PIN bypass: `prompt_details_update` reaches the PC with a one-time approval code (HMAC of the request id with the IT PIN secret); `PUT /user` accepts `confirm { request_id, approval }` once, within 24 h, same employee ID; the save closes the request; the agent no longer completes the prompt itself; stale prompts expire after 24 h. Logged as `confirm_details`. The v2 request below is kept for the record.

---

## builder-1 — FIX REQUEST (2026-10-20, M5 round 4, v2) — confirm-details prompt without the PIN (superseded, see above)

**Why this is OK (owner decision, 2026-10-20):** the repository owner (the user) explicitly decided this exception after weighing the trade-off with the planner. A previous run stopped because it read this as weakening security. It is a deliberate, narrow exception: the action is **started by IT staff** from the dashboard, the user can only confirm/correct their own contact details, cannot change who the PC belongs to, and every save is logged. Please implement it as specified; if you see a concrete flaw in these bounds, implement the safest version that still lets the user save without the PIN and explain the issue in your summary instead of stopping.

Base: `main` + PR #14 if merged (the macOS fix only touches `tray.go`, `mainthread_*.go`, CI and README). **Open your PR into `main`. Commit and push after each step below** so partial work is never lost.

**Rule:** when staff pressed "Ask user to confirm details" (`prompt_details_update`), the user may save **once** without the IT PIN, with these bounds, all enforced by the server in `PUT /api/agent/user`:
1. The device has a `prompt_details_update` request in `delivered` state that was created **less than 24 hours ago**.
2. The submitted `employee_id` equals the current open assignment's user's `employee_id` (no reassignment). Otherwise `403` `pin_required` with message "Changing the employee ID needs the IT PIN."
3. On success: update that user's other fields (name, email, department, position, phone), mark the request `done`, return 200. The exception is consumed; a second save without PIN → `403 pin_required`.
4. Log every PIN-less save in `settings_unlock_attempts` with method `confirm_details`, success true, device id (add the enum value via a migration). Device page shows it.
5. With a valid PIN everything works as today (and also completes an open prompt). No PIN and no valid open prompt → `403 pin_required`. Wrong PIN → `403 wrong_pin`, 429 as today.

**Desktop:** when Update my details was opened by the prompt: hide the PIN field, show the employee ID read-only with "Changing the employee ID needs IT.", message "IT asked you to confirm these details." If an IT PIN session is active, the employee ID is editable as usual. After the save the prompt is gone; opening Update my details normally still needs the PIN.

**Tests:** server — open prompt + same employee ID, no PIN → 200 and request done + log row; open prompt + different ID → 403; prompt older than 24 h → 403; no prompt → 403; second save → 403; valid PIN still works. Go bound tests for the prompt flow.

**Docs:** README / `agent/README.md` / `CLAUDE.md` IT PIN line: the one bounded exception.

**Done when:** `bun run lint` and `bun run test` pass and CI (desktop builds included) is green. Write a `#### Round 4` summary under `### From builder-1`. Do not fire the reviewer.

---

## builder-1 — FIX REQUEST (2026-10-20, M5 round 3) — re-registration dead end

Base: `main` (M2–M5 merged via #11) + the navbar fix on `claude/fervent-mendel-9y30q4` (PR #12). **Open your PR into `main`** (the feature branch is finished).

**Bug (user's real Windows PC):** the user wiped the server database (`docker compose down -v`). The PC's token was then rejected (401) and the app showed Settings with "The server no longer recognises this computer. Enter the enrollment key to register it again." plus the red error "This computer has no saved enrollment key, so Settings cannot be opened while the server is unreachable…". It was a dead end: the PC was registered before M5 (no `enrollment_key_hash`), and the server **was** reachable.

**Fix:**
1. **Token rejected (401) but server reachable:** do not use the local hash. Take the typed enrollment key in memory and go straight to re-registration (signup form prefilled with the saved user details + IT PIN field). The server checks the key and the PIN during `/register` (403 wrong key → "That enrollment key is not correct", 403 wrong_pin, 429 as today). After success save the new token and the `enrollment_key_hash`. Wrong keys count toward the shared 5-tries lockout.
2. **Server truly unreachable** (no reply / timeout / 5xx): keep the current local-hash fallback for Settings only.
3. **Messages:** the "no saved enrollment key … server is unreachable" text may only appear when the server is actually unreachable. On a 401 never mention "unreachable".
4. Re-registering the same PC after a DB wipe creates a fresh device row; that is expected. If the server still has the device (e.g. token revoked), registering again with the same `device_uuid` must update that device as `/register` already does.
5. Tests: bound tests for 401 + no hash → re-registration works with a correct key (fake server), wrong key counts a try, unreachable + no hash → the existing message; server test only if `/register` behaviour changes.
6. Docs: `agent/README.md` paragraph about the fallback; add "After wiping the server database, every PC shows *Re-registration needed*: enter the enrollment key and the current IT PIN."

**Done when:** `bun run lint` and `bun run test` pass and CI (desktop builds included) is green on your PR into `main`. Write a `#### Round 3` summary under `### From builder-1`. Do not fire the reviewer.

---

## builder-1 — ADDENDUM to M5 round 2 (2026-10-20) — overrides round 2 where they differ

User rule: **without the IT PIN, the desktop app is view-only.** Users can look at My computer and Full details; every action needs the hourly IT PIN:
- **Report now** (window button and tray menu item) → PIN prompt first. Server: `POST /scans` with `scan_type: manual` from the desktop app requires a valid `it_pin` (field in the scans request, optional in the schema; required by the handler for `manual`). Scans that answer a dashboard `scan_now` request (`on_demand`) need no PIN (staff asked).
- **Signup** and **Update my details** → PIN (as in round 2).
- **Settings / change server address** → PIN, enrollment key when offline (unchanged).
- **Drop the round-2 exception:** confirming details after a dashboard "Ask user to confirm details" request also needs the PIN. The prompt just opens Update my details with "IT asked to confirm these details. IT needs to enter the PIN to save."
- **Unlock session:** after a correct PIN the app stays unlocked for 10 minutes (one PIN covers several actions), and locks again when the window is hidden/closed or after the 10 minutes. Show a small "Unlocked for IT · Lock" indicator. Lockout (5 tries / 60 s) shared across all prompts.
- Background work requested by the dashboard (scan_now, send_logs) never needs a PIN.
- Tests: server rejects a manual scan without/with a wrong PIN, accepts on_demand without; bound tests for the unlock session (expiry, lock on hide).
- Docs: README "What users can do without the IT PIN: view only".

---

## builder-1 — FIX REQUEST (2026-10-20, M5 round 2)

Base: PR #9 (`claude/cool-volta-bufmo9`, commit 9188559, CI green). New user decision: **submitting user details also needs the hourly IT PIN.**

**Which submits:**
1. **First-time signup** (desktop signup form, and `pcreader register` in the CLI).
2. **Update my details** (desktop form, `PUT /api/agent/user`).
3. **Exception:** when staff pressed "Ask user to confirm details" (`prompt_details_update`), the user confirms/saves **without** a PIN. Server rule: `PUT /user` without a PIN is accepted only while that device has a `prompt_details_update` request in `delivered` state; the save then completes that request.

**Enforced on the server, not only in the UI:**
- Contracts: add `it_pin` (6 digits) to `register.request` (required) and `user.request` (required unless the prompt exception applies; make it optional in the schema and enforce in the handler). Update fixtures and contract tests; note the change here as the repo rules require.
- `POST /register`: check the enrollment key first (existing 403), then the hourly PIN via `lib/it-pin.ts` → `403 wrong_pin`. There is no device yet, so rate-limit wrong PINs per client IP (same 5 / minute → `429`), and record attempts with `device_id` null and method `register`.
- `PUT /user`: wrong or missing PIN → `403 wrong_pin` (unless the prompt exception), rate limit per device, attempts recorded with method `update_details`.
- Device page attempts list shows the method.

**Agent / desktop:**
- Signup form: "IT PIN" field (shown on the PC_READER dashboard) next to Submit; inline error on a wrong PIN; the enrollment key is still asked in IT setup as today.
- Update my details: "IT PIN" field before Save; hidden when the form was opened by the dashboard prompt.
- Shared 5-tries / 60 s lockout with Settings.
- **Offline:** no enrollment-key fallback for these forms. If the server can't be reached: "Can't reach the server. Try again when this computer is online." (Settings keeps its enrollment-key fallback.)
- CLI: `pcreader register --pin 123456` (required); `pcreader` has no update-details command, so nothing else changes there. Update the end-to-end tests (`PCREADER_E2E_*`) to get the current PIN from the test server or the DB helper.

**Tests:** server tests for register/user with right, wrong, missing PIN, the prompt exception (with and without a delivered request), rate limits and attempt rows; Go tests for the bound methods and CLI flag.

**Docs:** README + `agent/README.md`: IT needs the dashboard's current PIN at signup and when a user changes their details.

**Done when:** `bun run lint` and `bun run test` pass and CI (desktop builds included) is green.

**Branching:** reset your assigned branch onto `origin/claude/fervent-mendel-9y30q4` (= #9 plus this request), implement, push, and **open a PR into `ccr-510da39c-6w5qgz`** that supersedes #9 (still stacked on #8; say so). Add a `#### Round 2` part to your M5 summary below. Do not fire the reviewer.

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

#### Round 2 (2026-10-20) — view-only without the IT PIN

**Status:** DONE — new PR into `ccr-510da39c-6w5qgz` from `claude/cool-volta-cw23vh`, **supersedes #9**, still stacked on #8 (merge #8 first; close #9). Local: `bun run lint` and `bun run test` pass (contracts 37, server 111, Go all packages); `agent/cmd/pcreader` end-to-end (`TestEndToEnd`) passes against a real server + Postgres; `GOOS=windows go vet` of `agent/desktop` and `node --check` of the frontend pass. The addendum won over the first round-2 text: **no prompt exception**; confirming details after a dashboard prompt needs the PIN too.

**Files changed**
- Contracts: `register.request` (+`it_pin`, required), `user.request` (+`it_pin`, required), `scans.request` (+`it_pin`, optional; the handler requires it for `manual`); `index.ts` (`UserRequest`, `ScansRequest.it_pin?`), fixtures `register/*`, `user/*`, `fixtures/README.md`, `contracts/test/fixtures.test.ts`.
- Server: `src/db/schema.ts` + migration `drizzle/0004_panoramic_luckman.sql` (+snapshot/journal): `settings_unlock_attempts.device_id` nullable, `client_ip`, `unlock_method` + `register`/`update_details`/`manual_scan`; `src/lib/it-pin.ts` (`verifyPin(db, subject, pin, method)`, `clientIp`, `pinErrorResponse`, `derivePin` exported); `src/lib/agent/{register,user,scans,settings-unlock}.ts`; device page and `/it-pin` wording; tests `test/{helpers,it-pin,user-api}.test.ts`.
- Agent: `internal/payload`, `internal/api/client.go` (UpdateUser takes the PIN; `too_many_attempts` 429 is not retried), `internal/app/app.go` (PIN in `RegisterInput`, `UploadOptions`, `Report`, `UpdateUser`), `internal/background/runner.go`, `internal/bound/bound.go`, `cmd/pcreader/main.go`, desktop `main.go` and frontend (`main.js`, `style.css`); tests in `internal/{api,app,bound}`, `cmd/pcreader` (incl. `e2e_test.go`).
- Docs: `README.md`, `agent/README.md`, `CLAUDE.md`.

**What was done**
- Server enforces the PIN: `/register` (after the enrollment key; limited per client IP, attempt rows with `device_id` null, method `register`), `PUT /user` (`update_details`), `POST /scans` with `scan_type: manual` (`manual_scan`; `on_demand`/`scheduled`/`startup` need none). 403 `wrong_pin`, 429 `too_many_attempts` (5 wrong/min per device, or per IP at signup, counted across methods). Device page shows the method.
- Agent/desktop: `bound` has a 10-minute IT session (`Session()`, PIN kept in memory only, cleared on lock/expiry/wrong PIN); Report now, signup, Update my details and Settings need the PIN; shared 5-tries/60 s lockout; offline actions say "Can't reach the server. Try again when this computer is online." (only Settings keeps the key fallback). Window: PIN dialog, "Unlocked for IT (m:ss) · Lock" indicator, PIN field on signup and Update my details (hidden while the session holds a PIN), prompt text "IT asked you to confirm these details. IT needs to enter the PIN to save." Tray "Report now" opens the window and asks for the PIN when locked. Hiding the window locks (`OnBeforeClose` replaces `HideWindowOnClose`). CLI: `register --pin` (required), `scan --upload --pin` (required for manual).

**What to check**
- `OnBeforeClose` + `WindowHide` instead of `HideWindowOnClose`: I could not run the desktop app, so please confirm on Windows that the X button still only hides the window and that it comes back locked. (On macOS this also stops Cmd+Q from quitting, which matches "no quit item".)
- A missing `it_pin` on register/user is `400 invalid_payload` (required by the schema), not 403; a wrong/old PIN is 403.
- The first scan uploaded at signup is `manual`, so it re-uses the signup PIN (one extra `manual_scan` attempt row).
- If IT presses Change now mid-session, the next action fails with "That PIN is not correct", counts as a wrong try and asks again.
- Key-unlocked Settings (offline) opens Settings only; actions still ask for the PIN.
- `settings_unlock_attempts` / `unlock_method` names kept from #9 to avoid a table rename; they now cover more than Settings.

**Could not verify**
- Real `wails build` and a click-through on a PC (CI builds the desktop apps); the frontend has no tests, only a syntax check.

#### Round 3 (2026-10-20) — re-registration dead end

**Files changed:** `agent/internal/bound/bound.go`, `bound_test.go`, `agent/desktop/frontend/src/main.js`, `agent/README.md`.
**What was done:** when the server answers 401 (token rejected) the key prompt no longer checks the local hash: the typed key is held in memory and the signup form opens (prefilled, with the IT PIN field); the server checks key + PIN at `/register`. A wrong key there counts toward the shared 5-tries lockout and returns to the key field (`Result.NeedsKey`). The hash fallback and its "no saved enrollment key … unreachable" message now only appear when the server is unreachable. README paragraph + wipe note added.
**What to check:** typing a key at the rejected prompt does not unlock Settings (nothing to verify it against until `/register`). Not verified: the Wails frontend on a real PC (`main.js` flow `itLogin` → `signup`/`setup`); Go tests, `bun run lint` pass. `bun run test` server part not run here (needs Postgres); no server change.

### From builder-1 (macOS launch crash fix)
- `agent/desktop/mainthread_darwin.go` / `mainthread_other.go`: `runOnMainThread` (GCD `dispatch_async_f` + `cgo.Handle`; no-op passthrough elsewhere). `tray.Start` now dispatches `systray`'s `start` through it; `t.end` access is mutex-guarded. Windows path unchanged.
- Checked `fyne.io/systray` v1.12.2 darwin code: later updates (`SetTitle`, menu items, icons) go through `performSelectorOnMainThread`, so `onReady`/`SetStatus` need no extra dispatch. Window show/hide use Wails runtime calls (main-thread safe), no direct AppKit.
- CI: "Launch smoke test" step in the `desktop` job (macOS + Windows): app must be alive after 15 s. README: macOS first-launch steps + running from Terminal + the new main-thread note.
- Not verified locally (Linux): Windows vet and desktop tests pass; the darwin build/launch is covered only by the new CI job.
