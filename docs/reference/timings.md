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
steps as opaque names. Unknown roles, clocks and outcomes become `unknown` without
losing the span; an unknown clock cannot be joined as a host clock. Unsupported
attribute values are ignored. Step names, attribute keys and error codes must match
`^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$`, at most 128 ASCII bytes. An unsafe step rejects
the line; unsafe optional codes and attribute keys are discarded. Additive fields
and names do not change the schema version.

Trace/span/parent IDs map directly to OTLP IDs without renumbering. Parentage and
parallel spans do not depend on array, arrival or completion order. Each process
keeps one anchor pair on every line. Host placement uses
`child.origin_mono_us + child.start_us - parent.origin_mono_us`, not the time a
record arrived. A host child's origin is the parent's observed spawn instant;
`process.startup` accounts for spawn through initialization when that interval is
between zero and 60 seconds. A future or older spawn timestamp uses a fresh anchor
and emits no startup span, while collection continues. Such a process marks its
root with typed `attrs.anchor_fresh:true` (repeated on child spans and retained by
per-request trace contexts). Readers must not subtract anchors for that process;
place its spans within the parent's observed spawn/exit interval instead. The
host-join helper refuses marked records. The host clock is
`CLOCK_UPTIME_RAW` on macOS and `CLOCK_MONOTONIC` on Linux. Bun's high-resolution
timers are relative to VM initialization, so they cannot supply an absolute host
spawn timestamp. Unix start time is
`origin_unix_us + start_us`; OTLP nanoseconds require integer conversion without
floating-point rounding. Guest clocks need the parent's observed spawn/exit bounds;
they cannot be subtracted from host clocks. Parent references can outlive or arrive
before the referenced span. Do not sum overlapping parent and child durations.

The runtime internal argument is
`--internal-timings=fd:trace:parent:spawn_mono_us:role`, before ordinary arguments.
The parent transfers a dedicated extra descriptor (3 or above). The runtime sets
close-on-exec immediately after parsing its number, before validating context or
descriptor type; rejection closes the transferred descriptor. Accepted descriptors
are nonblocking; each bounded line is one atomic write. Timing never
shares stdout or stderr. Explicit exits flush dispatch and incomplete spans without
changing exit codes. Open spans use elapsed duration and `incomplete`.
At most 2,047 ordinary records are retained for emission; a final
`timings.truncated` line reports `attrs.dropped`. Capacity preserves the completed
prefix, and a killed process leaves only complete lines already emitted.

`vm.boot` starts before the provider start command and includes provider identity
checks, engine readiness and any existing failed-boot cleanup. A provider start
failure therefore records an error span. Warm starts use `vm.reattach`.

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

Numeric keys include `service_index`, `attempt`, `engine_requests`, `engine_connections`, `engine_transports`, `engine_method`, `dropped`,
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

On macOS, launchers use a connected Unix datagram socket. Each datagram contains
one newline-terminated record. The writer queries `net.local.dgram.maxdgram` and
`SO_SNDBUF` and uses the smaller limit (also bounded by the format line limit).
The reader raises its own `SO_RCVBUF` to 256 KiB, queries the achieved capacity
(at least 64 KiB), and drains continuously while the child runs. After observed
child exit it drains residual packets without waiting for datagram EOF. A rich
record fits the default macOS 2 KiB payload limit; the real-descriptor test sends
256 rich records with a concurrent reader and bounded producer pacing.

Pipes remain available for small records, bounded by observed `PIPE_BUF` (512
bytes on macOS). Oversized lines are dropped and counted; pipes are unsuitable
for the full attribute vocabulary there. Linux datagram payload capacity is
queried from `SO_SNDBUF` minus its 32-byte kernel reservation. No global socket
settings are changed. Diagnostic writes never wait for the reader; saturation
can drop records and is reported by the truncation marker when it can be sent.

## Engine counter capture

`HACK_ENGINE_REQUESTS_FILE` selects a private append-only JSONL file using this same
schema. Runtime children inherit this setting explicitly. An installed dedicated
timing descriptor takes precedence; a process never exports to both sinks.
File spans queue within the existing record bound and flush at command completion,
explicit exits and owner readiness checkpoints. File appenders serialize flushes
under a lock. A killed process can lose pending records; reject malformed or
`timings.truncated` captures rather than treating them as complete totals.

Fixed `engine.request.*` steps carry `attrs.engine_requests` and `engine_method`
(OTHER=0, GET=1, HEAD=2, POST=3, DELETE=4, PUT=5). Route segments use dots and object
identifiers become `id`; unknown routes use `engine.request.other`.
`engine.connections` carries `engine_connections` (actual connector/raw socket
attempts) and `engine_transports` (HTTP client creation attempts). Counters describe
attempts, including failures; an `ok` snapshot does not assert an engine effect.
Sum disjoint snapshots across processes. Owners started before capture was enabled
are excluded. Capture a snapshot when the command returns, before teardown.
