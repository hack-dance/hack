import { childEnvironment } from "../lib/child-environment.ts";
import { HackCliError } from "../lib/cli-result.ts";
import {
  type ComposeStartupPhase,
  DEFAULT_COMPOSE_STARTUP_TIMEOUT_MS,
  resolveComposeImageTimeoutMs,
  resolveComposeStartupTimeoutMs,
} from "../lib/compose-startup-budget.ts";
import { withDependencyStartupProgress } from "../lib/dependency-startup-progress.ts";
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
        return await runPhase(
          [
            ...composeArgs,
            "up",
            "-d",
            "--no-build",
            ...(opts.unattended ? ["--pull", "never"] : []),
            ...scope,
          ],
          startupTimeoutMs
        );
      };
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
