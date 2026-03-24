# Env Portability And Secret Management Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deliver portable project env management as an explicit, auditable product made of immutable encrypted bundles, manual project-key sharing, safe rotation and recovery, and preserved local `.env` compatibility.

**Architecture:** Keep the current local env contract and local materialization model intact, then add an owner-scoped broker registry for immutable portable bundles plus separate key-share records. Use bundle keys for per-version encryption, a project key for access control and recovery, and visibility-first CLI/macOS UX so users can always tell contract, local materialization, and portable state apart.

**Tech Stack:** Bun, TypeScript, Hack CLI `env` commands, auth-broker, Better Auth ownership, Drizzle/Postgres, macOS SwiftUI follow-on UX, existing secret backend abstractions.

---

### Task 1: Lock current-state storage and trust-model UX

**Files:**

- Modify: `docs/env.md`
- Modify: `src/commands/env.ts`
- Modify: `src/lib/hack-env.ts`
- Test: `tests/env-command.test.ts` or the nearest existing env command test file after inspection

**Step 1: Write the failing test**

Add env command coverage for an explain/status surface that distinguishes:

- committed contract location
- local plaintext value location
- local secret backend location
- portable-state availability

**Step 2: Run test to verify it fails**

Run: `bun test tests/env-command.test.ts` Expected: FAIL because the env command output does not yet expose the full trust model.

**Step 3: Write minimal implementation**

Add a visibility-first env status/explain output so operators can see where each value lives and what trust boundary applies before any remote portability is enabled.

**Step 4: Run test to verify it passes**

Run: `bun test tests/env-command.test.ts` Expected: PASS

**Step 5: Commit**

```bash
git add docs/env.md src/commands/env.ts src/lib/hack-env.ts tests/env-command.test.ts
git commit -m "feat: explain env storage and trust boundaries"
```

### Task 2: Add portable bundle and binding schema

**Files:**

- Modify: `packages/db/src/schema/core.ts`
- Modify: `services/auth-broker/src/db/schema.ts`
- Create: `services/auth-broker/src/modules/project-envs/service.ts`
- Test: `services/auth-broker/tests/index.test.ts`
- Docs: `docs/plans/2026-03-06-remote-encrypted-project-env-portability-plan.md`

**Step 1: Write the failing test**

Add broker storage tests for:

- bundle create/list/read by owner scope
- immutable version supersede behavior
- project binding create/update/delete
- cross-owner access rejection

**Step 2: Run test to verify it fails**

Run: `bun test --cwd services/auth-broker tests/index.test.ts` Expected: FAIL with missing schema or storage behavior.

**Step 3: Write minimal implementation**

Implement the portable bundle registry so one project binding can own a sequence of immutable encrypted bundle versions.

**Step 4: Run test to verify it passes**

Run: `bun test --cwd services/auth-broker tests/index.test.ts` Expected: PASS

**Step 5: Commit**

```bash
git add packages/db/src/schema/core.ts services/auth-broker/src/db/schema.ts services/auth-broker/src/modules/project-envs/service.ts services/auth-broker/tests/index.test.ts docs/plans/2026-03-06-remote-encrypted-project-env-portability-plan.md
git commit -m "feat: add portable env bundle storage"
```

### Task 3: Add broker and CLI publish or pull or apply flows

**Files:**

- Create: `services/auth-broker/src/modules/project-envs/plugin.ts`
- Modify: `services/auth-broker/src/app.ts`
- Modify: `services/auth-broker/src/modules/better-auth/session.ts`
- Modify: `src/commands/env.ts`
- Modify: `src/mcp/server.ts`
- Test: `services/auth-broker/tests/index.test.ts`
- Test: `tests/env-command.test.ts`
- Test: `tests/mcp.test.ts`

**Step 1: Write the failing test**

Add coverage for:

- `hack env remote publish`
- `hack env remote list`
- `hack env remote pull`
- `hack env remote apply`
- `hack env remote bind`
- signed-out and cross-owner rejection cases

**Step 2: Run test to verify it fails**

Run: `bun test --cwd services/auth-broker tests/index.test.ts && bun test tests/env-command.test.ts tests/mcp.test.ts` Expected: FAIL with route-not-found or unknown-command errors.

**Step 3: Write minimal implementation**

Implement explicit operator-driven flows for publish, fetch, bind, and apply. Do not add background sync or remote-node fan-out in this slice.

**Step 4: Run test to verify it passes**

Run: `bun test --cwd services/auth-broker tests/index.test.ts && bun test tests/env-command.test.ts tests/mcp.test.ts` Expected: PASS

**Step 5: Commit**

```bash
git add services/auth-broker/src/modules/project-envs/plugin.ts services/auth-broker/src/app.ts services/auth-broker/src/modules/better-auth/session.ts src/commands/env.ts src/mcp/server.ts services/auth-broker/tests/index.test.ts tests/env-command.test.ts tests/mcp.test.ts
git commit -m "feat: add portable env publish and apply flows"
```

### Task 4: Add manual project-key sharing

**Files:**

- Modify: `packages/db/src/schema/core.ts`
- Modify: `services/auth-broker/src/db/schema.ts`
- Modify: `services/auth-broker/src/modules/project-envs/service.ts`
- Modify: `services/auth-broker/src/modules/project-envs/plugin.ts`
- Modify: `src/commands/env.ts`
- Test: `services/auth-broker/tests/index.test.ts`
- Test: `tests/env-command.test.ts`

**Step 1: Write the failing test**

Add coverage for:

- create key share for one recipient
- list active shares
- revoke share
- block access after revocation
- reject implicit org-wide sharing when no explicit share exists

**Step 2: Run test to verify it fails**

Run: `bun test --cwd services/auth-broker tests/index.test.ts && bun test tests/env-command.test.ts` Expected: FAIL because project-key share records do not exist yet.

**Step 3: Write minimal implementation**

Implement explicit key-share records and CLI flows such as:

- `hack env remote share`
- `hack env remote shares`
- `hack env remote revoke-share`

Keep the unit of sharing as the project key, not plaintext values.

**Step 4: Run test to verify it passes**

Run: `bun test --cwd services/auth-broker tests/index.test.ts && bun test tests/env-command.test.ts` Expected: PASS

**Step 5: Commit**

```bash
git add packages/db/src/schema/core.ts services/auth-broker/src/db/schema.ts services/auth-broker/src/modules/project-envs/service.ts services/auth-broker/src/modules/project-envs/plugin.ts src/commands/env.ts services/auth-broker/tests/index.test.ts tests/env-command.test.ts
git commit -m "feat: add manual project key sharing"
```

### Task 5: Add rotation and recovery safeguards

**Files:**

- Modify: `services/auth-broker/src/modules/project-envs/service.ts`
- Modify: `services/auth-broker/src/modules/project-envs/plugin.ts`
- Modify: `src/commands/env.ts`
- Modify: `src/lib/secret-store.ts`
- Test: `services/auth-broker/tests/index.test.ts`
- Test: `tests/env-command.test.ts`

**Step 1: Write the failing test**

Add coverage for:

- project-key rotation
- recovery package export metadata
- preventing deletion of the last recovery path
- preventing revocation of the last owner share without force
- lost-key recovery versus compromised-key rotation handling

**Step 2: Run test to verify it fails**

Run: `bun test --cwd services/auth-broker tests/index.test.ts && bun test tests/env-command.test.ts` Expected: FAIL because rotation and recovery guardrails are not yet implemented.

**Step 3: Write minimal implementation**

Implement separate commands for value rotation, share rotation, recovery/share repair, and project-key rotation, plus explicit recovery-path validation before destructive actions are allowed. Make the operator flow distinguish lost-key recovery/share reissue from compromised-key rotation.

**Step 4: Run test to verify it passes**

Run: `bun test --cwd services/auth-broker tests/index.test.ts && bun test tests/env-command.test.ts` Expected: PASS

**Step 5: Commit**

```bash
git add services/auth-broker/src/modules/project-envs/service.ts services/auth-broker/src/modules/project-envs/plugin.ts src/commands/env.ts src/lib/secret-store.ts services/auth-broker/tests/index.test.ts tests/env-command.test.ts
git commit -m "feat: add env key rotation and recovery safeguards"
```

### Task 6: Add `.env` compatibility and visibility-first desktop UX

**Files:**

- Modify: `src/commands/env.ts`
- Modify: `apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/ProjectDetailView.swift`
- Modify: `apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/SettingsOverlayView.swift`
- Modify: `apps/macos/Packages/Services/HackCLI/Sources/HackCLIService/HackCLIClient.swift`
- Modify: `apps/macos/Packages/Shared/Models/Sources/HackDesktopModels/Models.swift`
- Test: `tests/env-command.test.ts`
- Test: `apps/macos/Packages/Shared/Models/Tests/HackDesktopModelsTests/`

**Step 1: Write the failing test**

Add coverage for:

- apply writing `plain_env` entries into `.hack/.env`
- apply writing secret entries into the configured backend
- warnings when local backend differs from publish-time hint
- desktop visibility of contract, local materialization, and portable state

**Step 2: Run test to verify it fails**

Run: `bun test tests/env-command.test.ts && swift test --package-path apps/macos` Expected: FAIL with missing compatibility or model coverage.

**Step 3: Write minimal implementation**

Implement compatibility-first apply logic and visibility-first UI. Do not add inline plaintext editing in desktop for remote bundles.

**Step 4: Run test to verify it passes**

Run: `bun test tests/env-command.test.ts && swift test --package-path apps/macos` Expected: PASS

**Step 5: Commit**

```bash
git add src/commands/env.ts apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/ProjectDetailView.swift apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/SettingsOverlayView.swift apps/macos/Packages/Services/HackCLI/Sources/HackCLIService/HackCLIClient.swift apps/macos/Packages/Shared/Models/Sources/HackDesktopModels/Models.swift tests/env-command.test.ts apps/macos/Packages/Shared/Models/Tests/HackDesktopModelsTests
git commit -m "feat: preserve env compatibility in portable env UX"
```

## Recommended Execution Order

1. Ship Task 1 first so the current trust model is understandable before remote state expands.
2. Reuse the existing remote env portability work as the starting point for Tasks 2 and 3.
3. Keep key sharing separate from base bundle publication so the access model stays reviewable.
4. Land rotation and recovery only after the share model is in place.
5. Add desktop UX after the CLI and broker contracts stabilize.

## Follow-On Ticket Titles

- Clarify env storage and trust boundaries in CLI and docs
- Add portable env bundle registry and project binding
- Add portable env publish or pull or apply command flow
- Add manual project-key sharing and revocation
- Add env key rotation and recovery safeguards
- Add compatibility-first portable env desktop UX

## Links

- `docs/plans/2026-03-13-env-portability-and-secret-management-design.md`
- `docs/plans/2026-03-06-remote-encrypted-project-env-portability-plan.md`
- `docs/env.md`
