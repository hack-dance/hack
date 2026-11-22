# What works and known limits

See the [native command table](https://github.com/hack-dance/hack/blob/next/docs/native/limits.md#commands-on-native)
for supported commands, refusal codes and the Compose capabilities that remain
unavailable on native. `hack config adopt` requires Compose even with
`--dry-run`. On native it refuses with `E_NATIVE_PROJECT_UNSUPPORTED`.

Projects the pool was started with can run together. If a running pool does
not share a project root, `hack up` restarts the pool to add it when nothing uses
the pool (about 30 s, one line says so). When another project is running there, or
the pool is starting or stopping, `hack up` refuses the start: run `hack down` in the
other projects first. A pool accepts up to eight project shares.

## Native startup limits

See the [native startup settings and refusal codes](https://github.com/hack-dance/hack/blob/next/docs/native/limits.md#native-startup-limits)
for the detached start budget and ceiling, the Compose-backed graph readiness
limit and the authored native startup limit.
