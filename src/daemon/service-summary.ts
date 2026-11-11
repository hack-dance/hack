import type { LaunchdServiceStatus } from "./launchd.ts";
import {
  describeSystemdUnavailable,
  LINGER_ENABLE_COMMAND,
  type SystemdServiceStatus,
} from "./systemd.ts";

/**
 * One view of "does a service manager own hackd", shared by
 * `hack daemon status` (text and `--json`) and `hack doctor`, so all three
 * name the same next step.
 */
export interface DaemonServiceSummary {
  readonly manager: "launchd" | "systemd";
  /** The manager can be used from this session. */
  readonly available: boolean;
  readonly installed: boolean;
  /** Starts at login (systemd `enabled`); null where not reported. */
  readonly enabled: boolean | null;
  readonly active: boolean;
  readonly pid: number | null;
  /** The manager's running process is the hackd that owns the pid file. */
  readonly ownsDaemon: boolean;
  /** A command that fixes the reported problem, or null. */
  readonly nextStep: string | null;
  /** One line for text output. */
  readonly summary: string;
  readonly severity: "ok" | "warn";
}

const INSTALL_COMMAND = "hack daemon install";
const RESTART_COMMAND = "hack daemon restart";
const JOURNAL_COMMAND = "journalctl --user -u hackd.service -n 50";

/**
 * Summarizes the systemd user service. Problems are reported in priority
 * order, one at a time: unavailable manager, missing unit, drift, disabled
 * unit, a failed unit, a hackd that systemd does not run, then linger.
 */
export function summarizeSystemdService(opts: {
  readonly status: SystemdServiceStatus;
  readonly daemonPid: number | null;
  readonly daemonRunning: boolean;
}): DaemonServiceSummary {
  const { status } = opts;
  const ownsDaemon =
    status.active &&
    status.mainPid !== null &&
    opts.daemonRunning &&
    status.mainPid === opts.daemonPid;
  const base = {
    manager: "systemd" as const,
    available: status.availability.available,
    installed: status.installed,
    enabled: status.availability.available ? status.enabled : null,
    active: status.active,
    pid: status.mainPid,
    ownsDaemon,
  };

  if (!status.availability.available) {
    const why = describeSystemdUnavailable(status.availability);
    return {
      ...base,
      nextStep: null,
      summary: `unavailable: ${why}. hackd runs detached and stops at logout or reboot`,
      // A missing user bus is fixable (log in normally, or linger); a host
      // without systemd is not, so it is reported without a warning.
      severity:
        status.availability.reason === "no-user-bus" ||
        status.availability.reason === "error"
          ? "warn"
          : "ok",
    };
  }
  if (!status.installed) {
    return {
      ...base,
      nextStep: INSTALL_COMMAND,
      summary:
        "not installed: hackd stops when the session that started it ends and does not start at login",
      severity: "warn",
    };
  }
  if (status.drift === "program-missing") {
    return {
      ...base,
      nextStep: INSTALL_COMMAND,
      summary: `the unit's program no longer exists (${status.program ?? "unreadable ExecStart"})`,
      severity: "warn",
    };
  }
  if (status.drift === "content") {
    return {
      ...base,
      nextStep: INSTALL_COMMAND,
      summary:
        "the unit file differs from what hack writes (edited, or written by another hack version)",
      severity: "warn",
    };
  }
  if (!status.enabled) {
    return {
      ...base,
      nextStep: INSTALL_COMMAND,
      summary: "installed but not enabled: hackd will not start at login",
      severity: "warn",
    };
  }
  if (status.activeState === "failed") {
    return {
      ...base,
      nextStep: RESTART_COMMAND,
      summary: `hackd.service failed; see: ${JOURNAL_COMMAND}`,
      severity: "warn",
    };
  }
  if (opts.daemonRunning && !ownsDaemon) {
    // hackd was started directly (for example while the user bus was
    // unavailable), so systemd's copy exited at login. This hackd stops at
    // logout; a restart hands it to systemd.
    return {
      ...base,
      nextStep: RESTART_COMMAND,
      summary:
        "installed, but the running hackd was started directly, not by systemd, and stops at logout",
      severity: "warn",
    };
  }
  if (status.linger === false) {
    return {
      ...base,
      nextStep: LINGER_ENABLE_COMMAND,
      summary:
        "linger is off: hackd stops when your last login session ends and starts again at the next login",
      severity: "warn",
    };
  }
  const state = status.active
    ? `active${status.mainPid ? ` (pid ${status.mainPid})` : ""}`
    : `not running (${status.activeState ?? "unknown"})`;
  return {
    ...base,
    nextStep: null,
    summary: `installed, enabled, ${state}`,
    severity: "ok",
  };
}

/** The launchd equivalent; reported only, never a warning (macOS unchanged). */
export function summarizeLaunchdService(opts: {
  readonly status: LaunchdServiceStatus;
  readonly daemonPid: number | null;
  readonly daemonRunning: boolean;
}): DaemonServiceSummary {
  const { status } = opts;
  let summary = "not installed";
  if (status.installed) {
    summary = status.loaded
      ? `loaded${status.running ? "" : " (not running)"}`
      : "not loaded";
  }
  return {
    manager: "launchd",
    available: true,
    installed: status.installed,
    enabled: null,
    active: status.running,
    pid: status.pid,
    ownsDaemon:
      status.running &&
      status.pid !== null &&
      opts.daemonRunning &&
      status.pid === opts.daemonPid,
    nextStep: null,
    summary,
    severity: "ok",
  };
}

/** The `service` object in `hack daemon status --json`. */
export function serviceSummaryJson(
  summary: DaemonServiceSummary | null,
  extra: Readonly<Record<string, unknown>> = {}
): Record<string, unknown> | null {
  if (!summary) {
    return null;
  }
  return {
    manager: summary.manager,
    available: summary.available,
    installed: summary.installed,
    enabled: summary.enabled,
    active: summary.active,
    pid: summary.pid,
    owns_daemon: summary.ownsDaemon,
    summary: summary.summary,
    next_step: summary.nextStep,
    ...extra,
  };
}
