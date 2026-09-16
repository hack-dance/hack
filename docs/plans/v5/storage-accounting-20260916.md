# Candidate storage accounting

`runtime disk-usage [--scope all|runtime|build|evidence|artifacts]
[--max-entries N] --json` adds
on-demand, read-only metadata accounting. The report identifies its exact relative
root, logical regular-file bytes, allocated regular-file bytes and counts by direct
child directory. Runtime scope means `.hack-local/run`; it does not include every
artifact, source checkout, export destination or guest-internal volume inventory.
The artifacts scope names `.hack-local/artifacts`; pinned provider packages live
under `.hack-local/providers` and appear separately in the all-scope categories.
All scope covers the entire `.hack-local` tree, including contributor builds and
private qualification evidence. These are not interchangeable benchmark scopes.

Allocated bytes use native `st_blocks * 512`. They are neither exclusive physical
usage on a cloning filesystem, guest free space nor a promise of reclaimable bytes.
Directory/symlink metadata allocation is excluded from file-byte totals. Hardlinked
files are counted once by device/inode and charged to a separate shared bucket;
links may also have references outside the selected subtree. Totals from overlapping
scopes must not be added as if they were disjoint or exclusively owned.

Traversal uses descriptor-relative metadata and directory opens with no-follow
semantics. It never reads file contents or traverses symlinks, sockets, FIFOs or
other special nodes. Cross-filesystem children, inaccessible/replaced entries and
observed directory changes mark the report incomplete. Scans default to 100,000
entries; an explicit limit may be 1–1,000,000. All scans retain 64 directory levels and a ten-second budget checked between operations;
this is not a hard interruption of an OS syscall. Incomplete totals are partial
observations, not zero usage or a complete inventory. Even a complete traversal is
not an atomic snapshot of a changing filesystem.

An absent subtree returns an empty report without creating directories or runtime
state. Unknown scopes and aliased roots refuse. The command does not start a VM,
change global Docker/Hack settings, select deletion candidates or authorize cleanup.
Read-only inspection is separate from proving ownership and absence of active users
for a later retention operation.

Closest regression controls cover a sparse disk file, duplicate hard links, a
symlink to an outside tree, a Unix socket, absent state capped/deep partial traversal, FIFOs and bounded argument parsing.
Remaining WU12 work includes guest images/layers/volumes and cache references,
export destinations, managed proxy storage/retirement, many-branch churn, actual
reclaimability and explicit safe retention policies. This report supplies a storage
baseline; it does not itself reclaim disk or complete the user's cleanup goal.

## Qualification

Evidence: `.hack-local/review/wu12/storage-usage-1789594680864545000/` contains
the exact protocol and both binary hashes. Development release SHA-256:
`37b48b25b644275d0974c07a85d4e8a3432c011cf29f9e8b05f4512689fdc3e0`;
isolated checkout release SHA-256:
`5910959c2418c9c0eccfe1d9ff99bb3ce11a30d023452f673df4be3875e3d894`.
All ten scoped observations, including empty subtrees, matched independent Python
metadata walks before and after each command. No build, VM startup or stateful test
overlapped the observations. Global protected hashes were unchanged and the
qualification VM remained stopped.

| Checkout/scope | Entries | Logical file size | Allocated file blocks | Scan elapsed |
| --- | ---: | ---: | ---: | ---: |
| Isolated runtime state | 1,129 | 72.047 GiB | 452.91 MiB | 5 ms |
| Isolated all state | 2,146 | 72.363 GiB | 777.62 MiB | 8 ms |
| Development runtime state | 2,148 | 72.052 GiB | 696.36 MiB | 28 ms |
| Development build tree | 224,682 | 10.728 GiB | 11,068.34 MiB | 1,147 ms |
| Development evidence | 9,815 | 0.496 GiB | 535.02 MiB | 25 ms |
| Development all state | 238,989 | 83.779 GiB | 12,819.77 MiB | 1,180 ms |

These runs explicitly used a one-million-entry limit. An earlier successful
control (`storage-usage-1789594379933488000`) hit the default 100,000-entry cap for
the development build/all scopes and correctly reported partial totals. That
finding motivated the bounded explicit limit rather than pretending those totals
were complete. The initial attempt (`storage-usage-1789594262757246000`) used the
wrong checkout's executable and correctly failed the checkout-identity guard; it
is not counted as a passing measurement.

The isolated all-scope categories include approximately 316.77 MiB of pinned
provider packages plus runtime state, binary and exported receipts. Build outputs
and shared hardlinks dominate development-checkout storage; those results must not
be presented as the installed runtime footprint. Sparse disk logical capacity also
must not be presented as actual occupied host blocks. These are local metadata
observations, not exclusive APFS usage, cold-scan performance or a matched
Compose/OrbStack comparison.

Required Rust default/all-feature tests, strict Clippy, default release build and
Bun typecheck/check/test passed (940 pass, 5 skip), as did CLI reference generation
and focused FIFO, depth and argument-limit controls. The actual application plan
refresh in `.hack-local/review/wu07/storage-usage-application-1789594705958724000/`
remains 14 services, 22 errors and two warnings with unchanged source/config and
dirty-state fingerprints. No application startup or compatibility gap was closed.
