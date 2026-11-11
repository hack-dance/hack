# Background commands

`hack exec --detach` and `hack run --detach` start a command in the background
and print its id at once. You then read what happens to it with a cursor: output
as it arrives, an advisory stall, and the end with its outcome and exit code.
After a disconnect you read again from the last cursor. The same commands are
available to MCP clients as `hack.project.command.start|read|inspect|cancel`
(see the [MCP tool contract](../reference/mcp-tools.md#background-commands)).
Both use one implementation and one journal.

This is phase 1: `exec` and `run` only, for projects with Compose
configuration (`.hack/docker-compose.yml`). Projects with native or adopted
configuration refuse `--detach` on the Compose backend. `up`, `restart` and `down`, a
project-wide event feed and service events are not part of it.

## Start

```sh
hack exec --detach --json api -- npm test
```

```json
{
  "ok": true,
  "data": {
    "commandId": "cmd_…",
    "cursor": "cmd_…:k3v9q2xa:0",
    "state": "accepted",
    "expiresAt": "…",
    "reused": false,
    "capture": "full",
    "liveOutput": "available",
    "stallDetection": "available",
    "limits": { "timeoutMs": 1800000, "stallAfterMs": 120000, "retentionMs": 86400000 }
  }
}
```

Start runs the same project resolution, env resolution, validation and refusals
as the foreground command; a refusal (for example a service that is not running
for `exec`) is reported at once and nothing is started. Flags, all only valid
with `--detach`:

| Flag | Meaning |
| --- | --- |
| `--json` | Print the start result as a JSON envelope |
| `--request-key <key>` | Retry safety: the same key with the same inputs in the same project returns the existing command and never runs it twice; the same key with different inputs fails with `E_REQUEST_CONFLICT`; a key whose result has expired fails with `E_RESULT_EXPIRED` |
| `--timeout-ms <ms>` | Stop the command after this long. Default 30 minutes, maximum 6 hours |
| `--stall-after-ms <ms>` | Advisory stall threshold. Default 120,000; 0 turns it off |
| `--capture full\|metadata` | Store output (default) or only events and the outcome |

The command runs with stdin closed and no terminal. A command that reads stdin
sees end of file at once, and a prompt that opens the terminal fails, so neither
can hang in the background. Input redirected from a file into
`hack exec --detach` is refused, because the command would never see it. Input
piped into it is not forwarded either; Hack does not read the pipe to check.

Limits: 4 active background commands per caller session (one terminal session,
or one MCP session) and 16 per Hack home. Over a limit, start fails with
`E_ADMISSION_LIMIT`; nothing is queued.

## Read

```sh
hack commands read <id> [--after <cursor>] [--follow] [--wait-ms N] [--max-bytes N] --json
```

With `--json` each event is printed as one JSON line, and the last line says why
the read ended:

```json
{"v":1,"id":"…","seq":4,"cursor":"cmd_…:k3v9q2xa:4","time":"…","projectId":"demo","instanceId":"@base","commandId":"cmd_…","service":"api","type":"command.output","payload":{"stream":"stdout","offset":0,"length":6,"text":"first\n"}}
{"type":"read.end","reason":"ended","commandId":"cmd_…","state":"ended","nextCursor":"cmd_…:k3v9q2xa:9","gap":false,"timedOut":false,"ended":true,"outcome":"failed","exitCode":3}
```

`reason` is `ended`, `wait_elapsed`, `stalled`, `budget` (the next event would
pass `--max-bytes`) or `gap`. Pass `nextCursor` as `--after` to continue.
Without `--json`, output is written to stdout and stderr as the command wrote it,
and status lines go to stderr. `--follow` keeps reading until the command ends.

- Event types: `command.accepted`, `command.started`, `command.output`,
  `command.stalled`, `command.resumed`, `command.output_truncated`,
  `command.ended`, and `gap`.
- Sequence numbers are dense and strictly increasing within one command. stdout
  and stderr interleave only in the order Hack observed them. There is no order
  across commands.
- Output is stored once, in byte files. An output event carries a byte range; a
  read adds `text`, the range decoded as UTF-8. Ranges end on character
  boundaries. Output that is not valid UTF-8 is withheld: the event keeps its
  `length` and gets `withheld: "not_utf8"` instead of `text`.
- `--max-bytes` bounds the text in one read: default 32 KiB, 16 KiB to 256 KiB.
  One output event is at most 16 KiB, so every read makes progress.
- The cursor contains a journal generation. A cursor from another generation,
  or past the end, returns a single `gap` event with `reason: "E_CURSOR_EXPIRED"`
  and the earliest available cursor, never an empty success.
- A read never slows the command: readers only read files.

## Outcomes

`command.ended` carries `outcome`, `exitCode`, `signal`, `durationMs`,
`truncated` and `suppressed`, and sometimes `reason`:

| Outcome | When |
| --- | --- |
| `succeeded` | The command exited 0 |
| `failed` | It exited non-zero or was killed by a signal Hack did not send |
| `cancelled` | `hack commands cancel` (or the MCP cancel tool) stopped it |
| `timed_out` | It ran past its timeout and Hack stopped it |
| `unknown` | Hack could not observe the end. `reason` says why: `supervisor_lost` (the supervisor died, for example a sandbox killed its cgroup or the machine restarted), `supervisor_never_started`, `supervisor_failed_to_start` or `supervisor_error` |

`unknown` is never reported as success or as an inferred failure, and nothing is
ever re-run automatically.

`hack down` or a container restart while a background `exec` runs stops the
container under the `docker compose exec` client. The client then exits with
Docker's status, and the command ends `failed` with that exit code (137 in the
end-to-end test for both cases). Hack does not reclassify these ends.

## Stalls

A command is stalled when it is alive and has written no output and changed no
state for `--stall-after-ms`, measured on a monotonic clock. `command.stalled`
carries `idleMs` and `lastOutputAt`; `command.resumed` follows when output
returns. Stalls are advisory only and never stop a command. Quiet builds, lock
waits and long downloads look exactly like stalls.

## Capture limit

Capture stops at 8 MiB per command (stdout and stderr together), or 65,536
output events. Hack then records `command.output_truncated`, stops storing
output, and **the command keeps running** to its normal end, which records
`truncated: true`. If the disk or quota fills while events are recorded,
capture also stops and the command keeps running; its final record (written
from space reserved at start) has `truncated: true` and
`captureStopped: "no_space"`. This differs from the foreground `hack.project.exec` and
`hack.project.run` MCP tools, where reaching 8 MiB stops the command.

## Inspect and cancel

```sh
hack commands show <id> --json
hack commands cancel <id> --json
```

`show` prints the request (service, argv, workdir), state, limits, capture and
redaction settings, output sizes, the supervisor and child process ids, the
cursors and the final record. It never prints environment values.

`cancel` first records the request, then signals the supervisor and the
command's process group, each only after re-checking its pid, start time and
process group immediately before the signal; a reused pid is never signalled
and is listed in `refused`. The supervisor records `cancelled`. The result says
what was confirmed: `supervisorSignalled`, `childGroupSignalled`, `childExited`,
and `containerProcess: "not_confirmed"`. Stopping a `docker compose exec` or
`run` client does not prove that the process inside the container stopped.

## Ownership

Each background command has its own supervisor process: a hidden entrypoint of
the same `hack` binary, started in a new session, so it survives the shell or
sandbox session that started it. No daemon is needed. The command's stdout and
stderr are appended by the kernel to files; they do not pass through the
supervisor. If the supervisor dies, the command keeps running and writing, and
the next read takes over: it announces the output that landed (marked
`unsupervised: true`) and, once the command is gone, writes the single final
record with outcome `unknown`. If the command is still running past its timeout
with no supervisor, the next background start in the same Hack home stops its
process group (only after checking its pid, start time and group), records
`timed_out` with reason `orphan_timeout`, and writes an audit line. Reads never
signal processes. A sandbox that kills by
cgroup kills both; that also ends as `unknown`.

## Stored output, retention and redaction

Using background mode is a decision to store output. It is not the same as a
foreground result: stored output lasts longer, any later process of the same OS
user that can select the project can read it, and backups can copy it.

- Journals live under the Hack home, in `commands/<id>/` (directory mode 0700,
  files mode 0600), never under a project's `.hack/` folder.
- Output of ended commands is removed after the retention period, at most 24
  hours. Retention is checked whenever a command is read, shown or started, so
  nothing depends on another command running. A later read fails with
  `E_RESULT_EXPIRED`.
- Metadata never contains environment values.

Settings, in the global `~/.hack/hack.config.json` or the project's
`.hack/hack.config.json`, under `backgroundCommands`:

| Key | Values | Scope |
| --- | --- | --- |
| `capture` | `full` or `metadata`; the global file also accepts `off`, which stores no output for any background command and refuses an explicit `--capture full` with `E_CAPTURE_DISABLED` | global, project |
| `retentionHours` | 0 to 24; the global value is a ceiling for the project value | global, project |
| `stallAfterMs` | 0 to 21,600,000 | global, project |

A per-call flag wins over the project default, which wins over the global one.

**Redaction is partial.** Before output is announced, Hack replaces values it
had already resolved to inject into that command's Compose environment (6 bytes
or longer) with `*`, in place in the stored file. The command writes to the
file directly, so a value is on disk unredacted until the supervisor's next
scan (about 200 ms), and the start of a value stays unredacted until the rest
arrives or the command ends. It matches across separate writes, so a value split between
two writes is still caught. It does not catch values Hack did not inject, values
the command transforms (encodes, splits across lines, prints in parts), or
values printed after the supervisor was lost (such output is withheld from reads
with `withheld: "redaction_unavailable"`). Hack never loads or decrypts secrets
only to redact. Treat stored output as sensitive.

## Audit

Starts, final outcomes and cancels are appended to `commands/audit.log` under
the Hack home (no argv, output or values). Reads are not audited. MCP calls also
write the usual `mcp-audit.log` line, except reads and inspects.

## Native backend

On the native backend the same commands work, but output arrives in one batch
when the command ends, so `liveOutput` and `stallDetection` are reported
`unavailable`; nothing is simulated. Hack resolves no values in the launcher
there, so nothing is redacted.

## Errors

| Code | Meaning |
| --- | --- |
| `E_COMMAND_NOT_FOUND` | No command with this id for the selected project and instance |
| `E_RESULT_EXPIRED` | The result was removed by retention |
| `E_CURSOR_EXPIRED` | Reported inside a `gap` event, not as an error |
| `E_CAPTURE_DISABLED` | `--capture full` while the global switch is `off` |
| `E_ADMISSION_LIMIT` | Too many active background commands |
| `E_REQUEST_CONFLICT` | A request key reused with different inputs |
| `E_JOURNAL_VERSION` | The journal was written by a newer Hack format |

An id grants nothing: `read`, `show` and `cancel` select the project and
instance with the same rules as `hack exec` (`--path`, `--project`, `--branch`,
or the working directory) and report `E_COMMAND_NOT_FOUND` for an id from
another project or instance, even when that command has expired. When output
expires, the request's argv and workdir are removed too.
