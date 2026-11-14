# Status during native startup (HACK-2110)

Question: can a presentation read make a start fail at a provider lease acquisition,
including after its service containers are running?

![Status observation and startup ownership](flow.svg)

[Diagram source](flow.mmd); the decision diagram is an implementation overview,
not an additional checked model. The cleanup branch describes adopted recovery.

`StatusStart.tla` enumerates one start, one overlapping reader and seven acquisition
stages: pool, relay, graph, probes, reservation, bridge and publisher. The first
three stages already wait for acquisition; the later stages refuse immediately.
The positive instance makes reads lease-free. The negative instance restores the
exclusive read lease and violates `ReaderNeverFailsStart` at `ReaderRefusal`, with
services already running and the reader holding the lease.

## Source and regression mapping

| Transition/property | Implementation | Regression |
| --- | --- | --- |
| Read / ReadDone never own the provider lease | `graph/status.rs`, `engine/inspection.rs`; adopted owner-status uses `Observer`; authored `Action::Observe` uses `runtime::status` | `status_and_mutation_overlap_without_taking_each_others_lease`, journal replacement/pending ABA/in-place mutation tests; frontend observe/ps fixtures |
| Initial bounded acquisition; holder named on expiry | `lifecycle::startup_lease`, `operation_lease`, `state::Lock` | `project_start_waits_for_a_legacy_status_holder_then_runs_without_replaying_admission`, `lasting_status_holder_is_named_at_the_acquisition_deadline_without_starting_services` |
| Later acquisition refuses a held lease | publisher startup, probe supervision and bridge publication | Negative control reproduces the old interleaving; actual lock test confirms second-mutator refusal |
| Down requires exact dead-owner proof | `native-project-down.ts`, `live_owner_cleanup.rs` | Plain-down frontend tests, settled-binding and missing-proof Rust tests; recovery repeats proof checks under its lease |

Authored `Action::Status` remains the full locked readiness check. Presentation
`Observed` replies cannot satisfy it. Status never records failure or reaps a
publisher. Failure recording remains at startup/effectful verification and owned
cleanup; first failure wins. Cleanup captures before stopping listeners and folds
evidence into its required journal commit. Incomplete-rebind cleanup does not
capture new listener exits. An owner crash before cleanup cannot reconstruct its
host child's exit. No background recording tick or new control-loop lease exists.

## Bounds and proof limits

Positive: **110 distinct states**. Negative: the named invariant fails with
`failedByReader = TRUE`, `services = TRUE`, `reader = TRUE`, `lease = "reader"`.
Both use the repository checksum-pinned TLC 1.7.4 distribution (banner 2.19),
Temurin 17.0.20+101, two workers and a 512 MiB heap. The registry verifies the count
and same-state negative witness. Apalache is not run.

Each stage's effects are atomic in this model. There is no fairness or liveness
claim. The model does not implement filesystem durability, guest identity, socket
transport, bounded wall-clock waits or recovery journals. `SecondMutation` is an
assumption preserving existing refusal, not an independent proof of admission.
`Down` abstracts complete exact-death/identity proof and assumes no uncertain
pending effect; it does not prove arbitrary failed-start recoverability. Unknown
identity never authorizes cleanup. Authored pre-Ready recovery is unchanged.

The held-lock test uses real flock and a fake native backend; it proves bounded
acquisition plus graph execution, not macOS provider behavior. Mac-only cleanup
and publisher tests require hosted macOS execution; cross-Clippy only compiles
them. Lead acceptance polls `ps` every 0.5 seconds through ten real VM starts,
including cross-project observation in the same pool, and checks plain `down`
after a post-service failure. Portable green checks do not replace that gate.
