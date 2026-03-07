# Linear Local Access Seeding Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let signed-in Hack clients reseed local Linear access from an existing Hack-owned remote connection without forcing users back through Linear OAuth.

**Architecture:** Persist an encrypted Linear token envelope on the broker-owned connection row, expose a protected local-seeding endpoint, and keep that remote custody fresh whenever local token refresh rotates credentials. Desktop and CLI continue using local keychain-backed profiles, while the default UX stays flattened to connected-or-not-connected with repair only when needed.

**Tech Stack:** Bun, Elysia, Drizzle, Better Auth, macOS SwiftUI, Hack CLI, Railway

---

### Task 1: Add failing broker tests for encrypted Linear token custody

**Files:**
- Modify: `services/auth-broker/tests/linear-callback-routes.test.ts`
- Create: `services/auth-broker/tests/linear-token-custody.test.ts`
- Modify: `services/auth-broker/tests/index.test.ts`

**Step 1: Write the failing test**
Add tests for:
- successful Linear callback persists encrypted token custody on the connection
- protected seed endpoint returns a decrypted token envelope for the owning Hack account
- refresh/update endpoint rejects unauthorized callers

**Step 2: Run test to verify it fails**
Run:
```bash
bun test --cwd services/auth-broker tests/linear-callback-routes.test.ts tests/linear-token-custody.test.ts
```
Expected: FAIL because the broker does not yet store or reseed durable Linear token custody.

**Step 3: Write minimal implementation**
Touch only broker schema/store/service code until the custody contract exists.

**Step 4: Run test to verify it passes**
Run:
```bash
bun test --cwd services/auth-broker tests/linear-callback-routes.test.ts tests/linear-token-custody.test.ts
```
Expected: PASS

**Step 5: Commit**
```bash
git add services/auth-broker/tests/linear-callback-routes.test.ts services/auth-broker/tests/linear-token-custody.test.ts services/auth-broker/tests/index.test.ts services/auth-broker/src/db/schema.ts services/auth-broker/src/config.ts services/auth-broker/src/modules/linear-connections/service.ts services/auth-broker/src/modules/linear-connections/plugin.ts services/auth-broker/src/modules/linear-oauth/service.ts
 git commit -m "feat: persist encrypted linear token custody"
```

### Task 2: Add broker seed/update endpoints for local Linear access

**Files:**
- Modify: `services/auth-broker/src/modules/linear-connections/plugin.ts`
- Modify: `services/auth-broker/src/modules/linear-connections/service.ts`
- Modify: `services/auth-broker/tests/linear-token-custody.test.ts`

**Step 1: Write the failing test**
Add tests for:
- `POST /v1/auth/linear/connections/seed` returns seedable local-access payload
- `POST /v1/auth/linear/connections/update-local-access` updates encrypted custody
- seed refreshes stale access tokens before returning payload when refresh token exists

**Step 2: Run test to verify it fails**
Run:
```bash
bun test --cwd services/auth-broker tests/linear-token-custody.test.ts
```
Expected: FAIL

**Step 3: Write minimal implementation**
Implement protected broker routes and reuse Better Auth ownership checks already used by connection listing.

**Step 4: Run test to verify it passes**
Run:
```bash
bun test --cwd services/auth-broker tests/linear-token-custody.test.ts
```
Expected: PASS

**Step 5: Commit**
```bash
git add services/auth-broker/src/modules/linear-connections/plugin.ts services/auth-broker/src/modules/linear-connections/service.ts services/auth-broker/tests/linear-token-custody.test.ts
 git commit -m "feat: add broker linear local-access seeding endpoints"
```

### Task 3: Add CLI import/update plumbing for broker-held Linear access

**Files:**
- Modify: `src/control-plane/extensions/linear/auth.ts`
- Modify: `src/control-plane/extensions/linear/commands.ts`
- Modify: `tests/linear-commands.test.ts`

**Step 1: Write the failing test**
Add tests for:
- `hack x linear seed-local-access --profile default --json`
- successful seed stores the local profile token envelope
- local refresh pushes updated custody back to the broker when broker-owned access exists

**Step 2: Run test to verify it fails**
Run:
```bash
bun test tests/linear-commands.test.ts
```
Expected: FAIL

**Step 3: Write minimal implementation**
Add a CLI repair/import path that consumes the protected broker seed endpoint and writes through `saveLinearToken()`.

**Step 4: Run test to verify it passes**
Run:
```bash
bun test tests/linear-commands.test.ts
```
Expected: PASS

**Step 5: Commit**
```bash
git add src/control-plane/extensions/linear/auth.ts src/control-plane/extensions/linear/commands.ts tests/linear-commands.test.ts
 git commit -m "feat: seed local linear access from broker connection"
```

### Task 4: Flatten desktop Linear state around repairable local access

**Files:**
- Modify: `apps/macos/Packages/Services/HackCLI/Sources/HackCLIService/HackCLIClient.swift`
- Modify: `apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/DashboardModel.swift`
- Modify: `apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/SettingsOverlayView.swift`
- Modify: `apps/macos/Packages/Shared/Models/Sources/HackDesktopModels/Models.swift`
- Modify: `apps/macos/Packages/Shared/Models/Tests/HackDesktopModelsTests/LinearSyncUXModelTests.swift`

**Step 1: Write the failing test**
Add tests for:
- remote connection plus missing local token -> `Needs attention`
- repair action imports local access and flips to `Connected`
- no `Waiting for browser auth` loop once remote connection exists but local access is missing

**Step 2: Run test to verify it fails**
Run:
```bash
swift test --package-path apps/macos --filter LinearSyncUXModelTests
```
Expected: FAIL

**Step 3: Write minimal implementation**
Teach the app to use the new CLI repair/import path and flatten the visible state to connected/repair-only copy.

**Step 4: Run test to verify it passes**
Run:
```bash
swift test --package-path apps/macos --filter LinearSyncUXModelTests
```
Expected: PASS

**Step 5: Commit**
```bash
git add apps/macos/Packages/Services/HackCLI/Sources/HackCLIService/HackCLIClient.swift apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/DashboardModel.swift apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/SettingsOverlayView.swift apps/macos/Packages/Shared/Models/Sources/HackDesktopModels/Models.swift apps/macos/Packages/Shared/Models/Tests/HackDesktopModelsTests/LinearSyncUXModelTests.swift
 git commit -m "feat: repair local linear access from hack account state"
```

### Task 5: Deploy and verify live Linear reseeding

**Files:**
- Modify if needed: `services/auth-broker/README.md`
- Modify if needed: `services/auth-broker/.env.example`

**Step 1: Run focused verification**
Run:
```bash
bun test --cwd services/auth-broker tests/linear-callback-routes.test.ts tests/linear-token-custody.test.ts
bun test tests/linear-commands.test.ts
swift test --package-path apps/macos --filter LinearSyncUXModelTests
```
Expected: PASS

**Step 2: Run full verification gates**
Run:
```bash
bun run build
bun run typecheck
bun run test
bun run check
hack ps
swift build --package-path apps/macos
```
Expected: PASS

**Step 3: Deploy broker**
Deploy auth-broker to Railway and verify:
- callback still succeeds
- seed endpoint returns protected data only to signed-in owners
- a fresh Mac/local profile can import Linear access from an existing Hack-owned connection without reauthorizing Linear

**Step 4: Commit docs/config updates**
```bash
git add services/auth-broker/README.md services/auth-broker/.env.example docs/plans/2026-03-07-linear-local-access-seeding-design.md docs/plans/2026-03-07-linear-local-access-seeding-plan.md
 git commit -m "docs: capture linear local access seeding rollout"
```
