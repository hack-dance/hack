# Linear Project Management UX Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Redesign `hack linear setup`, `hack linear project-bind`, and `hack linear status` so users can understand the active profile, repo routing, capabilities, and repair paths without knowing extension internals.

**Architecture:** Keep the existing command names and storage layout, but add shared project-management summary helpers inside the Linear extension. Use those helpers to drive the human-facing output and enriched JSON payloads for `setup`, `project-bind`, and `status`, then update help/docs to match the new routing language.

**Tech Stack:** Bun, TypeScript, existing CLI display helpers, Bun test

---

### Task 1: Add failing tests for the shared project-management summary model

**Files:**
- Modify: `tests/linear-commands.test.ts`
- Test: `tests/linear-commands.test.ts`

**Step 1: Write the failing test**

Add tests that expect new helper output for:

- connected profile + bound project + capabilities
- missing token/profile with repair command
- setup summary showing partial vs complete repo readiness
- project-bind summary showing routing scope and next steps

**Step 2: Run test to verify it fails**

Run: `bun test tests/linear-commands.test.ts`
Expected: FAIL because the new helper functions / payload shape do not exist yet.

**Step 3: Write minimal implementation**

Create shared summary helpers in `src/control-plane/extensions/linear/commands.ts` and expose them via `__testOnly`.

**Step 4: Run test to verify it passes**

Run: `bun test tests/linear-commands.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/linear-commands.test.ts src/control-plane/extensions/linear/commands.ts
git commit -m "feat: redesign linear project management status"
```

### Task 2: Rework human-facing `status`, `setup`, and `project-bind` output

**Files:**
- Modify: `src/control-plane/extensions/linear/commands.ts`
- Test: `tests/linear-commands.test.ts`

**Step 1: Write the failing test**

Add tests for command payload builders covering:

- `status` reports active route and capabilities
- `setup` reports readiness and next steps
- `project-bind` reports default route plus linked project scope

**Step 2: Run test to verify it fails**

Run: `bun test tests/linear-commands.test.ts`
Expected: FAIL

**Step 3: Write minimal implementation**

Refactor the command handlers to call the shared summary helper and render:

- status panel with connection, routing, capabilities, repair
- setup panel with repo readiness and next command
- project-bind panel with route scope and next command

Keep existing JSON fields where possible, but add the new summary fields.

**Step 4: Run test to verify it passes**

Run: `bun test tests/linear-commands.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/control-plane/extensions/linear/commands.ts tests/linear-commands.test.ts
git commit -m "feat: reframe linear setup and binding output"
```

### Task 3: Update top-level help and docs

**Files:**
- Modify: `src/commands/linear.ts`
- Modify: `docs/extensions.md`
- Modify: `docs/cli.md`

**Step 1: Write the failing test**

If practical, add or update a CLI/help test that covers the new examples. Otherwise rely on doc edits plus command-level tests from previous tasks.

**Step 2: Run test to verify it fails**

Run: `bun test tests/linear-command-alias.test.ts tests/linear-commands.test.ts`
Expected: Existing help expectations fail if examples changed.

**Step 3: Write minimal implementation**

Update help text and documentation to emphasize:

- connect profile
- bind repo route
- confirm status/capabilities

**Step 4: Run test to verify it passes**

Run: `bun test tests/linear-command-alias.test.ts tests/linear-commands.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/commands/linear.ts docs/extensions.md docs/cli.md tests/linear-command-alias.test.ts tests/linear-commands.test.ts
git commit -m "docs: clarify linear routing and capability language"
```

### Task 4: Verify quality gates and complete session handoff

**Files:**
- Modify if needed: `.hack/tickets/*` via CLI

**Step 1: Run targeted verification**

Run: `bun test tests/linear-commands.test.ts tests/linear-command-alias.test.ts`
Expected: PASS

**Step 2: Run quality gate**

Run: `bunx ultracite check`
Expected: PASS

**Step 3: File remaining work if needed**

Create follow-up tickets only for work explicitly left out of this pass.

**Step 4: Update issue status context**

Do not mutate Linear directly from this run. Instead prepare concise handoff notes describing completion state and residual risks.

**Step 5: Commit**

```bash
git add docs/plans/2026-03-13-linear-project-management-ux-design.md docs/plans/2026-03-13-linear-project-management-ux-plan.md
git commit -m "docs: plan linear project management ux redesign"
```
