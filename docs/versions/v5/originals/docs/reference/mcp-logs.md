# MCP logs contract

This page covers the `hack.project.logs.tail` and `hack.project.logs.snapshot`
MCP tools. Both tools run `hack logs --json` once per call and return the stream
events they collected. When a shell is available, use `hack logs` directly.

## Outcomes

Each call ends in exactly one outcome.

| Outcome | `ok` | `isError` | `data.cutoff` | `error` |
| --- | --- | --- | --- | --- |
| Complete: the backend ended the stream and exited 0 | `true` | absent | `null` | absent |
| Cutoff: the server stopped at one of its bounds | `true` | absent | set | absent |
| Backend failure | `false` | `true` | `null` | `backend_error` |

A cutoff is a success. The collected events are valid. The stream simply
continued past the bound. `data.cutoff` is `{ "bound": ..., "limit": ... }`:

- `events`: `maxEvents` log events were collected (tail only). Only
  `type: "log"` events count. `start`, `heartbeat`, `error` and `end` events
  are returned in `data.events` but do not use up the limit.
- `time`: the collection window ended. For tail this is `maxMs`. For snapshot
  it is the fixed 120 second command timeout.
- `bytes`: stdout plus stderr reached the 8 MiB capture limit.
  `outputTruncated` is `true`, and `data` still carries every event parsed
  before the cut. The cut never splits a UTF-8 code point. A trailing partial
  line can be present in `stdout`, but it is never parsed as an event.

After a cutoff, the server stopped the child process, so `exitCode` is often
non-zero. Use `ok` and `data.cutoff` to read the result, not `exitCode`.
`data.stop_reason` (tail only) keeps its earlier values: `eof`, `max_events`,
`timeout`, `output_limit`, `cancelled` or `interrupted`.

A backend failure is not a truncated success. It is reported when the stream
contains an `error` event or an `end` event with a reason other than `eof` or
`closed`, or when the child exits non-zero at the end of the stream. The error
is closed: `code` is `E_UNEXPECTED`, `reason` is `backend_error`, and `message`
is fixed text that never repeats backend output, caller input or the query.
Raw `stdout` and `stderr` are still returned, as they are for other tools.

Failure evidence counts only before the server stops the child. A child that
writes `error` or `end` events, or exits non-zero, in response to the server's
own stop signal still produces a cutoff. The byte bound is an exception for
events: every retained byte was written before the child was signalled, and
nothing after the cut is parsed, so an `error` or failing `end` event in the
returned prefix is still a backend failure. For the `events` and `time` bounds,
an `error` event that the backend wrote just before the stop but that the server
read after it is reported as a cutoff. The server cannot tell it apart from an
event written in response to the stop.

## Reconnects and repeated calls

The server keeps no log state between calls. Every call starts a new backend
stream:

- A repeated call does not replay events from an earlier call, and it does not
  continue after the earlier call's last event.
- A cancelled request, or a session that closes mid-call, stops the backend
  process group. The interrupted call's events are not delivered later, to this
  session or to a reconnected one.

To continue a stream approximately, call again with `since` set to the last
event's `ts`. `since` selects the Loki backend and cannot be combined with
`compose`. Expect overlap at the boundary and remove duplicates on the client.

## Decision: no handles, cursors or idempotency keys (no-go)

Status: no-go for now (HACK-1134). This decision adds no cursor implementation.

We considered three additions:

- A stream handle, so a later call can attach to a running tail.
- A resume cursor, so a later call can continue after the last returned event.
- An idempotency key, so a retried call returns the same result.

Reasons for no-go:

1. **The backends have no exact cursor.** Hack's compose path accepts only
   `tail`, and `docker compose logs` itself offers only timestamp filters that
   can repeat or skip lines with the same timestamp. The lifecycle log
   companion is a file tail. Loki selects by time range, and its timestamps
   are not unique. A cursor would promise gapless, duplicate-free resume that
   Hack cannot deliver, least of all for the default compose backend.
2. **A handle needs state that does not survive the common reconnect.** A
   stdio MCP client reconnects by starting a new `hack mcp serve` process, so
   in-memory handles are lost. Keeping them on disk under `HACK_HOME` would add
   retained log data, plus ownership, expiry and cleanup rules. Logs can hold
   secrets, so that retention is a risk.
3. **Idempotency adds nothing to a read.** Both tools are read-only and
   annotated `readOnlyHint`. A retry is already safe. It returns current data
   rather than a replay, and that is the documented behavior above.
4. **Bounded calls already cover the need.** Agents call tail with a small
   window, read `data.cutoff`, and call again with `since` when they need more.

Revisit this decision (go) only when all of these are true:

- A backend exposes a stable, monotonic position, such as a daemon-owned log
  index.
- Hack has a daemon-owned buffer with defined retention, ownership and secret
  handling.
- A real agent workflow shows that `since` overlap is not good enough.
