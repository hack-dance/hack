/** Receives a child's stdout and stderr chunks in place of this process's streams. */
export interface OutputSink {
  write(chunk: Uint8Array, stream: "stdout" | "stderr"): void;
}

/**
 * How long a pump waits, once its command has settled, for a descendant that
 * still holds the pipes to close them before it stops reading.
 */
export const OUTPUT_DRAIN_GRACE_MS = 1000;

/**
 * Reads both streams into `sink` as chunks arrive, so a chatty child never
 * blocks on a full pipe. `settle` is called once the command has exited: it
 * waits for both streams to end, at most `graceMs`, then cancels the readers.
 * A chunk the sink throws on is dropped; reading continues.
 */
export function pumpOutput(opts: {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly sink: OutputSink;
}): { settle(graceMs?: number): Promise<void> } {
  const readers = [
    { reader: opts.stdout.getReader(), stream: "stdout" as const },
    { reader: opts.stderr.getReader(), stream: "stderr" as const },
  ];
  const drained = Promise.allSettled(
    readers.map(async ({ reader, stream }) => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        try {
          opts.sink.write(value, stream);
        } catch {
          // Keep reading: a full pipe would stall the child.
        }
      }
    })
  );
  return {
    settle: async (graceMs = OUTPUT_DRAIN_GRACE_MS) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const grace = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, graceMs);
      });
      try {
        await Promise.race([drained, grace]);
      } finally {
        clearTimeout(timer);
        await Promise.allSettled(readers.map(({ reader }) => reader.cancel()));
      }
    },
  };
}
