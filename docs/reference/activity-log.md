# Activity log

Hack keeps a short history of project lifecycle actions: every `hack up`,
`hack down` and `hack restart`, on the Compose and the native backend alike.
`hack activity` reads it. The desktop app's Activity tab uses it, and so can
any script that wants to know what was started or stopped, when, by whom and
how it ended.

## Reading it

```sh
hack activity                                   # newest first, 50 entries
hack activity --json --project shop --limit 100
```

- `--project <name>`: only entries for this registered project name.
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
| `branch` | The branch instance targeted (`--branch`, or the linked worktree's instance), or `null`. |
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

- Each record is one `write(2)` of a whole line, at most 4,096 bytes, on a
  file opened with `O_APPEND`. Concurrent Hack commands therefore never
  interleave within a line. If the file does not end in a newline (a crash or
  full disk mid-write), the next record starts on a fresh line; during a
  concurrent append this check can leave a blank line, which readers skip.
- The file is created with mode 0600. An existing file with group or other
  access is tightened before writing. A symlink, a non-regular file or a file
  owned by another user is refused.
- When the file would pass 1 MiB, it is renamed to `activity.jsonl.1`,
  replacing the previous generation, under a short lock. One generation is
  kept, so the log holds roughly the last 1 to 2 MiB of actions. A writer that
  had the old file open finishes its line there; readers read both files.
- Readers skip any line that is not a complete, valid record, such as a torn
  last line.
- Recording is best effort. A write that fails (full disk, unwritable Hack
  home, refused file) is dropped silently and never changes the command's
  output, envelope or exit code.

## Relation to the `--json` lifecycle envelope

The `hack up|down|restart --json` envelope does not carry the activity
record. The envelope already reports the action, project, branch and
duration for the caller that ran the command; the log is for everyone else,
including actions started from a terminal. A caller that needs both can read
`hack activity --json --project <name> --limit 1` after the command returns.
