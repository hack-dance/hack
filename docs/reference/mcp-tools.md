# MCP tool contract

`hack mcp serve` exposes the tools below to MCP clients that have no shell. Each
tool runs one `hack` CLI command as a child process, with the session's captured
working directory and environment, and `HACK_NO_INTERACTIVE=1`. When a shell is
available, run the CLI command directly instead.

This page is the contract for tool names, annotations, inputs, the argv each tool
runs, and result shapes. The log tools have their own page:
[MCP logs contract](./mcp-logs.md).

## Tools

The annotation class is published in `tools/list`:

- `read-only`: `readOnlyHint: true`. The tool only inspects state.
- `additive`: `readOnlyHint: false`, `destructiveHint: false`. The tool starts
  or restarts local runtime state but does not remove it.
- `destructive`: `readOnlyHint: false`, `destructiveHint: true`. The tool can
  stop, replace or overwrite local state, or run an arbitrary command.

Every tool sets `openWorldHint: false`. Mutating tools set `idempotentHint: false`.

| Tool | Class | CLI command |
| --- | --- | --- |
| `hack.projects.list` | read-only | `hack projects --json` |
| `hack.project.status` | read-only | `hack ps --json` |
| `hack.project.up` | additive | `hack up --detach` |
| `hack.project.down` | destructive | `hack down` |
| `hack.project.restart` | additive | `hack restart` |
| `hack.project.run` | destructive | `hack run -- <service> [cmd...]` |
| `hack.project.logs.snapshot` | read-only | `hack logs --json --no-follow` |
| `hack.project.logs.tail` | read-only | `hack logs --json` |
| `hack.project.open` | read-only | `hack open --json` (never launches a browser) |
| `hack.project.init` | destructive | `hack init --auto` |
| `hack.project.exec` | destructive | `hack exec -- <service> <cmd...>` |
| `hack.project.doctor` | read-only | `hack doctor --json` |
| `hack.project.env.explain` | read-only | `hack env explain --json -- <key>` |
| `hack.project.env.keys` | read-only | `hack env list --json` |
| `hack.project.instances` | read-only | `hack projects --json --project=<name>` |
| `hack.project.target` | read-only | `hack project target --json` (provisional) |
| `hack.project.task.list` | read-only | `hack project task list --json` (provisional; runs nothing) |
| `hack.project.task.inspect` | read-only | `hack project task inspect --json -- <task>` (provisional; runs nothing) |
| `hack.project.command.start` | destructive | `hack exec\|run --detach --json --request-key=… -- <service> [cmd...]` |
| `hack.project.command.read` | read-only | `hack commands read --json -- <commandId>` |
| `hack.project.command.inspect` | read-only | `hack commands show --json -- <commandId>` |
| `hack.project.command.cancel` | destructive | `hack commands cancel --json -- <commandId>` |

## Project selection

Project-scoped tools accept at most one of `projectName`, `repoRoot` or `path`.
With none, the session's working directory selects the project.

- `projectName` must name a registered project (`~/.hack/projects.json`).
- `repoRoot` and `path` must exist and lie inside a registered project's repo
  root or project directory.
- With no selection, the working directory must contain a hack project or lie
  inside a registered one.

`hack.project.doctor` passes a named project to the CLI as `--path=<repo root>`,
because `hack doctor` has no `--project` option.

`hack.project.instances` needs a registered project name, because
`hack projects` selects by name only. A path, or the working directory when
nothing is selected, maps to the registered project whose repo root or project
directory contains it. When registrations are nested, the deepest one wins. Two
different registrations at the same root are refused as `ambiguous_project`. A
project that has a `.hack/` directory but no registration is refused; run
a registering command in it, for example `hack status`, `hack projects` or
`hack init` (`hack down`, `ps`, `run`, `exec`, `logs`, `open` and `commands`
do not register; `hack up` registers on the Compose backend only). A
`repoRoot` or `path` outside every registered project is refused as
`path_not_registered`. With no selection the server's working directory is
used, so check that it is the project you mean before a destructive call.

## Inputs and identifiers

Inputs are validated before any child process starts. Unknown input fields are
dropped, so they never reach the CLI argv.

- `service`, `services`, `profiles`, open `target`, and the env tools' `env` and
  `service` must match `^[A-Za-z0-9][A-Za-z0-9_.-]*$`.
- `branch` must match `^[A-Za-z0-9][A-Za-z0-9_./-]*$`.
- Env `key` must match `^[A-Za-z_][A-Za-z0-9_]*$`. Scoped `service.KEY` syntax is
  not accepted. Use the `service` input for the scope.
- Identifiers are at most 253 characters. None of these patterns can start with
  `-`, so no identifier can be read as an option.
- Numeric limits are positive integers. A value above the ceiling is refused,
  not clamped: `tail` and `maxEvents` up to 10,000, `maxMs` up to 60,000, and
  `timeoutMs` up to 600,000.

Option values are always fused (`--branch=<value>`). Positional values that come
from the caller follow `--`, so the CLI parser ends option parsing before them.

## Results

Every result has the same structured content:

| Field | Meaning |
| --- | --- |
| `ok` | The child exited 0 (for the log tools, see the logs contract) |
| `command` | The argv that ran, or `""` when refused before spawn |
| `exitCode` | The child's exit code (1 for a refusal) |
| `stdout`, `stderr` | Captured child output (withheld for the env tools; `stdout` withheld for instances) |
| `data` | Parsed or projected result, when the tool defines one |
| `outputTruncated` | `true` when output reached the 8 MiB capture limit, or this payload was cut to the result size limit |
| `spawned` | `false` only on a refusal: no child, no audit line |
| `error` | Closed refusal or backend error: `code`, `reason`, `message` |

When `ok` is `false`, the result also has `isError: true`. Output above the
8 MiB capture limit stops the command, and `data` is omitted so that a prefix is
never presented as a complete result. The log tools are the exception, as their
contract describes.

### Result size limit

Every tool's serialized result is limited to 9.5 MiB of UTF-8, measured after
JSON escaping. MCP SDK clients on stdio close the connection when a message passes
10 MiB. The rest of that margin covers the JSON-RPC envelope. The 8 MiB capture
limit cannot do this job, because it counts raw output, and a result repeats that
output and escapes it.

A result within the limit is unchanged. Above it, the server removes data in this
order:

1. `content` text. It becomes JSON of at most 256 KiB with the same shape as
   `structuredContent`, carrying less output and its own `outputTruncated: true`.
   If `structuredContent` now fits, it is complete and has no such flag.
2. For the log tools, `stdout`, then whole events from the end. See the
   [logs contract](mcp-logs.md). For other tools, `data`, then the end of `stdout`.
3. The end of `stderr`, past its first 16 KiB, which step 2 cannot take.

A payload that was cut has `outputTruncated: true`, and its `stderr` ends with a
fixed line saying to use the CLI for full output. For the log tools, that line
first suggests narrowing the request with `tail`, `since`, `until` or `service`.
A cut never splits a code point.
`ok` and `exitCode` still describe the command, so a command that succeeded stays
`ok` with `data` omitted. Run the equivalent CLI command when full output is needed.

### Refusals

A refusal happens before any child process exists. Its `error.reason` is one of
`invalid_arguments`, `conflicting_project_selection`, `invalid_project_name`,
`ambiguous_project`, `project_not_found`, `path_not_found`,
`path_not_registered`, `no_project_context` and `init_path_required`. The code is
`E_USAGE` or `E_PROJECT_NOT_FOUND`. The message is fixed text. It never repeats
caller input or registry values. For `invalid_arguments`, the message names the
rejected input fields, using only the tool's own schema keys.

## `hack.project.exec`

Runs a command in a service container that is already running (`docker compose
exec`). `hack.project.run` starts a new one-off container instead. Exec never
starts a container, and the CLI fails when the service is not running.

- Required: `service` and `cmd`, with at least one entry.
- Optional: project selection, `branch`, `profiles`, `workdir` and `timeoutMs`
  (default 120,000).
- Argv: `hack exec [--project=…|--path=…] [--branch=…] [--profile=…]
  [--workdir=…] -- <service> <cmd...>`. Entries in `cmd` such as `--help` or
  `--branch` reach the container command and are never parsed by hack.
- `data.limits` echoes `{ timeoutMs, outputBytes }`. `outputBytes` is the shared
  8 MiB capture limit.
- When `timeoutMs` runs out, the server stops the command's process group and
  the result has `timedOut: true`, a nonzero `exitCode` (usually 143) and a
  stderr line naming the limit. Exit 143 alone does not tell a timeout from a
  signal sent by something else. For anything that may run longer than a few
  minutes, use `hack.project.command.start` instead.

## Background commands

`hack.project.command.start`, `read`, `inspect` and `cancel` start `exec` or
`run` in the background and report on it by id and cursor. They are adapters
over the CLI described in [Background commands](../guides/background-commands.md),
so a command started through MCP can be read with `hack commands read` and the
other way round.

- `start`: required `operation` (`exec` or `run`), `service`, `cmd` (an array;
  `exec` needs at least one entry) and `requestKey`
  (`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$`). Optional: project selection,
  `branch`, `workdir`, `timeoutMs` (1,000 to 21,600,000; default 1,800,000),
  `stallAfterMs` (0 to 21,600,000; default 120,000; 0 turns it off) and
  `capture` (`full` or `metadata`). Validation, argv handling and refusals are
  those of `hack.project.exec` and `hack.project.run`. `data` is
  `{ commandId, cursor, state, expiresAt, reused, capture, liveOutput,
  stallDetection, limits }`. `expiresAt` is the planned expiry for a command that
  runs to its timeout (acceptance + `timeoutMs` + retention); one that ends
  earlier is kept for its retention time after its end. Storage limits can
  expire a result earlier. Retrying with the same `requestKey` and the same
  inputs returns the existing command (`reused: true`) while its result is kept;
  after the result expires the key is refused (`E_RESULT_EXPIRED`) for 7 days,
  then forgotten. The same key with different inputs is refused
  (`E_REQUEST_CONFLICT`). Keys are
  scoped to the project, whichever selector named it.
  The MCP session is the caller for the admission limit of 4 active commands.
- `read`: required `commandId`. Optional: project selection, `branch`, `after`
  (cursor; the first read passes the `cursor` from `start`, later reads each
  `nextCursor`), `waitMs` and `maxBytes` (16,384 to 262,144; default 32,768).
  `waitMs` defaults to 25,000 and is capped at 30,000 (a larger value is refused
  before any child starts), which keeps a call under the shortest known client
  tool-call limit. The call returns early when the command ends, a stall starts
  or the next event would pass `maxBytes`, 1,000 events or 4 × `maxBytes` of
  serialized events (`nextCursor` always advances). New output alone does not
  end the wait, so pass a smaller `waitMs` to see output sooner. A wait that
  elapses is not an error: it returns `timedOut: true` with `reason:
  "wait_elapsed"`. `data` is `{ state, events,
  nextCursor, gap, timedOut, ended, reason, outcome?, exitCode?, limits }`.
  Output events carry `text` (UTF-8) or `withheld`. An unknown or expired cursor
  gives `gap: true` and one `gap` event naming the earliest cursor.
- `inspect`: required `commandId`; `data` is the `hack commands show` result.
  Automatic env maps are omitted, but stored caller argv can contain sensitive
  expanded values and is not redacted, including with metadata-only capture.
- `cancel`: required `commandId`; `data` says what was confirmed. Stopping a
  `docker compose exec` or `run` client does not prove the process inside the
  container stopped (`containerProcess: "not_confirmed"`).
  `alreadyEnded: true` means the command had ended before the call; `outcome`
  is then its recorded outcome.

Every call re-checks project and instance scope: `commandId` must match
`^cmd_[a-z0-9]{26}$`, and an id from another project or instance fails with
`E_COMMAND_NOT_FOUND`. The id grants nothing. Errors reported by the CLI keep
their registered code (`E_COMMAND_NOT_FOUND`, `E_RESULT_EXPIRED`,
`E_CAPTURE_DISABLED`, `E_ADMISSION_LIMIT`, `E_REQUEST_CONFLICT`,
`E_JOURNAL_VERSION`, …) with `reason: "command_error"`. `start` and `cancel`
write an `mcp-audit.log` line; `read` and `inspect` do not. The `start` line
records the operation, service, `argv[0]`, the argument count and a SHA-256 of
the arguments, never the arguments themselves.

Differences from the foreground tools:

- **Capture limit.** Reaching 8 MiB stops capture and records
  `command.output_truncated`, but the command keeps running to its normal end.
  The foreground `hack.project.exec` and `hack.project.run` stop the command at
  8 MiB.
- **Storage.** Output is stored in private files under the Hack home, where
  later processes of the same OS user that can select the project can read it
  (`capture: "metadata"` stores none). It is not readable after its retention
  time (at most 24 hours after the command ends); the files are physically
  removed at the next background-command operation, `hack up` or `hack down`,
  so Hack does not promise physical deletion within 24 hours.
- **Redaction is partial.** Values Hack had already resolved to inject into the
  command are replaced with `*` before output is announced. Values Hack did not
  inject, or that the command transforms, are not caught. It is defence in
  depth, not a guarantee.

Client notes, from qualifying the tools with Claude Code and the Codex CLI:

- `start` and `cancel` are annotated destructive. A headless `codex exec` has
  no one to approve them and refuses each call ("MCP tool call requires
  approval"); give that run `-c
  'mcp_servers.<name>.default_tools_approval_mode="approve"'` (or answer the
  prompt in an interactive session). Claude Code in `-p` mode needs the tools
  allowed, for example `--allowedTools mcp__hack`.
- Observed in Claude Code 2.1.322: it loads the tools on demand through its
  tool search, and their names appear with dots replaced
  (`mcp__hack__hack_project_command_start`).
- Tool-call limits. Codex CLI 0.168.0 and Claude Code 2.1.322 applied no
  per-call limit by default: a foreground exec of 90 s completed in both, and
  one of 200 s (`timeoutMs: 600000`) in Codex. Codex stops waiting at
  `mcp_servers.<name>.tool_timeout_sec` when it is set (`timed out awaiting
  tools/call after 30s` at 30 s); it then cancels the call, and Hack stops the
  command's process group (exit 143 in `mcp-audit.log`). For a Compose command
  that stops the `docker compose` client; what runs in the container is not
  proven stopped. `hack setup mcp --codex` and `hack mcp install --codex`
  write `tool_timeout_sec = 660`, above the largest `timeoutMs` (600 s), so
  Hack's own limit ends a long call first and reports `timedOut: true`; a
  value already set is kept.

## `hack.project.doctor`

Runs read-only setup diagnostics: `hack doctor [--path=…] [--branch=…] --json`.
The argv set is closed. `--fix`, `--migrate-env-config`, `--domain-migration`,
`--native-cleanup`, `--native-run-mapping`, browser observations and legacy
rebind acceptance are never passed. The CLI also refuses `--json` together with
`--fix`.

`data` is the CLI's JSON result envelope, with `data.checks`, `data.summary` and
`data.counts`. When any check reports an error, the CLI exits 1, so `ok` is
`false` while `data` still carries the full report.

## `hack.project.env.explain`

Explains one env key without its value:
`hack env explain [--project=…|--path=…] [--env=…] [--service=…] [--target=…]
--json -- <key>`.

- Required: `key`. Optional: project selection, `env` (overlay; `base` or
  `default` selects base layers only), `service` (scope; default `global`) and
  `target` (`host` or `compose`).
- `data` is an allowlisted projection: `key`, `available`, `secret`, `format`,
  `environment`, `requested_scope`, `effective_scope`, `target`,
  `delivered_to`, `source` and `precedence`. Any other field in the CLI output is
  dropped.

## `hack.project.env.keys`

Lists env key names with metadata: `hack env list [--project=…|--path=…]
[--env=…] [--service=…] --json`. `--show-secrets` is never passed, and there is
no input for it.

`data` is `{ format, environment, selected_scope, scopes, keys,
missing_required }`. Each entry in `keys` is `{ key, secret, required, source,
resolved_from, services }`. `secret` is `true` when the CLI reports the key as
`keychain`-backed. Row values, materialized values, storage locations and
warning text are dropped. A row whose key does not match the env key pattern is
dropped whole.

### Value-free output

`hack env list --json` defaults to metadata without values. Both env tools also
enforce an independent value-free boundary and withhold the child's raw output,
including on errors:

- `stdout` is always `""`.
- `stderr` is `""` on success. On failure it is a fixed message that tells you
  to run the same `hack env` command in a terminal.
- `data` carries only the allowlisted fields above. It is `null` when the CLI
  printed no parseable JSON object.

`command` still shows the argv, which contains the key name but no values. The
MCP audit log records the same argv.

## `hack.project.instances`

Lists a registered project's runtime instances: `hack projects --json
--project=<name>`. It reads the project's `runtime` and `branch_runtime`
entries, so it lists only instances that currently have containers, running or
stopped. A configured branch that was never started is not listed.

`data` is `{ project, found, runtime_ok, instances }`. `instances` lists the
default instance first, when it has containers, as `branch: null`. Each branch
instance follows, in CLI order. Each instance is `{ branch, compose_project,
working_dir, services }`, and each service is `{ service, containers, running }`
with container counts. Both counts include lifecycle-process containers, which
the CLI adds to the service with the process name. `stdout` is always `""`: the raw listing can cover other
projects and carries container labels, mounts and networks, which `data` omits.
`stderr` is returned as captured. `found` is `false` when the project is
registered but the CLI listing does not include it.

## `hack.project.target`

Resolves the exact target a command would act on: `hack project target --json
[--project=…] [--path=…] [--branch=…] [--service=…] [--env=…]
[--expect-generation=…]`. The tool, its inputs and the result schema are
provisional; see the [AX target and result contract](./ax-target-result-contract.md).

- Inputs: `projectName`, `path`, `branch`, `service`, `env` and
  `expectGeneration`, all optional.
- Unlike the other project tools, selection is not resolved by the MCP server.
  `projectName` and `path` are passed through, both of them when both are
  given, so the CLI owns every resolution refusal (for example
  `conflicting_selectors`) and the MCP result matches the CLI exactly.
- `data` is the CLI's JSON envelope, re-validated against the contract, or
  `null` when the output does not match it. A detail-less error is accepted
  only as a parser `E_USAGE` refusal, so an `E_UNEXPECTED` fault message never
  reaches `data`. `stdout` is always `""`, because
  `data` carries the same envelope. `stderr` is returned as captured.
- The command never probes the engine, writes the registry or changes Git.

## `hack.project.task.list` and `hack.project.task.inspect`

List or inspect the reviewed task recipes in the target project's
`.hack/tasks.json`: `hack project task list --json` and `hack project task
inspect --json -- <task>`, with the same `projectName`, `path`, `branch`,
`env` and `expectGeneration` inputs as `hack.project.target` (no `service`;
each recipe names its own). The tools, inputs and schemas are provisional;
see the [AX task catalog contract](./ax-task-catalog.md).

- `task` (inspect only) must match the task id grammar; a malformed id is
  refused before spawning, as `invalid_arguments` with `spawned: false`.
- Selection is passed through unresolved, so every refusal comes from the
  CLI and matches it exactly.
- `data` is the CLI's JSON envelope, re-validated against the contract, or
  `null` when the output does not match it. A refused recipe never carries
  its argv or text, and a result never carries a recipe the catalog's checks
  would refuse. `stdout` is always `""`.
- Nothing is executed. The results say `authority: "none"` and
  `execution: "unavailable"`; there is no task execution tool.

## Audit log

Every spawned command appends one JSON line to `$HACK_HOME/mcp-audit.log` (by
default `~/.hack/mcp-audit.log`): `ts`, `tool`, `command` and `exit_code`.
Refusals write nothing.
