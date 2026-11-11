import type { DaemonPaths } from "../daemon/paths.ts";
import {
  type DaemonServiceSummary,
  summarizeSystemdService,
} from "../daemon/service-summary.ts";
import { readDaemonStatus } from "../daemon/status.ts";
import {
  defaultSystemdDeps,
  describeSystemdUnavailable,
  installSystemdUnit,
  isPidInSystemdUnit,
  LINGER_ENABLE_COMMAND,
  probeSystemdUserManager,
  readLingerStatus,
  readSystemdServiceStatus,
  resolveExpectedSystemdUnit,
  resolveSystemdAccess,
  resolveSystemdUnitPath,
  SYSTEMD_UNIT_NAME,
  type SystemdDeps,
  type SystemdServiceStatus,
  systemdServiceAction,
  uninstallSystemdUnit,
} from "../daemon/systemd.ts";
import { HackCliError } from "../lib/cli-result.ts";
import { pathExists } from "../lib/fs.ts";
import { logger } from "../ui/logger.ts";

/**
 * Linux `hack daemon` effects through the systemd user manager. Decisions
 * live in `src/daemon/systemd.ts` and `src/daemon/service-summary.ts`; this
 * file sequences them and prints. `deps` is injectable so tests drive it with
 * a fake `systemctl`.
 */

const JOURNAL_HINT = `journalctl --user -u ${SYSTEMD_UNIT_NAME} -n 50`;
const READY_TIMEOUT_MS = 8000;

export interface SystemdCommandHooks {
  readonly paths: DaemonPaths;
  readonly deps?: SystemdDeps;
  /** Starts hackd directly in its own session (the non-service path). */
  readonly startDetached: () => Promise<number>;
  /** Stops a directly started hackd by pid and removes its pid/socket files. */
  readonly stopDirect: (pid: number) => Promise<void>;
  readonly waitForReady: (timeoutMs: number) => Promise<boolean>;
  /** Defaults to {@link resolveExpectedSystemdUnit}; tests pin the program. */
  readonly resolveExpected?: typeof resolveExpectedSystemdUnit;
}

/** Status for `daemon status` and doctor; null off Linux or when access is denied. */
export async function resolveSystemdStatus(
  opts: {
    readonly deps?: SystemdDeps;
    readonly platform?: NodeJS.Platform;
  } = {}
): Promise<{
  readonly status: SystemdServiceStatus;
  readonly deps: SystemdDeps;
} | null> {
  if ((opts.platform ?? process.platform) !== "linux") {
    return null;
  }
  const deps = opts.deps ?? defaultSystemdDeps();
  if (!resolveSystemdAccess({ env: deps.env }).allowed) {
    return null;
  }
  const status = await readSystemdServiceStatus({
    unitPath: resolveSystemdUnitPath({ env: deps.env }),
    deps,
  });
  return status ? { status, deps } : null;
}

/** The shared summary for status output and doctor. */
export async function resolveSystemdSummary(opts: {
  readonly paths: DaemonPaths;
  readonly deps?: SystemdDeps;
  readonly platform?: NodeJS.Platform;
}): Promise<DaemonServiceSummary | null> {
  const resolved = await resolveSystemdStatus(opts);
  if (!resolved) {
    return null;
  }
  const daemon = await readDaemonStatus({ paths: opts.paths });
  return summarizeSystemdService({
    status: resolved.status,
    daemonPid: daemon.pid,
    daemonRunning: daemon.running,
    daemonInUnit:
      daemon.running && daemon.pid !== null
        ? await isPidInSystemdUnit({ pid: daemon.pid })
        : null,
  });
}

/**
 * `hack daemon start` when hackd.service is installed: start through systemd
 * so one manager owns the socket and pid file. Returns null when the unit is
 * not installed or systemd is unavailable; the caller then starts hackd
 * directly. A unit whose program no longer exists (an upgrade moved the
 * binary) is rewritten first.
 */
export async function startViaSystemdIfInstalled(
  hooks: Omit<SystemdCommandHooks, "startDetached" | "stopDirect">
): Promise<number | null> {
  const deps = hooks.deps ?? defaultSystemdDeps();
  if (!resolveSystemdAccess({ env: deps.env }).allowed) {
    return null;
  }
  const unitPath = resolveSystemdUnitPath({ env: deps.env });
  if (!(await pathExists(unitPath))) {
    return null;
  }
  const status = await readSystemdServiceStatus({
    unitPath,
    deps,
  });
  if (!status) {
    return null;
  }
  if (!status.availability.available) {
    logger.warn({
      message: `${SYSTEMD_UNIT_NAME} is installed but ${describeSystemdUnavailable(status.availability)}; starting hackd directly`,
    });
    return null;
  }
  // Rewrite the unit before starting when its program is gone, or when the
  // `hack` this CLI resolves is a different program: otherwise systemd would
  // start an old, incompatible hackd that `hack daemon start` then replaces,
  // on every start (the loop `repairLaunchdProgramIfInvalid` prevents on
  // macOS). This runs only when hackd is about to start, never against a
  // running daemon; status and doctor stay independent of PATH.
  const expected = await (
    hooks.resolveExpected ?? resolveExpectedSystemdUnit
  )();
  const programChanged =
    expected !== null &&
    status.drift !== "program-missing" &&
    expected.hackBinPath !== status.program;
  if (status.drift === "program-missing" || programChanged) {
    if (!expected) {
      logger.error({
        message: `${SYSTEMD_UNIT_NAME} runs a program that no longer exists (${status.program ?? "unreadable ExecStart"}) and no installed hack was found to replace it | Put hack on PATH, then run: hack daemon install`,
      });
      return 1;
    }
    const repaired = await installSystemdUnit({
      unitPath,
      unitText: expected.unitText,
      deps,
      // Keep the user's choice: a disabled unit is repaired, not re-enabled.
      enable: status.enabled,
    });
    if (!repaired.ok) {
      logger.error({
        message: `Failed to repair ${SYSTEMD_UNIT_NAME}: ${repaired.error}`,
      });
      return 1;
    }
    logger.warn({
      message: programChanged
        ? `Updated ${SYSTEMD_UNIT_NAME} to run ${expected.hackBinPath} (it ran ${status.program ?? "another program"})`
        : `Repaired ${SYSTEMD_UNIT_NAME}: its program no longer existed; it now runs ${expected.hackBinPath}`,
    });
  }
  // After a crash loop systemd refuses `start` ("start request repeated too
  // quickly") until the failed state is cleared. Clearing is harmless when
  // the unit is not failed.
  if (status.activeState === "failed") {
    await systemdServiceAction({ action: "reset-failed", deps });
  }
  const started = await systemdServiceAction({ action: "start", deps });
  if (!started.ok) {
    logger.error({
      message: `systemctl --user start ${SYSTEMD_UNIT_NAME} failed: ${started.error} | Check: ${JOURNAL_HINT}`,
    });
    return 1;
  }
  if (await hooks.waitForReady(READY_TIMEOUT_MS)) {
    logger.success({ message: "hackd started (systemd)" });
    return 0;
  }
  logger.warn({
    message: `systemd started hackd but it did not report ready yet | Check: hack daemon logs --tail 200 and ${JOURNAL_HINT}`,
  });
  return 1;
}

/**
 * `hack daemon stop` when systemd runs the tracked hackd: stop it through
 * systemctl so the manager records a clean stop (no restart, unit inactive).
 * Returns false when systemd does not own `pid`; the caller signals it.
 */
export async function stopViaSystemdIfOwned(opts: {
  readonly pid: number;
  readonly deps?: SystemdDeps;
}): Promise<boolean> {
  const deps = opts.deps ?? defaultSystemdDeps();
  if (!resolveSystemdAccess({ env: deps.env }).allowed) {
    return false;
  }
  const unitPath = resolveSystemdUnitPath({ env: deps.env });
  if (!(await pathExists(unitPath))) {
    return false;
  }
  const status = await readSystemdServiceStatus({
    unitPath,
    deps,
  });
  const owned =
    status?.active === true &&
    (status.mainPid === opts.pid ||
      (await isPidInSystemdUnit({ pid: opts.pid })) === true);
  if (!owned) {
    return false;
  }
  const stopped = await systemdServiceAction({ action: "stop", deps });
  if (!stopped.ok) {
    logger.warn({
      message: `systemctl --user stop ${SYSTEMD_UNIT_NAME} failed (${stopped.error}); signalling hackd directly`,
    });
    return false;
  }
  return true;
}

function assertSystemdAccess(deps: SystemdDeps): void {
  const access = resolveSystemdAccess({ env: deps.env });
  if (!access.allowed) {
    throw new HackCliError({
      code: "E_PERMISSION",
      message: access.message,
      detail: { reason: access.reason },
    });
  }
}

/**
 * `hack daemon install` on Linux: write and enable hackd.service, hand a
 * directly started hackd over to systemd, start it, and report linger.
 *
 * Without a usable user manager (no systemctl, no user bus, a container or
 * WSL without systemd) nothing is written: it explains why, starts hackd
 * directly in its own session instead, and exits 1 because the service was
 * not installed.
 */
export async function installDaemonSystemdService(
  hooks: SystemdCommandHooks & { readonly ignoredOptions: readonly string[] }
): Promise<number> {
  const deps = hooks.deps ?? defaultSystemdDeps();
  assertSystemdAccess(deps);
  if (hooks.ignoredOptions.length > 0) {
    logger.info({
      message: `Ignoring macOS launchd options on Linux: ${hooks.ignoredOptions.join(", ")}`,
    });
  }

  const availability = await probeSystemdUserManager(deps);
  if (!availability.available) {
    logger.warn({
      message: `Cannot install the hackd systemd user service: ${describeSystemdUnavailable(availability)}`,
    });
    logger.info({
      message:
        "Starting hackd directly instead. It keeps running after this shell exits, but not across logout or reboot.",
    });
    await hooks.startDetached();
    return 1;
  }

  const expected = await (
    hooks.resolveExpected ?? resolveExpectedSystemdUnit
  )();
  if (!expected) {
    logger.error({
      message:
        "Could not resolve an installed hack executable for the systemd unit | Install hack so `hack` is on PATH, then run: hack daemon install",
    });
    return 1;
  }

  const unitPath = resolveSystemdUnitPath({ env: deps.env });
  const before = await readSystemdServiceStatus({
    unitPath,
    deps,
  });
  const installed = await installSystemdUnit({
    unitPath,
    unitText: expected.unitText,
    deps,
  });
  if (!installed.ok) {
    logger.error({
      message: `Failed to install the hackd systemd user service: ${installed.error}`,
    });
    return 1;
  }
  if (installed.changed) {
    logger.success({
      message: before?.installed
        ? `Updated ${SYSTEMD_UNIT_NAME} (the unit had drifted)`
        : `Installed ${SYSTEMD_UNIT_NAME}`,
    });
  } else {
    logger.info({
      message: `${SYSTEMD_UNIT_NAME} already installed (unit unchanged)`,
    });
  }
  logger.info({ message: `  Unit: ${unitPath}` });
  logger.info({
    message: `  Runs: ${expected.hackBinPath} daemon start --foreground`,
  });

  // A directly started hackd holds the socket and pid file; systemd's copy
  // would exit at once. Stop it so the service owns the daemon.
  const daemon = await readDaemonStatus({ paths: hooks.paths });
  const managedPid = before?.active ? before.mainPid : null;
  if (daemon.running && daemon.pid !== null && daemon.pid !== managedPid) {
    logger.info({
      message: `Stopping directly started hackd (pid ${daemon.pid}) so systemd can manage it`,
    });
    await hooks.stopDirect(daemon.pid);
  }

  const action =
    installed.changed && before?.active
      ? ("restart" as const)
      : ("start" as const);
  if (before?.activeState === "failed") {
    await systemdServiceAction({ action: "reset-failed", deps });
  }
  const started = await systemdServiceAction({ action, deps });
  if (!started.ok) {
    logger.error({
      message: `systemctl --user ${action} ${SYSTEMD_UNIT_NAME} failed: ${started.error} | Check: ${JOURNAL_HINT}`,
    });
    return 1;
  }
  const ready = await hooks.waitForReady(READY_TIMEOUT_MS);
  if (ready) {
    logger.success({ message: "hackd running under systemd" });
  } else {
    logger.warn({
      message: `hackd did not report ready yet | Check: hack daemon status, ${JOURNAL_HINT}`,
    });
  }

  reportLinger({
    linger: await readLingerStatus(deps),
  });
  return ready ? 0 : 1;
}

function reportLinger(opts: { readonly linger: boolean | null }): void {
  const command = LINGER_ENABLE_COMMAND;
  if (opts.linger === true) {
    logger.info({
      message:
        "  Linger: on (hackd starts at boot and keeps running after logout)",
    });
    return;
  }
  if (opts.linger === false) {
    logger.warn({
      message: `Linger is off: hackd starts at login and stops when your last session ends. To keep it running without a login session, run: ${command}`,
    });
    return;
  }
  logger.info({
    message: `  Linger: unknown. If hackd must run without a login session, run: ${command}`,
  });
}

/** `hack daemon uninstall` on Linux. */
export async function uninstallDaemonSystemdService(opts: {
  readonly deps?: SystemdDeps;
}): Promise<number> {
  const deps = opts.deps ?? defaultSystemdDeps();
  assertSystemdAccess(deps);
  const unitPath = resolveSystemdUnitPath({ env: deps.env });
  const result = await uninstallSystemdUnit({ unitPath, deps });
  if (!result.ok) {
    logger.error({
      message: `Failed to uninstall the hackd systemd user service: ${result.error}`,
    });
    return 1;
  }
  if (result.notInstalled) {
    logger.info({ message: `${SYSTEMD_UNIT_NAME} was not installed` });
    return 0;
  }
  if (!result.managerNotified) {
    logger.warn({
      message: `Removed ${unitPath}, but systemctl --user is unavailable, so a running service was not stopped`,
    });
    return 0;
  }
  logger.success({
    message: `${SYSTEMD_UNIT_NAME} stopped, disabled and removed`,
  });
  return 0;
}
