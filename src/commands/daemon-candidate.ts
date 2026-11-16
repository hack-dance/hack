import { DAEMON_CLI_VERSION, isCandidateRun } from "../daemon/client.ts";
import { currentCandidateLauncher } from "../lib/candidate-launcher.ts";
import { quoteShellWord } from "../lib/logs.ts";

/**
 * What `hack daemon` does differently in a candidate run (HACK-2263).
 *
 * The hackd login service (launchd plist or hackd.service) belongs to the
 * stable `hack`: its program is the stable binary. A candidate run therefore
 * never starts, kickstarts, rewrites, installs or removes it, and never
 * replaces a running hackd of another version, which on a shared Hack home
 * is the stable one. It starts only its own bundle's hackd
 * (`resolveDaemonLaunch` in `src/daemon/executing-cli.ts`). Whether a run
 * is a candidate run is {@link isCandidateRun}.
 */

/**
 * The one-sentence refusal when a candidate run finds a hackd of another
 * version running for its Hack home; null when nothing is refused.
 */
export function candidateRunningDaemonRefusal(opts: {
  readonly pid: number;
  /** What hackd's API reported; null when it did not answer. */
  readonly version: string | null;
  /**
   * Positive evidence only: hackd's API answered with this CLI's version.
   * An API that did not answer is unknown, never compatible.
   */
  readonly compatible: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): string | null {
  if (opts.compatible || !isCandidateRun(opts.env ?? process.env)) {
    return null;
  }
  if (opts.version === null) {
    return `hackd (pid ${opts.pid}) runs for this Hack home but did not report its version, so this candidate (${DAEMON_CLI_VERSION}) leaves it alone; check it with: hack daemon status`;
  }
  return `hackd version ${opts.version} (pid ${opts.pid}) runs for this Hack home and this candidate (${DAEMON_CLI_VERSION}) does not stop or replace it; stop it with the Hack that started it, then run this command again.`;
}

/**
 * The one-sentence refusal when a candidate run finds hackd processes the
 * pid file does not track for its Hack home (orphans): their version is
 * unknown, so a candidate never signals them. Null when there are none.
 */
export function candidateOrphanRefusal(opts: {
  readonly pids: readonly number[];
}): string | null {
  if (opts.pids.length === 0) {
    return null;
  }
  return `hackd process ${opts.pids.join(", ")} holds this Hack home without its pid file, and this candidate does not stop a hackd it cannot identify; stop it with the Hack that started it, then run this command again.`;
}

/**
 * The one-sentence refusal for `hack daemon install|uninstall` in a
 * candidate run; null for an ordinary run.
 */
export function candidateServiceCommandRefusal(opts: {
  readonly command: "install" | "uninstall";
  readonly env?: Readonly<Record<string, string | undefined>>;
}): string | null {
  if (!isCandidateRun(opts.env ?? process.env)) {
    return null;
  }
  const launcher = quoteShellWord(currentCandidateLauncher().command);
  return `A candidate run does not ${opts.command} the hackd login service, which runs the stable hack; start this candidate's hackd with: ${launcher} daemon start`;
}
