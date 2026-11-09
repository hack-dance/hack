import { spawn } from "node:child_process";

const MAX_OUTPUT = 64 * 1024;
const TIMEOUT_MS = 30_000;
const INHERITED = ["PATH", "HOME", "TMPDIR", "USER", "LOGNAME"] as const;

/**
 * Run one credential CLI request and return its stdout privately.
 *
 * Contract shared by the native credential adapters:
 * - The child gets a clean environment: only PATH, HOME, TMPDIR, USER and LOGNAME
 *   from this process plus the caller's fixed `environment`. Ambient credential
 *   selectors (AWS_*, CLOUDSDK_*, GOOGLE_*) never reach it.
 * - stdin and stderr are ignored; only stdout is captured, capped at 64 KiB.
 * - The child leads its own process group. Timeout (30 s), oversize output,
 *   a stream error or settlement kills that group with SIGKILL; a persisted PID
 *   is never used and the request is never retried.
 * - Captured chunks are zero-filled after copying. The caller owns the returned
 *   buffer and must zero-fill it when done.
 *
 * Every failure rejects with `refused()`, except a missing executable, which
 * rejects with `missing()` when supplied. Neither error carries output.
 */
export function runNativePrivateCli(opts: {
  readonly executable: string;
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly refused: () => Error;
  readonly missing?: () => Error;
  readonly timeoutMs?: number;
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = { ...opts.environment };
    for (const key of INHERITED) {
      const value = process.env[key];
      if (value !== undefined) {
        env[key] = value;
      }
    }
    const child = spawn(opts.executable, [...opts.args], {
      env,
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const stop = () => {
      // The unreaped direct child starts a new POSIX group owned by this request.
      if (
        child.pid !== undefined &&
        child.exitCode === null &&
        child.signalCode === null
      ) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // Already exited; never use a persisted PID or retry the request.
        }
      }
      child.stdout?.destroy();
    };
    const finish = (outcome: "ok" | "refused" | "missing") => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      stop();
      if (outcome === "ok") {
        resolve(Buffer.concat(chunks));
      } else {
        reject(
          outcome === "missing" && opts.missing
            ? opts.missing()
            : opts.refused()
        );
      }
      for (const chunk of chunks) {
        chunk.fill(0);
      }
    };
    const timer = setTimeout(
      () => finish("refused"),
      opts.timeoutMs ?? TIMEOUT_MS
    );
    child.on("error", (error: NodeJS.ErrnoException) =>
      finish(error.code === "ENOENT" ? "missing" : "refused")
    );
    child.stdout?.on("error", () => finish("refused"));
    child.stdout?.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_OUTPUT) {
        chunk.fill(0);
        finish("refused");
        return;
      }
      chunks.push(chunk);
    });
    child.on("close", (code) => finish(code === 0 ? "ok" : "refused"));
  });
}
