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
  E_DOCKER_UNAVAILABLE: {
    meaning: "The container runtime CLI or engine cannot be reached.",
    readFirst: "`hack doctor --json`",
  },
  E_GLOBAL_INFRA_DOWN: {
    meaning: "Shared global infrastructure the command needs is offline.",
    readFirst: "`hack global status`",
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
  E_PROJECT_NOT_FOUND: {
    meaning:
      "No Hack project resolved from the working directory, `--project` or `--path`.",
    readFirst: "`hack projects --json`",
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
  E_STARTUP_INCOMPLETE: {
    meaning:
      "After start or restart, a service is neither running nor a successful one-shot.",
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
  E_PATH_CONFLICT: {
    meaning:
      "A path Hack must read or write is the wrong kind of entry: a file where a directory is needed, or a directory or special file where a regular file is needed.",
    readFirst: "`ls -ld <path from the message>`",
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
