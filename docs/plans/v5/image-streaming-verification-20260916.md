# Stream image verification on reuse — September 16

The completed-validation reuse path now hashes the archive through a 64 KiB buffer.
It still reads every byte and enforces the 256 MiB archive limit, exact SHA-256 and
initial observed length. It no longer retains the full archive in memory merely to
confirm that an already-verified, present image can be reused.

If full validation or import is needed, the loader rewinds the same open descriptor,
reads the bounded archive and verifies its hash again before validating or importing
those bytes. It never reopens the pathname between checks. File mutation between
the streaming check and buffered read therefore cannot authorize different import
bytes. The existing versioned receipt, ownership, live image identity, architecture
and incomplete-load checks remain in force.

The tradeoff is an additional compressed-archive read/hash on the non-reuse path.
The full validator/import path still buffers the archive and is not claimed to use
constant memory. Future cold-path optimization must preserve proof over the actual
bytes passed to validation/import.

Regression coverage includes short reads, maximum requested buffer size, archive
size overflow, hash mismatch, changed/truncated bytes between passes, and successful
full validation after both passes. Live measurements and full gate results follow.

## Verification and measurements

Rust default/all-feature tests and strict Clippy passed, as did the default release
build and Bun typecheck/check/test (940 passed, 5 skipped).

Seven-call medians on the same pinned image and archive:

| Cached load | Buffered validation reuse | Streaming validation reuse |
| --- | ---: | ---: |
| Peak RSS bytes | 108,101,632 | 10,502,144 |
| Elapsed seconds | 0.26 | 0.25 |
| CPU seconds | 0.21 | 0.21 |

Peak RSS decreased 90.3%. The earlier CPU improvement was preserved; the 0.01-second
elapsed difference is too small to claim another meaningful speed improvement.
These sequential separate-boot component measurements do not establish whole-app
startup, VM idle memory, cold-load speed or filesystem space recovery.

Streaming evidence:
`.hack-local/review/wu07/image-reuse-candidate-1789596924393689000/`, binary SHA-256
`3fb5e8656d7118471ec034a007028de5539b60c88cbb84d7607ef3669be09368`.
The comparator is `image-reuse-candidate-1789596582732654000/` from the preceding
[validation reuse experiment](image-validation-reuse-20260916.md). Wrong archive
hash and image ID were refused without changing the completed receipt. Four
watchdog samples retained normal memory pressure and unchanged swapouts.

A separate full-validation control used the same tar archive with 512 additional
zero padding bytes and a newly computed archive hash, ensuring no prior validation
receipt existed. Both the streaming check and buffered full validation succeeded;
subsequent reuse left the completed receipt unchanged. Engine inventory was unchanged
because the image itself was already present. This does not claim a fresh image
import test. Evidence:
`.hack-local/review/wu07/image-stream-cold-validation-1789596971268673000/`.
The temporary archive was deleted; its small managed validation receipt remains.
Both experiments ended with the VM stopped and protected global hashes unchanged.
