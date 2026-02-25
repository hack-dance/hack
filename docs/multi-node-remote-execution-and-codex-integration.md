# Multi-Node Remote Execution + Codex Integration Plan (2026-02-21)

## Goal
Ship a controller-led, multi-node execution system where lightweight node agents run on Linux/macOS hosts, execute branch-scoped jobs remotely, enforce policy approvals for risky writes, persist durable run artifacts into the tickets git channel, and optionally automate GitHub PR workflows.

This document is the durable source of truth for M1-M9 progress, remaining gaps, and implementation sequencing.

Related:
1. Provider composition and project-level override model:
   - `docs/provider-composition-and-project-overrides.md`
2. DX simplification and onboarding execution plan:
   - `docs/remote-node-dx-and-onboarding-simplification.md`

## Decision-Locked Architecture
1. Single controller owns node registry and dispatch routing.
2. Each node runs its own gateway (`hackd`), no central relay in v1.
3. Controller-to-node uses endpoint + scoped token.
4. Node agent is built into `hackd` via node routes/control-plane integration (no extra daemon in v1).
5. Linux/macOS are v1 production targets, Windows is WSL/manual preview.
6. Manual install is first onboarding path; AWS EC2/SSM is first provider automation.
7. Risky writes require explicit policy approval (interactive or explicit flag).
8. Artifacts are canonical in git-backed tickets/runs channel with local spool fallback.
9. GitHub App installation token is the first production SCM auth mode.
10. Existing single-node behavior remains unchanged when no node config is set.

## Current Baseline
Implemented:
1. Node registry + node CLI commands (`init/add/list/status/use/remove`).
2. Node health/status routing (`GET /v1/node/status`) and node workspace/devcontainer route spine.
3. Project-level execution routing (`controlPlane.execution.mode`, `controlPlane.execution.nodeId`) with legacy `controlPlane.nodeId` fallback and global cluster defaults (`defaultNodeId`, stale/offline thresholds).
4. Dispatch command spine (`run/status/logs`) with node selection (explicit/project/default/auto).
5. Risk classification module and approval gating in dispatch.
6. Local run spool with run record/events/logs/artifact files under `~/.hack/registry/runs/<runId>/`.
7. Gateway e2e and multi-node unit harness coverage.
8. Dispatch controller->node gated e2e harness (`bun run test:e2e:dispatch`).
9. GitHub App token refresh flow (JWT -> installation token exchange) with expiry-aware auth resolution.
10. Secret backend strategy contract + `hack env backend status/use` CLI.

Known open gaps:
1. Provider automation hardening (AWS/Hetzner/GCP parity) and feedback->run->PR flow command.
2. Additional e2e coverage for manual clean-machine onboarding + provider bootstrap paths.
3. Encrypted-file backend and cloud-provider shim adapters are implemented; provider-native cloud transports are still pending.
4. Published node-runtime container channel + clean-host onboarding validation.
5. Private-repo bootstrap auth still needs first-class distribution flow for fresh-node clone paths.

Recent provider addition:
1. Railway bootstrap path is now available via `hack node provider railway bootstrap` for quick external node bring-up using Railway CLI + node runtime image.

## Ticket Mapping
Active tickets:
1. `T-00044` Multi-node registry + node CLI.
2. `T-00045` Node status API.
3. `T-00048` Project node assignment/routing.
4. `T-00052` Multi-node docs/tests.
5. `T-00108` Policy engine + approval auditing.
6. `T-00109` Canonical artifact pipeline into tickets/runs channel.
7. `T-00110` GitHub App SCM extension + PR automation.
8. `T-00111` Devcontainer lifecycle + IDE attach bridge.
9. `T-00112` AWS EC2/SSM bootstrap.
10. `T-00113` Feedback->run->PR flow.
11. `T-00114` Remote workspace bootstrap + dispatch e2e coverage.
12. `T-00118` Published node-runtime container image + bootstrap docs.
13. `T-00116` GitHub App JWT -> installation token exchange in connect flow.
14. `T-00117` Env/secret backend strategy contract + CLI.
15. `T-00141` GitHub extension multi-account profiles + routing selection.
16. `T-00142` GitHub one-click OAuth/device flow + installation picker.
17. `T-00143` Dispatch/macOS GitHub profile selection + PR-run linkage.
18. `T-00162` Node-local workspace map + managed remote project roots.
19. `T-00163` Global host/node/hybrid role model + UI gating.
20. `T-00164` Topology add-node quick actions + tailnet candidate discovery.
21. `T-00165` Pairing walkthrough DX pass (auto-prefill + actionable errors).
22. `T-00166` Project remote-execution settings IA simplification.
23. `T-00167` Topology-driven one-click provider bootstrap (Railway first).
24. `T-00168` Node runtime image hardening + filesystem contract docs.
25. `T-00169` Remote node onboarding docs: host vs node quickstart.

## M1-M3 Acceptance Summary
M1:
1. Node registry CRUD/default/health transitions implemented.
2. `hack node add/list/use/remove/status` operational.
3. `GET /v1/node/status` implemented and wired.

M2:
1. `hack node init` emits enrollment bundle.
2. `hack node add --bundle` imports + probes node.
3. Manual onboarding flow exists and needs clean-machine rehearsal docs hardening.

M3:
1. `hack dispatch run` resolves node via explicit/project/default/auto.
2. Calls workspace ensure and then creates remote supervisor job.
3. Streams logs/events and persists local run artifacts.
4. Remaining gaps: private-repo bootstrap auth handoff and clean-host e2e hardening.

## M4-M7 Implementation Plan
### M4: Policy Engine + Durable Audit (`T-00108`)
1. Promote policy decision flow into dedicated engine module.
2. Persist every decision (approved/denied, mode, actor, rationale) to:
   - local policy audit log
   - run event stream
   - ticket event stream when `--ticket` is provided
3. Denied approvals must create durable run/audit evidence and fail safe in non-interactive mode.

### M5: Canonical Artifact Pipeline (`T-00109`)
1. Keep local spool under `~/.hack/registry/runs`.
2. Mirror canonical artifacts to tickets git channel under:
   - `.hack/tickets/runs/<runId>/summary.md`
   - `.hack/tickets/runs/<runId>/patch.diff`
   - `.hack/tickets/runs/<runId>/tests.json`
   - `.hack/tickets/runs/<runId>/logs.txt`
   - `.hack/tickets/runs/<runId>/manifest.json`
   - `.hack/tickets/runs/<runId>/run.json`
   - `.hack/tickets/runs/<runId>/events.jsonl`
3. Append run lifecycle events into tickets event log when ticket context exists.
4. Enforce artifact sanitization and bounded logs.

### M6: GitHub App SCM (`T-00110`)
1. Add `dance.hack.github` extension skeleton and commands for status + PR upsert.
2. Use GitHub App installation token (in secret store/env/config ref) for least-privilege API operations.
3. Add dispatch `--pr` mode to:
   - optionally push branch
   - create or update PR
   - post artifact summary comment
4. Persist PR linkage into run/ticket artifacts/events.
5. Added in this pass:
   - `hack x github connect` + `disconnect` with keychain-backed token storage.
   - keychain-first token resolution in both extension commands and dispatch `--pr` flow.
   - GitHub App mode in `hack x github connect` (`--app-id`, `--installation-id`, private key sources).
   - automatic token refresh on expiry using configured App credentials.

### M6.1: GitHub Account UX + Profiles (`T-00141`, `T-00142`, `T-00143`)
1. Add profile-aware GitHub extension config for multiple accounts/installations.
2. Add one-click OAuth/device-flow connect and installation selection UX.
3. Make dispatch/macOS PR flows profile-aware with deterministic precedence:
   - command flag
   - project override
   - global default profile
4. Persist selected GitHub profile/account metadata in run/ticket artifacts.

### M7: Controller Devcontainer Bridge (`T-00111`)
1. Add node CLI devcontainer commands:
   - `hack node devcontainer up --node <id> --project <name|id> --branch <branch>`
   - `hack node devcontainer down --node <id> --id <sessionId>`
   - `hack node devcontainer attach --ide <cursor|vscode|claude|codex> --node <id> --id <sessionId>`
2. Use node gateway endpoints for lifecycle.
3. Generate attach instructions over SSH baseline.
4. Added in this pass:
   - richer `attach` output with SSH metadata and IDE-specific command hints (`--ssh-host/--ssh-port/--ssh-user/--ssh-alias`).

## M3.5: Fresh-Node Workspace Bootstrap (`T-00114`)
1. Extended `/v1/node/workspaces/ensure` to accept `bootstrap` payload (`repo_url`, optional `project_name`, optional `project_root`).
2. Node can clone/register missing projects on demand and then continue branch ensure + job execution.
3. Dispatch now sends bootstrap hints from controller-local git origin metadata.
4. Added endpoint-level test coverage for bootstrap clone + legacy no-bootstrap behavior.
5. Added gated dispatch e2e coverage to validate controller->node workspace ensure, job stream, and artifact persistence.

## M3.6: Node-Local Workspace Mapping + Managed Roots (`T-00162`)
1. Add node-managed workspace root default:
   - `$HOME/.hack/projects/<project-slug>/`
2. Add node-local mapping store:
   - `$HOME/.hack/projects.config.json`
3. Map controller-side project identity to node-side workspace identity and root path so controller/remote paths can differ safely.
4. Update workspace ensure resolution order:
   - explicit mapped workspace
   - existing registered node project
   - managed-root clone/bootstrap
   - actionable failure
5. Support pre-existing manual workspaces on node as external attachments (no forced relocation).
6. Treat this as a prerequisite for seamless local-edit/remote-run sync work (`T-00159`).
7. Dispatch workspace ensure payload should include controller identity metadata:
   - `controller_project_id`
   - `controller_project_name`
   so node mappings stay stable even when node-local project ids differ.
8. Added node-local workspace map CLI repair surface:
   - `hack node workspace list`
   - `hack node workspace resolve --project <name|id>`
   - `hack node workspace attach --project <name|id> --path <workspace-root>`
   - `hack node workspace remove --project <name|id>`
9. Added tests for map selection helpers and bootstrap/map recovery paths:
   - `tests/node-workspace-command.test.ts`
   - `tests/node-workspace-bootstrap.test.ts`

## M3.7: Local Edit -> Remote Run Sync Spine (`T-00159`)
1. Gate sync to `controlPlane.execution.mode = local_edit_remote_run` only.
2. Implement first production sync engine as Mutagen (`one-way-safe`) before remote job create.
3. Persist node SSH source (`NodeRecord.source`) from pairing flow so controller can derive SSH transport for sync sessions.
4. Session model:
   - deterministic per project/node/branch
   - create-if-missing + flush-before-run
   - default excludes: `.git`, `.hack/.internal`, `.DS_Store`, plus config excludes.
5. Explicit failure handling:
   - missing local project root
   - missing node SSH source metadata
   - missing Mutagen binary
   - sync create/flush command failures
6. Persist sync metadata in run events + run artifacts manifest/summary for audit/debug.

## M2.5: Containerized Node Runtime (`T-00118`)
1. Add `docker/node-runtime` image with entrypoint-driven bootstrap:
   - optional repo clone
   - optional project init
   - gateway config enablement
   - optional enrollment bundle emission
2. Add build/publish automation:
   - `scripts/build-node-runtime-image.ts`
   - GHCR publish workflow (`release-node-runtime-image.yml`)
3. Add operator docs for env-based deployment and controller registration flow.

## Codex Integration Plan
### Why
Unify remote execution with Codex-driven implementation workflows, especially feedback->issue->run->PR loops.

### Integration Surfaces
1. Codex SDK:
   - primary for deterministic non-interactive backend runs on remote nodes.
   - best fit for dispatcher/worker automation.
2. Codex App Server:
   - primary for interactive session management/embedding in desktop app.
   - maps to long-lived session/thread orchestration and richer control semantics.
3. MCP:
   - primary for IDE tool integration and local assistant workflows.

### Recommended rollout
1. Phase A: dispatch runner adapter for Codex SDK (`runner=codex` path hardening).
2. Phase B: optional App Server bridge for interactive remote sessions.
3. Phase C: flow command that chains ticket context -> dispatch -> artifact -> PR update.

## Testing and Quality Gates
Required command gates:
1. `bun x tsc --noEmit`
2. `bun test`
3. `bun run test:e2e:gateway`
4. `bun run test:e2e:dispatch`
5. `bun x ultracite check` (warnings tracked separately under complexity refactor tickets)

Targeted scenarios:
1. Node registry health transitions and default selection.
2. Dispatch route selection precedence and fallback behavior.
3. Approval-required flows in interactive and non-interactive modes.
4. Artifact persistence local + tickets channel consistency.
5. Devcontainer up/down/status through controller->node bridge.
6. PR automation dry-run and real-run behavior with GitHub App token.
7. Containerized node bootstrap on clean host with enrollment bundle import.

## Immediate Next Steps
1. Run full remote-node e2e matrix on second MacBook + Railway private (`T-00158`) with runbook capture (`docs/guides/remote-node-laptop-e2e.md`).
2. Fix topology refresh reliability regression where node list can appear empty on first load (`T-00160`).
3. Execute DX simplification tracks from the dedicated plan:
   - role model + UI gating (`T-00163`)
   - topology add-node quick actions (`T-00164`)
   - pairing walkthrough polish (`T-00165`)
   - project IA simplification (`T-00166`)
   - provider one-click bootstrap UX (`T-00167`)
4. Harden node runtime image + filesystem contract and docs (`T-00168`, `T-00169`, `T-00118`).
5. Run full quality gates and reduce complexity hotspots tracked in `T-00161`.
6. Expand GitHub App coverage with connect/command integration tests for CLI UX edge cases.
7. Add controller command bridge for provider bootstrap (`T-00112`) starting with AWS SSM path.
8. Implement `hack flow feedback-pr` end-to-end ticket workflow (`T-00113`).
