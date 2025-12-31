# Structured log streaming spec

## Summary

Add a structured, streaming log output that can power MCP tools and a future TUI without parsing
human-formatted logs. The output is NDJSON (one JSON object per line) with a stable event schema
and a small set of event types.

## Goals

- Stream logs in a machine-friendly format (NDJSON).
- Preserve the existing log fields already emitted by `LogJsonEntry`.
- Provide a small set of stream-level events (start/end/heartbeat/errors).
- Work with both backends (compose, loki).
- Be easy to consume from an MCP server and a TUI.

## Non-goals

- Full log search or query language (Loki already covers this).
- Replacing Grafana/Loki UI.
- Remote or multi-host log aggregation.

## Proposed CLI surface

Primary path (minimal new flags):

- `hack logs --json` emits NDJSON and supports follow or snapshot modes.
- `hack logs --no-follow --json` keeps the current snapshot behavior (finite NDJSON stream).
- `hack logs --json` (follow) emits structured events and log lines indefinitely.

Optional flags (nice-to-have):

- `--heartbeat <seconds>` to emit heartbeat events while idle (default: 10s).
- `--stream` to force event envelope output even for snapshots (for strict consumers).

Notes:

- `--pretty` and `--json` remain mutually exclusive.
- `--loki/--compose`, `--services`, `--query`, `--since/--until` apply as they do today.

## NDJSON event format

Every line is a single JSON object (UTF-8, ASCII-compatible). Consumers should treat it as an
append-only stream.

Top-level event shape:

```
{
  "type": "start" | "log" | "heartbeat" | "error" | "end",
  "ts": "2025-01-01T00:00:00.000Z",
  "project": "my-app",
  "backend": "compose" | "loki",
  "branch": "feature-x",
  "services": ["api", "www"],
  "follow": true,
  "since": "2h",
  "until": null,
  "entry": { ... }
}
```

Event types:

- `start`: emitted once at stream start with resolved options.
- `log`: emitted for each log line. `entry` contains the log payload.
- `heartbeat`: emitted on an interval when no logs arrive.
- `error`: emitted on backend errors; may be followed by `end`.
- `end`: emitted once when the stream ends (only for snapshots or on fatal error).

### Log entry payload

`entry` uses the existing `LogJsonEntry` fields (from `src/ui/log-json.ts`).

```
{
  "source": "compose" | "loki",
  "message": "...",
  "raw": "...",
  "stream": "stdout" | "stderr",
  "project": "my-app",
  "service": "api",
  "instance": "1",
  "labels": { "service": "api" },
  "timestamp": "2025-01-01T00:00:00.000Z",
  "timestamp_ns": "1735689600000000000",
  "level": "debug" | "info" | "warn" | "error",
  "fields": { "requestId": "..." }
}
```

Rules:

- `message` is the parsed message if JSON was detected; otherwise the raw line.
- `raw` always contains the original line.
- `timestamp` uses ISO-8601 when available; `timestamp_ns` is Loki nanoseconds if present.
- Unknown fields should be ignored by consumers.

## Examples

Start + log + end (snapshot):

```
{"type":"start","ts":"2025-01-01T00:00:00.000Z","project":"my-app","backend":"compose","follow":false}
{"type":"log","ts":"2025-01-01T00:00:01.000Z","project":"my-app","backend":"compose","entry":{"source":"compose","message":"Server started","raw":"api-1 | Server started","service":"api","instance":"1","timestamp":"2025-01-01T00:00:01.000Z"}}
{"type":"end","ts":"2025-01-01T00:00:02.000Z","project":"my-app","backend":"compose","reason":"eof"}
```

Streaming with heartbeat:

```
{"type":"start","ts":"2025-01-01T00:00:00.000Z","project":"my-app","backend":"loki","follow":true}
{"type":"heartbeat","ts":"2025-01-01T00:00:10.000Z","project":"my-app","backend":"loki"}
{"type":"log","ts":"2025-01-01T00:00:11.000Z","project":"my-app","backend":"loki","entry":{"source":"loki","message":"GET /health","raw":"GET /health","service":"www","timestamp_ns":"1735689611000000000"}}
```

## Backend behavior

Compose:

- Uses `docker compose logs` under the hood.
- `stream` is derived from stdout/stderr when available.
- Timestamps are parsed from the line prefix if present.

Loki:

- Uses LogQL selectors and timestamps from Loki.
- `labels` contains the Loki label set for each line.

## MCP / TUI notes

- MCP server can stream NDJSON to clients or proxy as SSE/WebSocket.
- TUI can read the same NDJSON stream and update UI on `log` events.
- Use the `start` event to display the resolved project, backend, and filters.

## Phased delivery

1. **v0**: implement `type: log` events for `--json --follow` (streaming).
2. **v1**: add `start`/`end` events and optional `--heartbeat`.
3. **v2**: add `error` events and backend metadata.

## Open questions

- Should `--json` always include event envelopes, or should this require a `--stream` flag?
- Should we add `hack global logs --json` for global infra streaming?
- Is an explicit schema file needed (`hack.logs.schema.json`)?
