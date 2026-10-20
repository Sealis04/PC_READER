# Agency branding and an agency-neutral codebase

Builds on `main` + PR #15. Runs before M6 (custom fields). Visual plan: https://claude.ai/artifact/UnymAgxyNK6brKnbYmnnyz

## Goal

The repository becomes public and usable by any agency. Each server sets its own **agency name**, **logo** and **inventory number prefix** on a dashboard Settings page. The dashboard and the desktop app's window show them. The code and builds carry no agency-specific names.

**Out of scope:** login or PIN protection for Settings (staff login comes later), branding on printed labels and the tray tooltip, per-agency installer names (the OS-level app name stays "PC_READER").

## Decisions (2026-10-20)

| Topic | Decision |
| --- | --- |
| Where the name and logo show | Dashboard (top bar, browser tab title) and the desktop app's window header. Not on labels, not in the tray tooltip |
| Settings page | Dashboard `/settings` (top-bar link "Settings"): agency name, logo upload/remove, inventory prefix. No PIN or login for now; documented as an accepted risk until staff login |
| Defaults | Name "PC_READER", no logo, prefix `INV`. On upgrade, if devices already have `IA-YYYY-NNNNN` numbers, the migration sets the prefix to `IA` so existing servers keep their format |
| Logo | PNG, JPEG or WebP only (no SVG: script risk), max 512 KB, stored in the database, served at a public URL with its content type and a cache-busting version |
| Prefix | 2–10 characters, A–Z and 0–9. Changing it affects new numbers only; existing numbers stay. The counter stays per year. Typed numbers in the current pattern still raise the counter |
| Desktop app | Fetches name and logo from the server (no device token needed), caches them in `config.json` for offline starts, refreshes on launch and when the connection opens. The window title stays "PC_READER" |
| Neutral code | `wails.json` company/copyright "PC_READER"; app IDs without the agency (e.g. `pc-reader.desktop`, LaunchAgent `io.github.sealis04.pcreader`); default prefix `INV`. Existing installs keep working: on launch the app removes the old LaunchAgent plist (`ph.gov.intramuros.pcreader`) before writing the new one; the Windows Run value name stays `PC_READER` |

## Work (Builder 1, separate commits)

1. **Server:** `app_settings` single-row table (agency_name, inventory_prefix, logo bytes, logo content type, logo updated_at) + migration with the IA upgrade rule. `lib/settings.ts` (get/update, validation). `lib/inventory.ts` uses the configured prefix (pattern, counter, typed numbers). Dashboard `/settings` page + `GET/POST /api/dashboard/settings`, `POST/DELETE /api/dashboard/settings/logo`. Public `GET /api/branding` (`{ name, logo_url }`) and `GET /api/branding/logo` (with content type, `cache-control`). Top bar and `<title>` use the name and logo. Tests: validation, logo type/size limits, prefix change affects only new numbers, upgrade rule, public endpoints.
2. **Contracts:** `branding.response` schema + fixture (the desktop app reads it).
3. **Agent/desktop:** `api.Client.Branding`, cache in `config.json`, `bound` method for the window, header shows the logo and name; neutral IDs; old LaunchAgent cleanup; tests.
4. **Neutral code and docs:** remove agency names from code, builds and docs (README, agent README, spec where it names the agency, CLAUDE.md). Keep "Asia/Manila" as the default `DISPLAY_TIMEZONE` but say it is configurable. Note in the README how an agency sets its name, logo and prefix.

## Done when
- `bun run lint` and `bun run test` pass locally (CI now runs only after merges into `main`; start the **agent** workflow by hand on the branch to build the desktop apps if minutes allow).
- Dashboard: changing the name, logo and prefix shows immediately; a new inventory number uses the new prefix; old numbers unchanged.
- Desktop app shows the agency name and logo, also when started offline after one successful fetch.
