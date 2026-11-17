import { childEnvironment } from "../lib/child-environment.ts";
import { HackCliError } from "../lib/cli-result.ts";
import {
  effectiveComposeProfiles,
  readComposeOneShotGraph,
  runningOneShots,
  scopeOneShotGraph,
  startWatchDecision,
} from "../lib/compose-oneshot-progress.ts";
import { parseComposePsJson } from "../lib/compose-ps-result.ts";
import {
  type ComposeStartupPhase,
  DEFAULT_COMPOSE_STARTUP_TIMEOUT_MS,
  resolveComposeImageTimeoutMs,
  resolveComposeStartupCeilingMs,
  resolveComposeStartupTimeoutMs,
} from "../lib/compose-startup-budget.ts";
import { withDependencyStartupProgress } from "../lib/dependency-startup-progress.ts";
import { reportLifecycleProgress } from "../lib/lifecycle-progress.ts";
import { exec, run } from "../lib/shell.ts";
import { readLinesFromStream } from "../ui/lines.ts";
import { createStructuredLogGrouper } from "../ui/log-group.ts";
import {
  inspectUnattendedInputs,
  inspectUnattendedStorage,
  type UnattendedNamedVolume,
  type UnattendedTrustedBind,
} from "./compose-unattended-preflight.ts";

export type RuntimeBackendName = "compose";
const DEFAULT_COMPOSE_INSPECTION_TIMEOUT_MS = 15_000;

export interface RuntimeBackend {
  readonly name: RuntimeBackendName;
  up(opts: RuntimeUpOptions): Promise<number>;
  down(opts: RuntimeDownOptions): Promise<number>;
  psJson(opts: RuntimePsOptions): ReturnType<typeof exec>;
  ps(opts: RuntimePsOptions): Promise<number>;
  run(opts: RuntimeRunOptions): Promise<number>;
  exec(opts: RuntimeExecOptions): Promise<number>;
}

export interface RuntimeBaseOptions {
  readonly composeFiles: readonly string[];
  readonly composeProject?: string | null;
  readonly profiles?: readonly string[];
  readonly cwd: string;
  readonly env?: Record<string, string>;
  /**
   * Route subprocess stdout to stderr — required by `--json` callers whose
   * stdout must remain a single parseable envelope.
   */
  readonly routeStdoutToStderr?: boolean;
}

export interface RuntimeUpOptions extends RuntimeBaseOptions {
  /** Unattended startup may only reuse local images, never build, pull or load an implicit .env. */
  readonly unattended?: boolean;
  /** Re-authenticated machine-owned TLS files only; authored binds remain ineligible. */
  readonly unattendedTrustedBinds?: () => Promise<
    readonly UnattendedTrustedBind[]
  >;
  readonly dependencyProgress?: {
    readonly project: string;
    readonly services: readonly string[];
  };
  readonly detach: boolean;
  /** Detached `start` phase budget (container start and dependency wait). */
  readonly startupTimeoutMs?: number;
  /** Detached `images` phase budget (image build/pull and container creation). */
  readonly imageTimeoutMs?: number;
  /**
   * Absolute bound on the detached `start` phase while one-shot dependencies
   * keep it making progress (HACK-2310); see `startupTimeoutMs`.
   */
  readonly startupCeilingMs?: number;
  /** Called each time the start phase sees a one-shot dependency running. */
  readonly onStartupProgress?: () => void;
  /**
   * Called when the start phase is cut short (exit 124) with the one-shot
   * dependencies it last saw running; empty when none was running.
   */
  readonly onStartupStalled?: (inProgress: readonly string[]) => void;
  /**
   * Called before each detached phase begins, so a caller can attribute a
   * non-zero exit (including the 124 deadline) to the phase that produced it.
   */
  readonly onStartupPhase?: (phase: ComposeStartupPhase) => void;
  /**
   * Awaited right before containers start: after detached image preparation
   * (`up --no-start`) and before `up -d`, or before an attached `up`. A throw
   * rejects `up` without starting anything, so a caller can refuse to launch
   * services whose prerequisites were withdrawn while images were prepared.
   * Unattended starts also invoke it before preparation can create containers.
   */
  readonly beforeStart?: () => Promise<void>;
  readonly services?: readonly string[];
  readonly noDeps?: boolean;
  readonly forceRecreate?: boolean;
}

export interface RuntimeDownOptions extends RuntimeBaseOptions {}

export interface RuntimePsOptions extends RuntimeBaseOptions {
  readonly all?: boolean;
}

export interface RuntimeRunOptions extends RuntimeBaseOptions {
  readonly forwardSignals?: boolean;
  readonly timeoutMs?: number;
  readonly service: string;
  readonly noDeps?: boolean;
  readonly workdir?: string;
  readonly cmdArgs: readonly string[];
}

export interface RuntimeExecOptions extends RuntimeBaseOptions {
  readonly service: string;
  readonly workdir?: string;
  readonly cmdArgs: readonly string[];
}

function shouldDisableExecTty(): boolean {
  return !(process.stdin.isTTY === true && process.stdout.isTTY === true);
}

export function buildComposeArgs(opts: RuntimeBaseOptions): string[] {
  return [
    "docker",
    "compose",
    ...(opts.composeProject ? ["-p", opts.composeProject] : []),
    ...opts.composeFiles.flatMap((file) => ["-f", file] as const),
    ...(opts.profiles
      ? opts.profiles.flatMap((profile) => ["--profile", profile] as const)
      : []),
  ];
}

/**
 * `docker compose run --rm` argv. `disableTty` adds `-T`; background commands
 * always set it because their stdin is closed and they have no terminal.
 */
export function buildComposeRunCommand(opts: {
  readonly options: RuntimeRunOptions;
  readonly disableTty: boolean;
  /** `--name` for the one-off container, so its owner can remove it. */
  readonly containerName?: string;
}): string[] {
  const { options } = opts;
  return [
    ...buildComposeArgs(options),
    "run",
    "--rm",
    ...(opts.disableTty ? ["-T"] : []),
    ...(opts.containerName ? ["--name", opts.containerName] : []),
    ...(options.noDeps ? ["--no-deps"] : []),
    ...(options.workdir && options.workdir.length > 0
      ? ["-w", options.workdir]
      : []),
    options.service,
    ...(options.cmdArgs.length > 0 ? options.cmdArgs : []),
  ];
}

/** `docker compose exec` argv; `disableTty` adds `-T`. */
export function buildComposeExecCommand(opts: {
  readonly options: RuntimeExecOptions;
  readonly disableTty: boolean;
  /** `-e NAME=value` for the process in the container (a background marker). */
  readonly guestEnv?: Readonly<Record<string, string>>;
}): string[] {
  const { options } = opts;
  return [
    ...buildComposeArgs(options),
    "exec",
    ...(opts.disableTty ? ["-T"] : []),
    ...Object.entries(opts.guestEnv ?? {}).flatMap(([key, value]) => [
      "-e",
      `${key}=${value}`,
    ]),
    ...(options.workdir && options.workdir.length > 0
      ? ["-w", options.workdir]
      : []),
    options.service,
    ...(options.cmdArgs.length > 0 ? options.cmdArgs : []),
  ];
}

async function guardStartupStorage(
  opts: RuntimeUpOptions,
  volumes: readonly UnattendedNamedVolume[],
  binds: readonly UnattendedTrustedBind[],
  timeoutMs: number
): Promise<number> {
  await opts.beforeStart?.();
  if (!opts.unattended || (volumes.length === 0 && binds.length === 0)) {
    return 0;
  }
  const code = await inspectUnattendedStorage(opts, volumes, binds, timeoutMs);
  if (code === 0) {
    await opts.beforeStart?.();
  }
  return code;
}

async function prepareUnattendedStartup(
  opts: RuntimeUpOptions,
  composeArgs: readonly string[],
  timeoutMs: number
) {
  if (!opts.unattended) {
    return { exitCode: 0, volumes: [], binds: [] };
  }
  await opts.beforeStart?.();
  const inputs = await inspectUnattendedInputs(opts, composeArgs, timeoutMs);
  if (inputs.exitCode !== 0) {
    return inputs;
  }
  const storage = await guardStartupStorage(
    opts,
    inputs.volumes,
    inputs.binds,
    timeoutMs
  );
  return { ...inputs, exitCode: storage };
}

/** How often the detached start phase observes one-shot progress. */
const START_WATCH_POLL_MS = 1000;

/**
 * The detached `start` phase (HACK-2310). While a one-shot dependency runs,
 * `up -d` is waiting for it to exit before it starts its dependents: that is
 * progress, so the start budget then counts only time without progress, up
 * to an absolute ceiling. A graph without one-shots keeps the plain budget.
 * Exit 124 (reported through `onStartupStalled` with the one-shots last seen
 * running) means the wait was cut short; the Compose process group is then
 * terminated, while the containers it started keep running.
 */
async function runComposeStartPhase(input: {
  readonly cmd: readonly string[];
  readonly options: RuntimeUpOptions;
  readonly startupTimeoutMs: number;
  readonly budgetEnv: Readonly<Record<string, string | undefined>>;
  readonly runPhase: (
    cmd: readonly string[],
    timeoutMs: number
  ) => Promise<number>;
}): Promise<number> {
  const { options } = input;
  const graph = scopeOneShotGraph(
    await readComposeOneShotGraph(options.composeFiles, {
      activeProfiles: effectiveComposeProfiles({
        cliProfiles: options.profiles ?? [],
        env: options.env ?? {},
      }),
      interpolationEnv: { ...process.env, ...options.env },
    }),
    { services: options.services, noDeps: options.noDeps }
  );
  if (graph.oneShots.size === 0) {
    const code = await input.runPhase(input.cmd, input.startupTimeoutMs);
    if (code === 124) {
      options.onStartupStalled?.([]);
    }
    return code;
  }
  const ceilingMs = resolveComposeStartupCeilingMs({
    startupTimeoutMs: input.startupTimeoutMs,
    startupCeilingMs: options.startupCeilingMs,
    env: input.budgetEnv,
  });
  const watchdog = new AbortController();
  let done = false;
  const finished = run(input.cmd, {
    cwd: options.cwd,
    env: options.env,
    stdout: options.routeStdoutToStderr ? "stderr" : "inherit",
    timeoutMs: ceilingMs,
    forwardSignals: true,
    settleProcessGroupOnCancel: true,
    signal: watchdog.signal,
  }).finally(() => {
    done = true;
  });
  const watch = await watchStartProgress({
    options,
    graph,
    idleBudgetMs: input.startupTimeoutMs,
    ceilingMs,
    finished,
    isDone: () => done,
  });
  // Compose may end between the watcher's decision and this point: its own
  // outcome (success, a signal's exit code) then stands. Only a start the
  // watchdog actually cut short reports 124.
  const cutShort = watch.stopped && !done;
  if (cutShort) {
    watchdog.abort();
  }
  const code = await finished;
  if ((cutShort && code !== 0) || code === 124) {
    options.onStartupStalled?.(watch.lastSeen);
    return 124;
  }
  return code;
}

/**
 * One `compose ps --all --format json` read for the start-phase watchdog,
 * owned by it: the poll runs in its own process group, bounded like other
 * inspections, and is killed (with the Compose plugin process it starts) as
 * soon as the start ends, so a hung read never keeps the CLI alive after
 * Compose finished or was interrupted. Null when the read failed.
 */
async function pollComposePs(input: {
  readonly options: RuntimeUpOptions;
  readonly finished: Promise<number>;
}): Promise<Record<string, unknown>[] | null> {
  const proc = Bun.spawn(
    [...buildComposeArgs(input.options), "ps", "--all", "--format", "json"],
    {
      cwd: input.options.cwd,
      env: mergeSpawnEnv(input.options.env),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      detached: true,
    }
  );
  let settled = false;
  const stop = () => {
    if (settled) {
      return;
    }
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      // The group already exited.
    }
  };
  const timer = setTimeout(stop, DEFAULT_COMPOSE_INSPECTION_TIMEOUT_MS);
  // Stop the poll the moment the start ends.
  void input.finished.then(stop, stop);
  try {
    const [stdout, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    return code === 0 ? parseComposePsJson(stdout) : null;
  } finally {
    settled = true;
    clearTimeout(timer);
  }
}

/** Poll one-shot progress until the start ends or the watchdog decides to stop. */
async function watchStartProgress(input: {
  readonly options: RuntimeUpOptions;
  readonly graph: Awaited<ReturnType<typeof readComposeOneShotGraph>>;
  readonly idleBudgetMs: number;
  readonly ceilingMs: number;
  readonly finished: Promise<number>;
  readonly isDone: () => boolean;
}): Promise<{
  readonly stopped: boolean;
  readonly lastSeen: readonly string[];
}> {
  const startedAt = performance.now();
  let lastProgressAt = startedAt;
  let lastSeen: readonly string[] = [];
  for (;;) {
    await Promise.race([input.finished, Bun.sleep(START_WATCH_POLL_MS)]);
    if (input.isDone()) {
      return { stopped: false, lastSeen };
    }
    const entries = await pollComposePs({
      options: input.options,
      finished: input.finished,
    });
    if (input.isDone()) {
      return { stopped: false, lastSeen };
    }
    // A failed read is no evidence of progress, never extra time, and no
    // longer confirms what was running.
    lastSeen = entries ? runningOneShots({ graph: input.graph, entries }) : [];
    if (entries && lastSeen.length > 0) {
      lastProgressAt = performance.now();
      input.options.onStartupProgress?.();
    }
    const decision = startWatchDecision({
      now: performance.now(),
      startedAt,
      lastProgressAt,
      idleBudgetMs: input.idleBudgetMs,
      ceilingMs: input.ceilingMs,
    });
    if (decision !== "wait") {
      // Only a ceiling stop leaves one-shots confirmed running by the last
      // read; an idle stop means none was seen running for the whole budget.
      return {
        stopped: true,
        lastSeen: decision === "ceiling" ? lastSeen : [],
      };
    }
  }
}

export const composeRuntimeBackend: RuntimeBackend = {
  name: "compose",
  async up(opts) {
    if (opts.unattended && !opts.detach) {
      throw new HackCliError({
        code: "E_PERMISSION",
        message:
          "Unattended Compose startup requires detached mode; start this project manually.",
        detail: { reason: "unattended_requires_detached" },
      });
    }
    if (opts.detach) {
      const composeArgs = [
        ...buildComposeArgs(opts),
        ...(opts.unattended ? ["--env-file", "/dev/null"] : []),
      ];
      const budgetEnv = { ...process.env, ...opts.env };
      const startupTimeoutMs = resolveComposeStartupTimeoutMs({
        startupTimeoutMs: opts.startupTimeoutMs,
        env: budgetEnv,
      });
      const imageTimeoutMs = resolveComposeImageTimeoutMs({
        imageTimeoutMs: opts.imageTimeoutMs,
        env: budgetEnv,
      });
      const scope = [
        ...(opts.noDeps ? ["--no-deps"] : []),
        ...(opts.services ?? []),
      ];
      const runPhase = (cmd: readonly string[], timeoutMs: number) =>
        run(cmd, {
          cwd: opts.cwd,
          env: opts.env,
          stdout: opts.routeStdoutToStderr ? "stderr" : "inherit",
          timeoutMs,
          forwardSignals: true,
          settleProcessGroupOnCancel: true,
        });
      // Image build/pull can take far longer than starting containers, so it
      // runs (with container creation/recreation) under its own budget. The
      // start invocation then only starts the prepared containers and waits on
      // Compose dependency conditions; --no-build keeps it from rebuilding.
      const launch = async () => {
        const inputs = await prepareUnattendedStartup(
          opts,
          composeArgs,
          imageTimeoutMs
        );
        if (inputs.exitCode !== 0) {
          return inputs.exitCode;
        }
        opts.onStartupPhase?.("images");
        const prepared = await runPhase(
          [
            ...composeArgs,
            "up",
            "--no-start",
            ...(opts.unattended ? ["--no-build", "--pull", "never"] : []),
            ...(opts.forceRecreate ? ["--force-recreate"] : []),
            ...scope,
          ],
          imageTimeoutMs
        );
        if (prepared !== 0) {
          return prepared;
        }
        opts.onStartupPhase?.("start");
        const storage = await guardStartupStorage(
          opts,
          inputs.volumes,
          inputs.binds,
          startupTimeoutMs
        );
        if (storage !== 0) {
          return storage;
        }
        return await runStartPhase([
          ...composeArgs,
          "up",
          "-d",
          "--no-build",
          ...(opts.unattended ? ["--pull", "never"] : []),
          ...scope,
        ]);
      };
      // HACK-2310: while a one-shot dependency runs, `up -d` is waiting for
      // it to exit before it starts its dependents. That is progress: the
      // start budget then counts only time without progress, up to an
      // absolute ceiling. A graph without one-shots keeps the plain budget.
      const runStartPhase = (cmd: readonly string[]) =>
        runComposeStartPhase({
          cmd,
          options: opts,
          startupTimeoutMs,
          budgetEnv,
          runPhase,
        });
      const progress = opts.dependencyProgress;
      if (!progress) {
        return await launch();
      }
      return await withDependencyStartupProgress({
        project: progress.project,
        services: progress.services.filter(
          (service) =>
            !(opts.noDeps && opts.services) || opts.services.includes(service)
        ),
        cwd: opts.cwd,
        env: opts.env,
        onPhase: (service, phase) => {
          process.stderr.write(`Dependency cache ${service}: ${phase}\n`);
          reportLifecycleProgress({ service, phase });
        },
        onUnavailable: () => {
          process.stderr.write(
            "Dependency progress unavailable; Compose startup continues. Inspect hack ps and hack logs for status.\n"
          );
        },
        run: launch,
      });
    }

    await opts.beforeStart?.();
    const cmd = [
      ...buildComposeArgs(opts),
      "up",
      ...(opts.noDeps ? ["--no-deps"] : []),
      ...(opts.forceRecreate ? ["--force-recreate"] : []),
      ...(opts.services ?? []),
    ];
    const env = mergeSpawnEnv(opts.env);
    const proc = Bun.spawn(cmd, {
      cwd: opts.cwd,
      env: childEnvironment(env),
      stdin: "inherit",
      stdout: "pipe",
      stderr: "pipe",
      // Keep terminal group SIGINT delivery out of Compose's group: the parent
      // forwards each interrupt once, including a second one during shutdown.
      detached: true,
    });

    let interrupted: number | null = null;
    const forwardInterrupt = (): void => {
      interrupted ??= 130;
      if (proc.exitCode === null) {
        proc.kill("SIGINT");
      }
    };
    const forwardTerminate = (): void => {
      interrupted ??= 143;
      if (proc.exitCode === null) {
        proc.kill("SIGTERM");
      }
    };
    process.on("SIGINT", forwardInterrupt);
    process.on("SIGTERM", forwardTerminate);

    const stdoutTarget = opts.routeStdoutToStderr
      ? process.stderr
      : process.stdout;
    const stdoutGrouper = createStructuredLogGrouper({
      write: (text) => stdoutTarget.write(text),
    });
    const stderrGrouper = createStructuredLogGrouper({
      write: (text) => process.stderr.write(text),
    });

    const stdoutTask = (async () => {
      for await (const line of readLinesFromStream(proc.stdout)) {
        stdoutGrouper.handleLine(line);
      }
    })();

    const stderrTask = (async () => {
      for await (const line of readLinesFromStream(proc.stderr)) {
        stderrGrouper.handleLine(line);
      }
    })();

    try {
      const exitCode = await proc.exited;
      await Promise.all([stdoutTask, stderrTask]);
      stdoutGrouper.flush();
      stderrGrouper.flush();
      return interrupted ?? exitCode;
    } finally {
      process.off("SIGINT", forwardInterrupt);
      process.off("SIGTERM", forwardTerminate);
    }
  },
  async down(opts) {
    const cmd = [...buildComposeArgs(opts), "down"];
    return await run(cmd, {
      cwd: opts.cwd,
      env: opts.env,
      stdout: opts.routeStdoutToStderr ? "stderr" : "inherit",
      timeoutMs: DEFAULT_COMPOSE_STARTUP_TIMEOUT_MS,
    });
  },
  async psJson(opts) {
    const cmd = [
      ...buildComposeArgs(opts),
      "ps",
      ...(opts.all ? ["--all"] : []),
      "--format",
      "json",
    ];
    return await exec(cmd, {
      cwd: opts.cwd,
      stdin: "ignore",
      env: opts.env,
      timeoutMs: DEFAULT_COMPOSE_INSPECTION_TIMEOUT_MS,
    });
  },
  async ps(opts) {
    const cmd = [
      ...buildComposeArgs(opts),
      "ps",
      ...(opts.all ? ["--all"] : []),
    ];
    return await run(cmd, { cwd: opts.cwd, env: opts.env });
  },
  async run(opts) {
    const cmd = buildComposeRunCommand({ options: opts, disableTty: false });
    return await run(cmd, {
      cwd: opts.cwd,
      stdin: "inherit",
      env: opts.env,
      stdout: opts.routeStdoutToStderr ? "stderr" : "inherit",
      timeoutMs: opts.timeoutMs,
      forwardSignals: opts.forwardSignals,
    });
  },
  async exec(opts) {
    const cmd = buildComposeExecCommand({
      options: opts,
      disableTty: shouldDisableExecTty(),
    });
    return await run(cmd, { cwd: opts.cwd, stdin: "inherit", env: opts.env });
  },
};

function mergeSpawnEnv(
  override: Record<string, string> | undefined
): Record<string, string> {
  return childEnvironment(process.env, override);
}
