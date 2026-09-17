# Guarded balloon comparison and reuse accounting — September 16

The matched comparison passed its workload and cleanup controls, but a subsequent
native control invalidated interpreting its lower footprint as proven RAM savings.
The pinned refault path omits `MADV_FREE_REUSE` after `MADV_FREE_REUSABLE`. Rewritten,
live memory can therefore remain discounted from the process footprint. Do not
promote the earlier 27–30% apparent footprint reductions as resource improvements.

## Whole-range validation

The experimental release path now validates the complete range within one guest
memory mapping before obtaining the host address. It conservatively refuses ranges
crossing region boundaries, holes, invalid endpoints, zero lengths and arithmetic
overflow. Guest-contiguous regions need not have a contiguous host mapping.

Five focused tests passed in the actual device crate: two mapping-boundary tests
and the three PFN coalescing tests. A starting-address-only negative control failed
at the expected crossing-region assertion; the validated source was restored
byte-for-byte afterward. The tests use actual separately allocated guest-memory
regions and preserve boundary sentinels. This is component evidence, not proof of
all provider ABI, platform or adversarial guest behavior.

## Matched exploratory cohort

Both providers used the same source commit, Rust 1.97.1, release feature set,
instrumentation, range guard, pinned graphics libraries and identical guest init.
The unsorted control retains the original streaming coalescer; the sorted variant
uses the bounded 256-PFN batch. Each received an image warmup, shutdown, fresh boot,
then the same 32-worktree/control sequence. Order was unsorted then sorted; there
was one cohort per provider.

| Phase | Unsorted footprint, MiB | Sorted footprint, MiB |
| --- | ---: | ---: |
| Empty | 644.47 | 718.27 |
| 32 stopped/data retained | 1003.85 | 965.86 |
| Diagnostic cache drop | 992.08 | 958.25 |
| Balloon 4096 MiB | 993.08 | 694.38 |
| Balloon 5120 MiB | 993.30 | 693.99 |
| Deflated to zero | 993.85 | 694.88 |
| Two active, 30 retained | 998.66 | 696.31 |

These are observations of the existing accounting path, **not validated physical
memory savings**. Start medians were 0.688s for both variants. First/second restores
were 0.672/0.708s unsorted and 1.906/0.665s sorted. The two-active 10-second CPU windows
were 1.591% and 1.927% of one core respectively; after deflation, 0.554% and 0.657%.
No speed or CPU win is established, and repeated/reversed-order observations remain
needed after the accounting correction.

Both runs preserved original persistent tokens, removed all owned volumes, returned
guest inventory to baseline, exported/reconciled/pruned graph archives, and removed
all 64 temporary worktrees and branch refs in total. Each run had 64 normal-pressure,
unchanged-swapout watchdog samples. Both providers were freshly confirmed stopped
at the end; protected global hashes matched.

## Native negative control exposes under-accounting

A separately signed native executable allocated/touched 64 MiB, mapped it through
HVF, unmapped it, called `MADV_FREE_REUSABLE`, then remapped and rewrote/read back
all bytes. Three runs used `MADV_FREE_REUSE` before remapping; three omitted it to
match the current provider. All data readbacks and cleanup succeeded.

| Reuse path | Footprint after discard | Footprint after rewriting all 64 MiB |
| --- | ---: | ---: |
| With `MADV_FREE_REUSE`, all 3 samples | 1,769,928 B | 68,878,792 B |
| Without reuse advice, all 3 samples | 1,737,160 B | 1,737,160 B |

The no-reuse path reports essentially no footprint for memory just rewritten.
This proves the accounting blind spot in the host primitive/control; it does not
quantify how much of the live guest's apparent reduction is discounted memory,
prove data loss, or establish system-wide physical reclamation. The provider uses
this same missing-advice path, making its apparent footprint advantage insufficient
for promotion.

An isolated source correction now calls `MADV_FREE_REUSE` before remapping and
checks the return value. Failure is fatal instead of exposing a live guest mapping
with failed reuse accounting, consistent with existing fatal remap failure behavior.
Both affected crates passed locked compilation checks. The corrected full-package
comparison below now passes data and cleanup controls. Previous
experimental packages must not be promoted; working provider pins/defaults remain
unchanged.

Evidence: `.hack-local/reclaim-host-control/guarded-pair-1789602336819010000/`
(build/package receipts, warmups and `live/comparison.json`). Live cohorts under
`.hack-local/review/wu07/`: `worktrees-32-paired-unsorted-1789602526121750000/` and
`worktrees-32-paired-sorted-1789602679647683000/`. Native comparison:
`.hack-local/reclaim-host-control/reuse-accounting-control.json`; source/compilation
correction: `libkrun-guarded-reuse-sorted.patch` and `reuse-check.log` beside it.


## Corrected reuse accounting comparison

Both variants now restore reuse accounting before remapping, with identical range
validation, instrumentation, toolchain, features and guest init. Only PFN coalescing
differs. One warm-image cohort per variant ran sequentially, unsorted then sorted,
with 32 actual linked worktrees each. All token readbacks, owned volume cleanup,
export/prune, worktree removal and final stopped-state checks passed. Installed Hack
and global configuration hashes remained unchanged.

| Phase | Unsorted footprint MiB | Sorted footprint MiB | Unsorted RSS MiB | Sorted RSS MiB |
| --- | ---: | ---: | ---: | ---: |
| Empty | 634.02 | 631.58 | 657.41 | 654.98 |
| 32 retained | 959.72 | 922.10 | 982.80 | 945.19 |
| After diagnostic cache drop | 950.67 | 914.31 | 977.91 | 941.41 |
| 4 GiB balloon | 952.27 | 666.38 | 980.00 | 821.86 |
| 5 GiB balloon | 953.89 | 671.97 | 981.66 | 827.53 |
| Balloon released | 955.95 | 676.25 | 983.72 | 832.00 |
| Two restored, 30 retained | 955.99 | 806.88 | 985.80 | 897.23 |

Restoring services increases sorted footprint by 130.63 MiB, which the earlier
missing-reuse path could conceal. Final measured footprint is 149.11 MiB lower
(15.6%), and RSS is 88.57 MiB lower (9.0%). Neither metric establishes exclusive
system-wide physical RAM savings. The diagnostic cache drop and balloon sequence
is not the default idle workflow.

Initial start medians were 0.690/0.692 seconds. First/last wakes were 0.761/0.774
seconds unsorted and 1.739/0.736 seconds sorted: first-wake latency needs further
qualification. Ten-second CPU windows were 0.626%/0.401% after deflation and
2.073%/1.674% with two services restored (100% means one core). These single windows
are observations, not a demonstrated CPU improvement. Reverse-order repetitions,
sustained activity, physical-memory attribution and matched Compose/OrbStack
qualification remain open. No provider pin or default changed.

The maintained [BalloonReuse model](../../../tests/models/tla/README.md) now checks
the accounting contract, including a deliberately broken negative control. Both
models' four TLC controls pass, with verifier tests rejecting unrelated failures.
This is specification evidence for the experimental correction, not proof of the
currently pinned provider or actual kernel behavior.

Evidence: `.hack-local/reclaim-host-control/guarded-pair-1789603087722130000/`,
including per-variant package/build receipts and `live/comparison.json`. Cohorts:
`worktrees-32-paired-unsorted-1789603273313707000/` and
`worktrees-32-paired-sorted-1789603426902287000/` under `.hack-local/review/wu07/`.
