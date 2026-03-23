# Runtime, Session, and Remote Beta Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Harden runtime and daemon repair guidance, align tmux-first session behavior, and beta-label remote or multi-node entry points.

**Architecture:** Reuse a shared Docker backend diagnostics helper instead of duplicating backend detection in command code. Keep the code changes narrow: add tests around helper output and session naming, then update command summaries, human-readable status paths, and docs to match the intended UX.

**Tech Stack:** Bun, TypeScript, bun:test, markdown docs

---

### Task 1: Record backend-aware runtime guidance

**Files:**
- Create: `tests/runtime-guidance.test.ts`
- Create: `src/lib/runtime-guidance.ts`
- Modify: `src/commands/global.ts`
- Modify: `src/commands/doctor.ts`

**Step 1: Write the failing test**

Add tests that prove:
- Docker Desktop is identified distinctly from OrbStack
- unreachable Docker guidance includes backend-aware next steps
- doctor-facing formatting preserves the underlying runtime failure text

**Step 2: Run test to verify it fails**

Run: `bun test tests/runtime-guidance.test.ts`
Expected: FAIL because the shared guidance helper does not exist yet

**Step 3: Write minimal implementation**

Extract backend detection from `src/commands/global.ts` into `src/lib/runtime-guidance.ts`, then consume it from `global` and `doctor`.

**Step 4: Run test to verify it passes**

Run: `bun test tests/runtime-guidance.test.ts`
Expected: PASS

### Task 2: Make daemon status report repairable

**Files:**
- Modify: `tests/daemon-status.test.ts`
- Modify: `tests/daemon-command.test.ts`
- Modify: `src/daemon/status.ts`
- Modify: `src/commands/daemon.ts`

**Step 1: Write the failing test**

Add tests for:
- a crash-oriented daemon status classification when launchd reports a non-zero exit status
- human-readable daemon status output that recommends `hack daemon clear` for stale state and `hack daemon restart` or Docker startup for crash-like states

**Step 2: Run test to verify it fails**

Run: `bun test tests/daemon-status.test.ts tests/daemon-command.test.ts`
Expected: FAIL because daemon status does not yet encode or render those states

**Step 3: Write minimal implementation**

Extend the daemon status model and user-facing rendering to surface crash or repair guidance without changing the daemon API shape more than necessary.

**Step 4: Run test to verify it passes**

Run: `bun test tests/daemon-status.test.ts tests/daemon-command.test.ts`
Expected: PASS

### Task 3: Align session naming with tmux-first docs and validators

**Files:**
- Create: `tests/session-command.test.ts`
- Modify: `src/commands/session.ts`
- Modify: `docs/sessions.md`
- Modify: `docs/cli.md`
- Modify: `src/mcp/agent-docs.ts`

**Step 1: Write the failing test**

Add tests that prove:
- auto-generated session suffixes use `--2`
- custom session suffixes use `--agent-1`
- existing docs/help wording can accurately describe `hack session` as tmux-first

**Step 2: Run test to verify it fails**

Run: `bun test tests/session-command.test.ts`
Expected: FAIL because the CLI still creates `:`-suffixed session names

**Step 3: Write minimal implementation**

Update session name generation and the tmux-first messaging surfaces without changing the resolver strategy.

**Step 4: Run test to verify it passes**

Run: `bun test tests/session-command.test.ts`
Expected: PASS

### Task 4: Label remote and multi-node entry points as beta

**Files:**
- Modify: `tests/cli-command.test.ts`
- Modify: `src/commands/remote.ts`
- Modify: `src/commands/node.ts`
- Modify: `src/commands/dispatch.ts`
- Modify: `README.md`
- Modify: `docs/README.md`
- Modify: `docs/guides/remote-node-quickstart.md`
- Modify: `docs/guides/remote-node-container.md`
- Modify: `docs/guides/remote-node-railway.md`

**Step 1: Write the failing test**

Add spec-level assertions that the command summaries for `remote`, `node`, and `dispatch` include beta wording.

**Step 2: Run test to verify it fails**

Run: `bun test tests/cli-command.test.ts`
Expected: FAIL because the current summaries do not include beta labels

**Step 3: Write minimal implementation**

Update command summaries and the high-level docs that introduce remote or multi-node flows.

**Step 4: Run test to verify it passes**

Run: `bun test tests/cli-command.test.ts`
Expected: PASS

### Task 5: Capture Docker Desktop diagnostics during crash triage

**Files:**
- Create: `tests/crash-capture.test.ts`
- Modify: `src/commands/crash-capture.ts`
- Modify: `docs/cli.md`

**Step 1: Write the failing test**

Add a test that proves the crash-capture command set includes Docker Desktop-specific macOS log or process probes.

**Step 2: Run test to verify it fails**

Run: `bun test tests/crash-capture.test.ts`
Expected: FAIL because only OrbStack-specific probes exist today

**Step 3: Write minimal implementation**

Broaden the macOS diagnostics probes to include Docker Desktop terms while keeping OrbStack capture intact.

**Step 4: Run test to verify it passes**

Run: `bun test tests/crash-capture.test.ts`
Expected: PASS

### Task 6: Run focused and broader verification

**Files:**
- Modify: any touched files above

**Step 1: Run focused suites**

Run:
- `bun test tests/runtime-guidance.test.ts`
- `bun test tests/daemon-status.test.ts tests/daemon-command.test.ts`
- `bun test tests/session-command.test.ts`
- `bun test tests/cli-command.test.ts`
- `bun test tests/crash-capture.test.ts`

Expected: PASS

**Step 2: Run broader quality gates**

Run:
- `bun test`
- `bunx ultracite check`

Expected: PASS or only pre-existing unrelated failures

**Step 3: Document remaining work**

If any desired hardening remains outside this slice, create follow-up `hack tickets` before ending the session.
