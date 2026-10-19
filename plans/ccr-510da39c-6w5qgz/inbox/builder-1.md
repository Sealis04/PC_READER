# builder-1 tasks — Milestone 2 (desktop app demo)

**Current task: the FIX REQUEST (round 5) at the top of `../INBOX.md`** (Settings = server address only, behind the one-time PIN). Base your work on `origin/claude/cool-volta-7qyt93` (round 4).

**Repository:** `Sealis04/PC_READER` (https://github.com/Sealis04/PC_READER). If your working directory is a different repository, switch to a checkout of this one first (`git remote -v` must show Sealis04/PC_READER).
**Feature branch:** `ccr-510da39c-6w5qgz`

The full assignment is in [`../INBOX.md`](../INBOX.md) (section `## builder-1`, plus "Branch to work on", "Repo conventions" and the reviewer note), and the plan is in [`../../m2-desktop-demo/plan.md`](../../m2-desktop-demo/plan.md). Read both; this file only points to them.

Summary:
1. Contract + server: `PUT /api/agent/user` with tests.
2. Agent: shared service layer for CLI and desktop app; `api.Client.UpdateUser`; local user details, `last_report_at`, last payload.
3. Wails v2 desktop app: IT setup → signup → My computer (summary + full details, Report now) → Update my details. Wails code behind a build tag.
4. CI desktop builds (Windows, macOS) uploading `pcreader-desktop`; docs.

Work on your session's assigned branch (reset onto `origin/ccr-510da39c-6w5qgz`), open the PR into `ccr-510da39c-6w5qgz`, and do **not** fire the reviewer.

**Status:** DONE — all four sections implemented on `claude/cool-volta-4q6iev`; summary under `### From builder-1` in `../INBOX.md`. PR into `ccr-510da39c-6w5qgz`; reviewer not fired (per INBOX.md).

---

## Round 4 — PIN-protected IT settings

**Status:** DONE

**Files changed:** `agent/internal/config/{config.go,pin.go,pin_test.go}`, `agent/internal/app/app.go`, `agent/internal/bound/{bound.go,bound_test.go}`, `agent/desktop/frontend/src/{main.js,style.css}`, `agent/README.md`.
**What was done:** IT PIN (4–8 digits, twice) stored only as salted PBKDF2-SHA256 (600k iterations, 16-byte salt, stdlib `crypto/pbkdf2`) under `it_pin` in `config.json`. IT setup shows whenever no PIN is stored; on a registered computer it asks only for server URL + PIN. "IT settings" link on My computer → PIN prompt (5 wrong tries lock 60 s, in memory) → change server URL (checked first), re-register (key + signup, PIN kept), change PIN. Re-register after a rejected token also goes through the PIN.
**What to check:** UI could not be run here (Wails GUI); only bound methods are unit-tested. Desktop CI jobs must be green. Branch was reset onto `origin/claude/cool-volta-atpdut` (round 3, ad90735) as instructed in the fire payload.
**Conflicts resolved:** (none)
