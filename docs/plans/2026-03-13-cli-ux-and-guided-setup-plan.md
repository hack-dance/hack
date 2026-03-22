# CLI UX And Guided Setup Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Establish and implement a consistent guided-setup and repair contract across runtime, mux, GitHub, Linear, and top-level command semantics so users can recover from missing setup directly from CLI output.

**Architecture:** Keep Hack’s command-oriented structure, but add a shared prerequisite/interception vocabulary that root commands, promoted aliases, and extension commands all use consistently. Treat `hack doctor` as the runtime repair authority, `hack auth` as the Hack-account authority, provider commands as provider-specific repair surfaces, and `hack x` as the advanced dispatcher instead of the default user journey.

**Tech Stack:** Bun, TypeScript, Hack CLI command framework, extension command surfaces, Bun tests.

## Execution Notes

- Implement this stream through child issues rather than as one giant branch.
- Favor command-level tests that assert the user-visible next step.
- Keep JSON payloads and human output aligned.
- Reuse existing helpers before adding new shared layers.
- Repo-local ticket mapping:
  `T-00001` top-level semantics, `T-00002` runtime repair, `T-00003` mux/session repair,
  `T-00004` shared status vocabulary, `T-00005` GitHub guidance, `T-00006` Linear guidance.

---

### Task 1: Introduce a shared prerequisite result model

**Files:**

- Create: `src/cli/prereq.ts`
- Modify: `src/commands/project.ts`
- Modify: `src/commands/session.ts`
- Test: `tests/cli-prereq.test.ts`

**Step 1: Write the failing test**

Add tests for a minimal prerequisite result model that can represent:

- `ok`
- `degraded`
- `blocked`
- exact repair command
- retryable original command

**Step 2: Run test to verify it fails**

Run:

```bash
bun test tests/cli-prereq.test.ts
```

Expected: FAIL because the shared prerequisite model does not exist yet.

**Step 3: Write minimal implementation**

Add a small shared type/helper layer for prerequisite checks and repair messages. Keep it presentation-focused rather than building a large framework.

**Step 4: Run test to verify it passes**

Run:

```bash
bun test tests/cli-prereq.test.ts
```

Expected: PASS

### Task 2: Align runtime commands with guided doctor repair

**Files:**

- Modify: `src/commands/project.ts`
- Modify: `src/commands/doctor.ts`
- Test: `tests/project-up-command.test.ts`
- Test: `tests/daemon-command.test.ts`

**Step 1: Write the failing test**

Add focused tests showing that runtime failures route users to:

- `hack doctor`
- `hack doctor --fix`
- degraded-mode explanations when routing or trust is unavailable but the command can still partially work

**Step 2: Run test to verify it fails**

Run:

```bash
bun test tests/project-up-command.test.ts tests/daemon-command.test.ts
```

Expected: FAIL after adding the new expectations.

**Step 3: Write minimal implementation**

Use the shared prerequisite model to standardize runtime repair messages in project commands. Reuse doctor checks where practical instead of duplicating raw diagnostics.

**Step 4: Run test to verify it passes**

Run:

```bash
bun test tests/project-up-command.test.ts tests/daemon-command.test.ts
```

Expected: PASS

### Task 3: Make mux/session repair intent-first

**Files:**

- Modify: `src/commands/session.ts`
- Modify: `src/mux/mux-resolver.ts`
- Modify: `src/mux/tmux-backend.ts`
- Modify: `src/mux/zellij-backend.ts`
- Test: `tests/session-utils.test.ts`
- Create: `tests/session-command-guidance.test.ts`

**Step 1: Write the failing test**

Add tests for:

- auto mux mode with no available backend
- explicit tmux mode with tmux missing
- explicit zellij mode with zellij missing
- existing backend but missing named session

**Step 2: Run test to verify it fails**

Run:

```bash
bun test tests/session-command-guidance.test.ts tests/session-utils.test.ts
```

Expected: FAIL because session guidance does not yet distinguish backend setup from missing sessions clearly.

**Step 3: Write minimal implementation**

Return structured prerequisite failures from session entry points and render repair options:

- install tmux
- install zellij
- configure mux mode to `none`

**Step 4: Run test to verify it passes**

Run:

```bash
bun test tests/session-command-guidance.test.ts tests/session-utils.test.ts
```

Expected: PASS

### Task 4: Clean up root help and dispatcher semantics

**Files:**

- Modify: `src/cli/help.ts`
- Modify: `src/cli/spec.ts`
- Modify: `src/commands/x.ts`
- Modify: `src/commands/linear.ts`
- Modify: `src/commands/tickets.ts`
- Test: `tests/cli-command.test.ts`
- Create: `tests/help-output.test.ts`

**Step 1: Write the failing test**

Add tests for:

- root help surfacing promoted workflows clearly
- `hack x` help framing itself as advanced/dispatcher behavior
- extension-disabled output naming the exact promoted or extension entry point

**Step 2: Run test to verify it fails**

Run:

```bash
bun test tests/cli-command.test.ts tests/help-output.test.ts
```

Expected: FAIL with current help/dispatcher messaging.

**Step 3: Write minimal implementation**

Update root help and dispatcher copy to:

- explain promoted aliases
- explain when `hack x` is still canonical
- make disabled-extension output intent-first rather than namespace-first

**Step 4: Run test to verify it passes**

Run:

```bash
bun test tests/cli-command.test.ts tests/help-output.test.ts
```

Expected: PASS

### Task 5: Decide and implement GitHub top-level semantics

**Files:**

- Modify: `src/cli/spec.ts`
- Create or modify: `src/commands/github.ts`
- Modify: `src/control-plane/extensions/github/commands.ts`
- Test: `tests/github-commands.test.ts`
- Create: `tests/github-command-alias.test.ts`

**Step 1: Write the failing test**

Add tests for the approved GitHub entry-point decision:

- if promoted: `hack github ...` mirrors `hack x github ...`
- if not promoted: help/repair output consistently points users to `hack x github`

**Step 2: Run test to verify it fails**

Run:

```bash
bun test tests/github-commands.test.ts tests/github-command-alias.test.ts
```

Expected: FAIL because the chosen semantics are not implemented yet.

**Step 3: Write minimal implementation**

Implement the approved path only. Do not redesign GitHub auth in the same step.

**Step 4: Run test to verify it passes**

Run:

```bash
bun test tests/github-commands.test.ts tests/github-command-alias.test.ts
```

Expected: PASS

### Task 6: Improve GitHub prerequisite interception

**Files:**

- Modify: `src/control-plane/extensions/github/commands.ts`
- Modify: `src/control-plane/extensions/github/auth.ts`
- Test: `tests/github-commands.test.ts`
- Test: `tests/github-auth.test.ts`

**Step 1: Write the failing test**

Add tests for:

- missing `gh`
- missing selected GitHub profile
- missing local token/app installation state
- broker-owned flow requiring Hack auth

**Step 2: Run test to verify it fails**

Run:

```bash
bun test tests/github-commands.test.ts tests/github-auth.test.ts
```

Expected: FAIL after adding new guidance expectations.

**Step 3: Write minimal implementation**

Make GitHub commands report the missing layer explicitly and name the next command to run.

**Step 4: Run test to verify it passes**

Run:

```bash
bun test tests/github-commands.test.ts tests/github-auth.test.ts
```

Expected: PASS

### Task 7: Improve Linear prerequisite interception and routing clarity

**Files:**

- Modify: `src/control-plane/extensions/linear/commands.ts`
- Modify: `src/control-plane/extensions/linear/auth.ts`
- Test: `tests/linear-commands.test.ts`
- Test: `tests/linear-auth.test.ts`
- Test: `tests/auth-command.test.ts`

**Step 1: Write the failing test**

Add tests for:

- missing Hack auth for broker-owned Linear access
- stale broker token vs missing broker token
- missing local profile/token state
- missing project binding when running sync/project-scoped commands
- status output including profile/team/project context clearly

**Step 2: Run test to verify it fails**

Run:

```bash
bun test tests/linear-commands.test.ts tests/linear-auth.test.ts tests/auth-command.test.ts
```

Expected: FAIL after new expectations are added.

**Step 3: Write minimal implementation**

Standardize Linear repair output around four layers:

- Hack account session
- broker permission/profile ownership
- local profile/token access
- project binding/routing

**Step 4: Run test to verify it passes**

Run:

```bash
bun test tests/linear-commands.test.ts tests/linear-auth.test.ts tests/auth-command.test.ts
```

Expected: PASS

### Task 8: Standardize shared status vocabulary and payloads

**Files:**

- Modify: `src/commands/auth.ts`
- Modify: provider status commands under `src/control-plane/extensions/*/commands.ts`
- Create: `src/ui/status-contract.ts`
- Test: `tests/auth-command.test.ts`
- Test: `tests/github-commands.test.ts`
- Test: `tests/linear-commands.test.ts`

**Step 1: Write the failing test**

Add tests asserting stable human/JSON vocabulary for:

- Hack account
- provider profile
- local access
- broker access
- project binding
- repair next step

**Step 2: Run test to verify it fails**

Run:

```bash
bun test tests/auth-command.test.ts tests/github-commands.test.ts tests/linear-commands.test.ts
```

Expected: FAIL because the shared vocabulary layer does not exist yet.

**Step 3: Write minimal implementation**

Add a small shared status helper and adopt it in status-oriented commands.

**Step 4: Run test to verify it passes**

Run:

```bash
bun test tests/auth-command.test.ts tests/github-commands.test.ts tests/linear-commands.test.ts
```

Expected: PASS

### Task 9: Create and sync child tickets for the stream

**Files:**

- Verify only in git-backed tickets store

**Step 1: Create child tickets**

Create tickets for:

- runtime prerequisite repair
- mux/session interception
- root help and command semantics
- GitHub setup/auth guidance
- Linear setup/auth guidance
- shared status vocabulary

Current status: these tickets already exist in the repo-local hidden ref as `T-00001` through
`T-00006`.

**Step 2: Mark dependencies**

Model dependencies so shared vocabulary and command semantics can support the provider-specific work without blocking unrelated runtime fixes.

**Step 3: Sync tickets**

Run:

```bash
bun index.ts x tickets sync
```

Expected: tickets ref updates successfully once the workspace is bootstrapped.

### Task 10: Final verification

**Files:**

- Verify only

**Step 1: Run focused tests for changed slices**

Run the relevant focused `bun test ...` commands from the child issue being implemented.

**Step 2: Run repo quality gates**

Run:

```bash
bun run check
bun run typecheck
bun run test
```

Expected: PASS

**Step 3: Verify ticket state and handoff context**

Run:

```bash
bun index.ts x tickets list
git status --short
```

Expected: new docs and ticket artifacts are present, and remaining work is captured in child tickets.
