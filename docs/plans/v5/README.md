# Hack v5 candidate

Hack v5 aims to make starting, editing, testing, and reconnecting to development environments fast,
with low idle resource use and the same experience on local and private remote machines.

This is an experimental branch, not a release or a replacement for the installed Hack. Start with
the [specification](spec.md), follow the [work units](work-units.md), and use the
[isolated development lane](development.md) to review each checkpoint. The
[evidence summary](evidence.md) separates observations from decisions and unproven claims.
Every checkpoint must also complete a [real-project attempt and gap review](real-project-checkpoints.md).

[Checkpoint 01](checkpoint-01.md) records the read-only foundation.
[Checkpoint 02](checkpoint-02.md) tracks the private lifecycle implementation and its live gates.
[Checkpoint 03](checkpoint-03.md) records Compose review and real-project enrollment.
[Checkpoint 04](checkpoint-04.md) records durable fixture jobs and owned cancellation.
The [September 14 benchmark and review](benchmark-20260914.md) compares the owned graph executor
with direct Docker Compose and stable Hack 4.1.1/4.2.0, including the remaining acceptance gates.
The [resource and health-cadence checkpoint](resources-20260914.md) adds native CPU/footprint
measurements, reclamation evidence, command-string support and a controlled CPU-cost reduction.

The first implementation is `packages/runtime-core`, a Rust library and candidate executable.
The repository-root `hack-local` launcher addresses only that checkout's build. Commands include read-only `info` and `plan`, private package preparation, resource probing, and
experimental `runtime up/status/down/recover`, bounded `project plan/enroll/status`, and an explicit
local node for durable built-in fixture jobs. The owned graph executor can run a bounded supported
Compose plan, inspect readiness, restart or restore retained data, clean up, and export/prune archived
evidence. Full application source/build, managed environment, lifecycle and routing compatibility
remain open. A project path in a plan is not permission to mount it, read its secrets, or attach to
its existing environment.

## Decisions

- Lead provider: SmolVM/libkrun on Apple Silicon; explicit native container execution on Linux.
- Initial engine: Docker/Compose compatibility. Direct containerd integration requires a measured
  reason and its own compatibility gate; it is not required to ship the first candidate.
- Runtime control: a small Rust core, with a process boundary to VM/provider helpers. The existing
  TypeScript CLI remains supported; it does not acquire a competing v5 reconciler.
- Source: Linux-native working files, one declared writer, incremental synchronization, and
  immutable inputs for qualification jobs. Live development and frozen execution are distinct.
- Delivery: observable vertical checkpoints, with failure and cleanup demonstrations before the
  next layer becomes available. A fast happy path cannot waive ownership or persistence tests.

The September 8 design remains historical research. This directory is the maintained candidate
specification and supersedes its early requirement to replace Docker and rewrite the entire CLI.
Private reports, machine inventories, raw experiment logs, and guest state stay outside tracked docs.
