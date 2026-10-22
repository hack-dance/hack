# Native process census phase diagnostics

Recovery requires fresh, bounded, complete process observations. An expired
observation refuses recovery. A changed identity refuses when the row is of
interest: it carries the original process's PID, PGID or SID.

Recovery quiescence bounds its census to those rows of interest. A foreign row
decides nothing, but nothing about it is accepted on trust either:

- Drift of one foreign process between the two observations (same PID and
  birth, never a zombie) is accepted. Examples are exec, reparenting, a PGID or
  SID change, and live/transient state.
- Foreign PID reuse and foreign zombie churn supersede the pair.
- A failed SID lookup for a live row whose PID and PGID are both foreign also
  supersedes the attempt. On macOS this happens when a process exits, or
  becomes a zombie, between the listing and the lookup.

A superseded attempt is discarded whole. It leaves no denial fact, and it needs
two new complete observations within the same budget. A census without rows of
interest still refuses every change. Diagnostics do not authorize retry, extend
the three-second budget, or establish runtime acceptance.

Heavy short-lived process churn can still exhaust the budget. If most listings
include a process that exits before its SID is read, the census refuses as
expired.

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
| `sessions` | Session qualification of captured rows; includes fallback metadata used to classify an unavailable live session (only for rows of interest when the census is bounded). |
| `merge` | Existing identity/membership comparison of two complete observations. |
| `census` | One complete census call, including any disappearance or superseded-attempt retries within its original budget. |

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
