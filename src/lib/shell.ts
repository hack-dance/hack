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
  override: Record<string, string> | undefined,
  unsetKeys: readonly string[] = []
): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string" && !unsetKeys.includes(key)) {
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
  /** Remove explicitly unset authored destinations from the inherited host environment. */
  readonly unsetEnvKeys?: readonly string[];
  readonly stdin?: "inherit" | "pipe" | "ignore";
  /**
   * Route the child's stdout to THIS process's stderr (fd 2). Used by
   * `--json` code paths where stdout must stay a single parseable
   * envelope while subprocess output remains visible to humans. Ignore output
   * when an owned mutation would disclose private resource identities.
   */
  readonly stdout?: "inherit" | "stderr" | "ignore";
  readonly stderr?: "inherit" | "ignore";
  readonly timeoutMs?: number;
  /** Forward cancellation to an owned command process group, preserving TTY input. */
  readonly forwardSignals?: boolean;
  /**
   * Cancel the same owned process group as OS forwarding. Pre-aborted admission
   * returns 143 without spawning or invoking observations. The reason is private.
   */
  readonly signal?: AbortSignal;
  /** Synchronous admission after awaited setup, immediately before spawning. */
  readonly beforeSpawn?: () => void;
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
  const options = {
    ...opts,
    env: opts.env ? { ...opts.env } : undefined,
    unsetEnvKeys: opts.unsetEnvKeys ? [...opts.unsetEnvKeys] : undefined,
  };
  const command = [...cmd];
  const signal = options.signal;
  if (signal?.aborted) {
    return 143;
  }
  const beforeSpawn = options.beforeSpawn;
  if (
    options.forwardSignals &&
    (process.stdin.isTTY || hasControllingTerminal())
  ) {
    const { runWithTerminalGroup } = await import("./tty-run.ts");
    return await runWithTerminalGroup({
      command,
      cwd: options.cwd,
      env: buildSpawnEnv(options.env, options.unsetEnvKeys),
      stdout: options.stdout,
      stderr: options.stderr,
      stdin: options.stdin,
      timeoutMs: options.timeoutMs,
      signal,
      beforeSpawn,
      onSpawn: options.onSpawn,
      onExit: options.onExit,
    });
  }
  const ownsProcessGroup =
    options.timeoutMs !== undefined ||
    options.forwardSignals === true ||
    signal !== undefined;
  beforeSpawn?.();
  if (signal?.aborted) {
    return 143;
  }
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    env: buildSpawnEnv(options.env, options.unsetEnvKeys),
    stdin: options.stdin ?? "inherit",
    stdout: options.stdout === "stderr" ? 2 : (options.stdout ?? "inherit"),
    stderr: options.stderr ?? "inherit",
    detached: ownsProcessGroup,
  });
  const timeout = installSubprocessTimeout({
    pid: proc.pid,
    timeoutMs: options.timeoutMs,
  });
  const cancellation =
    options.forwardSignals || signal
      ? installSubprocessSignalForwarding({
          pid: proc.pid,
          forwardSignals: options.forwardSignals === true,
          signal,
        })
      : null;
  // Observe completion immediately: diagnostic setup must not keep deadlines armed
  // after the command has exited. Record callbacks still finish in spawn/exit order.
  const completion = (async (): Promise<RunExitEvent> => {
    try {
      const exitCode = await proc.exited;
      const code =
        cancellation?.exitCode() ?? (timeout.didTimeout() ? 124 : exitCode);
      const usage = options.onExit
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
    options.onSpawn?.({ pid: proc.pid, ownsProcessGroup }),
  ]);
  await options.onExit?.(result);
  return result.exitCode;
}

/** Detached noninteractive children keep cancellation scoped to their group. */
function installSubprocessSignalForwarding(opts: {
  readonly pid: number;
  readonly forwardSignals: boolean;
  readonly signal?: AbortSignal;
}): {
  readonly dispose: () => void;
  readonly exitCode: () => number | null;
} {
  let exitCode: number | null = null;
  let active = true;
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
  const onAbort = (): void => {
    // A caller's earlier OS handler may abort this signal in the same dispatch.
    // Let the existing OS owner retain SIGINT's 130 before generic abort's 143.
    queueMicrotask(() => {
      if (active && exitCode === null) {
        onTerminate();
      }
    });
  };
  if (opts.forwardSignals) {
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
  }
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  if (opts.signal?.aborted) {
    onAbort();
  }
  return {
    exitCode: () => exitCode,
    dispose: () => {
      active = false;
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
      opts.signal?.removeEventListener("abort", onAbort);
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
