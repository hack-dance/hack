# Authored recovery before frontend Ready

[PreReady.tla](PreReady.tla) extends the existing frontend recovery coverage with
the absent-Ready selection and fresh admission release. It does not replace
`Recovery.tla`, which checks durable recovery-lease publication and takeover.

The positive configuration exhausts **160 distinct states** (184 generated,
depth 10), with five original classes (Ready, failed, cleanup, Preparing and
pending), two initial admission states, two attempts, one crash and one possible
foreign-owner replacement. TLC 1.7.4, Temurin Java 17, two workers and a 512 MiB
heap are the pinned runner configuration. Three controls intentionally fail:

| Control | First violating action and invariant | Implementation regression |
| --- | --- | --- |
| `pre-ready-negative` | `Cleanup` violates `OnlySettledCleanup` when the original is unsettled | Runtime settled selection and frontend protocol reject Preparing and pending effects |
| `pre-ready-release` | `Release` violates `ReleaseRecorded` without a durable release marker | Fresh admission crash test; missing marker refuses, failed release keeps exact directory/owner inodes |
| `pre-ready-replay` | `StartAnother` violates `NoReplay` during incomplete recovery | Admission refuses during recovery and between actual release and completion |

| Model action / guard | Source mapping |
| --- | --- |
| `Acquire`, `Commit`, `Settled` | `recoverUsing` chooses interrupted admission or holds fresh admission before recovery/mutation. Frontend intent v3 records absent Ready, start/source and full admission selection; runtime intent v2 pins the original receipt. `require_recovery_settled` and the frontend `settled` parser reject pending effects. |
| `Cleanup` | The existing native cleanup owner rechecks exact dead publisher, boot/incarnation, inventory and binding before stopping/removing. Original phase and per-resource ranks cannot regress; reserved resources never become created. |
| `RetireFiles` | `retireFiles`/`retireHooks` run only after authenticated Removed and null observations. Pre-Ready host checks require existing settlement and absent groups; they never signal. |
| `ArmRelease`, `Release`, `Complete` | `retireAdmission` saves `admission_releasing`; `withFreshRecoveryLock` releases only the exact recorded lease. A second pass requires absence. Incomplete v3 intents continue blocking ordinary admission in the gap. |
| `Crash`, `Resume`, `ReplaceOwner` | The child-process regression crashes before/after the release marker and actual release, then resumes only the recorded dead selection; release-callback failure preserves exact inodes. A changed owner grants no authority. |

Committed intent writes and native cleanup are atomic abstractions here.
Resource-state predicates, exact filesystem/process/guest identity, host
settlement and the nested recovery/mutation leases are assumptions checked by
source, the existing lease model and implementation tests. The diagram shows
the implementation decision flow, not an additional checked machine.
The model has no fairness or liveness claim and does not prove fsync durability,
unbounded retries, physical VM behavior, source/topology recovery, old-reader
compatibility or cleanup after an unknown pending effect. Legacy frontend v1/v2
and runtime v1 remain covered by regression tests with their original Ready
rules. Older bundles refuse the new unknown versions. The real-Mac plain-down
run after authored pre-Ready failure remains separate acceptance evidence.

![Authored recovery selection](flow.svg)

[Diagram source](flow.mmd), rendered with Pele 1.9.0, links/images disabled.
