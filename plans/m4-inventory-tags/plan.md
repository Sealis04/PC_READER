# Milestone 4 — Inventory numbers and statuses

Source spec: [`docs/technical-spec.md`](../../docs/technical-spec.md) (Data model, rules on tagging and statuses). M3 plan and result: [`plans/m3-background-reporter/plan.md`](../m3-background-reporter/plan.md). Visual plan: https://claude.ai/artifact/UnymAgxyNK6brKnbYmnnyz

## Goal

Staff give each device an inventory number and a status from the dashboard, print a label for the sticker, set its location, and see one history of status, number, location and assignment changes. The device list can be filtered and searched by these fields.

**Out of scope for M4:** component tags and component statuses, batch tagging or batch status changes, showing the number in the desktop app, staff login / roles / attribution, PM reports, exports.

## Decisions

| Topic | Decision |
| --- | --- |
| Focus | Inventory numbers and statuses (decided 2026-10-19) |
| Scope | Devices only. Components are not tagged in M4 |
| Number format | Generated: `IA-YYYY-NNNNN` (e.g. `IA-2026-00123`): prefix `IA`, the current year in `DISPLAY_TIMEZONE`, a 5-digit counter that restarts each year. Staff may instead type an existing sticker number (free text, trimmed, max 50 chars, unique, case-insensitive) |
| Counter | Next number = highest issued for that year + 1, taking typed numbers that match the pattern into account. Issued inside a transaction / row lock so two staff can't get the same number. A number is never reused after it has been issued, even if later changed |
| Statuses | In use · Spare · Under repair · For disposal · Disposed · Lost (existing `device_status` enum) |
| Changes | One device at a time, with an optional reason. No batch |
| Attribution | None until login exists: `changed_by` is null in history |
| History | Append-only `status_history` (spec) plus append-only history for inventory number and location changes. Assignment history comes from the existing `assignments` table |
| Label | Print-friendly page per device: inventory number (large), QR code encoding the number, hostname, serial number, "PC_READER". Uses the browser's print dialog |
| List | Filters: status, department, OS, online state (keep the M3 filter). Search: inventory number, hostname, assigned user's name or employee ID, serial number |
| Builders | Builder 1 only; no reviewer routine. The planner checks the PR and CI; the user reviews and merges |

## Work breakdown (Builder 1, in this order, separate commits)

### 1. Schema
- `status_history` per spec, device-only for now: `device_id`, `old_status`, `new_status`, `changed_by` (nullable), `changed_at`, `reason`.
- A device change history for the other fields, e.g. `device_field_history` (`device_id`, `field` = inventory_number / location, `old_value`, `new_value`, `changed_by` nullable, `changed_at`, `reason`), or two small tables. Append-only.
- `inventory_counters` (`year`, `last_value`) or an equivalent that makes "next number" safe under concurrency.
- Case-insensitive unique index on `devices.inventory_number` (existing column).
- `bun run db:generate`; the migration must apply to an M3 database (existing devices keep status `in_use`, no history rows needed for the initial state).

### 2. Server logic + tests
- In `server/src/lib/inventory.ts` (or similar, testable without HTTP):
  - `assignNextNumber(deviceId)` → issues `IA-<year>-<5 digits>`; refuses if the device already has a number (staff change it explicitly instead).
  - `setInventoryNumber(deviceId, value, reason?)` → validate, unique (409-style error with a clear message naming the device that has it), history row.
  - `clearInventoryNumber` is allowed (history row) for mistakes.
  - `changeStatus(deviceId, newStatus, reason?)` → no-op if unchanged; history row.
  - `setLocation(deviceId, value, reason?)` → history row.
- Exposed to the dashboard as server actions or `api/dashboard/devices/{id}/...` routes (no login, like M3's request queueing).
- Tests: counter per year and rollover, two concurrent "assign next" calls get different numbers, typed number that matches the pattern pushes the counter, uniqueness (case-insensitive), history rows for each change, no row on a no-op status change.

### 3. Device page
- Header shows inventory number (or "No number yet") and a status pill.
- Edit panel: "Assign next number", "Enter existing number", status dropdown, location field, optional reason; inline errors.
- "Print label" link → `/devices/{id}/label`: print-friendly page with a QR code (generate server-side, e.g. the `qrcode` npm package as SVG/data URL; no external services).
- History timeline (newest first) merging status, number, location and assignment changes, formatted in `DISPLAY_TIMEZONE`.

### 4. Device list
- Columns: inventory number, status pill (next to the existing online pill), location.
- Filters and search as in Decisions; keep the query fast for 1,000 devices (indexes where needed, no N+1).

### 5. Docs
- README / `CLAUDE.md`: inventory number format, how the counter works, label page.

## Done when
- `bun run lint` and `bun run test` pass, including the new tests.
- In the dashboard: assign a next number, type an existing number, see a duplicate rejected, change status and location with a reason, see all of it in the history, print a label, and find the device by number, user and serial with filters.

## Risks
- Year rollover and time zone: the year comes from `DISPLAY_TIMEZONE` (Asia/Manila), not UTC.
- Typed numbers that look like generated ones → counter takes the maximum, so generated numbers never collide.
- No attribution until login; history rows will be backfilled as "unknown".
