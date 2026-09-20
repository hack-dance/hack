---
name: hack-repo-performance
description: Design and run bounded Hack runtime benchmarks or CPU, memory, disk and cleanup investigations with matched baselines. Use for performance claims and optimization experiments, not ordinary correctness checks.
---

# Measure Hack runtime behavior

Start with the [work-unit contract](../hack-repo-work-unit/SKILL.md), existing
[performance diagnostics](../../../docs/performance.md) and the relevant
v5 ledger entry (local `_docs/docs/plans/v5/work-units.md`). Reuse a qualified harness
when one exists; inspect its source and workload before treating an old report or
untracked experiment directory as canonical tooling.

1. Name one question, metric, acceptance threshold, trial count and time/resource
   ceiling. Record source SHA/dirty patch, executable path/version, provider pins,
   OS/architecture, CPU/memory limits, workload/lockfile and persistent-data state.
2. Match stable Hack, direct Compose and candidate on the same workload and host
   where possible. Keep cold image/install cost, warm start, no-op, exec, readiness,
   shutdown and cleanup separate. Alternate trial order; preserve raw samples,
   dispersion and failures. Explain mismatches instead of calculating a false win.
3. Confirm the application result before timing it as success. Use its dependency
   readiness and real operation/data readback, not just a process start or open port.
4. Measure the complete relevant process tree and shared VM/runtime. Record wall
   time, CPU seconds (and sampling duration for CPU percent), idle activity, peak and
   steady memory, disk I/O and allocated disk. Distinguish RSS, footprint, shared
   pages, guest allocation and sparse capacity; do not add incompatible quantities.
5. Profile the hot path before changing it. Make one bounded change and rerun the
   matched loop with correctness/recovery controls. An improvement in one metric
   does not justify silently degrading another or promoting an experimental default.
6. Recheck idle/stop/cleanup. Preserve active and shared data; unused engine references
   are not deletion authority. Prove ownership and retire only the experiment's
   artifacts. Record retained caches and allocated bytes after cleanup separately.

Keep native SmolVM/Hypervisor behavior on the host being qualified. Portable tasks
can use `hack run --profile toolchain toolchain -- exec <command>`; include that
container's limits and outer runtime in interpretation. Do not nest Docker or mount
the host socket into the developer toolchain merely to make a benchmark run.

Store a concise report beside the relevant plan: workload and commands, revisions,
measurement boundary, trial samples/summary, correctness controls, cleanup readback,
limitations and the next decision. Sanitize private application paths and data.
If admission fails or the cohort is mismatched, report the comparison as inconclusive.
