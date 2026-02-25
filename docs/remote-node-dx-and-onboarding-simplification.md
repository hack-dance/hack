# Remote Node DX + Onboarding Simplification Plan (2026-02-25)

Status: proposed
Owners: multi-node, desktop UX, provider integrations

Related:
1. `docs/multi-node-remote-execution-and-codex-integration.md`
2. `docs/guides/remote-node-laptop-e2e.md`
3. `docs/provider-composition-and-project-overrides.md`
4. Tickets: `T-00163`, `T-00164`, `T-00165`, `T-00166`, `T-00167`, `T-00168`, `T-00169`

## Goal

Make remote-node setup and usage "one-screen simple" for both CLI and macOS app:
1. discover or bootstrap a node
2. pair/trust it
3. set project execution target
4. run and observe remotely

## Current pain points

1. Pairing still feels command-heavy when endpoint/source cannot be auto-inferred.
2. App topology and project views expose too many controls at once.
3. Host/controller responsibilities are not explicit enough in all views.
4. Project remote workspace setup is powerful but not yet presented as a simple default path with light override affordances.
5. Provider bootstrap has too many visible knobs before basic values are entered.

## Product principles

1. Progressive disclosure: default path first, advanced options collapsed.
2. Explicit trust boundary: network presence never equals trust.
3. Stable defaults: deterministic remote roots and routing behavior.
4. Visible role state: users always know if this machine is host/controller or node-only.
5. Single-command equivalence: every major app flow maps to one documented CLI command.

## Target UX end-state

### 1) Global machine role model

Define one authoritative runtime role:
1. `host` (controller capabilities enabled)
2. `node` (execution-only mode, controller mutation controls hidden)
3. `hybrid` (advanced mode; current behavior)

Requirements:
1. role is persisted globally and surfaced in app chrome + topology.
2. UI sections gate by role (`host` shows pairing/registry controls; `node` hides them).
3. role switching provides safe migration checks (for example default-node/controller ownership conflicts).

### 2) Topology as the primary entry point

`Add remote node` should open a small action picker:
1. Pair existing reachable node (SSH/Tailscale)
2. Bootstrap new provider node (Railway first)
3. Manual endpoint registration

For existing tailnet devices:
1. show discovered candidates (hostname + IP + online state).
2. allow one-click prefill into pairing flow.

### 3) Pairing simplification

Controller CLI/app should support:
1. endpoint/source auto-detection first.
2. remote `hack` binary auto-discovery with deterministic fallback order.
3. short actionable errors (`gateway unreachable`, `ssh user invalid`, `remote hack missing`).

### 4) Project setup defaults

When first running a project against a node:
1. default remote workspace root: `~/.hack/projects/<project-slug>/`
2. auto-create map entry in `~/.hack/projects.config.json`
3. optional attach path for pre-existing remote workspace

Project control should reduce to two fields:
1. default node: `Local | <registered-node>`
2. git credentials for remote automation: `Local | <connected-account>`

### 5) Project information architecture cleanup (macOS)

Split into dedicated views:
1. Overview
2. Services
3. Lifecycle
4. Remote execution

Reduce header noise:
1. keep project status badge only.
2. move secondary actions into one overflow menu.

### 6) Runtime image + bootstrap contract

Public node image must guarantee:
1. `hack` CLI present and executable
2. optional tailscale userspace runtime
3. deterministic config/project roots
4. explicit startup logs for endpoint + auth mode

### 7) Documentation + onboarding

Ship one clear setup narrative:
1. Host machine setup
2. Node machine setup
3. Pairing flow
4. First remote project run
5. Troubleshooting by signature

## Milestones

### M0: Role and flow spec lock
1. Finalize role model semantics and migration behavior.
2. Lock reduced project settings IA.

### M1: Host/node role wiring
1. Add persisted global role state.
2. Gate topology/settings controls based on role.

### M2: Pairing acceleration
1. Add tailnet discovery candidate prefill.
2. Improve endpoint/source inference hints and walkthrough ergonomics.

### M3: One-click provider bootstrap
1. Move minimal provider bootstrap controls into topology add-node flow.
2. Keep advanced options collapsed.

### M4: Project remote defaults UX
1. Replace verbose remote controls with 2-field model (node + git creds).
2. Keep managed workspace map behavior as default.

### M5: Runtime image hardening + docs
1. Publish validated runtime image profile.
2. Update runbooks and troubleshooting docs.

## Ticket mapping

1. `T-00163` Global host/node/hybrid role model + UI gating.
2. `T-00164` Topology add-node quick actions + tailnet candidate discovery.
3. `T-00165` Pairing walkthrough DX pass (auto-prefill + actionable errors).
4. `T-00166` Project remote-execution settings IA simplification.
5. `T-00167` Topology-driven one-click provider bootstrap (Railway first).
6. `T-00168` Node runtime image hardening + filesystem contract docs.
7. `T-00169` Remote node onboarding docs: host vs node quickstart.

## Acceptance criteria

1. New user can connect a remote node from app topology in under 2 minutes.
2. Existing user can route a project to remote with two explicit selections (node, git creds).
3. Node-only mode hides host/controller mutation controls consistently.
4. `docs/guides/remote-node-laptop-e2e.md` plus provider guides fully cover first-run and recovery paths.
5. E2E matrix (`T-00158`) passes on second MacBook and Railway private node.

## Open questions

1. Should `hybrid` remain visible in UI, or be an advanced-only hidden mode?
2. For tailnet discovery, should we auto-suggest only nodes with `hack` gateway health signal, or all reachable devices first?
3. Should provider bootstrap always create non-default nodes unless user explicitly promotes?
