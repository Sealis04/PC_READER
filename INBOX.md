# INBOX — agent coordination

Planner writes assignments here. Builders read their section, work it, and update **Status**. Full plan: [`plans/m1-thin-slice/plan.md`](plans/m1-thin-slice/plan.md). Spec: [`docs/technical-spec.md`](docs/technical-spec.md).

**Base branch:** `ccr-510da39c-6w5qgz` (holds the plan; `main` does not yet). Branch from it, and push your work to the branch your session is assigned.

---

## Builder 1 — Run 1: Phase 0 + server

**Status:** ASSIGNED

Scope: "Run 1" in the plan — Phase 0 (repo layout, `contracts/` schemas and fixtures, schema check), committed separately, then Phase 1 (Next.js + Drizzle server, `/api/agent/register`, `/api/agent/scans`, dashboard list + detail, docker-compose, integration tests, CI).

Do **not** touch `agent/` beyond an empty placeholder.

When finished:
1. Set Status to `DONE`, add the branch name, commit SHA, and a short note of anything that deviates from the plan or that Run 2 must know (e.g. schema decisions).
2. Commit and push. The planner fires Run 2 after reading this.

---

## Builder 1 — Run 2: Go agent

**Status:** WAITING (starts after Run 1 is DONE)

Scope: "Run 2" in the plan — Go module in `agent/`, Windows + macOS scanners with fixture-tested parsers, `register` / `scan` / `capture-raw` CLI, credential-store token, cross-compile CI producing Windows `.exe` and macOS universal binary artifacts, end-to-end upload test against the server.

Build on the branch Run 1 pushed (see its notes above). Do not change `contracts/` without recording why in this file.

When finished: set Status to `DONE` with branch + SHA and notes, commit and push.

---

## Builder 2 / Reviewer

Not used in M1.
