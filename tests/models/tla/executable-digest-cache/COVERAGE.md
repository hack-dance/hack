# Executable digest cache

`DigestCache.tla` models the per-process SHA-256 cache in
[`native-executable-hash.ts`](../../../../src/backends/native-executable-hash.ts),
which the native start, HTTPS lease and HTTPS owner checks share. One path in
one process, a filesystem clock that stamps change times in coarse ticks,
in-place same-size writes and atomic replacements.

![DigestCache state chart](states.svg)

## Invariant

`CacheNeverStale`: a cache hit returns the digest of the file's current
content. Equivalently, a skipped read had identical inputs.

## Model and source

| Model action | Source |
| --- | --- |
| `BeginRead` | Open with `O_NOFOLLOW`, `fstat` (bigint), every executable check, key = device, inode, size, mtime and ctime in nanoseconds; a miss reads the file. |
| `CacheHit` | Same open and checks on a fresh `fstat`; the key equals the cached key, so the read is skipped. |
| `FinishRead` | The after-`fstat` equals the key and the byte count equals the size. The digest is cached only when the ctime is more than `RACY_WINDOW_NS` (2 s) older than the read's start (`RacyGuard`). |
| `RefuseRead` | The after-`fstat` differs: refused, and the path's cache entry is dropped. |
| `WriteInPlace` / `Replace` | Writes stamp the current tick; a replacement also changes the inode. |
| `Tick` | The filesystem timestamp clock advances. |

`tests/native-executable-hash.test.ts` walks each action on a real file with
an injected clock (`CacheHit`, `WriteInPlace`, `Replace`, the racy guard,
`RefuseRead` for a change and for growth, `fresh`).

## Bounds and controls

Positive: `RacyGuard = TRUE`, `MaxClock = 3`, `MaxWrites = 3`; 1,943 distinct
states, depth 10, no violation. Negative: `RacyGuard = FALSE` fails
`CacheNeverStale` at `CacheHit`. The trace: a write at tick 1, a read that
begins at tick 1, a second in-place write in the same tick (the stat does not
change), the read is accepted and cached, and the next lookup returns the
first write's digest.

## Not covered

The model folds size and mtime into the ctime stamp, and it assumes the
filesystem stamps from the same clock the process reads. It does not cover a
filesystem whose timestamp granularity is coarser than 2 s, a clock set
backwards, or an inode reused by another file at the same size and times.

The same negative trace shows a limit of the existing changed-during-read
check, which the cache does not change: a same-size in-place write in the
tick the read began leaves the stat unchanged, so that one read can return a
digest that mixes old and new bytes. Such a digest then fails the expected
hash comparison at every call site (a refusal, not an admission), and the
racy guard keeps it out of the cache.
