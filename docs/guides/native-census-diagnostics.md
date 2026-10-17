# Native process census phase diagnostics

Recovery requires fresh, bounded, complete process observations. A changed process
identity or expired observation refuses recovery. These rules apply even when the
changed row is unrelated to the selected process. Diagnostics do not authorize
retry, extend the three-second budget, or establish runtime acceptance.

For source-level investigation, explicitly create a
`createNativeProcessCensusDiagnostics()` collector from
`src/backends/native-process-census-diagnostics.ts`. Pass it as
`readNativeAuthoredProcessCensus(3000, { diagnostics })`, or as the third options
argument to `assertNativeAuthoredProcessQuiescent`. Obtain a report with
`diagnostics.snapshot()` after completion or refusal. Production callers omit the
collector; there is no default output, persisted telemetry or CLI setting.

The collector retains the most recent 256 immutable samples and reports how many
older samples were dropped. A late failure remains observable even in a long run. Snapshots remain unchanged as later observations arrive.
It stores only fixed phase/outcome labels, elapsed milliseconds and row counts;
unknown row counts are null. It does not retain PIDs, paths, executable names,
birth times, environment, command arguments, raw process rows or exception text.
No caller callback executes inside the observation protocol.

| Phase | Scope |
| --- | --- |
| `metadata` | One complete system metadata child, including pipe/exit settlement and parsing. |
| `sessions` | Session qualification of captured rows; includes fallback metadata used to classify an unavailable live session. |
| `merge` | Existing identity/membership comparison of two complete observations. |
| `census` | One complete census call, including any already-authorized disappearance retries within its original budget. |

A sample's `complete` outcome describes that phase only. A successful metadata or
session phase does not imply a complete census or successful recovery. Likewise,
a complete census does not authorize effects without the remaining ownership,
source and deadline checks. A failure later in recovery does not retroactively
invalidate an earlier sample's phase measurement.

The synthetic controls in `tests/native-authored-process-census.test.ts` check
identity-change refusal and expired-pair refusal with diagnostics enabled. The
existing real-observation synthetic recovery control emits its bounded phase
report only on failure. Tests must not remove identity guards, reset budgets or
turn uncertainty into authority to make a busy host pass.

Run focused controls with:

```sh
bun test tests/native-authored-process-census.test.ts \
  tests/native-authored-process-incarnation.test.ts \
  tests/native-process-census-diagnostics.test.ts
```

These controls use owned finite metadata children and synthetic process rows.
The separate recovery fixture uses real read-only process metadata, and can
refuse on host churn; its result must be reported separately from the synthetic
controls and live authored-project acceptance.
