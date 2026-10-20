# M4 INBOX log

Archived from `plans/ccr-510da39c-6w5qgz/INBOX.md` when M5 started.

---

## builder-1 — M4 (2026-10-19)

Implement sections 1–5 of `plans/m4-inventory-tags/plan.md`, in order, as separate commits:

1. **Schema:** `status_history`, append-only history for inventory number and location, a per-year counter, case-insensitive unique inventory number; migration applies to an M3 database.
2. **Server logic + tests:** assign next `IA-YYYY-NNNNN` (year in `DISPLAY_TIMEZONE`, safe under concurrency, never reused), set/clear an existing number (unique, clear error), change status, set location, each with optional reason and a history row (`changed_by` null — no login yet).
3. **Device page:** number + status in the header, edit panel, history timeline (status, number, location, assignments), `/devices/{id}/label` print page with a QR code generated locally.
4. **Device list:** number, status, location columns; filters (status, department, OS, online) and search (number, hostname, user name / employee ID, serial).
5. **Docs.**

Devices only: no component tags, no batch actions, nothing in the desktop app. No contract or agent changes are expected; if you need one, note it here.

**Done when:** `bun run lint` and `bun run test` pass, CI is green, and the PR into `ccr-510da39c-6w5qgz` is open with a summary below.

---

## reviewer

Not used for M4. builder-1: write your summary here under `### From builder-1` (files changed, what was done, what to check, what you could not verify), then stop.

### From builder-1

**Files changed:** `server/src/db/schema.ts`, `server/drizzle/0002_wise_mercury.sql` (+ meta), `server/src/lib/inventory.ts`, `server/src/lib/dashboard-inventory.ts`, `server/src/lib/queries.ts`, `server/src/lib/format.ts` (exports `TIME_ZONE`), `server/src/lib/http.ts` (`conflict` error code), `server/src/app/api/dashboard/devices/[id]/inventory/route.ts`, `server/src/app/devices/page.tsx`, `server/src/app/devices/[id]/page.tsx`, `server/src/app/devices/[id]/label/page.tsx`, `server/src/app/devices/_components/{inventory-panel,print-button}.tsx`, `server/src/app/globals.css`, `server/test/inventory.test.ts`, `server/test/dashboard.test.ts`, `server/test/helpers.ts`, `server/package.json` + `bun.lock` (`qrcode` 1.5.4, `@types/qrcode`), `README.md`, `CLAUDE.md`.

**What was done:** (1) Migration 0002: `status_history`, `device_field_history` (number/location), `inventory_counters`; replaced the case-sensitive unique constraint on `devices.inventory_number` with a unique index on `lower(...)`; added `devices_status_idx`. Applies on top of M3 (existing devices stay `in_use`, no history rows). (2) `lib/inventory.ts`: assign next / set / clear number, change status, set location, each in a transaction with the device row locked, optional reason, history row, no-op = no row; `POST /api/dashboard/devices/{id}/inventory`. (3) Device page: number + status in header, edit panel, merged history timeline, `/devices/{id}/label` with a server-generated SVG QR. (4) List: number/status/location columns, filters (status, department, OS, connection) and search; `listDevices` now takes a filters object. (5) Docs.

**What to check:** `listDevices` signature changed (second argument is now `{ connection, status, ... }`); existing test updated. A typed number that matches `IA-YYYY-NNNNN` is upper-cased and raises the counter; `assign_next` fails with 409 past 99999. Department filter matches the assigned user's department (unassigned devices have none). Search is `ILIKE` substring with `%`/`_` escaped (no trigram index; fine for ~1,000 devices).

**Not verified:** printing on a real printer / physical QR scan (only checked that the label page renders an `<svg>`); no browser UI click-through — I exercised the API and server-rendered pages with curl against a production build. `bun run lint` and `bun test` (85 server tests, Postgres 16) pass locally.

