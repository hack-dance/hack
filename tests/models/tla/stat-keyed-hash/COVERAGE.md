# Stat-keyed file hash model coverage (HACK-2461)

`StatKeyedHash.tla` checks when a stored file hash may be reused because the
file's stat key is unchanged. The step store (`../step-store/COVERAGE.md`) uses
it for executables, image archives and source files.

One file, two contents of the same size, a coarse clock. An ordinary write sets
mtime and ctime to now. `SetMtime` models tools that restore mtimes (`git
checkout`, `rsync -t`, `tar -x`, `touch -d`): mtime moves anywhere, ctime still
becomes now. The hasher is not atomic: stat, read, stat again, then store.

**Invariant `HitIsFresh`:** a reused hash is the hash of the file's current
content.

| Configuration | Constants | Result |
| --- | --- | --- |
| `positive` | key with ctime, racy check at the first stat, `MaxT = 5` | no error, 108,942 distinct states |
| `negative` | no racy check | `HitIsFresh` at `HashStore` |
| `mtime-only` | key without ctime (size and mtime, as fsutil's receiver compares) | `HitIsFresh` at `SetMtime` |
| `racy-at-store` | racy check against the clock at store time | `HitIsFresh` at `HashStore` |
| `reachability` | positive constants, invariant `NeverHits` | `NeverHits` at `HashStore`: a reused hash is reachable at all |

The rule it supports: read the clock before the first stat, and store the hash
only if mtime and ctime are strictly older than that reading minus the
filesystem's timestamp granularity. Comparing with the clock at store time is the
bug `racy-at-store` finds.

Not covered: inode reuse after delete and recreate, filesystems with coarse
ctime, a same-user adversary who knows the scheme, and more than one file.
