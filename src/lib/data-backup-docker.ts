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
}

function utf8(latin1: string): string {
  return Buffer.from(latin1, "latin1").toString("utf8");
}

/** The real Docker client on PATH, with Hack key material stripped from its env. */
export const hostDataBackupDocker: DataBackupDocker = {
  async capture(argv, opts) {
    const result = await exec(argv, {
      stdin: "ignore",
      ...(opts?.unbounded ? {} : { timeoutMs: METADATA_TIMEOUT_MS }),
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
      proc = spawnPiped(argv);
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
};

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

function spawnPiped(argv: readonly string[]) {
  return Bun.spawn([...argv], {
    env: childEnvironment(process.env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}
