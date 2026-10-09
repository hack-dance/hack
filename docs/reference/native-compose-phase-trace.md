# Native Compose phase trace

Set `HACK_NATIVE_COMPOSE_PHASE_TRACE=1` on one CLI invocation to emit optional
JSON lines to stderr while the native Compose command runs. For example:

```sh
HACK_NATIVE_COMPOSE_PHASE_TRACE=1 hack run web -- true
```

Only the literal value `1` enables tracing. The command consumes the flag once
before ordinary children inherit its environment. stdout and the command's result
retain their normal contracts. Concurrent in-process requests have separate trace
sequences; this diagnostic grants no ownership, recovery or cleanup authority.

Each version 1 line has exactly these fields:

| Field | Meaning |
| --- | --- |
| `diagnostic` | Fixed `native-compose-phase` tag |
| `version` | `1` |
| `sequence` | Increasing record number within this request |
| `span` | Number pairing the start and finish of one await |
| `phase` | Fixed phase name below |
| `boundary` | `begin`, `end` or `fail` |
| `elapsedMs` | Rounded monotonic milliseconds since trace start |
| `durationMs` | Rounded await duration, or `null` on `begin` |

A `begin` line is written before the existing await starts, so a retained capture
can identify the last phase that began. `end` means only that await returned;
`fail` means it rejected. Neither means command success, completed cleanup or a
proven timeout cause. Records contain no resource IDs, paths, arguments,
environment values, subprocess output or exception text.

The canonical call sites cover `oneoff.post-remove-owned`,
`guard.fresh-before`, `guard.ownership`, `finish.pending`, and the finalization
phases `finalize.fresh`, `finalize.generation`, `finalize.projection`,
`finalize.owned`, `finalize.remember-storage`, `finalize.witnesses`,
`finalize.pending`, `finalize.before-complete` and `finalize.save`. A finalization
recheck repeats the phase with a new span. Conditional phases appear only when the
existing command takes that path. The canonical trace does not yet distinguish
the unmerged ordinary-storage activation's `storage.verify` await. That
integration must add a span at its actual call site before claiming storage
attribution.

Output stops after 256 records or 64 KiB, or if the clock or sink fails. Diagnostic
failure preserves the original result or rejection and starts no retry. An
unfinished span may therefore mean capture interruption, truncation or diagnostic
failure. This bounds bytes and write attempts, not stderr latency or durability;
a launcher must still enforce its own deadline and settle its captured CLI.
Existing product await order, deadlines and ownership checks remain unchanged.
The trace is observability, not a performance improvement or complete CPU profile.
