# Hack Account Auth and Provider UX Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an optional first-class Hack account/session layer across auth-broker, CLI, and macOS, while cleaning up provider/project UX and keeping local-only Hack usage unauthenticated.

**Architecture:** Extend `services/auth-broker` from raw Better Auth API transport into a minimal auth-shell-backed identity surface, then add explicit `hack auth` CLI commands and a new macOS Hack-account settings card above provider integrations. Keep provider integrations and Hack login methods separate, use verified-email-only account linking, and improve desktop project/provider forms without moving operational ticket sync out of `Tickets`.

**Tech Stack:** Bun, Elysia, Better Auth, Drizzle/Neon, TypeScript, SwiftUI, Hack CLI ticket/config/auth flows.

---

### Task 1: Document and tighten broker auth requirements

**Files:**
- Modify: `services/auth-broker/README.md`
- Modify: `docs/plans/2026-03-06-hack-account-auth-and-provider-ux-design.md`
- Test: `services/auth-broker/tests/index.test.ts`

**Step 1: Write the failing test**

Add a broker test that asserts the provider catalog and status routes distinguish Better Auth session mode from provider integrations clearly enough for desktop/CLI consumers.

**Step 2: Run test to verify it fails**

Run: `bun test --cwd services/auth-broker tests/index.test.ts`
Expected: FAIL once new auth-surface assertions are added.

**Step 3: Write minimal implementation**

Update broker metadata/docs so there is one explicit source of truth for:
- Better Auth session base path
- optional-login local-only policy
- protected broker-owned routes
- provider connection routes

**Step 4: Run test to verify it passes**

Run: `bun test --cwd services/auth-broker tests/index.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add services/auth-broker/README.md services/auth-broker/tests/index.test.ts docs/plans/2026-03-06-hack-account-auth-and-provider-ux-design.md
git commit -m "docs: clarify broker auth boundaries"
```

### Task 2: Add Better Auth provider-driven auth shell routing

**Files:**
- Create: `services/auth-broker/src/modules/auth-shell/plugin.ts`
- Create: `services/auth-broker/src/modules/auth-shell/service.ts`
- Modify: `services/auth-broker/src/app.ts`
- Modify: `services/auth-broker/src/better-auth.ts`
- Test: `services/auth-broker/tests/index.test.ts`

**Step 1: Write the failing test**

Add broker tests for:
- `GET /auth`
- `GET /auth/account`
- provider list rendering from configured Better Auth social providers
- signed-out vs signed-in account page behavior

**Step 2: Run test to verify it fails**

Run: `bun test --cwd services/auth-broker tests/index.test.ts`
Expected: FAIL with missing route assertions.

**Step 3: Write minimal implementation**

Add a small auth-shell plugin that:
- renders a minimal sign-in page
- renders a minimal account/session page
- reads Better Auth session state from request headers/cookies
- lists configured social providers without hardcoding Google

**Step 4: Run test to verify it passes**

Run: `bun test --cwd services/auth-broker tests/index.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add services/auth-broker/src/modules/auth-shell/plugin.ts services/auth-broker/src/modules/auth-shell/service.ts services/auth-broker/src/app.ts services/auth-broker/src/better-auth.ts services/auth-broker/tests/index.test.ts
git commit -m "feat: add minimal auth shell to broker"
```

### Task 3: Add verified-email account linking policy

**Files:**
- Modify: `services/auth-broker/src/better-auth.ts`
- Modify: `services/auth-broker/src/better-auth-link.ts`
- Test: `services/auth-broker/tests/better-auth-link.test.ts`
- Test: `services/auth-broker/tests/index.test.ts`

**Step 1: Write the failing test**

Add tests for:
- verified GitHub email linking to existing Better Auth user
- refusal to auto-link on missing email
- refusal to auto-link on unverified/mismatched email
- provider-driven linking configuration shape in Better Auth runtime

**Step 2: Run test to verify it fails**

Run: `bun test --cwd services/auth-broker tests/better-auth-link.test.ts tests/index.test.ts`
Expected: FAIL after adding new expectations.

**Step 3: Write minimal implementation**

Configure Better Auth account linking with strict verified-email behavior and keep provider-link resolution code aligned with that rule.

**Step 4: Run test to verify it passes**

Run: `bun test --cwd services/auth-broker tests/better-auth-link.test.ts tests/index.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add services/auth-broker/src/better-auth.ts services/auth-broker/src/better-auth-link.ts services/auth-broker/tests/better-auth-link.test.ts services/auth-broker/tests/index.test.ts
git commit -m "feat: tighten auth account linking policy"
```

### Task 4: Add CLI `hack auth` command surface

**Files:**
- Modify: `src/commands/*.ts` (exact auth command registration files after inspection)
- Modify: `src/control-plane/sdk/config.ts` if persistent auth bootstrap state is needed
- Test: `tests/*auth*.test.ts` (add new focused auth command tests)
- Docs: `docs/plans/2026-03-06-hack-account-auth-and-provider-ux-design.md`

**Step 1: Write the failing test**

Add CLI tests for:
- `hack auth status`
- `hack auth login`
- `hack auth logout`
- `hack auth whoami`
- auth-required broker commands returning actionable guidance

**Step 2: Run test to verify it fails**

Run: `bun test tests/*auth*.test.ts`
Expected: FAIL because the command group does not exist yet.

**Step 3: Write minimal implementation**

Implement the `hack auth` command group with browser-open login flow, session status output, sign-out, and compact whoami output.

**Step 4: Run test to verify it passes**

Run: `bun test tests/*auth*.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src tests
git commit -m "feat: add hack auth command group"
```

### Task 5: Make broker-protected provider commands guide sign-in

**Files:**
- Modify: `src/control-plane/extensions/linear/commands.ts`
- Modify: `src/control-plane/extensions/github/commands.ts` if broker-owned GitHub management is added in the same flow
- Test: `tests/linear-commands.test.ts`
- Test: `tests/github-commands.test.ts`

**Step 1: Write the failing test**

Add tests for unauthenticated broker-protected operations returning explicit auth guidance instead of opaque transport errors.

**Step 2: Run test to verify it fails**

Run: `bun test tests/linear-commands.test.ts tests/github-commands.test.ts`
Expected: FAIL after new expectations are added.

**Step 3: Write minimal implementation**

Map `better_auth_session_required` and related broker responses to user guidance such as:
- why auth is required
- `hack auth login`
- whether local-only fallback is still available

**Step 4: Run test to verify it passes**

Run: `bun test tests/linear-commands.test.ts tests/github-commands.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/control-plane/extensions tests
git commit -m "feat: improve auth-required broker command guidance"
```

### Task 6: Add macOS Hack account card above provider integrations

**Files:**
- Modify: `apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/SettingsOverlayView.swift`
- Modify: `apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/DashboardModel.swift`
- Modify: `apps/macos/Packages/Services/HackCLI/Sources/HackCLIService/HackCLIClient.swift`
- Modify: `apps/macos/Packages/Shared/Models/Sources/HackDesktopModels/Models.swift`
- Test: `apps/macos/Packages/...` focused model/view tests as needed

**Step 1: Write the failing test**

Add model tests for a Hack account state object that includes:
- signed-in flag
- user identity
- active org
- active team
- available remote features

**Step 2: Run test to verify it fails**

Run: `swift test --package-path apps/macos --filter HackAccount`
Expected: FAIL because the shared model and client methods do not exist yet.

**Step 3: Write minimal implementation**

Add a new top-level Hack account settings card and wire it to CLI/broker auth status methods.

**Step 4: Run test to verify it passes**

Run: `swift test --package-path apps/macos --filter HackAccount`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/macos
git commit -m "feat: add Hack account settings surface"
```

### Task 7: Clean up project/provider form UX in macOS

**Files:**
- Modify: `apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/ProjectDetailView.swift`
- Modify: `apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/SettingsOverlayView.swift`
- Modify: shared local view helpers if needed
- Test: `swift build --package-path apps/macos`

**Step 1: Write the failing test**

Where practical, add view-model or helper coverage for field group rendering decisions. If no meaningful unit test exists, record the visual acceptance targets in the plan comments and treat build + manual validation as the first executable check.

**Step 2: Run test/build to verify current gap**

Run: `swift build --package-path apps/macos`
Expected: PASS, but visual acceptance still fails against the design because forms are duplicated/unstyled.

**Step 3: Write minimal implementation**

Refactor project/provider forms to use:
- stacked field groups
- dedicated visible labels
- cleaner menu/input styling
- helper copy below controls
- no duplicate label text in the same row

**Step 4: Run validation**

Run:
- `swift build --package-path apps/macos`
- manual validation in the running desktop app
Expected: build PASS and visual acceptance improved.

**Step 5: Commit**

```bash
git add apps/macos
git commit -m "feat: polish desktop auth and settings forms"
```

### Task 8: Add Google social login support if env is present

**Files:**
- Modify: `services/auth-broker/src/better-auth.ts`
- Modify: `services/auth-broker/README.md`
- Test: `services/auth-broker/tests/index.test.ts`
- Test: `services/auth-broker/tests/config.test.ts`

**Step 1: Write the failing test**

Add tests that assert Google is exposed only when the corresponding env is configured.

**Step 2: Run test to verify it fails**

Run: `bun test --cwd services/auth-broker tests/index.test.ts tests/config.test.ts`
Expected: FAIL after new expectations are added.

**Step 3: Write minimal implementation**

Add Google Better Auth provider wiring behind env-driven configuration.

**Step 4: Run test to verify it passes**

Run: `bun test --cwd services/auth-broker tests/index.test.ts tests/config.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add services/auth-broker/src/better-auth.ts services/auth-broker/README.md services/auth-broker/tests/index.test.ts services/auth-broker/tests/config.test.ts
git commit -m "feat: add optional Google auth provider"
```

### Task 9: Update docs and operational guidance

**Files:**
- Modify: `services/auth-broker/README.md`
- Modify: `docs/plans/2026-03-06-hack-account-auth-and-provider-ux-design.md`
- Create/Modify: auth usage docs discovered during implementation

**Step 1: Write the failing doc check**

List the doc gaps explicitly in the PR/task notes before editing:
- login vs provider integration
- local-only vs remote/shared auth requirements
- provider-driven auth shell behavior
- Google optionality

**Step 2: Update docs minimally**

Document:
- Hack account/session model
- broker-required feature guidance
- provider integration ownership model
- sign-in methods

**Step 3: Run docs-adjacent verification**

Run targeted tests/builds already introduced for auth broker, CLI, and macOS.
Expected: PASS

**Step 4: Commit**

```bash
git add services/auth-broker/README.md docs/plans/2026-03-06-hack-account-auth-and-provider-ux-design.md
git commit -m "docs: add Hack account auth guidance"
```

### Task 10: Full verification gate

**Files:**
- No new files

**Step 1: Run required repo gates**

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

**Step 2: Run focused runtime checks**

Run:

```bash
curl -sS https://auth.hack.broker/health | jq .
curl -sS https://auth.hack.broker/v1/auth/better-auth/status | jq .
curl -sS https://auth.hack.broker/v1/auth/providers | jq .
```

Expected:
- health returns `ok: true`
- Better Auth status returns `enabled: true`
- provider catalog includes `better-auth` and configured social/provider entries

**Step 3: Manual validation**

Validate in Hack Desktop:
- Hack account card renders correctly
- signed-out state explains local-only vs shared features
- sign-in flow opens browser
- provider settings remain usable
- project settings fields are visually compact and no longer duplicate labels

**Step 4: Commit final integration pass**

```bash
git add .
git commit -m "feat: add Hack account auth surface and provider UX cleanup"
```
