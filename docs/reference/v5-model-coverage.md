# V5 model coverage and release evidence

Models are contributor evidence, not product capability claims. This inventory
was reconciled against protected `next` f73fbd56 and the local readiness changes
on 2026-10-28. [The release path](../guides/v5-release-readiness.md) keeps source,
model, regression, artifact, native application and dogfood acceptance separate.

## Checked scope and tool provenance

The maintained runner enumerates finite domains with TLC and checks a positive
instance plus discriminating negative controls. Its registry pins state counts,
invariants, named counterexample actions and same-state witness fields. A parse
error, zero-state search, timeout, unrelated failure or incomplete search is not a
pass. See [model contracts](../../tests/models/tla/README.md) and
[the result validator](../../scripts/lib/tla-result.ts).

TLC 1.7.4 remains the official latest stable release checked on this date; its
SHA256 stays pinned. Apalache 0.62.4 is the reviewed current stable optional tool;
its local installer pin is updated separately. Do not infer Apalache support from
a TLC result. Record the actual checker, JVM, bounds and result. Current upstream
references: [TLC releases](https://github.com/tlaplus/tlaplus/releases/latest),
[TLA+ AgentSkills](https://github.com/tlaplus/AgentSkills),
[Apalache bounds](https://apalache-mc.org/docs/apalache/running.html).

The new pre-Ready model exhausts 10,965 states with interfering source/session/proof
replacement and crashes enabled. Six independent guard removals violate Safe.
Conditional liveness exhausts 395 states with interference/crashes disabled and
explicit weak-fairness assumptions. This is not an unbounded proof or evidence
that a real provider eventually completes cleanup. Its positive contract includes
unpublished local PR499 follow-up 5c4ae64c; it does not prove protected next already
implements that follow-up. Full checker-suite and executable integration results
must be attached to the eventual exact integration revision.

## Critical-state mapping

| Property and critical states | Model coverage | Implementation/regression boundary | Remaining qualification |
| --- | --- | --- | --- |
| Exclusive claims; competing writers; partial owner publication | graph-admission, registry-writer, publication-journal, missing-publication-lock, native-frontend-recovery | Admission/registry locks, pending publication and exact saved owner; related runtime ownership tests | Real filesystems, boot/incarnation identity and unsupported writers remain independent. |
| Canceled/expired startup; reader cancellation versus EOF; producer/group uncertainty | pre-ready-retirement, authority-lifetime, native-file-material | Native graph finalizer/onSettled, exact Removed, hard-signal freshness, host stop/close; local pre-Ready retained/removed regressions | Physical guest acceptance; current root aggregate; explicit executable unknown host-close control; async proof-to-stop and partial binding-retirement crash windows. |
| Crash between reserve, publish, sync and release; stale recovery | native-frontend-recovery, publication, publication-journal, native-storage-witness | Durable intent/enrolled/released records, fresh lease and expected binding; recovery and sync-failure tests | Fsync guarantees, process-kill windows, real restarted provider observations. No missing-path authority. |
| Data lifetime independent of compute; replaced/aliased metadata | native-persistent-enrollment, native-storage-witness, native-file-material | Existing-only enrollment, exact birth/witness and reference fencing; copied-label/replacement tests | Real SQL/content retention, external writer assumptions, allocated-byte evidence. |
| Concurrent stop/publication; route claim and relay lifetime | native-route-stop, shared-https-lifetime, previous-boot-shared-https, relay-lifecycle-barrier, relay-authorization, relay-staging, relay-fence | Fenced route removal, relay owner, ready/removed protocol, authenticated observations | Native DNS/TLS/browser behavior; old-boot uncertainty and external routing. |
| Dependency rebind, incomplete initializer, terminal reuse | dependency-rebind, stopped-pool-startup, restore-history | Dependency claim/readiness, saved execution, restore history and source convergence tests | Actual installer failure, cache corruption, retained application state and resource plateau. |
| MCP cold start, cancellation and duplicate launches | mcp-startup, mcp-startup-cancellation | Shared MCP bundle identity, startup deduplication and cancellation regressions | Fresh supported client sessions, full workflow coverage and measured overhead (WU16/WU20/WU28). |
| Software install/upgrade/rollback, active launcher versus selection, compatibility | **Coverage gap:** no maintained model here is an installer/selection refinement | `scripts/install-prerelease.py`, prerelease-install/Python installer tests, candidate-install contract | Add a bounded selection/lock/crash/compatibility model before primary-driver promotion; real official-artifact upgrade/rollback still required. |
| Primary-driver promotion and rollback to stable | **Coverage gap:** staged readiness policy is not an implemented state machine proof | Reviewed release manifest, per-project opt-in, explicit stable/candidate ownership records | No active-project switch until exact candidate/artifact and rollback/data compatibility are qualified. |

These rows identify coverage, not closure. A local mutant or spy proves handling,
not that the kernel/provider produces the modeled condition. No model establishes
full Compose parity, lower CPU/memory, end-to-end latency, 1/8/32 branch safety or
safe deletion of every retained resource.

## Maintained finite instances

Bounds below are reviewed registry contracts, not claims of universal proof. A
control count includes the positive/negative pair and additional configurations;
liveness/reachability controls have their own documented assumptions.

| Model | Positive distinct states | Configurations |
| --- | ---: | ---: |
| [pre-ready-retirement](../../tests/models/tla/pre-ready-retirement/Retirement.tla) | 10,965 | 8 |
| [native-persistent-enrollment](../../tests/models/tla/native-persistent-enrollment/Enrollment.tla) | 38 | 6 |
| [native-frontend-recovery](../../tests/models/tla/native-frontend-recovery/Recovery.tla) | 602 | 10 |
| [native-storage-witness](../../tests/models/tla/native-storage-witness/Witness.tla) | 352 | 19 |
| [native-file-material](../../tests/models/tla/native-file-material/Material.tla) | 8,388 | 12 |
| [native-route-stop](../../tests/models/tla/native-route-stop/Stop.tla) | 202 | 6 |
| [registry-writer](../../tests/models/tla/registry-writer/RegistryWriter.tla) | 7,721 | 2 |
| [absent-publication-recovery](../../tests/models/tla/absent-publication-recovery/Absent.tla) | 247 | 5 |
| [missing-publication-lock](../../tests/models/tla/missing-publication-lock/MissingLock.tla) | 96 | 7 |
| [shared-https-lifetime](../../tests/models/tla/shared-https-lifetime/SharedHttps.tla) | 64 | 2 |
| [previous-boot-shared-https](../../tests/models/tla/previous-boot-shared-https/ArchiveHttps.tla) | 92 | 4 |
| [stopped-pool-startup](../../tests/models/tla/stopped-pool-startup/Resume.tla) | 71 | 3 |
| [dependency-rebind](../../tests/models/tla/dependency-rebind/Rebind.tla) | 21 | 10 |
| [relay-lifecycle-barrier](../../tests/models/tla/relay-lifecycle-barrier/Barrier.tla) | 1,590 | 2 |
| [relay-authorization](../../tests/models/tla/relay-authorization/Authorization.tla) | 7 | 2 |
| [mcp-startup-cancellation](../../tests/models/tla/mcp-startup-cancellation/Cancellation.tla) | 10 | 2 |
| [mcp-startup](../../tests/models/tla/mcp-startup/Startup.tla) | 27 | 2 |
| [authority-snapshot](../../tests/models/tla/authority-snapshot/Routing.tla) | 11 | 2 |
| [authority-lifetime](../../tests/models/tla/authority-lifetime/Lifetime.tla) | 9 | 2 |
| [publication-journal](../../tests/models/tla/publication-journal/Journal.tla) | 50 | 2 |
| [publication](../../tests/models/tla/publication/Publication.tla) | 16 | 2 |
| [fence-first](../../tests/models/tla/fence-first/First.tla) | 24 | 2 |
| [fence-pending](../../tests/models/tla/fence-pending/Fence.tla) | 7 | 2 |
| [relay-staging](../../tests/models/tla/relay-staging/Stage.tla) | 9 | 2 |
| [relay-fence](../../tests/models/tla/relay-fence/RelayFence.tla) | 16 | 2 |
| [restore-history](../../tests/models/tla/restore-history/RestoreHistory.tla) | See named result contract | 2 |
| [graph-admission](../../tests/models/tla/graph-admission/Admission.tla) | See named result contract | 2 |
| [balloon-reuse](../../tests/models/tla/balloon-reuse/BalloonReuse.tla) | See named result contract | 2 |

The three legacy result contracts are maintained directly in `tla-result.ts`;
all other rows are in `tla-runtime-models.ts`. Inspect each `.cfg` and model README
before drawing conclusions from its count. Changing a bound, fairness condition,
atomic boundary or state constraint requires a new recorded result and reviewed
negative controls; never silently normalize an unexpected state count.

## Statecharts and tests

Use the same events/guards in source, spec and diagrams. Model independent
producer, durable receipt, host-session and invocation states as orthogonal
regions. Do not collapse a canceled read, exited child and absent group into one
"done" node, or recover an ownership capability through a history transition.
[Pre-Ready retirement](../../tests/models/tla/pre-ready-retirement/README.md)
contains the source/test map and the compressed statechart.

Required negative controls include stale claimant, changed review/source/session,
pending publication, uncertain reader/child/group/host exit, hard cancellation,
crash/reopen and incompatible software rollback. Preserve a named counterexample
and an executable regression for every claimed implementation fix. Missing
executable or model coverage stays a release gate; a diagram alone cannot close it.
