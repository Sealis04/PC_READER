# Milestone 7 — Staff login with HRIS (Better Auth, OIDC)

Source spec: [`docs/technical-spec.md`](../../docs/technical-spec.md) ("Staff accounts for the dashboard live in a separate `staff` table … not in `users`"; "Staff logins and exports are logged"). Builds on `main` (branding, #16). HRIS integration contract: `Sealis04/hris` → `docs/oauth-integration.md`.

## Goal

The dashboard gets a login. Staff sign in with their HRIS account (HRIS is the OpenID Provider; PC_READER is a confidential OIDC client using Better Auth). Only HRIS users with the `IT` user level get in. Every staff action on the dashboard records who did it. This closes the "no dashboard login" accepted risk (IT PIN page, Settings, and later M6 secrets).

**Out of scope:** local passwords or any login other than HRIS, per-staff roles inside PC_READER (all allowed staff get full access), an HRIS roles manifest, changes to the HRIS codebase, the agent / desktop app / contracts (they don't use the dashboard).

## Decisions (2026-10-20)

| Topic | Decision |
| --- | --- |
| Provider | HRIS, via its OIDC discovery `${HRIS_URL}/.well-known/openid-configuration` (Authorization Code + PKCE S256, EdDSA id_tokens). HRIS already runs Better Auth `oauthProvider`; **no HRIS code changes** |
| Library | `better-auth` on the PC_READER server with the Drizzle adapter (`pg`) and the `genericOAuth` plugin (`providerId: "hris"`, `pkce: true`, `overrideUserInfo: true`). No email/password, no other providers. Mounted at `/api/auth/[...all]` |
| HRIS client | Registered by an HRIS admin at `/admin/oauth-clients`: confidential, redirect URI `${BETTER_AUTH_URL}/api/auth/oauth2/callback/hris` (exact), scopes `openid profile email account_level` |
| Who gets in | `hris:user_level` (from the `account_level` scope) must be in `HRIS_ALLOWED_USER_LEVELS` (comma list, default `IT`). Checked on every sign-in (the level is refreshed from HRIS each time); a denied sign-in creates no session and shows "Your HRIS account is not allowed to use PC_READER" on `/login` |
| What is protected | The whole dashboard: every page and every `/api/dashboard/*` route. Open: `/login`, `/api/auth/*`, `/api/agent/*` (device tokens, unchanged), `/api/branding[/logo]` (public, the desktop app needs it), static assets |
| Enforcement | `proxy.ts` (Next 16) does a cheap cookie check and redirects pages to `/login?next=…`. The real check is server-side in one helper `requireStaff()` (`src/lib/staff-auth.ts`) called by every dashboard page/layout and every dashboard route handler: pages → redirect, API → `401 { error: "unauthorized" }`. A test walks `src/app/api/dashboard/**/route.ts` and fails if a route answers without a session |
| Fail closed | If `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `HRIS_URL`, `HRIS_CLIENT_ID` or `HRIS_CLIENT_SECRET` is missing, the server still starts (agent API keeps working) but the dashboard shows "Login is not configured" and all dashboard APIs return 503. No dev bypass |
| Staff tables | Better Auth tables with a `staff_` prefix so they don't collide with the existing `users` (PC users): `staff_user`, `staff_session`, `staff_account`, `staff_verification`. `staff_user` extra fields: `hris_sub` (unique, the join key — never email), `employee_number`, `hris_user_level`. Staff rows are never deleted |
| Session | 8 h, refreshed with activity (Better Auth defaults otherwise). Sign out in the top bar. Cookies `secure` when `BETTER_AUTH_URL` is https (plain-HTTP LAN still works, as today) |
| Who did it | `status_history.changed_by`, `device_field_history.changed_by`, `device_requests.requested_by` and dashboard-made `assignments.assigned_by` store the `staff_user.id`. The device page shows the staff name (join to `staff_user`); old rows (null, `self-registration`, …) show as before. History stays append-only |
| Login log | New append-only `staff_events` (staff_user_id nullable, hris_sub, type `login` / `login_denied` / `logout` / `it_pin_rotated` / `settings_changed` / `logo_changed`, detail, client IP, time). Never tokens, codes or the PIN. Shown read-only on a small "Staff activity" section of `/settings` (latest 100) |
| Network | The PC_READER server must reach HRIS (back-channel token + JWKS calls) and staff browsers must reach both |

## Login flow

```
Browser ──GET /devices──▶ proxy.ts: no session cookie ──302──▶ /login
/login "Sign in with HRIS" ──▶ /api/auth/sign-in/oauth2 {providerId: hris}
   ──302──▶ HRIS /api/better-auth/oauth2/authorize (state + PKCE)
HRIS login + consent ──302──▶ /api/auth/oauth2/callback/hris?code&state
PC_READER server ──POST token (client secret + verifier)──▶ HRIS ; verify id_token (EdDSA, JWKS, iss/aud/exp)
   user_level ∉ allowed ─▶ staff_events login_denied, no session ─▶ /login?error=not_allowed
   user_level ∈ allowed ─▶ upsert staff_user, create staff_session, staff_events login ─▶ /devices (or ?next)
```

## New env (`.env.example`, `docker-compose.yml`, README)

```
BETTER_AUTH_SECRET=            # openssl rand -hex 32
BETTER_AUTH_URL=http://<this server>:3000   # PC_READER's own public URL; must match the redirect URI registered in HRIS
HRIS_URL=https://<hris host>   # discovery at $HRIS_URL/.well-known/openid-configuration
HRIS_CLIENT_ID=
HRIS_CLIENT_SECRET=
HRIS_ALLOWED_USER_LEVELS=IT
```

## Work breakdown (Builder 1, in order, separate commits)

### 1. Schema + Better Auth core
- `bun add better-auth` in `server/` (pin the exact version, same major as HRIS: 1.x).
- Drizzle tables `staff_user` / `staff_session` / `staff_account` / `staff_verification` (generate with `bunx @better-auth/cli generate` against the config, then move into `src/db/schema.ts` and map via `modelName`), `staff_events` (append-only). `bun run db:generate` (never hand-edit SQL).
- `src/lib/auth.ts`: `betterAuth({ database: drizzleAdapter(db, { provider: "pg", schema }), plugins: [genericOAuth({ config: [{ providerId: "hris", discoveryUrl, clientId, clientSecret, pkce: true, scopes: ["openid","profile","email","account_level"], overrideUserInfo: true, mapProfileToUser }] }), nextCookies()] })`. `mapProfileToUser` copies `sub`, `name`, `email`, `employee_number`, `hris:user_level`.
- Gate in `databaseHooks.session.create.before`: load the staff user, reject with `APIError("FORBIDDEN", { code: "NOT_ALLOWED" })` unless the level is allowed; write `login` / `login_denied` to `staff_events`. Pure helper `isAllowedLevel(level, envList)` (trim, case-sensitive like HRIS).
- `src/app/api/auth/[...all]/route.ts` (`toNextJsHandler`).
- `src/lib/staff-auth.ts`: `getStaff()`, `requireStaff()` for pages (redirect) and `requireStaffApi(req)` for routes (401/503 JSON in the agreed `{ error, message }` shape); `authConfigured()`.

### 2. Protect the dashboard
- `src/proxy.ts`: matcher excludes `/login`, `/api/auth`, `/api/agent`, `/api/branding`, `/_next`, favicon; cookie check only (`getSessionCookie`), redirect with `next`.
- Every dashboard page (`/`, `/devices`, `/devices/[id]`, `/devices/[id]/label`, `/it-pin`, `/settings`) and every `/api/dashboard/*` handler calls the helper. Agent and branding routes untouched.
- `/login` page: agency name + logo (from `safeBranding`), "Sign in with HRIS" button, error messages (`not_allowed`, `not_configured`, generic). Safe `next` (same-origin path only, no open redirect).
- Top bar: staff name + "Sign out" (writes `logout`).

### 3. Record who did it
- Pass the staff id from the route handlers into `lib/inventory.ts`, `lib/requests.ts` / `dashboard-requests.ts`, assignment changes, `lib/settings.ts` (→ `settings_changed` / `logo_changed` events) and IT PIN "Change now" (→ `it_pin_rotated`). Keep the lib signatures testable (staff id as a parameter, not read from the request inside the lib).
- `queries.ts` history: join `staff_user` to show the name for `by`.
- `/settings`: read-only "Staff activity" list (latest 100 `staff_events`).

### 4. Tests (bun test, Postgres)
- `isAllowedLevel`: `IT` allowed, `EMPLOYEE` / null / missing claim denied, custom list.
- Session hook: denied level → no session + `login_denied` row; allowed → session + `login` row; level change in HRIS is picked up on next sign-in.
- Route sweep: every file under `src/app/api/dashboard/**/route.ts`, every exported method → 401 without session, 503 when auth env is missing; agent and branding routes still work without a staff session.
- `changed_by` / `requested_by` / `assigned_by` filled with the staff id; history shows the name.
- `next` redirect rejects `//evil.com`, `https://…`.
- Mock HRIS with a tiny in-test OIDC server (discovery, authorize, token, JWKS with an Ed25519 key) for one full callback test, if practical; otherwise test the hooks directly and leave the full flow to the user test.

### 5. Docs
- README: "Staff login (HRIS)" — registering the client in HRIS (redirect URI, scopes, confidential), env vars, who gets in, sign out, what changed. Remove the "no dashboard login" accepted-risk notes (Settings, IT PIN, history `changed_by`). `.env.example`, `docker-compose.yml`, `CLAUDE.md` conventions line, spec line about Auth.js → Better Auth + HRIS.

## Done when
- `bun run lint` and `bun run test` pass locally.
- User test against the real HRIS: an IT user signs in and lands on `/devices`; an EMPLOYEE user is refused with the message; `/it-pin` and `/api/dashboard/*` are unreachable signed out; a status change shows the staff name in history; the PC agent and desktop app keep working unchanged.

## Risks / notes
- **Issuer:** HRIS's issuer is `${HRIS BETTER_AUTH_URL}/api/better-auth`; Better Auth ≥ 1.7 clients check it. If discovery and tokens disagree, it's an HRIS config issue (`BETTER_AUTH_URL` on HRIS), not PC_READER code.
- **Plain HTTP LAN:** session cookies travel unencrypted on HTTP; HTTPS is still recommended (unchanged risk from M1).
- **Revocation:** removing a user's IT level in HRIS takes effect at their next sign-in (≤ 8 h session). Acceptable for now.
- **M6 (custom fields)** is planned but not built; both add migrations. M6 should run after M7 merges and use `requireStaff` + staff id in `secret_access_log`.
