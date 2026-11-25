# Start graph coverage

`StartGraph.tla` models how one native `hack up` creates, starts, observes and
publishes a project's containers when an unchanged running container may be kept
(HACK-2459). It is the design model for the start graph slices. When this file was
added, no source path implemented the reuse or wave transitions yet. Each slice that
implements an action adds its source mapping and the test that walks it to the
table below.

## Bounds and result

Two services with one dependency edge (`b` waits for `a`), two generations per
service. The CI tier has two specs and one VM boot; `positive-reboot` has one spec
and two boots, so the boot fence is checked without edits. TLC 1.7.4, two workers,
deadlock checking on (the runner's default):

| Configuration | Expected result |
| --- | --- |
| `positive` | no error, **1,656,372 distinct states**, depth 40 |
| `positive-reboot` (`Specs = {1}`, `MaxBoot = 2`) | no error, **81,534 distinct states**, depth 36 |
| `negative` (`NoFence`) | `NoEffectWithoutIntent` at `Create`: a create from a staged, not yet durable intent |
| `ignore-deps` | `DepsBeforeStart` at `Start` |
| `no-publish-fence` | `NoPublishToReplaced` at `Publish`: the container was removed between snapshot and commit |
| `reuse-by-name` | `ReturnIsCurrent` at `Return`: an edited service kept by name |
| `no-unpublish` | `NoReplaceWhileRouted` at `RemoveOld` |
| `keep-across-boot` (`MaxBoot = 2`) | `ReturnIsCurrent` at `Return`: a restart-policy container kept after a reboot with attachments from the old boot |
| `blind-retry` | `OneContainerPerService` at `Create`: after an uncertain create (a lost reply or an owner takeover; the witness does not tell them apart), a second create without inspecting |
| `reachable-noop` | `NeverNoOpUp` at `Return`: an `up` that began on a current, ready and routed project (`base = TRUE`) returns without planning anything |

The positive run with two specs and two boots is outside the CI budget and is not part
of the runner.

The boot fence is layered: `Ready`, the dependency check in `Start` and the publish
fence each refuse a container whose attachments are from an earlier boot. Removing the
`Ready` guard alone does not violate anything, because the other two still hold.
Removing it together with the dependency check violates `DepsBeforeStart`, and together
with the publish fence's boot check violates `NoPublishToReplaced`, both on
`positive-reboot` (checked by hand when this model was added, not in CI). The unsafe-step
flags are judged by the true condition (`DepsSafe`, `PublishSafe`), never by the guard
they check, so a weakened guard cannot also weaken its own judgment.

## Invariants

- `NoEffectWithoutIntent`: every container that exists has a durable intent naming its service, generation and spec.
- `DepsBeforeStart`: a service starts only after every dependency is ready, with attachments made in this boot.
- `NoPublishToReplaced`: a route is never committed to a replaced, unready or previous-boot generation.
- `NoReplaceWhileRouted`: the owner never removes a container while a route points at it. An external removal of a routed container (`ExtRemove`) is a modelled failure and is not covered.
- `OneContainerPerService`: at most one container exists per service.
- `ReturnIsCurrent`: `up` returns only when every container runs the current spec with attachments made in this boot.
- `DoneIsCurrent`: done means every service runs the current spec, made in this boot, ready and routed (readiness is asserted, not only guarded).

## Source mapping

| Model action | Planned source boundary | Status |
| --- | --- | --- |
| `Plan`, `Reusable` | the reuse decision from one labelled list and the receipt | not implemented |
| `Flush` | one grouped receipt save per wave | not implemented |
| `Create`, `Inspect` | wave creates; a lost reply is inspected by name before anything else | not implemented |
| `RemoveOld`, `Unpublish` | replacement removes the old generation after its slots are released | not implemented |
| `Start`, `Ready` | `project::execution` evaluator; readiness from the list or probe sample | today's serial evaluator only |
| `Snap`, `Publish` | the publication batch fence | publication batch, outside this model |
| `Crash`, `Reboot` | owner death; a new guest incarnation (`load_at` refuses another incarnation) | today's cleanup paths |
| `Return` | the foreground owner's `graph_foreground_started` line, printed after the receipt is saved in `started-observed` (`execution::Event::AllStarted`, `graph::Session::record`), only with `graph serve --report-started` | implemented in the runtime; the CLI does not pass the flag yet and still returns at `Done` |
| `Done` | the `graph_foreground_ready` line after the receipt is saved in `ready-observed` (`Event::Ready`) and publishers have started | implemented |

In the runtime, "started" is Compose's rule: every service has been started and its
latest observation is running or exited 0, after each dependency edge's own condition
held (a `service_healthy` or `service_completed_successfully` edge still holds its
dependent back). Health and route goals are not part of it. The model's `Return`
guard is stronger: it also asks for the current spec and this boot's attachments,
which the start loop guarantees by construction today (it creates every container
fresh), not by a check at `Return`.

`DepsReady` is decided on a fresh observation. Within one evaluation pass the
evaluator keeps each observation: an edge whose dependency was already seen this
pass not meeting its condition waits for the next pass without asking the engine
again, while an edge that would allow a start observes the dependency afresh right
before it (`execution::run_with_clock`). The model has no passes; a reused
"not yet" only defers a start by one pass, which it does not distinguish.

## Not covered

Engine event loss and stale events; more than one owner or two concurrent `up`
commands; the concurrency cap; probe allocation, env staging and relay startup as
separate steps (folded into `Start` and the boot-bound attachment); network and
volume nodes (`native-plan-reconcile`, `native-cache-reconcile`); the publication
batch's own phases; liveness (no fairness is assumed); filesystem durability; the
real engine. A passing run does not qualify the implementation.

## State chart

`statechart.mmd` is the per-service state chart that goes with this model, rendered
with Pele 1.9.0 into `statechart.svg` and a 2x `statechart.png`. It is a review aid
with more states than the model (probe, publication and retirement detail); the model,
not the chart, is checked.
