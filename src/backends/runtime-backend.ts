import { exec, run } from "../lib/shell.ts";
import { readLinesFromStream } from "../ui/lines.ts";
import { createStructuredLogGrouper } from "../ui/log-group.ts";

export type RuntimeBackendName = "compose";
const DEFAULT_COMPOSE_STARTUP_TIMEOUT_MS = 90_000;
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
  readonly detach: boolean;
  readonly services?: readonly string[];
  readonly noDeps?: boolean;
  readonly forceRecreate?: boolean;
}

export interface RuntimeDownOptions extends RuntimeBaseOptions {}

export interface RuntimePsOptions extends RuntimeBaseOptions {
  readonly all?: boolean;
}

export interface RuntimeRunOptions extends RuntimeBaseOptions {
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

function buildComposeArgs(opts: RuntimeBaseOptions): string[] {
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

export const composeRuntimeBackend: RuntimeBackend = {
  name: "compose",
  async up(opts) {
    const cmd = [
      ...buildComposeArgs(opts),
      "up",
      ...(opts.detach ? ["-d"] : []),
      ...(opts.noDeps ? ["--no-deps"] : []),
      ...(opts.forceRecreate ? ["--force-recreate"] : []),
      ...(opts.services ?? []),
    ];
    if (opts.detach) {
      return await run(cmd, {
        cwd: opts.cwd,
        env: opts.env,
        stdout: opts.routeStdoutToStderr ? "stderr" : "inherit",
        timeoutMs: DEFAULT_COMPOSE_STARTUP_TIMEOUT_MS,
      });
    }

    const env = mergeSpawnEnv(opts.env);
    const proc = Bun.spawn(cmd, {
      cwd: opts.cwd,
      env,
      stdin: "inherit",
      stdout: "pipe",
      stderr: "pipe",
    });

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

    const exitCode = await proc.exited;
    await Promise.all([stdoutTask, stderrTask]);
    stdoutGrouper.flush();
    stderrGrouper.flush();
    return exitCode;
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
    const cmd = [...buildComposeArgs(opts), "ps"];
    return await run(cmd, { cwd: opts.cwd, env: opts.env });
  },
  async run(opts) {
    const cmd = [
      ...buildComposeArgs(opts),
      "run",
      "--rm",
      ...(opts.noDeps ? ["--no-deps"] : []),
      ...(opts.workdir && opts.workdir.length > 0 ? ["-w", opts.workdir] : []),
      opts.service,
      ...(opts.cmdArgs.length > 0 ? opts.cmdArgs : []),
    ];
    return await run(cmd, { cwd: opts.cwd, stdin: "inherit", env: opts.env });
  },
  async exec(opts) {
    const cmd = [
      ...buildComposeArgs(opts),
      "exec",
      ...(shouldDisableExecTty() ? ["-T"] : []),
      ...(opts.workdir && opts.workdir.length > 0 ? ["-w", opts.workdir] : []),
      opts.service,
      ...(opts.cmdArgs.length > 0 ? opts.cmdArgs : []),
    ];
    return await run(cmd, { cwd: opts.cwd, stdin: "inherit", env: opts.env });
  },
};

function mergeSpawnEnv(
  override: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!override) {
    return undefined;
  }

  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      base[key] = value;
    }
  }
  return { ...base, ...override };
}
