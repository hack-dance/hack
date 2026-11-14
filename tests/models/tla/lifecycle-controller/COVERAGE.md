# Opt-in lifecycle controller ownership model

This finite model covers the CLI controller above the standalone physical-process
model. It has one instance, one creating operation and at most one adopting
operation. There is one initial launch and at most one incremental add. The native
owner token remains stable (`token = 1`), while adoption advances the cleanup epoch
from 1 to 2. It does not model arbitrary strings or independent project instances.

| Transition/property | Source owner | Regression boundary |
| --- | --- | --- |
| `Begin`, `PublishPending`, `Launch`; `DurableBeforeLaunch` | `createSupervisorLifecycleController.begin`, controller lock, common state publication before native `serve` | `tests/lifecycle-supervisor-controller.test.ts`; native launch failure retains a durable cleanup owner |
| `Accept`; `StableNativeOwner` | Controller `accept` and `publish`; native framed launch receipt | Controller readback and incremental real-process tests |
| `Adopt`, `Abort`; `NoAdoptedStop` | `decide` preserves the native ownership token and writes a new cleanup epoch; `stopOwned` checks that epoch before signaling | Creator abort after another controller adopts cannot stop the adopted process |
| `LoseReply`, `PublishLate`, `FailUnknown`; `LateFailurePublished` | Incremental launch failure inspects native state, accepts verified receipts and publishes before reporting the uncertain outcome | The real controller regression drops an incremental reply after its native effect and asserts both common-state publication before failure and native liveness of the late command |
| `Add`, `Stop`; `StoppedPreventsAdd` | Per-instance controller lock plus native launch/stop admission lock | `tests/lifecycle-supervisor-controller.test.ts`; `packages/lifecycle-supervisor/tests/incremental.rs` concurrent add/stop and add after completed stop |

Positive TLC exploration: **21 distinct states**, queue exhausted, depth 10.
`negative.cfg` removes only the cleanup epoch fence: `Abort` violates
`NoAdoptedStop`, with `unsafeStop = TRUE`, `epoch = 2`, `creatorEpoch = 1`,
`adopted = TRUE` and `stage = "Aborted"` in the same state. `pending.cfg` removes
only the pre-launch publication fence: `Launch` violates `DurableBeforeLaunch`
with `unsafeLaunch = TRUE`, `pending = FALSE`, `live = TRUE` and
`stage = "AwaitReply"` in the same state. Both controls exit 12 for the intended
invariant, rather than a parser or incomplete-state error. The maintained registry
pins the count and both complete same-state witnesses.

Checker: pinned TLA+ 1.7.4 jar (TLC reports 2.19), Java 17, two workers, 512 MiB
maximum heap and breadth-first search. Apalache is not qualified here.

The model treats each controller/native lock region as atomic. Therefore stop can
order before or after add but cannot interrupt its protected launch/publication.
The abstract stop proves absence; real unknown outcomes retain ownership and do
not authorize deletion. `nativePublished` represents the command receipt for the
current launch; it is cleared for add so a lost incremental reply must publish a
fresh verified receipt, rather than rely on the earlier launch's publication.
No fairness or eventual command exit is assumed.

Assumptions: private lock integrity, serialized writers for this instance, atomic
state publication, native readback that correctly separates live/unknown/absent,
and no hidden late effect after the protected native admission has settled. A
transport timeout can precede settlement: implementation reconciliation and native
locks handle that boundary, not an inference from socket absence.

Omissions: actual PID/session identity, native guardian failure, byte framing,
socket replacement, credentials, filesystem sync/power loss, scheduler timing,
multiple processes' independent liveness, multiple instances, command output and
default-runner migration. Physical-process ownership remains covered separately
by `LifecycleSupervisor.tla` and Rust tests. This small controller model is not
whole-product, macOS runtime, packaging or installed-artifact qualification.
