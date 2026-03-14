# Linear Project Artifacts Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Hack-managed Linear project documents, milestones, and status updates with repo-backed artifacts and explicit CLI pull/plan/apply workflows.

**Architecture:** Extend the existing Linear extension in three layers: GraphQL client support for project artifact operations, a repo-backed artifact file model under `.hack/linear/projects/<project-id>/`, and three new CLI noun families (`documents`, `milestones`, `status-updates`) that share routing and diff semantics. Keep the feature manual-first: outbound writes happen only through explicit `apply` or `publish` commands.

**Tech Stack:** Bun, TypeScript, existing Linear extension/client code, Bun test, Markdown + YAML frontmatter parsing, current display helpers.

---

### Task 1: Add failing Linear client tests for project artifact queries and mutations

**Files:**
- Modify: `tests/linear-client.test.ts`
- Modify: `src/control-plane/extensions/linear/client.ts`

**Step 1: Write the failing tests**

Add focused tests for:
- listing project documents
- creating/updating a project document
- listing project milestones
- creating/updating a milestone
- listing project status updates
- creating a status update

Model them after the existing issue/project tests so they assert:
- GraphQL operation names
- key variables
- parsed response shape

**Step 2: Run test to verify it fails**

Run:

```bash
bun test tests/linear-client.test.ts
```

Expected: FAIL because the client does not expose these project artifact methods yet.

**Step 3: Write minimal implementation**

Extend `src/control-plane/extensions/linear/client.ts` with:
- new types for project document, milestone, and status update payloads
- request helpers for list/create/update operations
- parsing helpers that normalize the GraphQL payload into small stable TS types

Do not add CLI logic in this task.

**Step 4: Run test to verify it passes**

Run:

```bash
bun test tests/linear-client.test.ts
```

Expected: PASS for the new client coverage.

**Step 5: Commit**

```bash
git add tests/linear-client.test.ts src/control-plane/extensions/linear/client.ts
git commit -m "feat: add linear project artifact client support"
```

### Task 2: Add failing tests for local artifact file parsing and materialization

**Files:**
- Create: `tests/linear-project-artifacts.test.ts`
- Create: `src/control-plane/extensions/linear/project-artifacts.ts`

**Step 1: Write the failing tests**

Cover:
- parsing Markdown + YAML frontmatter for documents
- parsing milestones with structured fields
- parsing status update drafts
- resolving project artifact root from bound project id
- detecting duplicate remote IDs or duplicate local slugs
- planning create/update/noop sets from local + remote inputs

**Step 2: Run test to verify it fails**

Run:

```bash
bun test tests/linear-project-artifacts.test.ts
```

Expected: FAIL because the artifact parser/planner module does not exist yet.

**Step 3: Write minimal implementation**

Create `src/control-plane/extensions/linear/project-artifacts.ts` with:
- TS types for local artifact records
- frontmatter parsing/serialization helpers
- repo path resolution helpers
- reconciliation helpers for `pull` and `plan`

Keep remote API calls out of this module.

**Step 4: Run test to verify it passes**

Run:

```bash
bun test tests/linear-project-artifacts.test.ts
```

Expected: PASS for parser/planner coverage.

**Step 5: Commit**

```bash
git add tests/linear-project-artifacts.test.ts src/control-plane/extensions/linear/project-artifacts.ts
git commit -m "feat: add linear project artifact file model"
```

### Task 3: Add failing command-parser tests for the new Linear noun families

**Files:**
- Modify: `tests/linear-commands.test.ts`
- Modify: `src/control-plane/extensions/linear/commands.ts`

**Step 1: Write the failing tests**

Add parser tests for:
- `documents list|pull|plan|apply`
- `milestones list|pull|plan|apply`
- `status-updates list|pull|plan|publish`

Assert:
- verb parsing
- shared routing flags
- path handling
- `--json`
- invalid verbs error clearly

**Step 2: Run test to verify it fails**

Run:

```bash
bun test tests/linear-commands.test.ts
```

Expected: FAIL because the new parser helpers and command registrations are missing.

**Step 3: Write minimal implementation**

In `src/control-plane/extensions/linear/commands.ts`:
- register new commands named `documents`, `milestones`, and `status-updates`
- add shared parser helpers for verb-driven command families
- wire handlers to existing profile/project binding resolution

Keep handlers thin; they should delegate planning/file logic to `project-artifacts.ts`.

**Step 4: Run test to verify it passes**

Run:

```bash
bun test tests/linear-commands.test.ts
```

Expected: PASS for parser coverage without full remote mutation behavior yet.

**Step 5: Commit**

```bash
git add tests/linear-commands.test.ts src/control-plane/extensions/linear/commands.ts
git commit -m "feat: add linear project artifact command families"
```

### Task 4: Implement `list` and `pull` end to end

**Files:**
- Modify: `src/control-plane/extensions/linear/commands.ts`
- Modify: `src/control-plane/extensions/linear/project-artifacts.ts`
- Modify: `tests/linear-commands.test.ts`
- Modify: `tests/linear-client.test.ts`
- Modify: `tests/mcp.test.ts`

**Step 1: Write the failing tests**

Add command-level tests for:
- listing remote documents/milestones/status updates
- pulling them into the repo artifact tree
- preserving remote IDs in frontmatter
- honoring project binding defaults

**Step 2: Run test to verify it fails**

Run:

```bash
bun test tests/linear-commands.test.ts tests/mcp.test.ts
```

Expected: FAIL because handlers do not yet perform end-to-end listing or file writes.

**Step 3: Write minimal implementation**

Implement:
- remote fetch via the new client methods
- local file writes through the artifact helpers
- stable `--json` payloads for machine consumers
- MCP registrations for any new CLI command IDs exposed through the existing bridge

**Step 4: Run test to verify it passes**

Run:

```bash
bun test tests/linear-commands.test.ts tests/mcp.test.ts
```

Expected: PASS for `list` and `pull`.

**Step 5: Commit**

```bash
git add src/control-plane/extensions/linear/commands.ts src/control-plane/extensions/linear/project-artifacts.ts tests/linear-commands.test.ts tests/linear-client.test.ts tests/mcp.test.ts
git commit -m "feat: pull linear project artifacts into repo state"
```

### Task 5: Implement `plan`

**Files:**
- Modify: `src/control-plane/extensions/linear/project-artifacts.ts`
- Modify: `src/control-plane/extensions/linear/commands.ts`
- Modify: `tests/linear-project-artifacts.test.ts`
- Modify: `tests/linear-commands.test.ts`

**Step 1: Write the failing tests**

Add plan tests for:
- local create vs remote missing
- local update vs remote drift
- remote-only artifacts reported without mutation
- duplicate mapping errors
- immutable published status update handling

**Step 2: Run test to verify it fails**

Run:

```bash
bun test tests/linear-project-artifacts.test.ts tests/linear-commands.test.ts
```

Expected: FAIL because the planner does not yet compute a complete action set.

**Step 3: Write minimal implementation**

Implement a planner that returns:
- `creates`
- `updates`
- `noops`
- `remoteOnly`
- `conflicts`

Render human output with existing `display.table` / `display.kv` helpers and structured JSON for machine use.

**Step 4: Run test to verify it passes**

Run:

```bash
bun test tests/linear-project-artifacts.test.ts tests/linear-commands.test.ts
```

Expected: PASS for non-mutating plan behavior.

**Step 5: Commit**

```bash
git add src/control-plane/extensions/linear/project-artifacts.ts src/control-plane/extensions/linear/commands.ts tests/linear-project-artifacts.test.ts tests/linear-commands.test.ts
git commit -m "feat: plan linear project artifact changes"
```

### Task 6: Implement document/milestone `apply` and status update `publish`

**Files:**
- Modify: `src/control-plane/extensions/linear/client.ts`
- Modify: `src/control-plane/extensions/linear/project-artifacts.ts`
- Modify: `src/control-plane/extensions/linear/commands.ts`
- Modify: `tests/linear-client.test.ts`
- Modify: `tests/linear-commands.test.ts`
- Modify: `tests/linear-project-artifacts.test.ts`

**Step 1: Write the failing tests**

Cover:
- applying a new document writes back `linearId`
- applying an updated milestone preserves file path/slug
- publishing a draft status update moves it to `published/`
- already-published status updates are rejected unless explicit repair mode exists

**Step 2: Run test to verify it fails**

Run:

```bash
bun test tests/linear-client.test.ts tests/linear-commands.test.ts tests/linear-project-artifacts.test.ts
```

Expected: FAIL because mutation handlers and post-success file rewrites are incomplete.

**Step 3: Write minimal implementation**

Implement:
- document create/update
- milestone create/update
- status update publish
- safe local file rewrites only after confirmed remote success

Do not add delete/prune in this task.

**Step 4: Run test to verify it passes**

Run:

```bash
bun test tests/linear-client.test.ts tests/linear-commands.test.ts tests/linear-project-artifacts.test.ts
```

Expected: PASS for explicit apply/publish flows.

**Step 5: Commit**

```bash
git add src/control-plane/extensions/linear/client.ts src/control-plane/extensions/linear/project-artifacts.ts src/control-plane/extensions/linear/commands.ts tests/linear-client.test.ts tests/linear-commands.test.ts tests/linear-project-artifacts.test.ts
git commit -m "feat: apply managed linear project artifacts"
```

### Task 7: Update command help and docs after behavior is live

**Files:**
- Modify: `src/commands/linear.ts`
- Modify: `src/control-plane/extensions/linear/extension.ts`
- Modify: `docs/cli.md`
- Modify: `docs/extensions.md`
- Modify: `docs/guides/linear-integration-architecture.md`

**Step 1: Write the failing test**

Add or extend a CLI/help test that asserts `hack linear` help includes the new command families once implemented.

**Step 2: Run test to verify it fails**

Run:

```bash
bun test tests/linear-command-alias.test.ts
```

Expected: FAIL because help/docs do not mention the new project artifact commands yet.

**Step 3: Write minimal implementation**

Update summaries and examples so Linear is described as:
- account connection
- ticket sync
- project planning artifacts

Cross-link the architecture guide and extension docs to the repo-backed artifact model.

**Step 4: Run test to verify it passes**

Run:

```bash
bun test tests/linear-command-alias.test.ts
```

Expected: PASS for help coverage.

**Step 5: Commit**

```bash
git add src/commands/linear.ts src/control-plane/extensions/linear/extension.ts docs/cli.md docs/extensions.md docs/guides/linear-integration-architecture.md tests/linear-command-alias.test.ts
git commit -m "docs: document linear project artifact workflows"
```

### Task 8: Run final quality gates

**Files:**
- Modify: none

**Step 1: Run focused tests**

Run:

```bash
bun test tests/linear-client.test.ts tests/linear-commands.test.ts tests/linear-project-artifacts.test.ts tests/linear-command-alias.test.ts tests/mcp.test.ts
```

Expected: PASS

**Step 2: Run lint/format gates**

Run:

```bash
bun x ultracite check
```

Expected: PASS with no remaining issues.

**Step 3: Run any required autofixes if needed**

Run:

```bash
bun x ultracite fix
```

Then rerun:

```bash
bun x ultracite check
```

**Step 4: Commit final polish**

```bash
git add .
git commit -m "chore: finish linear project artifact support"
```
