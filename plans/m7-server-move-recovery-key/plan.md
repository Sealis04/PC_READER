# Milestone 7 — Server move and rotating recovery key

Decided with the owner on 2026-11-19. Visual plan: https://claude.ai/artifact/S9fomozh7qpVE75UgHtzBV
Builds on M5 (hourly IT PIN, enrollment-key fallback), M6 (`SECRETS_KEY`, reveal pattern) and the setup scripts in #21.

## Goal

1. IT can move the server (new IP, port or hostname) from the dashboard; connected PCs follow by themselves.
2. A PC whose server is gone can still be unlocked offline. The secret for that is the enrollment key, which becomes a **recovery key**: stored in the database, rotated every 30 days, kept in step on every PC (only as a hash), and visible to IT on the dashboard behind the IT PIN.

**Out of scope:** staff login, email notifications, service discovery (mDNS), several servers at once, a per-PC recovery PIN.

## Decisions

| Topic | Decision |
| --- | --- |
| Network | Local network only; the Cloudflare Tunnel stays optional (#21) |
| Recovery secret | The enrollment key, no new PIN. First setup on a PC needs address + key only. Any later server change on a PC needs the IT PIN, or the recovery key when the server is unreachable (today's Settings fallback) |
| Where the key lives | Database. `ENROLLMENT_KEY` from the env file only seeds version 1 of an empty table (an existing install keeps its current key as v1). Once keys exist, the env value is ignored; the dashboard says so if it differs |
| Format of new keys | 16 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no 0/O, 1/I/L) in 4 groups: `K7QM-2XRP-9WDF-H4TN`. Typed case-insensitively, dashes and spaces optional (normalize: trim, upper-case, drop `-` and spaces) |
| Rotation | Automatically every 30 days (server-side check on start and hourly; this is a server timer, not PC polling) and on demand: dashboard "New key now" with the current IT PIN |
| Joining new PCs | Only the current version registers a PC. No overlap after a rotation |
| Old keys | Kept, encrypted with `SECRETS_KEY` (AES-256-GCM via `lib/secrets-crypto.ts`, context `recovery-key:<version>`). An old key still unlocks the PCs that hold it (offline, on the PC); it never registers a PC |
| Seeing the key | Dashboard Settings: "Show key" asks for the current IT PIN, shows it 30 s with Copy. Device page: "Show this PC's recovery key" (IT PIN) shows the version that PC holds. Every attempt logged (append-only), never the value |
| Without `SECRETS_KEY` | Recovery keys cannot be stored: keep today's behaviour (env key only, no rotation, no reveal, no push) and say why on the dashboard. The server still starts |
| Keeping PCs in step | The server never sends the key. It sends a PBKDF2-SHA256 hash in the `config.SecretHash` format (`algorithm`, `iterations` 600 000, `salt`, `hash`), one salt per version, of the **normalized** key, plus the version number. The PC replaces its stored hash and acknowledges the version |
| Missed update: IT | Device page "Recovery key: v7 (current)" / "v5 (2 behind)" / "unknown"; device list filter + count "Recovery key behind", like Stale |
| Missed update: person at the PC | Desktop app notice when the PC has not reached the server for over 30 days (decided on the PC alone): "This computer missed a security update. Connect to the office network." Goes away once the PC is updated |
| Server move | Dashboard Settings "Server address": new URL + IT PIN. The server pushes it to connected PCs (and to PCs that connect later while the move is active). A PC switches only after the new address answers an authenticated check with its own token and the same device id; otherwise it stays and reports why. Dashboard shows per device: moved / not moved (reason) / waiting |
| Setup scripts | `setup.bat` and `setup.sh` (twins): explain that `ENROLLMENT_KEY` only seeds a new database; a prod re-run asks for confirmation before changing `APP_PORT` (it cuts off every PC) |
| Builders | Builder 1 only, in the order below, separate commits |

## Work breakdown (Builder 1)

### 1. Contracts and schema (first commit; INBOX note)
- Contracts (`contracts/agent-api`, fixtures, validators, TS types, Go types/tests):
  - SSE messages in `events.message.schema.json`: `recovery_key` `{ version, hash: { algorithm, iterations, salt, hash } }` and `server_moved` `{ move_id, url }`.
  - `POST /api/agent/recovery-key/ack` `{ version }` → `{ ok: true }`.
  - `GET /api/agent/me` → `{ device_id }` (token-authenticated; used to check a new address).
  - `POST /api/agent/move-result` `{ move_id, moved: boolean, reason? }` (sent to the **old** server before switching, or on failure).
- Drizzle schema + `bun run db:generate` (migration 0008):
  - `recovery_keys` (version serial PK, ciphertext, nonce, verify_hash for registration checks, pc_hash jsonb (the SecretHash sent to PCs), source `seed`/`auto`/`manual`, created_at, retired_at).
  - `recovery_key_access_log` (append-only: action `reveal`/`rotate`, version, device_id null, success, client_ip, created_at).
  - `devices.recovery_key_version` (int null), `devices.recovery_key_acked_at`.
  - `server_moves` (id, url, created_at, client_ip, ended_at) and `server_move_results` (append-only: move_id, device_id, moved, reason, created_at).
  - `unlock_method` values `reveal_recovery_key`, `rotate_recovery_key`, `server_move`.

### 2. Server: recovery key
- `lib/recovery-key.ts` (only place that reads/writes keys): seed from env, generate/normalize/format, `currentKeyMatches(typed)` for `/register` (replaces the direct `ENROLLMENT_KEY` compare in `lib/agent/register.ts`), `rotate(source)`, `revealKey(version, pin, ip)` via `verifyPin`, PC hash for a version.
- Rotation timer in-process (on start + hourly): rotate when the current key is older than 30 days.
- SSE: on connect send `recovery_key` when the device's version is not current; on rotation send it to every open stream. Ack endpoint records the version.
- Dashboard: Settings card (version, created, next rotation, "Show key", "New key now", env-differs note, no-`SECRETS_KEY` note); device page line + "Show this PC's recovery key"; device list filter and count.
- Tests: seed (empty table, existing install keeps its key, env ignored afterwards), normalization, format/alphabet, registration only with the current version, rotation by age and manually (PIN required, wrong PIN 403/429, logged), reveal never in any other response, push on connect/rotate, ack, behind-count, no `SECRETS_KEY` fallback.

### 3. Agent: recovery key
- Handle `recovery_key`: replace `config.EnrollmentKeyHash` with the received hash, save `recovery_key_version`, acknowledge. Save `last_server_contact_at` on every successful contact.
- Offline Settings unlock: verify the normalized typed key; also accept the raw form so hashes made at setup before M7 keep working.
- Desktop app notice after 30 days without server contact (home screen banner; clears on the next contact). `pcreader status` shows the version and last contact.
- IT setup and re-registration keep storing the hash of the typed key (normalized) as today.
- Tests in `internal/app`, `internal/bound`, `internal/events` (fixtures from contracts).

### 4. Server move (server + agent)
- Server: Settings "Server address" form (URL + IT PIN, `verifyPin` method `server_move`), `server_moves` row, `server_moved` push now and on connect while the move is active, "Cancel move", `GET /api/agent/me`, `POST /api/agent/move-result`, per-device status on the Settings card and device page.
- Agent: on `server_moved`, call `GET {url}/api/agent/me` with its token; if 200 and the same device id, post `move-result moved:true` to the old server, save the URL (`SetServerURL`) and reconnect; otherwise keep the old address, log it (no token or URL secrets in logs) and post `moved:false` with a reason (`unreachable`, `unknown_device`, `different_device`).
- Tests on both sides, including a PC that is offline during the move and connects later.

### 5. Setup scripts and docs
- `setup.bat` / `setup.sh`: ENROLLMENT_KEY wording (seeds a new database only; after that the dashboard shows and rotates it); prod re-run asks before changing `APP_PORT`.
- README: "Recovery key" and "Moving the server" sections (recommend a stable name such as `pcreader.office.local` or a DHCP reservation); `.env.example`; CLAUDE.md conventions line for the recovery key and server move.

## Accepted risks
- No dashboard login: anyone who can open the dashboard can read the IT PIN and so reveal the recovery key. Every reveal is logged. Same accepted risk as M5/M6.
- A PC that never reconnects keeps an old key's hash; IT finds that version on the device page.
