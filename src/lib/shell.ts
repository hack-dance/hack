import { readSubprocessResourceUsage } from "./process-resource-usage.ts";
import { hasControllingTerminal } from "./tty-process-group.ts";

export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ExecOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly stdin?: "inherit" | "pipe" | "ignore";
  readonly timeoutMs?: number;
}

/**
 * Build the child env from the CURRENT `process.env` plus overrides.
 *
 * Always returns an explicit env (never undefined): `Bun.spawn` without an
 * env resolves argv[0] against the PATH snapshot captured at process
 * startup, which ignores runtime PATH changes — the same pitfall
 * `findExecutableInPath` documents. Passing the live env keeps child
 * behavior identical for normal runs while honoring runtime PATH.
 */
function buildSpawnEnv(
  override: Record<string, string> | undefined
): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      base[key] = value;
    }
  }
  return override ? { ...base, ...override } : base;
}

export async function exec(
  cmd: readonly string[],
  opts: ExecOptions = {}
): Promise<ExecResult> {
  const proc = Bun.spawn([...cmd], {
    cwd: opts.cwd,
    env: buildSpawnEnv(opts.env),
    stdin: opts.stdin ?? "inherit",
    stdout: "pipe",
    stderr: "pipe",
    detached: opts.timeoutMs !== undefined,
  });

  const timeout = installSubprocessTimeout({
    pid: proc.pid,
    timeoutMs: opts.timeoutMs,
  });

  const stdoutText = await streamToText(proc.stdout);
  const stderrText = await streamToText(proc.stderr);
  const exitCode = await proc.exited;
  timeout.dispose();

  return {
    exitCode: timeout.didTimeout() ? 124 : exitCode,
    stdout: stdoutText,
    stderr: stderrText,
  };
}

export interface RunOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly stdin?: "inherit" | "pipe" | "ignore";
  /**
   * Route the child's stdout to THIS process's stderr (fd 2). Used by
   * `--json` code paths where stdout must stay a single parseable
   * envelope while subprocess output remains visible to humans.
   */
  readonly stdout?: "inherit" | "stderr";
  readonly timeoutMs?: number;
  /** Forward cancellation to an owned command process group, preserving TTY input. */
  readonly forwardSignals?: boolean;
  readonly onSpawn?: (event: {
    readonly pid: number;
    readonly ownsProcessGroup: boolean;
    readonly processGroupId?: number;
  }) => Promise<void>;
  readonly onExit?: (event: RunExitEvent) => Promise<void>;
}

export type RunExitEvent = {
  readonly finishedAt: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly cpuTimeMs: number | null;
  readonly maxRssBytes: number | null;
};

export async function run(
  cmd: readonly string[],
  opts: RunOptions = {}
): Promise<number> {
  if (
    opts.forwardSignals &&
    (process.stdin.isTTY || hasControllingTerminal())
  ) {
    const { runWithTerminalGroup } = await import("./tty-run.ts");
    return await runWithTerminalGroup({
      command: cmd,
      cwd: opts.cwd,
      env: buildSpawnEnv(opts.env),
      stdout: opts.stdout,
      stdin: opts.stdin,
      timeoutMs: opts.timeoutMs,
      onSpawn: opts.onSpawn,
      onExit: opts.onExit,
    });
  }
  const ownsProcessGroup =
    opts.timeoutMs !== undefined || opts.forwardSignals === true;
  const proc = Bun.spawn([...cmd], {
    cwd: opts.cwd,
    env: buildSpawnEnv(opts.env),
    stdin: opts.stdin ?? "inherit",
    stdout: opts.stdout === "stderr" ? 2 : "inherit",
    stderr: "inherit",
    detached: ownsProcessGroup,
  });
  const timeout = installSubprocessTimeout({
    pid: proc.pid,
    timeoutMs: opts.timeoutMs,
  });
  const cancellation = opts.forwardSignals
    ? installSubprocessSignalForwarding({
        pid: proc.pid,
      })
    : null;
  // Observe completion immediately: diagnostic setup must not keep deadlines armed
  // after the command has exited. Record callbacks still finish in spawn/exit order.
  const completion = (async (): Promise<RunExitEvent> => {
    try {
      const exitCode = await proc.exited;
      const code =
        cancellation?.exitCode() ?? (timeout.didTimeout() ? 124 : exitCode);
      const usage = opts.onExit
        ? readSubprocessResourceUsage(proc)
        : { cpuTimeMs: null, maxRssBytes: null };
      return {
        finishedAt: new Date().toISOString(),
        exitCode: code,
        timedOut: timeout.didTimeout(),
        cancelled: cancellation?.exitCode() != null,
        ...usage,
      };
    } finally {
      timeout.dispose();
      cancellation?.dispose();
    }
  })();
  const [result] = await Promise.all([
    completion,
    opts.onSpawn?.({ pid: proc.pid, ownsProcessGroup }),
  ]);
  await opts.onExit?.(result);
  return result.exitCode;
}

/** Detached noninteractive children keep cancellation scoped to their group. */
function installSubprocessSignalForwarding(opts: { readonly pid: number }): {
  readonly dispose: () => void;
  readonly exitCode: () => number | null;
} {
  let exitCode: number | null = null;
  let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
  const send = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-opts.pid, signal);
    } catch {
      // The owned group may already have exited.
    }
  };
  const cancel = (signal: "SIGINT" | "SIGTERM"): void => {
    if (exitCode !== null) {
      send("SIGKILL");
      return;
    }
    exitCode = signal === "SIGINT" ? 130 : 143;
    send(signal);
    forceKillTimer = setTimeout(() => send("SIGKILL"), 2000);
  };
  const onInterrupt = (): void => cancel("SIGINT");
  const onTerminate = (): void => cancel("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  return {
    exitCode: () => exitCode,
    dispose: () => {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      if (exitCode !== null) {
        send("SIGKILL");
      }
    },
  };
}

function installSubprocessTimeout(opts: {
  readonly pid: number;
  readonly timeoutMs: number | undefined;
}): { readonly dispose: () => void; readonly didTimeout: () => boolean } {
  let timedOut = false;
  if (opts.timeoutMs === undefined) {
    return { dispose: () => undefined, didTimeout: () => false };
  }
  let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
  const signalProcessGroup = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-opts.pid, signal);
    } catch {
      try {
        process.kill(opts.pid, signal);
      } catch {
        return;
      }
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    signalProcessGroup("SIGTERM");
    forceKillTimer = setTimeout(() => signalProcessGroup("SIGKILL"), 2000);
  }, opts.timeoutMs);
  return {
    dispose: () => {
      clearTimeout(timer);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
        // The direct child may honor SIGTERM before its descendants do. Once
        // the child exits, finish cleaning the detached process group instead
        // of cancelling the only pending SIGKILL and orphaning descendants.
        signalProcessGroup("SIGKILL");
      }
    },
    didTimeout: () => timedOut,
  };
}

async function streamToText(
  stream: ReadableStream<Uint8Array> | null
): Promise<string> {
  if (!stream) {
    return "";
  }
  return await new Response(stream).text();
}

/**
 * Resolve an executable from the CURRENT `process.env.PATH`.
 *
 * `Bun.which(name)` consults the PATH snapshot captured at process startup,
 * so runtime PATH edits (tests isolating tool discovery, wrappers that
 * prepend shim dirs) would be ignored. Passing PATH explicitly keeps lookup
 * behavior identical for normal runs while honoring runtime changes.
 */
export function findExecutableInPath(executableName: string): string | null {
  const resolved = Bun.which(executableName, {
    PATH: process.env.PATH ?? "",
  });
  return typeof resolved === "string" ? resolved : null;
}

export class CommandError extends Error {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly cmd: readonly string[];

  constructor(opts: {
    readonly cmd: readonly string[];
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly message?: string;
  }) {
    super(
      opts.message ??
        `Command failed (exit ${opts.exitCode}): ${opts.cmd.join(" ")}`
    );
    this.name = "CommandError";
    this.exitCode = opts.exitCode;
    this.stdout = opts.stdout;
    this.stderr = opts.stderr;
    this.cmd = opts.cmd;
  }
}

export async function execOrThrow(
  cmd: readonly string[],
  opts: ExecOptions = {}
): Promise<ExecResult> {
  const res = await exec(cmd, opts);
  if (res.exitCode !== 0) {
    throw new CommandError({
      cmd,
      exitCode: res.exitCode,
      stdout: res.stdout,
      stderr: res.stderr,
    });
  }
  return res;
}
