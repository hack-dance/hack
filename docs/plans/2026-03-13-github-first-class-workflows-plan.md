# GitHub First-Class Workflows Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the initial first-class GitHub workflow set for reviews, PR updates, comments, and PR-adjacent repo actions in a phased, testable way.

**Architecture:** Build a shared GitHub PR/review domain layer first, then layer workflow-specific command/UI entry points on top. Keep write operations narrowly aligned to the defined workflow classes so the product surface stays bounded.

**Tech Stack:** Bun, TypeScript, Hack CLI extension framework, Bun test, markdown docs

---

### Task 1: Document the product boundary in public docs

**Files:**

- Modify: `docs/extensions.md`
- Modify: `docs/cli.md`
- Test: `docs/plans/2026-03-13-github-first-class-workflows-design.md`

**Step 1: Write the failing documentation expectation**

Add a short checklist to the task branch notes describing the public-doc gap:

- GitHub docs only describe auth/profile management plus `pr-upsert`
- There is no explicit workflow taxonomy for reviews, comments, or repo handoff

**Step 2: Verify the gap exists**

Run: `grep -n "GitHub extension" -n docs/extensions.md && grep -n "review" docs/extensions.md` Expected: GitHub auth/pr-upsert docs exist, but workflow taxonomy is missing or incomplete.

**Step 3: Add minimal public-facing scope language**

Document:

- supported initial workflow classes
- explicit non-goals for the first milestone
- pointer from command docs to the workflow model

**Step 4: Verify the docs render cleanly**

Run: `git diff --check` Expected: no whitespace or patch-format errors.

**Step 5: Commit**

```bash
git add docs/extensions.md docs/cli.md docs/plans/2026-03-13-github-first-class-workflows-design.md
git commit -m "docs: define first-class github workflow scope"
```

### Task 2: Add shared PR/review read primitives

**Files:**

- Modify: `src/control-plane/extensions/github/client.ts`
- Modify: `src/control-plane/extensions/github/commands.ts`
- Test: `tests/github-client.test.ts`
- Test: `tests/github-commands.test.ts`

**Step 1: Write the failing tests**

Add tests covering:

- fetching a PR summary by repo + number or branch
- listing relevant PRs for a repo/user context
- normalizing review/check/thread summary payloads

**Step 2: Run targeted tests to verify failure**

Run: `bun test tests/github-client.test.ts tests/github-commands.test.ts` Expected: FAIL because review/summary read APIs do not exist yet.

**Step 3: Implement the minimal shared read layer**

Add client helpers and command plumbing for:

- PR summary fetch
- relevant PR listing
- review/check/thread summary normalization

**Step 4: Re-run tests**

Run: `bun test tests/github-client.test.ts tests/github-commands.test.ts` Expected: PASS for the new read-path coverage.

**Step 5: Commit**

```bash
git add src/control-plane/extensions/github/client.ts src/control-plane/extensions/github/commands.ts tests/github-client.test.ts tests/github-commands.test.ts
git commit -m "feat(github): add shared pr review read primitives"
```

### Task 3: Implement review decision submission

**Files:**

- Modify: `src/control-plane/extensions/github/client.ts`
- Modify: `src/control-plane/extensions/github/commands.ts`
- Test: `tests/github-client.test.ts`
- Test: `tests/github-commands.test.ts`
- Modify: `docs/extensions.md`
- Modify: `docs/cli.md`

**Step 1: Write the failing tests**

Add tests covering:

- `approve`, `comment`, and `request_changes` review submission
- required summary body validation
- stable success payload formatting

**Step 2: Run targeted tests to verify failure**

Run: `bun test tests/github-client.test.ts tests/github-commands.test.ts` Expected: FAIL because review submission endpoints and command parsing are missing.

**Step 3: Implement the minimal review submission flow**

Add:

- client call for GitHub review submission
- command parsing and output formatting
- docs for the new supported review workflow

**Step 4: Re-run tests**

Run: `bun test tests/github-client.test.ts tests/github-commands.test.ts` Expected: PASS for review submission coverage.

**Step 5: Commit**

```bash
git add src/control-plane/extensions/github/client.ts src/control-plane/extensions/github/commands.ts tests/github-client.test.ts tests/github-commands.test.ts docs/extensions.md docs/cli.md
git commit -m "feat(github): add review decision workflow"
```

### Task 4: Expand PR update flow beyond upsert

**Files:**

- Modify: `src/control-plane/extensions/github/client.ts`
- Modify: `src/control-plane/extensions/github/commands.ts`
- Test: `tests/github-client.test.ts`
- Test: `tests/github-commands.test.ts`
- Modify: `docs/extensions.md`
- Modify: `docs/cli.md`

**Step 1: Write the failing tests**

Add tests covering:

- PR metadata read-before-write behavior
- title/body/base updates
- draft -> ready and ready -> draft transitions
- optional comment attach-on-update behavior

**Step 2: Run targeted tests to verify failure**

Run: `bun test tests/github-client.test.ts tests/github-commands.test.ts` Expected: FAIL because the state-transition surface is incomplete.

**Step 3: Implement the minimal PR update workflow**

Extend the current `pr-upsert` path or split it into clearer commands, but keep support limited to:

- create/update
- draft/ready transitions
- optional top-level comment

**Step 4: Re-run tests**

Run: `bun test tests/github-client.test.ts tests/github-commands.test.ts` Expected: PASS for the expanded PR update coverage.

**Step 5: Commit**

```bash
git add src/control-plane/extensions/github/client.ts src/control-plane/extensions/github/commands.ts tests/github-client.test.ts tests/github-commands.test.ts docs/extensions.md docs/cli.md
git commit -m "feat(github): expand pr update workflow"
```

### Task 5: Add standalone PR comment workflow

**Files:**

- Modify: `src/control-plane/extensions/github/client.ts`
- Modify: `src/control-plane/extensions/github/commands.ts`
- Test: `tests/github-client.test.ts`
- Test: `tests/github-commands.test.ts`
- Modify: `docs/extensions.md`
- Modify: `docs/cli.md`

**Step 1: Write the failing tests**

Add tests covering:

- creating a top-level PR comment
- validating repo/pr target resolution
- emitting durable remote identifiers in output

**Step 2: Run targeted tests to verify failure**

Run: `bun test tests/github-client.test.ts tests/github-commands.test.ts` Expected: FAIL because standalone comment workflow is not yet exposed.

**Step 3: Implement the minimal standalone comment flow**

Support only top-level PR comments in this task. Do not add full inline diff-thread comment support.

**Step 4: Re-run tests**

Run: `bun test tests/github-client.test.ts tests/github-commands.test.ts` Expected: PASS for standalone comment coverage.

**Step 5: Commit**

```bash
git add src/control-plane/extensions/github/client.ts src/control-plane/extensions/github/commands.ts tests/github-client.test.ts tests/github-commands.test.ts docs/extensions.md docs/cli.md
git commit -m "feat(github): add standalone pr comments"
```

### Task 6: Add PR-adjacent repo handoff actions

**Files:**

- Modify: `src/control-plane/extensions/github/client.ts`
- Modify: `src/control-plane/extensions/github/commands.ts`
- Modify: `src/lib/project.ts`
- Test: `tests/github-client.test.ts`
- Test: `tests/github-commands.test.ts`
- Test: `tests/project-execution-routing.test.ts`
- Modify: `docs/extensions.md`
- Modify: `docs/cli.md`

**Step 1: Write the failing tests**

Add tests covering:

- resolving PR head/base refs from GitHub state
- mapping a PR to a local branch/worktree handoff target
- presenting changed-file and checks summary as read-only repo context

**Step 2: Run targeted tests to verify failure**

Run: `bun test tests/github-client.test.ts tests/github-commands.test.ts tests/project-execution-routing.test.ts` Expected: FAIL because PR-to-local handoff actions are not implemented.

**Step 3: Implement the minimal repo handoff flow**

Support:

- PR/ref resolution
- local branch/worktree handoff target generation
- PR URL and changed-file/check summary output

Do not add merge, rebase, rerun, or admin actions.

**Step 4: Re-run tests**

Run: `bun test tests/github-client.test.ts tests/github-commands.test.ts tests/project-execution-routing.test.ts` Expected: PASS for the handoff coverage.

**Step 5: Commit**

```bash
git add src/control-plane/extensions/github/client.ts src/control-plane/extensions/github/commands.ts src/lib/project.ts tests/github-client.test.ts tests/github-commands.test.ts tests/project-execution-routing.test.ts docs/extensions.md docs/cli.md
git commit -m "feat(github): add pr repo handoff actions"
```

### Task 7: Run full quality gates for the GitHub workflow milestone

**Files:**

- Modify: `docs/extensions.md`
- Modify: `docs/cli.md`
- Modify: `src/control-plane/extensions/github/client.ts`
- Modify: `src/control-plane/extensions/github/commands.ts`
- Modify: `tests/github-client.test.ts`
- Modify: `tests/github-commands.test.ts`

**Step 1: Run formatter/linter**

Run: `bun x ultracite fix` Expected: formatting and autofix pass cleanly.

**Step 2: Run focused tests**

Run: `bun test tests/github-client.test.ts tests/github-commands.test.ts tests/project-execution-routing.test.ts` Expected: PASS.

**Step 3: Run broader repository validation**

Run: `bun x ultracite check` Expected: PASS with no new lint or formatting regressions.

**Step 4: Review scope against the design doc**

Verify each implemented action still maps to:

- review intake/decision
- PR update
- PR comments
- PR-adjacent repo handoff

Expected: no extra GitHub surface added beyond the design boundary.

**Step 5: Commit**

```bash
git add docs/extensions.md docs/cli.md src/control-plane/extensions/github/client.ts src/control-plane/extensions/github/commands.ts tests/github-client.test.ts tests/github-commands.test.ts tests/project-execution-routing.test.ts
git commit -m "feat(github): deliver first-class workflow milestone"
```
