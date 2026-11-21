# Timing records

`hack.timings/1` uses one JSON line per finished span. Fields are `schema`, `trace`
(32 lowercase hex digits), `span` and optional `parent` (16 lowercase hex digits),
`proc` (`cli`, `runtime`, `owner`, `guest`), `clock` (`host`, `guest`),
`origin_unix_us`, `origin_mono_us`, `step`, `start_us`, `dur_us`, and `outcome`.
Outcomes are `ok`, `error`, `cancelled`, `incomplete`, `skipped`. Optional
`cached:true` describes a successful stored result and appears only with `ok`.
Optional `code` is a fixed error code, never a message. `attrs` contains numeric
or boolean values from the writer vocabulary listed below. Services are
distinguished by index, never name.
Writers use fixed step names. Readers ignore new fields and preserve unknown
steps as opaque names. Additive fields and steps do not change the schema version.

Trace/span/parent IDs map directly to OTLP IDs without renumbering. Parentage and
parallel spans do not depend on array, arrival or completion order. Each process
keeps one anchor pair on every line. Host placement uses
`child.origin_mono_us + child.start_us - parent.origin_mono_us`, not the time a
record arrived. A host child's origin is the parent's observed spawn instant;
`process.startup` accounts for spawn through initialization. Unix start time is
`origin_unix_us + start_us`; OTLP nanoseconds require integer conversion without
floating-point rounding. Guest clocks need the parent's observed spawn/exit bounds;
they cannot be subtracted from host clocks. Parent references can outlive or arrive
before the referenced span. Do not sum overlapping parent and child durations.

The runtime internal argument is
`--internal-timings=fd:trace:parent:spawn_mono_us:role`, before ordinary arguments.
The parent transfers a dedicated writable pipe descriptor. The runtime sets it
nonblocking and close-on-exec; each bounded line is one atomic write. Timing never
shares stdout or stderr. Explicit exits flush dispatch and incomplete spans without
changing exit codes. Open spans use elapsed duration and `incomplete`.
At most 2,047 ordinary records are retained for emission; a final
`timings.truncated` line reports `attrs.dropped`. Capacity preserves the completed
prefix, and a killed process leaves only complete lines already emitted.

This slice implements the Rust contract and transport only. The TypeScript reader,
public `--timings`/`--json` integration, long-lived child transport wiring and measured
command coverage follow separately. No CLI join or performance acceptance is claimed.

## Growing the vocabulary

A writer emits only the names shipped in its own build. A reader keeps names it
does not know. New steps and numeric/boolean attribute keys are additive, with no
schema version change. A root span declares `attrs.service_index_stable`: `false`
means `service_index` is a plan position; `true` means it is a stable slot from the
start graph's reuse implementation. Service contexts retain this process setting.
The internal argument accepts optional `:positions` (the default) or `:slots` after
its role to declare the mode.

Start-graph steps are `start.observe`, `start.decide`, `start.wave.record`,
`container.create`, `container.start`, `container.remove`, `container.ready`,
`container.publish`, and `spec.digest`. Kept services use `ok` with `cached:true`;
created/recreated services use `ok` without `cached`. Dependency-blocked work uses
`skipped` with `attrs.blocked:true`. A still-warming service has no completed
`container.ready` span until readiness is observed; the owner may outlive the CLI.

Numeric keys include `service_index`, `attempt`, `engine_requests`, `dropped`,
`services`, `wave`, `syncs`, `waited_on_index`, and `generation`. Boolean keys include
`blocked`, `waited_on_cap`, `reason_spec`, `reason_unhealthy`, `reason_exited`,
`reason_dead`, `reason_missing`, `reason_forced`, `reason_migrated`,
`reason_managed_env`, and the changed-field keys `changed_image`, `changed_command`,
`changed_env`, `changed_managed_env`, `changed_mounts`, `changed_networks`,
`changed_limits`, `changed_healthcheck`, `changed_probe`, `changed_ports`,
`changed_labels`, `changed_platform`, `changed_other`.

Stored-result misses use numeric `miss_reason`: 1 no record, 2 inputs changed,
3 epoch changed, 4 observation failed, 5 do not cache, 6 torn record, 7 version
changed. Hits omit the field. `inputs_changed_mask` is an integer bit mask below
2^53; its bit assignments belong to the producing step. Readers retain unfamiliar
reason codes without treating them as error messages.

An inherited Unix datagram descriptor is also supported. Each datagram contains
one newline-terminated record, atomically, up to 4,096 bytes. Prefer it for the
full attribute vocabulary on platforms whose pipe `PIPE_BUF` is only 512 bytes.
Pipe writers stay within their observed atomic limit and account for oversized
records as dropped. A datagram reader drains queued packets after observed child
exit; it must not wait for stream EOF on a datagram socket.
