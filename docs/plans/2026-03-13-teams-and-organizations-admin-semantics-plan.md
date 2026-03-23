# Teams And Organizations Admin Semantics Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Turn the approved org/team admin semantics into explicit broker APIs, CLI commands, and shared lifecycle outputs that make membership changes trustworthy.

**Architecture:** Add first-class organization, team, and membership lifecycle records to `auth-broker`, then expose them through top-level `hack org` and `hack team` command groups plus recipient-side `hack auth invite` actions. Keep invite acceptance separate from admin mutations, keep team membership dependent on org membership, and make destructive operations preview their cascades before execution.

**Tech Stack:** Bun, TypeScript, Elysia, Better Auth, Drizzle, Hack CLI command framework, JSON CLI output, future macOS consumer surfaces.

---

### Task 1: Lock the semantics into docs and command expectations

**Files:**

- Modify: `docs/plans/2026-03-13-teams-and-organizations-admin-semantics-design.md`
- Modify: `docs/cli.md`
- Test: `tests/cli-command.test.ts`

**Step 1: Write the failing test**

Add command-spec coverage that expects the future top-level command groups and their immediate subcommands to appear in CLI help metadata:

- `hack org`
- `hack team`
- `hack auth invite`

**Step 2: Run test to verify it fails**

Run:

```bash
bun test tests/cli-command.test.ts
```

Expected: FAIL because the command groups do not exist yet.

**Step 3: Write minimal implementation**

Update help/spec plumbing and docs so the command surface is visible even before all mutation handlers are implemented.

**Step 4: Run test to verify it passes**

Run:

```bash
bun test tests/cli-command.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add docs/plans/2026-03-13-teams-and-organizations-admin-semantics-design.md docs/cli.md tests/cli-command.test.ts src/cli/spec.ts src/commands/auth.ts src/commands/org.ts src/commands/team.ts
git commit -m "feat: scaffold org and team command groups"
```

### Task 2: Add broker data model for org, team, and membership lifecycle

**Files:**

- Modify: `services/auth-broker/src/db/schema.ts`
- Modify: `services/auth-broker/src/db/ensure-columns.ts`
- Modify: `services/auth-broker/src/types.ts`
- Test: `services/auth-broker/tests/better-auth-schema.test.ts`
- Test: `services/auth-broker/tests/index.test.ts`

**Step 1: Write the failing test**

Add schema/store tests that expect first-class records for:

- organizations
- teams
- memberships with `pending`, `active`, and `removed` states
- invite metadata and removal audit fields

**Step 2: Run test to verify it fails**

Run:

```bash
bun test --cwd services/auth-broker tests/better-auth-schema.test.ts tests/index.test.ts
```

Expected: FAIL because the lifecycle tables/columns do not exist yet.

**Step 3: Write minimal implementation**

Add the smallest schema and types that can persist:

- org records
- team records with parent org id
- membership records with state and audit timestamps
- optional invite linkage for pending memberships

**Step 4: Run test to verify it passes**

Run:

```bash
bun test --cwd services/auth-broker tests/better-auth-schema.test.ts tests/index.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add services/auth-broker/src/db/schema.ts services/auth-broker/src/db/ensure-columns.ts services/auth-broker/src/types.ts services/auth-broker/tests/better-auth-schema.test.ts services/auth-broker/tests/index.test.ts
git commit -m "feat(auth-broker): add org and membership lifecycle schema"
```

### Task 3: Add broker lifecycle services and route authorization

**Files:**

- Modify: `services/auth-broker/src/app.ts`
- Create: `services/auth-broker/src/modules/orgs/plugin.ts`
- Create: `services/auth-broker/src/modules/orgs/service.ts`
- Create: `services/auth-broker/src/modules/teams/plugin.ts`
- Create: `services/auth-broker/src/modules/teams/service.ts`
- Create: `services/auth-broker/src/modules/memberships/plugin.ts`
- Create: `services/auth-broker/src/modules/memberships/service.ts`
- Test: `services/auth-broker/tests/index.test.ts`
- Test: `services/auth-broker/tests/session-auth.test.ts`

**Step 1: Write the failing test**

Add route tests for:

- org create
- team create under an org
- org member invite/add/remove
- team member invite/add/remove
- invite accept/decline
- org removal cascade preview for child team memberships

**Step 2: Run test to verify it fails**

Run:

```bash
bun test --cwd services/auth-broker tests/index.test.ts tests/session-auth.test.ts
```

Expected: FAIL because these routes do not exist yet.

**Step 3: Write minimal implementation**

Implement the service layer and protected routes with the approved semantics:

- `invite` creates `pending`
- `add` creates `active`
- `accept` moves `pending -> active`
- `decline` and `remove` move membership to `removed`
- org removal previews and then applies team cascades

**Step 4: Run test to verify it passes**

Run:

```bash
bun test --cwd services/auth-broker tests/index.test.ts tests/session-auth.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add services/auth-broker/src/app.ts services/auth-broker/src/modules/orgs/plugin.ts services/auth-broker/src/modules/orgs/service.ts services/auth-broker/src/modules/teams/plugin.ts services/auth-broker/src/modules/teams/service.ts services/auth-broker/src/modules/memberships/plugin.ts services/auth-broker/src/modules/memberships/service.ts services/auth-broker/tests/index.test.ts services/auth-broker/tests/session-auth.test.ts
git commit -m "feat(auth-broker): add org team and membership lifecycle routes"
```

### Task 4: Add CLI command groups and shared mutation rendering

**Files:**

- Modify: `src/cli/spec.ts`
- Modify: `src/commands/auth.ts`
- Create: `src/commands/org.ts`
- Create: `src/commands/team.ts`
- Create: `src/lib/membership-output.ts`
- Test: `tests/cli-command.test.ts`
- Test: `tests/auth-command.test.ts`

**Step 1: Write the failing test**

Add CLI tests for:

- `hack org create`
- `hack org member invite`
- `hack org member add`
- `hack org member remove`
- `hack team create`
- `hack team member invite`
- `hack team member add`
- `hack team member remove`
- `hack auth invites`
- `hack auth invite accept`
- `hack auth invite decline`

**Step 2: Run test to verify it fails**

Run:

```bash
bun test tests/cli-command.test.ts tests/auth-command.test.ts
```

Expected: FAIL because the command handlers do not exist yet.

**Step 3: Write minimal implementation**

Add CLI groups and formatters that:

- call the broker lifecycle routes
- print clear human summaries
- emit stable JSON payloads with membership state transitions and cascade details
- require `--yes` for destructive non-interactive removals

**Step 4: Run test to verify it passes**

Run:

```bash
bun test tests/cli-command.test.ts tests/auth-command.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/cli/spec.ts src/commands/auth.ts src/commands/org.ts src/commands/team.ts src/lib/membership-output.ts tests/cli-command.test.ts tests/auth-command.test.ts
git commit -m "feat(cli): add org and team admin commands"
```

### Task 5: Add confirmation, cascade preview, and audit list behavior

**Files:**

- Modify: `src/commands/org.ts`
- Modify: `src/commands/team.ts`
- Modify: `services/auth-broker/src/modules/memberships/service.ts`
- Test: `tests/cli-command.test.ts`
- Test: `services/auth-broker/tests/index.test.ts`

**Step 1: Write the failing test**

Add tests that verify:

- removing an org member previews affected team memberships
- `--yes` bypasses interactive confirmation cleanly
- member listing defaults to pending and active
- `--state all` includes removed memberships with audit metadata

**Step 2: Run test to verify it fails**

Run:

```bash
bun test tests/cli-command.test.ts && bun test --cwd services/auth-broker tests/index.test.ts
```

Expected: FAIL until preview and audit behaviors are implemented.

**Step 3: Write minimal implementation**

Implement preview-first destructive behavior and consistent list filters without adding bulk operations or advanced role editing.

**Step 4: Run test to verify it passes**

Run:

```bash
bun test tests/cli-command.test.ts && bun test --cwd services/auth-broker tests/index.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/commands/org.ts src/commands/team.ts services/auth-broker/src/modules/memberships/service.ts tests/cli-command.test.ts services/auth-broker/tests/index.test.ts
git commit -m "feat: add membership confirmation and audit views"
```

### Task 6: Final verification and docs cleanup

**Files:**

- Modify: `docs/cli.md`
- Verify only

**Step 1: Run focused verification**

Run:

```bash
bun test tests/cli-command.test.ts tests/auth-command.test.ts
bun test --cwd services/auth-broker tests/better-auth-schema.test.ts tests/index.test.ts tests/session-auth.test.ts
```

Expected: PASS

**Step 2: Run repo quality gates**

Run:

```bash
bun x ultracite fix
bun x ultracite check
bun test
```

Expected: PASS

**Step 3: Sync follow-up docs**

Make sure `docs/cli.md` and command help text match the shipped CLI behavior.

**Step 4: Commit**

```bash
git add docs/cli.md
git commit -m "docs: finalize org and team admin CLI semantics"
```
