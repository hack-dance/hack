# Linear Phase 3 Completion Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Finish the remaining Linear production work by adding first-class ownership persistence, team-scoped broker authz, shared repo-backed review notes, and opt-in project autosync.

**Architecture:** Keep git-backed tickets as the project source of truth and keep broker-only integration state in `services/auth-broker`. Promote ownership fields into first-class broker persistence, then enforce access from Better Auth session/org/team state. Add repo-shared review notes as new ticket events, and finally layer autosync on top of the existing pending-delivery/manual-apply engine.

**Tech Stack:** Bun, TypeScript, Elysia, Better Auth, Drizzle/Neon, SwiftUI, git-backed ticket event log.

---

### Task 1: Promote Linear ownership fields to first-class broker schema

**Files:**
- Modify: `services/auth-broker/src/db/schema.ts`
- Modify: `services/auth-broker/src/db.ts` if needed
- Modify: `services/auth-broker/src/modules/linear-connections/service.ts`
- Modify: `services/auth-broker/src/modules/linear-sync-store/service.ts`
- Test: `services/auth-broker/tests/index.test.ts`

**Step 1: Write the failing broker tests**
- Assert connection rows round-trip `betterAuthOrganizationId` and `betterAuthTeamId` as first-class fields.
- Assert webhook deliveries round-trip `betterAuthOrganizationId` and `betterAuthTeamId` as first-class fields.

**Step 2: Run the focused broker tests to verify failure**
Run: `bun test --cwd services/auth-broker tests/index.test.ts`
Expected: FAIL because the schema/service layer still pulls ownership from metadata/payload envelopes.

**Step 3: Implement the minimal schema/service change**
- Add dedicated ownership columns to the local auth-broker schema.
- Read/write them directly in connection and webhook delivery services.
- Keep compatibility fallback for existing metadata/payload rows during rollout.

**Step 4: Re-run the focused tests**
Run: `bun test --cwd services/auth-broker tests/index.test.ts`
Expected: PASS

**Step 5: Commit**
```bash
git add services/auth-broker/src/db.ts services/auth-broker/src/db/schema.ts services/auth-broker/src/modules/linear-connections/service.ts services/auth-broker/src/modules/linear-sync-store/service.ts services/auth-broker/tests/index.test.ts
git commit -m "feat(auth-broker): promote linear ownership fields"
```

### Task 2: Enforce team-scoped Better Auth access on Linear broker routes

**Files:**
- Modify: `services/auth-broker/src/modules/better-auth/session.ts`
- Modify: `services/auth-broker/src/modules/linear-connections/plugin.ts`
- Modify: `services/auth-broker/src/modules/linear-sync-store/plugin.ts`
- Modify: `services/auth-broker/src/modules/providers/plugin.ts`
- Test: `services/auth-broker/tests/index.test.ts`

**Step 1: Write the failing broker route tests**
- Active team membership can list/apply team-owned deliveries.
- User/session fallback still works for legacy user-owned records.
- Org-only sessions cannot mutate team-owned records outside membership.

**Step 2: Run the focused broker tests to verify failure**
Run: `bun test --cwd services/auth-broker tests/index.test.ts`
Expected: FAIL because only user/org scoping exists.

**Step 3: Implement minimal team authz**
- Extend resolved Better Auth session shape with team membership identifiers.
- Filter connection/delivery lists by user, org, and team ownership in that order.
- Update provider metadata access mode to report the strongest active scope.

**Step 4: Re-run the focused tests**
Run: `bun test --cwd services/auth-broker tests/index.test.ts`
Expected: PASS

**Step 5: Commit**
```bash
git add services/auth-broker/src/modules/better-auth/session.ts services/auth-broker/src/modules/linear-connections/plugin.ts services/auth-broker/src/modules/linear-sync-store/plugin.ts services/auth-broker/src/modules/providers/plugin.ts services/auth-broker/tests/index.test.ts
git commit -m "feat(auth-broker): enforce linear team access"
```

### Task 3: Add shared repo-backed review note events

**Files:**
- Modify: `src/control-plane/extensions/tickets/store.ts`
- Modify: `src/control-plane/extensions/tickets/commands.ts`
- Modify: `src/control-plane/extensions/linear/commands.ts`
- Modify: `apps/macos/Packages/Shared/Models/Sources/HackDesktopModels/Models.swift`
- Modify: `apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/TicketsView.swift`
- Test: `tests/tickets-store.test.ts`
- Test: `apps/macos/Packages/Shared/Models/Tests/HackDesktopModelsTests/TicketDetailReviewModelTests.swift`

**Step 1: Write the failing local ticket tests**
- `ticket.review_note_appended` materializes in ticket detail.
- Review notes remain distinct from synced ticket comments.

**Step 2: Run the focused tests to verify failure**
Run: `bun test tests/tickets-store.test.ts && swift test --package-path apps/macos --filter TicketDetailReviewModelTests`
Expected: FAIL because review notes are still desktop-local state.

**Step 3: Implement the minimal shared review-note path**
- Add a new append-only ticket event type.
- Add CLI command/helper to append review notes.
- Replace desktop-local review note storage with ticket-backed data.
- Keep review notes separate from Linear-synced comments.

**Step 4: Re-run the focused tests**
Run: `bun test tests/tickets-store.test.ts && swift test --package-path apps/macos --filter TicketDetailReviewModelTests`
Expected: PASS

**Step 5: Commit**
```bash
git add src/control-plane/extensions/tickets/store.ts src/control-plane/extensions/tickets/commands.ts src/control-plane/extensions/linear/commands.ts tests/tickets-store.test.ts apps/macos/Packages/Shared/Models/Sources/HackDesktopModels/Models.swift apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/TicketsView.swift apps/macos/Packages/Shared/Models/Tests/HackDesktopModelsTests/TicketDetailReviewModelTests.swift
git commit -m "feat(tickets): share linear review notes"
```

### Task 4: Add opt-in project autosync subscriptions and apply flow

**Files:**
- Modify: `services/auth-broker/src/db/schema.ts`
- Modify: `services/auth-broker/src/modules/linear-sync-store/service.ts`
- Modify: `services/auth-broker/src/modules/linear-agent/plugin.ts`
- Modify: `src/control-plane/extensions/linear/commands.ts`
- Modify: `src/mcp/server.ts`
- Modify: `apps/macos/Packages/Services/HackCLI/Sources/HackCLIService/HackCLIClient.swift`
- Modify: `apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/SettingsOverlayView.swift`
- Modify: `apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/ProjectDetailView.swift`
- Test: `services/auth-broker/tests/index.test.ts`
- Test: `tests/linear-commands.test.ts`
- Test: `tests/mcp.test.ts`

**Step 1: Write the failing autosync tests**
- Project subscription rows can be created/listed for a profile/project/team.
- Matching webhook deliveries can auto-apply when autosync is enabled.
- Conflict-producing deliveries remain pending/review-needed instead of silently overwriting.

**Step 2: Run the focused tests to verify failure**
Run: `bun test --cwd services/auth-broker tests/index.test.ts && bun test tests/linear-commands.test.ts tests/mcp.test.ts`
Expected: FAIL because autosync subscriptions and auto-apply behavior do not exist.

**Step 3: Implement the minimal autosync path**
- Add subscription persistence.
- Match pending deliveries to project/profile/team routes.
- Reuse the existing sync engine for auto-apply.
- Stop on conflict and record review state instead of forcing overwrite.

**Step 4: Re-run the focused tests**
Run: `bun test --cwd services/auth-broker tests/index.test.ts && bun test tests/linear-commands.test.ts tests/mcp.test.ts`
Expected: PASS

**Step 5: Commit**
```bash
git add services/auth-broker/src/db/schema.ts services/auth-broker/src/modules/linear-sync-store/service.ts services/auth-broker/src/modules/linear-agent/plugin.ts src/control-plane/extensions/linear/commands.ts src/mcp/server.ts apps/macos/Packages/Services/HackCLI/Sources/HackCLIService/HackCLIClient.swift apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/SettingsOverlayView.swift apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/ProjectDetailView.swift services/auth-broker/tests/index.test.ts tests/linear-commands.test.ts tests/mcp.test.ts
git commit -m "feat(linear): add project autosync"
```

### Task 5: Final verification

**Files:**
- Verify only

**Step 1: Run focused broker/macOS tests**
Run: `bun test --cwd services/auth-broker tests/index.test.ts && swift test --package-path apps/macos --filter TicketDetailReviewModelTests`
Expected: PASS

**Step 2: Run full repo verification gates**
Run: `bun run build && bun run typecheck && bun run test && bun run check && hack ps`
Expected: PASS

**Step 3: Verify auth-broker deployability**
Run: `railway up --service auth-broker -c`
Expected: successful deployment with `/health` returning `ok: true`
