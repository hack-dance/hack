import { HACK_ERROR_CODES, type HackErrorCode } from "../lib/cli-result.ts";

/**
 * Agent-facing meaning of each stable `--json` error code.
 *
 * Keyed by {@link HackErrorCode}, so adding a code to the registry without a
 * row here fails typecheck; the packaged reference renders in registry order
 * from {@link HACK_ERROR_CODES}, and `tests/focused-skills.test.ts` checks the
 * rendered code set against the registry.
 */
type ErrorCodeGuide = {
  /** What the failure means, without caller values. */
  readonly meaning: string;
  /** The first read-only step; never a repair. */
  readonly readFirst: string;
};

const ERROR_CODE_GUIDES: Readonly<Record<HackErrorCode, ErrorCodeGuide>> = {
  E_NATIVE_SETUP_REQUIRED: {
    meaning:
      "The selected native home needs runtime setup before project startup.",
    readFirst: "`hack doctor --native-preflight --json`",
  },
  E_UNSUPPORTED_PLATFORM: {
    meaning:
      "The command needs a platform this host is not, such as the native runtime outside Apple Silicon macOS.",
    readFirst:
      "The error's first line names the supported platform; use the Compose backend instead.",
  },
  E_DOCKER_UNAVAILABLE: {
    meaning: "The container runtime CLI or engine cannot be reached.",
    readFirst: "`hack doctor --json`",
  },
  E_GLOBAL_INFRA_DOWN: {
    meaning: "Shared global infrastructure the command needs is offline.",
    readFirst: "`hack global status`",
  },
  E_GLOBAL_NOT_READY: {
    meaning:
      "A global proxy or logging container did not become ready, or routes did not answer, within its bound.",
    readFirst: "`hack doctor`",
  },
  E_GLOBAL_STOPPED: {
    meaning:
      "A global proxy or logging container stopped right after it started.",
    readFirst: "`docker logs --tail 50 <container>`",
  },
  E_LOGGING_OFF: {
    meaning:
      "The command needs the opt-in global logging stack (Loki, Grafana), which is off.",
    readFirst: "`hack global up --logging`",
  },
  E_CONFIG_PARSE: {
    meaning: "A Hack configuration file could not be parsed.",
    readFirst: "`hack doctor --json`",
  },
  E_CONFIG_INVALID: {
    meaning:
      "Project configuration or saved runtime input did not pass validation.",
    readFirst: "`hack doctor --json`",
  },
  E_MIN_CLI_VERSION_REQUIRED: {
    meaning: "The Compose remote configuration needs a minimum CLI version.",
    readFirst: "`hack config validate --json`",
  },
  E_INVALID_MIN_CLI_VERSION: {
    meaning: "The minimum CLI version is malformed.",
    readFirst: "`hack config validate --json`",
  },
  E_CLI_VERSION_TOO_OLD: {
    meaning: "The running CLI is older than the project minimum.",
    readFirst: "`hack config validate --json`",
  },
  E_INVALID_PREREQUISITE: {
    meaning: "A sign-in prerequisite declaration is invalid.",
    readFirst: "`hack config validate --json`",
  },
  E_UNKNOWN_PREREQUISITE: {
    meaning: "A remote target refers to an undeclared prerequisite.",
    readFirst: "`hack config validate --json`",
  },
  E_INVALID_HOST_TOOL: {
    meaning: "A host tool declaration or reference list is invalid.",
    readFirst: "`hack config validate --json`",
  },
  E_UNKNOWN_HOST_TOOL: {
    meaning: "A prerequisite or tunnel names an undeclared host tool.",
    readFirst: "`hack config validate --json`",
  },
  E_INVALID_REMOTE: {
    meaning: "A remote declaration is invalid.",
    readFirst: "`hack config validate --json`",
  },
  E_REMOTE_START_UNSUPPORTED: {
    meaning: "The command cannot start services for a project with remotes.",
    readFirst: "`hack up --help`",
  },
  E_UNKNOWN_REMOTE_TARGET: {
    meaning: "A remote names a default target that does not exist.",
    readFirst: "`hack config validate --json`",
  },
  E_PREREQUISITE_TOOL_MISSING: {
    meaning: "A binary needed for the prerequisite is missing.",
    readFirst: "`hack doctor --json`",
  },
  E_PREREQUISITE_CHECK_TIMEOUT: {
    meaning: "A sign-in prerequisite check exceeded its deadline.",
    readFirst: "`hack doctor --json`",
  },
  E_PREREQUISITE_CHECK_FAILED: {
    meaning: "A sign-in prerequisite check exited unsuccessfully.",
    readFirst: "`hack doctor --json`",
  },
  E_PROJECT_NOT_FOUND: {
    meaning:
      "No Hack project resolved from the working directory, `--project` or `--path`.",
    readFirst: "`hack projects --json`",
  },
  E_NATIVE_RUN_MAPPING_FOREIGN_HOME: {
    meaning:
      "The instance's last native run belongs to another native home, usually the one an earlier Hack version used; this home neither starts nor stops it until that mapping is released or the owning version stops the run.",
    readFirst:
      "The error message (and `detail.releaseCommand` in `--json`) names the way out; `hack doctor --native-run-mapping inspect --json` shows the owner.",
  },
  E_NATIVE_PROJECT_CONFLICT: {
    meaning:
      "Native project input and legacy Hack inputs coexist; project commands refuse until one is reconciled.",
    readFirst: "`hack doctor --json`",
  },
  E_NATIVE_PROJECT_UNSUPPORTED: {
    meaning:
      "The project or the requested operation needs native runtime support that this CLI does not provide.",
    readFirst: "`hack doctor --json`",
  },
  E_NATIVE_COMPOSE_PROXY_ACCESS: {
    meaning: "Native Compose routing could not read the live proxy state.",
    readFirst: "`hack global status`",
  },
  E_SERVICE_NOT_FOUND: {
    meaning: "The named service is not part of the selected project runtime.",
    readFirst: "`hack ps --json`",
  },
  E_COMPOSE_FAILED: {
    meaning: "A Compose operation failed or left a stop incomplete.",
    readFirst: "`hack logs --json --no-follow --tail 200`",
  },
  E_COMPOSE_OUTPUT_INVALID: {
    meaning:
      "Compose exited successfully but printed output Hack cannot parse as JSON, usually an unsupported Compose version.",
    readFirst: "`docker compose version`",
  },
  E_PLAN_REFUSED: {
    meaning:
      "A read-only administrator plan established that the command would refuse to run.",
    readFirst: "Read `error.detail.plan.refused`; no planned step ran.",
  },
  E_PLAN_INCOMPLETE: {
    meaning: "An administrator plan cannot yet determine every required phase.",
    readFirst:
      "Read `error.detail.plan.blocked` and re-plan after its prerequisites are satisfied.",
  },
  E_STARTUP_INCOMPLETE: {
    meaning:
      "After start or restart, a service is neither running nor a successful one-shot.",
    readFirst: "`hack ps --json`",
  },
  E_PROJECT_RUNNING: {
    meaning:
      "The command needs the project stopped, and some of its containers (or containers using its volumes) are running; nothing was changed. `error.detail.running` names them. Hack never stops them for you.",
    readFirst: "`hack ps --json`",
  },
  E_BACKUP_INVALID: {
    meaning:
      "The directory given to `hack data import` is not a complete, intact `hack data export` backup: an interrupted `.partial` directory, no or an unreadable manifest, or a tar missing or not matching its recorded size and sha256. Nothing was changed.",
    readFirst: "`ls -l <backup dir from the message>`",
  },
  E_DATA_TARGET_CONFLICT: {
    meaning:
      "A volume `hack data import` would restore into already holds data, its labels name another project or key, it is not a plain local volume, or it was replaced while the import created it; Hack never overwrites or touches it, and nothing was written to it. `error.detail.conflicts` names each volume and why.",
    readFirst: "`docker volume inspect <volume from the message>`",
  },
  E_RECOVERY_REQUIRED: {
    meaning:
      "The last native run of this instance has no confirmed shutdown (its owner exited before finishing it, or another start replaced it), so `up` started nothing. `hack down --recover` finishes that cleanup with data kept, starting the native runtime if it needs to.",
    readFirst: "`hack down --recover`",
  },
  E_DOWN_INCOMPLETE: {
    meaning:
      "After down, a container of the instance may still run. `error.detail.running` names this checkout's services, `error.detail.foreign` another checkout's containers and their working dir (stop them from there), and `error.detail.unknown` means the containers could not be listed.",
    readFirst: "`hack ps --json`",
  },
  E_DEPENDENCY_BOOTSTRAP_FAILED: {
    meaning: "A dependency installer service did not complete successfully.",
    readFirst: "`hack logs <service> --json --no-follow --tail 200`",
  },
  E_STARTUP_TIMEOUT: {
    meaning: "Bounded startup ran out of time before services settled.",
    readFirst: "`hack ps --json`",
  },
  E_CANCELLED: {
    meaning:
      "The caller cancelled the operation; pending ownership is retained.",
    readFirst: "`hack ps --json`",
  },
  E_LIFECYCLE_FAILED: {
    meaning: "A lifecycle hook or host process failed.",
    readFirst: "`hack projects --details`",
  },
  E_ENV_KEY_MISSING: {
    meaning:
      "The selected env overlay cannot supply keys the command requires; the detail lists names only.",
    readFirst: "`hack env explain <key> --service <service>`",
  },
  E_ENV_TOO_LARGE: {
    meaning:
      "The Compose environment exceeds the platform limit for a new process (ARG_MAX, or MAX_ARG_STRLEN for one variable), so Compose was not started; the detail has byte counts only.",
    readFirst: "`hack env list --json`",
  },
  E_PERMISSION: {
    meaning:
      "A filesystem or runtime permission was denied, or a file Hack must write is on a read-only filesystem.",
    readFirst: "`hack doctor --json`",
  },
  E_NO_SPACE: {
    meaning:
      "A file Hack must write could not be written because the disk is full or the disk quota is exceeded.",
    readFirst: "`df -h <path from the message>`",
  },
  E_DATA_CLEANUP_RECORD: {
    meaning:
      "`hack data cleanup --nonce` found no usable cleanup record for that nonce under `$HACK_HOME/data-cleanup/`, or the record's project, instance, env selection or engine endpoint no longer matches what this project's managed env selects; nothing was listed or removed and no engine was contacted.",
    readFirst: "`ls $HACK_HOME/data-cleanup/`",
  },
  E_PATH_CONFLICT: {
    meaning:
      "A path Hack must read or write is the wrong kind of entry: a file where a directory is needed, or a directory or special file where a regular file is needed.",
    readFirst: "`ls -ld <path from the message>`",
  },
  E_PROJECT_EXISTS: {
    meaning:
      "The project is already initialized, so init wrote nothing; it never overwrites an existing project directory.",
    readFirst: "`hack doctor --json`",
  },
  E_LOCKED: {
    meaning:
      "A lock Hack needs stayed held for the whole bounded wait, by another Hack command or by a stale lock Hack cannot prove abandoned; nothing guarded by it was written.",
    readFirst: "`ls -l <lock path from the message>`",
  },
  E_INTERACTIVE_REQUIRED: {
    meaning:
      "The command needs an answer at a prompt but is running without one.",
    readFirst: "`hack <command> --help`",
  },
  E_COMMAND_NOT_FOUND: {
    meaning:
      "No background command with this id exists for the selected project and instance.",
    readFirst:
      "`hack commands show <id> --json` from the project that started it",
  },
  E_RESULT_EXPIRED: {
    meaning:
      "The background command's result passed its retention and its output was removed; it is never re-run.",
    readFirst: "`hack commands show <id> --json`",
  },
  E_CURSOR_EXPIRED: {
    meaning:
      "A read cursor is from another journal generation or past the end; the read returned a gap with the earliest cursor.",
    readFirst: "`hack commands read <id> --json` without `--after`",
  },
  E_CAPTURE_DISABLED: {
    meaning:
      "Output capture for background commands is turned off in the global config.",
    readFirst: "`hack config get backgroundCommands --global`",
  },
  E_ADMISSION_LIMIT: {
    meaning:
      "Too many background commands are active for this session or Hack home.",
    readFirst: "`hack commands show <id> --json` for the running commands",
  },
  E_REQUEST_CONFLICT: {
    meaning:
      "A background request key was reused with different inputs; the earlier command is unchanged.",
    readFirst: "`hack commands show <id> --json`",
  },
  E_JOURNAL_VERSION: {
    meaning:
      "A background command journal was written by a newer Hack journal format.",
    readFirst: "`hack --version`",
  },
  E_DAEMON_SERVICE: {
    meaning:
      "hackd or its login service could not be started, stopped, restarted, installed or repaired, or Hack refused because it could not prove the daemon or service belongs to this Hack home and executable.",
    readFirst: "`hack daemon status --json`",
  },
  E_USAGE: {
    meaning: "Arguments or flags were invalid for the command.",
    readFirst: "`hack <command> --help`",
  },
  E_UNEXPECTED: {
    meaning: "An unclassified failure; the message is the only detail.",
    readFirst: "`hack doctor --json`",
  },
};

/**
 * Render the `hack-diagnose` error-code reference from the exported registry.
 * One table row per code, in registry order.
 */
export function renderErrorCodeReference(): string {
  const rows = HACK_ERROR_CODES.map((code) => {
    const guide = ERROR_CODE_GUIDES[code];
    return `| \`${code}\` | ${guide.meaning} | ${guide.readFirst} |`;
  });
  return [
    "# Hack error codes",
    "",
    "Commands run with `--json` print one envelope. A failure has the shape",
    "`{ok: false, error: {code, message}}`; branch on `code`, not on `message`.",
    "Each read-first step only inspects state. Repairs such as `hack doctor --fix`",
    "stay within the request.",
    "",
    "| Code | Meaning | Read first |",
    "| --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}
