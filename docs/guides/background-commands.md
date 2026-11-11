# Background commands

`hack exec --detach` and `hack run --detach` start a command in the background
and print its id at once. You then read what happens to it with a cursor: output
as it arrives, an advisory stall, and the end with its outcome and exit code.
After a disconnect you read again from the last cursor. The same commands are
available to MCP clients as `hack.project.command.start|read|inspect|cancel`
(see the [MCP tool contract](../reference/mcp-tools.md#background-commands)).
Both use one implementation and one journal.

This is phase 1: `exec` and `run` only, for projects with Compose
configuration (`.hack/docker-compose.yml`). `up`, `restart` and `down`, a
project-wide event feed and service events are not part of it. Qualification
in real MCP clients (Claude Code, Codex) is still open (HACK-2086).

`--detach` is refused, with `E_USAGE` and the reason, for:

- projects with native (`.hack/hack.project.json`) or adopted configuration:
  their `exec` and `run` go through a separate dispatcher with its own
  generation store and ownership proofs, which the background launcher does
  not use;
- `run` against a service whose shared dependency cache has an installer that
  runs before it: the installer would run before the request is accepted and
  deduplicated. Use the foreground command, or `exec --detach` against the
  running service.

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
for `exec`) is reported at once and nothing is started. On the native backend
the synchronous refusals of the foreground command (runtime selection,
`--env`/`--profile` for `exec`) run first; refusals that the native runtime
makes later surface as a `failed` command. Start returns once the supervisor
has recorded itself, which can take up to 10 seconds on a loaded machine. Flags, all only valid
with `--detach`:

| Flag | Meaning |
| --- | --- |
| `--json` | Print the start result as a JSON envelope |
| `--request-key <key>` | Retry safety: the same key with the same inputs in the same project returns the existing command and never runs it twice; the same key with different inputs fails with `E_REQUEST_CONFLICT`; a key whose result has expired fails with `E_RESULT_EXPIRED` |
| `--timeout-ms <ms>` | Stop the command after this long. Default 30 minutes, maximum 6 hours |
| `--stall-after-ms <ms>` | Advisory stall threshold. Default 120,000; 0 turns it off |
| `--capture full\|metadata` | Store output (default) or only events and the outcome |

The command runs with stdin closed and no terminal: Hack passes `-T` to
`docker compose exec` and `run` and never allocates one. A command that reads
stdin sees end of file at once, and a prompt that opens the terminal fails, so
neither can hang in the background. Input redirected from a file into
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
  The 16 KiB minimum is the largest output event, so every read makes
  progress. A read also stops at 1,000 events or 4 × `--max-bytes` of
  serialized events (withheld output has no text but still counts), so many
  small events cannot make one read too large; `nextCursor` always advances.
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
end-to-end test for both cases). `hack down` does not stop a background `run`:
`docker compose down` leaves a running one-off container in place (it exits 0
but reports that the project network is still in use), so the command keeps
running until it ends or times out. `hack commands cancel` (or the timeout)
stops the `docker compose run` client. Whenever a background `run` ends, by a
stop or because its client exited on its own (for example at the file-size
cap), the supervisor removes the command's one-off container: Hack names it
`hack-bg-<random>` at start and removes it only if Docker reports it as a
one-off container of the expected service. If the supervisor itself is gone
(a cancel that had to force-stop it, an orphan timeout, a supervisor error),
the container is not removed and the end says `containerProcess:
"not_confirmed"`. The result
says `containerProcess: "stopped"` when that is confirmed. Both are tested end
to end. Hack does not reclassify these ends.

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
from space reserved at start) has `truncated: true` and `captureStopped:
"no_space"`. On the Compose backend each output file is also capped at 64 MiB
by a kernel file-size limit on the host-side `docker compose` client, so a
burst between two supervisor polls cannot fill the disk. A client that writes
more than that within one poll (200 ms) gets a "File too large" (EFBIG) error
and exits: the command ends `failed`, output after that point is lost, and
what ran in the container is then stopped like at any other end (see Inspect
and cancel). Everything the client starts on the host inherits the same 64 MiB
file limit (with SIGXFSZ ignored). A command whose program does not exist ends
`failed` with exit code 127. The native backend has no such cap. This differs
from the foreground `hack.project.exec` and `hack.project.run` MCP tools,
where reaching 8 MiB stops the command.

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
and is listed in `refused`. A live supervisor stops the process group itself:
it records the group's members first, so descendants that ignore SIGTERM are
still killed (after checking their pid and start time) once the command's own
process exits. The supervisor records `cancelled`. If the command's own
process exits by itself just as a cancel arrives, the group was never stopped;
the final record then also says `descendants: "not_confirmed"`. A command that already
exited 0 stays `succeeded` even if a cancel raced its end. The result says what
was confirmed: `supervisorSignalled`, `childGroupSignalled`, `childExited`, and
`containerProcess`: `"stopped"` when what ran in the container is confirmed
gone (for a `run`, the one-off container is removed; for an `exec`, no process
carrying the marker is left, which is best effort, see below), otherwise
`"not_confirmed"`. Stopping a `docker compose` client alone
does not stop what runs in the container, so:

- a background `run`'s one-off container is removed at every end (see
  Outcomes);
- a background `exec` runs its process with `HACK_BACKGROUND_COMMAND=<marker>`
  in its environment; at every end (a stop, a killed client, a client that
  exits by itself, a clean exit) the supervisor ends every process in the
  container that carries the marker, including any the command left running
  in the background (TERM, then KILL), and reports `stopped` once none is
  left. That needs `sh`, `/proc`
  and `tr` in the image. The script first checks that it can find a known
  variable in a process's environment, so without them the result is
  `not_confirmed`, never `stopped`. Processes the scan cannot see are not
  stopped: one started with a cleaned environment (`env -i`, `sudo` with
  `env_reset`, `su -`, a daemon that clears its environment), and one whose
  environment the exec user cannot read (another user's, or a setuid
  program).

An end other than `succeeded` whose container process is `not_confirmed` keeps
its admission slot until the command's timeout window closes, so a
start/cancel loop cannot run more than the limits allow. A `succeeded` end
never holds a slot, even on an image where the stop cannot run; anything a
succeeded command left running in the background is then not confirmed
stopped, as with a foreground `hack exec`. The hold survives retention: when
the output expires first, the tombstone keeps the deadline. A Compose command
finalized after its supervisor was lost also ends with `containerProcess:
"not_confirmed"`, because nothing stopped what ran in the container. When the
stop itself cannot be confirmed (for example the command's identity is
unknown, see below), no final record is written and `outcome` is
`unconfirmed`.

## Ownership

Each background command has its own supervisor process: a hidden entrypoint of
the same `hack` binary, started in a new session, so it survives the shell or
sandbox session that started it. No daemon is needed. The command's stdout and
stderr are appended by the kernel to files; they do not pass through the
supervisor. If the supervisor dies, the command keeps running and writing, and
the next read takes over: it announces the output that landed (marked
`unsupervised: true`) and, once the command is confirmed gone, writes the
single final record with outcome `unknown`. Until then the command stays
running: it keeps its admission slot, and its files are not truncated at the
capture limit (no owner is left to truncate them). If it is still running past
its timeout, the next background start in the same Hack home stops its process
group (only after checking its pid, start time and group), records `timed_out`
with reason `orphan_timeout`, and writes an audit line. Reads never signal
processes. A sandbox that kills by cgroup kills both; that also ends as
`unknown`.

**Ownership unknown.** If the supervisor dies between starting the command and
recording its identity, or `ps` could not observe the command when it started,
the command may still exist but cannot be identified. Hack never treats that
as absence: no final record is written, so the command keeps its admission
slot and retention keeps its files, and cancel reports `unconfirmed`. It
resolves when the machine reboots (a process recorded before the last boot is
certainly gone); `hack commands show` reports the state.

## Stored output, retention and redaction

Using background mode is a decision to store output. It is not the same as a
foreground result: stored output lasts longer, any later process of the same OS
user that can select the project can read it, and backups can copy it.

- Journals live under the Hack home, in `commands/<id>/` (directory mode 0700,
  files mode 0600), never under a project's `.hack/` folder.
- A result is not readable after its retention time (at most 24 hours after
  the command ends): every read, show or cancel checks it and answers
  `E_RESULT_EXPIRED`. Files are physically removed at the next sweep, which
  runs on every background-command operation and at `hack up` and
  `hack down`; there is no separate timer, so Hack does not promise physical
  deletion within 24 hours. An expired result keeps a value-free tombstone
  (no argv or output) for 7 days, and its request key is remembered for those
  7 days, so a retry is refused rather than re-run.
- A Hack home keeps at most 64 ended results and 256 MiB of their events and
  output. Each start checks this first: past either ceiling, the oldest ended
  results expire early, exactly as at their retention time. Running commands
  are never touched. At most 4096 tombstones are kept; past that the oldest
  are removed with their request keys (never one that still holds an
  admission slot), so a request key is remembered for 7
  days or until 4096 newer results have expired, whichever comes first.
- Metadata never contains environment values.

Settings, in the global `~/.hack/hack.config.json` or the project's
`.hack/hack.config.json`, under `backgroundCommands`:

| Key | Values | Scope |
| --- | --- | --- |
| `capture` | `full` or `metadata`; the global file also accepts `off`, which stores no output for any background command and refuses an explicit `--capture full` with `E_CAPTURE_DISABLED` | global, project |
| `retentionHours` | 0 to 24; the global value is a ceiling for the project value. With 0, the first read after the end removes the output and the outcome, so a caller may only ever see `E_RESULT_EXPIRED` | global, project |
| `stallAfterMs` | 0 to 21,600,000 | global, project |

A per-call flag wins over the project default, which wins over the global one.

**Redaction is partial.** Before output is announced, Hack replaces values it
had already resolved to inject into that command's Compose environment with
`*`, in place in the stored file. Values shorter than 6 bytes are not redacted
(too many false matches). The values reach the supervisor over an inherited
pipe; they are never written to disk or put in an environment variable. The command writes to the
file directly, so a value is on disk unredacted until the supervisor's next
scan (about 200 ms), and the start of a value stays unredacted until the rest
arrives or the command ends. It matches across separate writes, so a value split between
two writes is still caught. It does not catch values Hack did not inject, values
the command transforms (encodes, splits across lines, prints in parts), or
values printed after the supervisor was lost (such output is withheld from reads
with `withheld: "redaction_unavailable"`). Hack never loads or decrypts secrets
only to redact. Treat stored output as sensitive.

## Audit

Starts, final outcomes (whoever writes them) and cancels are appended to
`commands/audit.log` under the Hack home (no argv, output or values). Reads are
not audited. MCP calls also write the usual `mcp-audit.log` line, except reads
and inspects; for `hack.project.command.start` that line records the
operation, service, `argv[0]`, the argument count and a SHA-256 of the
arguments, never the arguments. New audit files are created mode 0600.

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
