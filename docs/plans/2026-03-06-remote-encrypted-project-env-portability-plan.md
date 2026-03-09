# Remote Encrypted Project Env Portability Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an opt-in, Hack-account-owned remote encrypted project env bundle flow that makes project envs portable across machines without changing the current local-only env workflow.

**Architecture:** Keep `.hack/.env` and local secret storage as the default path. Add a broker-owned remote bundle registry that stores ciphertext, envelope metadata, ownership scope, and audit/version metadata, while leaving plaintext decrypt/apply in authenticated clients for the first implementation slice. Defer automatic remote-node hydration, multi-recipient sharing, and recovery/rotation UX to follow-on phases.

**Tech Stack:** Bun, Elysia auth-broker, Better Auth user/org/team ownership, Drizzle/Postgres broker tables, Hack CLI env commands, macOS Hack Desktop follow-on UX.

## Dependency on Hack Account Auth

This plan depends on the approved Hack account/auth redesign.

### Required auth assumptions

- Hack account auth is provided through the broker auth shell
- CLI/macOS can bootstrap a local broker management token through
  `GET /v1/auth/session/start`, `GET /v1/auth/session/flows/:flowId`, and
  `GET /v1/auth/me`
- remote resources are owned by Hack user/org/team scope, not by provider identity
- provider connections such as Linear remain separate resources under that Hack account

### Boundary with provider auth

Remote encrypted env portability must not be modeled as:

- a GitHub integration feature
- a Linear integration feature
- a keychain-export convenience layer for provider tokens

It is a Hack-account-owned remote secret portability feature with its own
authorization and audit boundary.

---

## Scope Boundary

### In scope for the next implementation slice

- opt-in remote encrypted env bundles per Hack project
- ownership under Hack user/org/team scope
- ciphertext + metadata storage in `auth-broker`
- CLI publish, list, fetch, and apply flows
- explicit project binding between local Hack project and remote env bundle
- audit-friendly version metadata and last-writer identity

### Explicitly out of scope for the current implementation pass

- any implementation work in the current provider/auth slice
- automatic remote-node hydration
- automatic broker-side plaintext decryption and fan-out
- secrets sharing UX between multiple humans or teams
- key recovery, emergency escrow, or full rotation UX
- provider-token portability or keychain migration

## Design Summary

### Product rule

- local-only env stays local by default
- remote portability is opt-in per project
- remote env state is owned by a Hack account scope, not by a provider profile
- broker stores encrypted payloads and metadata, not editable plaintext
- local provider auth remains separate and is not made portable by this plan

### Ownership model

Every remote env bundle must be owned by exactly one Hack scope:

- user-owned
- organization-owned
- team-owned

The ownership scope must follow the active Better Auth context already used for Linear connections and subscriptions. A local project may bind to one default remote env bundle and may later support explicit additional named bundles, but the next slice should ship only a single default bundle binding per project.

### Storage model

Persist one logical bundle per project binding, with append-only versions.

Recommended fields:

- `id`
- `owner_type` and `owner_id`
- `project_binding_key`
- `project_name`
- `project_path_hint` nullable
- `environment_name` default `default`
- `ciphertext_blob`
- `ciphertext_digest`
- `encryption_scheme_version`
- `wrapped_data_key`
- `data_key_wrap_method`
- `created_by_user_id`
- `created_at`
- `supersedes_version_id` nullable
- `status` active | superseded | revoked

The broker should treat versions as immutable records. “Updating” a portable env means writing a new version row and marking the older one superseded.

### Encryption model

Use envelope encryption.

1. Client generates a random data-encryption key per bundle version.
2. Client encrypts the normalized env payload locally.
3. Client sends ciphertext plus a wrapped copy of the data key.
4. Broker stores ciphertext, wrapped key, and metadata.

For the first slice, choose one wrap path and keep it simple:

- preferred: broker-managed account-scope wrapping key material, exposed only through authenticated broker routes
- acceptable fallback: locally derived wrap key anchored to existing Hack secret storage plus explicit export/import support

The critical design constraint is that the broker remains the durable registry for the encrypted payload and ownership metadata. The first slice should not require a single machine-local keychain to remain the only recovery path.

### Local vs remote secret boundary

Keep the plaintext boundary narrow:

- local client may read and decrypt plaintext during explicit publish/apply
- broker stores ciphertext, wrapped-key material, and metadata
- remote portability does not imply remote plaintext editing in the broker
- remote portability does not imply migration of provider OAuth tokens

### Apply model

The first implementation slice should use client-mediated apply:

- authenticated client fetches the encrypted bundle
- authenticated client unwraps or requests unwrap
- client writes the resolved env material to the local project env destination
- local runtime reload remains an explicit operator action

Do not add background env sync to nodes in this slice.

### Project binding model

Each local Hack project needs a stable portable-env binding record.

Required binding fields:

- `hack_project_id`
- `hack_project_name`
- `owner_scope`
- `remote_env_bundle_id` or `project_binding_key`
- `last_applied_version_id`
- `last_applied_at`

Binding should be set explicitly, not inferred from directory names alone.

### Conflict model

Remote env portability should not attempt field-level merges.

Rules:

- payload versions are immutable snapshots
- publish creates a new remote version
- apply pulls a specific remote version into the local project
- if local material has changed since the last apply/publish checkpoint, warn and require confirmation

This keeps the first slice operationally predictable and avoids partial secret merges.

### Audit model

The registry should be auditable from day one.

Track:

- owner scope
- actor user id
- version lineage
- ciphertext digest
- created/appplied timestamps
- client host label or device label when available

## Trust Boundaries

### Local machine

Trusted to:

- read plaintext env material
- create normalized payloads
- decrypt/apply payloads
- cache temporary plaintext during an explicit operator action

### Auth broker

Trusted to:

- enforce ownership and authorization
- store encrypted payloads and version metadata
- issue short-lived access to wrapped material
- record audit history

Broker should not become a general plaintext env editor in the first slice.

### Remote nodes

Not trusted in the first slice with persistent remote-secret authority.

Remote-node hydration is a follow-on phase once ownership, audit, and revoke semantics are proven with manual client-mediated flows.

## Implementation Phases

### Phase 0: design and ownership contract

Completed by this plan ticket.

Deliverables:

- ownership model
- storage model
- encryption boundary
- phased rollout plan

### Phase 1: default remote bundle registry and CLI flow

This is the next actionable implementation slice.

Deliverables:

- broker schema for remote env bundles and project bindings
- broker routes to create/list/get/supersede bundle versions
- CLI commands to publish/fetch/apply/list bindings
- explicit auth gating through Better Auth ownership
- local project command to bind/unbind a default remote env bundle

### Phase 2: remote node hydration

Follow-on.

Deliverables:

- short-lived hydration grants
- explicit node-targeted apply flow
- audit trail for which node received which version
- revoke/expiry semantics

### Phase 3: rotation, recovery, and sharing UX

Follow-on.

Deliverables:

- key rotation flow
- recovery/re-wrap flow
- multi-user/team collaboration UX
- macOS account/project settings UI for bundle state

## Task Plan For Phase 1

### Task 1: Add broker schema for portable env bundles

**Files:**
- Modify: `packages/db/src/schema/core.ts`
- Modify: `services/auth-broker/src/db/schema.ts`
- Create: `services/auth-broker/src/modules/project-envs/service.ts`
- Test: `services/auth-broker/tests/index.test.ts`

**Step 1: Write failing broker storage tests**

Cover:

- owner-scoped bundle create/list
- immutable version supersede behavior
- project binding read/write
- cross-owner access rejection

**Step 2: Run focused broker tests and confirm failure**

Run: `bun test --cwd services/auth-broker tests/index.test.ts`
Expected: missing schema/service failures for portable env routes or storage.

**Step 3: Implement schema and service storage**

Add bundle version rows plus a small binding table or equivalent binding fields.

**Step 4: Re-run focused broker tests**

Run: `bun test --cwd services/auth-broker tests/index.test.ts`
Expected: PASS for new portable env storage coverage.

**Step 5: Commit**

```bash
git add packages/db/src/schema/core.ts services/auth-broker/src/db/schema.ts services/auth-broker/src/modules/project-envs/service.ts services/auth-broker/tests/index.test.ts
git commit -m "Add project env bundle storage"
```

### Task 2: Add broker routes with Better Auth ownership enforcement

**Files:**
- Create: `services/auth-broker/src/modules/project-envs/plugin.ts`
- Modify: `services/auth-broker/src/app.ts`
- Modify: `services/auth-broker/src/modules/better-auth/session.ts`
- Test: `services/auth-broker/tests/index.test.ts`

**Step 1: Write failing route tests**

Cover:

- signed-out rejection
- user/org/team-owned access
- management-token access for the bound profile/project context
- immutable version creation and binding updates

**Step 2: Run focused broker tests and confirm failure**

Run: `bun test --cwd services/auth-broker tests/index.test.ts`
Expected: route-not-found or auth failures.

**Step 3: Implement minimal broker routes**

Routes should support:

- list bundles
- publish new version
- get version metadata
- fetch encrypted payload
- bind/unbind default project bundle

**Step 4: Re-run focused broker tests**

Run: `bun test --cwd services/auth-broker tests/index.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add services/auth-broker/src/modules/project-envs/plugin.ts services/auth-broker/src/app.ts services/auth-broker/src/modules/better-auth/session.ts services/auth-broker/tests/index.test.ts
git commit -m "Add broker-owned project env routes"
```

### Task 3: Add CLI publish/fetch/apply commands

**Files:**
- Modify: `src/commands/env.ts`
- Modify: `src/mcp/server.ts`
- Test: `tests/env-backend-command.test.ts`
- Test: `tests/mcp.test.ts`

**Step 1: Write failing CLI tests**

Cover:

- `hack env remote publish`
- `hack env remote pull`
- `hack env remote apply`
- `hack env remote bind`
- MCP forwarding for bind/list/apply flows

**Step 2: Run focused CLI tests and confirm failure**

Run: `bun test tests/env-backend-command.test.ts tests/mcp.test.ts`
Expected: unknown command or missing route failures.

**Step 3: Implement the minimal CLI surface**

Prefer explicit, operator-driven verbs. Avoid hidden sync.

**Step 4: Re-run focused CLI tests**

Run: `bun test tests/env-backend-command.test.ts tests/mcp.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/commands/env.ts src/mcp/server.ts tests/env-backend-command.test.ts tests/mcp.test.ts
git commit -m "Add remote project env CLI commands"
```

### Task 4: Add project binding visibility in desktop follow-on UX

**Files:**
- Modify: `apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/ProjectDetailView.swift`
- Modify: `apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/SettingsOverlayView.swift`
- Modify: `apps/macos/Packages/Services/HackCLI/Sources/HackCLIService/HackCLIClient.swift`
- Modify: `apps/macos/Packages/Shared/Models/Sources/HackDesktopModels/Models.swift`
- Test: `apps/macos/Packages/Shared/Models/Tests/HackDesktopModelsTests/`

**Step 1: Write failing model/UI tests where practical**

Cover:

- current binding summary
- last applied version metadata
- auth-required state
- explicit publish/apply actions with confirmation

**Step 2: Run focused macOS tests and confirm failure**

Run: `swift test --package-path apps/macos`
Expected: missing model or command wiring coverage.

**Step 3: Implement a minimal visibility-first UI**

Do not add inline plaintext editing. Show binding state and explicit operator actions only.

**Step 4: Re-run focused macOS tests/build**

Run: `swift test --package-path apps/macos && swift build --package-path apps/macos`
Expected: PASS.

**Step 5: Commit**

```bash
git add apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/ProjectDetailView.swift apps/macos/Packages/Features/DashboardFeature/Sources/DashboardFeature/SettingsOverlayView.swift apps/macos/Packages/Services/HackCLI/Sources/HackCLIService/HackCLIClient.swift apps/macos/Packages/Shared/Models/Sources/HackDesktopModels/Models.swift apps/macos/Packages/Shared/Models/Tests/HackDesktopModelsTests
git commit -m "Show portable env binding state in desktop"
```

## Open Questions

- Should Phase 1 use a broker-managed wrapping key or a client-exported recovery key package?
- Do we want exactly one portable bundle per project at first, or one default plus named bundles like `staging` and `prod`?
- Should bundle ownership be project-bound only, or can an org bind the same bundle to multiple projects intentionally?
- How should local dirty-state detection work before publish/apply: digest of normalized env payload, file mtime, or both?
- What is the shortest acceptable audit retention window?

## Recommended Execution Order

1. Ship Phase 1 CLI + broker path first.
2. Keep remote-node hydration out until ownership/audit semantics are proven.
3. Add desktop UX only after the command and route contract are stable.
4. File follow-on tickets for hydration and recovery instead of stretching Phase 1.

## Links

- `docs/plans/2026-03-06-hack-account-auth-and-provider-ux-design.md`
- `docs/plans/2026-03-06-hack-account-auth-and-provider-ux-plan.md`
- `T-00194`
