# Linear Browser Handoff And Connection Repair Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Unify Linear OAuth with the GitHub browser handoff contract, eliminate raw callback failures, and make desktop/CLI show a simple connected-or-not-connected state with repair paths.

**Architecture:** Keep the current broker-owned remote connection plus local claimed token model, but make the browser callback authoritative for success and failure. Linear start and callback should carry desktop redirect context, persist remote connection state before flow completion, and always render a Hack-branded completion or error page instead of leaking infrastructure errors.

**Tech Stack:** Bun, Elysia, Better Auth, macOS SwiftUI, Hack CLI, Railway

---

### Task 1: Capture current Linear callback behavior with failing broker tests

**Files:**
- Modify: `services/auth-broker/tests/index.test.ts`
- Modify: `services/auth-broker/tests/session-auth.test.ts`
- Create: `services/auth-broker/tests/linear-callback-routes.test.ts`

**Step 1: Write the failing test**

Add focused tests for:
- successful `GET /linear/callback` with a valid mocked flow returns Hack-branded HTML and `200`
- callback exception returns Hack-branded HTML and non-`502` host-safe error page
- callback with desktop redirect context includes `Open Hack`

**Step 2: Run test to verify it fails**

Run:
```bash
bun test --cwd services/auth-broker tests/linear-callback-routes.test.ts
```

Expected: FAIL because current Linear callback does not yet share the GitHub callback contract or hard failure boundary.

**Step 3: Write minimal implementation**

Touch only the Linear callback route and service until the test targets exist.

**Step 4: Run test to verify it passes**

Run:
```bash
bun test --cwd services/auth-broker tests/linear-callback-routes.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add services/auth-broker/tests/index.test.ts services/auth-broker/tests/session-auth.test.ts services/auth-broker/tests/linear-callback-routes.test.ts services/auth-broker/src/modules/linear-oauth/service.ts services/auth-broker/src/modules/linear-oauth/callback-routes-plugin.ts services/auth-broker/src/linear.ts services/auth-broker/src/flow-store.ts services/auth-broker/src/types.ts
git commit -m "test: cover linear callback handoff contract"
```

### Task 2: Make Linear start flow carry desktop redirect context like GitHub

**Files:**
- Modify: `services/auth-broker/src/modules/linear-oauth/model.ts`
- Modify: `services/auth-broker/src/modules/linear-oauth/service.ts`
- Modify: `services/auth-broker/src/flow-store.ts`
- Modify: `services/auth-broker/src/types.ts`
- Test: `services/auth-broker/tests/linear-callback-routes.test.ts`

**Step 1: Write the failing test**

Add a test that starts a Linear flow with a desktop redirect URL and verifies the persisted flow stores it.

**Step 2: Run test to verify it fails**

Run:
```bash
bun test --cwd services/auth-broker tests/linear-callback-routes.test.ts
```

Expected: FAIL because Linear start query/model does not yet mirror GitHub desktop redirect handling.

**Step 3: Write minimal implementation**

- Accept `desktopRedirectUrl` in Linear start query
- Normalize it using the same `hack:` / `hack-dev:` rules as GitHub
- Persist it on the flow

**Step 4: Run test to verify it passes**

Run:
```bash
bun test --cwd services/auth-broker tests/linear-callback-routes.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add services/auth-broker/src/modules/linear-oauth/model.ts services/auth-broker/src/modules/linear-oauth/service.ts services/auth-broker/src/flow-store.ts services/auth-broker/src/types.ts services/auth-broker/tests/linear-callback-routes.test.ts
git commit -m "feat: add desktop redirect support to linear oauth flows"
```

### Task 3: Unify Linear callback completion page and hard error handling

**Files:**
- Modify: `services/auth-broker/src/modules/linear-oauth/service.ts`
- Modify: `services/auth-broker/src/modules/better-auth/shell-plugin.ts` (only if shared rendering helpers are needed)
- Test: `services/auth-broker/tests/linear-callback-routes.test.ts`

**Step 1: Write the failing test**

Add tests for:
- `Open Hack` action present on successful Linear callback when desktop redirect exists
- provider and unexpected failures render Hack HTML pages instead of raw host failures

**Step 2: Run test to verify it fails**

Run:
```bash
bun test --cwd services/auth-broker tests/linear-callback-routes.test.ts
```

Expected: FAIL

**Step 3: Write minimal implementation**

- Add top-level try/catch around Linear callback processing
- Reuse GitHub-style deep-link building semantics for `Open Hack`
- Replace old bespoke callback HTML with the same dark minimal callback language used elsewhere

**Step 4: Run test to verify it passes**

Run:
```bash
bun test --cwd services/auth-broker tests/linear-callback-routes.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add services/auth-broker/src/modules/linear-oauth/service.ts services/auth-broker/src/modules/better-auth/shell-plugin.ts services/auth-broker/tests/linear-callback-routes.test.ts
git commit -m "feat: unify linear callback browser handoff"
```

### Task 4: Persist remote Linear connection before reporting completion

**Files:**
- Modify: `services/auth-broker/src/modules/linear-oauth/service.ts`
- Modify: `services/auth-broker/src/modules/linear-connections/service.ts`
- Test: `services/auth-broker/tests/linear-store-schema.test.ts`
- Test: `services/auth-broker/tests/linear-callback-routes.test.ts`

**Step 1: Write the failing test**

Add a test that verifies successful callback writes a connection row and only then exposes completed flow state.

**Step 2: Run test to verify it fails**

Run:
```bash
bun test --cwd services/auth-broker tests/linear-callback-routes.test.ts tests/linear-store-schema.test.ts
```

Expected: FAIL

**Step 3: Write minimal implementation**

Ensure the callback path persists or updates the connection row before final completion response generation, while still handling persistence failure as a Hack-rendered flow error instead of a host crash.

**Step 4: Run test to verify it passes**

Run:
```bash
bun test --cwd services/auth-broker tests/linear-callback-routes.test.ts tests/linear-store-schema.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add services/auth-broker/src/modules/linear-oauth/service.ts services/auth-broker/src/modules/linear-connections/service.ts services/auth-broker/tests/linear-callback-routes.test.ts services/auth-broker/tests/linear-store-schema.test.ts
git commit -m "feat: persist linear connections during callback completion"
```

### Task 5: Make CLI Linear flow use the unified desktop redirect contract

**Files:**
- Modify: `src/control-plane/extensions/linear/commands.ts`
- Modify: `src/control-plane/extensions/linear/auth.ts`
- Test: `tests/linear-commands.test.ts`

**Step 1: Write the failing test**

Add a test that `hack x linear oauth-connect --json` includes or forwards the desktop redirect context expected by the new broker contract.

**Step 2: Run test to verify it fails**

Run:
```bash
bun test tests/linear-commands.test.ts
```

Expected: FAIL

**Step 3: Write minimal implementation**

Update the CLI Linear auth path to pass the desktop redirect URL consistently and preserve current poll-and-claim semantics.

**Step 4: Run test to verify it passes**

Run:
```bash
bun test tests/linear-commands.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/control-plane/extensions/linear/commands.ts src/control-plane/extensions/linear/auth.ts tests/linear-commands.test.ts
git commit -m "feat: align linear cli flow with browser handoff contract"
```

### Task 6: Make macOS Linear settings stop hanging on stale browser state

**Files:**
- Modify: `apps/macos/Packages/Services/HackCLI/Sources/HackCLIService/HackCLIClient.swift`
- Modify: `apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/DashboardModel.swift`
- Modify: `apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/SettingsOverlayView.swift`
- Modify: `apps/macos/Packages/Shared/Models/Sources/HackDesktopModels/Models.swift`
- Test: `apps/macos/Packages/Shared/Models/Tests/HackDesktopModelsTests/LinearSyncUXModelTests.swift`

**Step 1: Write the failing test**

Add or extend a test for Linear auth status mapping so `error`, `expired`, and `complete` broker statuses stop rendering as indefinite `Waiting for browser auth`.

**Step 2: Run test to verify it fails**

Run:
```bash
swift test --package-path apps/macos --filter LinearSyncUXModelTests
```

Expected: FAIL

**Step 3: Write minimal implementation**

- Map broker flow states to compact user-facing states
- Default UI remains binary and calm
- Only repair states expose extra detail such as `Reconnect to repair local access`

**Step 4: Run test to verify it passes**

Run:
```bash
swift test --package-path apps/macos --filter LinearSyncUXModelTests
```

Expected: PASS

**Step 5: Commit**

```bash
git add apps/macos/Packages/Services/HackCLI/Sources/HackCLIService/HackCLIClient.swift apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/DashboardModel.swift apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/SettingsOverlayView.swift apps/macos/Packages/Shared/Models/Sources/HackDesktopModels/Models.swift apps/macos/Packages/Shared/Models/Tests/HackDesktopModelsTests/LinearSyncUXModelTests.swift
git commit -m "feat: simplify linear desktop connection state"
```

### Task 7: Polish the Linear account page and callback shell to stay minimal

**Files:**
- Modify: `services/auth-broker/src/modules/better-auth/shell-plugin.ts`
- Modify: `services/auth-broker/src/modules/linear-oauth/service.ts`
- Modify: `apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/SettingsOverlayView.swift`

**Step 1: Write the failing test**

Add or update HTML snapshot assertions for the Linear callback page so it uses the same dark minimal shell style as Hack/GitHub auth pages.

**Step 2: Run test to verify it fails**

Run:
```bash
bun test --cwd services/auth-broker tests/linear-callback-routes.test.ts tests/index.test.ts
```

Expected: FAIL

**Step 3: Write minimal implementation**

- Remove leftover Linear-specific bubbly/legacy completion UI
- Keep one compact action and one terse status line
- Remove passive explanatory clutter from desktop Linear settings where the new flow state makes it unnecessary

**Step 4: Run test to verify it passes**

Run:
```bash
bun test --cwd services/auth-broker tests/linear-callback-routes.test.ts tests/index.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add services/auth-broker/src/modules/better-auth/shell-plugin.ts services/auth-broker/src/modules/linear-oauth/service.ts apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/SettingsOverlayView.swift services/auth-broker/tests/linear-callback-routes.test.ts services/auth-broker/tests/index.test.ts
git commit -m "style: unify linear auth and connection ui"
```

### Task 8: Run full verification and deploy broker

**Files:**
- Modify: `services/auth-broker/README.md` (if callback behavior or repair guidance changed)
- Modify: `docs/plans/2026-03-07-linear-browser-handoff-and-connection-repair-design.md` (only if implementation changed design assumptions)

**Step 1: Run focused broker tests**

Run:
```bash
bun test --cwd services/auth-broker tests/linear-callback-routes.test.ts tests/index.test.ts tests/linear-store-schema.test.ts tests/session-auth.test.ts
```

Expected: PASS

**Step 2: Run desktop and CLI focused tests**

Run:
```bash
bun test tests/linear-commands.test.ts
swift test --package-path apps/macos --filter LinearSyncUXModelTests
```

Expected: PASS

**Step 3: Run repo verification gates**

Run:
```bash
bun run build
bun run typecheck
bun run test
bun run check
hack ps
```

Expected: PASS, with only pre-existing legacy complexity warnings if any

**Step 4: Deploy auth-broker and run live smoke checks**

Run:
```bash
railway up --service auth-broker
curl -sS https://auth.hack.broker/health | jq .
curl -i -sS https://auth.hack.broker/auth | sed -n '1,40p'
```

Expected:
- Railway deploy succeeds
- `/health` returns `ok`
- Linear callback and auth shell return Hack-branded pages, not host 502s

**Step 5: Commit**

```bash
git add services/auth-broker/README.md docs/plans/2026-03-07-linear-browser-handoff-and-connection-repair-design.md
git commit -m "docs: document unified linear browser handoff"
```
