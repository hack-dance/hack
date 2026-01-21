import { pathExists, readTextFile } from "../lib/fs.ts"
import { resolveHackInvocation } from "../lib/hack-cli.ts"
import { logger } from "../ui/logger.ts"
import { CliUsageError, defineCommand, defineOption, withHandler } from "../cli/command.ts"
import { optJson, optTail } from "../cli/options.ts"
import { resolveDaemonPaths } from "../daemon/paths.ts"
import {
  isProcessRunning,
  removeFileIfExists,
  waitForProcessExit
} from "../daemon/process.ts"
import { runDaemon } from "../daemon/server.ts"
import { requestDaemonJson } from "../daemon/client.ts"
import { buildDaemonStatusReport, readDaemonStatus } from "../daemon/status.ts"
import {
  getLaunchdServiceStatus,
  installLaunchdService,
  kickstartLaunchdService,
  stopLaunchdService,
  uninstallLaunchdService
} from "../daemon/launchd.ts"
import { readControlPlaneConfig } from "../control-plane/sdk/config.ts"
import { updateGlobalConfig } from "../lib/config.ts"

import type { CliContext, CommandArgs } from "../cli/command.ts"
import type { DaemonLaunchdConfig } from "../control-plane/sdk/config.ts"

const optForeground = defineOption({
  name: "foreground",
  type: "boolean",
  long: "--foreground",
  description: "Run hackd in the foreground (debug)"
} as const)

const startSpec = defineCommand({
  name: "start",
  summary: "Start hackd (local daemon)",
  group: "Diagnostics",
  options: [optForeground] as const,
  positionals: [],
  subcommands: []
} as const)

const stopSpec = defineCommand({
  name: "stop",
  summary: "Stop hackd",
  group: "Diagnostics",
  options: [],
  positionals: [],
  subcommands: []
} as const)

const statusSpec = defineCommand({
  name: "status",
  summary: "Show hackd status",
  group: "Diagnostics",
  options: [optJson] as const,
  positionals: [],
  subcommands: []
} as const)

const metricsSpec = defineCommand({
  name: "metrics",
  summary: "Show hackd metrics",
  group: "Diagnostics",
  options: [] as const,
  positionals: [],
  subcommands: []
} as const)

const logsSpec = defineCommand({
  name: "logs",
  summary: "Show hackd logs",
  group: "Diagnostics",
  options: [optTail] as const,
  positionals: [],
  subcommands: []
} as const)

const clearSpec = defineCommand({
  name: "clear",
  summary: "Clear stale hackd pid/socket files",
  group: "Diagnostics",
  options: [],
  positionals: [],
  subcommands: []
} as const)

const restartSpec = defineCommand({
  name: "restart",
  summary: "Restart hackd",
  group: "Diagnostics",
  options: [],
  positionals: [],
  subcommands: []
} as const)

const optRunAtLoad = defineOption({
  name: "run-at-load",
  type: "boolean",
  long: "--run-at-load",
  description: "Start hackd automatically on login"
} as const)

const optNoRunAtLoad = defineOption({
  name: "no-run-at-load",
  type: "boolean",
  long: "--no-run-at-load",
  description: "Do not start hackd automatically on login"
} as const)

const optGuiOnly = defineOption({
  name: "gui-only",
  type: "boolean",
  long: "--gui-only",
  description: "Only run in GUI sessions (default)"
} as const)

const optNoGuiOnly = defineOption({
  name: "no-gui-only",
  type: "boolean",
  long: "--no-gui-only",
  description: "Run in all session types (including SSH)"
} as const)

const installSpec = defineCommand({
  name: "install",
  summary: "Install hackd as a launchd service (macOS)",
  group: "Diagnostics",
  options: [optRunAtLoad, optNoRunAtLoad, optGuiOnly, optNoGuiOnly] as const,
  positionals: [],
  subcommands: []
} as const)

const uninstallSpec = defineCommand({
  name: "uninstall",
  summary: "Uninstall hackd launchd service (macOS)",
  group: "Diagnostics",
  options: [],
  positionals: [],
  subcommands: []
} as const)

export const daemonStartCommand = withHandler(startSpec, handleDaemonStart)
export const daemonStopCommand = withHandler(stopSpec, handleDaemonStop)
export const daemonStatusCommand = withHandler(statusSpec, handleDaemonStatus)
export const daemonMetricsCommand = withHandler(metricsSpec, handleDaemonMetrics)
export const daemonLogsCommand = withHandler(logsSpec, handleDaemonLogs)
export const daemonClearCommand = withHandler(clearSpec, handleDaemonClear)
export const daemonRestartCommand = withHandler(restartSpec, handleDaemonRestart)
export const daemonInstallCommand = withHandler(installSpec, handleDaemonInstall)
export const daemonUninstallCommand = withHandler(uninstallSpec, handleDaemonUninstall)

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
    daemonUninstallCommand
  ]
} as const)

export const daemonCommand = withHandler(daemonSpec, async ({ ctx }): Promise<number> => {
  throw new CliUsageError(`Missing subcommand for ${ctx.cli.name} daemon`)
})

type DaemonStartArgs = CommandArgs<typeof startSpec.options, readonly []>
type DaemonStopArgs = CommandArgs<typeof stopSpec.options, readonly []>
type DaemonStatusArgs = CommandArgs<typeof statusSpec.options, readonly []>
type DaemonMetricsArgs = CommandArgs<typeof metricsSpec.options, readonly []>
type DaemonLogsArgs = CommandArgs<typeof logsSpec.options, readonly []>
type DaemonClearArgs = CommandArgs<typeof clearSpec.options, readonly []>
type DaemonRestartArgs = CommandArgs<typeof restartSpec.options, readonly []>
type DaemonInstallArgs = CommandArgs<typeof installSpec.options, readonly []>
type DaemonUninstallArgs = CommandArgs<typeof uninstallSpec.options, readonly []>

async function handleDaemonStart({
  args
}: {
  readonly ctx: CliContext
  readonly args: DaemonStartArgs
}): Promise<number> {
  const paths = resolveDaemonPaths({})
  const status = await readDaemonStatus({ paths })

  if (status.running) {
    logger.success({ message: `hackd already running (pid ${status.pid ?? "unknown"})` })
    return 0
  }

  await removeFileIfExists({ path: paths.socketPath })
  await removeFileIfExists({ path: paths.pidPath })

  if (args.options.foreground) {
    await runDaemon({ paths, foreground: true })
    return 0
  }

  const invocation = await resolveHackInvocation()
  const cmd = [...invocation.args, "daemon", "start", "--foreground"]
  const proc = Bun.spawn([invocation.bin, ...cmd], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore"
  })
  proc.unref()

  const started = await waitForDaemonStart({ paths })
  if (!started) {
    logger.warn({ message: "Started hackd process but it did not report ready yet" })
    return 1
  }

  logger.success({ message: "hackd started" })
  return 0
}

async function handleDaemonStop({
  args: _args
}: {
  readonly ctx: CliContext
  readonly args: DaemonStopArgs
}): Promise<number> {
  const paths = resolveDaemonPaths({})
  const status = await readDaemonStatus({ paths })

  if (!status.pid) {
    logger.info({ message: "hackd is not running" })
    return 0
  }

  if (!status.running) {
    await removeFileIfExists({ path: paths.pidPath })
    await removeFileIfExists({ path: paths.socketPath })
    logger.info({ message: "Removed stale hackd pid/socket files" })
    return 0
  }

  process.kill(status.pid, "SIGTERM")
  const exited = await waitForProcessExit({ pid: status.pid, timeoutMs: 2_000, pollMs: 200 })
  if (!exited) {
    process.kill(status.pid, "SIGKILL")
  }

  await removeFileIfExists({ path: paths.pidPath })
  await removeFileIfExists({ path: paths.socketPath })
  logger.success({ message: "hackd stopped" })
  return 0
}

async function handleDaemonStatus({
  args
}: {
  readonly ctx: CliContext
  readonly args: DaemonStatusArgs
}): Promise<number> {
  const paths = resolveDaemonPaths({})
  const status = await readDaemonStatus({ paths })
  const processRunning = status.running
  let apiOk = false

  if (status.socketExists) {
    const ping = await requestDaemonJson({
      path: "/v1/status",
      timeoutMs: 500,
      allowIncompatible: true
    })
    apiOk = ping?.ok ?? false
  }

  const report = buildDaemonStatusReport({
    pid: status.pid,
    processRunning,
    socketExists: status.socketExists,
    logExists: status.logExists,
    apiOk
  })

  const launchdStatus = process.platform === "darwin"
    ? await getLaunchdServiceStatus({ paths })
    : null

  if (args.options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          status: report.status,
          running: report.running,
          api_ok: report.apiOk,
          process_running: report.processRunning,
          stale: report.stale,
          stale_reason: report.staleReason,
          pid: report.pid,
          socket_path: paths.socketPath,
          socket_exists: report.socketExists,
          log_path: paths.logPath,
          log_exists: report.logExists,
          launchd: launchdStatus
            ? {
                installed: launchdStatus.installed,
                loaded: launchdStatus.loaded,
                running: launchdStatus.running,
                pid: launchdStatus.pid,
                exit_status: launchdStatus.exitStatus,
                plist_path: paths.launchdPlistPath
              }
            : null
        },
        null,
        2
      )}\n`
    )
    return report.status == "running" ? 0 : 1
  }

  if (report.status == "running") {
    logger.success({ message: `hackd running (pid ${report.pid ?? "unknown"})` })
    if (launchdStatus?.installed) {
      logger.info({ message: `  launchd: ${launchdStatus.loaded ? "loaded" : "not loaded"}` })
    }
    return 0
  }

  if (report.status == "starting") {
    logger.warn({
      message: `hackd starting (pid ${report.pid ?? "unknown"}): API not responding yet`
    })
    return 1
  }

  logger.warn({ message: report.stale ? "hackd stopped (stale state detected)" : "hackd is not running" })
  if (launchdStatus?.installed) {
    logger.info({ message: `  launchd: ${launchdStatus.loaded ? "loaded (not running)" : "not loaded"}` })
  }
  return 1
}

async function handleDaemonMetrics({
  args: _args
}: {
  readonly ctx: CliContext
  readonly args: DaemonMetricsArgs
}): Promise<number> {
  const metrics = await requestDaemonJson({ path: "/v1/metrics" })
  if (metrics?.ok && metrics.json) {
    process.stdout.write(`${JSON.stringify(metrics.json, null, 2)}\n`)
    return 0
  }

  logger.warn({ message: "hackd metrics unavailable (daemon not running or incompatible)" })
  return 1
}

async function handleDaemonLogs({
  args
}: {
  readonly ctx: CliContext
  readonly args: DaemonLogsArgs
}): Promise<number> {
  const paths = resolveDaemonPaths({})
  const text = await readTextFile(paths.logPath)
  if (!text) {
    logger.warn({ message: "No hackd logs found yet" })
    return 1
  }

  const lines = text.split("\n").filter(line => line.trim().length > 0)
  const tail = args.options.tail ?? 200
  const slice = tail > 0 ? lines.slice(-tail) : lines
  process.stdout.write(`${slice.join("\n")}\n`)
  return 0
}

async function handleDaemonClear({
  args: _args
}: {
  readonly ctx: CliContext
  readonly args: DaemonClearArgs
}): Promise<number> {
  const paths = resolveDaemonPaths({})
  const status = await readDaemonStatus({ paths })

  if (status.running) {
    logger.warn({ message: "hackd is running; stop it before clearing state" })
    return 1
  }

  const pidExists = await pathExists(paths.pidPath)
  const socketExists = await pathExists(paths.socketPath)

  if (!pidExists && !socketExists) {
    logger.info({ message: "No stale hackd state found" })
    return 0
  }

  if (pidExists) {
    await removeFileIfExists({ path: paths.pidPath })
  }
  if (socketExists) {
    await removeFileIfExists({ path: paths.socketPath })
  }

  logger.success({ message: "Cleared stale hackd state" })
  return 0
}

async function handleDaemonRestart({
  args: _args,
  ctx
}: {
  readonly ctx: CliContext
  readonly args: DaemonRestartArgs
}): Promise<number> {
  const stopArgs: DaemonStopArgs = {
    options: {},
    positionals: {},
    raw: { argv: [], positionals: [] }
  }
  const startArgs: DaemonStartArgs = {
    options: { foreground: false },
    positionals: {},
    raw: { argv: [], positionals: [] }
  }

  await handleDaemonStop({ ctx, args: stopArgs })
  return await handleDaemonStart({ ctx, args: startArgs })
}

async function waitForDaemonStart({
  paths
}: {
  readonly paths: ReturnType<typeof resolveDaemonPaths>
}): Promise<boolean> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const status = await readDaemonStatus({ paths })
    if (status.running && status.socketExists) return true
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  return false
}

async function handleDaemonInstall({
  args
}: {
  readonly ctx: CliContext
  readonly args: DaemonInstallArgs
}): Promise<number> {
  if (process.platform !== "darwin") {
    logger.warn({ message: "launchd integration is only available on macOS" })
    return 1
  }

  const paths = resolveDaemonPaths({})
  const controlPlane = await readControlPlaneConfig({})

  const runAtLoad = args.options["run-at-load"] === true
    ? true
    : args.options["no-run-at-load"] === true
      ? false
      : controlPlane.config.daemon.launchd.runAtLoad

  const guiSessionOnly = args.options["no-gui-only"] === true
    ? false
    : args.options["gui-only"] === true
      ? true
      : controlPlane.config.daemon.launchd.guiSessionOnly

  const launchdConfig: DaemonLaunchdConfig = {
    installed: true,
    runAtLoad,
    guiSessionOnly
  }

  const result = await installLaunchdService({ paths, config: launchdConfig })
  if (!result.ok) {
    logger.error({ message: `Failed to install launchd service: ${result.error}` })
    return 1
  }

  await updateGlobalConfig({
    path: "controlPlane.daemon.launchd.installed",
    value: true
  })
  await updateGlobalConfig({
    path: "controlPlane.daemon.launchd.runAtLoad",
    value: runAtLoad
  })
  await updateGlobalConfig({
    path: "controlPlane.daemon.launchd.guiSessionOnly",
    value: guiSessionOnly
  })

  if (result.alreadyInstalled) {
    logger.info({ message: "hackd launchd service already installed (config unchanged)" })
  } else {
    logger.success({ message: "hackd launchd service installed" })
  }

  const runAtLoadMsg = runAtLoad ? "enabled" : "disabled"
  const guiOnlyMsg = guiSessionOnly ? "GUI sessions only" : "all sessions"
  logger.info({ message: `  Run at login: ${runAtLoadMsg}` })
  logger.info({ message: `  Session type: ${guiOnlyMsg}` })
  logger.info({ message: `  Plist: ${paths.launchdPlistPath}` })

  const launchdStatus = await getLaunchdServiceStatus({ paths })
  if (!launchdStatus.running) {
    logger.info({ message: "Starting hackd via launchd..." })
    const kickResult = await kickstartLaunchdService()
    if (!kickResult.ok) {
      logger.warn({ message: `Failed to start service: ${kickResult.error}` })
      return 1
    }

    const started = await waitForDaemonStart({ paths })
    if (started) {
      logger.success({ message: "hackd started via launchd" })
    } else {
      logger.warn({ message: "hackd may not have started yet; check `hack daemon status`" })
    }
  }

  return 0
}

async function handleDaemonUninstall({
  args: _args
}: {
  readonly ctx: CliContext
  readonly args: DaemonUninstallArgs
}): Promise<number> {
  if (process.platform !== "darwin") {
    logger.warn({ message: "launchd integration is only available on macOS" })
    return 1
  }

  const paths = resolveDaemonPaths({})
  const result = await uninstallLaunchdService({ paths })

  if (!result.ok) {
    logger.error({ message: `Failed to uninstall launchd service: ${result.error}` })
    return 1
  }

  await updateGlobalConfig({
    path: "controlPlane.daemon.launchd.installed",
    value: false
  })

  if (result.notInstalled) {
    logger.info({ message: "hackd launchd service was not installed" })
  } else {
    logger.success({ message: "hackd launchd service uninstalled" })
  }

  return 0
}
