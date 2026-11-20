# Timing records

`hack.timings/1` is the timing envelope shared by the CLI and Rust runtime. Records
contain only a fixed step name, numeric span and parent IDs, monotonic start offset
and duration in microseconds, an outcome (`ok`, `error`, `skipped`), and optional
`cached: true`. The cache field means an existing stored result replaced work;
ordinary successful work does not set it. Names never include service names,
paths, arguments, environment values or error messages.

The envelope has `schema`, `records` and `truncated`. IDs start at 1 in record order;
a parent must precede its child. A report holds at most 2,048 records. `truncated`
means some records were omitted. Readers must not claim complete step coverage
from such a report. Unknown fields, step names and invalid numbers are rejected.

Offsets belong to one monotonic process timeline, not calendar time. To join a
child report, a parent adds its observed child-spawn offset, remaps IDs, and attaches
child roots to the enclosing request. Process startup before the child's first
clock reading stays in the parent's request span. Do not sum a parent and its
children: their durations overlap. An `ok` outcome describes the operation's
result contract; it does not independently prove application health.

The runtime's internal parent transport uses a leading `--internal-timings`
argument and one `HACK_TIMINGS ` JSON line on captured stderr after dispatch.
Without that argument the runtime creates no timing report or timing file.
It does not change structured command responses, errors, retries or ownership.
The CLI-facing flag and timeline reader are a separate integration slice.
