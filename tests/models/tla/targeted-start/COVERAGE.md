# Targeted native start coverage

The model starts with `web` running on one run, with a route and a seeded
supervisor. Two requests can add `cache` and its dependent `redis`, then
`api`. The pool starts with zero to two spare sockets. `unused` remains
unselected. The model keeps durable ownership separate from observed compute.

| Property | Source and regression |
| --- | --- |
| `SameRun`, `PreserveExisting`, `OnlySelected` | `foreground/service_start.rs` pins the live owner. `extend::run` verifies the current receipt under the provider lease. `config::prepare_with_ownership` reuses allocated names and `execution::run_seeded` observes running dependencies. The ownership fake checks the old ID and the macOS fixture sends two requests through the owner socket. |
| `DependencyBeforeCreate`, `PublishAfterStart` | The seeded scheduler dispatches after the dependency condition and publishes the confirmed container ID. The scheduler regression checks the wait and exact selection. |
| `Capacity`, `SupervisorSeeded` | `bridges::check_extension_capacity` checks the leased pool registry before the receipt write. `EarlyPublications` verifies the added publishers and carries each admitted route generation to the supervisor. The free-count and unseen-probe tests cover refusal and supervisor enrollment. |
| `OwnedEffects`, `CleanStop`, `Loadable` | `Session::reserve` records names before allocation. Failure keeps the owner and pending marker until scoped rollback succeeds. Explicit recovery retains pending bytes as evidence, reconciles the committed receipt and clears the marker on phase change. The macOS fixture kills the owner during an append, recovers, and reads back the settled receipt. |

TLC 1.7.4 with Java 17 explores 291 distinct states. `negative.cfg` drops the
dependency's intent and fails `OwnedEffects` at `Create`. `replace-existing.cfg`
admits the running service into the effect selection and fails
`PreserveExisting` when `Create` acts on it.

The model assumes serialized owner requests, an exclusive provider lease,
atomic committed receipt replacement and an engine that honors confirmed
identities. A crash keeps the committed names even when the latest effect
reply was lost. `Degraded` is the owner's state until rollback is verified
or cleanup is requested. The model abstracts Docker retries, private
environment and volume cleanup, probe sampling, signal delivery, filesystem
durability and live VM routing. The [Pele state chart](../../../../docs/reference/state-charts/targeted-start.svg)
shows the same transitions.

The CLI regression simulates a held provider lease and checks that requests
reach the owner for a second start or a stop. Confirmed data removal first uses
the modeled stop when the owner is appending, then runs a separate stopped-only
removal. The tests cover refusal if the append finishes before the owner sees
the stop. The owner transport tests cover EOF cancellation on an open append
stream and the distinct half-close behavior of job, dependency refresh and
authored interactive exec requests. The macOS recovery fixtures
exercise a pending receipt before and after enrollment, then restore the
original selection and its named data. These checks cover the socket lifecycle,
the interrupted first write and the retained restore layout outside the model.
The append commit records the new normalized review and the matching shared
source execution contract together. The model abstracts those fingerprints.
The shared-source regression checks that the cold contract rejects the
expanded plan and that the combined contract admits the same plan after a
source edit. The VM CLI fixture also checks exec on the running graph and
reads both named-volume markers after a retaining down and plain up.
