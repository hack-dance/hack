# Bounded balloon coalescing experiment — September 16

**Later accounting control:** the [guarded matched comparison](balloon-guarded-pair-20260916.md)
found that missing reuse advice can leave live rewritten memory discounted from
footprint. The apparent reductions below are not proven RAM savings and must not
be used to promote these experimental packages.

An isolated provider patch sorts at most 256 surrendered PFNs at a time, removes
in-batch duplicates, and emits consecutive ranges through the existing reclaim
path. It uses a fixed 1 KiB page buffer and no allocation proportional to descriptor
length. It flushes before queue acknowledgment, including after a partial input
read; no unsurrendered gap is added to a range. Host-page alignment and existing
refault handling remain unchanged. This is not yet a promoted provider/default.

## Verification

Three tests passed, including an independent set oracle over all 55,987 sequences
of length zero through six from a six-page alphabet. Other cases cover a missing
page within a host page, duplicates, batch boundaries, empty flushes, and maximum
PFNs without arithmetic wrap. A deliberate no-sort negative control failed with
exactly zero versus 16,384 expected reclaimable bytes. The full-feature provider
release build passed; all 64 exported APIs and the embedded guest init match the
pinned package. These checks do not prove host mapping bounds or full ABI parity.

The 1 GiB synthetic inflation changed alignment-skipped bytes from 1,072,529,408
(99.887%) to 20,774,912 (1.935%). Of the newly aligned bytes, 1,041,317,888 were skipped
for overlap with already-reclaimed ranges; successful additional discard was only
11,649,024 bytes. No discard/unmap failures occurred. Live data and released-memory
reuse checks passed. Improved alignment alone is not a footprint-win claim.

## Retained-worktree measurements

Two serial 32-worktree runs passed start/readback/stop-retain, balloon inflation and
deflation, two concurrent restores with original persistent tokens, explicit removal
of all owned volumes, guest inventory equality, archive/export reconciliation,
archive pruning, and removal of all temporary worktrees/branches. Both VMs ended
stopped. All 71 cold-run and 65 warm-run watchdog samples showed normal pressure,
unchanged swapouts and more than 2 GiB headroom; protected global hashes matched.

The first run imported the image and began around 1,396 MiB. Its post-cache-drop
footprint fell from 1,086 MiB to 747 MiB at a 4 GiB balloon target and remained about
750 MiB after deflation. Because the earlier baseline reused an existing image,
the experiment was repeated with the image already present:

| Phase | Earlier pinned provider, MiB | Sorted diagnostic provider, warm image, MiB |
| --- | ---: | ---: |
| Empty VM | 673.56 | 658.02 |
| 32 stopped, persistent data retained | 1000.81 | 992.25 |
| After diagnostic cache drop | 989.16 | 984.41 |
| Balloon actual 4096 MiB | 985.42 | 713.91 |
| Balloon actual 5120 MiB | 987.42 | 716.08 |
| Balloon actual zero | 983.97 | 718.72 |
| Two active, 30 retained | 985.21 | 720.67 |

The warm diagnostic run returned about 270 MiB after cache eviction and inflation,
and kept that reduction through deflation/restores. Its final measured footprint
was about 265 MiB (26.9%) below the earlier baseline. The 32-start median was 0.698s;
wakes were 1.822s and 0.710s. These are exploratory component measurements, not a
matched full-application benchmark or automatic idle-policy result. Cache dropping
remains diagnostic; it is not a new routine policy.

There is **no CPU improvement claim**. Selected 10-second provider-tree windows were
higher than the earlier baseline: 32-retained idle 0.774% versus 0.535% of one core;
two-active 1.918% versus 1.212%. The providers were not built/instrumented identically,
and the short samples are insufficient to attribute that difference to sorting.
A matched instrumented unsorted build and repeated windows are required before
accepting the resource tradeoff or promoting the patch.

## Remaining gates and evidence

Source review found that existing `release_guest_range` validates the starting
address but not the whole host-contiguous range. Before promotion, validate or split
coalesced ranges at guest-memory region boundaries, with regression cases for
adjacent guest regions backed by different host mappings and invalid end addresses.
The PFN set oracle does not cover that translation property. Preserve conservative
behavior for overlaps; do not assume every overlapping request was fully reclaimed.

A first worktree attempt correctly refused to resize the earlier synthetic pool's
fixed bridge capacity. It allocated no graph compute; all temporary worktrees were
subsequently removed without force. A fresh two-bridge fixture was used for both
successful runs. The harness now removes temporary worktrees after runtime failure
as well as success.

Evidence under `.hack-local/review/wu07/`:
- `reclaim-sorted-live-1789601616944474000/` — synthetic memory control.
- `worktrees-32-sorted-1789601777256724000/` — cold image/control.
- `worktrees-32-sorted-1789601950190559000/` — warm image/control.
- Baseline: `worktrees-32-vmmap-1789599770752832000/`.

Patch and test/build receipts: `.hack-local/reclaim-host-control/`.
Patch SHA-256: `3afdc4793f90a8fa8542469c3e02a0d994248c943be9941cfabad71906f9e483`.
Experimental archive: `a5672594b95c560d834157778b543ce36ca5639010ef29c83ae9f39c1a0353d9`.
Worktree candidate: `261dad37826106d520374a145bc9e9c586cd690e61636fb6614f903aabece9b2`.
Candidate pins, installed/global environments and previous qualification providers
were not changed.
