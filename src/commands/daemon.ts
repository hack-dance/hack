import type { CliContext, CommandArgs } from "../cli/command.ts";
import {
  CliUsageError,
  defineCommand,
  defineOption,
  withHandler,
} from "../cli/command.ts";
import { optJson, optTail } from "../cli/options.ts";
import type { DaemonLaunchdConfig } from "../control-plane/sdk/config.ts";
import { readControlPlaneConfig } from "../control-plane/sdk/config.ts";
import { probeDaemonApi, requestDaemonJson } from "../daemon/client.ts";
import {
  getLaunchdServiceStatus,
  installLaunchdService,
  kickstartLaunchdService,
  type LaunchdServiceStatus,
  repairLaunchdProgramIfInvalid,
  resolveLaunchdAccess,
  uninstallLaunchdService,
} from "../daemon/launchd.ts";
import { type DaemonPaths, resolveDaemonPaths } from "../daemon/paths.ts";
import {
  findOrphanDaemonProcesses,
  readDaemonPid,
  removeDaemonFilesIfStale,
  removeFileIfExists,
  terminateOrphanDaemonProcesses,
  terminateProvenDaemon,
  waitForProcessExit,
} from "../daemon/process.ts";
import { runDaemon } from "../daemon/server.ts";
import {
  type DaemonServiceSummary,
  serviceSummaryJson,
  summarizeLaunchdService,
} from "../daemon/service-summary.ts";
import { spawnDetachedDaemon } from "../daemon/spawn.ts";
import {
  buildDaemonRepairMessage,
  buildDaemonStatusReport,
  type DaemonStatusReport,
  readDaemonStatus,
} from "../daemon/status.ts";
import { HackCliError } from "../lib/cli-result.ts";
import { updateGlobalConfig } from "../lib/config.ts";
import { pathExists, readTextFile } from "../lib/fs.ts";
import { resolveHackInvocation } from "../lib/hack-cli.ts";
import {
  buildDockerStatusProbe,
  detectDockerBackend,
} from "../lib/runtime-guidance.ts";
import { logger } from "../ui/logger.ts";
import {
  describeSystemdIncompatibleOwner,
  installDaemonSystemdService,
  resolveSystemdSummary,
  startViaSystemdIfInstalled,
  stopViaSystemdIfInstalled,
  uninstallDaemonSystemdService,
} from "./daemon-systemd.ts";

const optForeground = defineOption({
  name: "foreground",
  type: "boolean",
  long: "--foreground",
  description: "Run hackd in the foreground (debug)",
} as const);

const startSpec = defineCommand({
  name: "start",
  summary: "Start hackd (local daemon)",
  group: "Diagnostics",
  options: [optForeground] as const,
  positionals: [],
  subcommands: [],
} as const);

const stopSpec = defineCommand({
  name: "stop",
  summary: "Stop hackd",
  group: "Diagnostics",
  options: [],
  positionals: [],
  subcommands: [],
} as const);

const statusSpec = defineCommand({
  name: "status",
  summary: "Show hackd status",
  group: "Diagnostics",
  options: [optJson] as const,
  positionals: [],
  subcommands: [],
} as const);

const metricsSpec = defineCommand({
  name: "metrics",
  summary: "Show hackd metrics",
  group: "Diagnostics",
  options: [] as const,
  positionals: [],
  subcommands: [],
} as const);

const logsSpec = defineCommand({
  name: "logs",
  summary: "Show hackd logs",
  group: "Diagnostics",
  options: [optTail] as const,
  positionals: [],
  subcommands: [],
} as const);

const clearSpec = defineCommand({
  name: "clear",
  summary: "Clear stale hackd pid/socket files",
  group: "Diagnostics",
  options: [],
  positionals: [],
  subcommands: [],
} as const);

const restartSpec = defineCommand({
  name: "restart",
  summary: "Restart hackd",
  group: "Diagnostics",
  options: [],
  positionals: [],
  subcommands: [],
} as const);

const optRunAtLoad = defineOption({
  name: "run-at-load",
  type: "boolean",
  long: "--run-at-load",
  description: "Start hackd automatically on login (macOS launchd)",
} as const);

const optNoRunAtLoad = defineOption({
  name: "no-run-at-load",
  type: "boolean",
  long: "--no-run-at-load",
  description: "Do not start hackd automatically on login (macOS launchd)",
} as const);

const optGuiOnly = defineOption({
  name: "gui-only",
  type: "boolean",
  long: "--gui-only",
  description: "Only run in GUI sessions (macOS launchd; default)",
} as const);

const optNoGuiOnly = defineOption({
  name: "no-gui-only",
  type: "boolean",
  long: "--no-gui-only",
  description: "Run in all session types, including SSH (macOS launchd)",
} as const);

const installSpec = defineCommand({
  name: "install",
  summary:
    "Install hackd as a login service (launchd on macOS, systemd user unit on Linux)",
  group: "Diagnostics",
  options: [optRunAtLoad, optNoRunAtLoad, optGuiOnly, optNoGuiOnly] as const,
  positionals: [],
  subcommands: [],
} as const);

const uninstallSpec = defineCommand({
  name: "uninstall",
  summary: "Uninstall the hackd login service (launchd or systemd)",
  group: "Diagnostics",
  options: [],
  positionals: [],
  subcommands: [],
} as const);

export const daemonStartCommand = withHandler(startSpec, handleDaemonStart);
export const daemonStopCommand = withHandler(stopSpec, handleDaemonStop);
export const daemonStatusCommand = withHandler(statusSpec, handleDaemonStatus);
export const daemonMetricsCommand = withHandler(
  metricsSpec,
  handleDaemonMetrics
);
export const daemonLogsCommand = withHandler(logsSpec, handleDaemonLogs);
export const daemonClearCommand = withHandler(clearSpec, handleDaemonClear);
export const daemonRestartCommand = withHandler(
  restartSpec,
  handleDaemonRestart
);
export const daemonInstallCommand = withHandler(
  installSpec,
  handleDaemonInstall
);
export const daemonUninstallCommand = withHandler(
  uninstallSpec,
  handleDaemonUninstall
);

const daemonSpec = defineCommand({
  name: "daemon",
  summary: "Manage the local hack daemon (hackd)",
  group: "Diagnostics",
  options: [],
  positionals: [],
  subcommands: [
    daemonStartCommand,
    daemonStopCommand,
    daemonRestartCommand,
    daemonStatusCommand,
    daemonMetricsCommand,
    daemonLogsCommand,
    daemonClearCommand,
    daemonInstallCommand,
    daemonUninstallCommand,
  ],
} as const);

export const daemonCommand = withHandler(
  daemonSpec,
  ({ ctx }): Promise<number> => {
    throw new CliUsageError(`Missing subcommand for ${ctx.cli.name} daemon`);
  }
);

type DaemonStartArgs = CommandArgs<typeof startSpec.options, readonly []>;
type DaemonStopArgs = CommandArgs<typeof stopSpec.options, readonly []>;
type DaemonStatusArgs = CommandArgs<typeof statusSpec.options, readonly []>;
type DaemonMetricsArgs = CommandArgs<typeof metricsSpec.options, readonly []>;
type DaemonLogsArgs = CommandArgs<typeof logsSpec.options, readonly []>;
type DaemonClearArgs = CommandArgs<typeof clearSpec.options, readonly []>;
type DaemonRestartArgs = CommandArgs<typeof restartSpec.options, readonly []>;
type DaemonInstallArgs = CommandArgs<typeof installSpec.options, readonly []>;
type DaemonUninstallArgs = CommandArgs<
  typeof uninstallSpec.options,
  readonly []
>;

async function handleDaemonStart({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: DaemonStartArgs;
}): Promise<number> {
  const paths = resolveDaemonPaths({});
  const status = await readDaemonStatus({ paths });

  if (status.running && status.pid !== null) {
    const running = await handleRunningDaemonAtStart({
      pid: status.pid,
      socketExists: status.socketExists,
      paths,
    });
    if (running !== null) {
      return running;
    }
  }

  // Daemons that outlived their pid file (e.g. a launchd-managed instance
  // surviving a manual clear/restart) hold the API socket invisibly and
  // make every freshly spawned daemon exit cleanly. Sweep them first.
  const orphans = await findOrphanDaemonProcesses({
    trackedPid: status.pid,
    daemonRoot: paths.root,
  });
  if (orphans.length > 0) {
    logger.warn({
      message: `Stopping orphaned hackd process(es) not tracked by the pid file: ${orphans.join(", ")}`,
    });
    await terminateOrphanDaemonProcesses({ pids: orphans });
  }

  // An installed hackd.service owns the daemon on Linux. Start through it
  // before touching the pid/socket files: systemd (a pending restart) or
  // another starter may be writing them right now, and hackd replaces its
  // own socket when it starts.
  if (process.platform === "linux" && !args.options.foreground) {
    const viaSystemd = await startViaSystemdIfInstalled({
      paths,
      waitForReady: (timeoutMs) => waitForDaemonStart({ paths, timeoutMs }),
    });
    if (viaSystemd !== null) {
      return viaSystemd;
    }
  }

  const raced = await clearStaleDaemonFilesBeforeStart({ paths });
  if (raced !== null) {
    return raced;
  }

  if (args.options.foreground) {
    await runDaemon({ paths, foreground: true });
    return 0;
  }

  // When launchd manages the daemon, start through launchd — spawning a
  // bare process next to a loaded agent means two process managers fight
  // over one socket and pid file.
  const launchdStatus = await resolveLaunchdStatus({ paths });
  if (launchdStatus?.loaded) {
    const repair = await repairLaunchdProgramIfInvalid({ paths });
    if (repair === "repaired") {
      logger.warn({
        message:
          "Repaired launchd service: its program path was invalid (stale or compiled-binary virtual path)",
      });
    }
    // launchd owns the daemon: never spawn a bare process next to it —
    // two process managers for one socket is how machines end up with
    // start-then-exit flapping and stale-pid contradictions.
    const kick = await kickstartLaunchdService();
    if (!kick.ok) {
      logger.error({
        message: `launchd kickstart failed: ${kick.error ?? "unknown error"} | Check: hack daemon logs --tail 200`,
      });
      return 1;
    }
    const startedViaLaunchd = await waitForDaemonStart({
      paths,
      timeoutMs: 8000,
    });
    if (startedViaLaunchd) {
      logger.success({ message: "hackd started (launchd)" });
      return 0;
    }
    logger.warn({
      message:
        "launchd kickstarted hackd but it did not report ready yet | Check: hack daemon logs --tail 200",
    });
    return 1;
  }

  return await startDaemonDetached({ paths });
}

/**
 * `hack daemon start` found a live pid. Returns an exit code when start is
 * done (already running, or an incompatible systemd-run hackd that only
 * `hack daemon install` can switch), or null after replacing an
 * incompatible directly started hackd.
 */
async function handleRunningDaemonAtStart(opts: {
  readonly pid: number;
  readonly socketExists: boolean;
  readonly paths: DaemonPaths;
}): Promise<number | null> {
  const api = await checkDaemonApi({
    socketExists: opts.socketExists,
    paths: opts.paths,
  });
  if (!(api.reachable && !api.compatible)) {
    logger.success({ message: `hackd already running (pid ${opts.pid})` });
    return 0;
  }
  // systemd runs this hackd from a unit that points at another `hack`:
  // replacing it would only make systemd start the same old binary again.
  // Say so instead (start never rewrites such a unit).
  const systemdOwner =
    process.platform === "linux"
      ? await describeSystemdIncompatibleOwner({ pid: opts.pid })
      : null;
  if (systemdOwner !== null) {
    logger.warn({ message: systemdOwner });
    return 1;
  }
  // An incompatible daemon (usually a pre-upgrade binary) must be replaced,
  // not reported as success — leaving it running is how machines end up
  // with doctor/status contradictions.
  logger.warn({ message: `Replacing incompatible hackd (pid ${opts.pid})` });
  await stopDaemonProcess({ pid: opts.pid, paths: opts.paths });
  return null;
}

/**
 * Removes the pid/socket files only while they are still stale: a
 * concurrent start may have written new ones since status was read. When it
 * finds a newer owner it waits for that daemon and returns an exit code;
 * otherwise null.
 */
async function clearStaleDaemonFilesBeforeStart(opts: {
  readonly paths: DaemonPaths;
}): Promise<number | null> {
  const { paths } = opts;
  const cleanup = await removeDaemonFilesIfStale({
    pidPath: paths.pidPath,
    socketPath: paths.socketPath,
    observedPid: await readDaemonPid({ pidPath: paths.pidPath }),
  });
  if (!cleanup.newerOwner) {
    return null;
  }
  if (await waitForDaemonStart({ paths, timeoutMs: 8000 })) {
    logger.success({ message: "hackd already started by another process" });
    return 0;
  }
  logger.warn({
    message:
      "Another process is starting hackd but it did not report ready yet | Check: hack daemon status",
  });
  return 1;
}

/**
 * Starts `hack daemon start --foreground` in its own session and process
 * group (see {@link spawnDetachedDaemon}), so it survives the shell, agent
 * or process group that ran `hack daemon start` (HACK-2052). hackd writes
 * its own log file; its stdio is not connected to the caller.
 */
async function startDaemonDetached(opts: {
  readonly paths: DaemonPaths;
}): Promise<number> {
  const { paths } = opts;
  const invocation = await resolveHackInvocation();
  spawnDetachedDaemon({
    argv: [
      invocation.bin,
      ...invocation.args,
      "daemon",
      "start",
      "--foreground",
    ],
  });

  const started = await waitForDaemonStart({ paths });
  if (!started) {
    logger.warn({
      message: "Started hackd process but it did not report ready yet",
    });
    return 1;
  }

  logger.success({ message: "hackd started" });
  return 0;
}

async function stopDaemonProcess(opts: {
  readonly pid: number;
  readonly paths: DaemonPaths;
}): Promise<void> {
  try {
    process.kill(opts.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
  const exited = await waitForProcessExit({
    pid: opts.pid,
    timeoutMs: 2000,
    pollMs: 200,
  });
  if (!exited) {
    try {
      process.kill(opts.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  await removeDaemonFilesIfStale({
    pidPath: opts.paths.pidPath,
    socketPath: opts.paths.socketPath,
    observedPid: opts.pid,
  });
}

async function handleDaemonStop({
  args: _args,
}: {
  readonly ctx: CliContext;
  readonly args: DaemonStopArgs;
}): Promise<number> {
  const paths = resolveDaemonPaths({});
  const initial = await readDaemonStatus({ paths });

  // An installed hackd.service is stopped through systemd even when the pid
  // file is missing or names a dead pid: that is how a pending
  // Restart=on-failure restart gets cancelled.
  const viaSystemd =
    process.platform === "linux"
      ? await stopViaSystemdIfInstalled({
          pid: initial.running ? initial.pid : null,
        })
      : { handled: false, ownedPid: false };
  if (viaSystemd.ownedPid && initial.pid !== null) {
    await waitForProcessExit({
      pid: initial.pid,
      timeoutMs: 5000,
      pollMs: 200,
    });
  }

  const status = viaSystemd.handled
    ? await readDaemonStatus({ paths })
    : initial;
  if (!status.pid) {
    logger.info({
      message: viaSystemd.handled
        ? "hackd stopped (systemd)"
        : "hackd is not running",
    });
    return 0;
  }

  if (!status.running) {
    await removeDaemonFilesIfStale({
      pidPath: paths.pidPath,
      socketPath: paths.socketPath,
      observedPid: status.pid,
    });
    logger.info({
      message: viaSystemd.handled
        ? "hackd stopped (systemd)"
        : "Removed stale hackd pid/socket files",
    });
    return 0;
  }

  // A directly started hackd (or one systemd did not stop in time).
  process.kill(status.pid, "SIGTERM");
  const exited = await waitForProcessExit({
    pid: status.pid,
    timeoutMs: 2000,
    pollMs: 200,
  });
  if (!exited) {
    process.kill(status.pid, "SIGKILL");
  }

  await removeDaemonFilesIfStale({
    pidPath: paths.pidPath,
    socketPath: paths.socketPath,
    observedPid: status.pid,
  });
  logger.success({ message: "hackd stopped" });
  return 0;
}

async function handleDaemonStatus({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: DaemonStatusArgs;
}): Promise<number> {
  const paths = resolveDaemonPaths({});
  const status = await readDaemonStatus({ paths });
  const api = await checkDaemonApi({
    socketExists: status.socketExists,
    paths,
  });
  const launchdStatus = await resolveLaunchdStatus({ paths });
  const report = buildDaemonStatusReport({
    pid: status.pid,
    processRunning: status.running,
    socketExists: status.socketExists,
    logExists: status.logExists,
    apiReachable: api.reachable,
    apiCompatible: api.compatible,
    serviceLoaded: launchdStatus?.loaded === true,
  });
  const service = launchdStatus
    ? summarizeLaunchdService({
        status: launchdStatus,
        daemonPid: status.pid,
        daemonRunning: status.running,
      })
    : await resolveSystemdSummary({ paths });
  const dockerBackend = await detectDockerBackend();
  const dockerStatus = await buildDockerStatusProbe();

  if (args.options.json) {
    outputDaemonStatusJson({
      report,
      paths,
      launchdStatus,
      service,
    });
    return report.status === "running" ? 0 : 1;
  }

  return reportDaemonStatus({
    report,
    launchdStatus,
    service,
    dockerBackendName: dockerBackend?.name ?? null,
    dockerReachable: dockerStatus.reachable,
  });
}

async function checkDaemonApi(opts: {
  readonly socketExists: boolean;
  readonly paths: DaemonPaths;
}): Promise<{ readonly reachable: boolean; readonly compatible: boolean }> {
  if (!opts.socketExists) {
    return { reachable: false, compatible: false };
  }
  const probe = await probeDaemonApi({
    socketPath: opts.paths.socketPath,
    timeoutMs: 500,
  });
  return { reachable: probe.reachable, compatible: probe.compatible };
}

async function resolveLaunchdStatus(opts: {
  readonly paths: DaemonPaths;
}): Promise<LaunchdServiceStatus | null> {
  if (process.platform !== "darwin") {
    return null;
  }
  return await getLaunchdServiceStatus({ paths: opts.paths });
}

function outputDaemonStatusJson(opts: {
  readonly report: DaemonStatusReport;
  readonly paths: DaemonPaths;
  readonly launchdStatus: LaunchdServiceStatus | null;
  readonly service: DaemonServiceSummary | null;
}): void {
  const payload = {
    status: opts.report.status,
    running: opts.report.running,
    api_ok: opts.report.apiOk,
    api_reachable: opts.report.apiReachable,
    api_compatible: opts.report.apiCompatible,
    process_running: opts.report.processRunning,
    stale: opts.report.stale,
    stale_reason: opts.report.staleReason,
    issue: opts.report.issue,
    next_step: opts.report.nextStep,
    pid: opts.report.pid,
    socket_path: opts.paths.socketPath,
    socket_exists: opts.report.socketExists,
    log_path: opts.paths.logPath,
    log_exists: opts.report.logExists,
    managed_by: opts.service?.ownsDaemon ? opts.service.manager : null,
    service: serviceSummaryJson(opts.service),
    launchd: opts.launchdStatus
      ? {
          installed: opts.launchdStatus.installed,
          loaded: opts.launchdStatus.loaded,
          running: opts.launchdStatus.running,
          pid: opts.launchdStatus.pid,
          exit_status: opts.launchdStatus.exitStatus,
          plist_path: opts.paths.launchdPlistPath,
        }
      : null,
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function reportDaemonStatus(opts: {
  readonly report: DaemonStatusReport;
  readonly launchdStatus: LaunchdServiceStatus | null;
  readonly service: DaemonServiceSummary | null;
  readonly dockerBackendName: string | null;
  readonly dockerReachable: boolean;
}): number {
  const { report, launchdStatus } = opts;
  if (report.status === "running") {
    logger.success({
      message: `hackd running (pid ${report.pid ?? "unknown"})`,
    });
    logLaunchdStatus({ launchdStatus, running: true });
    logSystemdStatus({ service: opts.service });
    return 0;
  }

  if (report.status === "starting") {
    logger.warn({
      message: `hackd starting (pid ${report.pid ?? "unknown"}): API not responding yet`,
    });
    logSystemdStatus({ service: opts.service });
    return 1;
  }

  if (report.status === "incompatible") {
    logger.warn({
      message: `hackd is running but incompatible with this CLI; run \`${report.nextStep}\``,
    });
    logLaunchdStatus({ launchdStatus, running: true });
    logSystemdStatus({ service: opts.service });
    return 1;
  }

  logger.warn({
    message: buildDaemonRepairMessage({
      report,
      launchdStatus,
      dockerBackendName: opts.dockerBackendName,
      dockerReachable: opts.dockerReachable,
    }),
  });
  logLaunchdStatus({ launchdStatus, running: false });
  logSystemdStatus({ service: opts.service });
  return 1;
}

/**
 * Linux only: one line naming who manages hackd and, when something is
 * wrong, the same `next_step` that `status --json` reports under `service`.
 */
function logSystemdStatus(opts: {
  readonly service: DaemonServiceSummary | null;
}): void {
  const { service } = opts;
  if (service?.manager !== "systemd") {
    return;
  }
  const owner = service.ownsDaemon ? " (manages this hackd)" : "";
  const fix = service.nextStep ? ` | Run: ${service.nextStep}` : "";
  const message = `  systemd: ${service.summary}${owner}${fix}`;
  if (service.severity === "warn") {
    logger.warn({ message });
  } else {
    logger.info({ message });
  }
}

function logLaunchdStatus(opts: {
  readonly launchdStatus: LaunchdServiceStatus | null;
  readonly running: boolean;
}): void {
  if (!opts.launchdStatus?.installed) {
    return;
  }
  if (opts.running) {
    logger.info({
      message: `  launchd: ${opts.launchdStatus.loaded ? "loaded" : "not loaded"}`,
    });
    return;
  }
  logger.info({
    message: `  launchd: ${
      opts.launchdStatus.loaded ? "loaded (not running)" : "not loaded"
    }`,
  });
}

async function handleDaemonMetrics({
  args: _args,
}: {
  readonly ctx: CliContext;
  readonly args: DaemonMetricsArgs;
}): Promise<number> {
  const metrics = await requestDaemonJson({ path: "/v1/metrics" });
  if (metrics?.ok && metrics.json) {
    process.stdout.write(`${JSON.stringify(metrics.json, null, 2)}\n`);
    return 0;
  }

  logger.warn({
    message: "hackd metrics unavailable (daemon not running or incompatible)",
  });
  return 1;
}

async function handleDaemonLogs({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: DaemonLogsArgs;
}): Promise<number> {
  const paths = resolveDaemonPaths({});
  const text = await readTextFile(paths.logPath);
  if (!text) {
    logger.warn({ message: "No hackd logs found yet" });
    return 1;
  }

  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const tail = args.options.tail ?? 200;
  const slice = tail > 0 ? lines.slice(-tail) : lines;
  process.stdout.write(`${slice.join("\n")}\n`);
  return 0;
}

async function handleDaemonClear({
  args: _args,
}: {
  readonly ctx: CliContext;
  readonly args: DaemonClearArgs;
}): Promise<number> {
  const paths = resolveDaemonPaths({});
  const status = await readDaemonStatus({ paths });

  if (status.running) {
    logger.warn({ message: "hackd is running; stop it before clearing state" });
    return 1;
  }

  const orphans = await findOrphanDaemonProcesses({
    trackedPid: status.pid,
    daemonRoot: paths.root,
  });
  if (orphans.length > 0) {
    logger.warn({
      message: `Stopping orphaned hackd process(es): ${orphans.join(", ")}`,
    });
    await terminateOrphanDaemonProcesses({ pids: orphans });
  }

  const pidExists = await pathExists(paths.pidPath);
  const socketExists = await pathExists(paths.socketPath);

  if (!(pidExists || socketExists)) {
    logger.info({
      message:
        orphans.length > 0
          ? "Cleared orphaned hackd process(es); no stale files found"
          : "No stale hackd state found",
    });
    return 0;
  }

  if (pidExists) {
    await removeFileIfExists({ path: paths.pidPath });
  }
  if (socketExists) {
    await removeFileIfExists({ path: paths.socketPath });
  }

  logger.success({ message: "Cleared stale hackd state" });
  return 0;
}

async function handleDaemonRestart({
  args: _args,
  ctx,
}: {
  readonly ctx: CliContext;
  readonly args: DaemonRestartArgs;
}): Promise<number> {
  const stopArgs: DaemonStopArgs = {
    options: {},
    positionals: {},
    raw: { argv: [], positionals: [] },
  };
  const startArgs: DaemonStartArgs = {
    options: { foreground: false },
    positionals: {},
    raw: { argv: [], positionals: [] },
  };

  await handleDaemonStop({ ctx, args: stopArgs });
  return await handleDaemonStart({ ctx, args: startArgs });
}

async function waitForDaemonStart({
  paths,
  timeoutMs,
}: {
  readonly paths: ReturnType<typeof resolveDaemonPaths>;
  readonly timeoutMs?: number;
}): Promise<boolean> {
  const deadline = Date.now() + (timeoutMs ?? 2000);
  while (Date.now() < deadline) {
    const status = await readDaemonStatus({ paths });
    if (status.running && status.socketExists) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

async function handleDaemonInstall({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: DaemonInstallArgs;
}): Promise<number> {
  if (process.platform === "linux") {
    const paths = resolveDaemonPaths({});
    return await installDaemonSystemdService({
      paths,
      ignoredOptions: (
        ["run-at-load", "no-run-at-load", "gui-only", "no-gui-only"] as const
      )
        .filter((name) => args.options[name] === true)
        .map((name) => `--${name}`),
      startDetached: () => startDaemonDetached({ paths }),
      stopDirect: async (proof) => {
        await terminateProvenDaemon({ proof });
        await removeDaemonFilesIfStale({
          pidPath: paths.pidPath,
          socketPath: paths.socketPath,
          observedPid: proof.pid,
        });
      },
      waitForReady: (timeoutMs) => waitForDaemonStart({ paths, timeoutMs }),
    });
  }
  if (process.platform !== "darwin") {
    logger.warn({
      message:
        "hack daemon install supports launchd (macOS) and systemd (Linux) only",
    });
    return 1;
  }
  assertLaunchdAccess();

  const paths = resolveDaemonPaths({});
  const controlPlane = await readControlPlaneConfig({});

  const runAtLoad = resolveRunAtLoadOption({
    runAtLoadOpt: args.options["run-at-load"],
    noRunAtLoadOpt: args.options["no-run-at-load"],
    defaultValue: controlPlane.config.daemon.launchd.runAtLoad,
  });

  const guiSessionOnly = resolveGuiSessionOnlyOption({
    guiOnlyOpt: args.options["gui-only"],
    noGuiOnlyOpt: args.options["no-gui-only"],
    defaultValue: controlPlane.config.daemon.launchd.guiSessionOnly,
  });

  const launchdConfig: DaemonLaunchdConfig = {
    installed: true,
    runAtLoad,
    guiSessionOnly,
  };

  const result = await installLaunchdService({ paths, config: launchdConfig });
  if (!result.ok) {
    logger.error({
      message: `Failed to install launchd service: ${result.error}`,
    });
    return 1;
  }

  await updateGlobalConfig({
    path: "controlPlane.daemon.launchd.installed",
    value: true,
  });
  await updateGlobalConfig({
    path: "controlPlane.daemon.launchd.runAtLoad",
    value: runAtLoad,
  });
  await updateGlobalConfig({
    path: "controlPlane.daemon.launchd.guiSessionOnly",
    value: guiSessionOnly,
  });

  if (result.alreadyInstalled) {
    logger.info({
      message: "hackd launchd service already installed (config unchanged)",
    });
  } else {
    logger.success({ message: "hackd launchd service installed" });
  }

  const runAtLoadMsg = runAtLoad ? "enabled" : "disabled";
  const guiOnlyMsg = guiSessionOnly ? "GUI sessions only" : "all sessions";
  logger.info({ message: `  Run at login: ${runAtLoadMsg}` });
  logger.info({ message: `  Session type: ${guiOnlyMsg}` });
  logger.info({ message: `  Plist: ${paths.launchdPlistPath}` });

  const launchdStatus = await getLaunchdServiceStatus({ paths });
  if (!launchdStatus.running) {
    logger.info({ message: "Starting hackd via launchd..." });
    const kickResult = await kickstartLaunchdService();
    if (!kickResult.ok) {
      logger.warn({ message: `Failed to start service: ${kickResult.error}` });
      return 1;
    }

    const started = await waitForDaemonStart({ paths });
    if (started) {
      logger.success({ message: "hackd started via launchd" });
    } else {
      logger.warn({
        message: "hackd may not have started yet; check `hack daemon status`",
      });
    }
  }

  return 0;
}

/**
 * Refuses an explicit `daemon install`/`uninstall` closed when this process
 * may not manage the per-user launchd service (an isolated HACK_HOME or
 * HACK_LAUNCHD_DISABLE=1). Nothing is read or written before the refusal.
 */
function assertLaunchdAccess(): void {
  const access = resolveLaunchdAccess();
  if (!access.allowed) {
    throw new HackCliError({
      code: "E_PERMISSION",
      message: access.message,
      detail: { reason: access.reason },
    });
  }
}

function resolveRunAtLoadOption(opts: {
  readonly runAtLoadOpt: boolean | undefined;
  readonly noRunAtLoadOpt: boolean | undefined;
  readonly defaultValue: boolean;
}): boolean {
  if (opts.runAtLoadOpt === true) {
    return true;
  }
  if (opts.noRunAtLoadOpt === true) {
    return false;
  }
  return opts.defaultValue;
}

function resolveGuiSessionOnlyOption(opts: {
  readonly guiOnlyOpt: boolean | undefined;
  readonly noGuiOnlyOpt: boolean | undefined;
  readonly defaultValue: boolean;
}): boolean {
  if (opts.noGuiOnlyOpt === true) {
    return false;
  }
  if (opts.guiOnlyOpt === true) {
    return true;
  }
  return opts.defaultValue;
}

async function handleDaemonUninstall({
  args: _args,
}: {
  readonly ctx: CliContext;
  readonly args: DaemonUninstallArgs;
}): Promise<number> {
  if (process.platform === "linux") {
    return await uninstallDaemonSystemdService({});
  }
  if (process.platform !== "darwin") {
    logger.warn({
      message:
        "hack daemon uninstall supports launchd (macOS) and systemd (Linux) only",
    });
    return 1;
  }
  assertLaunchdAccess();

  const paths = resolveDaemonPaths({});
  const result = await uninstallLaunchdService({ paths });

  if (!result.ok) {
    logger.error({
      message: `Failed to uninstall launchd service: ${result.error}`,
    });
    return 1;
  }

  await updateGlobalConfig({
    path: "controlPlane.daemon.launchd.installed",
    value: false,
  });

  if (result.notInstalled) {
    logger.info({ message: "hackd launchd service was not installed" });
  } else {
    logger.success({ message: "hackd launchd service uninstalled" });
  }

  return 0;
}
