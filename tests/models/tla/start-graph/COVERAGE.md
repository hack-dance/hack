# Start graph coverage

`StartGraph.tla` models how one native `hack up` creates, starts, observes and
publishes a project's containers when an unchanged running container may be kept
(HACK-2459). It is the design model for the start graph slices. When this file was
added, no source path implemented the reuse or wave transitions yet. Each slice that
implements an action adds its source mapping and the test that walks it to the
table below.

## Bounds and result

Two services with one dependency edge (`b` waits for `a`), two specs, two
generations per service. The CI tier allows one VM boot (`MaxBoot = 1`). TLC 1.7.4,
two workers, deadlock checking on (the runner's default):

| Configuration | Expected result |
| --- | --- |
| `positive` | no error, **1,119,624 distinct states**, depth 39 |
| `negative` (`NoFence`) | `NoEffectWithoutIntent` at `Create`: a create from a staged, not yet durable intent |
| `ignore-deps` | `DepsBeforeStart` at `Start` |
| `no-publish-fence` | `NoPublishToReplaced` at `Publish`: the container was removed between snapshot and commit |
| `reuse-by-name` | `ReturnIsCurrent` at `Return`: an edited service kept by name |
| `no-unpublish` | `NoReplaceWhileRouted` at `RemoveOld` |
| `keep-across-boot` (`MaxBoot = 2`) | `ReturnIsCurrent` at `Return`: a restart-policy container kept after a reboot with attachments from the old boot |
| `blind-retry` | `OneContainerPerService` at `Create`: a lost create reply, then a second create without inspecting |
| `reachable-noop` | `NeverNoOpUp` is violated: a later `up` of a routed, unchanged project returns without planning anything |

The positive run with `MaxBoot = 2` (3,143,992 states) is outside the CI budget and
is not part of the runner.

## Invariants

- `NoEffectWithoutIntent`: every container that exists has a durable intent naming its service, generation and spec.
- `DepsBeforeStart`: a service starts only after every dependency is ready.
- `NoPublishToReplaced`: a route is never committed to a replaced or unready generation.
- `NoReplaceWhileRouted`: no container is removed while a route points at it.
- `OneContainerPerService`: at most one container exists per service.
- `ReturnIsCurrent`: `up` returns only when every container runs the current spec with attachments made in this boot.
- `DoneIsCurrent`: done means every service runs the current spec, made in this boot, ready and routed.

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
