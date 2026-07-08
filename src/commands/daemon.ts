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
  uninstallLaunchdService,
} from "../daemon/launchd.ts";
import { type DaemonPaths, resolveDaemonPaths } from "../daemon/paths.ts";
import {
  findOrphanDaemonProcesses,
  removeFileIfExists,
  terminateOrphanDaemonProcesses,
  waitForProcessExit,
} from "../daemon/process.ts";
import { runDaemon } from "../daemon/server.ts";
import {
  buildDaemonRepairMessage,
  buildDaemonStatusReport,
  type DaemonStatusReport,
  readDaemonStatus,
} from "../daemon/status.ts";
import { updateGlobalConfig } from "../lib/config.ts";
import { pathExists, readTextFile } from "../lib/fs.ts";
import { resolveHackInvocation } from "../lib/hack-cli.ts";
import {
  buildDockerStatusProbe,
  detectDockerBackend,
} from "../lib/runtime-guidance.ts";
import { logger } from "../ui/logger.ts";

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
  description: "Start hackd automatically on login",
} as const);

const optNoRunAtLoad = defineOption({
  name: "no-run-at-load",
  type: "boolean",
  long: "--no-run-at-load",
  description: "Do not start hackd automatically on login",
} as const);

const optGuiOnly = defineOption({
  name: "gui-only",
  type: "boolean",
  long: "--gui-only",
  description: "Only run in GUI sessions (default)",
} as const);

const optNoGuiOnly = defineOption({
  name: "no-gui-only",
  type: "boolean",
  long: "--no-gui-only",
  description: "Run in all session types (including SSH)",
} as const);

const installSpec = defineCommand({
  name: "install",
  summary: "Install hackd as a launchd service (macOS)",
  group: "Diagnostics",
  options: [optRunAtLoad, optNoRunAtLoad, optGuiOnly, optNoGuiOnly] as const,
  positionals: [],
  subcommands: [],
} as const);

const uninstallSpec = defineCommand({
  name: "uninstall",
  summary: "Uninstall hackd launchd service (macOS)",
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
    const api = await checkDaemonApi({
      socketExists: status.socketExists,
      paths,
    });
    if (api.reachable && !api.compatible) {
      // An incompatible daemon (usually a pre-upgrade binary) must be
      // replaced, not reported as success — leaving it running is how
      // machines end up with doctor/status contradictions.
      logger.warn({
        message: `Replacing incompatible hackd (pid ${status.pid})`,
      });
      await stopDaemonProcess({ pid: status.pid, paths });
    } else {
      logger.success({
        message: `hackd already running (pid ${status.pid})`,
      });
      return 0;
    }
  }

  // Daemons that outlived their pid file (e.g. a launchd-managed instance
  // surviving a manual clear/restart) hold the API socket invisibly and
  // make every freshly spawned daemon exit cleanly. Sweep them first.
  const orphans = await findOrphanDaemonProcesses({
    trackedPid: status.pid,
  });
  if (orphans.length > 0) {
    logger.warn({
      message: `Stopping orphaned hackd process(es) not tracked by the pid file: ${orphans.join(", ")}`,
    });
    await terminateOrphanDaemonProcesses({ pids: orphans });
  }

  await removeFileIfExists({ path: paths.socketPath });
  await removeFileIfExists({ path: paths.pidPath });

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

  const invocation = await resolveHackInvocation();
  const cmd = [...invocation.args, "daemon", "start", "--foreground"];
  const proc = Bun.spawn([invocation.bin, ...cmd], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  proc.unref();

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
  await removeFileIfExists({ path: opts.paths.pidPath });
  await removeFileIfExists({ path: opts.paths.socketPath });
}

async function handleDaemonStop({
  args: _args,
}: {
  readonly ctx: CliContext;
  readonly args: DaemonStopArgs;
}): Promise<number> {
  const paths = resolveDaemonPaths({});
  const status = await readDaemonStatus({ paths });

  if (!status.pid) {
    logger.info({ message: "hackd is not running" });
    return 0;
  }

  if (!status.running) {
    await removeFileIfExists({ path: paths.pidPath });
    await removeFileIfExists({ path: paths.socketPath });
    logger.info({ message: "Removed stale hackd pid/socket files" });
    return 0;
  }

  process.kill(status.pid, "SIGTERM");
  const exited = await waitForProcessExit({
    pid: status.pid,
    timeoutMs: 2000,
    pollMs: 200,
  });
  if (!exited) {
    process.kill(status.pid, "SIGKILL");
  }

  await removeFileIfExists({ path: paths.pidPath });
  await removeFileIfExists({ path: paths.socketPath });
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
  const report = buildDaemonStatusReport({
    pid: status.pid,
    processRunning: status.running,
    socketExists: status.socketExists,
    logExists: status.logExists,
    apiReachable: api.reachable,
    apiCompatible: api.compatible,
  });
  const launchdStatus = await resolveLaunchdStatus({ paths });
  const dockerBackend = await detectDockerBackend();
  const dockerStatus = await buildDockerStatusProbe();

  if (args.options.json) {
    outputDaemonStatusJson({
      report,
      paths,
      launchdStatus,
    });
    return report.status === "running" ? 0 : 1;
  }

  return reportDaemonStatus({
    report,
    launchdStatus,
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
  readonly dockerBackendName: string | null;
  readonly dockerReachable: boolean;
}): number {
  const { report, launchdStatus } = opts;
  if (report.status === "running") {
    logger.success({
      message: `hackd running (pid ${report.pid ?? "unknown"})`,
    });
    logLaunchdStatus({ launchdStatus, running: true });
    return 0;
  }

  if (report.status === "starting") {
    logger.warn({
      message: `hackd starting (pid ${report.pid ?? "unknown"}): API not responding yet`,
    });
    return 1;
  }

  if (report.status === "incompatible") {
    logger.warn({
      message: `hackd is running but incompatible with this CLI; run \`${report.nextStep}\``,
    });
    logLaunchdStatus({ launchdStatus, running: true });
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
  return 1;
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
  if (process.platform !== "darwin") {
    logger.warn({ message: "launchd integration is only available on macOS" });
    return 1;
  }

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
  if (process.platform !== "darwin") {
    logger.warn({ message: "launchd integration is only available on macOS" });
    return 1;
  }

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
