# Linear Sync Phase 2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add durable Linear sync state, append-only comment sync, assignee mapping, broker-side pending webhook storage, and macOS conflict review UI while keeping tickets git-backed.

**Architecture:** Keep tickets in the existing local event log, add user-visible sync state as new local ticket events, and use the auth-broker Postgres database for remote webhook queueing and ownership metadata. CLI and macOS remain thin surfaces over the same sync/runtime primitives.

**Tech Stack:** Bun, TypeScript, Drizzle/Neon Postgres, Better Auth, SwiftUI, Elysia.

---

### Task 1: Add Shared Broker DB Schema For Linear Sync

**Files:**
- Modify: `packages/db/src/schema/core.ts`
- Modify: `packages/db/src/client.ts` if exports need extension
- Test: `packages/db/tests/smoke.test.ts`

**Step 1: Write failing schema tests**
- Assert the new Linear tables/exports exist and can be imported.

**Step 2: Run test to verify it fails**
Run: `bun test --cwd packages/db`
Expected: FAIL because schema exports are missing.

**Step 3: Add schema tables**
- `linear_connections`
- `linear_assignee_mappings`
- `linear_webhook_events`
- `linear_sync_subscriptions`

**Step 4: Run package tests**
Run: `bun test --cwd packages/db`
Expected: PASS

**Step 5: Commit**
```bash
git add packages/db/src/schema/core.ts packages/db/tests/smoke.test.ts
git commit -m "feat(db): add linear sync schema"
```

### Task 2: Add Broker DB Access Layer For Linear Sync State

**Files:**
- Create: `services/auth-broker/src/modules/linear-sync-store/service.ts`
- Modify: `services/auth-broker/src/better-auth.ts`
- Test: `services/auth-broker/tests/index.test.ts`

**Step 1: Write failing broker tests**
- store webhook delivery
- list pending deliveries
- mark delivery applied
- preserve optional Better Auth ownership columns

**Step 2: Run broker tests to verify failure**
Run: `bun test --cwd services/auth-broker tests/index.test.ts`
Expected: FAIL due to missing store/routes.

**Step 3: Implement minimal DB-backed store helpers**
- read/write pending deliveries
- read/write assignee mappings
- bind optional user/org/team ownership metadata

**Step 4: Re-run broker tests**
Run: `bun test --cwd services/auth-broker tests/index.test.ts`
Expected: PASS

**Step 5: Commit**
```bash
git add services/auth-broker/src/modules/linear-sync-store/service.ts services/auth-broker/tests/index.test.ts services/auth-broker/src/better-auth.ts
git commit -m "feat(auth-broker): add linear sync store"
```

### Task 3: Persist Verified Linear Webhooks Instead Of Only Acking Them

**Files:**
- Modify: `services/auth-broker/src/modules/linear-agent/plugin.ts`
- Modify: `services/auth-broker/src/app.ts`
- Test: `services/auth-broker/tests/index.test.ts`

**Step 1: Write failing tests**
- valid webhook inserts pending delivery row
- invalid signature still rejected
- response returns accepted delivery metadata

**Step 2: Run tests to verify failure**
Run: `bun test --cwd services/auth-broker tests/index.test.ts`
Expected: FAIL for missing persistence.

**Step 3: Implement persistence path**
- parse relevant webhook metadata
- insert pending event row
- attach optional ownership/profile/team metadata when possible

**Step 4: Re-run tests**
Run: `bun test --cwd services/auth-broker tests/index.test.ts`
Expected: PASS

**Step 5: Commit**
```bash
git add services/auth-broker/src/modules/linear-agent/plugin.ts services/auth-broker/src/app.ts services/auth-broker/tests/index.test.ts
git commit -m "feat(auth-broker): persist linear webhook deliveries"
```

### Task 4: Extend Ticket Store With Comments, Sync Checkpoints, And Conflicts

**Files:**
- Modify: `src/control-plane/extensions/tickets/store.ts`
- Modify: `src/control-plane/extensions/tickets/commands.ts`
- Test: `tests/...` or add focused ticket-store tests

**Step 1: Write failing tests**
- comment append materializes in ticket detail
- checkpoint event materializes sync state
- conflict record event materializes open conflict
- conflict resolution event updates conflict status

**Step 2: Run focused tests to verify failure**
Expected: FAIL because store has no such event types/materialization.

**Step 3: Implement new event types and materialization**
- `ticket.comment_appended`
- `ticket.assignee_set`
- `ticket.sync_checkpointed`
- `ticket.sync_conflict_recorded`
- `ticket.sync_conflict_resolved`

**Step 4: Re-run tests**
Expected: PASS

**Step 5: Commit**
```bash
git add src/control-plane/extensions/tickets/store.ts src/control-plane/extensions/tickets/commands.ts tests
 git commit -m "feat(tickets): add sync comments and conflicts"
```

### Task 5: Add Linear Assignee Mapping And Comment Sync Primitives

**Files:**
- Modify: `src/control-plane/extensions/linear/client.ts`
- Modify: `src/control-plane/extensions/linear/commands.ts`
- Create/Modify tests: `tests/linear-commands.test.ts`, `tests/linear-auth.test.ts`

**Step 1: Write failing tests**
- explicit assignee mapping wins
- unresolved assignee creates conflict instead of overwrite
- new remote comments append locally once
- local comments push once with dedupe

**Step 2: Run tests to verify failure**
Run: `bun test tests/linear-commands.test.ts tests/linear-auth.test.ts`
Expected: FAIL

**Step 3: Implement minimal sync primitives**
- Linear comment fetch/create client helpers
- assignee mapping resolver
- checkpoint-based conflict detection
- append-only comment sync in both directions

**Step 4: Re-run tests**
Expected: PASS

**Step 5: Commit**
```bash
git add src/control-plane/extensions/linear/client.ts src/control-plane/extensions/linear/commands.ts tests/linear-commands.test.ts tests/linear-auth.test.ts
git commit -m "feat(linear): add assignee mapping and comment sync"
```

### Task 6: Add Broker Pending-Event Apply Commands And MCP Tools

**Files:**
- Modify: `src/control-plane/extensions/linear/commands.ts`
- Modify: `src/mcp/server.ts`
- Modify: `apps/macos/Packages/Services/HackCLI/Sources/HackCLIService/HackCLIClient.swift`
- Test: `tests/mcp.test.ts`, `tests/linear-commands.test.ts`

**Step 1: Write failing tests**
- list pending deliveries
- apply pending deliveries for routed project/profile
- MCP tools call the right CLI commands

**Step 2: Run tests to verify failure**
Expected: FAIL

**Step 3: Implement commands/tools**
- `hack linear pending list`
- `hack linear pending apply`
- optional conflict/mapping commands in same surface

**Step 4: Re-run tests**
Expected: PASS

**Step 5: Commit**
```bash
git add src/control-plane/extensions/linear/commands.ts src/mcp/server.ts apps/macos/Packages/Services/HackCLI/Sources/HackCLIService/HackCLIClient.swift tests/mcp.test.ts tests/linear-commands.test.ts
git commit -m "feat(linear): add pending delivery apply tools"
```

### Task 7: Add macOS Review UI For Comments And Conflicts

**Files:**
- Modify: `apps/macos/Packages/Shared/Models/Sources/HackDesktopModels/Models.swift`
- Modify: `apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/TicketsView.swift`
- Modify: `apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/SettingsOverlayView.swift`
- Test: `apps/macos/Packages/Shared/Models/Tests/HackDesktopModelsTests/...`

**Step 1: Write failing model/UI tests**
- conflict badge and needs-review filter
- comments decode and display model
- assignee mapping/settings state

**Step 2: Run tests to verify failure**
Run: `swift test --package-path apps/macos`
Expected: FAIL in focused new tests.

**Step 3: Implement minimal UI**
- comments section in ticket detail
- conflicts section with resolve actions
- needs-review filter
- settings diagnostics for mappings and pending deliveries

**Step 4: Re-run tests/build**
Run: `swift test --package-path apps/macos && swift build --package-path apps/macos`
Expected: PASS

**Step 5: Commit**
```bash
git add apps/macos/Packages/Shared/Models apps/macos/Packages/Features/DashboardFeature
git commit -m "feat(macos): add linear sync review ui"
```

### Task 8: End-to-End Verification And Docs

**Files:**
- Modify: `docs/extensions.md`
- Modify: `docs/cli.md`
- Modify: `services/auth-broker/README.md`

**Step 1: Update docs for new sync/apply/review flow**
- pending webhook apply
- assignee mappings
- conflicts/comments behavior
- user/team ownership notes

**Step 2: Run full verification**
```bash
bun run build
bun run typecheck
bun run test
bun run check
hack ps
```
Expected: all PASS

**Step 3: Commit**
```bash
git add docs/extensions.md docs/cli.md services/auth-broker/README.md
git commit -m "docs: cover linear sync phase 2"
```
