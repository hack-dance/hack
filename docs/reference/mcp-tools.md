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
`hack projects` or any project command in it to register it.

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
| `outputTruncated` | `true` when output reached the 8 MiB capture limit |
| `spawned` | `false` only on a refusal: no child, no audit line |
| `error` | Closed refusal or backend error: `code`, `reason`, `message` |

When `ok` is `false`, the result also has `isError: true`. Output above the
8 MiB capture limit stops the command, and `data` is omitted so that a prefix is
never presented as a complete result. The log tools are the exception, as their
contract describes.

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

`hack env list --json` prints plaintext values, and CLI errors can quote env
files. Both env tools therefore withhold the child's output:

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
  `null` when the output does not match it. `stdout` is always `""`, because
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
