# Milestone 6 — Custom fields with secret fields

Source spec: [`docs/technical-spec.md`](../../docs/technical-spec.md). Builds on M4 (inventory, history) and M5 (hourly IT PIN). Visual plan: https://claude.ai/artifact/UnymAgxyNK6brKnbYmnnyz

## Goal

IT defines extra fields once for all devices (e.g. "Registered email", "Warranty until", "Local admin password") and fills them in per device on the dashboard. Secret fields are encrypted on the server, hidden by default and revealed only with the current IT PIN; every reveal and change is logged.

**Out of scope for M6:** per-device ad-hoc fields, free-text notes, dropdown fields, showing custom fields in the desktop app, exports, staff login.

## Decisions

| Topic | Decision |
| --- | --- |
| Scope | Dashboard and server only. No contract or agent changes; custom fields and secrets are never sent to PCs |
| Field definitions | Same set for every device, managed on a dashboard "Fields" page: create, rename, reorder, archive (hidden, values kept). Never deleted |
| Field types | Text, Date, Secret |
| Secret storage | AES-256-GCM per value with a random nonce, key from `SECRETS_KEY` in `.env` (32 random bytes, base64). Without the key the server still starts, but secret fields are disabled with a clear message. README: back up the key together with the database; a lost key means lost secrets |
| Reveal | "Reveal" asks for the current IT PIN (checked with `lib/it-pin.ts`, same rate limit), shows the value for 30 s, then hides it again. Copy button |
| Edit secret | Setting or changing a secret also needs the current IT PIN |
| Logging | Append-only `secret_access_log` (device, field, action reveal/set/clear, success, client IP, time) — never the value. Device page shows it |
| History | Text/date changes go to the device history with old/new values (append-only). Secret changes appear only as "changed" without values |
| Search | Device list: search text fields, filter date fields (before/after). Secrets are never searchable or shown in the list |
| Accepted risk | No dashboard login yet: anyone who can open the dashboard can also read the IT PIN and reveal secrets. Every reveal is logged. Documented in the README |
| Builders | Builder 1 only; start after M5 round 4 is merged (both add migrations) |

## Work breakdown (Builder 1, in order, separate commits)

### 1. Schema
- `custom_fields` (id, name, type text/date/secret, position, archived_at, created_at, updated_at).
- `device_field_values` (device_id, field_id, text_value, date_value, secret_ciphertext, secret_nonce, updated_at; unique per device+field).
- `secret_access_log` (append-only, as above).
- Reuse `device_field_history` from M4 for text/date changes (`field` = `custom:<field id>`), or add a column for the field id — keep it append-only.
- `bun run db:generate`; migration applies to the current `main` database.

### 2. Server logic + tests
- `lib/custom-fields.ts`: define/rename/reorder/archive fields; set text/date values with history; `setSecret(deviceId, fieldId, value, pin)`, `revealSecret(deviceId, fieldId, pin)`, both verify the PIN, write the log, never log the value.
- `lib/secrets-crypto.ts`: encrypt/decrypt with `SECRETS_KEY`; refuse when the key is missing or the wrong length.
- Dashboard routes (no login, like the rest): fields CRUD, values, reveal.
- Tests: encryption round trip and tamper detection, wrong key fails, reveal/set with wrong PIN → 403 + log row, rate limit, archive keeps values, history rows, secret never present in any API response except reveal, search/filter on text/date.

### 3. Dashboard
- Fields page (nav link "Fields"): list, add, rename, reorder, archive.
- Device page: "Custom fields" panel, inline edit for text/date; secrets as `••••••` with Reveal / Set / Change (PIN dialog), 30 s countdown, copy button; secret access log.
- Device list: text search across custom text fields, date filters.

### 4. Docs
- README: Fields page, secret fields, `SECRETS_KEY` setup and backup, accepted risk. `.env.example` and `docker-compose.yml` get `SECRETS_KEY`. `CLAUDE.md` conventions line.

## Done when
- `bun run lint` and `bun run test` pass; CI green.
- User test: create Text, Date and Secret fields; fill them on a device; reveal a secret with the current PIN (fails with an old one); see the access log and history; search and filter by the new fields.

## Risks
- Key management: lost `SECRETS_KEY` = unrecoverable secrets; changing it needs a re-encryption step (out of scope, documented).
- No login: secrets are protected only by the IT PIN, which is visible on the dashboard. Fixed properly when staff login arrives.
