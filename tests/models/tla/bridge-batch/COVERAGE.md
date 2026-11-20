# Bridge batch (HACK-2442)

[BridgeBatch.tla](BridgeBatch.tla) models one foreground owner publishing a
batch of two bridges (route `r`, loopback port `p`) and a cleanup releasing
them, with one provider lease, container replacement and health loss at any
time, and owner and cleanup crashes between any two steps.

Charts (Pele, house theme): [start](../../../../docs/assets/diagrams/bridge-batch-start.light.svg),
[release](../../../../docs/assets/diagrams/bridge-batch-release.light.svg) and the
[request path](../../../../docs/assets/diagrams/bridge-batch-sequence.light.svg);
Mermaid sources sit next to them.

## Invariants (`Safe`)

| Invariant | In plain words |
| --- | --- |
| `IntentBeforeEffect` | No relay runs in the guest unless its slot's durable phase says it was started (`starting`, `running` or `stopping`). |
| `NoUnadmittedPublication` | A host listener is launched only after its own fence, in the same lease hold, observed a running relay whose container was the reserved, healthy incarnation. This is an admission property: the container can still change between that fence and the launch (the relay stays pinned to the fenced incarnation; forwarding and restart rebinding are `loopback-port-publication` and `service-restart-policy`). |
| `ListenerClosedBeforeRelayStop` | A relay is never stopped while its host listener still serves. |
| `ReleaseComplete` | A finished release leaves no relay and no live listener. |
| `ReadyComplete` | `ready` means every bridge of the batch is `running` and published. A ready owner can then shut down (Ctrl-C, `down`) or die, and cleanup releases the run. |

## Checked bounds

TLC 1.7.4, 2 workers, `MaxCrashes = 2` (owner and cleanup crashes share the
budget), two slots, one replacement and one health loss per container.
Positive: 14,674 distinct states, 46,907 generated, depth 35, no violation.

| Control | Guard removed or witness | Expected result |
| --- | --- | --- |
| `negative` | `EnforceIntent = FALSE`: relays start before `starting` is saved | `Safe` violated at `Relays` |
| `child-fence` | `EnforceChildFence = FALSE`: a child launches although its fence refused | `Safe` violated at `ChildLaunch` (container replaced after the batch) |
| `release-order` | `EnforceReleaseOrder = FALSE`: relays stop before listeners close | `Safe` violated at `CleanStop` (an orphan listener of a crashed owner) |
| `ready-reachable` | `NeverReady` | reached at `Await` |
| `release-reachable` | `NeverReleased` | reached at `CleanDrop` |
| `release-after-ready` | `NeverReleasedAfterReady` | reached at `CleanDrop` after a ready batch with both listeners published was shut down |
| `stale-stop-reachable` | `NeverStaleStop` | reached at `Fence3` (one slot stopped, the other running) |

Run by `bun run test:models` (`scripts/lib/tla-runtime-models.ts`, entry
`bridge-batch`).

## Source mapping and executable regressions

| Action | Source (`packages/runtime-core/src/provider/`) | Rust test walking it |
| --- | --- | --- |
| `Reserve` | `graph/bridges.rs` `reserve_publications` / `reserve_all` | `bridges::batch_tests::routes_and_ports_reserve_from_one_observation_in_one_update` |
| `OwnerAcquire`, `Fence1`, `Fence2`, `OwnerRefuse` | `start_bridges`, `start_selected` steps 1–3, `inspect_targets` | `target_restarted_before_relay_intent_refuses_with_nothing_recorded`, `health_lost_after_reservation_refuses_like_a_restart` |
| `Intent`, `Relays` | `start_selected` steps 4–5, `relay.rs` `start_all`, `relay-batch.sh` | `one_lease_starts_every_relay_with_one_guest_call_per_step` (asserts `starting` is on disk inside the relay call), `unconfirmed_relay_start_retains_every_launch_intent_for_cleanup`, `relay::tests::batch_wrapper_runs_each_slot_with_its_arguments_and_the_payload` |
| `Fence3` | `start_selected` step 6 | `target_restarted_mid_batch_stops_only_its_relay_and_refuses` |
| `Spawn`, `Await`, `Shutdown` | `foreground/publishers.rs` `Publishers::start`, `await_published` | macOS only: type-checked; exercised by the native fixtures and the lead's VM runs |
| `ChildAcquire`, `ChildFence`, `ChildLaunch` | `bridges.rs` `connect_waiting`, `publish_bridge` (fence and relay inspect, then `publication::launch`) | `health_lost_after_reservation_refuses_like_a_restart` (child fence) |
| `CleanAcquire` … `CleanDrop` | `bridges.rs` `release_selected` (#1015; before it, `release_run` ran the same phases one slot at a time), `publication.rs` `release_reservations` | `release_retires_each_phase_for_the_whole_run_in_order`, `refused_batch_stop_keeps_every_slot_and_the_next_release_resumes` |
| `CleanCrash`, `OwnerCrash` | process death; the kernel releases the `flock` lease | the resume tests above |

## Assumptions and what is not covered

- A fence is one atomic read; the real fence is several engine GETs under the
  lease. The child's fence and its launch are separate steps, and nothing
  re-checks the target between them: the model admits a change there, and the
  property is stated as admission by the observation, not freshness at launch.
- The per-slot `stop_slot` used for a slot found stale after its relay started
  is one step; its own phases are covered by `relay-fence` and
  `relay-lifecycle-barrier`.
- Journal saves are atomic. Single-step pending-journal recovery of the
  publication journal is `publication-journal`; the release keeps one entry
  removal per save so that recovery still applies.
- Outside this model: partial effects inside one guest batch call (some relays
  started, the call refused), a crash between spawning two children, and a
  crash inside `Fence3`'s host and guest stop of a stale slot. The per-slot
  `relay-fence` and `relay-lifecycle-barrier` models cover a single slot's
  phases; their composition with the batch is not checked here.
- One guest boot. Earlier-boot relays (marked `stopped` without a guest call)
  are covered by Rust tests, not this model.
- No liveness: the model does not claim that a waiting child or a cleanup
  eventually runs. Real `flock` fairness, guest scheduling, publisher process
  identity, kqueue stop and filesystem durability remain implementation and
  Apple Silicon VM gates.
