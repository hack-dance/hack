# Retained worktree memory attribution — September 16

A second 32-linked-worktree cycle measured guest memory alongside native host
provider accounting. It then tested explicit cache dropping and balloon inflation
inside the isolated VM, followed by data-preserving restore. This was a diagnostic
experiment; no default policy or implementation changed.

## Observations

Values are MiB at the end of approximately ten-second observation windows. The
provider tree contained one verified `smolvm-bin` process throughout this run.

| Phase | Host footprint | Guest Cached | Guest AnonPages | Guest Slab |
| --- | ---: | ---: | ---: | ---: |
| Empty VM | 676.8 | 167.0 | 24.2 | 15.1 |
| After 32 starts/stops, all data retained | 963.5 | 212.2 | 42.3 | 20.8 |
| After sync and diagnostic cache drop | 951.7 | 101.9 | 42.2 | 19.4 |
| Balloon actual 4096 MiB | 951.9 | 101.9 | 42.3 | 19.4 |
| Balloon returned to zero | 949.9 | 102.0 | 42.2 | 19.4 |
| Two restored, 30 retained | 954.4 | 162.9 | 66.8 | 19.7 |

Host footprint grew 286.8 MiB during the cycle, while guest Cached grew 45.2 MiB,
AnonPages 18.1 MiB and Slab 5.7 MiB. Evicting more than 110 MiB of guest cache reduced
host footprint by only 11.8 MiB. Balloon inflation reduced guest available memory
as expected, but did not materially reduce host footprint; deflation returned guest
capacity without returning the host footprint to baseline.

These observations locate the retained host accounting in the VM process, but do
not distinguish its allocator/virtualization buffers from guest pages that became
free without being returned to the host. Do not label this a leak or attribute the
whole gap to Docker/containerd. Host VM-region attribution is the next diagnostic.
A larger balloon target is a separate bounded experiment, requiring guest headroom
and deflation before any workload resumes.

## Control and recovery

The control used `sync` followed by guest `drop_caches=3`, then requested 4096 MiB
balloon inflation and waited for actual target acknowledgement. Guest available
memory had to exceed the requested target by 512 MiB before inflation. The balloon
was returned to zero and acknowledged before restore. Existing recorded policy
was balloon reclaim enabled with a ten-minute idle interval; this experiment did
not wait for or qualify that automatic interval.

Cache dropping remains diagnostic only. The [Linux kernel documentation](https://www.kernel.org/doc/html/latest/admin-guide/sysctl/vm.html#drop-caches)
warns that rebuilding evicted caches can incur substantial CPU/I/O cost and does
not recommend it as a routine cache-growth control. In this run the first restored
response took 1.81 seconds and the second 0.77 seconds, versus 0.71–0.77 seconds in
the earlier non-eviction pair. These small sequential samples suggest a cold-cache
cost but do not quantify a general wake regression.

Both restored worktrees returned their original unique data tokens. All 32 volumes
were explicitly removed afterward and guest storage inventory matched baseline.
All temporary worktrees/branch refs were removed. Each graph was archived, exported
and pruned through the managed path, preserving exports and consumed-ID receipts.
The VM ended stopped, protected global hashes were unchanged, and all 57 watchdog
samples retained normal memory pressure with unchanged swapouts.

Evidence:
`.hack-local/review/wu07/worktrees-32-memory-1789599489319258000/`.
Binary SHA-256:
`33bf794257021a7475e1d4f69903b54ae9464a83857aaa58d04194be6d0a9dc8`.
No new runtime build was needed: this is the previously qualified aggregate-admission
candidate. This control does not establish automatic idle safety, host disk
reclamation, matched Compose performance, or a new default worth promoting.
