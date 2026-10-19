# builder-1 tasks — Milestone 2 (desktop app demo)

**Repository:** `Sealis04/PC_READER` (https://github.com/Sealis04/PC_READER). If your working directory is a different repository, switch to a checkout of this one first (`git remote -v` must show Sealis04/PC_READER).
**Feature branch:** `ccr-510da39c-6w5qgz`

The full assignment is in [`../INBOX.md`](../INBOX.md) (section `## builder-1`, plus "Branch to work on", "Repo conventions" and the reviewer note), and the plan is in [`../../m2-desktop-demo/plan.md`](../../m2-desktop-demo/plan.md). Read both; this file only points to them.

Summary:
1. Contract + server: `PUT /api/agent/user` with tests.
2. Agent: shared service layer for CLI and desktop app; `api.Client.UpdateUser`; local user details, `last_report_at`, last payload.
3. Wails v2 desktop app: IT setup → signup → My computer (summary + full details, Report now) → Update my details. Wails code behind a build tag.
4. CI desktop builds (Windows, macOS) uploading `pcreader-desktop`; docs.

Work on your session's assigned branch (reset onto `origin/ccr-510da39c-6w5qgz`), open the PR into `ccr-510da39c-6w5qgz`, and do **not** fire the reviewer.
