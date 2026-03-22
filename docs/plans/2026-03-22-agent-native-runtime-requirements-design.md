# Agent-Native Runtime Requirements For Hack

## Context

Hack already supports the workflows that the future runtime has to serve:

- branch-scoped local environments with `hack up --branch <name>`
- isolated agent sessions with `hack session start <project> --new --name agent-1`
- managed host lifecycle processes declared in `.hack/hack.config.json`
- gateway and supervisor jobs/shells for remote control-plane access
- controller-to-node execution with workspace bootstrap, branch ensure, route bridging, and optional Mutagen sync
- remote devcontainer startup on node workspaces

The runtime question is not whether Hack needs containers in the abstract. It is whether the runtime can preserve these workflows without pushing users back toward ad hoc Docker, tmux, SSH, port-forwarding, and one-off bootstrap scripts.

The linked Linear spec was not retrievable anonymously during this session, so this requirements set is derived from the current repo docs and command surface.

## Source Workflows

These are the concrete workflows the runtime must satisfy.

### WF-1: Parallel branch environments on one machine

One repo can run multiple branch instances at once. Each instance needs separate routing, service state, logs, and cleanup while still feeling like the same Hack project.

Examples:

- `hack up --branch feature-a --detach`
- `hack open --branch feature-a`
- `hack logs --branch feature-a`
- `hack down --branch feature-a`

### WF-2: Agent-heavy local work with isolated sessions

Agents need durable PTYs that outlive one CLI invocation. They also need cheap, isolated session creation so a main agent and several subagents can work in parallel without sharing one terminal or stomping on each other.

Examples:

- `hack session start <project>`
- `hack session start <project> --new --name agent-1`
- `hack session exec <session> "bun test"`
- `hack session capture <session>`

### WF-3: Host-side helpers managed as part of project runtime

Many projects need host-native helpers that are not container workloads: auth bootstrap, local tunnels, proxies, and credential refresh loops. Hack treats these as part of runtime, not as separate user-managed tabs.

Examples:

- `lifecycle.up.before`
- `lifecycle.processes`
- `hack logs <lifecycle-process>`

### WF-4: Remote control-plane execution

Remote clients, desktop surfaces, and agents need a stable API for jobs, shells, sessions, env resolution, and project discovery. This has to keep working when the caller is not on the same machine as the repo checkout.

Examples:

- `GET /v1/projects`
- `POST /control-plane/projects/:projectId/jobs`
- `WS /control-plane/projects/:projectId/jobs/:jobId/stream`
- `POST /control-plane/projects/:projectId/shells`

### WF-5: Controller local-edit, remote-run

Hack can run a project on a remote node while the developer edits locally. That means the runtime has to support workspace bootstrap, branch ensure, local-to-remote sync, and local route bridging back to the remote project.

Examples:

- `hack up --target auto`
- `hack dispatch run --project <name|id> --node default --branch <branch> --runner generic -- "pwd"`
- `POST /v1/node/workspaces/ensure`
- `hack node routes status`

### WF-6: Fresh-node bootstrap and devcontainers

Hack can bring up a new node, clone a repo, enable gateway access, and optionally start a devcontainer in the resolved workspace. The runtime cannot assume the workspace already exists or that bootstrap is manual.

Examples:

- container bootstrap via `hackdance/hack:latest`
- `POST /v1/node/devcontainers/up`
- `hack node devcontainer up --node <node-id> --project <project> --branch <branch>`

## Mandatory Requirements

These are architecture gates. If an option cannot satisfy them, it is the wrong runtime for Hack.

### 1. Project Instance Isolation

- The runtime unit must be a Hack project instance, not just a raw container.
- A project instance must be addressable by at least:
  - project id or name
  - workspace root
  - branch instance identity
- Two branch instances of the same project must be able to run concurrently on one machine without host-port collisions, network alias collisions, log collisions, or teardown ambiguity.
- Cleanup must be instance-scoped. `hack down --branch foo` must not disturb the base instance or other branches.
- Runtime-generated names, mounts, and caches must be deterministic enough for Hack to rediscover and manage them after CLI or daemon restart.

Why this is Hack-specific:
Hack already exposes branch instances as a user-facing concept. The runtime has to preserve that abstraction instead of flattening everything into one mutable project.

### 2. First-Class Hack Networking

- Each project instance must be routable through Hack hostnames without manual per-service port management.
- The runtime must support the equivalent of Hack’s current label-driven ingress model so `hack open`, browser access, and OAuth callback flows keep using stable hostnames.
- Containers and host-managed helpers must be able to resolve and trust the same Hack URLs from inside the runtime.
- Dynamic route repair is mandatory. If proxy IP, runtime identity, or bridge state changes, Hack must be able to detect drift and reconcile it.
- Local bridge routes for remote execution are mandatory. A controller machine must be able to keep `https://<project>.hack` working while the actual service runs on a remote node.

Why this is Hack-specific:
Hack is not just starting services. It is creating a stable local domain model that spans browser access, container-to-container calls, host helpers, and remote-node bridge routes.

### 3. Sessions As Runtime Objects

- Persistent sessions must remain first-class even if the container runtime changes.
- The runtime must support durable named execution homes for:
  - human terminals
  - agent shells
  - lifecycle-owned host processes
- Sessions need create, list, exec, capture, tail, input, and stop operations through Hack’s local API surface.
- Session identity must survive CLI disconnects and be discoverable after daemon restart.
- Long-lived PTYs and one-shot jobs must be separate primitives. Hack needs both.

Why this is Hack-specific:
Hack is explicitly agent-native. Durable PTYs are part of the product surface, not a debugging convenience.

### 4. Cheap Concurrent Execution For Subagents

- The runtime must make it cheap to create multiple isolated execution contexts under the same project instance.
- Subagents need isolated cwd, env, and terminal state even when they share the same branch workspace.
- The runtime must support both:
  - short-lived command jobs with streamed output and exit status
  - long-lived interactive shells
- Runs need stable ids plus persisted metadata such as project, branch, runner, ticket, and timestamps.
- Cancellation must be explicit and reliable. Orphaned jobs or zombie shells are not acceptable.

Why this is Hack-specific:
Hack is trying to coordinate real multi-agent work, not just a single foreground shell.

### 5. Host-Native Lifecycle Integration

- The runtime must treat host-native helper processes as part of project runtime state.
- Hack must be able to start, monitor, log, and stop lifecycle processes using the same project instance model as services.
- Lifecycle failure must participate in startup correctness. If a required hook fails, runtime startup must fail clearly.
- Lifecycle teardown must be deterministic and scoped to the relevant branch or project instance.

Why this is Hack-specific:
Projects regularly need host-only auth, tunnel, and proxy processes. A runtime that only models containers would force users back to unmanaged terminal tabs.

### 6. Remote Workspace Bootstrap And Branch Ensure

- Given only project identity plus bootstrap hints, a remote node must be able to:
  - resolve or create a workspace
  - clone the repo if needed
  - ensure the requested branch
  - register the workspace back into Hack’s project map
- Bootstrap must be idempotent and diagnosable. Failures need machine-readable reasons such as auth source, clone failure, or origin mismatch.
- The runtime must support controller local-edit, remote-run flows without assuming manual SSH setup beyond Hack’s pairing/bootstrap path.
- Workspace identity on the node must remain stable enough for later dispatch, session reuse, and devcontainer startup.

Why this is Hack-specific:
Hack treats remote nodes as an extension of local development, not as generic CI workers.

### 7. Control-Plane Native Runtime Introspection

- The runtime must expose enough local state for Hack to answer:
  - what projects and instances exist
  - which services, sessions, jobs, and lifecycle processes are active
  - how to attach or stream into them
  - whether the runtime is healthy, stale, or degraded
- This data must be available through a local API that the CLI, desktop app, and remote gateway can share.
- The gateway must continue to enforce project opt-in, token scopes, and write gating on top of the runtime.
- Runtime operations that mutate state must remain auditable.

Why this is Hack-specific:
Hack’s control plane is already part of the product architecture. The runtime has to be legible to that control plane, not hidden behind opaque shell-outs.

### 8. Recovery As A First-Class Capability

- The runtime must detect identity drift and reset conditions instead of silently failing.
- Hack must be able to distinguish:
  - runtime unavailable
  - runtime reset
  - stale cached state
  - incompatible daemon or control-plane state
- Jobs, shells, sessions, and route bridges must support reconnect or repair by stable id where possible.
- Recovery must prefer safe auto-repair for stale local state and explicit guidance for unsafe cases.
- A daemon restart must not make active project instances undiscoverable.

Why this is Hack-specific:
Hack already has daemon fallback, remote bridging, and session semantics. Recovery failures here are visible product failures, not just operator inconvenience.

## Nice-To-Have Requirements

These materially improve the runtime, but they should not block initial architecture selection.

### 1. First-Class Devcontainer Tracking

- Model node devcontainers as tracked runtime objects rather than opaque shell commands.
- Preserve attach hints and lifecycle metadata so IDE handoff is deterministic.

### 2. Policy-Aware Placement

- Let Hack choose between local runtime, remote node, and provider bootstrap using labels, profiles, or policy without changing the project abstraction.

### 3. Resource Accounting Per Project Instance

- Expose CPU, memory, disk, and network attribution per project instance and branch instance.
- Surface quota and pressure signals to CLI and desktop.

### 4. Warm Snapshot Or Fast Resume

- Support pausing and resuming branch instances or remote workspaces faster than full cold boot.
- This is valuable for agent-heavy workflows but not required to prove correctness.

### 5. Better Cross-Machine State Portability

- Make it easier to move project runtime state, env contracts, and workspace metadata between controller and node without rebuilding everything from scratch.

## Workflow Traceability

This is the minimum traceability map for architecture review. Every mandatory requirement should be justified by at least one real Hack workflow, and every source workflow should be protected by more than one runtime capability where appropriate.

| Workflow | Primary requirements it drives |
| --- | --- |
| WF-1 Parallel branch environments | Project Instance Isolation, First-Class Hack Networking, Recovery As A First-Class Capability |
| WF-2 Agent-heavy local work | Sessions As Runtime Objects, Cheap Concurrent Execution For Subagents, Control-Plane Native Runtime Introspection |
| WF-3 Host-side helpers | Host-Native Lifecycle Integration, Sessions As Runtime Objects, Recovery As A First-Class Capability |
| WF-4 Remote control-plane execution | Control-Plane Native Runtime Introspection, Cheap Concurrent Execution For Subagents, Recovery As A First-Class Capability |
| WF-5 Controller local-edit, remote-run | Remote Workspace Bootstrap And Branch Ensure, First-Class Hack Networking, Control-Plane Native Runtime Introspection, Recovery As A First-Class Capability |
| WF-6 Fresh-node bootstrap and devcontainers | Remote Workspace Bootstrap And Branch Ensure, Control-Plane Native Runtime Introspection |

## Explicit Non-Requirements

These should not distort the architecture discussion.

- Hack does not need a general multi-tenant cluster scheduler.
- Hack does not need Kubernetes compatibility as a goal by itself.
- Hack does not need to replace tmux/zellij semantics with an entirely different UX if the current session model already works.
- Hack does not need a runtime that only optimizes container startup while breaking hostname stability, session durability, or remote-node bootstrap.

## Architecture Evaluation Scorecard

A candidate runtime should be evaluated against these questions before implementation work starts.

### Reject If Any Answer Is No

1. Can it run multiple branch instances of one project concurrently with deterministic routing and cleanup?
2. Can Hack continue to present stable `*.hack` hostnames locally, inside services, and through remote route bridges?
3. Can it host durable named sessions and interactive shells that survive CLI disconnects?
4. Can it support many concurrent subagent jobs and shells without shared-terminal interference?
5. Can it model host-native lifecycle processes as part of project runtime state?
6. Can a remote node bootstrap a missing workspace, ensure a branch, and expose it back through the control plane?
7. Can Hack observe runtime state through a local API instead of best-effort scraping only?
8. Can it recover cleanly from runtime resets, stale state, and daemon restarts without losing project identity?

### Strong Preference Questions

1. Does the design reduce the amount of Docker-specific glue Hack has to maintain today?
2. Does it make remote-node and local-runtime code paths more uniform instead of more divergent?
3. Does it reduce the amount of ad hoc state that lives outside Hack’s project and control-plane models?
4. Does it make job, shell, session, and lifecycle logging more coherent?
5. Does it make architecture simpler for the desktop app, CLI, and gateway consumers?

## Required Prototype Evidence

The evaluation loop should not accept slideware or narrow happy-path demos. A runtime spike should prove each mandatory capability with direct evidence and should avoid the false positives listed here.

| Requirement | Minimum proof for architecture evaluation | False positive to avoid |
| --- | --- | --- |
| Project Instance Isolation | Start two branch instances of one repo, confirm independent routing, logs, and teardown, then restart the daemon/CLI and rediscover both instances by stable identity. | Demoing two unrelated projects or two manual ports instead of true branch-instance isolation. |
| First-Class Hack Networking | Prove stable `*.hack` access from browser, from inside a service, and through a controller-side remote route bridge to a node-hosted workload. Then force drift and show route repair. | Showing only host-to-container localhost access or static port mappings with no hostname model. |
| Sessions As Runtime Objects | Create named sessions, reconnect after CLI exit, exec commands, capture/tail output, and stop them through the local API surface. | Replacing durable sessions with plain subprocesses that die when the caller disconnects. |
| Cheap Concurrent Execution For Subagents | Run several concurrent jobs and interactive shells against one project instance, with isolated terminal state, streamed output, stable run ids, and reliable cancellation. | Serial command execution or one shared PTY presented as “multi-agent support.” |
| Host-Native Lifecycle Integration | Start a project with required host hooks and persistent helper processes, surface them in logs and runtime state, then tear them down cleanly with the project instance. | Treating host helpers as external prerequisites or unmanaged terminal tabs. |
| Remote Workspace Bootstrap And Branch Ensure | On a fresh node, bootstrap the repo from hints only, ensure a branch, record bootstrap auth source, and reuse the workspace for later dispatch or devcontainer startup. | Assuming the workspace was pre-cloned or manually prepared outside Hack. |
| Control-Plane Native Runtime Introspection | Use one runtime-backed API surface to list projects, instances, jobs, shells, sessions, and lifecycle processes for both local CLI and gateway consumers. | Scraping ad hoc shell output differently in each client and calling that a control plane. |
| Recovery As A First-Class Capability | Simulate runtime reset or stale daemon state, distinguish the failure mode, preserve discoverability of live instances, and prove reconnect or guided repair by stable identity. | Only proving clean-start behavior and ignoring reset, drift, or stale-state recovery. |

## Recommendation For Option Evaluation

When comparing runtime architectures, score them against the mandatory set first and only discuss performance, implementation language, or operator simplicity after that gate passes.

The main mistake to avoid is choosing a runtime that is good at generic container orchestration but weak at Hack’s actual product surface: branch instances, agent sessions, host helpers, remote-node bootstrap, and control-plane-visible recovery.
