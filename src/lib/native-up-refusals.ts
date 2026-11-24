import { HackCliError } from "./cli-result.ts";

export const NATIVE_AUTHORED_ATTEMPT_LIMIT = "native_graph_attempt_limit";

export class NativeAuthoredAttemptLimitError extends HackCliError {
  constructor() {
    super({
      code: "E_STARTUP_INCOMPLETE",
      message:
        "The native authored graph limit is 64 attempts. Active workloads, persistent storage, private environment records, or unfinished cleanup and recovery can keep attempts in the active inventory. Run hack doctor --native-cleanup inspect for cleanup guidance.",
      detail: { nativeCode: NATIVE_AUTHORED_ATTEMPT_LIMIT },
    });
  }
}

/**
 * Native image-project `up` and `restart` run one whole-project foreground
 * owner. Each option that owner cannot honor is refused by name, with the
 * supported form, as a closed `E_USAGE` error: the top-level handler prints the
 * one-line message (no command help, no stack). The refusal happens before
 * project discovery, input acquisition or any runtime request.
 */
/**
 * The one-line `E_USAGE` refusal for internal foreground entry points. Public
 * `up --detach` launches a background frontend before reaching this helper;
 * `restart --detach` still refuses on both image and authored paths.
 */
export function nativeForegroundDetachRefusal(opts: {
  readonly restart: boolean;
}): HackCliError {
  const command = opts.restart ? "hack restart" : "hack up";
  return new HackCliError({
    code: "E_USAGE",
    message: `Native \`${command}\` runs in the foreground only, so --detach is not supported. Run \`${command}\` without --detach in its own terminal and keep it open; use \`hack ps\` and \`hack logs\` from another terminal, and press Ctrl-C to stop it.`,
  });
}

export function refuseUnsupportedNativeUpOptions(opts: {
  readonly restart: boolean;
  readonly detach?: boolean;
  readonly json?: boolean;
  readonly target?: string;
  readonly services?: readonly string[];
}): void {
  const command = opts.restart ? "hack restart" : "hack up";
  const refuse = (message: string): never => {
    throw new HackCliError({ code: "E_USAGE", message });
  };
  if (opts.detach) {
    throw nativeForegroundDetachRefusal({ restart: opts.restart });
  }
  if (opts.json) {
    // Plain `restart --json` runs a detached restart (see handleRestart);
    // only frontend recovery, which stays in the foreground, reaches here.
    refuse(
      opts.restart
        ? "Native `hack restart` does not support --json with --recover-frontend, because recovery stays in the foreground until stopped. Run the recovery without --json and use `hack ps --json` from another terminal for status."
        : `Native \`${command}\` does not support --json because it stays in the foreground until stopped. Run it without --json and use \`hack ps --json\` from another terminal for status.`
    );
  }
  if (opts.target) {
    refuse(
      `Native \`${command}\` does not support --target; it starts the selected project on this host. Run it without --target.`
    );
  }
  if (opts.services && opts.services.length > 0) {
    refuse(
      `Native \`${command}\` starts the whole project; service selection is not supported. Run it without service names.`
    );
  }
}
