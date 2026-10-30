# MCP fields and results

Exact tool inputs for v5 (next.5). Start with [Agent integrations](../../integrations.md) for setup. These are MCP JSON input names, not CLI flag spellings.

Registration does not establish backend compatibility. In particular, the native candidate has a narrower admission contract; a retained Compose tool is not an alternative native lifecycle API. A successful command result is not application health or readiness.

## Input rules

Schema-optional selectors can still have conditional requirements. `hack.project.init` requires `path` or `repoRoot`. Do not provide conflicting selectors. `service` and `services`, `compose` and `loki`, profiles and runtime selection interact through the command handler. The schema does not promise every combination succeeds.

Run timeout defaults to 120000 ms. Init uses a 180000 ms child timeout and exposes no timeout input. Log tail collection defaults to 200 events and 5000 ms. These are handler fallbacks, not schema defaults. An omitted log `tail` can be forwarded to the CLI, which has its own default.

`hack.project.exec` requires a nonempty `cmd` array (at least one entry); run allows cmd to be omitted. Exec also defaults to 120000 ms. Positive-integer limits are tail/maxEvents ≤10000, maxMs ≤60000, timeoutMs ≤600000. Identifier helpers impose a 253-character maximum and distinct service/profile, branch and env-key patterns. The MCP env-key grammar is broader than CLI uppercase keys; later CLI refusal is possible. See [MCP tools](../../reference/mcp-tools.md) for exact validation and typed pre-spawn failures.

## `hack.projects.list`

[source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/mcp/server.ts#L535)

| Input | Presence | Type / validation | Meaning |
| --- | --- | --- | --- |
| `filter` | Optional | `string` | Filter by project name |
| `includeGlobal` | Optional | `boolean` | Include global infra projects |
| `includeUnregistered` | Optional | `boolean` | Include unregistered compose projects |


## `hack.project.status`

[source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/mcp/server.ts#L577)

| Input | Presence | Type / validation | Meaning |
| --- | --- | --- | --- |
| `projectName` | Optional | `string` | Registered project name (from ~/.hack/projects.json) |
| `repoRoot` | Optional | `string` | Repo root path (absolute or relative) |
| `path` | Optional | `string` | Path inside a repo (absolute or relative) |
| `branch` | Optional | `string; identifier rules` | See identifier and input rules. |
| `profiles` | Optional | `string; identifier rules` | Compose profile names |


## `hack.project.up`

[source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/mcp/server.ts#L619)

| Input | Presence | Type / validation | Meaning |
| --- | --- | --- | --- |
| `projectName` | Optional | `string` | Registered project name (from ~/.hack/projects.json) |
| `repoRoot` | Optional | `string` | Repo root path (absolute or relative) |
| `path` | Optional | `string` | Path inside a repo (absolute or relative) |
| `branch` | Optional | `string; identifier rules` | See identifier and input rules. |
| `profiles` | Optional | `string; identifier rules` | Compose profile names |


## `hack.project.down`

[source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/mcp/server.ts#L658)

| Input | Presence | Type / validation | Meaning |
| --- | --- | --- | --- |
| `projectName` | Optional | `string` | Registered project name (from ~/.hack/projects.json) |
| `repoRoot` | Optional | `string` | Repo root path (absolute or relative) |
| `path` | Optional | `string` | Path inside a repo (absolute or relative) |
| `branch` | Optional | `string; identifier rules` | See identifier and input rules. |
| `profiles` | Optional | `string; identifier rules` | Compose profile names |


## `hack.project.restart`

[source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/mcp/server.ts#L696)

| Input | Presence | Type / validation | Meaning |
| --- | --- | --- | --- |
| `projectName` | Optional | `string` | Registered project name (from ~/.hack/projects.json) |
| `repoRoot` | Optional | `string` | Repo root path (absolute or relative) |
| `path` | Optional | `string` | Path inside a repo (absolute or relative) |
| `branch` | Optional | `string; identifier rules` | See identifier and input rules. |
| `profiles` | Optional | `string; identifier rules` | Compose profile names |


## `hack.project.run`

[source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/mcp/server.ts#L734)

| Input | Presence | Type / validation | Meaning |
| --- | --- | --- | --- |
| `projectName` | Optional | `string` | Registered project name (from ~/.hack/projects.json) |
| `repoRoot` | Optional | `string` | Repo root path (absolute or relative) |
| `path` | Optional | `string` | Path inside a repo (absolute or relative) |
| `branch` | Optional | `string; identifier rules` | See identifier and input rules. |
| `profiles` | Optional | `string; identifier rules` | Compose profile names |
| `service` | Required | `string; identifier rules` | See identifier and input rules. |
| `cmd` | Optional | `string[]` | Command arguments |
| `workdir` | Optional | `string` | Working directory inside container |
| `timeoutMs` | Optional | `positive integer; ceiling in input rules` | See identifier and input rules. |


Tool-specific emitted data fields:

| Field | Type | Presence |
| --- | --- | --- |
| `data.limits` | `object` | Present in source shape |
| `data.limits.timeoutMs` | `number` | Present in source shape |


## `hack.project.logs.snapshot`

[source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/mcp/server.ts#L785)

| Input | Presence | Type / validation | Meaning |
| --- | --- | --- | --- |
| `projectName` | Optional | `string` | Registered project name (from ~/.hack/projects.json) |
| `repoRoot` | Optional | `string` | Repo root path (absolute or relative) |
| `path` | Optional | `string` | Path inside a repo (absolute or relative) |
| `branch` | Optional | `string; identifier rules` | See identifier and input rules. |
| `profiles` | Optional | `string; identifier rules` | Compose profile names |
| `service` | Optional | `string; identifier rules` | See identifier and input rules. |
| `services` | Optional | `string; identifier rules` | Multiple service names |
| `query` | Optional | `string` | Raw LogQL selector/query |
| `loki` | Optional | `boolean` | Force Loki backend |
| `compose` | Optional | `boolean` | Force docker compose backend |
| `tail` | Optional | `positive integer; ceiling in input rules` | See identifier and input rules. |
| `since` | Optional | `string` | Start time (RFC3339 or duration) |
| `until` | Optional | `string` | End time (RFC3339 or duration) |


Tool-specific emitted data fields:

| Field | Type | Presence |
| --- | --- | --- |
| `data.events` | `LogStreamEvent[]` | Present in source shape |
| `data.count` | `number` | Present in source shape |
| `data.cutoff` | `null or {bound, limit}` | Present in source shape |
| `data.limits` | `object` | Present in source shape |
| `data.limits.tail` | `number or null` | Present in source shape |


## `hack.project.logs.tail`

[source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/mcp/server.ts#L836)

| Input | Presence | Type / validation | Meaning |
| --- | --- | --- | --- |
| `projectName` | Optional | `string` | Registered project name (from ~/.hack/projects.json) |
| `repoRoot` | Optional | `string` | Repo root path (absolute or relative) |
| `path` | Optional | `string` | Path inside a repo (absolute or relative) |
| `branch` | Optional | `string; identifier rules` | See identifier and input rules. |
| `profiles` | Optional | `string; identifier rules` | Compose profile names |
| `service` | Optional | `string; identifier rules` | See identifier and input rules. |
| `services` | Optional | `string; identifier rules` | Multiple service names |
| `query` | Optional | `string` | Raw LogQL selector/query |
| `loki` | Optional | `boolean` | Force Loki backend |
| `compose` | Optional | `boolean` | Force docker compose backend |
| `tail` | Optional | `positive integer; ceiling in input rules` | See identifier and input rules. |
| `since` | Optional | `string` | Start time (RFC3339 or duration) |
| `until` | Optional | `string` | End time (RFC3339 or duration) |
| `maxEvents` | Optional | `positive integer; ceiling in input rules` | See identifier and input rules. |
| `maxMs` | Optional | `positive integer; ceiling in input rules` | See identifier and input rules. |


Tool-specific emitted data fields:

| Field | Type | Presence |
| --- | --- | --- |
| `data.events` | `LogStreamEvent[]` | Present in source shape |
| `data.count` | `number` | Present in source shape |
| `data.cutoff` | `null or {bound, limit}` | Present in source shape |
| `data.stop_reason` | `string (collector stop reason)` | Present in source shape |
| `data.duration_ms` | `number` | Present in source shape |
| `data.limits` | `object` | Present in source shape |
| `data.limits.tail` | `number or null` | Present in source shape |
| `data.limits.maxEvents` | `number` | Present in source shape |
| `data.limits.maxMs` | `number` | Present in source shape |


## `hack.project.open`

[source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/mcp/server.ts#L900)

| Input | Presence | Type / validation | Meaning |
| --- | --- | --- | --- |
| `projectName` | Optional | `string` | Registered project name (from ~/.hack/projects.json) |
| `repoRoot` | Optional | `string` | Repo root path (absolute or relative) |
| `path` | Optional | `string` | Path inside a repo (absolute or relative) |
| `branch` | Optional | `string; identifier rules` | See identifier and input rules. |
| `target` | Optional | `string; identifier rules` | See identifier and input rules. |


## `hack.project.init`

[source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/mcp/server.ts#L942)

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


## `hack.project.exec`

[source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/mcp/server.ts#L1002)

| Input | Presence | Type / validation | Meaning |
| --- | --- | --- | --- |
| `projectName` | Optional | `string` | Registered project name (from ~/.hack/projects.json) |
| `repoRoot` | Optional | `string` | Repo root path (absolute or relative) |
| `path` | Optional | `string` | Path inside a repo (absolute or relative) |
| `branch` | Optional | `string; identifier rules` | See identifier and input rules. |
| `profiles` | Optional | `string; identifier rules` | Compose profile names |
| `service` | Required | `string; identifier rules` | See identifier and input rules. |
| `cmd` | Required | `string` | Command and arguments (at least one entry) |
| `workdir` | Optional | `string` | Working directory inside container |
| `timeoutMs` | Optional | `positive integer; ceiling in input rules` | See identifier and input rules. |


Tool-specific emitted data fields:

| Field | Type | Presence |
| --- | --- | --- |
| `data.limits` | `object` | Present in source shape |
| `data.limits.timeoutMs` | `number` | Present in source shape |
| `data.limits.outputBytes` | `number` | Present in source shape |


## `hack.project.doctor`

[source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/mcp/server.ts#L1061)

| Input | Presence | Type / validation | Meaning |
| --- | --- | --- | --- |
| `projectName` | Optional | `string` | Registered project name (from ~/.hack/projects.json) |
| `repoRoot` | Optional | `string` | Repo root path (absolute or relative) |
| `path` | Optional | `string` | Path inside a repo (absolute or relative) |
| `branch` | Optional | `string; identifier rules` | See identifier and input rules. |


## `hack.project.env.explain`

[source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/mcp/server.ts#L1096)

| Input | Presence | Type / validation | Meaning |
| --- | --- | --- | --- |
| `projectName` | Optional | `string` | Registered project name (from ~/.hack/projects.json) |
| `repoRoot` | Optional | `string` | Repo root path (absolute or relative) |
| `path` | Optional | `string` | Path inside a repo (absolute or relative) |
| `env` | Optional | `string; identifier rules` | See identifier and input rules. |
| `service` | Optional | `string; identifier rules` | See identifier and input rules. |
| `key` | Required | `string; env-key rules` | See identifier and input rules. |
| `target` | Optional | `"host" or "compose"` | Env view: host (default) or compose |


## `hack.project.env.keys`

[source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/mcp/server.ts#L1141)

| Input | Presence | Type / validation | Meaning |
| --- | --- | --- | --- |
| `projectName` | Optional | `string` | Registered project name (from ~/.hack/projects.json) |
| `repoRoot` | Optional | `string` | Repo root path (absolute or relative) |
| `path` | Optional | `string` | Path inside a repo (absolute or relative) |
| `env` | Optional | `string; identifier rules` | See identifier and input rules. |
| `service` | Optional | `string; identifier rules` | See identifier and input rules. |


## `hack.project.instances`

[source](https://github.com/hack-dance/hack/blob/28de2f8902d3776c3da9326e7ae6c6aa6e7f69bc/src/mcp/server.ts#L1179)

| Input | Presence | Type / validation | Meaning |
| --- | --- | --- | --- |
| `projectName` | Optional | `string` | Registered project name (from ~/.hack/projects.json) |
| `repoRoot` | Optional | `string` | Repo root path (absolute or relative) |
| `path` | Optional | `string` | Path inside a repo (absolute or relative) |


## Prompt arguments

`hack-init` is a prompt, separate from `hack.project.init`. Mode defaults to existing-project. Prompt hints do not become init tool inputs.

A supplied `repoRoot` triggers inventory and replaces the mode/projectName/devHost hints.

| Argument | Presence | Declaration |
| --- | --- | --- |
| `arguments.repoRoot` | Optional | `string` |
| `arguments.mode` | Optional | `string` |
| `arguments.projectName` | Optional | `string` |
| `arguments.devHost` | Optional | `string` |


## Common result

The emitted MCP transport subset is `content[]` with `type`/`text`, `structuredContent`, and `isError` on failure. The table describes the common structured payload, not every SDK extension. When present, the error object contains required string code/reason/message fields. Optional `data` is declared unknown; it is not a machine-validated closed nested schema.

| Field | Type | Presence |
| --- | --- | --- |
| `structuredContent.ok` | `boolean` | Required |
| `structuredContent.outputTruncated` | `boolean` | Optional |
| `structuredContent.command` | `string` | Required |
| `structuredContent.exitCode` | `number` | Required |
| `structuredContent.stdout` | `string` | Required |
| `structuredContent.stderr` | `string` | Required |
| `structuredContent.data` | `unknown` | Optional |
| `structuredContent.spawned` | `literal false` | Optional |
| `structuredContent.error` | `object` | Optional |


Up/down/restart/init do not return a typed data status or readiness object. Open returns `data.url` without launching a browser. Status forwards the selected command JSON; a Compose result has project/branch/composeProject/items, and engine-specific item fields are open. Projects list forwards public CLI inventory JSON; consumers must tolerate version/runtime-specific metadata.

Run returns `data.limits.timeoutMs`; exec additionally reports an 8 MiB shared capture budget through `outputBytes`. Snapshot adds events/count/cutoff/limits.tail. Tail adds stop_reason/duration_ms and limits.maxEvents/maxMs. Omitted tail is echoed as null, not the child CLI default. Cutoff is null or `{bound,limit}` with bound events/bytes/time. A deliberate collection cutoff is distinct from backend failure. Tail counts only type:log events against maxEvents; start/heartbeat/error/end do not spend that counter.

### `McpEnvExplainData`

| Field | Type | Presence |
| --- | --- | --- |
| `key` | `string \\| null` | Required; null only if the type includes null |
| `available` | `boolean \\| null` | Required; null only if the type includes null |
| `secret` | `boolean \\| null` | Required; null only if the type includes null |
| `format` | `string \\| null` | Required; null only if the type includes null |
| `environment` | `string \\| null` | Required; null only if the type includes null |
| `requested_scope` | `string \\| null` | Required; null only if the type includes null |
| `effective_scope` | `string \\| null` | Required; null only if the type includes null |
| `target` | `string \\| null` | Required; null only if the type includes null |
| `delivered_to` | `readonly string[] \\| null` | Required; null only if the type includes null |
| `source` | `string \\| null` | Required; null only if the type includes null |
| `precedence` | `readonly string[] \\| null` | Required; null only if the type includes null |


### `McpEnvKeyEntry`

| Field | Type | Presence |
| --- | --- | --- |
| `key` | `string` | Required; null only if the type includes null |
| `secret` | `boolean` | Required; null only if the type includes null |
| `required` | `boolean \\| null` | Required; null only if the type includes null |
| `source` | `string \\| null` | Required; null only if the type includes null |
| `resolved_from` | `string \\| null` | Required; null only if the type includes null |
| `services` | `readonly string[] \\| null` | Required; null only if the type includes null |


### `McpEnvKeysData`

| Field | Type | Presence |
| --- | --- | --- |
| `format` | `string \\| null` | Required; null only if the type includes null |
| `environment` | `string \\| null` | Required; null only if the type includes null |
| `selected_scope` | `string \\| null` | Required; null only if the type includes null |
| `scopes` | `readonly string[] \\| null` | Required; null only if the type includes null |
| `keys` | `readonly McpEnvKeyEntry[]` | Required; null only if the type includes null |
| `missing_required` | `readonly string[]` | Required; null only if the type includes null |


### `McpInstanceService`

| Field | Type | Presence |
| --- | --- | --- |
| `service` | `string` | Required; null only if the type includes null |
| `containers` | `number` | Required; null only if the type includes null |
| `running` | `number` | Required; null only if the type includes null |


### `McpProjectInstance`

| Field | Type | Presence |
| --- | --- | --- |
| `branch` | `string \\| null` | Required; null only if the type includes null |
| `compose_project` | `string \\| null` | Required; null only if the type includes null |
| `working_dir` | `string \\| null` | Required; null only if the type includes null |
| `services` | `readonly McpInstanceService[]` | Required; null only if the type includes null |


### `McpInstancesData`

| Field | Type | Presence |
| --- | --- | --- |
| `project` | `string` | Required; null only if the type includes null |
| `found` | `boolean` | Required; null only if the type includes null |
| `runtime_ok` | `boolean \\| null` | Required; null only if the type includes null |
| `instances` | `readonly McpProjectInstance[]` | Required; null only if the type includes null |


The env projections withhold values, ciphertext and raw backend output. Projection null is different from a missing key. Instances describe discovered containers, not all configured branches. Doctor can return a nested CLI report under `data.data`; specialized engine and diagnostic subobjects remain open and are not exhaustively typed here.

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
