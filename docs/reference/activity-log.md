# Activity log

Hack keeps a short history of project lifecycle actions: every `hack up`,
`hack down` and `hack restart`, on the Compose and the native backend alike.
`hack activity` reads it. It is meant for the planned desktop app's Activity
tab, and for any script that wants to know what was started or stopped, when,
by whom and how it ended.

## Reading it

```sh
hack activity                                   # newest first, 50 entries
hack activity --json --project shop --limit 100
```

- `--project <name>`: only entries for this project name, accepting the same
  canonical-name aliases as lifecycle commands (`My_App` matches `my-app`).
  Historical entries remain selectable after a project leaves the registry.
- `--limit <n>`: at most `n` entries, newest first (default 50, at most
  10,000).
- `--json`: the standard envelope, `{"ok": true, "data": {"version": 1,
  "entries": [...]}}`. A log that exists but cannot be read (not this user's
  regular file, a symlink, or a read error) is `{"ok": false, "error":
  {"code": "E_PATH_CONFLICT", ...}}` with exit 1, never an empty history.
  An absent log is an empty list.

## Records

One JSON object per line, in `<hack home>/activity.jsonl` (`~/.hack` unless
`HACK_HOME` is set):

```json
{"v":1,"ts":"2026-11-14T12:00:00.000Z","project":"shop","branch":null,"action":"up","origin":"app","outcome":"failed","failed_services":["worker"],"duration_ms":8412}
```

| Field | Meaning |
|---|---|
| `v` | Schema version, `1`. Readers skip lines of another version. |
| `ts` | When the action started (ISO 8601, UTC). |
| `project` | The project's registered name, or `null` when the target is not a registered project. Resolved from `--project` with the same canonical-name rules the command uses (`My_App` records `my-app`), or from the registered checkout, `.hack` directory or linked worktree containing `--path` or the working directory. Never a path. |
| `branch` | The branch instance the command acted on (`--branch`, or the linked worktree's instance; for an implicit `down` the running instance it was reconciled to), or `null` for the base instance. |
| `action` | `up`, `down`, `restart`; `autostart` is reserved for always-on starts. |
| `origin` | Who asked: `cli`, `app`, `autostart` or `agent`, from `HACK_ORIGIN`. |
| `outcome` | `ok` (exit 0), `interrupted` (exit 130 or 143, such as Ctrl-C on a foreground `up`), or `failed`. |
| `failed_services` | Service names that did not start, when known (sorted, at most 32). |
| `duration_ms` | Wall time of the command. |

`HACK_ORIGIN` takes one of the four origins. Unset, empty or any other value
records `cli`. The desktop app sets `app`; Hack's MCP server sets `agent` for
the commands it runs unless its own environment already names an origin.

A record is written when the command returns. A foreground `hack up` that
keeps running is recorded when it stops, so its duration is the whole time it
ran. A command killed before it returns writes no record. With `up -d` on the
native backend, the launcher that waits for startup writes the record; the
detached owner process does not.

## What is never recorded

The log holds names and fixed values only: the project's registered name, a
branch slug, service names and the enums above. It never contains an env
value, a secret, a key name, a command line, a host name or a filesystem path.
A name that is not a plain name (letters, digits, `.`, `_`, `-`) is dropped
rather than written.

## Durability and concurrency

![Activity recording and rotation](../diagrams/activity-log.svg)

- Each record is one `write(2)` of a whole line, at most 4,096 bytes including
  any leading newline after a torn line, on a file opened with `O_APPEND`.
  Encoding reserves one byte for that recovery separator.
- Appends and rotation take the same short lock (`activity.jsonl.lock`), so a
  rotation never retires a file between a writer's open and its write. A
  completed record is lost only to retention: after a later rotation has kept
  a full newer generation.
- If the lock stays busy for 2 seconds, the record is appended without it and
  without rotating. Concurrent appends still never interleave within a line.
  After that write the writer checks that the file it wrote is still linked;
  if a rotation retired it meanwhile, the record is appended again.
- If the file does not end in a newline (a crash or full disk mid-write), the
  next record starts on a fresh line. An unlocked writer that looks during
  another append can leave a blank line, which readers skip.
- Both files are this user's regular files with mode 0600, opened without
  following a symlink. A writer tightens a looser current file before writing
  or keeping it as the generation; a symlink, a non-regular file or another
  user's file is refused by writers and by `hack activity`.
- When the current file would pass 1 MiB it is renamed to `activity.jsonl.1`,
  replacing the previous generation, so the log holds roughly the last 1 to 2
  MiB of actions.
- A reader opens both files before reading either; if a rotation happens
  between the two opens it sees the same file twice and opens the pair again,
  so a read never returns the same records twice. It returns only the fields
  above and skips any line that is not a complete, valid record, such as a
  torn last line.
- Recording is best effort. A write that fails (full disk, unwritable Hack
  home, refused file) is dropped silently and never changes the command's
  output, envelope or exit code.

## Relation to the `--json` lifecycle envelope

The `hack up|down|restart --json` envelope does not carry the activity
record. The envelope already reports the action, project, branch and
duration for the caller that ran the command; the log is for everyone else,
including actions started from a terminal. A caller that needs both can read
`hack activity --json --project <name> --limit 1` after the command returns.
