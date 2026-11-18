import type { DaemonStatusReport } from "../daemon/status.ts";

export const CANDIDATE_DAEMON_GUIDANCE =
  "hackd is optional for candidate Compose workflows; daemon autostart and automatic repair are disabled.";

/** Diagnostic text must not send a candidate user to the stable daemon on PATH. */
export function buildDoctorDaemonCheck(opts: {
  readonly report: DaemonStatusReport;
  readonly candidate: boolean;
  /**
   * Why hackd would refuse to start (for example a home directory writable
   * by others), from `diagnoseDaemonDirectory`; null when it would start.
   */
  readonly startRefusal?: string | null;
}): {
  readonly name: "daemon";
  readonly status: "ok" | "warn";
  readonly message: string;
} {
  const { report } = opts;
  if (report.status === "running") {
    return {
      name: "daemon",
      status: "ok",
      message: `hackd running (pid ${report.pid ?? "unknown"})`,
    };
  }
  if (opts.startRefusal) {
    return {
      name: "daemon",
      status: "warn",
      message: `hackd cannot start: ${opts.startRefusal}`,
    };
  }
  if (opts.candidate) {
    return {
      name: "daemon",
      status: report.status === "stopped" ? "ok" : "warn",
      message: `hackd ${report.status}${report.stale ? " (stale pid/socket)" : ""}; ${CANDIDATE_DAEMON_GUIDANCE}`,
    };
  }
  if (report.status === "starting") {
    return {
      name: "daemon",
      status: "warn",
      message: `hackd starting (pid ${report.pid ?? "unknown"}): API not responding`,
    };
  }
  if (report.status === "incompatible") {
    return {
      name: "daemon",
      status: "warn",
      message: `hackd is running but incompatible (run: ${report.nextStep})`,
    };
  }
  return {
    name: "daemon",
    status: "warn",
    message: report.stale
      ? `hackd not running (stale pid/socket; run: ${report.nextStep})`
      : "hackd not running (run: hack daemon start)",
  };
}
