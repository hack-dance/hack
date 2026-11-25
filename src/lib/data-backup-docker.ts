import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { childEnvironment } from "./child-environment.ts";
import { composeEnvValuesToRedact } from "./compose-ps-result.ts";
import { exec } from "./shell.ts";

/** Default bound for a capture that names none (model and metadata reads). */
const DEFAULT_CAPTURE_TIMEOUT_MS = 120_000;
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 16_384;

/** Exit code a stream reports when its bound ran out and the client was killed. */
export const DATA_BACKUP_TIMEOUT_EXIT = 124;

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
 * The only Docker effects of a data export or import, injected so tests run
 * without an engine. Every argv is complete (it starts with `docker`). Every
 * call is bounded: a run past its bound kills the client and reports
 * {@link DATA_BACKUP_TIMEOUT_EXIT}; the daemon-side container is the
 * caller's to remove (see data-backup-held-volume.ts).
 */
/**
 * The engine a data command's managed env selects, when it selects one:
 * a managed `DOCKER_HOST` or `DOCKER_CONTEXT` (values Hack added, not the
 * caller's own environment). Recovery instructions must target the same
 * engine.
 */
export type DataBackupEngineSelection = {
  readonly host: string | null;
  readonly context: string | null;
};

export interface DataBackupDocker {
  /**
   * Values the project's managed env adds to the client's environment (see
   * `composeEnvValuesToRedact`), such as a managed `DOCKER_HOST`. Every
   * refusal that quotes an engine line redacts them, in text and JSON.
   */
  readonly redactValues: readonly string[];
  /** The managed engine selection; absent means the caller's own engine. */
  readonly engine?: DataBackupEngineSelection;
  /**
   * The `hack data cleanup` command line that targets this command's
   * project, instance and env, for the given nonce; absent when the caller
   * is not the CLI.
   */
  readonly hackCleanupCommand?: (nonce: string) => string;
  /** Run `argv` and capture its UTF-8 output. */
  capture(
    argv: readonly string[],
    opts?: { readonly timeoutMs?: number }
  ): Promise<DataBackupProcessResult>;
  /**
   * Run `argv` and stream its stdout into a new file at `path` (created
   * exclusively, mode 0600, fsynced before return), hashing the bytes as they
   * pass. The file is left in place on failure. A failed write kills the
   * client and rethrows.
   */
  streamToFile(opts: {
    readonly argv: readonly string[];
    readonly path: string;
    readonly timeoutMs: number;
  }): Promise<DataBackupStreamResult>;
  /** Run `argv` with the file at `path` as its stdin, capturing its output. */
  streamFromFile(opts: {
    readonly argv: readonly string[];
    readonly path: string;
    readonly timeoutMs: number;
  }): Promise<DataBackupProcessResult>;
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

type Spawned = ReturnType<typeof Bun.spawn>;

/** Kill `proc` with SIGKILL after `timeoutMs`; `fired()` tells whether it did. */
function deadline(proc: Spawned, timeoutMs: number) {
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    proc.kill("SIGKILL");
  }, timeoutMs);
  return {
    fired: () => fired,
    clear: () => clearTimeout(timer),
  };
}

/**
 * The real Docker client. Every subprocess (Compose, `docker volume`, `ps`,
 * `events`, `create`, `exec` and `rm`) gets `env`, the project's managed
 * Compose env, over the inherited one, so a project that selects its engine
 * with a managed DOCKER_HOST or DOCKER_CONTEXT is read on that engine, and
 * runs in `cwd`. Hack key material is stripped as for every child.
 */
export function createHostDataBackupDocker(opts: {
  readonly env: Readonly<Record<string, string>>;
  /** Working directory for every call: the project's Compose directory. */
  readonly cwd?: string;
  /** Bound for a capture that names none (metadata reads). */
  readonly captureTimeoutMs?: number;
  /** See {@link DataBackupDocker.hackCleanupCommand}. */
  readonly hackCleanupCommand?: (nonce: string) => string;
}): DataBackupDocker {
  const env = { ...opts.env };
  const managed = (key: string): string | null => {
    const value = env[key];
    return value !== undefined && value !== "" && process.env[key] !== value
      ? value
      : null;
  };
  const cwd = opts.cwd;
  const captureTimeoutMs = opts.captureTimeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS;
  const spawn = (
    argv: readonly string[],
    stdin: "ignore" | Blob
  ): Bun.Subprocess<"ignore" | Blob, "pipe", "pipe"> =>
    Bun.spawn([...argv], {
      cwd,
      env: childEnvironment(process.env, env),
      stdin,
      stdout: "pipe",
      stderr: "pipe",
    }) as Bun.Subprocess<"ignore" | Blob, "pipe", "pipe">;
  return {
    redactValues: composeEnvValuesToRedact({ env }),
    engine: {
      host: managed("DOCKER_HOST"),
      context: managed("DOCKER_CONTEXT"),
    },
    hackCleanupCommand: opts.hackCleanupCommand,
    async capture(argv, captureOpts) {
      const result = await exec(argv, {
        cwd,
        env,
        stdin: "ignore",
        timeoutMs: captureOpts?.timeoutMs ?? captureTimeoutMs,
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
    async streamToFile({ argv, path, timeoutMs }) {
      const file = await open(path, "wx", 0o600);
      const hash = createHash("sha256");
      let bytes = 0;
      let proc: ReturnType<typeof spawn> | undefined;
      let bound: ReturnType<typeof deadline> | undefined;
      try {
        proc = spawn(argv, "ignore");
        bound = deadline(proc, timeoutMs);
        const stderr = boundedText(proc.stderr);
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
          exitCode: bound.fired() ? DATA_BACKUP_TIMEOUT_EXIT : exitCode,
          stderr: await stderr,
          bytes,
          sha256: hash.digest("hex"),
        };
      } catch (error: unknown) {
        // A failed write (a full disk) must not leave the client streaming.
        if (proc && proc.exitCode === null) {
          proc.kill("SIGKILL");
          await proc.exited;
        }
        throw error;
      } finally {
        bound?.clear();
        await file.close();
      }
    },
    async streamFromFile({ argv, path, timeoutMs }) {
      const proc = spawn(argv, Bun.file(path));
      const bound = deadline(proc, timeoutMs);
      try {
        const [stdout, stderr, exitCode] = await Promise.all([
          boundedText(proc.stdout, MAX_CAPTURE_BYTES),
          boundedText(proc.stderr),
          proc.exited,
        ]);
        return {
          exitCode: bound.fired() ? DATA_BACKUP_TIMEOUT_EXIT : exitCode,
          stdout,
          stderr,
        };
      } finally {
        bound.clear();
      }
    },
    watch(argv, onLine) {
      const proc = Bun.spawn([...argv], {
        cwd,
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

/** Read `stream` to the end, keeping at most `limit` bytes of text. */
async function boundedText(
  stream: ReadableStream<Uint8Array>,
  limit = MAX_STDERR_BYTES
): Promise<string> {
  const chunks: Buffer[] = [];
  let kept = 0;
  await eachChunk(stream, (chunk) => {
    if (kept < limit) {
      const part = Buffer.from(chunk).subarray(0, limit - kept);
      chunks.push(part);
      kept += part.byteLength;
    }
    return Promise.resolve();
  });
  return Buffer.concat(chunks).toString("utf8");
}
