# Hack error codes

Commands run with `--json` print one envelope. A failure has the shape
`{ok: false, error: {code, message}}`; branch on `code`, not on `message`.
Each read-first step only inspects state. Repairs such as `hack doctor --fix`
stay within the request.

| Code | Meaning | Read first |
| --- | --- | --- |
| `E_DOCKER_UNAVAILABLE` | The container runtime CLI or engine cannot be reached. | `hack doctor --json` |
| `E_GLOBAL_INFRA_DOWN` | Shared global infrastructure the command needs is offline. | `hack global status` |
| `E_CONFIG_PARSE` | A Hack configuration file could not be parsed. | `hack doctor --json` |
| `E_CONFIG_INVALID` | Project configuration or saved runtime input did not pass validation. | `hack doctor --json` |
| `E_PROJECT_NOT_FOUND` | No Hack project resolved from the working directory, `--project` or `--path`. | `hack projects --json` |
| `E_NATIVE_PROJECT_CONFLICT` | Native project input and legacy Hack inputs coexist; project commands refuse until one is reconciled. | `hack doctor --json` |
| `E_NATIVE_PROJECT_UNSUPPORTED` | The project or the requested operation needs native runtime support that this CLI does not provide. | `hack doctor --json` |
| `E_NATIVE_COMPOSE_PROXY_ACCESS` | Native Compose routing could not read the live proxy state. | `hack global status` |
| `E_SERVICE_NOT_FOUND` | The named service is not part of the selected project runtime. | `hack ps --json` |
| `E_COMPOSE_FAILED` | A Compose operation failed or left a stop incomplete. | `hack logs --json --no-follow --tail 200` |
| `E_COMPOSE_OUTPUT_INVALID` | Compose exited successfully but printed output Hack cannot parse as JSON, usually an unsupported Compose version. | `docker compose version` |
| `E_STARTUP_INCOMPLETE` | After start or restart, a service is neither running nor a successful one-shot. | `hack ps --json` |
| `E_PLAN_REFUSED` | A read-only administrator plan established that the command would refuse to run. | Read `error.detail.plan.refused`; no planned step ran. |
| `E_PLAN_INCOMPLETE` | An administrator plan cannot yet determine every required phase. | Read `error.detail.plan.blocked` and re-plan after its prerequisites are satisfied. |
| `E_DEPENDENCY_BOOTSTRAP_FAILED` | A dependency installer service did not complete successfully. | `hack logs <service> --json --no-follow --tail 200` |
| `E_STARTUP_TIMEOUT` | Bounded startup ran out of time before services settled. | `hack ps --json` |
| `E_CANCELLED` | The caller cancelled the operation; pending ownership is retained. | `hack ps --json` |
| `E_LIFECYCLE_FAILED` | A lifecycle hook or host process failed. | `hack projects --details` |
| `E_ENV_KEY_MISSING` | The selected env overlay cannot supply keys the command requires; the detail lists names only. | `hack env explain <key> --service <service>` |
| `E_ENV_TOO_LARGE` | The Compose environment exceeds the platform limit for a new process (ARG_MAX, or MAX_ARG_STRLEN for one variable), so Compose was not started; the detail has byte counts only. | `hack env list --json` |
| `E_PERMISSION` | A filesystem or runtime permission was denied, or a file Hack must write is on a read-only filesystem. | `hack doctor --json` |
| `E_NO_SPACE` | A file Hack must write could not be written because the disk is full or the disk quota is exceeded. | `df -h <path from the message>` |
| `E_PATH_CONFLICT` | A path Hack must read or write is the wrong kind of entry: a file where a directory is needed, or a directory or special file where a regular file is needed. | `ls -ld <path from the message>` |
| `E_PROJECT_EXISTS` | The project is already initialized, so init wrote nothing; it never overwrites an existing project directory. | `hack doctor --json` |
| `E_LOCKED` | A lock Hack needs stayed held for the whole bounded wait, by another Hack command or by a stale lock Hack cannot prove abandoned; nothing guarded by it was written. | `ls -l <lock path from the message>` |
| `E_INTERACTIVE_REQUIRED` | The command needs an answer at a prompt but is running without one. | `hack <command> --help` |
| `E_COMMAND_NOT_FOUND` | No background command with this id exists for the selected project and instance. | `hack commands show <id> --json` from the project that started it |
| `E_RESULT_EXPIRED` | The background command's result passed its retention and its output was removed; it is never re-run. | `hack commands show <id> --json` |
| `E_CURSOR_EXPIRED` | A read cursor is from another journal generation or past the end; the read returned a gap with the earliest cursor. | `hack commands read <id> --json` without `--after` |
| `E_CAPTURE_DISABLED` | Output capture for background commands is turned off in the global config. | `hack config get backgroundCommands --global` |
| `E_ADMISSION_LIMIT` | Too many background commands are active for this session or Hack home. | `hack commands show <id> --json` for the running commands |
| `E_REQUEST_CONFLICT` | A background request key was reused with different inputs; the earlier command is unchanged. | `hack commands show <id> --json` |
| `E_JOURNAL_VERSION` | A background command journal was written by a newer Hack journal format. | `hack --version` |
| `E_USAGE` | Arguments or flags were invalid for the command. | `hack <command> --help` |
| `E_UNEXPECTED` | An unclassified failure; the message is the only detail. | `hack doctor --json` |

---

Content revision: `3dd842ac3170`. Generated by Hack; edit the canonical source and regenerate the plugin.
