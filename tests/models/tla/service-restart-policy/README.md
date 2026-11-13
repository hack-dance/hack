# Service restart policy

`RestartPolicy.tla` models one owned Compose-file graph container whose admitted
`restart` policy is lowered to the guest engine's own `HostConfig.RestartPolicy`
(`packages/runtime-core/src/provider/graph/restart_policy.rs`). It is a contract
model of the stop/restart interaction, not an implementation-refinement proof.

## Properties

1. `NoStaleIncarnation`: a generation-bound use (endpoint, exec or relay target)
   never acts on an incarnation other than the one it observed. An incarnation is
   the container ID plus `StartedAt`; a restart keeps the ID and changes
   `StartedAt`.
2. `NoIncarnationAfterStop`: after the owner's stop request, no new incarnation
   starts, including across a guest engine restart or VM reboot.
3. `TerminalProof`: terminal stop evidence is recorded only while `Running` and
   `Restarting` are both false.

## Source mapping

| Model action | Source boundary |
| --- | --- |
| `Exit` / `EngineRestart` | Engine policy behavior. A scheduled restart fires even after a policy update; only the stop's restart-manager cancel prevents it. The graph observes the pending state as `Observation::Restarting` (`provider/graph/mod.rs` `observation`), admitted only with a receipt policy (`probes::observe`). |
| `DaemonRestart` | Guest engine restore: an armed `always` container restarts even after a manual stop. |
| `Bind` / `Use` / `RefuseStale` / `Rebind` | Endpoint generations hash `StartedAt` (`endpoints.rs`). The foreground supervision tick uses `bridges/restart_rebind.rs`: fresh receipt policy, unchanged container ID, owned labels and complete network attachment; fenced retirement, publication removal and publisher reaping precede a fresh reservation and one launch. `RefuseStale` abstracts full retirement and `Rebind` abstracts fresh admission/reservation/start/publication. Relay lifecycle, fence and publication staging models retain the expanded intermediate states and uncertainty. Route probes rearm only after the old exec is independently inactive, using a new sample generation after `probe-rearm-samples.sh` clears only owned prior samples under the existing lock, without unmounting the running container’s probe state. Real-probe regression tests in `http_probe.rs` cover retained samples, partial `status.pending`, live-writer lock refusal, foreign generations and aliased files. Other HTTP probes, host dependencies, managed environment delivery and dependency caches remain refused. |
| `Disarm` | `shutdown::disarm_owned` / `disarm_one`: `update RestartPolicy=no` on every receipt-admitted container, confirmed by a fresh ownership-verified inspection, before any stop request. A policy the receipt never admitted refuses. |
| `RequestStop` / `EngineStop` | `shutdown::stop_owned` batch stop; `shutdown::prepare` accepts the engine `restarting` state only for a receipt-admitted policy. |
| `ObserveTerminal` / `RefuseNonTerminal` | `shutdown::terminal` requires a fresh observation that is neither running nor restarting before evidence is written. |
| `Remove` | `cleanup_owned_fenced` deletes without force after terminal evidence. |

## Controls

The positive configuration exhausts 134 distinct states with `MaxIncarnation = 3`
and at most one engine restart. Each negative control removes one guard and must
fail its property with a same-state witness. TLC's two-worker search does not
always report the shortest trace, so each control accepts every first violation
the model can reach, and nothing else:

- `negative.cfg` (no disarm): `DaemonRestart` after the stop request starts a new
  incarnation (`NoIncarnationAfterStop`), in the `stopping` or `stopped` phase.
- `unproved-terminal.cfg` (stop transport success taken as proof):
  `ObserveTerminal` records evidence while the engine is still running or has a
  pending restart (`TerminalProof`).
- `stale-generation.cfg` (no generation recheck): `Use` acts on a bound
  incarnation that is older than the current one, or on the current one after
  it stopped running (`NoStaleIncarnation`).
- `rebind-reachable.cfg`: `Rebind` reaches an incarnation after the first; this prevents vacuous restart coverage.
- `completion-reachable.cfg`: cleanup reaches removal with every guard enforced.

## Omissions

Replacement readiness is scoped to the selected host child in
`foreground/publishers.rs::publication_ready_with`; `owner_loop::PublisherReadiness`
keeps fresh startup's all-publishers-live guard distinct. The portable guard
regression and macOS two-real-child readiness-poll regression cover pending and
committed sibling exits, selected-child refusal and selected-only port-busy
classification. The native regression replaces the publication read boundary;
it proves neither guest readiness nor full VM rebind. This one-service model
abstracts publication readiness inside `Rebind` and does not check that
cross-service failure path. Both port and routed sibling rebinds remain VM gates.

The model does not cover transport timeouts or uncertain stop outcomes (existing
shutdown evidence and its tests own those), several services, the engine's backoff
timing or `on-failure` retry counting, durability of the receipt, or the real guest
engine. Ownership/labels/network validation and probe rearming are implementation
obligations, not modeled facts. A busy port has no successful Rebind transition. Real-engine behavior (a crashing `unless-stopped` service restarted by the
guest engine, a stop during restart backoff, and disarm before deletion) still
needs host evidence from a native foreground test on a prepared candidate VM.
