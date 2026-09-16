# VM memory regions and balloon granularity — September 16

The next isolated 32-worktree cycle added `vmmap -summary -wide` snapshots, checked
against the same native process identity before/after inspection. All seven
snapshots succeeded. A 5 GiB balloon target was attempted only after verifying guest
available memory exceeded that target by 512 MiB; both 4 GiB and 5 GiB targets were
acknowledged, then returned to zero before restoring workloads.

| Phase | Native provider footprint, MiB | vmmap shared-memory resident, MiB |
| --- | ---: | ---: |
| Empty VM | 673.6 | 222.0 |
| 32 stopped, data retained | 1000.8 | 382.6 |
| After diagnostic cache drop | 989.2 | 382.8 |
| Balloon actual 4096 MiB | 985.4 | 382.9 |
| Balloon actual 5120 MiB | 987.4 | 384.1 |
| Balloon returned to zero | 984.0 | 384.6 |

Ordinary malloc-region resident growth was below 1 MiB: small allocations grew
832 KiB and tiny allocations 16 KiB; the other allocator categories were stable.
Shared-memory resident growth was about 161 MiB. This argues against ordinary host
allocator growth as the main explanation and directs investigation toward guest
memory mappings/reclamation. It does not account for every byte of the 327 MiB
native-footprint delta: vmmap category totals and native footprint are different
accounting views, and inspection itself may affect the experiment. Do not equate
shared-memory region totals directly with guest live allocation or a proven leak.

Both worktrees restored with their original tokens (1.74s and 0.78s to response).
All 32 volumes were explicitly removed; guest inventory returned to baseline.
Worktrees and temporary branch refs were removed; graph evidence was exported and
duplicate archives pruned through managed commands. The VM ended stopped and all
66 watchdog samples retained normal pressure and unchanged swapouts. Protected
global hashes were unchanged. No implementation or default changed.

Evidence: `.hack-local/review/wu07/worktrees-32-vmmap-1789599770752832000/`.
Binary SHA-256: `33bf794257021a7475e1d4f69903b54ae9464a83857aaa58d04194be6d0a9dc8`.

## Source-level follow-up

The [SmolVM 1.14.3 provenance](https://github.com/smol-machines/smolvm/blob/v1.14.3/lib/libkrun.provenance)
identifies libkrun commit `5de9ab51c1bb166af2324de3c9413d00022eb178`.
Inspection of that exact source identifies two bounded instrumentation targets:

- The [inflate handler](https://github.com/smol-machines/libkrun/blob/5de9ab51c1bb166af2324de3c9413d00022eb178/src/devices/src/virtio/balloon/device.rs)
  combines only ascending consecutive 4 KiB PFNs within each descriptor. The
  [HVF reclaim path](https://github.com/smol-machines/libkrun/blob/5de9ab51c1bb166af2324de3c9413d00022eb178/src/hvf/src/lib.rs)
  aligns ranges inward to host pages. A reproduction of these operations gives
  16 KiB reclaimable for PFNs `[4,5,6,7]`, but zero for `[7,6,5,4]` on a 16 KiB
  host page. The same pages were surrendered; ordering changes what is reclaimed.
  This proves an algorithmic limitation, not the live guest's submission ordering.
- After successful hypervisor unmapping, the pinned implementation calls
  `madvise` without checking its return value. Target acknowledgement therefore
  does not independently prove successful host discard. It remaps a whole retained
  range on a refault, which also needs accounting when explaining net recovery.

Next instrument aggregate counts for submitted PFNs, aligned/skipped bytes,
unmap/discard failures, reclaimed bytes and remapped bytes in an isolated provider
build. Avoid logging guest data or raw addresses. Observe actual ordering and return
codes before proposing sorting/coalescing or a different discard strategy. Any patch
must preserve balloon ownership, host-page alignment, acknowledgement ordering,
refault safety and bounded metadata; qualify data preservation and host footprint
before changing provider pins or defaults. The simple PFN control is retained as
`pfn-order-control.json` beside the live evidence.
