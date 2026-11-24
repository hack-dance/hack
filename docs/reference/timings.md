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

`vm.ensure` carries `attrs.admission_reused` when a Development pool start's host
sample under the startup lease was accepted: `true` when a recorded earlier sample
replaced the admission wait, `false` when the start waited out its window. A start
that fails later still carries it. It is absent when no such sample was accepted:
a pool that was already running, a Research pool, or a start refused before or at
that sample.

Native `hack up` joins startup records from its runtime children under
`command.total`. `containers.started` ends when the final container start
is recorded. `services.ready` ends when all observed readiness conditions
hold. A milestone without a successful record has no observed time for
this invocation.

For image acquisition, `image.engine.preflight` measures the initial guest
check and `image.tag.resolve` measures mutable tag resolution.
`image.cache.inventory` measures receipt and archive metadata checks across
the local cache.
`image.pin.verify` measures digest-bound registry metadata verification. With
stored metadata it hashes the small manifest, selected child and config. If the
metadata is missing it includes the registry lookup.
`image.import.connect` includes provider lease wait and engine authentication.
`image.inspect` measures exact image readback, including guest ownership checks.
`image.archive.digest` measures the standalone archive SHA-256 pass and is absent
when a completed load receipt and live readback satisfy `ensure-image`.

`image.ensure` and `image.cache` report `attrs.registry_requests`, the count
of attempted HTTP sends in that runtime command, including registry
authentication, retries and redirects. A fresh loaded selection reports zero.
`image.tag.record` covers the local receipt read without network transfer.
A batch ensure also includes `attrs.image_index`, the zero-based position in
the batch request, so overlapping spans can be attributed to each image.

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
`container.publish`, `spec.digest`, and `env.stage`. Kept services use `ok` with `cached:true`;
created/recreated services use `ok` without `cached`. Dependency-blocked work uses
`skipped` with `attrs.blocked:true`. A still-warming service has no completed
`container.ready` span until readiness is observed; the owner may outlive the CLI.
Between a dependency's gate and its dependent's create, a fresh start records
`start.wave.record` (the durable start-intent receipt write), `container.inspect`
(the check that no container already has the planned name) and `container.create`
(the create request). A service with managed values also records `env.stage`
(staging its values into the guest and checking the staged path) between
`spec.digest` and `container.create`. Its durable attachment marker is part of the
start-intent write; a second `start.wave.record` appears only when it was not.

Numeric keys include `service_index`, `attempt`, `engine_requests`, `dropped`,
`services`, `wave`, `syncs`, `waited_on_index`, and `generation`. Boolean keys include
`blocked`, `waited_on_cap`, `admission_reused`, `reason_spec`, `reason_unhealthy`, `reason_exited`,
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
