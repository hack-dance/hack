import { childEnvironment } from "./child-environment.ts";
import { hasControllingTerminal } from "./tty-process-group.ts";

/** SIGTERM-to-SIGKILL grace, and the output-drain bound after cancellation. */
const CANCEL_GRACE_MS = 2000;

/** A pipe reader whose pending read can be ended without the writer closing. */
function interruptible(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  return {
    stream: new ReadableStream<Uint8Array>({
      async pull(controller) {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      },
      cancel: (reason) => reader.cancel(reason),
    }),
    stop: () => {
      reader.cancel().catch(() => undefined);
    },
  };
}

interface LifecycleCommandOptions {
  readonly command: string;
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly signal?: AbortSignal;
  readonly inheritStdin?: boolean;
  readonly drain: (
    stream: ReadableStream<Uint8Array>,
    source: "stdout" | "stderr"
  ) => Promise<void>;
  /** Test seam; defaults to {@link CANCEL_GRACE_MS}. */
  readonly graceMs?: number;
}

/**
 * Run one finite lifecycle command and drain its output. Without cancellation,
 * the shell keeps the caller's process group and inherits stdin.
 *
 * A cancellable command gets an owned process group. The terminal supervisor
 * makes that group foreground when the hook inherits an attached terminal.
 * Without a terminal, an inheriting hook receives the existing input descriptor.
 * Abort terminates the group and bounds output draining for escaped descendants.
 */
export async function runLifecycleCommandChild(
  opts: LifecycleCommandOptions
): Promise<number> {
  const signal = opts.signal;
  if (signal?.aborted) {
    return 130;
  }
  const owned = signal !== undefined;
  if (
    owned &&
    opts.inheritStdin &&
    (process.stdin.isTTY || hasControllingTerminal())
  ) {
    return await runTerminalLifecycleCommand(opts);
  }
  const proc = Bun.spawn(["sh", "-c", opts.command], {
    cwd: opts.cwd,
    env: childEnvironment(opts.env),
    stdin: !owned || opts.inheritStdin ? "inherit" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: owned,
  });
  const stdout = interruptible(proc.stdout);
  const stderr = interruptible(proc.stderr);
  const drained = Promise.all([
    opts.drain(stdout.stream, "stdout"),
    opts.drain(stderr.stream, "stderr"),
  ]);
  // Awaited below; observed now so an early drain failure is not unhandled.
  drained.catch(() => undefined);
  const graceMs = opts.graceMs ?? CANCEL_GRACE_MS;
  const signalGroup = (name: NodeJS.Signals): void => {
    try {
      process.kill(-proc.pid, name);
    } catch {
      // The owned group already exited.
    }
  };
  let exited = false;
  let canceled = false;
  let kill: ReturnType<typeof setTimeout> | undefined;
  let release: ReturnType<typeof setTimeout> | undefined;
  const cancel = (): void => {
    if (canceled) {
      return;
    }
    canceled = true;
    signalGroup(exited ? "SIGKILL" : "SIGTERM");
    if (!exited) {
      kill = setTimeout(() => signalGroup("SIGKILL"), graceMs);
    }
    release = setTimeout(() => {
      stdout.stop();
      stderr.stop();
    }, graceMs);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const code = await proc.exited;
    exited = true;
    const aborted = signal?.aborted === true;
    if (canceled) {
      // The shell is gone; descendants must not outlive a forced stop.
      clearTimeout(kill);
      signalGroup("SIGKILL");
    }
    await drained;
    return aborted ? 130 : code;
  } finally {
    signal?.removeEventListener("abort", cancel);
    clearTimeout(kill);
    clearTimeout(release);
  }
}

async function runTerminalLifecycleCommand(
  opts: LifecycleCommandOptions
): Promise<number> {
  const { runWithTerminalGroup } = await import("./tty-run.ts");
  let output:
    | { readonly drained: Promise<unknown>; readonly stop: () => void }
    | undefined;
  const code = await runWithTerminalGroup({
    command: ["sh", "-c", opts.command],
    cwd: opts.cwd,
    env: opts.env,
    signal: opts.signal,
    onOutput: (streams) => {
      const stdout = interruptible(streams.stdout);
      const stderr = interruptible(streams.stderr);
      const drained = Promise.all([
        opts.drain(stdout.stream, "stdout"),
        opts.drain(stderr.stream, "stderr"),
      ]);
      drained.catch(() => undefined);
      output = {
        drained,
        stop: () => {
          stdout.stop();
          stderr.stop();
        },
      };
    },
  });
  const stop = output?.stop;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopAfterGrace = () => {
    if (stop) {
      timer ??= setTimeout(stop, opts.graceMs ?? CANCEL_GRACE_MS);
    }
  };
  opts.signal?.addEventListener("abort", stopAfterGrace, { once: true });
  if (opts.signal?.aborted || code === 130 || code === 143) {
    stopAfterGrace();
  }
  try {
    await output?.drained;
    return opts.signal?.aborted ? 130 : code;
  } finally {
    opts.signal?.removeEventListener("abort", stopAfterGrace);
    clearTimeout(timer);
  }
}
