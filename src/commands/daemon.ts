import { dirname } from "node:path";
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
import {
  DAEMON_CLI_VERSION,
  isCandidateRun,
  probeDaemonApi,
  requestDaemonJson,
} from "../daemon/client.ts";
import {
  executingDaemonArgv,
  resolveDaemonLaunch,
} from "../daemon/executing-cli.ts";
import {
  getLaunchdServiceStatus,
  installLaunchdService,
  kickstartLaunchdService,
  type LaunchdServiceStatus,
  readLaunchdManagerState,
  resolveLaunchdAccess,
  uninstallLaunchdService,
} from "../daemon/launchd.ts";
import { isLoginServiceAutostart } from "../daemon/login-autostart.ts";
import { type DaemonPaths, resolveDaemonPaths } from "../daemon/paths.ts";
import {
  type DaemonProcessRefusal,
  type DaemonTermination,
  describeDaemonProcessRefusal,
  describeDaemonTermination,
  findOrphanDaemonProcesses,
  isHackDaemonProcess,
  type OwnedDaemonProof,
  proveOwnedDaemonProcess,
  readDaemonPid,
  removeDaemonFilesIfStale,
  terminateProvenDaemon,
  waitForProcessExit,
} from "../daemon/process.ts";
import {
  createDaemonCommandTrace,
  DAEMON_RECONCILE_ONLY_ENV,
  type DaemonCommandTrace,
} from "../daemon/reconcile.ts";
import { runDaemon } from "../daemon/server.ts";
import {
  type DaemonServiceSummary,
  serviceSummaryJson,
  summarizeLaunchdService,
} from "../daemon/service-summary.ts";
import { diagnoseDaemonDirectory } from "../daemon/socket-permissions.ts";
import { spawnDetachedDaemon } from "../daemon/spawn.ts";
import { waitForDetachedDaemonStart } from "../daemon/start-wait.ts";
import {
  buildDaemonRepairMessage,
  buildDaemonStatusReport,
  type DaemonStatusReport,
  readDaemonStatus,
} from "../daemon/status.ts";
import {
  defaultSystemdDeps,
  readSystemdManagerState,
} from "../daemon/systemd.ts";
import { HackCliError } from "../lib/cli-result.ts";
import { updateGlobalConfig } from "../lib/config.ts";
import { readTextFile } from "../lib/fs.ts";
import { resolveHackInvocation } from "../lib/hack-cli.ts";
import { resolveUserHomeDir } from "../lib/home-dir.ts";
import { readProjectsRegistry } from "../lib/projects-registry.ts";
import {
  buildDockerStatusProbe,
  detectDockerBackend,
} from "../lib/runtime-guidance.ts";
import { logger } from "../ui/logger.ts";
import {
  candidateOrphanRefusal,
  candidateRunningDaemonRefusal,
  candidateServiceCommandRefusal,
} from "./daemon-candidate.ts";
import {
  checkRunningLaunchdDaemon,
  refuseForeignLaunchdProgram,
  refuseLaunchdBeforeReplacing,
  startViaLaunchdIfLoaded,
} from "./daemon-launchd.ts";
import {
  describeUnverifiedReplacement,
  directReplacementPath,
  type ReplacementStartOutcome,
  type ServiceManagerState,
  startReplacementDaemon,
} from "./daemon-replace.ts";
import { runDaemonCommand } from "./daemon-result.ts";
import {
  describeSystemdIncompatibleOwner,
  installDaemonSystemdService,
  reconcileRunningSystemdDaemon,
  refuseSystemdStartBeforeReplacing,
  resolveSystemdSummary,
  startViaSystemdIfInstalled,
  stopViaSystemdIfInstalled,
  uninstallDaemonSystemdService,
  withSystemdIncompatibleNextStep,
} from "./daemon-systemd.ts";

const optForeground = defineOption({
  name: "foreground",
  type: "boolean",
  long: "--foreground",
  description: "Run hackd in the foreground (debug)",
} as const);

const startSpec = defineCommand({
  name: "start",
  summary:
    "Start hackd (local daemon); reinstalls and restarts a stale login service",
  group: "Diagnostics",
  options: [optForeground, optJson] as const,
  positionals: [],
  subcommands: [],
} as const);

const stopSpec = defineCommand({
  name: "stop",
  summary: "Stop hackd",
  group: "Diagnostics",
  options: [optJson] as const,
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
  options: [optJson] as const,
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
  options: [
    optRunAtLoad,
    optNoRunAtLoad,
    optGuiOnly,
    optNoGuiOnly,
    optJson,
  ] as const,
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
  const json = args.options.json === true;
  if (json && args.options.foreground) {
    throw new CliUsageError("--json cannot be used with --foreground");
  }
  const paths = resolveDaemonPaths({});
  return await runDaemonCommand({
    command: "start",
    json,
    paths,
    run: (trace) =>
      startDaemon({
        paths,
        foreground: args.options.foreground === true,
        trace,
        // A foreground start is a daemon being run (by a manager, or as the
        // replacement a reconcile spawned), never a reconcile: the flag
        // must not stop it from running.
        reconcileOnly:
          args.options.foreground !== true &&
          (process.env[DAEMON_RECONCILE_ONLY_ENV] ?? "").trim() === "1",
      }),
  });
}

/**
 * `hack daemon start`. With an installed login service it also brings a
 * stale service up to this CLI (HACK-2216): see
 * {@link reconcileRunningSystemdDaemon}, `prepareSystemdUnitForStart` and
 * {@link startViaLaunchdIfLoaded}. `trace` records what it did for `--json`.
 */
async function startDaemon(opts: {
  readonly paths: DaemonPaths;
  readonly foreground: boolean;
  readonly trace: DaemonCommandTrace;
  /**
   * {@link DAEMON_RECONCILE_ONLY_ENV} (the post-update step): only bring a
   * running hackd and its service up to date; never start one that is not
   * running, even if it stopped after the caller looked.
   */
  readonly reconcileOnly?: boolean;
  /**
   * The caller (`restart`) already stopped a running hackd: start its
   * replacement with the same fallback as a replacement here.
   */
  readonly alreadyReplaced?: boolean;
}): Promise<number> {
  const { paths, trace } = opts;
  if (isCandidateRun() && !opts.foreground) {
    const refused = await refuseCandidateDaemonChange({ paths, launch: true });
    if (refused !== null) {
      return refused;
    }
  }
  const status = await readDaemonStatus({ paths });

  // A pid that survived an unclean shutdown may now belong to another
  // program; that is not a running hackd (systemd runs this at every boot).
  const livePid = status.running ? status.pid : null;
  const pidIsDaemon =
    livePid !== null && (await isHackDaemonProcess({ pid: livePid }));
  if (opts.reconcileOnly && !(pidIsDaemon && status.socketExists)) {
    logger.info({
      message: "hackd is not running; nothing to bring up to date",
    });
    return 0;
  }
  let replaced = opts.alreadyReplaced === true;
  if (livePid !== null && pidIsDaemon) {
    // A candidate run leaves the stable login service alone and never
    // replaces a hackd of another version (HACK-2263).
    const running = await (isCandidateRun()
      ? reportCandidateRunningDaemon
      : handleRunningDaemonAtStart)({
      pid: livePid,
      socketExists: status.socketExists,
      paths,
      trace,
      foreground: opts.foreground,
    });
    if (running !== null) {
      return running;
    }
    replaced = true;
  }
  const startStopped = () =>
    startStoppedDaemon({
      paths,
      foreground: opts.foreground,
      trace,
      trackedPid: status.pid,
      stalePid: pidIsDaemon ? null : livePid,
      replacement: replaced,
    });
  if (!replaced || opts.foreground) {
    return (await startStopped()).exitCode;
  }
  // A running daemon was just stopped: never leave hackd stopped, unless
  // the manager may still start it (see startReplacementDaemon). Any direct
  // start runs this CLI itself, and the result must be this CLI's hackd.
  return await startReplacementDaemon({
    trace,
    startViaService: startStopped,
    startDirect: () => startReplacementDirectly({ paths }),
    isRunning: async () => {
      const now = await readDaemonStatus({ paths });
      return now.running && now.socketExists;
    },
    managerState: (manager) => readServiceManagerState({ manager, paths }),
    verifyStarted: async () => {
      const now = await readDaemonStatus({ paths });
      return describeUnverifiedReplacement(
        await checkDaemonApi({ socketExists: now.socketExists, paths })
      );
    },
  });
}

/**
 * The service manager's state for {@link startReplacementDaemon}; `null`:
 * the platform's own manager (systemd on Linux, launchd on macOS).
 */
function readServiceManagerState(opts: {
  readonly manager: "systemd" | "launchd" | null;
  readonly paths: DaemonPaths;
}): Promise<ServiceManagerState> {
  const manager =
    opts.manager ?? (process.platform === "darwin" ? "launchd" : "systemd");
  if (manager === "launchd") {
    return readLaunchdManagerState();
  }
  return process.platform === "linux"
    ? readSystemdManagerState({ deps: defaultSystemdDeps() })
    : Promise.resolve("idle");
}

/**
 * `start` once no hackd of this home runs (or it was just replaced). The
 * outcome says how far it got, for the replacement fallback.
 */
/** A manual cache daemon start does not acquire authority to start projects. */
export async function reportManualAutostartSkip(opts?: {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly readRegistry?: typeof readProjectsRegistry;
  readonly note?: (message: string) => void;
}): Promise<void> {
  if (isLoginServiceAutostart({ env: opts?.env ?? process.env })) {
    return;
  }
  const registry = await (opts?.readRegistry ?? readProjectsRegistry)().catch(
    () => null
  );
  if (registry?.projects.some((project) => project.autostart)) {
    const message =
      "This manual daemon launch did not run the login autostart pass. Run it intentionally with: hack autostart run --no-interactive";
    if (opts?.note) {
      opts.note(message);
    } else {
      logger.info({ message });
    }
  }
}

async function startStoppedDaemon(opts: {
  readonly paths: DaemonPaths;
  readonly foreground: boolean;
  readonly trace: DaemonCommandTrace;
  readonly trackedPid: number | null;
  /** A live pid already shown not to be hackd. */
  readonly stalePid: number | null;
  /**
   * A running daemon was just stopped to replace it: a direct start runs
   * this CLI itself ({@link executingDaemonArgv}), not the `hack` first on
   * PATH, which may be the old version (HACK-2216).
   */
  readonly replacement?: boolean;
}): Promise<ReplacementStartOutcome> {
  const { paths, trace } = opts;
  const candidate = isCandidateRun();
  const sweep = await sweepOrphanDaemons({
    trackedPid: opts.trackedPid,
    paths,
    refuseOrphans: candidate,
  });
  if (!sweep.allStopped) {
    // A proven orphan still holds the socket: any start would fail.
    return { kind: "direct-attempted", exitCode: 1, manager: null };
  }

  // An installed hackd.service owns the daemon on Linux. Start through it
  // before touching the pid/socket files: systemd (a pending restart) or
  // another starter may be writing them right now, and hackd replaces its
  // own socket when it starts.
  if (process.platform === "linux" && !opts.foreground && !candidate) {
    let requested = false;
    const viaSystemd = await startViaSystemdIfInstalled({
      paths,
      waitForReady: (timeoutMs) => waitForDaemonStart({ paths, timeoutMs }),
      trace,
      onStartRequested: () => {
        requested = true;
      },
    });
    if (viaSystemd !== null) {
      return {
        kind: requested ? "service-attempted" : "service-refused",
        exitCode: viaSystemd,
        manager: "systemd",
      };
    }
    // The unit serves another home, or systemd is unusable: hackd starts
    // directly, whatever was noted about the unit.
    trace.manager = "none";
  }

  const raced = await clearStaleDaemonFilesBeforeStart({
    paths,
    stalePid: opts.stalePid,
  });
  if (raced !== null) {
    // Another starter owns this start.
    return { kind: "direct-attempted", exitCode: raced, manager: null };
  }

  if (opts.foreground) {
    await reportManualAutostartSkip();
    await runDaemon({ paths, foreground: true });
    return { kind: "direct-attempted", exitCode: 0, manager: null };
  }

  let requested = false;
  const viaLaunchd = candidate
    ? null
    : await startViaLaunchdIfLoaded({
        paths,
        trace,
        waitForReady: (timeoutMs) => waitForDaemonStart({ paths, timeoutMs }),
        onStartRequested: () => {
          requested = true;
        },
      });
  if (viaLaunchd !== null) {
    return {
      kind: requested ? "service-attempted" : "service-refused",
      exitCode: viaLaunchd,
      manager: "launchd",
    };
  }

  // A replacement (a running daemon was just stopped) never inherits the
  // caller's PATH, with or without a service: it gets the service PATH,
  // checked ({@link startReplacementDirectly}). A fresh start keeps the
  // caller's environment, as an ordinary `hack daemon start` always has.
  // A candidate always starts its own bundle (startDaemonDetached).
  const started =
    opts.replacement === true && !candidate
      ? await startReplacementDirectly({ paths })
      : await startDaemonDetached({ paths });
  trace.manager = "none";
  trace.action = started === 0 ? "started" : trace.action;
  return { kind: "direct-attempted", exitCode: started, manager: null };
}

/**
 * `hack daemon stop` could not prove the pid-file pid is this HACK_HOME's
 * hackd. A pid that is not hackd at all (reused after an unclean shutdown)
 * means the pid file is stale: like `start`, stop leaves that process alone,
 * removes the file and succeeds, so `hack daemon restart` works. Anything
 * else (another root's daemon, unknown identity) is left alone and fails.
 */
async function reportUnprovenStop(opts: {
  readonly pid: number;
  readonly reason: DaemonProcessRefusal;
  readonly paths: DaemonPaths;
}): Promise<number> {
  if (opts.reason === "not-hackd" || opts.reason === "not-running") {
    await removeDaemonFilesIfStale({
      pidPath: opts.paths.pidPath,
      socketPath: opts.paths.socketPath,
      observedPid: opts.pid,
      observedPidIsDaemon: false,
    });
    logger.info({
      message: `Removed a stale hackd pid file (pid ${opts.pid} is not hackd); that process was left running`,
    });
    return 0;
  }
  logger.warn({
    message: `Did not stop pid ${opts.pid} from the hackd pid file: ${describeDaemonProcessRefusal(opts.reason)} | Check: hack daemon status`,
  });
  return 1;
}

/**
 * Daemons that outlived their pid file (e.g. a launchd-managed instance
 * surviving a manual clear/restart) hold the API socket invisibly and make
 * every freshly spawned daemon exit cleanly. Sweep them first.
 *
 * Only processes that pass the full identity proof are signalled, each
 * re-proven immediately before every signal; anything else is reported with
 * its pid and left alone. `allStopped` is false when a proven orphan could
 * not be confirmed stopped: the caller must not go on as if the socket
 * were free.
 */
async function sweepOrphanDaemons(opts: {
  readonly trackedPid: number | null;
  readonly paths: DaemonPaths;
  /**
   * A candidate run (HACK-2263): an orphan's version is unknown, so it is
   * reported and nothing is signalled or started.
   */
  readonly refuseOrphans?: boolean;
}): Promise<{ readonly allStopped: boolean; readonly stopped: number }> {
  const scan = await findOrphanDaemonProcesses({
    trackedPid: opts.trackedPid,
    daemonRoot: opts.paths.root,
  });
  if (scan.unknown) {
    // No trusted `ps` at a fixed path (HACK-2216): orphans are unknown, so
    // nothing is stopped and the start does not go on as if none held
    // the socket.
    logger.error({
      message:
        "Could not read the process table (no ps at a fixed, trusted path), so orphaned hackd processes are unknown; nothing was stopped or started | Check: hack daemon status",
    });
    return { allStopped: false, stopped: 0 };
  }
  for (const refused of scan.refused) {
    // A process that is provably not this home's hackd (for example a shell
    // whose command line merely contains "hack daemon start") neither blocks
    // the start nor gets signalled, so it is debug noise (HACK-2329). One
    // whose identity could not be read may still be hackd: keep that visible.
    const unrelated =
      refused.reason === "not-hackd" || refused.reason === "foreign-socket";
    (unrelated ? logger.debug : logger.info)({
      message: `Left pid ${refused.pid} running: it looks like a hack daemon start, but ${describeDaemonProcessRefusal(refused.reason)}`,
    });
  }
  const orphanRefusal = opts.refuseOrphans
    ? candidateOrphanRefusal({ pids: scan.orphans.map((orphan) => orphan.pid) })
    : null;
  if (orphanRefusal !== null) {
    logger.error({ message: orphanRefusal });
    return { allStopped: false, stopped: 0 };
  }
  let allStopped = true;
  let stopped = 0;
  for (const orphan of scan.orphans) {
    logger.warn({
      message: `Stopping orphaned hackd process not tracked by the pid file: ${orphan.pid}`,
    });
    const termination = await terminateProvenDaemon({
      proof: orphan,
      daemonRoot: opts.paths.root,
    });
    if (termination.kind === "exited") {
      stopped += 1;
    } else {
      allStopped = false;
      logger.error({
        message: `${describeDaemonTermination(orphan.pid, termination)} | Check: hack daemon status`,
      });
    }
  }
  return { allStopped, stopped };
}

/**
 * Stops a proven hackd and, once its exit is confirmed, removes its files
 * if still stale. Returns false (and reports) when the exit was not
 * confirmed: callers must not continue as if hackd were stopped.
 */
export async function stopProvenDaemon(opts: {
  readonly proof: OwnedDaemonProof;
  readonly paths: DaemonPaths;
  /** Defaults to {@link terminateProvenDaemon}; tests pin the outcome. */
  readonly terminate?: (proof: OwnedDaemonProof) => Promise<DaemonTermination>;
}): Promise<boolean> {
  const termination = await (
    opts.terminate ??
    ((proof: OwnedDaemonProof) =>
      terminateProvenDaemon({ proof, daemonRoot: opts.paths.root }))
  )(opts.proof);
  if (termination.kind !== "exited") {
    logger.error({
      message: `${describeDaemonTermination(opts.proof.pid, termination)} | Check: hack daemon status`,
    });
    return false;
  }
  await removeDaemonFilesIfStale({
    pidPath: opts.paths.pidPath,
    socketPath: opts.paths.socketPath,
    observedPid: opts.proof.pid,
  });
  return true;
}

/**
 * `hack daemon start` found a live pid. Returns an exit code when start is
 * done (already running, a stale login service brought up to this CLI, or
 * an incompatible systemd-run hackd that only `hack daemon install` can
 * switch), or null after replacing an incompatible directly started hackd.
 */
async function handleRunningDaemonAtStart(opts: {
  readonly pid: number;
  readonly socketExists: boolean;
  readonly paths: DaemonPaths;
  readonly trace: DaemonCommandTrace;
  readonly foreground: boolean;
}): Promise<number | null> {
  const { paths, trace } = opts;
  const api = await checkDaemonApi({
    socketExists: opts.socketExists,
    paths,
  });
  if (process.platform === "linux" && !opts.foreground) {
    const reconciled = await reconcileRunningSystemdDaemon({
      paths,
      pid: opts.pid,
      version: api.reachable ? api.version : null,
      waitForReady: (timeoutMs) => waitForDaemonStart({ paths, timeoutMs }),
      trace,
    });
    if (reconciled !== null) {
      return reconciled;
    }
  }
  const compatible = !(api.reachable && !api.compatible);
  if (process.platform === "darwin" && !opts.foreground) {
    const viaLaunchd = await checkRunningLaunchdDaemon({
      paths,
      trace,
      pid: opts.pid,
      compatible,
      waitForReady: (timeoutMs) => waitForDaemonStart({ paths, timeoutMs }),
    });
    if (viaLaunchd !== null) {
      return viaLaunchd;
    }
  }
  if (compatible) {
    logger.success({ message: `hackd already running (pid ${opts.pid})` });
    return 0;
  }
  trace.stale.add("version-mismatch");
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
  const proof = await proveOwnedDaemonProcess({
    pid: opts.pid,
    daemonRoot: opts.paths.root,
  });
  if (proof.kind !== "owned") {
    logger.warn({
      message: `hackd is incompatible with this CLI, but pid ${opts.pid} was not replaced: ${describeDaemonProcessRefusal(proof.reason)} | Check: hack daemon status`,
    });
    return 1;
  }
  if (!opts.foreground) {
    const blocked = await refuseReplacementBeforeStop({
      paths,
      trace,
      launchdChecked: true,
    });
    if (blocked !== null) {
      return blocked;
    }
  }
  logger.warn({ message: `Replacing incompatible hackd (pid ${opts.pid})` });
  if (!(await stopProvenDaemon({ proof, paths: opts.paths }))) {
    return 1;
  }
  return null;
}

/**
 * `hack daemon start` in a candidate run found this home's hackd running:
 * already running when it is this CLI's version, otherwise refused with
 * nothing stopped (HACK-2263).
 */
async function reportCandidateRunningDaemon(opts: {
  readonly pid: number;
  readonly socketExists: boolean;
  readonly paths: DaemonPaths;
  readonly trace: DaemonCommandTrace;
}): Promise<number> {
  const api = await checkDaemonApi({
    socketExists: opts.socketExists,
    paths: opts.paths,
  });
  const refusal = candidateRunningDaemonRefusal({
    pid: opts.pid,
    version: api.version,
    compatible: api.reachable && api.compatible,
  });
  if (refusal === null) {
    logger.success({ message: `hackd already running (pid ${opts.pid})` });
    return 0;
  }
  opts.trace.stale.add("version-mismatch");
  logger.error({ message: refusal });
  return 1;
}

/**
 * Removes the pid/socket files only while they are still stale: a
 * concurrent start may have written new ones since status was read. When it
 * finds a newer owner it waits for that daemon and returns an exit code;
 * otherwise null.
 */
async function clearStaleDaemonFilesBeforeStart(opts: {
  readonly paths: DaemonPaths;
  /** A live pid already shown not to be hackd. */
  readonly stalePid: number | null;
}): Promise<number | null> {
  const { paths } = opts;
  const observedPid = await readDaemonPid({ pidPath: paths.pidPath });
  const cleanup = await removeDaemonFilesIfStale({
    pidPath: paths.pidPath,
    socketPath: paths.socketPath,
    observedPid,
    observedPidIsDaemon: !(
      opts.stalePid !== null && observedPid === opts.stalePid
    ),
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
/**
 * The direct start after a replaced daemon's service could not start it:
 * this CLI itself, with the PATH its service would give hackd, never the
 * caller's ({@link directReplacementPath}). An unsafe service PATH starts
 * nothing and leaves hackd stopped.
 */
async function startReplacementDirectly(opts: {
  readonly paths: DaemonPaths;
}): Promise<number> {
  const argv = executingDaemonArgv();
  const servicePath = await readDirectReplacementPath(argv);
  if ("refused" in servicePath) {
    logger.error({
      message: `Not starting the replacement hackd directly: ${servicePath.refused}; hackd is stopped | Fix that directory, then run: hack daemon install`,
    });
    return 1;
  }
  return await startDaemonDetached({
    paths: opts.paths,
    argv,
    path: servicePath.path,
  });
}

function readDirectReplacementPath(argv: readonly string[]) {
  return directReplacementPath({
    argv,
    home: resolveUserHomeDir(),
    platform: process.platform,
  });
}

/**
 * What a direct start that did not become ready says. A state directory
 * hackd refuses names that reason. Otherwise a process that already ended
 * says so with its exit code, and one that is still running after the whole
 * budget keeps the "not ready yet" message.
 */
export function detachedStartFailureMessage(opts: {
  readonly outcome: "exited" | "timeout";
  readonly directoryRefusal: string | null;
  readonly exitCode: number | null;
}): string {
  if (opts.directoryRefusal !== null) {
    return `hackd did not start: ${opts.directoryRefusal}`;
  }
  const check =
    "Check: hack daemon logs --tail 200, or run hack daemon start --foreground to see its error";
  return opts.outcome === "exited"
    ? `hackd exited before it was ready${opts.exitCode === null ? "" : ` (exit code ${opts.exitCode})`} | ${check}`
    : `Started hackd process but it did not report ready yet | ${check}`;
}

async function startDaemonDetached(opts: {
  readonly paths: DaemonPaths;
  /**
   * What to run. Defaults to the `hack` this CLI resolves (an ordinary
   * start); a replacement passes {@link executingDaemonArgv}, this CLI
   * itself (HACK-2216).
   */
  readonly argv?: readonly string[];
  /** Replaces the caller's PATH (a replacement; see startReplacementDirectly). */
  readonly path?: string;
}): Promise<number> {
  const { paths } = opts;
  const argv = opts.argv ?? (await resolveDaemonStartArgv());
  if (typeof argv === "string") {
    logger.error({ message: argv });
    return 1;
  }
  // A detached hackd's output is discarded and it refuses before opening its
  // log, so name the refusal here instead of a bare "not ready" (HACK-2329).
  const refusal = diagnoseDaemonDirectory({ root: paths.root });
  if (refusal !== null) {
    logger.error({ message: `hackd cannot start: ${refusal}` });
    return 1;
  }
  // A directly started hackd never runs the login autostart pass (its
  // environment drops HACK_DAEMON_LOGIN_SERVICE); say so once per launch.
  await reportManualAutostartSkip();
  const spawned = spawnDetachedDaemon({ argv: [...argv], path: opts.path });

  // Returns as soon as hackd is ready, and as soon as the spawned process is
  // gone with no hackd recorded; only a process that is alive but not ready
  // uses the whole budget (HACK-2371).
  const outcome = await waitForDetachedDaemonStart({
    isReady: async () => {
      const status = await readDaemonStatus({ paths });
      return status.running && status.socketExists;
    },
    spawnedExitCode: spawned.exitCode,
    daemonAlive: async () => (await readDaemonStatus({ paths })).running,
  });
  if (outcome.kind !== "ready") {
    const late = diagnoseDaemonDirectory({ root: paths.root });
    logger.warn({
      message: detachedStartFailureMessage({
        outcome: outcome.kind,
        directoryRefusal: late,
        exitCode: spawned.exitCode(),
      }),
    });
    return 1;
  }
  // "started" needs positive evidence (HACK-2263): the program started may
  // not be this CLI, so its API must answer with this CLI's version.
  const api = await waitForDaemonApi({ paths });
  if (!(api.reachable && api.compatible)) {
    logger.error({
      message: api.reachable
        ? `Started hackd, but it reports version ${api.version ?? "unknown"}, not this CLI's ${DAEMON_CLI_VERSION}; it is not this Hack's hackd | Check: hack daemon status`
        : "Started hackd, but its API did not answer, so its version is unknown | Check: hack daemon status",
    });
    return 1;
  }

  logger.success({ message: "hackd started" });
  return 0;
}

/**
 * The argv of an ordinary detached start ({@link resolveDaemonLaunch}): the
 * `hack` this CLI resolves, or in a candidate run its own bundle's
 * launcher. A string is the refusal when a candidate run cannot prove what
 * it would start.
 */
async function resolveDaemonStartArgv(): Promise<readonly string[] | string> {
  const launch = resolveDaemonLaunch();
  if (launch.kind === "refused") {
    return launch.message;
  }
  if (launch.kind === "candidate") {
    return launch.argv;
  }
  const invocation = await resolveHackInvocation();
  return [
    invocation.bin,
    ...invocation.args,
    "daemon",
    "start",
    "--foreground",
  ];
}

async function handleDaemonStop({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: DaemonStopArgs;
}): Promise<number> {
  const paths = resolveDaemonPaths({});
  return await runDaemonCommand({
    command: "stop",
    json: args.options.json === true,
    paths,
    run: (trace) => stopDaemon({ paths, trace }),
  });
}

/** `hack daemon stop`; `trace` records who stopped what for `--json`. */
async function stopDaemon(opts: {
  readonly paths: DaemonPaths;
  readonly trace: DaemonCommandTrace;
}): Promise<number> {
  const { paths, trace } = opts;
  // A candidate stops only its own hackd, never through the login service
  // (HACK-2263).
  const candidate = isCandidateRun();
  if (candidate) {
    const refused = await refuseCandidateDaemonChange({ paths, launch: false });
    if (refused !== null) {
      return refused;
    }
  }
  const code = await stopDaemonSteps({ paths, trace, useSystemd: !candidate });
  if (trace.manager === "none" && process.platform === "darwin") {
    const launchd = await resolveLaunchdStatus({ paths });
    trace.manager = launchd?.loaded ? "launchd" : "none";
  }
  return code;
}

async function stopDaemonSteps(opts: {
  readonly paths: DaemonPaths;
  readonly trace: DaemonCommandTrace;
  /** False in a candidate run: hackd.service runs the stable hack. */
  readonly useSystemd?: boolean;
}): Promise<number> {
  const { paths, trace } = opts;
  const initial = await readDaemonStatus({ paths });

  // An installed hackd.service is stopped through systemd even when the pid
  // file is missing or names a dead pid: that is how a pending
  // Restart=on-failure restart gets cancelled.
  const viaSystemd =
    process.platform === "linux" && opts.useSystemd !== false
      ? await stopViaSystemdIfInstalled({
          pid: initial.running ? initial.pid : null,
          hackHome: dirname(paths.root),
        })
      : { handled: false, ownedPid: false, failed: null, refused: null };
  if (viaSystemd.refused !== null) {
    logger.error({ message: viaSystemd.refused });
    return 1;
  }
  if (viaSystemd.failed !== null) {
    // Signalling hackd would not stop the manager, which can start it again
    // (a pending Restart=on-failure). Report the failure instead.
    logger.error({
      message: `systemctl --user stop hackd.service failed: ${viaSystemd.failed}; hackd was not stopped | Check: systemctl --user status hackd.service`,
    });
    return 1;
  }
  if (viaSystemd.ownedPid && initial.pid !== null) {
    await waitForProcessExit({
      pid: initial.pid,
      timeoutMs: 5000,
      pollMs: 200,
    });
  }
  if (viaSystemd.handled) {
    trace.manager = "systemd";
    trace.action = "stopped";
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

  // A directly started hackd (or one systemd did not stop in time). Signal
  // it only once it is proven to be this HACK_HOME's hackd: the pid file can
  // name a reused pid.
  const proof = await proveOwnedDaemonProcess({
    pid: status.pid,
    daemonRoot: paths.root,
  });
  if (proof.kind !== "owned") {
    return await reportUnprovenStop({
      pid: status.pid,
      reason: proof.reason,
      paths,
    });
  }
  if (!(await stopProvenDaemon({ proof, paths }))) {
    return 1;
  }
  trace.action = "stopped";
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
  const baseReport = buildDaemonStatusReport({
    pid: status.pid,
    processRunning: status.running,
    socketExists: status.socketExists,
    logExists: status.logExists,
    apiReachable: api.reachable,
    apiCompatible: api.compatible,
    serviceLoaded: launchdStatus?.loaded === true,
  });
  const report = await withSystemdIncompatibleNextStep({ report: baseReport });
  const service = launchdStatus
    ? summarizeLaunchdService({
        status: launchdStatus,
        daemonPid: status.pid,
        daemonRunning: status.running,
      })
    : await resolveSystemdSummary({ paths });
  const dockerBackend = await detectDockerBackend();
  const dockerStatus = await buildDockerStatusProbe();
  // Why a start would be refused, read-only; only meaningful while stopped.
  const startRefusal =
    report.status === "running"
      ? null
      : diagnoseDaemonDirectory({ root: paths.root });

  if (args.options.json) {
    outputDaemonStatusJson({
      report,
      apiVersion: api.version,
      paths,
      launchdStatus,
      service,
      startRefusal,
    });
    return report.status === "running" ? 0 : 1;
  }

  return reportDaemonStatus({
    report,
    launchdStatus,
    service,
    dockerBackendName: dockerBackend?.name ?? null,
    dockerReachable: dockerStatus.reachable,
    startRefusal,
  });
}

async function checkDaemonApi(opts: {
  readonly socketExists: boolean;
  readonly paths: DaemonPaths;
}): Promise<{
  readonly reachable: boolean;
  readonly compatible: boolean;
  readonly version: string | null;
}> {
  if (!opts.socketExists) {
    return { reachable: false, compatible: false, version: null };
  }
  const probe = await probeDaemonApi({
    socketPath: opts.paths.socketPath,
    timeoutMs: 500,
  });
  return {
    reachable: probe.reachable,
    compatible: probe.compatible,
    version: probe.version,
  };
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
  /** What hackd's API reported; null when it did not answer. */
  readonly apiVersion: string | null;
  readonly paths: DaemonPaths;
  readonly launchdStatus: LaunchdServiceStatus | null;
  readonly service: DaemonServiceSummary | null;
  /** Why `hack daemon start` would be refused (HACK-2329), or null. */
  readonly startRefusal: string | null;
}): void {
  const payload = {
    status: opts.report.status,
    running: opts.report.running,
    api_ok: opts.report.apiOk,
    api_reachable: opts.report.apiReachable,
    api_compatible: opts.report.apiCompatible,
    // Both strings come from HACK_VERSION; compatible means equal.
    version: opts.apiVersion,
    cli_version: DAEMON_CLI_VERSION,
    process_running: opts.report.processRunning,
    stale: opts.report.stale,
    stale_reason: opts.report.staleReason,
    issue: opts.report.issue,
    next_step: opts.report.nextStep,
    start_refusal: opts.startRefusal,
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
  readonly startRefusal: string | null;
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
  if (opts.startRefusal !== null) {
    logger.warn({ message: `hackd cannot start: ${opts.startRefusal}` });
  }
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

  // A candidate never signals an untracked hackd: its version is unknown
  // (HACK-2263).
  const sweep = await sweepOrphanDaemons({
    trackedPid: status.pid,
    paths,
    refuseOrphans: isCandidateRun(),
  });
  if (!sweep.allStopped) {
    return 1;
  }

  // Same stale-only rule as start and stop: a concurrent start may have
  // written a new pid file and socket since status was read.
  const cleanup = await removeDaemonFilesIfStale({
    pidPath: paths.pidPath,
    socketPath: paths.socketPath,
    observedPid: status.pid,
  });
  if (cleanup.newerOwner) {
    logger.warn({
      message:
        "hackd state changed while clearing (another process is starting hackd); left it in place | Check: hack daemon status",
    });
    return 1;
  }
  if (!(cleanup.removedPid || cleanup.removedSocket)) {
    logger.info({
      message:
        sweep.stopped > 0
          ? "Cleared orphaned hackd process(es); no stale files found"
          : "No stale hackd state found",
    });
    return 0;
  }

  logger.success({ message: "Cleared stale hackd state" });
  return 0;
}

async function handleDaemonRestart({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: DaemonRestartArgs;
}): Promise<number> {
  const paths = resolveDaemonPaths({});
  return await runDaemonCommand({
    command: "restart",
    json: args.options.json === true,
    paths,
    run: (trace) => restartDaemon({ paths, trace }),
  });
}

/**
 * Check the selected replacement route before stopping the running daemon.
 * The actual start checks the route and PATH again before acting.
 */
async function refuseReplacementBeforeStop(opts: {
  readonly paths: DaemonPaths;
  readonly trace: DaemonCommandTrace;
  /** `start` already checked the loaded job in checkRunningLaunchdDaemon. */
  readonly launchdChecked?: true;
  /** `restart` may have read a stale pidfile that names an unrelated process. */
  readonly unverifiedPid?: number;
}): Promise<number | null> {
  const { paths, trace } = opts;
  let managed = trace.manager === "launchd";
  const onManagedStart = () => {
    managed = true;
  };
  if (process.platform === "darwin" && !opts.launchdChecked) {
    const blocked = await refuseLaunchdBeforeReplacing({
      paths,
      trace,
      waitForReady: (timeoutMs) => waitForDaemonStart({ paths, timeoutMs }),
      onManagedStart,
    });
    if (blocked !== null) {
      return blocked;
    }
  }
  if (process.platform === "linux") {
    const refusal = await refuseSystemdStartBeforeReplacing({
      paths,
      onManagedStart,
    });
    if (refusal !== null) {
      trace.manager = "systemd";
      trace.blocked = refusal.blocked;
      logger.warn({
        message: `Not replacing hackd: hackd.service could not be started for this home afterwards, so nothing was stopped: ${refusal.message}`,
      });
      return 1;
    }
  }
  if (managed) {
    return null;
  }
  if (
    opts.unverifiedPid !== undefined &&
    !(await isHackDaemonProcess({ pid: opts.unverifiedPid }))
  ) {
    return null;
  }
  const servicePath = await readDirectReplacementPath(executingDaemonArgv());
  if (!("refused" in servicePath)) {
    return null;
  }
  logger.warn({
    message: `Keeping the running hackd: its direct replacement cannot start with an unsafe PATH: ${servicePath.refused} | Fix that directory, then retry`,
  });
  return 1;
}

async function restartDaemon(opts: {
  readonly paths: DaemonPaths;
  readonly trace: DaemonCommandTrace;
}): Promise<number> {
  const { paths, trace } = opts;
  if (isCandidateRun()) {
    return await restartCandidateDaemon(opts);
  }
  // A launchd service that runs another existing (or unreadable) program
  // is refused before anything is stopped: the later start would kickstart
  // a program this CLI does not own.
  if (process.platform === "darwin") {
    const foreign = await refuseForeignLaunchdProgram({
      paths,
      trace,
      verb: "restart",
      waitForReady: (timeoutMs) => waitForDaemonStart({ paths, timeoutMs }),
    });
    if (foreign !== null) {
      return foreign;
    }
  }
  // Restarting an incompatible hackd that systemd runs from another,
  // still existing `hack` only starts the same version again.
  const status = await readDaemonStatus({ paths });
  if (status.running && status.pid !== null) {
    const api = await checkDaemonApi({
      socketExists: status.socketExists,
      paths,
    });
    const incompatible = api.reachable && !api.compatible;
    if (incompatible) {
      trace.stale.add("version-mismatch");
    }
    const owner =
      incompatible && process.platform === "linux"
        ? await describeSystemdIncompatibleOwner({ pid: status.pid })
        : null;
    if (owner !== null) {
      trace.manager = "systemd";
      logger.warn({ message: owner });
      return 1;
    }
    // The same eligibility checks `start` runs before replacing a running
    // daemon: refuse now, with nothing stopped, when the start after the
    // stop would be refused.
    const blocked = await refuseReplacementBeforeStop({
      paths,
      trace,
      unverifiedPid: status.pid,
    });
    if (blocked !== null) {
      return blocked;
    }
  }
  // A refused stop (the pid could not be proven to be this HACK_HOME's
  // hackd) must not turn into "already running" success.
  const stopTrace = createDaemonCommandTrace();
  const stopped = await stopDaemon({ paths, trace: stopTrace });
  if (stopped !== 0) {
    trace.manager = stopTrace.manager;
    return stopped;
  }
  // A daemon that ran before the stop gets the same idle-gated direct
  // fallback as a replacement in `start`.
  const started = await startDaemon({
    paths,
    foreground: false,
    trace,
    alreadyReplaced: status.running,
  });
  if (started === 0 && trace.action === "started") {
    trace.action = "restarted";
  }
  return started;
}

/**
 * `hack daemon restart` in a candidate run (HACK-2263): no login service
 * checks (the service runs the stable hack), and a running hackd of
 * another version is refused before anything is stopped, because this
 * candidate would start its own hackd instead of that one.
 */
async function restartCandidateDaemon(opts: {
  readonly paths: DaemonPaths;
  readonly trace: DaemonCommandTrace;
}): Promise<number> {
  const { paths, trace } = opts;
  // Everything the start would refuse is refused before the stop.
  const refused = await refuseCandidateDaemonChange({ paths, launch: true });
  if (refused !== null) {
    return refused;
  }
  const running = (await readDaemonStatus({ paths })).running;
  const stopTrace = createDaemonCommandTrace();
  const stopped = await stopDaemonSteps({
    paths,
    trace: stopTrace,
    useSystemd: false,
  });
  if (stopped !== 0) {
    trace.manager = stopTrace.manager;
    return stopped;
  }
  const started = await startDaemon({
    paths,
    foreground: false,
    trace,
    alreadyReplaced: running,
  });
  if (started === 0 && trace.action === "started") {
    trace.action = "restarted";
  }
  return started;
}

/**
 * Before a candidate run (HACK-2263) starts, stops or restarts hackd: an
 * exit code (reported) when it must change nothing, else null. It refuses
 * when it cannot prove what it would start (`launch`), when the tracked
 * hackd does not positively report this CLI's version (a stable hackd on a
 * shared Hack home, or one whose API did not answer), and when untracked
 * hackd processes hold this home or the process table cannot be read.
 */
async function refuseCandidateDaemonChange(opts: {
  readonly paths: DaemonPaths;
  readonly launch: boolean;
}): Promise<number | null> {
  const { paths } = opts;
  const launch = opts.launch ? resolveDaemonLaunch() : null;
  if (launch?.kind === "refused") {
    logger.error({ message: launch.message });
    return 1;
  }
  const status = await readDaemonStatus({ paths });
  const livePid = status.running ? status.pid : null;
  if (livePid !== null && (await isHackDaemonProcess({ pid: livePid }))) {
    const api = await checkDaemonApi({
      socketExists: status.socketExists,
      paths,
    });
    const refusal = candidateRunningDaemonRefusal({
      pid: livePid,
      version: api.version,
      compatible: api.reachable && api.compatible,
    });
    if (refusal !== null) {
      logger.error({ message: refusal });
      return 1;
    }
  }
  const scan = await findOrphanDaemonProcesses({
    trackedPid: status.pid,
    daemonRoot: paths.root,
  });
  const orphanRefusal = scan.unknown
    ? "Could not read the process table (no ps at a fixed, trusted path), so this candidate cannot tell which hackd processes hold this Hack home; nothing was stopped or started."
    : candidateOrphanRefusal({
        pids: scan.orphans.map((orphan) => orphan.pid),
      });
  if (orphanRefusal !== null) {
    logger.error({ message: orphanRefusal });
    return 1;
  }
  return null;
}

/** Polls hackd's API until it answers or `timeoutMs` passes. */
async function waitForDaemonApi(opts: {
  readonly paths: DaemonPaths;
  readonly timeoutMs?: number;
}): Promise<Awaited<ReturnType<typeof checkDaemonApi>>> {
  const deadline = Date.now() + (opts.timeoutMs ?? 5000);
  for (;;) {
    const api = await checkDaemonApi({ socketExists: true, paths: opts.paths });
    if (api.reachable || Date.now() >= deadline) {
      return api;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
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
  const paths = resolveDaemonPaths({});
  return await runDaemonCommand({
    command: "install",
    json: args.options.json === true,
    paths,
    run: (trace) => installDaemon({ args, paths, trace }),
  });
}

async function installDaemon(opts: {
  readonly args: DaemonInstallArgs;
  readonly paths: DaemonPaths;
  readonly trace: DaemonCommandTrace;
}): Promise<number> {
  const { args, paths, trace } = opts;
  const candidateRefusal = candidateServiceCommandRefusal({
    command: "install",
  });
  if (candidateRefusal !== null) {
    logger.error({ message: candidateRefusal });
    return 1;
  }
  if (process.platform === "linux") {
    return await installDaemonSystemdService({
      paths,
      ignoredOptions: (
        ["run-at-load", "no-run-at-load", "gui-only", "no-gui-only"] as const
      )
        .filter((name) => args.options[name] === true)
        .map((name) => `--${name}`),
      startDetached: () => startDaemonDetached({ paths }),
      stopDirect: (proof) => stopProvenDaemon({ proof, paths }),
      waitForReady: (timeoutMs) => waitForDaemonStart({ paths, timeoutMs }),
      trace,
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
  trace.manager = "launchd";

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
    trace.action = "installed";
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
  const candidateRefusal = candidateServiceCommandRefusal({
    command: "uninstall",
  });
  if (candidateRefusal !== null) {
    logger.error({ message: candidateRefusal });
    return 1;
  }
  if (process.platform === "linux") {
    return await uninstallDaemonSystemdService({
      daemonRoot: resolveDaemonPaths({}).root,
    });
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
