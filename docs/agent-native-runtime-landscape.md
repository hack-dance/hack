# Agent-Native Runtime Landscape

Updated: March 13, 2026

This document surveys the runtimes and adjacent systems that are most relevant to Hack's next runtime baseline. It is intentionally decision-oriented: the goal is not to catalog everything in the market, but to extract the architecture and control-plane patterns that should shape Hack's future runtime work.

This analysis uses the current Hack implementation as the local baseline, especially [architecture.md](architecture.md) and [gateway.md](gateway.md). Primary claims below were validated against official project documentation on March 13, 2026. The referenced Linear Zig runtime spec URL was reachable but did not expose readable content from this workspace during authoring, so any "future runtime" implications below are inferred from the issue scope plus the current repo architecture.

For the concrete backend contract derived from this survey, see [agent-native-runtime-provider-capabilities.md](agent-native-runtime-provider-capabilities.md).

## Executive Summary

### Emulate

- Keep a simple app model like Compose: a small project graph, explicit services, explicit optional profiles, and a human-editable source of truth.
- Treat recovery as a first-class design area, not an afterthought. Nomad's separation between local restart and scheduler-level reschedule is the right conceptual model for Hack.
- Keep the control plane optional and least-privilege by default. Podman and Hack already point in the right direction: local sockets first, remote access only through deliberate exposure.
- Preserve stable service identity across local and remote environments. Dev Containers and DevPod show the value of a portable environment contract even when the underlying runtime changes.
- Make inactivity handling and resume semantics explicit. DevPod's stop/resume model is more aligned with agent workflows than "everything runs forever."
- Model resources and dependencies explicitly. Tilt's resource graph is a better mental model for agent-driven orchestration than raw "bring everything up."

### Avoid

- Do not make Hack's baseline depend on a heavyweight cluster scheduler, CRD ecosystem, or Kubernetes object model.
- Do not tie the control plane to an always-on network listener. Local sockets plus opt-in remote gateways are safer.
- Do not rely on engine-specific health or restart heuristics as the sole source of truth. They are useful inputs, not the whole runtime state model.
- Do not make the runtime spec synonymous with dev environment configuration. Dev Containers are a good interchange layer, but they are not a sufficient runtime architecture by themselves.

### Defer

- Full cluster scheduling, placement optimization, and multi-node failover.
- VM-backed isolation as the baseline local path.
- Rich live-reload/build-loop features like Tilt's `live_update`; these are useful higher-level accelerators, not the core runtime substrate.
- A containerd-native baseline unless Hack is ready to own more low-level networking, image, and lifecycle wiring.

## Evaluation Dimensions

The systems below were compared against the dimensions Hack actually cares about:

- Architecture and composition model
- Isolation and security boundaries
- Networking and service identity
- Recovery and restart behavior
- Control-plane and API shape
- Portability across local, remote, and agent-driven workflows

## At-A-Glance Comparison

| System | Primary Value | Best Pattern To Borrow | Main Risk For Hack |
| --- | --- | --- | --- |
| Docker Engine + Compose | Ubiquitous local baseline | Simple service graph, profiles, health-gated startup | Weak control-plane semantics and engine coupling |
| Podman | Rootless, daemon-light container runtime | Socket-activated API, rootless bias, Kubernetes YAML bridge | Linux-centric operational edges and compatibility drift |
| containerd + nerdctl + CNI | Embedded runtime substrate | Clear layering and namespace support | Higher integration burden for networking and UX |
| Dev Containers spec | Portable environment contract | Reusable workspace definition, lifecycle hooks, prebuilds | Config spec is not a runtime/control plane |
| DevPod | Provider abstraction over devcontainers | Provider model, stop/resume, SSH-first workspace access | Workspace-centric model can be heavier than project-local orchestration |
| Colima + Lima | Practical macOS substrate adapter | Explicit VM/network/mount capabilities over Docker or containerd | VM indirection changes networking and filesystem assumptions |
| Tilt | Explicit resource graph for inner-loop dev | Dependency graph, selective enablement, readiness-driven orchestration | High complexity and implicit build-loop behavior |
| Nomad | Clear runtime and scheduler semantics | Restart vs reschedule split, pluggable drivers | Scheduler scope is broader than Hack's baseline need |

## Survey

### 1. Docker Engine + Compose

Relevant sources:

- [Compose profiles](https://docs.docker.com/compose/how-tos/profiles/)
- [Compose startup order and health checks](https://docs.docker.com/compose/how-tos/startup-order/)
- [Restart policies](https://docs.docker.com/engine/containers/start-containers-automatically/)
- [Live restore](https://docs.docker.com/engine/daemon/live-restore/)
- [Storage driver notes](https://docs.docker.com/engine/storage/drivers/overlayfs-driver/)

Architecture:

- Compose remains the simplest widely adopted model for describing a local multi-service app.
- Profiles are a practical mechanism for optional resources without introducing a separate scheduler.
- The model is declarative enough for humans, but the real control plane still lives in the Docker engine and CLI.

Isolation:

- Isolation is container-first and engine-managed.
- On Linux, storage defaults still center on OverlayFS-style copy-on-write layers, and newer Docker installs now use the containerd image store by default.
- Isolation is good enough for local app services, but not a strong agent boundary on its own.

Networking:

- Compose gives stable service naming within a project network, but Hack already had to add Caddy, CoreDNS, and `extra_hosts` repair logic to get durable host/container identity across developer workflows.
- Compose health-aware dependency ordering is useful, but it is still startup coordination, not a full dependency or recovery graph.

Recovery:

- Docker restart policies and live restore are valuable primitives.
- They are still daemon-centric. They help containers survive daemon restarts or restart after exits, but they do not provide a richer runtime state machine for agent tooling.

Control plane:

- The Docker API is widely supported, but it is an engine API rather than an app-centric project control plane.
- Hack's current `hackd` layer already exists because raw engine data is not enough for Hack's UX.

Implications for Hack:

- Emulate Compose's small, explicit project model and profiles.
- Keep Compose compatibility or importability for the near term.
- Avoid making Docker engine state the sole source of truth for project/runtime state.
- Defer any attempt to compete with Docker as a general-purpose container engine.

### 2. Podman

Relevant sources:

- [Podman system service](https://docs.podman.io/en/latest/markdown/podman-system-service.1.html)
- [Podman network create](https://docs.podman.io/en/latest/markdown/podman-network-create.1.html)
- [Podman kube play](https://docs.podman.io/en/latest/markdown/podman-kube-play.1.html)
- [Podman systemd units / Quadlet](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html)

Architecture:

- Podman is attractive because it reduces the "always-running daemon" assumption and leans into system tooling such as systemd socket activation and generated service units.
- Its API service is optional and can be activated on demand, which matches Hack's "optional daemon/control plane" philosophy better than Docker's default posture.

Isolation:

- Podman has strong rootless and user namespace stories, which matter if Hack wants a safer local agent substrate.
- The platform still has meaningful Linux-first behavior differences, especially around networking and host access.

Networking:

- Podman exposes network choices more explicitly. Internal bridge networks, network-scoped DNS, and route settings are first-class.
- Rootless networking has real constraints. That is a benefit for security clarity, but it also makes "just make the host visible everywhere" less reliable than many Docker users assume.

Recovery:

- Systemd integration is the headline pattern here. Socket activation and generated units create a crisp relationship between desired state and host process supervision.
- `kube play --replace` is also a good example of an idempotent reconcile operation on top of a local runtime.

Control plane:

- Podman's API docs are unusually direct about security: local socket access is the security model, and remote TCP exposure should be avoided unless mutually authenticated.
- That advice maps almost exactly to how Hack should treat its own remote control surface.

Implications for Hack:

- Emulate the optional API/socket-activation pattern.
- Emulate the bias toward local socket control and explicit remote exposure.
- Borrow the idea that "reconcile from declarative input" can be a first-class local runtime operation.
- Avoid a Linux-only baseline if Hack still needs broad macOS-first developer ergonomics.

### 3. containerd + nerdctl + CNI

Relevant sources:

- [containerd README](https://github.com/containerd/containerd)
- [nerdctl README](https://github.com/containerd/nerdctl)
- [CNI overview](https://www.cni.dev/)
- [CNI plugin overview](https://www.cni.dev/plugins/current/main/)

Architecture:

- containerd is explicit about its intended role: it is designed to be embedded into a larger system.
- That makes it architecturally relevant to Hack's long-term direction. A future Hack runtime could reasonably sit on top of containerd rather than on top of Docker CLI behaviors.
- nerdctl demonstrates that a Docker-like UX can be rebuilt over containerd, including Compose-style workflows.

Isolation:

- containerd gives a cleaner layering boundary between runtime, image store, snapshotters, and higher-level tooling.
- The cost is that Hack would own more assembly work: image build integration, rootless setup, network plugins, and cross-platform packaging become Hack responsibilities.

Networking:

- nerdctl depends on CNI plugins for container networking.
- CNI's strength is narrow scope: it focuses on network connectivity and cleanup, with plugins for bridge, `ptp`, `macvlan`, `ipvlan`, and others.
- That narrowness is good for composition but means Hack would need a stronger opinionated layer above CNI if it wants stable developer-facing service identity, ingress, and route repair.

Recovery:

- containerd is strong at lifecycle primitives, but it does not hand you a product-level project control plane.
- Namespace support in nerdctl is particularly relevant. It offers a clean separation tool that is more explicit than many Docker-based local stacks.

Control plane:

- This stack is a toolkit, not a finished local-dev product.
- That is both the opportunity and the risk: it aligns with Hack's possible future, but it raises the bar on owning more runtime UX and reliability directly.

Implications for Hack:

- Emulate the layering discipline: runtime substrate below, Hack project control plane above.
- Consider containerd as a future substrate if Hack wants less Docker coupling and more runtime ownership.
- Defer a containerd-native baseline until Hack is ready to own networking, rootless ergonomics, and cross-platform integration as product features rather than incidental plumbing.

### 4. Dev Containers Specification

Relevant sources:

- [Development Containers overview](https://containers.dev/)
- [devcontainers/spec](https://github.com/devcontainers/spec)
- [Using images, Dockerfiles, and Docker Compose](https://containers.dev/guide/dockerfile)
- [Prebuilds](https://containers.dev/guide/prebuild)
- [Supporting tools and services](https://containers.dev/supporting.html)

Architecture:

- Dev Containers solve a different problem than Hack's runtime, but they solve an adjacent one extremely well: portable workspace definition.
- The key design win is separation between environment contract and the underlying executor. A `devcontainer.json` can target local or cloud-backed experiences through multiple tools.

Isolation:

- Isolation is intentionally inherited from the underlying container platform.
- The spec provides lifecycle hooks, Features, and mounting/config semantics, but it does not define a richer runtime supervisor or scheduling model.

Networking:

- The spec can reuse Docker Compose and define forwarded ports, but networking behavior varies across supporting tools.
- That portability gap is important: the spec is useful as a contract, but Hack should not assume every field maps cleanly across all runtime backends.

Recovery:

- Dev Containers are oriented around create/recreate/reopen flows rather than scheduler-style recovery semantics.
- Prebuilds are a useful performance pattern, but not a runtime control pattern.

Control plane:

- The spec is intentionally not a unified remote control plane.
- It is a configuration and interoperability layer.

Implications for Hack:

- Emulate the idea of a portable workspace/project contract that can survive backend changes.
- Consider import/export or compatibility with `devcontainer.json` for agent workspaces.
- Avoid conflating "dev environment config" with "agent-native runtime design."

### 5. DevPod

Relevant sources:

- [What is DevPod?](https://devpod.sh/docs/what-is-devpod)
- [What are Workspaces?](https://devpod.sh/docs/developing-in-workspaces/what-are-workspaces)
- [What are Providers?](https://devpod.sh/docs/managing-providers/what-are-providers)
- [Create a Workspace](https://devpod.sh/docs/developing-in-workspaces/create-a-workspace)
- [Auto-inactivity timeout](https://devpod.sh/docs/developing-in-workspaces/inactivity-timeout)

Architecture:

- DevPod is a strong example of separating workspace UX from backend execution through a provider model.
- It reuses `devcontainer.json`, then layers provider-specific machine or container execution behind a common CLI/UI.
- This is highly relevant to Hack's local-vs-remote node ambitions.

Isolation:

- DevPod's isolation story depends on the provider.
- The important pattern is not "best isolation," but "stable user experience across multiple isolation substrates."

Networking:

- DevPod's SSH-first access pattern is notable. The workspace becomes addressable through a stable SSH target rather than a custom always-open HTTP control plane.
- That is a useful model for agent attachment, especially when paired with explicit gateway exposure only when needed.

Recovery:

- Stop/resume/recreate/reset are explicit user-facing lifecycle states.
- Automatic inactivity shutdown is especially relevant for agent-native workflows where unused environments should pause rather than accumulate indefinitely.

Control plane:

- Providers are CLI-defined and extensible. That is the cleanest adjacent example of a backend abstraction that still feels product-level rather than purely infrastructural.
- The client-only posture is also instructive: many workflows do not need a large always-on central service.

Implications for Hack:

- Emulate the provider/driver abstraction.
- Emulate explicit pause/resume and inactivity semantics.
- Consider SSH or socket-first attach flows as a default agent transport.
- Avoid copying the full "workspace product" scope into Hack's runtime baseline if Hack's main need is project and service orchestration.

### 6. Colima + Lima

Relevant sources:

- [Colima README](https://github.com/abiosoft/colima)
- [Lima VM types](https://lima-vm.io/docs/config/vmtype/)
- [Lima network](https://lima-vm.io/docs/config/network/)
- [Lima VMNet networks](https://lima-vm.io/docs/config/network/vmnet/)
- [Lima filesystem mounts](https://lima-vm.io/docs/config/mount/)

Architecture:

- Colima is not a runtime in the same sense as Docker Engine or containerd. It is a practical local adapter that gives macOS users a Linux VM plus a chosen container runtime.
- Lima is the more important architectural reference for Hack. It makes the hidden VM layer explicit by exposing VM type, mount type, port forwarding, and network mode as top-level configuration.
- This matters because Hack is macOS-heavy today. Any future runtime baseline that ignores VM-backed local execution will mis-model real-world behavior for a large part of Hack's user base.

Isolation:

- The real isolation boundary is often the guest VM first and the container runtime second.
- That can be a feature: it is a clearer substrate boundary than pretending macOS containers are "just Linux containers on the host."
- But it also means filesystem behavior depends on mount strategy such as `virtiofs`, `9p`, or SSH-backed sharing. Host/container parity is not guaranteed.

Networking:

- Lima's docs are unusually useful because they make network mode tradeoffs explicit: user-mode networking, `vzNAT`, `socket_vmnet`, additional guest IPs, and port-forwarding behavior are all separate choices.
- Colima's automatic port forwarding is convenient, but it can hide the fact that host-to-container reachability on macOS is VM-mediated rather than native bridge behavior.
- For Hack, this validates a key design point: service identity, ingress, and route repair must be Hack-owned semantics, not assumptions inherited from a specific local runtime stack.

Recovery:

- Recovery is mostly substrate restart at the VM/runtime layer rather than app-aware project recovery.
- When the VM restarts or reconfigures, host reachability, forwarded ports, and mounted filesystem behavior can all drift even if the container runtime conceptually "came back."
- That pattern is directly relevant to Hack's stale-runtime and route-repair logic.

Control plane:

- Colima and Lima expose machine/runtime controls, not project-level app semantics.
- That makes them strong adjacent references but weak candidates for Hack's actual control plane model.
- They should be treated as environment adapters that Hack can observe and accommodate, not as the shape of the Hack runtime itself.

Implications for Hack:

- Emulate explicit capability reporting for host OS, VM layer, network mode, and mount behavior.
- Emulate the honesty of treating macOS local backends as VM-backed substrates with different guarantees than native Linux.
- Avoid assuming Docker-compatible CLI behavior implies Docker-compatible networking or filesystem semantics.
- Defer any deep Lima/Colima-specific integration unless Hack decides it wants to optimize for macOS substrate introspection directly.

### 7. Tilt

Relevant sources:

- [Tilt overview](https://docs.tilt.dev/)
- [Resource dependencies](https://docs.tilt.dev/resource_dependencies.html)
- [Live Update reference](https://docs.tilt.dev/live_update_reference.html)
- [Tiltfile API](https://docs.tilt.dev/api.html)
- [Disable resources](https://docs.tilt.dev/disable_resources.html)

Architecture:

- Tilt is best understood as a resource graph controller for development workflows.
- It manages local commands, Docker Compose resources, Kubernetes resources, and custom logic under one graph.
- That graph-centric model is closer to how agents reason than raw Compose is.

Isolation:

- Tilt delegates isolation to the underlying targets.
- Its value is orchestration, readiness tracking, and update behavior, not runtime sandboxing.

Networking:

- Tilt can work across Compose and Kubernetes, but it is not primarily a networking system.
- The important pattern is that it treats resources and their readiness as first-class, rather than just issuing a one-shot `up` command.

Recovery:

- Tilt's `resource_deps` and readiness semantics are useful, but they are optimized for inner-loop iteration.
- A notable caveat: for Docker Compose resources, Tilt does not currently observe Compose health checks for readiness. That is exactly the sort of backend mismatch Hack should avoid depending on blindly.

Control plane:

- Tilt shows the value of a rich local control plane with selective enable/disable, parallelism settings, and a graph model.
- Its `live_update` system is powerful, but it is not a baseline runtime primitive. It is an optimization layer.

Implications for Hack:

- Emulate explicit resource graphs, readiness, and selective activation.
- Emulate the idea that a control plane should reason about dependencies, not just shell out to runtime commands.
- Defer advanced build/live-update ergonomics until the core runtime state model is solid.

### 8. Nomad

Relevant sources:

- [Job specification](https://developer.hashicorp.com/nomad/docs/job-specification)
- [Restart block](https://developer.hashicorp.com/nomad/docs/job-specification/restart)
- [Reschedule block](https://developer.hashicorp.com/nomad/docs/job-specification/reschedule)
- [Network block](https://developer.hashicorp.com/nomad/docs/job-specification/network)
- [Task driver plugins](https://developer.hashicorp.com/nomad/plugins/drivers)

Architecture:

- Nomad is broader than Hack's current scope, but it contains some of the clearest control-plane semantics in this survey.
- Jobs, groups, and tasks make placement and co-location explicit without dragging in Kubernetes' full object model.

Isolation:

- Nomad's task driver model is important conceptually. Execution is pluggable, and isolation quality is a property of the driver rather than hidden behind a fake universal abstraction.
- That honesty is useful for Hack if it wants multiple backend types in the future.

Networking:

- Nomad's group-level network model is strong: network mode and allocated ports are part of the job spec, and CNI integration is explicit rather than implied.
- Shared network namespaces within groups map well to "service plus sidecars/helpers" patterns.

Recovery:

- Nomad's clean split between restart and reschedule is probably the single most important recovery pattern in this survey.
- Restart is local and client-side. Reschedule is scheduler-side and can move work elsewhere.
- That distinction gives operators and tooling much clearer mental models than many local runtimes expose.

Control plane:

- Nomad is a real scheduler, which is more than Hack needs today.
- But its jobspec and lifecycle semantics are an excellent source of concepts for a lighter-weight Hack control plane.

Implications for Hack:

- Emulate the restart/reschedule distinction directly.
- Emulate pluggable execution drivers or providers, with honest capability reporting.
- Defer full scheduling and cluster placement logic.

## Cross-Cutting Takeaways For Hack

### 1. Hack should keep a small declarative app model

Compose still wins on approachability. Hack should preserve a simple service graph with optional profiles and human-editable config, even if the underlying runtime eventually stops being Docker-centric.

### 2. The runtime substrate and the Hack control plane should stay separate

containerd and Nomad both reinforce the same lesson from different directions:

- the runtime substrate should own primitive execution and isolation
- Hack should own project semantics, readiness, recovery policy, networking policy, and agent-facing APIs

That is already implicit in today's `hackd` and gateway architecture. The future runtime should make it more explicit, not less.

### 3. Recovery needs at least two layers

Hack should adopt terminology and behavior closer to:

- `restart`: retry or recreate inside the same local execution context
- `reschedule` or `recreate elsewhere`: move to a different node, backend, or substrate when local recovery is not enough

Without this split, local and remote runtime behavior will stay ambiguous for agents and operators.

### 4. Networking should be treated as a product subsystem

Hack's current Caddy/CoreDNS/route-repair work already shows the gap between engine networking and developer-facing networking.

The baseline runtime should therefore define:

- stable service identity
- ingress policy
- host/container name resolution policy
- repair behavior when local routing state changes
- backend capability differences, rather than pretending they do not exist

### 5. The control plane should remain socket-first and opt-in for remote exposure

Podman is the clearest external validation of this posture. The safest default is:

- local Unix socket or equivalent local transport
- no remote writes unless explicitly enabled
- remote exposure through SSH/Tailscale/Cloudflare-style operator actions, not ambient open TCP listeners

That also fits agent workflows better, because it makes capability and trust boundaries explicit.

### 6. Provider or driver abstraction is worth keeping

DevPod, Colima/Lima, and Nomad converge on a similar idea from different angles:

- a top-level product can keep a stable UX
- execution backends still need honest capability boundaries

Hack should keep moving toward explicit provider/driver capability reporting for local Docker-like backends, remote node runtimes, and future alternative substrates.

### 7. macOS support means Hack must model VM-backed local execution explicitly

Colima and Lima make a reality explicit that many local tools gloss over: on macOS, the "local container runtime" is often a Linux VM plus forwarding, mounts, and compatibility layers.

For Hack, that means the backend capability contract should expose at least:

- whether execution is native-host or VM-mediated
- how host/container networking is implemented
- how filesystem mounts are bridged
- which assumptions survive VM restart or reconfiguration

### 8. Hack should import workspace standards, not become one

`devcontainer.json` compatibility is attractive for agent workspaces and remote onboarding, but it should sit above the runtime, not define it.

The right likely direction is:

- Hack runtime defines execution, networking, recovery, and control-plane semantics
- Hack can ingest or generate higher-level workspace/environment definitions when useful

## Mapping To Current Hack Architecture

The current repo already contains several pieces of the eventual runtime boundary. The practical question is which ones should remain compatibility layers and which ones should become core runtime abstractions.

### 1. Compose should become a backend, not the architecture

Current baseline:

- [architecture.md](architecture.md) treats `.hack/docker-compose.yml` as the project runtime source of truth today.
- [cli.md](cli.md) still defines core runtime flows in terms of `docker compose up`, `down`, `ps`, `logs`, and `run`.

Implication:

- The next runtime should preserve Compose import/export and migration value.
- But Hack's architecture should define its own project graph, dependency semantics, health model, and recovery policy above whichever backend executes the workload.

### 2. `hackd` is already the beginning of the real control plane

Current baseline:

- [architecture.md](architecture.md) already separates `hackd` from the underlying container runtime.
- The daemon caches state, fingerprints runtime resets, and reports stale runtime metadata when the engine changes or disappears.

Implication:

- This is the right direction and should be extended into a first-class runtime state machine.
- The future runtime spec should define project states, service states, readiness, stale cache, reset detection, and recovery transitions in Hack terms instead of inheriting them implicitly from Docker status strings.

### 3. Networking is already a Hack-owned subsystem

Current baseline:

- [architecture.md](architecture.md) documents the current Caddy, CoreDNS, TLS cert, and `extra_hosts` repair stack.
- Hack already treats stable service naming and local ingress as product responsibilities rather than leaving them to Compose defaults.

Implication:

- The future runtime should formalize networking as a runtime subsystem with explicit capabilities and repair semantics.
- That includes service identity, host/container resolution behavior, ingress policy, and what happens when route or IP assumptions drift under the runtime.

### 4. The gateway posture is directionally correct

Current baseline:

- [gateway.md](gateway.md) already keeps remote access optional, local by default, and gated by explicit write enablement.

Implication:

- The control plane should stay socket-first and local-first.
- Remote access should remain a deliberate operator action layered on top, not a default runtime posture.

### 5. Remote nodes expose the current substrate coupling

Current baseline:

- [guides/remote-node-container.md](guides/remote-node-container.md) shows that today's remote node runtime still bundles the `hack` CLI and shells out through Docker plus the Docker socket.

Implication:

- That is acceptable as a compatibility and bootstrap layer.
- It also highlights exactly where Hack is still substrate-coupled: remote nodes currently package Hack's control plane and Docker integration together rather than separating "Hack runtime semantics" from "Docker-backed execution."

### 6. Capability reporting should become explicit

Current baseline:

- The gateway and node docs already distinguish capabilities such as runtime, gateway, and supervisor.

Implication:

- The next runtime should make capability reporting richer and backend-aware.
- At minimum, Hack should report which backends support restart semantics, pause/resume, health probes, ingress, remote shells, snapshots, and route repair rather than assuming every backend behaves like Docker on the local host.

## Recommended Baseline Requirements For The Next Hack Runtime

Based on this survey, a credible baseline should include:

1. A small declarative project model with services, profiles, mounts, env, and explicit dependencies.
2. First-class runtime state with health, readiness, stale-cache, and reset detection semantics.
3. Distinct restart and reschedule behaviors, with room for local and remote backends.
4. Stable service identity and explicit networking policy across host and container contexts.
5. Optional local control plane with socket-first access and explicit remote exposure.
6. Capability-aware provider/driver abstraction for backend differences.
7. Backend capability reporting that can distinguish native Linux execution from VM-mediated local backends on macOS.
8. Explicit pause/resume or inactivity behavior for agent-managed environments.
9. Compatibility paths for Compose and likely future workspace-contract import, but no hard dependency on either as the long-term architecture.

## Questions The Runtime Spec Should Answer Explicitly

The survey narrows the next spec work to a small set of architecture questions:

1. What is Hack's canonical project and service model once Compose is treated as an adapter rather than the source of truth?
2. Which lifecycle states are Hack-defined, and which are merely backend observations?
3. What is the exact difference between restart, recreate, reschedule, and resume in local and remote contexts?
4. Which networking guarantees are required across all supported backends, and which are best-effort capabilities?
5. What is the minimum backend capability contract for a "Hack runtime provider"?
6. How should Hack model VM-mediated local backends on macOS versus native Linux backends?
7. Which pieces of agent workspace setup belong in the runtime versus in higher-level workspace contracts such as devcontainers?

## Suggested Near-Term Architecture Direction

If Hack wants the most credible near-term baseline, the best path is:

- Keep the current Compose-backed model as the compatibility and migration layer.
- Strengthen Hack-owned runtime state, recovery semantics, and networking policy in `hackd` and the gateway.
- Introduce clearer provider/driver capability reporting for local and remote runtimes.
- Use [agent-native-runtime-provider-capabilities.md](agent-native-runtime-provider-capabilities.md) as the starting contract for backend capability modeling.
- Design the future runtime boundary so Docker/Compose can be one backend, not the definition of Hack itself.
- Delay a containerd-native substrate until Hack explicitly wants to own more low-level runtime assembly.

That path preserves today's leverage while still moving toward an agent-native architecture.
