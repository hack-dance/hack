import type { DaemonServiceSummary } from "../daemon/service-summary.ts";

/** The doctor check row for the hackd login service (Linux, systemd). */
export const DAEMON_SERVICE_CHECK = "daemon service";

export type DaemonServiceCheck = {
  readonly name: typeof DAEMON_SERVICE_CHECK;
  readonly status: "ok" | "warn";
  readonly message: string;
};

/**
 * Maps the shared service summary to a doctor row. The message and fix are
 * the ones `hack daemon status` prints, so doctor and status agree. Returns
 * null when there is nothing to report (not Linux, or systemd management is
 * disabled for this process).
 */
export function buildDaemonServiceCheck(
  summary: DaemonServiceSummary | null
): DaemonServiceCheck | null {
  if (summary?.manager !== "systemd") {
    return null;
  }
  const fix = summary.nextStep ? ` (run: ${summary.nextStep})` : "";
  return {
    name: DAEMON_SERVICE_CHECK,
    status: summary.severity,
    message: `hackd systemd user service: ${summary.summary}${fix}`,
  };
}

export type DaemonServiceFixDecision =
  | { readonly kind: "none" }
  | { readonly kind: "skip"; readonly reason: string; readonly command: string }
  | { readonly kind: "install" };

/**
 * Whether `hack doctor --fix` should offer `hack daemon install`. Only a
 * missing, drifted or disabled unit qualifies; linger is never changed. The
 * install writes outside the project and enables a login service, so the
 * caller must confirm it as a destructive step (declined without a TTY).
 * A candidate run or HACK_DAEMON_AUTOSTART_DISABLE=1 skips it, as it skips
 * the hackd repair, because the install starts a daemon.
 */
export function decideDaemonServiceFix(opts: {
  readonly summary: DaemonServiceSummary | null;
  readonly autostart:
    | { readonly allowed: true }
    | { readonly allowed: false; readonly message: string };
}): DaemonServiceFixDecision {
  const { summary } = opts;
  if (
    summary?.manager !== "systemd" ||
    summary.nextStep !== "hack daemon install"
  ) {
    return { kind: "none" };
  }
  if (!opts.autostart.allowed) {
    return {
      kind: "skip",
      reason: opts.autostart.message,
      command: summary.nextStep,
    };
  }
  return { kind: "install" };
}
