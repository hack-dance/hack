import { run } from "./shell.ts";
import { openTerminalControl } from "./tty-process-group.ts";

/**
 * Native macOS administrator authorization (`sudo -v`) shared by native
 * repairs and DNS activation.
 *
 * Contract:
 * - The caller has already obtained the human confirmation and released the
 *   terminal. No spinner or prompt may draw while sudo shows its password
 *   prompt; a redrawing spinner erases the prompt before the user sees it.
 * - Hack must own the terminal's foreground process group. `run` then hands the
 *   foreground to the sudo child's own group and restores it afterwards. A
 *   background invocation is refused before sudo runs.
 * - Later privileged steps use `sudo -n` with the ticket this call caches, so
 *   no `sudo -n` step may run before this call succeeds.
 * - Any non-zero exit is an authorization failure, never a decline: the user
 *   already approved the change. sudo reports an interrupted or timed-out first
 *   password read as "a password is required".
 */
export const ADMINISTRATOR_PROMPT_TIMEOUT_MS = 120_000;

/** Remediation shown with every authorization failure. */
export const ADMINISTRATOR_PROMPT_HINT =
  'Run "sudo -v" in this terminal first, then retry.';

export type AdministratorAuthorizationFailure =
  /** Hack is not the terminal's foreground job, so sudo cannot read a password. */
  | "not-foreground"
  | "timed-out"
  | "interrupted"
  /** sudo exited non-zero, for example after three wrong passwords. */
  | "rejected";

export type AdministratorAuthorization =
  | { readonly status: "authorized" }
  | {
      readonly status: "failed";
      readonly failure: AdministratorAuthorizationFailure;
      /** The sudo exit code; null when sudo never ran. */
      readonly exitCode: number | null;
    };

export interface AdministratorAuthorizationDependencies {
  readonly runCommand: typeof run;
  /** True when this process group owns the controlling terminal's foreground. */
  readonly ownsTerminalForeground: () => boolean;
}

/**
 * Whether this process may hand the terminal to a prompting child. An
 * unavailable terminal-control library is unknown, not a refusal: sudo then
 * reports its own failure.
 */
export function ownsTerminalForeground(): boolean {
  let terminal: ReturnType<typeof openTerminalControl>;
  try {
    terminal = openTerminalControl();
  } catch {
    return true;
  }
  try {
    const foreground = terminal.foreground();
    return foreground > 0 && foreground === terminal.group();
  } finally {
    terminal.close();
  }
}

const DEFAULTS: AdministratorAuthorizationDependencies = {
  runCommand: run,
  ownsTerminalForeground,
};

/** Show the native administrator prompt once and classify its outcome. */
export async function requestAdministratorAuthorization(
  opts: {
    readonly dependencies?: Partial<AdministratorAuthorizationDependencies>;
  } = {}
): Promise<AdministratorAuthorization> {
  const deps = { ...DEFAULTS, ...opts.dependencies };
  if (!deps.ownsTerminalForeground()) {
    return { status: "failed", failure: "not-foreground", exitCode: null };
  }
  const exitCode = await deps.runCommand(["sudo", "-v"], {
    stdin: "inherit",
    timeoutMs: ADMINISTRATOR_PROMPT_TIMEOUT_MS,
    forwardSignals: true,
  });
  if (exitCode === 0) {
    return { status: "authorized" };
  }
  let failure: AdministratorAuthorizationFailure = "rejected";
  if (exitCode === 124) {
    failure = "timed-out";
  } else if (exitCode === 130 || exitCode === 143) {
    failure = "interrupted";
  }
  return { status: "failed", failure, exitCode };
}

/** Control-free phrase naming why authorization did not complete. */
export function describeAdministratorAuthorizationFailure(
  result: Extract<AdministratorAuthorization, { readonly status: "failed" }>
): string {
  switch (result.failure) {
    case "not-foreground":
      return "Hack is not the terminal's foreground job, so the macOS administrator prompt cannot read a password";
    case "timed-out":
      return `the macOS administrator prompt timed out after ${ADMINISTRATOR_PROMPT_TIMEOUT_MS / 1000} seconds`;
    case "interrupted":
      return "the macOS administrator prompt was interrupted";
    default:
      return `sudo -v did not accept the administrator password (exit ${result.exitCode ?? "unknown"})`;
  }
}
