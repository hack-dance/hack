import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { childEnvironment } from "./child-environment.ts";
import { exec } from "./shell.ts";

/** Bound for model and metadata reads; helper copies have no time limit. */
const METADATA_TIMEOUT_MS = 120_000;
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 16_384;

export type DataBackupProcessResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type DataBackupStreamResult = {
  readonly exitCode: number;
  readonly stderr: string;
  readonly bytes: number;
  readonly sha256: string;
};

/**
 * The only Docker effects of a data export, injected so tests run without an
 * engine. Every argv is complete (it starts with `docker`).
 */
export interface DataBackupDocker {
  /** Run a bounded read and capture its UTF-8 output. */
  capture(
    argv: readonly string[],
    opts?: { readonly unbounded?: boolean }
  ): Promise<DataBackupProcessResult>;
  /**
   * Run `argv` and stream its stdout into a new file at `path` (created
   * exclusively, mode 0600, fsynced before return), hashing the bytes as they
   * pass. The file is left in place on failure.
   */
  streamToFile(opts: {
    readonly argv: readonly string[];
    readonly path: string;
  }): Promise<DataBackupStreamResult>;
  /**
   * Start a long-running `argv` (a `docker events` subscription) and call
   * `onLine` for each complete stdout line, in order.
   */
  watch(
    argv: readonly string[],
    onLine: (line: string) => void
  ): DataBackupWatch;
}

/** A running subscription started by {@link DataBackupDocker.watch}. */
export interface DataBackupWatch {
  /** Settles once the child has exited and its stdout is fully read. */
  readonly done: Promise<{ readonly exitCode: number }>;
  /**
   * SIGTERM, a bounded drain of what it already wrote, then SIGKILL if it is
   * still running; always awaits the exit. Idempotent.
   */
  stop(): Promise<void>;
}

/** How long a stopped subscription may take to drain before SIGKILL. */
const WATCH_DRAIN_MS = 2000;

function utf8(latin1: string): string {
  return Buffer.from(latin1, "latin1").toString("utf8");
}

/**
 * The real Docker client. Every subprocess (Compose, `docker volume`, `ps`,
 * `events` and the helper runs) gets `env`, the project's managed Compose
 * env, over the inherited one, so a project that selects its engine with a
 * managed DOCKER_HOST or DOCKER_CONTEXT is read on that engine. Hack key
 * material is stripped as for every child.
 */
export function createHostDataBackupDocker(opts: {
  readonly env: Readonly<Record<string, string>>;
}): DataBackupDocker {
  const env = { ...opts.env };
  return {
    async capture(argv, captureOpts) {
      const result = await exec(argv, {
        env,
        stdin: "ignore",
        ...(captureOpts?.unbounded ? {} : { timeoutMs: METADATA_TIMEOUT_MS }),
        maxStdoutBytes: MAX_CAPTURE_BYTES,
        maxStderrBytes: MAX_STDERR_BYTES,
        forwardSignals: true,
      });
      return {
        exitCode: result.exitCode,
        stdout: utf8(result.stdout),
        stderr: utf8(result.stderr),
      };
    },
    async streamToFile({ argv, path }) {
      const file = await open(path, "wx", 0o600);
      const hash = createHash("sha256");
      let bytes = 0;
      let proc: ReturnType<typeof spawnPiped> | undefined;
      try {
        proc = spawnPiped(argv, env);
        const errors = proc.stderr;
        const stderr = (async () => {
          let text = "";
          await eachChunk(errors, (chunk) => {
            if (text.length < MAX_STDERR_BYTES) {
              text += Buffer.from(chunk).toString("utf8");
            }
            return Promise.resolve();
          });
          return text.slice(0, MAX_STDERR_BYTES);
        })();
        await eachChunk(proc.stdout, async (chunk) => {
          hash.update(chunk);
          bytes += chunk.byteLength;
          let offset = 0;
          while (offset < chunk.byteLength) {
            const { bytesWritten } = await file.write(chunk, offset);
            offset += bytesWritten;
          }
        });
        const exitCode = await proc.exited;
        await file.sync();
        return {
          exitCode,
          stderr: await stderr,
          bytes,
          sha256: hash.digest("hex"),
        };
      } catch (error: unknown) {
        // A failed write (a full disk) must not leave the helper streaming.
        if (proc && proc.exitCode === null) {
          proc.kill("SIGKILL");
          await proc.exited;
        }
        throw error;
      } finally {
        await file.close();
      }
    },
    watch(argv, onLine) {
      const proc = Bun.spawn([...argv], {
        env: childEnvironment(process.env, env),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      });
      const done = (async () => {
        const decoder = new TextDecoder();
        let pending = "";
        try {
          await eachChunk(proc.stdout, (chunk) => {
            pending += decoder.decode(chunk, { stream: true });
            let newline = pending.indexOf("\n");
            while (newline >= 0) {
              onLine(pending.slice(0, newline));
              pending = pending.slice(newline + 1);
              newline = pending.indexOf("\n");
            }
            return Promise.resolve();
          });
        } finally {
          if (pending !== "") {
            onLine(pending);
          }
        }
        return { exitCode: await proc.exited };
      })();
      let stopping: Promise<void> | undefined;
      return {
        done,
        stop() {
          stopping ??= (async () => {
            if (proc.exitCode === null && proc.signalCode === null) {
              proc.kill("SIGTERM");
            }
            let timer: ReturnType<typeof setTimeout> | undefined;
            const drained = await Promise.race([
              done.then(
                () => true,
                () => true
              ),
              new Promise<false>((resolve) => {
                timer = setTimeout(() => resolve(false), WATCH_DRAIN_MS);
              }),
            ]);
            clearTimeout(timer);
            if (!drained) {
              proc.kill("SIGKILL");
            }
            await proc.exited;
            await done.catch(() => undefined);
          })();
          return stopping;
        },
      };
    },
  };
}

async function eachChunk(
  stream: ReadableStream<Uint8Array>,
  onChunk: (chunk: Uint8Array) => Promise<void>
): Promise<void> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      await onChunk(value);
    }
  } finally {
    reader.releaseLock();
  }
}

function spawnPiped(
  argv: readonly string[],
  env: Readonly<Record<string, string>>
) {
  return Bun.spawn([...argv], {
    env: childEnvironment(process.env, env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}
