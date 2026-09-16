# Live balloon page-order attribution — September 16

The isolated instrumented provider confirms substantial alignment loss during a
1 GiB balloon inflation. Of 261,120 adjacent PFN pairs within descriptors, 258,664
(99.06%) were descending consecutive pages. The pinned handler only coalesces
ascending pages before shrinking ranges to the host's 16 KiB page size.

| Inflation counters, before target request to acknowledged target | Result |
| --- | ---: |
| Submitted 4 KiB PFNs | 262,144 (1 GiB) |
| Descending adjacent pairs | 258,664 |
| Ascending adjacent pairs | 512 |
| Other adjacent pairs | 1,944 |
| Additional requested range bytes | 1,073,741,824 |
| Additional aligned range bytes | 1,212,416 (1.15625 MiB) |
| Additional alignment-skipped bytes | 1,072,529,408 (99.887% of inflation) |
| Unmap failures / discard failures | 0 / 0 |

These are cumulative diagnostic snapshots differenced around the inflation;
snapshots are not atomic across fields. Free-page reporting also uses the reclaim
path, so whole-run requested/aligned/discard counters must not be mistaken for
inflate-only totals. In this interval, additional requested bytes exactly matched
the submitted inflation bytes. No additional overlap skips were recorded. All
recorded discard calls succeeded; successful discard bytes are not a measurement
of physical memory returned. Refaulted ranges are counted separately.

The synthetic control retained a 128 MiB guest tmpfs file while allocating and
releasing another 384 MiB, inflated to 1024 MiB, deflated to zero, then verified the
original file's hash and rewrote/read back the released allocation. All checks
passed. The owned tmpfs was unmounted and removed, the VM stopped, and protected
global hashes were unchanged. All 25 watchdog samples showed normal pressure,
unchanged swapouts, and more than 2 GiB headroom. This does not qualify persistent
application volumes, automatic idle triggering, or a performance gain.

## Build and isolation

The patch applies to pinned libkrun commit
`5de9ab51c1bb166af2324de3c9413d00022eb178`. Both changed crates passed locked checks,
then the complete release feature set (`blk`, `net`, `gpu`, `input`, default init)
built through the upstream Makefile with Rust 1.97.1 and two jobs. Build inputs use
Apple's installed libclang and the pinned package's graphics libraries, with a
private linker alias/pkg-config metadata. No global tool installation was needed.
The Makefile packaging step required Apple's `mv`; GNU `mv` rejects its same-path
rename. Build scripts and initial failed attempts remain in private evidence.

The existing library's `krun_get_default_init` API supplied its exact ARM64 ELF init
(780,864 bytes), and the rebuilt library returned byte-identical init bytes. All
64 exported `krun_*` symbols matched. Only `lib/libkrun.dylib` and its checksum entry
changed in the diagnostic package. Signing and every package checksum verified.
The diagnostic candidate pins the new archive digest in its own checkout; main
candidate source/pins, the previous qualification cell and installed Hack remain
unchanged. Export equality is an interface check, not complete ABI/behavior proof.

The first fixture boot lacked four required networking archives and stopped during
guest setup. Native status confirmed the process was absent; managed recovery
reconciled it. After staging all four exact pinned inputs, the retry passed.
Follow-up: validate these inputs before VM allocation and report a specific missing
input error instead of the generic `provider_state` file error. This initial failure
was a fixture-preparation gap, not evidence of an instrumented-provider crash.

Evidence: `.hack-local/reclaim-host-control/` (build/packaging inputs and receipts),
`.hack-local/review/wu07/reclaim-trace-live-1789601278635269000/` (successful live
control); failed first boot `reclaim-trace-live-1789601185977239000/`.
Diagnostic archive SHA-256:
`e3f361186b5ae1908eac620dd4b45beb6c183248f511edc615b4cc185120d99b`.
Diagnostic candidate SHA-256:
`fe706c5d7e887ad8531d43a57d241d911333b7154a7673f9c00e813c16856cf9`.

## Next experiment

Test bounded PFN sorting/coalescing before release, without increasing the set of
pages eligible for reclamation. Preserve queue acknowledgment ordering, host-page
alignment, duplicate handling, refault safety, and fixed memory bounds. Repeat the
same control, then the retained-worktree/persistent-data workload and matched
resource measurements before considering any provider-pin/default change. The live
alignment loss is now demonstrated; its contribution to the earlier 32-worktree
retained-footprint gap still needs the patched comparison.
