# Explicit malformed publication journal recovery

The experimental candidate exposes offline inspection and an explicit recovery action:

```sh
./hack-local runtime publication-recovery --json
./hack-local runtime recover-publications --expect-sha256 FINGERPRINT --json
```

Inspection returns a fingerprint of both committed and pending bytes, sizes and the
number of recorded publications. It never emits control tokens or raw journal data.
Recovery is candidate-wide: it stops all recorded host publications using the usual
identity and file cleanup checks. Guest containers and application volumes are not
removed. This is an explicit maintenance action, not automatic startup replay.

Before cleanup, recovery stores the exact committed and pending evidence in a private
content-addressed file. A changed fingerprint refuses before effects. Retention is
bounded to 16 copies of at most 256 KiB each (4 MiB payload maximum); an identical copy
is reused. Interrupted copies resume only when their bytes are an exact prefix of
the expected content. Mismatched, aliased, oversized or foreign evidence refuses.
No evidence is automatically pruned to make room.

After all recorded publisher cleanup succeeds, recovery refuses if any candidate
staging path remains, including paths not represented in committed state. It does
not infer ownership from a filename or a malformed journal. Only after the exact
evidence is reverified and all such paths are absent does it remove the blocking
journal and persist an empty registry. A completed retry verifies retained evidence
and empty state without stopping a newly created publication. If interrupted after
journal removal but before empty-state publication, ordinary cleanup can retire the
already-absent recorded resources or complete its final pending write.

Missing directory/file identity still blocks cleanup when resources remain. Evidence
may have been safely retained and some recorded publishers stopped before such a
refusal; the returned error is not a claim that nothing happened. The pending journal
and committed ownership are retained on that path.

## Verification

Retention tests cover exact-prefix resumption, idempotence, the 16-copy limit and
preservation of mismatched content. Live qualification and remaining gates are
recorded below. No overall CPU or Docker/Compose performance advantage is claimed.


The live control interrupted the actual CLI at receipt retirement, then replaced
that test-owned pending journal with a one-byte malformed fixture. Inspection and
recovery retained exact original committed bytes and the malformed pending bytes.
A wrong fingerprint and a fingerprint made stale by a further byte change refused
before cleanup. An unrecorded candidate-prefixed directory was preserved and blocked
recovery after evidence retention. Only the harness removed its own verified test
directory; retry then cleared the malformed journal and retired the receipt.

Completed recovery was idempotent. A subsequent old recovery request with a newly
running publisher was rejected; that publisher stayed alive and served the same
application token. The volume record also remained unchanged until explicit fixture
cleanup. Graph cleanup, archive/export and final VM down passed.

Private evidence: `.hack-local/review/wu07/publication-raw-recovery-1789587351149344000/`.
Candidate SHA-256: `e7d034247d04692ad2a2bc17f005052efdfe44efdf5ea02664153a331aeabade`.
All 5 watchdog samples and protected global hashes passed. Final readback found
zero active publisher entries, pending journals and staging directories, plus
2 intentionally retained evidence files totaling 2116 bytes across the two live
runs. Retained evidence is not claimed as reclaimed disk space.

All seven publication tests, default/all-feature Rust suites, strict Clippy, default
native-HTTP release and Bun typecheck/check/tests passed (940 pass, 5 skip). CLI
reference generation completed without stable-CLI changes. Missing identities with
resources still present remain a refusal. Export/retirement of resolved evidence
and reaching the fixed retention limit remain explicit disk-management work.
