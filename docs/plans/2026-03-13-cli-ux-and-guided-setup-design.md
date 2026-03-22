# CLI UX And Guided Setup Design

## Context

Hack already exposes most of the underlying capability needed for setup, repair, and provider auth:

- `hack doctor` checks many machine prerequisites and already suggests `hack doctor --fix` for several failures.
- `hack setup` manages agent/editor integrations.
- `hack auth` provides a first-class Hack account flow.
- `hack linear` exists as a top-level alias over the Linear extension.
- `hack tickets` exists as a top-level alias over the tickets extension.
- `hack x` remains the generic extension dispatcher.

The problem is not missing raw capability. The problem is that prerequisite detection, next-step routing, and status language are still fragmented across commands, extensions, and transport-specific error strings.

Today a user can still hit all of these failure classes:

- missing runtime prerequisites discovered only after a command fails
- mux/session failures that surface as backend absence rather than setup guidance
- GitHub flows that remain extension-centric and token-centric
- Linear broker flows that depend on Hack auth, local profile config, and project routing, but do not always explain which layer is missing
- help output that explains commands, but not the setup state required to use them

This stream defines the UX contract for first-run and repair behavior without requiring every child issue to invent its own interception language.

## Goals

- Make missing prerequisites discoverable from CLI output alone.
- Route users to the right setup or repair flow automatically.
- Define consistent top-level semantics for built-in commands, top-level aliases, and `hack x`.
- Normalize how status/help/error output describes auth, profiles, teams, and project routing.
- Break the stream into child issues that are independently executable.

## Non-Goals

- Do not redesign the full visual style of every command output.
- Do not collapse all extension commands into the root CLI in one pass.
- Do not replace provider-specific logic with one giant generic setup engine.
- Do not move existing local-only workflows behind mandatory Hack sign-in.
- Do not implement every child issue in this stream from this program ticket.

## Approaches Considered

### 1. Program-level UX contract first, then targeted child implementation

Define one shared prerequisite matrix, interception model, command taxonomy, and status vocabulary. Land that as docs plus child issue decomposition, then let each child issue implement one part.

Pros:

- Matches the acceptance criteria for this stream issue.
- Prevents runtime, mux, GitHub, and Linear work from drifting apart.
- Makes future code review objective because the contract is explicit.

Cons:

- Does not immediately change runtime behavior by itself.

### 2. Incrementally patch each command family directly

Fix `doctor`, `session`, GitHub auth, Linear auth, and help output one by one without a formal shared contract.

Pros:

- Faster short-term shipping on one surface at a time.

Cons:

- High risk of inconsistent messages and overlapping repair flows.
- Makes later cleanup harder because semantics drift.

### 3. Centralize all setup detection in one universal setup command

Create a single setup wizard that owns all prerequisite detection and recovery.

Pros:

- Conceptually simple entry point.

Cons:

- Too large for this stream.
- Conflicts with Hack’s existing command-oriented workflow.
- Still would not address provider-specific interception needs cleanly.

## Recommended Direction

Use approach 1.

This stream should land the product contract for guided setup and repair, then delegate execution to child issues focused on runtime/mux, command semantics, GitHub auth/setup, and Linear auth/setup.

## Current Surface Summary

The current codebase implies the following shape:

- runtime/global infra health lives primarily under `hack doctor`
- project lifecycle lives under root commands like `hack up`, `hack logs`, and `hack open`
- Hack account auth lives under `hack auth`
- Linear already has a root alias: `hack linear`
- tickets already has a root alias: `hack tickets`
- GitHub is still extension-only under `hack x github`
- extension enablement is handled separately from provider auth

This means the new UX contract should not pretend the CLI is fully flattened already. It should explicitly define which commands stay root-level, which commands remain extension-level for now, and how the CLI explains that split.

## Approved UX Contract

### 1. Prerequisites are grouped by capability, not by implementation detail

The CLI should reason about four user-facing capability groups:

- runtime
- mux sessions
- GitHub integration
- Linear integration

Each group has a small prerequisite matrix with:

- what the user is trying to do
- what must exist
- how the CLI checks it
- what command repairs it
- whether the CLI can auto-intercept and route

### 2. Every missing prerequisite maps to one next step

When a command fails because a prerequisite is missing, the user should see:

- what is missing
- why this command needs it
- the exact next command to run
- whether rerunning the original command should work afterward

Avoid vague guidance like:

- "not configured"
- "missing context"
- "extension disabled"

unless the output also names the corrective action.

### 3. Root commands are intent-first; `hack x` is the escape hatch

The command taxonomy should be:

- `hack <root-command>` for built-in product workflows and high-frequency integrated flows
- `hack <alias>` for promoted extensions with stable UX contracts
- `hack x <namespace> ...` for advanced or not-yet-promoted extension workflows

For this stream, the intended top-level shape is:

- keep `hack auth`
- keep `hack linear`
- keep `hack tickets`
- keep `hack setup`
- keep `hack doctor`
- keep `hack x` as the generic dispatcher
- add a first-class decision on whether GitHub remains `hack x github` or is promoted to `hack github`

### 4. Interception should happen at the command entry point closest to intent

The CLI should intercept at the first command the user naturally runs, not after multiple opaque transport failures.

Examples:

- `hack up` should intercept missing global/runtime health and send the user to `hack doctor` or `hack doctor --fix`
- `hack session start` should intercept missing mux backend and explain how to enable tmux/zellij or choose no-mux mode
- `hack x github ...` or `hack github ...` should intercept missing `gh`, missing stored profile state, and missing Hack auth only when the chosen flow actually requires it
- `hack linear ...` should intercept missing Hack auth, missing broker-backed profile access, missing local token/profile state, or missing project binding distinctly

### 5. Status output must separate these concepts consistently

Human-facing and JSON output should use stable language for:

- Hack account session
- provider connection
- selected profile
- selected organization/team
- project binding/routing
- local access versus broker-owned access

The CLI should not force users to infer which layer failed from an error string.

## Prerequisite Detection Matrix

### Runtime

| Capability | Required state | Existing check surface | Expected interception |
| --- | --- | --- | --- |
| `hack up`, `hack open`, `hack logs`, `hack ps` | bun installed, docker available, docker daemon reachable, global networking healthy enough for routed features | mostly `hack doctor`, partial command-local checks in project commands | commands route to `hack doctor` / `hack doctor --fix` with targeted explanation |
| routed HTTPS hosts | caddy/global infra, DNS resolver, trust state | `hack doctor`, project command warnings | command explains whether routing is degraded vs fully blocked |
| mutagen-backed workflows | mutagen binary/agent availability | `hack doctor`, mutagen helpers | repair points to `hack doctor --fix` or explicit mutagen path override |

### Mux Sessions

| Capability | Required state | Existing check surface | Expected interception |
| --- | --- | --- | --- |
| `hack session`, `hack session start` | chosen mux mode resolves to available tmux/zellij backend, or explicit no-mux mode | mux resolver + backend availability checks | session command explains missing backend and setup choice instead of acting like zero sessions exist |
| attach/exec/capture | backend installed and target session exists | session commands | command distinguishes "backend missing" from "session missing" |

### GitHub Integration

| Capability | Required state | Existing check surface | Expected interception |
| --- | --- | --- | --- |
| GitHub status/connect/profile workflows | extension enabled, selected profile resolved, local token/app installation state available | GitHub extension auth/commands | user sees promoted command semantics and exact repair path |
| broker-owned/shared GitHub features | valid Hack auth session plus authorized broker access | provider-specific auth flows | output distinguishes Hack account login from GitHub provider connection |
| PR/remote bootstrap workflows | `gh` installed when flow depends on GitHub CLI | GitHub commands | command offers install/setup guidance before failing deeper |

### Linear Integration

| Capability | Required state | Existing check surface | Expected interception |
| --- | --- | --- | --- |
| local profile/token flows | extension enabled, selected profile resolved, local token saved or provided | Linear command parsing/auth helpers | output explains profile selection and storage source clearly |
| broker-owned connection/autosync flows | Hack auth session, broker management token, permitted profile/team/project access | Linear auth/session helpers | command states whether user needs `hack auth login`, reconnect, or different profile/team |
| project sync/routing flows | project context present, project binding present, route scope known | Linear commands + project config | output names bound project/team/profile and what is missing |

## Interception Rules

### Root runtime commands

For `hack up`, `hack open`, `hack logs`, and related project commands:

- preflight only the prerequisites relevant to the requested behavior
- distinguish hard blockers from degraded modes
- point to `hack doctor` or `hack doctor --fix` when a shared runtime issue is the root cause
- preserve the original command in the message so the user knows what to retry

### Session commands

For `hack session`:

- if mux mode is `auto` and no backend is available, explain the decision tree: install tmux, install zellij, or set mux mode to `none`
- if a backend exists but session name is missing, show normal session guidance
- do not silently treat missing backend as an empty session list

### Extension promotion and dispatch

For promoted namespaces:

- root alias and `hack x` behavior should stay functionally aligned
- root help should explain when a workflow is promoted
- `hack x` help should describe itself as the advanced/escape-hatch path

For unpromoted namespaces:

- `hack x <namespace>` remains canonical until promotion is approved

### Provider auth flows

For GitHub and Linear:

- first explain whether the missing layer is Hack account auth, provider auth, or project/profile selection
- do not say "not authorized" without naming the identity boundary
- show active profile/team/project bindings in status output when they affect the requested command

## Status And Help Vocabulary

The CLI should standardize these phrases:

- `Hack account`: the Better Auth session used for broker-owned resources
- `Provider profile`: the selected GitHub or Linear profile
- `Local access`: provider token/profile state stored on this machine
- `Broker access`: remote access owned by the Hack account/org/team
- `Project binding`: the project-level route to a provider profile/project/team
- `Repair`: a recoverable path where the CLI knows the next command

Avoid mixing these into ambiguous phrases like:

- `connected` with no scope
- `authorized` with no subject
- `default` with no mention of profile vs team vs project binding

## Child Issue Breakdown

This stream should break into the following child issues.
These are already recorded in the repo-local `hack` tickets ref as `T-00001` through `T-00006`.

### 1. Runtime prerequisite detection and guided repair (`T-00002`)

Scope:

- define command-level runtime preflight helpers
- align `hack up`/`open`/`logs` with `hack doctor`
- normalize degraded-vs-blocked messaging

Primary files:

- `src/commands/project.ts`
- `src/commands/doctor.ts`
- shared runtime helper modules under `src/lib/` or `src/commands/`

### 2. Mux/session prerequisite interception (`T-00003`)

Scope:

- make missing tmux/zellij explicit
- surface mux mode and repair actions in `hack session`
- distinguish backend absence from missing sessions

Primary files:

- `src/commands/session.ts`
- `src/mux/mux-resolver.ts`
- `src/mux/*.ts`

### 3. Top-level command semantics and help cleanup (`T-00001`)

Scope:

- define promotion rules for root aliases vs `hack x`
- decide GitHub root alias promotion
- improve root help and dispatcher help copy
- make extension-disabled messaging intent-first

Primary files:

- `src/cli/help.ts`
- `src/cli/spec.ts`
- `src/commands/x.ts`
- command alias files such as `src/commands/linear.ts`, `src/commands/tickets.ts`

### 4. GitHub setup and auth guidance cleanup (`T-00005`)

Scope:

- clarify setup/auth/status output for GitHub profiles
- intercept missing `gh`, missing local auth, and broker-auth requirements
- align any promoted root alias with extension behavior

Primary files:

- `src/control-plane/extensions/github/commands.ts`
- `src/control-plane/extensions/github/auth.ts`
- related GitHub tests

### 5. Linear setup and broker/local access guidance cleanup (`T-00006`)

Scope:

- clarify Hack auth vs Linear auth vs project binding failures
- standardize status output around profile/team/project context
- improve repair routing for broker-backed access and local repair flows

Primary files:

- `src/control-plane/extensions/linear/commands.ts`
- `src/control-plane/extensions/linear/auth.ts`
- related Linear tests

### 6. Shared status payload vocabulary (`T-00004`)

Scope:

- define shared JSON fields and human phrasing for auth/profile/routing status
- align provider and root status commands on that vocabulary

Primary files:

- auth/provider command implementations
- any shared status rendering helpers
- command tests asserting payload shape and text

## Testing Strategy

This stream’s child work should bias toward command-level tests that assert:

- the right interception occurs before deep failure
- output names the missing prerequisite explicitly
- output names the exact next command
- JSON output exposes the same state model as human output

Use focused Bun tests for:

- command parsing
- command handlers with mocked fetch/process state
- status payload rendering
- help output snapshots where needed

## Acceptance Mapping

### A user can discover and fix missing setup from CLI output alone

Covered by:

- prerequisite matrix
- interception rules
- repair vocabulary

### Core workflows route users into the correct setup or repair flow automatically

Covered by:

- root runtime command interception
- session interception
- provider auth flow interception

### Integration commands explain active bindings and missing context clearly

Covered by:

- status/help vocabulary
- provider-specific guidance rules
- shared status payload contract

### The child issues in this stream are sufficient to implement the new UX contract

Covered by:

- six-child breakdown across runtime, mux, semantics, GitHub, Linear, and shared status payloads

## Recommended Next Step

Write an implementation plan that converts this contract into small tasks and create local child tickets mirroring the issue breakdown above.
