# What works and known limits

See the [native command table](https://github.com/hack-dance/hack/blob/next/docs/native/limits.md#commands-on-native)
for supported commands, refusal codes and the Compose capabilities that remain
unavailable on native. `hack config adopt` requires Compose even with
`--dry-run`. On native it refuses with `E_NATIVE_PROJECT_UNSUPPORTED`.

Projects the pool was started with can run together. If a running pool does
not share a project root, `hack up` refuses the start. Stop the pool and add
the root before the next boot. A pool accepts up to eight project shares.

## Native startup limits

See the [native startup settings and refusal codes](https://github.com/hack-dance/hack/blob/next/docs/native/limits.md#native-startup-limits)
for the detached start budget and ceiling, the Compose-backed graph readiness
limit and the authored native startup limit.

The native authored runtime keeps up to 64 attempt directories in its active
inventory. When that inventory fills, it can move the oldest fully removed
attempt without persistent storage out of the inventory. The archive keeps up
to 256 removal receipts for inspection and confirmation. After the archive
fills, the oldest receipts expire as new ones are added.
