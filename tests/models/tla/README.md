# Runtime state models

Run `bun run test:models` with Java 17 available and `TLA2TOOLS_JAR` pointing to
TLA+ 1.7.4's `tla2tools.jar`. The runner checks the SHA-256 before executing Java:

```text
936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
```

Official artifact:
https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar

`JAVA_BIN` may select an explicit Java executable. The runner does not install tools
or change global Java settings. CI's Runtime state models job supplies Java and the
pinned artifact. Each check has a 120-second timeout, 512 MiB Java heap, two workers
and bounded output; temporary TLC metadata is removed after success or failure.
No credentials or running VM are needed.

## Graph admission

`graph-admission/Admission.tla` checks the smallest admission race: two clients
competing for one capacity unit. The positive configuration requires the lock
across capacity observation and reservation; the negative configuration removes it.
The positive run must explore all five expected distinct states. The negative run
must produce TLC's invariant-violation exit code, name the `Capacity` invariant and
show both clients occupying the unit. A syntax error, crash, timeout, wrong invariant
or arbitrary nonzero exit is not a successful negative control.

| Model element | Implementation boundary |
| --- | --- |
| `Check` | `provider/graph/admission.rs::check`, under the `OwnedGuest` provider lock |
| `Reserve` | durable preparing receipt and container allocation in graph run/restore |
| `used` | other graphs' retained compute reservations, including exited containers |
| `Retire` | ownership-verified graph cleanup completes before capacity is available |
| `owner` | provider mutation lease held through observation and allocation |
| `Capacity` | combined reservations cannot exceed the admitted capacity |

Paths above are relative to `packages/runtime-core/src/`. The abstraction represents
one capacity dimension; Rust regression tests cover actual CPU, memory and service
limits. It omits crashes, source-job coexistence, engine failures, route lifetime,
filesystem persistence and scheduling fairness. Passing it does not prove those
properties or that all callers hold the lock correctly. Keep the live two-graph
and over-budget controls and ordinary Rust tests as implementation evidence.

When changing admission semantics, review the model and mapping, rerun both controls,
and update expected exploration bounds only with an explanation. Preserve useful
counterexamples as ordinary regression tests. Add recovery and idle/wake models when
their state machines and concrete invariants are defined; do not expand this small
model merely to represent unrelated product behavior.

## Balloon reuse accounting

`balloon-reuse/BalloonReuse.tla` models one guest mapping's unmap, discard,
reuse-accounting restoration, remap, and terminal failure transitions. The positive
model explores seven states. Its invariant requires mapped guest memory to be
outside the host's reusable/discounted accounting state. The negative control omits
reuse accounting and must fail `MappedMemoryAccounted` with both `phase = "mapped"`
and `reusable = TRUE` in the same remap step. Fields appearing in different trace
states, another invariant, or a tool failure do not qualify the negative control.

| Model action | Provider boundary |
| --- | --- |
| `Unmap` | Successful `hv_vm_unmap` in libkrun `balloon_reclaim_range` |
| `Discard` | `MADV_FREE_REUSABLE`; both success and failure are represented |
| `Reuse` | Experimental correction: successful `MADV_FREE_REUSE` before remapping |
| `ReuseFailure` | Refuse a live mapping and stop on failed reuse accounting |
| `Remap` / `RemapFailure` | Successful `hv_vm_map`, or existing fatal remap failure |
| `Stop` | Abstract terminal shutdown of this mapping's owning process |

This is the intended contract for the **experimental correction**, not a claim that
Hack's currently pinned provider implements it. The pinned libkrun commit
`5de9ab51c1bb166af2324de3c9413d00022eb178` omits reuse advice in
`src/hvf/src/lib.rs::balloon_remap_if_reclaimed`. The native accounting control and
initial matched guest results are recorded in the
provider investigation (local `_docs/docs/plans/v5/balloon-guarded-pair-20260916.md`).

The model abstracts the serialized reclaim-map lock and one mapping. It omits PFN
sorting, overlapping ranges, mapping geometry, multiple vCPUs, real kernel return
codes, physical residency, persistent data, performance and process restart. A
passing model cannot replace native accounting, mapping-boundary or guest readback
tests, and must not turn an apparent footprint reduction into a RAM-savings claim.

## Restore history retention

`restore-history/RestoreHistory.tla` models publication of a bounded history window,
legacy retirement, process crashes and repeated capture/restore. Capacity 2 and
limit 6 explore 27 states, including more restores than history slots. The negative
control retires legacy history during preparation; it must violate
`HistoryPreserved` in a single `Prepare` state with both legacy and committed
manifest empty. The verifier rejects unrelated failures or split-state evidence.

| Model action/state | Implementation boundary |
| --- | --- |
| `Prepare` / `pending` | Deterministic replacement from committed history and the current receipt |
| `Publish` / `manifest` | Synced atomic `restore-history.json` publication |
| `Retire` / `legacy` | Witness-checked removal of legacy diagnostic files after publication |
| `Crash` | Pending-prefix recovery or resumption after a published manifest |
| `Restore` / `current` | Graph execution continues using current state, never a historical receipt |
| `HistoryPreserved` | The last committed bounded window remains available across transitions |

Implementation: `provider/graph/restore_history.rs`, relative to
`packages/runtime-core/src/`. Process-kill tests at pre-publication, publication
and retirement boundaries exercise the model's ordering; partial-prefix, foreign
content, symlink/hardlink and byte-budget tests cover filesystem details omitted
by the abstraction. The model does not prove fsync semantics, hash collision
resistance, malicious same-user races, byte limits, eventual progress under
unlimited crashes, engine behavior or persistent-volume correctness. Live migration
and repeated data readbacks remain separate acceptance gates.

## Organization and recovered runtime models

Each topic directory owns its source modules and finite `positive.cfg` /
`negative.cfg` controls. Broken modules are intentional negative controls, never
implementation alternatives. This follows the topic/module/config organization of
[the official TLA+ examples](https://github.com/tlaplus/Examples); the directory
name `tests/models/tla` is Hack's convention. Reusable authoring and artifact
handling instructions live in the repository's `hack-repo-tla` skill.

The runner copies sources to temporary scratch space before invoking TLC, then
removes sources and generated state on success or failure. Private originals and
review snapshots in `.hack-local` are historical evidence, not canonical sources.
Generated trace-validation wrappers were not promoted: the core models below do
not claim trace replay coverage. The three earlier model families above already
have canonical copies and were not duplicated.

| Topic | Positive distinct states | Contract and negative control | Implementation boundary under `packages/runtime-core/src/provider/` |
| --- | ---: | --- | --- |
| authority-snapshot | 11 | Deliver to the observed reservation or fail; reusing the frontend delivers generation 2 after observing 1 | `hostname_authority.rs`, `hostname_authority/managed.rs` routing ownership |
| authority-lifetime | 9 | Authority cannot outlive completed runtime shutdown; removing the startup lease permits a late bind | `hostname_authority.rs` startup lock and shutdown |
| publication-journal | 50 | Recovery cannot adopt a live writer's pending entry; unsafe recovery violates that condition | `publication.rs` journal recovery |
| publication | 16 | A live native publication retains its intent, directory and guest; early retirement breaks ownership | `publication.rs`, `publication_stage.rs` |
| fence-first | 24 | First recovery needs terminal prior state, no occupied slot, and complete evidence; ignoring occupancy fails | `graph/relay-fence.sh` initial recovery |
| fence-pending | 7 | Recover only permitted pending transitions; accepting launching-to-stopped leaves a live process | `graph/relay-fence.sh` pending recovery |
| relay-staging | 9 | Discarded preparation cannot contain a live child; discarding an authorized launch fails | `publication_stage.rs` and `graph/relay-fence.sh` launch ordering |
| relay-fence | 16 | Retired generations cannot launch again; removing the monotonic fence allows stale launch | `graph/relay-fence.sh` generation fencing |

These are small safety abstractions recovered from local investigations. Snapshot
uses two generations; relay fencing uses `Limit = 3`; journal counters stop at 4;
other models use finite phase/boolean sets. No fairness or eventual-progress claim
is made. The first-fence model checks an admission predicate, not an interleaving
proof. Journal `skipped` is constrained by the recovery guard and its negative
control specifically tests live-writer recovery, not every corruption condition.
OS process identity, file locks, fsync, symlink races, host mounts, credentials,
network behavior and actual crash recovery require implementation tests and live
qualification. A passing abstract model does not close those runtime gates.

Runtime contracts in `scripts/lib/tla-runtime-models.ts` require completed positive
exploration at the stated bound. Negative runs must exit with TLC code 12, name the
intended invariant, and contain the expected action and violating fields together
in one state. Parser failures, wrong invariants, split-state evidence and timeouts
are rejected.

## MCP startup watchdog design

`mcp-startup/Startup.tla` checks the startup handoff's finite safety contract.
Implementation tests qualify the specific native boundaries below; this model is
not a complete implementation or recovery proof. With two clients, the positive configuration explores 27 distinct
states. The negative control grants readiness before relinquishing timeout authority;
it must fail `NoRevokedGrant` in one `Timeout` state containing both `granted = TRUE`
and `killed = TRUE`. A grant waiting in an inherited channel is already observable:
waiting until a separate ready receipt is noticed is too late to authorize a kill.

| Model action | Intended implementation boundary / present status |
| --- | --- |
| `Request` | `src/mcp/startup-channel.ts` observes loss early and requests permission after ownership publication |
| `Commit` | `mcp_owner/supervision.rs::run` disarms its direct-child guard before writing the grant |
| `Grant` / `Ready` | Separate channel delivery, asynchronous grant validation, descriptor closure and `socket-backend.ts` session activation |
| `Timeout` | `UngrantedChild::drop` kills/reaps only a retained direct child before commitment; adapter cleanup remains limited to its direct launcher |
| `Release` | Native supervisor exits after grant without a resident helper; the backend retains the inherited lease |
| `Attach` / `Detach` / `Retire` | Existing per-client sessions and backend idle retirement, exercised by `tests/mcp-managed-startup.test.ts` |
| `BackendCrash` / `WatchdogCrash` | Process loss before/after handoff; native tests cover post-publication timeout recovery and refusal of a later grant request after supervisor loss |

The backend's independent grant-channel deadline maps to `BackendCrash`: before
grant acceptance it departs without activating sessions. The native owner sets
eight-second receive/send socket timeouts before exec; these end with that private
descriptor and do not affect MCP session I/O. After poll returns, the supervisor
rechecks its absolute deadline before accepting queued readiness. The stopped-owner
test observes publication, bounded refusal and owned cleanup, then resumes the
fixture owner for reaping and lease release. The unchanged finite model checks
handoff safety only; its state graph does not prove either elapsed-time bound.

The finite safety check separates commitment, grant visibility, readiness, client
attachment, retirement and process loss. `Commit` is a local serialized decision,
not a claim that filesystem writes are atomic. It assumes a direct-child handle
cannot be reused before reaping. No fairness, wall-clock deadline, eventual recovery,
pipe behavior, signal delivery, inherited-descriptor correctness, filesystem cleanup
or malicious same-user interference is proved. A watchdog lost before granting can
leave an unready child; this is intentionally represented and remains an open
recovery/liveness requirement. A backend stuck before reaching the grant exchange
can outlive a lost supervisor. `tests/mcp-startup-supervision.test.ts` checks the
real channel, unready timeout/reaping, valid-receipt cleanup, supervisor exit after
grant, supervisor-loss refusal and forced grant-write failure. The failed-write
control suspends the supervisor until its peer has queued a request and closed the
channel; commitment must still prevent killing. Managed 32-client tests cover the
integrated launch path. These tests do not prove all crash windows or eventual
recovery and do not authorize default rollout based on a finite model pass.


## MCP startup cancellation

`mcp-startup-cancellation/Cancellation.tla` has ten positive states: idle; pending,
owned and published with either cancellation value; ready without cancellation;
and closed with either cancellation value. Cancellation means observed channel
failure/deadline, not the instant a remote process physically exits. `Complete`
represents finishing an already-started filesystem effect and capturing its
ownership evidence. `Publish` represents initiating the next publication effect,
not an atomic filesystem transaction or a guarantee that an in-flight write cannot
finish after cancellation. Refusal waits for that completion before cleanup.

The negative control removes the pre-publication check and must violate
`NoLatePublication` in one `Publish` state containing `cancelled = TRUE` and
`latePublication = TRUE`. `NoCancelledReady` also holds in the positive model.
`tests/mcp-startup-supervision.test.ts` maps this counterexample to a claim-creation
barrier: supervisor loss is observed before a delayed effect returns; publication
must not resume, the owned claim is removed and replacement ownership succeeds.
The old implementation fails by binding after the delayed effect completes.

This model checks cancellation ordering at an await boundary. It omits filesystem
errors, malicious replacement, descriptor reuse, elapsed time, blocked JavaScript,
permanent I/O stalls and liveness/fairness. Real descriptor callbacks must settle
before close, and the startup descriptor must close before session activation.
The existing startup model separately covers commit-before-grant kill authority.


## Relay authorization and revocation

`relay-authorization/Authorization.tla` asks whether an already authenticated session
can admit a write after its authority is revoked. The positive model holds one mutex
from `Check` through `Write`; `Revoke` takes that mutex. Its seven states comprise
initial/new, ready, checked and done while active, plus revoked new/ready/done.
The negative control drops the lock after checking and must fail `NoLateWrite` in
`Write` with `active = FALSE`, `phase = "done"` and `lateWrite = TRUE` together.

| Action/state | Implementation boundary |
| --- | --- |
| Authenticate | Successful `relay_auth::ServerHandshake::finish`; crypto validity is assumed in this model |
| Check / held | `AuthorizedSession::with_active` locks the authority and requires its key to remain present |
| Write | Bounded non-reentrant effect callback while the mutex guard remains held |
| Revoke / active | `Authority::revoke` clears the stored key under the same mutex |

This finite one-session abstraction checks effect admission, not network delivery.
Bytes written before revocation may still be in kernel buffers. It omits cryptography,
OS scheduling, callback cancellation, multi-process state, VM lifecycle events, key
provisioning and socket shutdown. The Rust race/poison/revocation tests are the source
regressions; a model pass does not prove consumers wrap every effect correctly.


## Managed relay lifecycle barrier (model and implementation mapping)

`relay-lifecycle-barrier/Barrier.tla` checks the retirement protocol used to guide
managed relay lifecycle work. The implementation now includes a durable coordinator,
private owner control transport, graph cleanup enrollment and a foreground managed
owner. One owned synthetic graph now qualifies initial dependency exchange, health and
enrolled cleanup through the startup integration. This is not full application or
crash-recovery qualification. The model remains an abstraction: its pass does not prove these source paths, native
behavior, or general graph/VM lifecycle acceptance.

In the model, a lifecycle operation records target retirement intent before requesting
revocation.
The relay owner stops each targeted capability (`Revoke`) and drops each service's
owned connections and queues (`Drain`) in separate transitions, then acknowledges
the specific owner/command incarnation only after all targets have retired.
`BeginEffect` requires that matching acknowledgement or confirmed death of the exact
owner. Missing response, a timeout, or a stale PID is not death proof. The model
assumes the owner exclusively holds all relevant sockets/capabilities; inherited
copies must be ruled out before process death can justify fallback.

`BeginEffect` and `ConfirmEffect` are separate transitions. The latter represents
verified new graph/VM identity and a confirmed receipt; it is not an atomic mutation
plus filesystem write. A crash between them leaves targets fenced. Registration
remains blocked by retained intent until confirmation, including after owner restart.
An acknowledgement can be lost and resent; coordinator recovery changes its command
incarnation and cannot reuse a previous acknowledgement. Other services can keep
writing during targeted retirement; a VM-wide change targets both modeled services.

| Model boundary | Current source mapping and limits |
| --- | --- |
| BeginMutation / journal | `relay_owner/lifecycle_intent.rs`: `Coordinator::begin_graph_enrolled` persists the graph selection through its callback before publishing Intent. `graph/host_relay.rs` records the matching `Receipt.relay_cleanup`; `graph/cleanup_enrollment.rs` blocks ordinary mutations and unsafe retention while enrollment is unresolved. This is a graph cleanup integration, not a claim that every VM lifecycle operation uses the barrier. |
| Revoke / Write | `relay_auth::Authority::revoke`, the effect guard, and `relay_owner.rs::retire`; the separate authorization model checks their mutex boundary. |
| Drain / Acknowledge | `RelayOwner::retire` retires the selected authorities and closes their owned flows before producing the matching acknowledgement. `relay_owner/transport.rs` handles bounded selection/retirement exchanges; `publication.rs` pins the private endpoint and native peer identity. `managed.rs` owns the foreground reactor, listener admission and revoke-before-listener-drop shutdown. |
| OwnerCrash / ObserveDeath | Native process start/executable identity is checked at the publication/transport boundary. The managed owner publishes its foreground process identity, which does not independently prove reactor-thread liveness. The model's confirmed-death alternative is not permission to bypass the implementation's fresh retirement proof after a timeout or thread failure. Exclusive descriptor ownership and any death fallback require separate evidence. |
| BeginEffect / ConfirmEffect | `Coordinator::execute` durably records EffectStarted before the effect; recovery cannot replay it. `graph/host_relay.rs::{resume_relay_cleanup,confirm_relay_cleanup}` distinguishes pre-effect resumption from independent post-effect inspection, including archived receipts. Confirmation persists the graph marker before coordinator acknowledgement permits rollover; pending acknowledgement also gates retention. |
| Register | `graph/host_relay.rs::HostRelayService` derives graph/service bindings from inspected identity. `relay_owner/managed.rs::register` uses a caller-selected graph, slot and captured host endpoint; untrusted traffic cannot select a registration. `graph/startup/runtime.rs` provisions the canonical credential through private stdin to the verified guest executable and releases the application gate. The native synthetic startup fixture requires authenticated dependency traffic before initial health; listener binding alone is not readiness, and failure/crash windows remain separate gates. |

One abstract connection per service represents all its pending/active sockets and
retained queues; implementation acknowledgement must account for all of them. The
command incarnation must bind a unique operation and its exact target generations,
not just a coordinator PID.

The finite model has two services, one lifecycle change (one service or both), two
resource generations, at most one owner restart and one coordinator restart. It
explores 1590 states. It checks no effect starts with an unretired target and no
active connection writes under the wrong generation. TLC coverage includes effect
confirmation, fresh registration and unrelated-service writes. No fairness/liveness,
elapsed time, cryptographic proof, filesystem durability, malicious replacement,
process inheritance, transport authentication or kernel-buffer recall is modeled.
Already delivered bytes cannot be recalled by revocation.

The maintained negative control bypasses the barrier and must violate
`NoUnretiredTarget` in one `BeginEffect` state with `unsafeCommit = TRUE`,
`phase = "effect-started"`, retained journal, live owner and both connections still
present. Parser errors or an arbitrary nonzero exit do not satisfy that witness.

Implementation regression coverage lives in `relay_owner/lifecycle_intent/tests.rs`,
`relay_owner/{tests,publication/tests,managed}.rs`, and graph cleanup/enrollment tests.
`graph/host_relay/live_tests/recovery.rs` exercises owned interrupted cleanup and
confirmation boundaries; `graph/startup/native_test.rs` defines the separate initial
application-health acceptance fixture. A test's presence is not a passing run.
Record the exact source/artifact and result when claiming component or native proof;
the synthetic startup fixture passed on September 17, 2026; its 64 KiB exchange,
initial health and confirmed cleanup do not qualify Event Agent or all failure paths.

Keep the remaining acceptance questions explicit: lost acknowledgement and resend,
stale owner/command evidence, death versus timeout, pre/post-effect crashes without
replay, selective retirement with unaffected traffic, and new-generation provisioning
must be tied to the actual operation being claimed. Component checks, the model and
one graph cleanup fixture do not establish every VM mutation, complete application
compatibility, resource improvements or release readiness. The model also omits the
implementation's graph-receipt/coordinator acknowledgement gap and startup release
gate; those require their own implementation tests rather than an expanded claim
about this unchanged specification.
