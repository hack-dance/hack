# Runtime, Session, and Remote Beta Hardening Design

**Date:** 2026-03-13

## Goal

Harden the default local runtime path around Docker Desktop, make daemon/runtime failures produce actionable repair guidance, clarify tmux-first session semantics, and label remote or multi-node flows as beta where users first encounter them.

## Scope

- Share Docker backend detection outside `global` so runtime diagnostics can explain what to do next.
- Improve `doctor` and `daemon status` output so runtime and daemon failures point to concrete recovery steps.
- Capture Docker Desktop-relevant diagnostics in `hack crash-capture` instead of assuming OrbStack.
- Align session naming and help text with tmux-first semantics and existing SSH or daemon constraints.
- Label remote, node, and dispatch surfaces as beta in command summaries and docs.

## Non-Goals

- Rewriting mux backend support across the CLI.
- Changing remote control-plane behavior beyond messaging, labeling, and guidance.
- Reworking daemon architecture or Docker event handling internals.

## Current Problems

### Runtime guidance is inconsistent

`hack global install` knows how to detect Docker Desktop vs OrbStack, but `hack doctor` still reports a generic “Docker daemon is not reachable” message. That means the common recovery path is least helpful on the common failure.

### Daemon failures are under-explained

`hack daemon status` distinguishes running, starting, stale, and stopped, but the user-facing output does not explain whether the right next step is clearing stale state, restarting the daemon, or starting the Docker backend.

### Crash capture is OrbStack-biased

`hack crash-capture` already collects useful Docker state, but its macOS unified log collection specifically targets OrbStack. Docker Desktop-first users do not get equally targeted diagnostics.

### Sessions are conceptually tmux-first but operationally inconsistent

The resolver already prefers tmux in `auto` mode, but the CLI and docs overstate general mux support while `hack session` remains tmux-centric. There is also a session naming mismatch: docs describe `--` separators while the CLI currently creates `:` suffixed session names, which conflicts with SSH and daemon session validators.

### Remote flows are not clearly beta-labeled

Remote, multi-node, and dispatch flows are presented as ordinary command surfaces even though the surrounding docs and acceptance criteria position them as beta.

## Proposed Changes

### 1. Shared Docker backend diagnostics

Create a small shared helper that:

- detects the local Docker backend
- formats backend-aware repair guidance
- can be reused by `global`, `doctor`, and daemon-facing status output

The default messaging should prefer Docker Desktop language when it is the installed backend, while still supporting OrbStack and Linux systemd paths.

### 2. Actionable doctor and daemon guidance

Update `hack doctor` so Docker failures include:

- the specific `docker info` failure text when available
- the detected backend name
- the most relevant next step, such as starting Docker Desktop, rerunning `hack doctor`, or using `hack global install`

Update `hack daemon status` human-readable output so it distinguishes:

- stale local state that should be cleared
- daemon not running while launchd is loaded
- launchd exit status that implies a crash
- follow-up recovery commands

### 3. Docker Desktop-inclusive crash capture

Expand crash capture collection on macOS to include Docker Desktop process and unified log matches alongside existing OrbStack diagnostics. This keeps the artifact relevant no matter which supported backend the user runs.

### 4. tmux-first session semantics and naming cleanup

Keep the resolver unchanged, but make the user-facing behavior consistent:

- session docs and command summaries should say tmux-first plainly
- generated agent guidance should mention the tmux-first default
- new session names should use the documented `--` separator so they remain compatible with SSH and daemon session routes

### 5. Explicit beta labeling for remote and multi-node flows

Add beta wording to:

- `hack remote`
- `hack node`
- `hack dispatch`
- the docs entry points that send users into remote or multi-node setup

The goal is expectation-setting, not warning fatigue, so the label should appear at the feature entry points instead of every downstream command.

## Testing Strategy

- Add unit tests for daemon status rendering helpers and backend-aware runtime guidance.
- Add CLI-facing tests for session naming compatibility.
- Add targeted tests for remote or beta-labeled command summaries where practical through CLI spec inspection.
- Run focused `bun test` suites for touched areas before broader checks.

## Risks

- Session name changes can affect any code that assumes `:` separators, so the test pass needs to include SSH and daemon route compatibility.
- Help text changes may require updating generated docs manually if there is no doc generation step wired into the repo.
- Backend-aware guidance must stay concise or it will bury the actual failure signal.
