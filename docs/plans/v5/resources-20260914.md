# September 14, 2026 — Resource accounting and health-check cadence

The candidate has a lower observed empty-pool footprint and CPU cost than the current OrbStack
processes, but its frequently probed graph used more CPU. An explicit health-check cadence change
then reduced candidate graph CPU by 76.6% in an A/B/A control, with readiness inside the observed
control range. Memory remained resident after graph cleanup and disappeared from the owned process
inventory only when the VM stopped. These findings guide the next optimization work; they do not
establish a full application or equivalent-capacity provider winner.

This supplements the [32-trial warm graph benchmark](benchmark-20260914.md). It does not replace
that frozen cohort or mix its timings with the single resource/cadence trials below.

## Implemented and verified

- `runtime status --json` now reports a bounded native root/descendant resource tree: identities,
  resident/physical-footprint bytes, CPU nanoseconds, disk I/O and idle wakeups. A changed identity,
  unreadable process or more than 64 processes refuses the snapshot rather than publishing a partial
  total. CPU uses the Mach timebase and is calibrated against independent `getrusage` counters.
- Executable command/entrypoint strings support bounded Compose-compatible word splitting for the
  supported subset. Quotes, empty arguments, escaping, Unicode and concatenated words pass the
  recorded Compose reference cases and live init/SQLite/web/check execution. No implicit shell is
  introduced; unquoted controls/backticks, malformed quoting and excessive argument counts refuse.
- Compose `healthcheck.start_interval` is reviewed and delivered to the engine. Absent values preserve
  previous health serialization. Existing project settings and defaults are unchanged.

Resource accounting and command words are source checkpoint `09263423`; startup cadence support is
`8fb05e27`. The final release build, rustfmt, all-target clippy and **122 Rust tests** pass; 13 opt-in
tests are excluded from that ordinary suite. The separate live pilot, resource run and A/B/A run
passed their stated controls. CLI reference regeneration has no TypeScript interface drift. This is
local qualification, not hosted CI, distribution, migration or release acceptance.

## Empty-pool and running-graph measurements

CPU means percent of **one core**, derived from cumulative native CPU deltas divided by actual
elapsed time. Footprint is the median sum of observed physical-footprint bytes, in MiB; it is not
configured RAM, unique-page accounting or whole-host used memory. The requested ten-minute idle
window has 599.16 seconds between its first and last usable samples. Graph windows are about 60 seconds.

| Observation | Candidate CPU | Candidate footprint | OrbStack CPU | OrbStack footprint |
| --- | --- | --- | --- | --- |
| Empty pools | 0.45% | 622.5 MiB | 1.06% | 2393.4 MiB |
| Same idle graph, 100 ms health interval | 48.17% | 878.2 MiB | 39.80% | 2847.5 MiB |

The candidate is an owned 4-vCPU / 6-GiB development pool. OrbStack reports 16 CPUs and
73,705,746,432 bytes of engine memory, with its UI/helper processes and broader functionality.
These pool capacities and features differ. The graph's image contents, commands, CPU/memory/PID/
shared-memory limits and security settings match the earlier benchmark; the live run additionally
uses command strings. Only one graph runs at a time. The graph window is idle service operation
with periodic health checks after the 200-request correctness probe, not sustained application load.

OrbStack's two observed processes cover its descendants in the read-only inventory audit. The stable
Hack daemon root is measured separately in the CSV; it is **not a complete daemon total**. An audit
found an additional Docker events child. A late companion observer captured that child for graph
windows, but its early idle data is unavailable and is not extrapolated. The main observer and its
reaped CLI children used roughly 1.35–1.92% of one core across the windows and are reported separately.
This instrumentation cost is material relative to empty-pool CPU and is not part of the candidate's
resident runtime. Short-lived/reparented helpers and shared-page accounting remain explicit limits.

## Reclamation

| Candidate state | CPU | Median footprint |
| --- | --- | --- |
| Graph removed, data retained | 0.39% | 906.3 MiB |
| Graph and data removed | 0.49% | 907.6 MiB |
| VM stopped, observed for 60 seconds | No owned live provider process | No owned live provider process |

CPU returned close to the empty-pool level, but about 908 MiB remained in the warm VM. Removing
containers/data is therefore not immediate host-footprint reclamation. Stopping the VM removes
that owned process footprint; this does not prove all filesystem cache pages were returned to the
host, nor does it remove retained images, disk allocations, receipts or evidence archives.

## Controlled cadence change

Both candidates and Compose can express separate startup and steady health-check intervals. The
new compiler support preserves that explicit choice; it does not silently weaken existing checks.
The control used a 100 ms interval. The middle run used:

```yaml
healthcheck:
  interval: 1s
  start_period: 10s
  start_interval: 100ms
```

The engine checks quickly during startup, then uses the regular interval after success. A slower
regular interval increases later failure-detection latency. See the
[Docker health-check reference](https://docs.docker.com/reference/compose-file/services/#healthcheck).

| Run | Candidate CPU, one core | Ready + 200-request check | Median observed probe spacing |
| --- | --- | --- | --- |
| 1: frequent | 40.68% | 1.831s | 0.180s |
| 2: startup-fast-steady-slow | 10.10% | 1.415s | 1.117s |
| 3: frequent | 45.61% | 1.301s | 0.200s |

CPU fell by 76.6% relative to the mean of the two controls and rose again when the frequent
cadence returned. The changed run's readiness was within the controls' 1.30–1.83 second range.
Actual engine configuration and successful health-log timestamps confirm the cadence change.
All three trials preserve the database token on restore, use new compute identities, and confirm
owned cleanup. Three sequential windows are a useful mechanism control, not a statistical tail or
throughput qualification. The 1-second configuration was not compared against a similarly changed
OrbStack graph here; it is not an exclusive candidate advantage or a RAM optimization.

## Evidence and unsuccessful checks

The primary run is `.hack-local/review/wu05/resources-1789415966310064000/`; its public scalar data
are [resources-20260914.csv](resources-20260914.csv). The cadence run is
`.hack-local/review/wu05/health-cadence-1789417129874758000/`, with
[health-cadence-20260914.csv](health-cadence-20260914.csv). Both retain frozen `protocol.py`, metadata,
raw watchdog samples, calls, workload/persistence receipts, protection checks and stopped-state proof.
The primary analysis excludes one snapshot whose native phase was `stopping` despite the prior
steady-stage label; it remains in raw evidence. The cadence harness marks shutdown separately.

Primary binary SHA-256: `a2552ab1aadc73fbf6c13f740a9cb617cc7223abbd05afb5fddd3ad5c8032c68`.
Cadence binary SHA-256: `73c18f2e904498a47618196e8f514e4b7498fb70e36b5b22ea840ec69558dd09`.
Primary protocol SHA-256: `156d581dc242dfa4503667a6d75e96066342fa909ebada17505949e39d054f88`.
Cadence protocol SHA-256: `4fb30040e99da7c56922d4c6acfe80ca22077dcce256010d3e1adefd84e7eba7`.

An initial native-tree test correctly rejected `/bin/sh` changing executable identity to `/bin/bash`;
the controlled test now launches the intended stable executable directly. An independent CPU-clock
calibration caught raw Mach ticks being mistaken for nanoseconds before the measured runs. The
conversion and regression test fix that undercount. The Docker-child omission and observer cost
remain recorded measurement limitations. Native pressure stayed normal, swapouts stayed unchanged,
protected inputs/configuration matched except normal registry observation timestamps, and owned
fixture resources/registrations were removed. The installed v4.2.0 daemon remains running and compatible.

## Work-unit review and next acceptance gates

### Persistent native observer follow-up

The Rust `resource-sampler` example now observes 1–8 explicitly selected, disjoint native process
trees in one persistent process. Selection requires the exact executable and current-user native
identity; every sample rechecks root/descendant identities. Overlapping trees, an observer inside
a selected tree, unavailable processes and invalid budgets fail without emitting a partial sample.
Output is bounded to one hour, uses absolute sampling deadlines, and records both observer usage
and a final completion marker. A consumer must require that marker and successful exit; earlier
samples alone do not prove completion. Sampling reads no command arguments or environment values
and confers no lifecycle authority over external processes.

Build with `CARGO_TARGET_DIR=.hack-local/target cargo +1.97.1 build --manifest-path
packages/runtime-core/Cargo.toml --release --example resource-sampler` (one shell command).
Invoke `.hack-local/target/release/examples/resource-sampler COUNT INTERVAL_MS LABEL PID
EXACT_EXECUTABLE`, adding label/PID/executable triples for additional roots. Supply freshly verified
PIDs and executable paths. The example emits JSON Lines to stdout; preserve it as private evidence.

A read-only follow-up collected 31 samples over 60.000 seconds at two-second cadence. The candidate
VM stayed stopped. Both stable-daemon processes, including the Docker events child, appeared in
every sample; all selected identities remained unchanged.

| Selected component | Processes | CPU, percent of one core | Median footprint |
| --- | --- | --- | --- |
| OrbStack UI | 1 | 0.0023% | 102.67 MiB |
| OrbStack helper | 1 | 1.0181% | 2269.01 MiB |
| Stable Hack daemon and descendants | 2 | 0.6859% | 83.44 MiB |
| Persistent observer | 1 | 0.0614% | 1.94 MiB |

Median sample observation took 1,012 microseconds. This closes the missing-descendant issue for
this selected daemon and window, and provides a lower-cost collection path. It does not repair the
earlier cohort, cover unrelated Hack clients, or prove whole-system accounting. The earlier harness
also performed lifecycle/pressure checks, so its 1.35–1.92% cost is not an equivalent-workload
speedup baseline. Exited/reparented helpers and shared memory remain outside complete accounting.

Private evidence is `.hack-local/review/native-sampler-20260914/`: exact command, JSONL samples,
exit status, negative controls and derived summary. Raw samples SHA-256:
`892043358e59f995f6e5b9e2386b338f454b3b172b6b115b169eec0121bd1faa`.
Observed binary SHA-256: `6cceda921f1acacba30cbaad7fa10e3f464086eccb90162cf6cc2d97dd726399`.
Wrong executable, overlapping roots and invalid-budget controls all exit nonzero without a sample.
An owned sleep process was terminated after the first sample; the sampler rejected its next
observation, exited nonzero and omitted the completion marker. The fixture was reaped. The native
regression suite additionally checks stale identities and CPU-clock calibration. All **123 Rust
tests**, rustfmt, all-target clippy, release builds and privacy/document-link checks pass locally;
13 opt-in tests remain excluded. The fresh 14-service application plan retains the same 22 errors
and two warnings, and both protected input hashes match the previous checkpoint.

### Remaining application and performance gates

- WU07 advances with executable command words and startup cadence compatibility. The captured
  14-service application plan still has 22 errors: 12 unresolved mount sources, nine external
  route/owner-label conflicts and one external network; two metadata warnings are separate. Build,
  managed environment delivery, lifecycle/routing and the full application workflow remain open.
- WU10 now has calibrated native CPU/footprint observations, a ten-minute empty-pool window,
  running-graph and reclamation windows, and a cadence counterfactual. Full application load,
  CPU per completed task, reload/build, longer memory trends and equal-capacity comparison remain open.
- Resource follow-ups: integrate the qualified persistent sampler into the next matched graph
  cohort, including every selected external daemon descendant from the first sample; investigate remaining candidate CPU overhead
  under equal probe cadence; evaluate explicit idle-pool reclamation against restart latency and
  active-work/data guarantees. Do not add automatic shutdown or change user defaults without those controls.
- WU05/06 synchronization/cache recovery, WU08 durable terminals, WU09 Linux/SSH parity, and WU11
  packaging/migration retain their prior open gates. The immediate application critical path remains
  source/build and managed environment delivery.
