# Hack error codes

Commands run with `--json` print one envelope. A failure has the shape
`{ok: false, error: {code, message}}`; branch on `code`, not on `message`.
Each read-first step only inspects state. Repairs such as `hack doctor --fix`
stay within the request.

| Code | Meaning | Read first |
| --- | --- | --- |
| `E_DOCKER_UNAVAILABLE` | The container runtime CLI or engine cannot be reached. | `hack doctor --json` |
| `E_GLOBAL_INFRA_DOWN` | Shared global infrastructure the command needs is offline. | `hack global status` |
| `E_LOGGING_OFF` | The command needs the opt-in global logging stack (Loki, Grafana), which is off. | `hack global up --logging` |
| `E_GLOBAL_NOT_READY` | A global proxy or logging container did not become ready, or routes did not answer, within its bound. | `hack doctor` |
| `E_GLOBAL_STOPPED` | A global proxy or logging container stopped right after it started. | `docker logs --tail 50 <container>` |
| `E_CONFIG_PARSE` | A Hack configuration file could not be parsed. | `hack doctor --json` |
| `E_CONFIG_INVALID` | Project configuration or saved runtime input did not pass validation. | `hack doctor --json` |
| `E_CONFLICT` | A project config layer changed after it was read. | Run hack config show --json again before preparing a new patch. |
| `E_LAYER_READ_ONLY` | The selected project config layer cannot be edited. | Check the layer’s writable flag and edit an authored layer. |
| `E_MIN_CLI_VERSION_REQUIRED` | The Compose remote configuration needs a minimum CLI version. | `hack config validate --json` |
| `E_INVALID_MIN_CLI_VERSION` | The minimum CLI version is malformed. | `hack config validate --json` |
| `E_CLI_VERSION_TOO_OLD` | The running CLI is older than the project minimum. | `hack config validate --json` |
| `E_INVALID_PREREQUISITE` | A sign-in prerequisite declaration is invalid. | `hack config validate --json` |
| `E_UNKNOWN_PREREQUISITE` | A remote target refers to an undeclared prerequisite. | `hack config validate --json` |
| `E_INVALID_HOST_TOOL` | A host tool declaration or reference list is invalid. | `hack config validate --json` |
| `E_UNKNOWN_HOST_TOOL` | A prerequisite or tunnel names an undeclared host tool. | `hack config validate --json` |
| `E_INVALID_REMOTE` | A remote declaration is invalid. | `hack config validate --json` |
| `E_REMOTE_START_UNSUPPORTED` | The command cannot start services for a project with remotes. | `hack up --help` |
| `E_UNKNOWN_REMOTE_TARGET` | A remote names a default target that does not exist. | `hack config validate --json` |
| `E_PREREQUISITE_TOOL_MISSING` | A binary needed for the prerequisite is missing. | `hack doctor --json` |
| `E_PREREQUISITE_CHECK_TIMEOUT` | A sign-in prerequisite check exceeded its deadline. | `hack doctor --json` |
| `E_PREREQUISITE_CHECK_FAILED` | A sign-in prerequisite check exited unsuccessfully. | `hack doctor --json` |
| `E_PROJECT_NOT_FOUND` | No Hack project resolved from the working directory, `--project` or `--path`. | `hack projects --json` |
| `E_NATIVE_PROJECT_CONFLICT` | Native project input and legacy Hack inputs coexist; project commands refuse until one is reconciled. | `hack doctor --json` |
| `E_NATIVE_PROJECT_UNSUPPORTED` | The project or the requested operation needs native runtime support that this CLI does not provide. | `hack doctor --json` |
| `E_NATIVE_COMPOSE_PROXY_ACCESS` | Native Compose routing could not read the live proxy state. | `hack global status` |
| `E_NATIVE_RUN_MAPPING_FOREIGN_HOME` | The instance's last native run belongs to another native home, usually the one an earlier Hack version used; this home neither starts nor stops it until that mapping is released or the owning version stops the run. | The error message (and `detail.releaseCommand` in `--json`) names the way out; `hack doctor --native-run-mapping inspect --json` shows the owner. |
| `E_SERVICE_NOT_FOUND` | The named service is not part of the selected project runtime. | `hack ps --json` |
| `E_COMPOSE_FAILED` | A Compose operation failed or left a stop incomplete. | `hack logs --json --no-follow --tail 200` |
| `E_COMPOSE_OUTPUT_INVALID` | Compose exited successfully but printed output Hack cannot parse as JSON, usually an unsupported Compose version. | `docker compose version` |
| `E_STARTUP_INCOMPLETE` | After start or restart, a service is neither running nor a successful one-shot. | `hack ps --json` |
| `E_DOWN_INCOMPLETE` | After down, a container of the instance may still run. `error.detail.running` names this checkout's services, `error.detail.foreign` another checkout's containers and their working dir (stop them from there), and `error.detail.unknown` means the containers could not be listed. | `hack ps --json` |
| `E_RECOVERY_REQUIRED` | The last native run of this instance has no confirmed shutdown (its owner exited before finishing it, or another start replaced it), so `up` started nothing. `hack down --recover` finishes that cleanup with data kept, starting the native runtime if it needs to. | `hack down --recover` |
| `E_PLAN_REFUSED` | A read-only administrator plan established that the command would refuse to run. | Read `error.detail.plan.refused`; no planned step ran. |
| `E_PLAN_INCOMPLETE` | An administrator plan cannot yet determine every required phase. | Read `error.detail.plan.blocked` and re-plan after its prerequisites are satisfied. |
| `E_NATIVE_SETUP_REQUIRED` | The selected native home needs runtime setup before project startup. | `hack doctor --native-preflight --json` |
| `E_UNSUPPORTED_PLATFORM` | The command needs a platform this host is not, such as the native runtime outside Apple Silicon macOS. | The error's first line names the supported platform; use the Compose backend instead. |
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
| `E_DAEMON_SERVICE` | hackd or its login service could not be started, stopped, restarted, installed or repaired, or Hack refused because it could not prove the daemon or service belongs to this Hack home and executable. | `hack daemon status --json` |
| `E_USAGE` | Arguments or flags were invalid for the command. | `hack <command> --help` |
| `E_UNEXPECTED` | An unclassified failure; the message is the only detail. | `hack doctor --json` |

---

Content revision: `fbf626bdfcb0`. Generated by Hack; edit the canonical source and regenerate the plugin.
