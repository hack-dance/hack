# What works and known limits

See the [native command table](https://github.com/hack-dance/hack/blob/next/docs/native/limits.md#commands-on-native)
for supported commands, refusal codes and the Compose capabilities that remain
unavailable on native. `hack config adopt` requires Compose even with
`--dry-run`. On native it refuses with `E_NATIVE_PROJECT_UNSUPPORTED`.

Projects the pool was started with can run together. If a running pool does
not share a project root, `hack up` restarts the pool to add it when nothing uses
the pool (one line says so). When another project is running there, or
the pool is starting or stopping, `hack up` refuses the start and names up to three
of those projects: run `hack down` in them first. A pool accepts up to eight project shares.

The desktop preview's **Doctor** view shows the selected native pool's state and
any memory or graph counts reported by Hack. A failed observation shows the pool
state as unknown.

A native home keeps up to 64 graph runs. A run whose data was removed
(`hack down --remove-data`, or a fresh start that failed) is archived on its own
when a new run needs the room. Runs that keep their data are never archived; when
64 of them fill the home, `hack up` refuses with `graph_retention_budget` until you
remove the data of a project you no longer use.

## Native startup limits

See the [native startup settings and refusal codes](https://github.com/hack-dance/hack/blob/next/docs/native/limits.md#native-startup-limits)
for the detached start budget and ceiling, the Compose-backed graph readiness
limit and the authored native startup limit.
