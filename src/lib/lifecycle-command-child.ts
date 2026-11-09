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

/**
 * Run one finite lifecycle command with `sh -c` and drain its output.
 *
 * Without a signal the command keeps the caller's process group and terminal
 * stdin, as lifecycle hooks always have, and its output is drained until the
 * pipes close.
 *
 * With a signal the command owns a process-group cancellation boundary. The
 * shell leads a new process group, so the terminal's interrupt reaches only
 * the caller, which decides when to cancel; stdin is closed because a
 * background group cannot read the terminal. Abort sends SIGTERM to the whole
 * group, then SIGKILL once the shell exits or the grace period ends, so a
 * descendant such as `sleep` in `sleep 600; echo finished` cannot outlive the
 * cancellation. Output draining after cancellation is bounded by the same
 * grace period, so a process that escaped the group and still holds the pipes
 * cannot delay a forced stop. The listener stays installed until draining
 * finishes. The result is 130 when the signal aborted before the shell exited.
 */
export async function runLifecycleCommandChild(opts: {
  readonly command: string;
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly signal?: AbortSignal;
  readonly drain: (
    stream: ReadableStream<Uint8Array>,
    source: "stdout" | "stderr"
  ) => Promise<void>;
  /** Test seam; defaults to {@link CANCEL_GRACE_MS}. */
  readonly graceMs?: number;
}): Promise<number> {
  const signal = opts.signal;
  if (signal?.aborted) {
    return 130;
  }
  const owned = signal !== undefined;
  const proc = Bun.spawn(["sh", "-c", opts.command], {
    cwd: opts.cwd,
    env: opts.env,
    stdin: owned ? "ignore" : "inherit",
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
