import { HackCliError } from "./cli-result.ts";

/**
 * Native image-project `up` and `restart` run one whole-project foreground
 * owner. Each option that owner cannot honor is refused by name, with the
 * supported form, as a closed `E_USAGE` error: the top-level handler prints the
 * one-line message (no command help, no stack). The refusal happens before
 * project discovery, input acquisition or any runtime request.
 */
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
    refuse(
      `Native \`${command}\` runs in the foreground only, so --detach is not supported. Run \`${command}\` without --detach in its own terminal and keep it open; use \`hack ps\` and \`hack logs\` from another terminal, and press Ctrl-C to stop it.`
    );
  }
  if (opts.json) {
    refuse(
      `Native \`${command}\` does not support --json because it stays in the foreground until stopped. Run it without --json and use \`hack ps --json\` from another terminal for status.`
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
