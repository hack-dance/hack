import { Writable } from "node:stream";
import { watchLogConsumer } from "./native-log-consumer.ts";

/**
 * Compose-style service prefix, padded to the longest service name so the
 * columns line up: `api    | `.
 */
export function nativeLogPrefix(opts: {
  readonly service: string;
  readonly width: number;
}): string {
  return `${opts.service.padEnd(opts.width)} | `;
}

/**
 * A writable that prefixes every line it forwards to `target`. A partial line
 * waits for its newline (or `end`), so prefixes never land mid-line when
 * several services share one output. Each write completes only once `target`
 * accepted it, so the follower keeps its backpressure; a target error (for
 * example EPIPE after the reader went away) is passed back to the writer.
 */
export function prefixedLineWriter(opts: {
  readonly target: Writable;
  readonly prefix: string;
}): Writable {
  let pending = "";
  const forward = (text: string, done: (error?: Error | null) => void) => {
    if (text.length === 0) {
      done();
      return;
    }
    opts.target.write(text, (error) => done(error ?? null));
  };
  return new Writable({
    decodeStrings: false,
    write(chunk: string | Buffer, _encoding, done) {
      pending += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const end = pending.lastIndexOf("\n");
      if (end < 0) {
        done();
        return;
      }
      const complete = pending.slice(0, end + 1);
      pending = pending.slice(end + 1);
      forward(
        complete
          .slice(0, -1)
          .split("\n")
          .map((line) => `${opts.prefix}${line}\n`)
          .join(""),
        done
      );
    },
    final(done) {
      const rest = pending;
      pending = "";
      forward(rest ? `${opts.prefix}${rest}\n` : "", done);
    },
  });
}

/**
 * Follows every service at once, as `hack logs --follow` without a service
 * does on Compose. Each service gets its own follower (and so its own
 * restart handling and bounded admission); text output is prefixed with the
 * service name, JSON events already carry it.
 *
 * Exit code: a cancellation (130 for Ctrl-C, 143 for SIGTERM) wins; otherwise
 * 0 when every follower ended cleanly, else the first failure's code. One
 * service failing does not stop the others. When the reader of stdout goes
 * away, every follower is told its output closed.
 */
export async function followAllNativeServices(opts: {
  readonly services: readonly string[];
  readonly json: boolean;
  readonly follow: (input: {
    readonly service: string;
    readonly stdout: Writable;
    readonly stderr: Writable;
  }) => Promise<number>;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
}): Promise<number> {
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const width = Math.max(0, ...opts.services.map((s) => s.length));
  const writers: Writable[] = [];
  const writersOf = new Map<Writable, Writable[]>([
    [stdout, []],
    [stderr, []],
  ]);
  const outputs = opts.services.map((service) => {
    if (opts.json) {
      return { service, stdout, stderr };
    }
    const prefix = nativeLogPrefix({ service, width });
    const out = prefixedLineWriter({ target: stdout, prefix });
    const err = prefixedLineWriter({ target: stderr, prefix });
    writers.push(out, err);
    writersOf.get(stdout)?.push(out);
    writersOf.get(stderr)?.push(err);
    return { service, stdout: out, stderr: err };
  });
  const closeAll = () => {
    for (const writer of writers) {
      writer.destroy();
    }
  };
  // A stream that failed for another reason also emits `close`; that is
  // not the reader going away, so it must not tear down stderr's writers.
  const failed = new Set<Writable>();
  const dispose = await watchLogConsumer(stdout, () => {
    if (!failed.has(stdout)) {
      closeAll();
    }
  });
  // The shared targets emit their own errors; consume them here. A closed
  // consumer (EPIPE when the reader of `hack logs | head` goes away) ends
  // every follower quietly. Any other failure (EIO, ENOSPC) fails only the
  // writers on that target, so each follower can still print its fixed
  // diagnostic on the other stream.
  const targets = [...new Set([stdout, stderr])];
  const targetError = new Map<Writable, (error: Error) => void>(
    targets.map((target) => [
      target,
      (error: Error) => {
        if (consumerClosed(error)) {
          closeAll();
          return;
        }
        failed.add(target);
        for (const writer of writersOf.get(target) ?? []) {
          writer.destroy(error);
        }
      },
    ])
  );
  if (!opts.json) {
    for (const [target, listener] of targetError) {
      target.on("error", listener);
    }
  }
  try {
    const codes = await Promise.all(
      outputs.map(async (output) => {
        let code = 1;
        try {
          code = await opts.follow(output);
          return code;
        } finally {
          await finishWriters({
            writers: [output.stdout, output.stderr].filter(
              (writer) => writer !== stdout && writer !== stderr
            ),
            canceled: code === 130 || code === 143,
          });
        }
      })
    );
    return (
      codes.find((code) => code === 130 || code === 143) ??
      codes.find((code) => code !== 0) ??
      0
    );
  } finally {
    if (!opts.json) {
      for (const [target, listener] of targetError) {
        target.off("error", listener);
      }
    }
    dispose();
  }
}

/** The reader went away: a broken pipe or a stream already torn down. */
function consumerClosed(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED")
  );
}

/** Longest wait for a prefixed writer to flush its last partial line. */
const FLUSH_BOUND_MS = 1000;

/**
 * Ends a follower's prefixed writers. After a cancellation, or when a flush
 * does not finish within {@link FLUSH_BOUND_MS} (a consumer that stays open
 * but stops reading), the writers are destroyed instead, so follow-all
 * always returns its code.
 */
async function finishWriters(opts: {
  readonly writers: readonly Writable[];
  readonly canceled: boolean;
}): Promise<void> {
  await Promise.all(
    opts.writers.map(async (writer) => {
      if (writer.destroyed) {
        return;
      }
      if (opts.canceled) {
        writer.destroy();
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        new Promise<void>((resolve) => writer.end(resolve)),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, FLUSH_BOUND_MS);
        }),
      ]);
      clearTimeout(timer);
      if (!writer.writableFinished) {
        writer.destroy();
      }
    })
  );
}
