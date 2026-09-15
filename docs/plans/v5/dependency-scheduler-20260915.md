# Dependency-ordered graph scheduling — September 15

The candidate now executes each scheduling pass in the deterministic dependency order already
computed during graph validation. In four old/new/old sequences, startup and restore are faster
with the new order every time. Median phase latency drops 7.8% and 8.7%, respectively. Median
engine CPU is essentially unchanged; this change is retained for latency, not as a new CPU saving.

## Behavior and correctness

Previously, validation computed a topological order to reject cycles, discarded it, and execution
scanned services alphabetically. A dependent visited before its prerequisite could wait for the
next 100 ms polling interval even after the prerequisite had become ready later in the same pass.
Execution now uses validation's order. Independent services remain deterministically ordered.

Dependency order is not permission to start. The driver still reobserves each dependency immediately
before admitting its dependent, records durable start intent, refuses ambiguous starts and checks
readiness/deadlines. A stalled graph retains the 100 ms backoff. No extra immediate polling pass,
concurrency, cached health assertion, ownership shortcut or journal change is introduced.

Regression controls prove that an already-ready init → web → check chain needs no polling sleep,
a stalled prerequisite reaches backoff without busy polling, and a dependency becoming unhealthy
blocks its dependent even after an earlier healthy observation. Existing failed-init, uncertain-start,
journal-failure, invalid-graph and timeout tests remain passing.

Three live controls pass with the final scheduling logic: driver interruption at probe allocation/
exec boundaries, supervisor loss and same-container restart/fresh restore, and non-root scoped
environment delivery with fresh restored values. Evidence:
`.hack-local/review/wu07/graph-native-http-1789501732900553000/`.
All eleven watchdog samples have normal pressure and unchanged swapouts; owned cleanup and VM stop
pass. These are bounded fixture controls, separate from full Event Agent acceptance.

## Matched comparison

Evidence: `.hack-local/review/wu05/scheduler-aba-1789501809366622000/`.
The directory retains the frozen protocol, source patch, distinct executable hashes, raw commands,
process CPU counters, workload checks, watchdog and independent analysis. The baseline executable
matches the prior qualified native HTTP binary. [All 48 measured phase rows](scheduler-comparison-20260915.csv)
are exported without private identities.

One excluded warmup per build precedes four baseline → dependency-order → baseline sequences on
one owned VM. All 12 measured trials and both warmups run the same pinned native HTTP init/SQLite/
web/check workload, complete 200 requests on startup and restore, preserve the database token,
use fresh compute IDs, verify effective limits and remove/archive owned resources. Builds and
agent-controlled tests finish before measurement. Both variants use the same VM capacity.

CPU counters bracket whole phases, including readiness inspection; they measure gross engine CPU,
not CLI CPU, isolated container cost or steady-state overhead. Background activity on this shared
host is not eliminated. Each new-build trial is compared with the mean of its adjacent baseline
trials to reduce drift sensitivity. All 39 watchdog samples have normal pressure and unchanged
swapouts; protected inputs match and the VM stops. The activated candidate binary matches the
measured dependency-order hash.

| Phase | Baseline median, eight trials | New median, four trials | Change |
| --- | ---: | ---: | ---: |
| Startup + completed workload | 1.307 s | 1.205 s | 7.8% faster |
| Restore + completed workload | 1.290 s | 1.177 s | 8.7% faster |
| Startup engine CPU | 0.691 CPU-s | 0.694 CPU-s | +0.3% |
| Restore engine CPU | 0.678 CPU-s | 0.673 CPU-s | −0.8% |

Paired startup latency improvements range from 5.9–16.9%; restore improvements range from
5.3–16.8%. CPU pair differences vary in both directions, so no CPU improvement or strict CPU
non-regression bound is claimed. Cleanup was unchanged by this patch: its measured median was
0.501 versus 0.531 seconds retaining data and 0.484 versus 0.480 seconds removing data. These
fluctuations are controls, not attributed cleanup gains. This small cohort does not establish tail
latency or full-application performance.

## Rejected approach

An earlier implementation kept alphabetical iteration and immediately repeated a pass after bounded
progress. It passed correctness controls but did not qualify for adoption. Initial evidence:
`.hack-local/review/wu05/scheduler-aba-1789501366381688000/`.
A warmup-controlled repeat in `scheduler-aba-1789501502720713000/` showed higher startup engine CPU
in all four paired comparisons (3.7–27.0% higher); startup median CPU was 0.793 versus 0.658 CPU-s.
Restore latency improved, but that did not justify the startup tradeoff. The rejected patch and
binary remain private evidence. A host spot-check also recorded background CPU activity, so this
is an adoption decision under the observed results, not a precise causal CPU attribution.

The final implementation reuses dependency order instead of adding those polling passes. The
failed experiment's measurements are not combined with the final implementation's results.

## Verification and next unit

The final code passes 153 default Rust tests and 158 with `environment-launcher,native-http-probe`,
strict Clippy in both configurations, and the three live controls above. Repository typecheck,
lint/privacy and the CLI test gate pass (940 passing tests, five skips; the final CLI rerun reused
unchanged task-cache results). Documentation links, scalar rows and whitespace checks pass.
This is candidate-branch evidence, not hosted CI or release qualification.

[Bounded concurrent cleanup](concurrent-cleanup-20260915.md) passed correctness controls but did
not qualify across the lifecycle; sequential deletion remains the default. A follow-up must isolate
phase/order effects and include CLI CPU before reconsidering adoption. The existing CPU/footprint defaults remain intact; resource-size sweeps and real-application
idle reclamation/recovery remain separate open work.
