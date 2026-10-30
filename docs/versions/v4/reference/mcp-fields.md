# MCP fields and results

Exact tool inputs for v4.2.4. Start with [Agent integrations](../../integrations.md) for setup. These are MCP JSON input names, not CLI flag spellings.

Registration does not establish backend compatibility. A successful command result is not application health or readiness.

## Input rules

Schema-optional selectors can still have conditional requirements. `hack.project.init` requires `path` or `repoRoot`. Do not provide conflicting selectors. `service` and `services`, `compose` and `loki`, profiles and runtime selection interact through the command handler. The schema does not promise every combination succeeds.

Run timeout defaults to 120000 ms. Init uses a 180000 ms child timeout and exposes no timeout input. Log tail collection defaults to 200 events and 5000 ms. These are handler fallbacks, not schema defaults. An omitted log `tail` can be forwarded to the CLI, which has its own default.

Numeric input declarations use `z.number()` in this version. Do not assume the later positive-integer ceilings or typed pre-spawn errors from v5.

## `hack.projects.list`

[source](https://github.com/hack-dance/hack/blob/91b14bf0abb17602142425de0d02628a3e8a2615/src/mcp/server.ts#L161)

| Input | Presence | Type / validation | Meaning |
| --- | --- | --- | --- |
| `filter` | Optional | `string` | Filter by project name |
| `includeGlobal` | Optional | `boolean` | Include global infra projects |
| `includeUnregistered` | Optional | `boolean` | Include unregistered compose projects |


## `hack.project.status`

[source](https://github.com/hack-dance/hack/blob/91b14bf0abb17602142425de0d02628a3e8a2615/src/mcp/server.ts#L204)

| Input | Presence | Type / validation | Meaning |
| --- | --- | --- | --- |
| `projectName` | Optional | `string` | Registered project name (from ~/.hack/projects.json) |
| `repoRoot` | Optional | `string` | Repo root path (absolute or relative) |
| `path` | Optional | `string` | Path inside a repo (absolute or relative) |
| `branch` | Optional | `string` | Branch/worktree name |
| `profiles` | Optional | `string[]` | Compose profile names |


## `hack.project.up`

[source](https://github.com/hack-dance/hack/blob/91b14bf0abb17602142425de0d02628a3e8a2615/src/mcp/server.ts#L245)

| Input | Presence | Type / validation | Meaning |
| --- | --- | --- | --- |
| `projectName` | Optional | `string` | Registered project name (from ~/.hack/projects.json) |
| `repoRoot` | Optional | `string` | Repo root path (absolute or relative) |
| `path` | Optional | `string` | Path inside a repo (absolute or relative) |
| `branch` | Optional | `string` | Branch/worktree name |
| `profiles` | Optional | `string[]` | Compose profile names |


## `hack.project.down`

[source](https://github.com/hack-dance/hack/blob/91b14bf0abb17602142425de0d02628a3e8a2615/src/mcp/server.ts#L283)

| Input | Presence | Type / validation | Meaning |
| --- | --- | --- | --- |
| `projectName` | Optional | `string` | Registered project name (from ~/.hack/projects.json) |
| `repoRoot` | Optional | `string` | Repo root path (absolute or relative) |
| `path` | Optional | `string` | Path inside a repo (absolute or relative) |
| `branch` | Optional | `string` | Branch/worktree name |
| `profiles` | Optional | `string[]` | Compose profile names |


## `hack.project.restart`

[source](https://github.com/hack-dance/hack/blob/91b14bf0abb17602142425de0d02628a3e8a2615/src/mcp/server.ts#L320)

| Input | Presence | Type / validation | Meaning |
| --- | --- | --- | --- |
| `projectName` | Optional | `string` | Registered project name (from ~/.hack/projects.json) |
| `repoRoot` | Optional | `string` | Repo root path (absolute or relative) |
| `path` | Optional | `string` | Path inside a repo (absolute or relative) |
| `branch` | Optional | `string` | Branch/worktree name |
| `profiles` | Optional | `string[]` | Compose profile names |


## `hack.project.run`

[source](https://github.com/hack-dance/hack/blob/91b14bf0abb17602142425de0d02628a3e8a2615/src/mcp/server.ts#L357)

| Input | Presence | Type / validation | Meaning |
| --- | --- | --- | --- |
| `projectName` | Optional | `string` | Registered project name (from ~/.hack/projects.json) |
| `repoRoot` | Optional | `string` | Repo root path (absolute or relative) |
| `path` | Optional | `string` | Path inside a repo (absolute or relative) |
| `branch` | Optional | `string` | Branch/worktree name |
| `profiles` | Optional | `string[]` | Compose profile names |
| `service` | Required | `string` | Compose service name |
| `cmd` | Optional | `string[]` | Command arguments |
| `workdir` | Optional | `string` | Working directory inside container |
| `timeoutMs` | Optional | `number` | Command timeout in ms |


## `hack.project.logs.snapshot`

[source](https://github.com/hack-dance/hack/blob/91b14bf0abb17602142425de0d02628a3e8a2615/src/mcp/server.ts#L405)

| Input | Presence | Type / validation | Meaning |
| --- | --- | --- | --- |
| `projectName` | Optional | `string` | Registered project name (from ~/.hack/projects.json) |
| `repoRoot` | Optional | `string` | Repo root path (absolute or relative) |
| `path` | Optional | `string` | Path inside a repo (absolute or relative) |
| `branch` | Optional | `string` | Branch/worktree name |
| `profiles` | Optional | `string[]` | Compose profile names |
| `service` | Optional | `string` | Single service name |
| `services` | Optional | `string` | Multiple service names |
| `query` | Optional | `string` | Raw LogQL selector/query |
| `loki` | Optional | `boolean` | Force Loki backend |
| `compose` | Optional | `boolean` | Force docker compose backend |
| `tail` | Optional | `number` | Tail last N log lines |
| `since` | Optional | `string` | Start time (RFC3339 or duration) |
| `until` | Optional | `string` | End time (RFC3339 or duration) |


Tool-specific emitted data fields:

| Field | Type | Presence |
| --- | --- | --- |
| `data.events` | `LogStreamEvent[]` | Present in source shape |
| `data.count` | `number` | Present in source shape |


## `hack.project.logs.tail`

[source](https://github.com/hack-dance/hack/blob/91b14bf0abb17602142425de0d02628a3e8a2615/src/mcp/server.ts#L477)

| Input | Presence | Type / validation | Meaning |
| --- | --- | --- | --- |
| `projectName` | Optional | `string` | Registered project name (from ~/.hack/projects.json) |
| `repoRoot` | Optional | `string` | Repo root path (absolute or relative) |
| `path` | Optional | `string` | Path inside a repo (absolute or relative) |
| `branch` | Optional | `string` | Branch/worktree name |
| `profiles` | Optional | `string[]` | Compose profile names |
| `service` | Optional | `string` | Single service name |
| `services` | Optional | `string` | Multiple service names |
| `query` | Optional | `string` | Raw LogQL selector/query |
| `loki` | Optional | `boolean` | Force Loki backend |
| `compose` | Optional | `boolean` | Force docker compose backend |
| `tail` | Optional | `number` | Tail last N log lines |
| `since` | Optional | `string` | Start time (RFC3339 or duration) |
| `until` | Optional | `string` | End time (RFC3339 or duration) |
| `maxEvents` | Optional | `number` | Max events to collect |
| `maxMs` | Optional | `number` | Max duration in ms |


Tool-specific emitted data fields:

| Field | Type | Presence |
| --- | --- | --- |
| `data.events` | `LogStreamEvent[]` | Present in source shape |
| `data.count` | `number` | Present in source shape |
| `data.stop_reason` | `string (collector stop reason)` | Present in source shape |
| `data.duration_ms` | `number` | Present in source shape |


## `hack.project.open`

[source](https://github.com/hack-dance/hack/blob/91b14bf0abb17602142425de0d02628a3e8a2615/src/mcp/server.ts#L559)

| Input | Presence | Type / validation | Meaning |
| --- | --- | --- | --- |
| `projectName` | Optional | `string` | Registered project name (from ~/.hack/projects.json) |
| `repoRoot` | Optional | `string` | Repo root path (absolute or relative) |
| `path` | Optional | `string` | Path inside a repo (absolute or relative) |
| `branch` | Optional | `string` | Branch/worktree name |
| `target` | Optional | `string` | Target host/subdomain or URL |


## `hack.project.init`

[source](https://github.com/hack-dance/hack/blob/91b14bf0abb17602142425de0d02628a3e8a2615/src/mcp/server.ts#L600)

| Input | Presence | Type / validation | Meaning |
| --- | --- | --- | --- |
| `projectName` | Optional | `string` | Registered project name (from ~/.hack/projects.json) |
| `repoRoot` | Optional | `string` | Repo root path (absolute or relative) |
| `path` | Optional | `string` | Path inside a repo (absolute or relative) |
| `name` | Optional | `string` | Project slug |
| `devHost` | Optional | `string` | DEV_HOST override |
| `oauth` | Optional | `boolean` | Enable OAuth alias host |
| `oauthTld` | Optional | `string` | OAuth alias TLD |
| `manual` | Optional | `boolean` | Skip discovery and generate a minimal compose |
| `noDiscovery` | Optional | `boolean` | Skip discovery even if available |


## Prompt arguments

`hack-init` is a prompt, separate from `hack.project.init`. Mode defaults to existing-project. Prompt hints do not become init tool inputs.

| Argument | Presence | Declaration |
| --- | --- | --- |
| `arguments.mode` | Optional | `string` |
| `arguments.projectName` | Optional | `string` |
| `arguments.devHost` | Optional | `string` |


## Common result

The emitted MCP transport subset is `content[]` with `type`/`text`, `structuredContent`, and `isError` on failure. The table describes the common structured payload, not every SDK extension. Optional `data` is declared unknown; it is not a machine-validated closed nested schema.

| Field | Type | Presence |
| --- | --- | --- |
| `structuredContent.ok` | `boolean` | Required |
| `structuredContent.command` | `string` | Required |
| `structuredContent.exitCode` | `number` | Required |
| `structuredContent.stdout` | `string` | Required |
| `structuredContent.stderr` | `string` | Required |
| `structuredContent.data` | `unknown` | Optional |


Up/down/restart/init do not return a typed data status or readiness object. Open returns `data.url` without launching a browser. Status forwards the selected command JSON; a Compose result has project/branch/composeProject/items, and engine-specific item fields are open. Projects list forwards public CLI inventory JSON; consumers must tolerate version/runtime-specific metadata.

Run has no data object. Snapshot returns events/count. Tail adds stop_reason/duration_ms. Its maxEvents limit counts collected parsed events, unlike v5's type:log-only counter. Refusals use the common failure payload/stderr; this version does not promise v5's typed error object.

## Log event fields

These are source types, not a closed validator for every parsed JSON line. Event type is start/log/heartbeat/error/end. Labels and fields are application-owned string maps. Do not enumerate application log keys as Hack API fields.

| Field | Type | Presence |
| --- | --- | --- |
| `data.events[].type` | `LogStreamEventType` | Required in declared source type |
| `data.events[].ts` | `string` | Required in declared source type |
| `data.events[].project` | `string` | Optional |
| `data.events[].backend` | `LogStreamBackend` | Optional |
| `data.events[].branch` | `string` | Optional |
| `data.events[].services` | `readonly string[]` | Optional |
| `data.events[].follow` | `boolean` | Optional |
| `data.events[].since` | `string` | Optional |
| `data.events[].until` | `string` | Optional |
| `data.events[].entry` | `LogJsonEntry` | Optional |
| `data.events[].message` | `string` | Optional |
| `data.events[].reason` | `string` | Optional |
| `data.events[].entry.source` | `"compose" \\| "loki"` | Required in declared source type |
| `data.events[].entry.message` | `string` | Required in declared source type |
| `data.events[].entry.raw` | `string` | Required in declared source type |
| `data.events[].entry.stream` | `"stdout" \\| "stderr"` | Optional |
| `data.events[].entry.project` | `string` | Optional |
| `data.events[].entry.service` | `string` | Optional |
| `data.events[].entry.instance` | `string` | Optional |
| `data.events[].entry.labels` | `Record<string, string>` | Optional |
| `data.events[].entry.timestamp` | `string` | Optional |
| `data.events[].entry.timestamp_ns` | `string` | Optional |
| `data.events[].entry.level` | `LogLevel` | Optional |
| `data.events[].entry.fields` | `Record<string, string>` | Optional |


## Contract boundaries

Nested engine/project/diagnostic variants and arbitrary application data remain open. Inspect the pinned public command source when handling a new variant; do not depend on private daemon/guest/compiler protocols. This field reference is source-reviewed and does not claim client-loading or cloud execution qualification.
