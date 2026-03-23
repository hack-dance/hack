# Teams and Organizations Management Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an explicit, secure-by-default admin model for organizations, teams, shared project ownership, and env sharing without regressing Hack's local-first workflows.

**Architecture:** Keep local runtime/project/env operations local by default, and add broker-mediated ownership, membership, grants, and audit flows only for shared resources. The CLI should expose the trust boundary directly through `auth`, `org`, `team`, `project owner/access`, and shared `env` surfaces.

**Tech Stack:** Bun, TypeScript, Hack CLI, auth-broker, existing env contract system, existing Hack auth session model

---

## Program Split

`HACK-436` is the program-definition issue, not the implementation bucket. The expected output for this issue is:

- a reviewed design for the command and access-control model
- a dependency-ordered child ticket set covering lifecycle, permissions, ownership, env sharing, and admin boundaries
- a concrete implementation sequence that downstream tickets can execute without re-deciding trust assumptions

Recommended child ticket order:

1. `T-00001` Org and Team Lifecycle Primitives
2. `T-00002` Org/Team Membership and RBAC Enforcement
3. `T-00003` Project Ownership Metadata and Transfer Flow
4. `T-00004` Project Access Grants and Permission Checks
5. `T-00005` Shared Env Policy, Grants, and Encrypted Value Custody
6. `T-00006` CLI Help and Docs for Local vs Broker Admin Boundaries
7. `T-00007` Audit Events and Diagnostics for Shared Admin Operations

Recommended dependencies:

- Ticket 2 depends on Ticket 1
- Ticket 3 depends on Ticket 1
- Ticket 4 depends on Tickets 2 and 3
- Ticket 5 depends on Tickets 2 and 3
- Ticket 6 depends on Tickets 1, 3, 4, and 5
- Ticket 7 depends on Tickets 2, 4, and 5

The task breakdown below is the implementation scaffold those child tickets should follow.

---

### Task 1: Capture the shared admin vocabulary in config and docs

**Files:**
- Modify: `docs/architecture.md`
- Modify: `docs/env.md`
- Modify: `docs/gateway.md` if boundary wording needs tightening
- Test: documentation review plus focused grep validation

**Step 1: Write the failing documentation checklist**
- Confirm the docs do not currently define:
  - local vs shared project ownership
  - project vs env grant separation
  - org/team admin boundary

**Step 2: Run the repo search to verify the gap**
Run:
```bash
grep -RInE 'project ownership|env grant|team role|org role|shared env' docs src tests
```
Expected: incomplete or missing shared admin contract language.

**Step 3: Add the minimal shared admin vocabulary**
- define `local` vs `shared` ownership
- define org/team/project/env role terms
- define broker-mediated admin boundary

**Step 4: Re-run the search and readback**
Run:
```bash
grep -RInE 'local vs broker|project_owner|env_admin|team_admin|org_owner' docs
```
Expected: PASS with the new contract represented in docs.

### Task 2: Add explicit project ownership metadata and read surfaces

**Files:**
- Modify: `src/lib/project.ts`
- Modify: `src/lib/project-meta.ts`
- Modify: `src/commands/project.ts`
- Test: `tests/project-config.test.ts`
- Test: `tests/project-views.test.ts`

**Step 1: Write the failing tests**
- local projects default to `ownership.mode=local`
- shared project metadata can represent `team` or `organization` ownership
- CLI/project views surface ownership without inferring from unrelated state

**Step 2: Run focused tests to verify failure**
Run:
```bash
bun test tests/project-config.test.ts tests/project-views.test.ts
```
Expected: FAIL because ownership metadata and views are not explicit yet.

**Step 3: Write minimal implementation**
- add project ownership metadata schema/helpers
- expose read-only ownership inspection in the CLI

**Step 4: Re-run focused tests**
Run:
```bash
bun test tests/project-config.test.ts tests/project-views.test.ts
```
Expected: PASS

### Task 3: Add org and team lifecycle CLI surfaces backed by broker auth

**Files:**
- Modify: `src/commands/auth.ts`
- Create: `src/commands/org.ts`
- Create: `src/commands/team.ts`
- Modify: `src/cli/spec.ts`
- Test: `tests/auth-command.test.ts`
- Test: new focused tests such as `tests/org-command.test.ts` and `tests/team-command.test.ts`

**Step 1: Write the failing tests**
- unauthenticated `org` and `team` mutations fail with a clear Hack auth requirement
- list/show surfaces parse and render target scope correctly
- mutating calls require broker-backed auth context

**Step 2: Run focused tests to verify failure**
Run:
```bash
bun test tests/auth-command.test.ts tests/org-command.test.ts tests/team-command.test.ts
```
Expected: FAIL because the new command surfaces do not exist.

**Step 3: Write minimal implementation**
- add `hack org ...` and `hack team ...` command trees
- wire auth/session guards
- keep scope explicit in command output and errors

**Step 4: Re-run focused tests**
Run:
```bash
bun test tests/auth-command.test.ts tests/org-command.test.ts tests/team-command.test.ts
```
Expected: PASS

### Task 4: Add project transfer and access-grant flows

**Files:**
- Modify: `src/commands/project.ts`
- Modify: project ownership/access helper modules under `src/lib/`
- Test: `tests/project-up-command.test.ts`
- Test: new focused project access tests

**Step 1: Write the failing tests**
- `hack project owner show` returns local or shared ownership explicitly
- transfer to team/org requires authenticated broker context
- project access grants are rejected for local-only projects

**Step 2: Run focused tests to verify failure**
Run:
```bash
bun test tests/project-up-command.test.ts tests/project-config.test.ts tests/project-views.test.ts
```
Expected: FAIL because ownership transfer and grant behavior is missing.

**Step 3: Write minimal implementation**
- add `project owner` read/transfer commands
- add `project access` list/grant/revoke commands
- fail closed when project mode is local or auth context is missing

**Step 4: Re-run focused tests**
Run:
```bash
bun test tests/project-up-command.test.ts tests/project-config.test.ts tests/project-views.test.ts
```
Expected: PASS

### Task 5: Add shared env policy and access controls

**Files:**
- Modify: `src/commands/env.ts`
- Modify: `src/lib/env.ts`
- Modify: `docs/env.md`
- Test: `tests/env-backend-command.test.ts`
- Test: add focused env-sharing tests

**Step 1: Write the failing tests**
- local env operations remain local by default
- enabling env sharing requires explicit mode selection
- shared env value access is checked separately from project access

**Step 2: Run focused tests to verify failure**
Run:
```bash
bun test tests/env-backend-command.test.ts
```
Expected: FAIL because shared env policy/grants are not implemented.

**Step 3: Write minimal implementation**
- add env sharing policy representation
- add `env access` and `env share` subcommands
- preserve local `env set/unset` semantics

**Step 4: Re-run focused tests**
Run:
```bash
bun test tests/env-backend-command.test.ts
```
Expected: PASS

### Task 6: Add broker authorization and audit contracts for shared admin actions

**Files:**
- Modify: `services/auth-broker/src/...` relevant auth/admin modules
- Modify: `packages/db/src/schema/...` if shared admin tables/events are needed
- Test: `services/auth-broker/tests/...`
- Test: `packages/db` focused schema tests

**Step 1: Write the failing tests**
- shared admin operations enforce org/team/project/env roles
- unauthorized callers receive explicit permission failures
- successful mutations emit durable audit events

**Step 2: Run focused broker tests to verify failure**
Run:
```bash
bun test --cwd services/auth-broker
bun test --cwd packages/db
```
Expected: FAIL in the new authorization/audit scenarios.

**Step 3: Write minimal implementation**
- add shared admin role checks
- add audit event recording for shared mutations
- keep local-only workflows outside this enforcement path

**Step 4: Re-run focused broker tests**
Run:
```bash
bun test --cwd services/auth-broker
bun test --cwd packages/db
```
Expected: PASS

### Task 7: Tighten CLI help, docs, and diagnostics around the trust boundary

**Files:**
- Modify: `docs/cli.md`
- Modify: `src/cli/help.ts`
- Modify: `src/commands/help.ts`
- Test: `tests/cli-command.test.ts`

**Step 1: Write the failing test**
- help output names the local-only versus broker-mediated distinction where the new commands appear

**Step 2: Run focused tests to verify failure**
Run:
```bash
bun test tests/cli-command.test.ts
```
Expected: FAIL because help text does not yet describe the boundary clearly.

**Step 3: Write minimal implementation**
- update help text for new admin surfaces
- add boundary-oriented examples and failure guidance

**Step 4: Re-run focused tests**
Run:
```bash
bun test tests/cli-command.test.ts
```
Expected: PASS

### Task 8: Final verification

**Files:**
- Verify only

**Step 1: Run focused tests for touched areas**
Run:
```bash
bun test tests/auth-command.test.ts tests/project-config.test.ts tests/project-views.test.ts tests/project-up-command.test.ts tests/env-backend-command.test.ts tests/cli-command.test.ts
```
Expected: PASS

**Step 2: Run repo verification gates**
Run:
```bash
bun run build
bun run typecheck
bun run test
bun run check
```
Expected: PASS

**Step 3: Run ticket and runtime checks**
Run:
```bash
bun run index.ts tickets list
bun run index.ts doctor
```
Expected: PASS, or explicit blocker output if ticket remote/auth setup is unavailable in the environment.
