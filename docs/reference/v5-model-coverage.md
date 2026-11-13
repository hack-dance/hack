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
it remains unrun for this coverage, and its local installer pin is updated
separately. Do not infer Apalache support from
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
| CI cancellation must not lose merged-change coverage; only exact-head full evidence may qualify a prerelease | No maintained GitHub scheduler model. Finite fixture interleavings cover predecessor success/failure/cancellation, two competing full/scoped runs and two rerun attempts | `ci.yml` shares only the next-push cancellation group and requires a successful before run for selection. `selectPrereleaseCiRun` reads current attempts; `requireBranchChecks` binds suite and job check IDs. `ci-trusted-policy`, `prerelease-plan` and `release-prepare-gate` regressions reject cancelled predecessors, green subsets, stale checks, skipped hosts and changed attempts | API snapshots and GitHub group/event semantics are assumptions; races after the last read remain possible. Publication rechecks the frozen protected head and full evidence but does not transactionally lock GitHub. Hosted dispatch/cancellation checks qualify wiring; no scheduler liveness or formal refinement claim. |
| Native log follower versus lifecycle mutation, frontend loss, stopped container and transport loss | No new state model: the follower observes without a mutation lease and grants no cleanup authority | `provider/graph/log_follow.rs` and its native counterpart pin Ready admission, container and start generation; `provider/engine/log_follow.rs` bounds framing and distinguishes real EOF from stopped-service idle cutoff. `lifecycle_log_follow_tests.rs` keeps the production transport on a fake Engine socket active while acquiring startup and operation leases, with a same-lock contention control and output while each lease is held. `native-log-follow-source.test.ts` guards the observer-only route; process tests cover cancellation, frontend loss, real output-pipe closure while idle, replacement-container restart (including retained adopted run/owner IDs) with one marker, NDJSON admission failures, truncated/partial output and slow idle-end delivery. `native-log-restart.test.ts` covers bounded re-admission, unchanged-container refusal and prompt down; `native-log-selection.test.ts` covers strict finite admission responses and owned-child cancellation/timeouts; advisory markers grant no authority | 4 KiB payload envelopes, 8 KiB wire lines, 64 Ki-character retained payload prefixes excluding Engine timestamps, 30-second restart wait, 1000-line new-container backlog. The portable lease test fakes identity/state checks; it does not exercise host process/disk auditing, graph admission or the VM relay. Real relay EOF on stop/down/restart, VM loss and concurrent lifecycle latency require Apple Silicon acceptance. No performance or whole-product parity claim. |
| Foreground group interrupt; publisher exit before authenticated stop; dead owner's pending cleanup enrollment and bridge release | native-publisher-stop | [Process adapter](../../src/backends/native-project-process.ts) isolates Compose owners regardless of hooks; Rust `process::publisher_command` isolates publishers; `legacy_cleanup_enrollment` binds the old coordinator and inventories before a distinct recovery intent. [Group regression](../../tests/native-foreground-group-interrupt.test.ts) signals the whole group for fresh/restore owners; Rust real-publisher process, frontend-loss, exact child-reaping and enrollment tests check grouping, lifetime wakeups and stale selectors. | One graph, one publisher, one crash, one identity replacement and one audited successor boot; 168 states. Publisher exit observation is separate from lease-bound reaping/proof commitment; `NoUncommittedExit` rejects owner cleanup while proof is pending. A busy lease stutters without delaying stop control. SIGHUP requests retaining cleanup; a reaped publisher enters an observable publisher-down state until explicit stop. Native process tests and frontend framing/ps tests cover signal delivery and notices. Dependency release is a separate post-completion step; `NoStrandedReservation` rejects success with a held reservation. Real reservation-file regressions check retry, capacity reuse and refusal fences. Separate stopped-receipt and intent-completion commits are collapsed; TypeScript dispatch and Rust completion-digest regressions cover that interruption window. Publication-registry sync/rename is abstracted and covered by portable commit-interruption tests. Kernel identity, socket/inode proofs, guest observations, durable storage and existing next.13 home recovery remain implementation/Apple Silicon VM gates. No eventual recovery is asserted. |
| Exclusive claims; competing writers; partial owner publication | graph-admission, registry-writer, publication-journal, missing-publication-lock, native-frontend-recovery | Admission/registry locks, pending publication and exact saved owner; related runtime ownership tests | Real filesystems, boot/incarnation identity and unsupported writers remain independent. |
| Interrupted native restart: Ctrl-C or a frontend crash while the old run stops; `up` and `restart` refusing each other | native-restart-intent | The restart's stop requests run in their own process group (`processGroup: "own"` in [native-runtime-client](../../src/backends/native-runtime-client.ts)); a resumed `prepared` intent accepts a graph its owner stopped ([restart](../../src/backends/native-project-restart.ts), [preflight](../../src/backends/native-project-restart-preflight.ts)); [restart regressions](../../tests/native-project-restart.test.ts) send a real group SIGINT and cover the resume; HACK-2035 regressions force SIGINT/SIGTERM child rejection before frontend abort in preflight and down, using the runtime client’s preserved `stopSignal` | The finite model abstracts interrupt delivery as one action and does not prove child-exit versus frontend-handler ordering; deterministic tests cover that classification. A stale restart lock after a frontend crash; down hooks still share the terminal's group; physical guest acceptance. |
| Foreground Compose startup failing after resources started; unconfirmed cleanup; unauthenticated final inspection | native-startup-owner | `recordFailedStartupOwner` in [native-project-start](../../src/backends/native-project-start.ts) publishes the authenticated failed run with a finalization lifetime; [start regressions](../../tests/native-project-start.test.ts) cover recording, an unauthenticated receipt and a retained mapping | A refused final inspection still leaves only the runtime journal; crash between finalization registration and mapping publication; physical guest acceptance. |
| Canceled/expired startup; reader cancellation versus EOF; producer/group uncertainty | pre-ready-retirement, authority-lifetime, native-file-material | Native graph finalizer/onSettled, exact Removed, hard-signal freshness, host stop/close; local pre-Ready retained/removed regressions, including separate live/foreign/hard-canceled fresh-teardown-admission assertions (HACK-1801) | Physical guest acceptance; current root aggregate; explicit executable unknown host-close control; async proof-to-stop and partial binding-retirement crash windows; post-stop source/session replacement or hard cancellation before Retire (Retire does not recheck these inputs; Safe has no post-stop interference predicate). |
| Detached up readiness handoff after down-hook bookkeeping; launcher loss before/after acceptance | native-startup-owner, native-frontend-recovery | `native-detached-up.ts` readiness IPC and exact child disconnect; native image/authored readiness callbacks; [process regressions](../../tests/native-detached-up.test.ts) qualify retained control after launcher exit and graceful pre-acceptance loss | One launcher/owner, finite startup and two recovery attempts. IPC delivery/OS scheduling, real graph and host lifecycle effects, physical durability and real-VM restart/down remain host gates. No daemon adoption or new recovery authority. |
| Crash between reserve, publish, sync and release; stale recovery; detached launcher loss distinct from live-owner death | native-frontend-recovery, publication, publication-journal, native-storage-witness | Durable intent/enrolled/released records, fresh lease and expected binding; recovery and sync-failure tests | Fsync guarantees, process-kill windows, real restarted provider observations. No missing-path authority. |
| Data lifetime independent of compute; replaced/aliased metadata; retained-data handoff across Compose plan changes, including dependency caches | native-persistent-enrollment, native-storage-witness, native-file-material, native-plan-reconcile, native-cache-reconcile | Existing-only enrollment, exact birth/witness and reference fencing; copied-label/replacement tests; `provider/graph/plan_reconcile.rs` projection and cache-selection tests | Real SQL/content retention, external writer assumptions, allocated-byte evidence. |
| Settled retained Compose route-attempt retirement; pinned references; interrupted deletion | **Coverage gap:** filesystem journal compaction is not modeled; native-route-stop covers a different stop protocol | Instance mutation lock and exact surviving claim witnesses in [journal compaction](../../src/lib/native-compose-route-claims.ts); [claim regressions](../../tests/native-compose-route-claims.test.ts) and [retained lifecycle integration](../../tests/native-compose-adoption-routing-generation.test.ts) | 24 successful operations keep two attempt directories and constant Linux descriptors; four integrated lifecycle operations check directory counts. Injected unlink failures cover same-store and fresh-store cleanup retries. Assumes cooperative same-user writers, the caller's mutation lock and working filesystem synchronization. No process-kill/power-loss durability proof or bound on unresolved/over-budget histories. |
| Graph cleanup container stop batch: bounded in-flight stops, shared worker queue, connect-stage retry, batch-wide unreachable state, deadline expiry, worker panic | **Coverage gap:** no maintained model covers scheduling inside the stop batch; native-route-stop covers a different stop protocol | `dispatch` and `attempt` in [the stop batch](../../packages/runtime-core/src/provider/engine/stop.rs): at most 4 stops in flight, every worker joined; only `connect`/`connect_timeout` failures retry (25 ms doubling to 500 ms, within the batch deadline and 30 s of a stop's first connect failure); once one stop exhausts its window, later connect failures return at once; a deadline reached during backoff keeps the connect stage; `response`, `timeout` and `transport` never retry. Regressions in the same file's `provider::engine::stop` tests (bounded in-flight socket server, late socket, missing socket, 14-stop retry counts, persistent connect failures, oversleeping backoff, non-retried stages, worker panic) and `fourteen_service_connect_failures_keep_resumable_progress_and_retry_only_unstopped` | Tests cover exact attempt counts and the in-flight bound for fixed interleavings; no model explores all worker schedules or proves at most one delivered request per stop. Assumes a failed connect sent no request bytes and that the stop budget covers fully serialized grace periods. Graph-level resume after a partial batch is covered by tests only. Host qualification of the descriptor-pressure root cause (HACK-1302) remains open. |
| Concurrent stop/publication; route claim and relay lifetime | native-route-stop, shared-https-lifetime, previous-boot-shared-https, relay-lifecycle-barrier, relay-authorization, relay-staging, relay-fence | Fenced route removal, relay owner, ready/removed protocol, authenticated observations | Native DNS/TLS/browser behavior; old-boot uncertainty and external routing. |
| Shared host helper instance: overlapping ups, session adoption, stale create decisions, replacement before finalize, epoch-record failure, interrupted cleanup, concurrent down, displaced launches, failed down session stop | shared-helper-instance | `src/lib/project-shared-helpers.ts` (shutdown generation, `assertCurrent`, `SharedHelperSessionOwnership`); `src/lib/project-lifecycle-controller.ts` session decision, the locked creation transaction (revalidate, publish, create, environment, record, stop on failure, all under one lock), launches fenced by the lock and a token check, abort and signal cleanup through the same epoch decision (`runIfOwned`), an unknown exact-presence answer failing the inspection, and the locked conditional finalize; `stopSessionBeforeReleasingHelpers` (down, restart, native retirement keep holders when the session stop fails); `runMuxCommand` bounds every lifecycle and backend mux call so it settles before the lock is released, and reports a timeout as unknown (never absence); `tests/mux-command-timeout.test.ts`; `tests/project-lifecycle-controller-ownership.test.ts`, `tests/project-shared-helpers.test.ts`, `tests/native-project-down.test.ts`, e2e `shared-host-helpers` | Helper holder/rollback and claim protocol are not modeled (claim fixtures cover them); timeout settlement is an assumption the code does not guarantee (a killed tmux client's queued command may still apply, so a late kill or window command can reach a newer session; consequences and the session-ID fence, not in this slice, are in the README); zellij is refused for shared-helper lifecycle sessions (token written after creation); the gap between a down's session stop and its release (an up that captured after the stopping mark can still succeed there) is a documented first-slice limitation; real mux/process/lock-file behavior. |
| Engine restart policies: stop versus pending restart, guest engine restart, stale incarnations, terminal proof | service-restart-policy | Receipt-admitted policy, disarm-before-stop and `restarting` stop preflight in `shutdown.rs`; admission refusals for incarnation-bound delivery classes in `restart_policy.rs`; owner-driven `Rebind` after full retirement, fresh ownership/attachment checks and a new reservation in `bridges/restart_rebind.rs`; route probe sample-generation rearm; Rust tests for admission, endpoint identity, port-busy refusal, disarm and stop preflight; portable selected-child readiness guard plus macOS two-real-child polling regression prevent historical sibling exits from rejecting a replacement or misclassifying its own listener | Real guest engine behavior (crash restart, stop during backoff, disarm before deletion) needs native host evidence; several services, selected-child readiness during sibling failure, backoff timing and retry counting are not modeled. Same-port/route reachability after a policy restart, route probe rearm and per-slot child retirement still require real-VM host evidence. Rebind abstracts retirement/reservation/publication; relay lifecycle, fence and staging models cover their separate failure boundaries. |
| Foreground Ctrl-C down hooks: concurrent `down`, second interrupt, crash between or during hooks, stop during `up.after`, next generation | native-foreground-down-hooks | Value-free compare-and-swap journal in [down hooks](../../src/backends/native-project-down-hooks.ts), foreground orchestration in [foreground stop](../../src/backends/native-project-foreground-stop.ts) and `hack down` in [native down](../../src/backends/native-project-down.ts); [journal](../../tests/native-project-down-hooks.test.ts), [foreground](../../tests/native-project-start-stop-hooks.test.ts) and [down](../../tests/native-project-down-journal.test.ts) regressions | Durable writes are atomic in the model; real fsync/power loss, a stale journal lock after a crash inside the lock, and the live process-group behavior of the graph owner on a host are not covered. One generation and at most two `down` invocations are explored. |
| Dependency rebind, automatic refresh, incomplete initializer, terminal reuse | dependency-rebind, dependency-auto-refresh, stopped-pool-startup, restore-history | Dependency claim/readiness, saved execution, restore history and source convergence tests | Actual installer failure, cache corruption, retained application state and resource plateau. |
| Private environment allocation lifetime: staged values and private file members, crash between record and stage, retirement with the container | **Coverage gap:** no maintained model covers environment or credential delivery; file members share the existing allocation, intent record and retirement, so the state machine is unchanged | `packages/runtime-core/src/provider/environment.rs` (preparation bounds, staging layout, verification), `managed_environment.rs` (envelope v2 refusals, forwarding), `graph/launcher.rs` (read-only binds, overlap refusals) and `environment_recovery.rs` retirement tests | Live VM evidence that only the owning UID reads a member, writes fail read-only and the member is absent after cleanup; refresh or rotation of delivered files is not implemented. |
| One pool, many project roots: share-set changes, boot mounts, per-project share selection, removal of a referenced share | multi-root-share | `provider::share_update` (journaled stopped-pool add/remove, record before owner), `project_share::{check_request, check_boot, validate_set}`, `OwnedGuest::project_share_for`; `share_update` and `project_share` unit tests | Real provider boot with an updated mount record, virtio-fs device limits and live multi-project graphs on a host VM. Cross-project cleanup is abstracted to one run's own resources. |
| Native image builds: unleased build versus engine stop, crash mid-build, storage recreation, foreign or forged images, reclamation versus retained graph references | native-build-retention | `provider::image_build` (shared build fence, per-key lock, incarnation/boot/engine recheck and label check at adoption, dead-attempt recording) and `image_build::reclaim` (owned labels, current receipts, retained graph state scan, engine non-force removal); `image_build` regressions | One key and namespace; a build client orphaned by a killed `hack-native` is not modeled (the client inherits the build fence and per-key lock, so both stay held until it exits: `image_build::tests::a_killed_coordinator_leaves_its_client_fenced`); real BuildKit, engine removal semantics and guest storage are host evidence. |
| MCP cold start, cancellation and duplicate launches | mcp-startup, mcp-startup-cancellation | Shared MCP bundle identity, startup deduplication and cancellation regressions | Fresh supported client sessions, full workflow coverage and measured overhead (WU16/WU20/WU28). |
| Software install/upgrade/rollback, active launcher versus selection, compatibility | **Coverage gap:** no maintained model here is an installer/selection refinement | `scripts/install-prerelease.py`, prerelease-install/Python installer tests, candidate-install contract | Add a bounded selection/lock/crash/compatibility model before primary-driver promotion; real official-artifact upgrade/rollback still required. |
| Primary-driver promotion and rollback to stable | **Coverage gap:** staged readiness policy is not an implemented state machine proof | Reviewed release manifest, per-project opt-in, explicit stable/candidate ownership records | No active-project switch until exact candidate/artifact and rollback/data compatibility are qualified. |
| Post-Compose bridge attachment: endpoint placeholder persists or resolves to owned/foreign ID (HACK-2141) | **Coverage gap:** no maintained model of external Docker endpoint attachment timing | `waitForNativeComposeNetworkMembers` retries only owner-issued member-ID refusal, re-acquiring complete proof; `native-compose-ownership.test.ts` covers the three-ID/one-placeholder listing, resolution, persistence, foreign member, cancellation, deadline and nonretryable errors. `native-compose-endpoint-settlement-command.test.ts` drives source CLI `up` through readiness and the prepared guard independently, with a placeholder that resolves on the next query; strict/saved policy is unchanged | Two-second monotonic retry window plus one bounded probe; Docker read consistency and eventual attachment remain external assumptions. `native-config-process-policy` is the live isolated regression; repeated CI runs remain separate evidence. Other effect-adjacent reads still fail closed immediately: the routed-run guard, strict `afterReadiness` re-read, one-off run pre/post-removal checks, saved exec guards and other saved non-observe commands, saved stop/down reads, and file-owner pre/post-effect/readiness checks in `native-compose-file-command.ts`. A detaching-endpoint placeholder was not observed in this investigation; those paths remain known gaps. |
| Compose detached startup: short job exits before observation; old completed container replaced between samples | **Coverage gap:** no maintained model of external Docker observation consistency | `waitForComposeStartupState` corroborates identities and classifies only the latest snapshot within the remaining start budget. `compose-startup-state.test.ts` covers sub-second interleavings, replacement, failure and deadline; `project-up-startup-state.test.ts` replays the Compose/Docker boundary. `compose-short-oneshot` checks real repeated replacement and sub-second exit zero | Assumes Docker listings eventually describe current containers; two matching identity listings cannot prevent replacement after the final read. Unit bounds are one job, two identities and a 1 s virtual budget. Real-project acceptance and Docker CI remain separate gates. |
| Compose foreground first/second interrupt and lifecycle signal handoff | **Coverage gap:** no maintained model covers the external Compose shutdown protocol | `composeRuntimeBackend.up` isolates the Compose session, forwards each signal once, and waits for child exit/log EOF; `runUpCommand` retires the setup signal owner before attached launch. `tests/compose-foreground-signal.test.ts` covers delayed graceful completion, second interrupt and listener disposal; `tests/e2e/scenarios/compose-foreground-signal.ts` checks both real containers immediately after a process-group SIGINT and CLI exit. | Finite subprocess tests cover one or two interrupts and one child; Docker shutdown success is observed by the live regression, not inferred from child exit. Docker daemon failure, wrapper SIGKILL/crash and an unresponsive Compose client are not qualified. The first interrupt has no forced deadline; Compose owns its configured service stop grace periods. |

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
| [native-publisher-stop](../../tests/models/tla/native-publisher-stop/PublisherStop.tla) | 168 | 7 |
| [shutdown-rebase](../../tests/models/tla/shutdown-rebase/ShutdownRebase.tla) | 43 | 3 |
| [native-plan-reconcile](../../tests/models/tla/native-plan-reconcile/Reconcile.tla) | 747,656 | 4 |
| [native-cache-reconcile](../../tests/models/tla/native-cache-reconcile/CacheReconcile.tla) | 2,208 | 5 |
| [pre-ready-retirement](../../tests/models/tla/pre-ready-retirement/Retirement.tla) | 10,965 | 8 |
| [native-persistent-enrollment](../../tests/models/tla/native-persistent-enrollment/Enrollment.tla) | 38 | 6 |
| [native-frontend-recovery](../../tests/models/tla/native-frontend-recovery/Recovery.tla) | 1752 | 12 |
| [native-storage-witness](../../tests/models/tla/native-storage-witness/Witness.tla) | 352 | 19 |
| [native-file-material](../../tests/models/tla/native-file-material/Material.tla) | 8,388 | 12 |
| [native-foreground-down-hooks](../../tests/models/tla/native-foreground-down-hooks/DownHooks.tla) | 1,246 | 6 |
| [native-route-stop](../../tests/models/tla/native-route-stop/Stop.tla) | 202 | 6 |
| [registry-writer](../../tests/models/tla/registry-writer/RegistryWriter.tla) | 7,721 | 2 |
| [absent-publication-recovery](../../tests/models/tla/absent-publication-recovery/Absent.tla) | 247 | 5 |
| [missing-publication-lock](../../tests/models/tla/missing-publication-lock/MissingLock.tla) | 96 | 7 |
| [shared-https-lifetime](../../tests/models/tla/shared-https-lifetime/SharedHttps.tla) | 64 | 2 |
| [previous-boot-shared-https](../../tests/models/tla/previous-boot-shared-https/ArchiveHttps.tla) | 92 | 4 |
| [native-startup-owner](../../tests/models/tla/native-startup-owner/Owner.tla) | 136 | 5 |
| [native-restart-intent](../../tests/models/tla/native-restart-intent/RestartIntent.tla) | 40 | 4 |
| [stopped-pool-startup](../../tests/models/tla/stopped-pool-startup/Resume.tla) | 71 | 3 |
| [multi-root-share](../../tests/models/tla/multi-root-share/Shares.tla) | 55 | 5 |
| [dependency-rebind](../../tests/models/tla/dependency-rebind/Rebind.tla) | 21 | 10 |
| [dependency-auto-refresh](../../tests/models/tla/dependency-auto-refresh/AutoRefresh.tla) | 141 | 2 |
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
| [service-restart-policy](../../tests/models/tla/service-restart-policy/RestartPolicy.tla) | 134 | 6 |
| [relay-fence](../../tests/models/tla/relay-fence/RelayFence.tla) | 16 | 2 |
| [pool-emulation](../../tests/models/tla/pool-emulation/Emulation.tla) | 13 | 3 |
| [native-build-retention](../../tests/models/tla/native-build-retention/BuildRetention.tla) | 6,181 | 4 |
| [shared-helper-instance](../../tests/models/tla/shared-helper-instance/Instance.tla) | 7,649 | 11 |
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

### Retained shutdown evidence (HACK-1963)

`shutdown-rebase` checks `StopAdmitted`, `RetainedBeforeReset` and
`NoUnprovenPrune` for one graph, two logical services, one retired generation,
three old-container observations (absent/present/unknown), and presence/absence of
exact stopped history. `Archive`, `Rebase`, `Start` map to restore's confirmed
compute absence, `restore_history::retain`, `shutdown::rebase_stopped`, and receipt
projection/publication. History and reset are distinct crash boundaries; `Crash`
permits retry before new compute admission. `Repair` maps to explicit receipt-bound
selection and fresh immutable-ID absence in `shutdown::recover_rebase`.

The missing-reset control fails `StopAdmitted` at `Start`; the missing-absence
control fails `NoUnprovenPrune` at `Repair`. Rust shutdown rebase tests cover exact
IDs, refusal, bounded evidence history, retry and read-only selection; the plan
reconcile regression covers add/stop/remove/projection. The interrupted-cleanup
engine retains its independent owner, coordinator, inventory and per-stop journal
checks; the model does not prove those native effects. Assumptions: provider lease
serializes managed writers and engine absence observations are authoritative for
the inspected immutable ID. Uncovered: real VM/foreground signals, external Docker
writers, fsync failures, native publication retirement, boot rollover recovery,
application flush behavior and live container absence. Linux portable checks do
not qualify those macOS behaviors.
