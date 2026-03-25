# Architecture

Architectural decisions and patterns discovered during mission planning.

**What belongs here:** durable architecture rules, canonical paths, ownership boundaries, and shared design constraints.

---

## Core Product Boundary

- Hack remains CLI-first and local-first.
- `apps/web` is optional and must never become the only path for critical local workflows.
- Shared administration, integration management, and env/secret-sharing can prefer the web app, but CLI parity and local usability must remain intact.

## Auth Ownership

- Keep one coherent Better Auth model.
- The browser app owns the interactive web auth UX.
- `services/auth-broker` remains the auth/session and control-plane API backend.
- Do not introduce a second independent auth authority.

## Persistence Rules

- Shared org/team/project/integration state must be durable by default.
- In-memory-only admin state is mission work to remove or explicitly surface as dev-only if temporarily retained during transition.
- Use existing Neon + Drizzle foundations where practical instead of inventing a separate persistence layer.

## Linear Canonical State

- Repo-bound Linear artifacts belong under `.hack/linear/projects/<project-id>/...`.
- `.hack/.hack/linear/**` is a legacy bug surface and must not remain authoritative.
- Mission closeout scope is the frozen set of Hack-project Linear work open at mission start plus mission-created optional-web-control-plane work.

## Durable Persistence Targets

- Better Auth-owned tables and broker-specific auth persistence currently live under `services/auth-broker/src/db/schema.ts`.
- Org/team admin state now persists in broker-owned `org_admin_*` tables under `services/auth-broker/src/db/schema.ts`, and the default auth-broker wiring uses the DB-backed store whenever `DATABASE_URL` is available.
- Auth-broker startup now reports the selected org/team store mode. When `DATABASE_URL` is absent, the broker runs in an explicitly surfaced development-only in-memory mode, and durable initialization failures must throw instead of silently falling back to memory.
- Shared control-plane tables currently live under `packages/db/src/schema/core.ts`, with migrations/verification through `bun run db:generate`, `bun run db:migrate`, and `bun run db:push`.
- Workers may extract shared durable contracts, but they must keep one concrete Neon + Drizzle-backed persistence path and document any migration boundary changes in code/tests.
