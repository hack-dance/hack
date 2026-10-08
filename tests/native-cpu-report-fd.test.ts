import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function capture(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => {
    reader.cancel().catch(() => {
      // A concurrently closed owned pipe already satisfies cancellation.
    });
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) {
    cancel();
  }
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      size += next.value.byteLength;
      if (size > 1024) {
        cancel();
        throw new Error(
          "Diagnostic descriptor control output exceeded its budget."
        );
      }
      chunks.push(next.value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.concat(chunks)
  );
}

test("private report FD reaches Bun and is absent at the nested original index and 0..255 scan", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "hack-cpu-fd-"))
  );
  const child = Bun.spawn(
    [
      "/usr/bin/python3",
      join(import.meta.dir, "fixtures/native-cpu-report-fd.py"),
      process.execPath,
      join(import.meta.dir, "fixtures/native-cpu-report-fd.ts"),
      join(directory, "report.json"),
    ],
    {
      env: { PATH: "/usr/bin:/bin" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: process.platform !== "win32",
    }
  );
  let settled = false;
  let stopped = false;
  let cleanupFailed = false;
  const io = new AbortController();
  const stop = () => {
    if (!(settled || stopped)) {
      stopped = true;
      try {
        if (process.platform === "win32") {
          child.kill("SIGKILL");
        } else {
          process.kill(-child.pid, "SIGKILL");
        }
      } catch (error: unknown) {
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== "ESRCH"
        ) {
          cleanupFailed = true;
        }
      }
    }
    io.abort();
  };
  const stdoutRead = capture(child.stdout, io.signal);
  const stderrRead = capture(child.stderr, io.signal);
  const timer = setTimeout(stop, 8000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      stdoutRead,
      stderrRead,
      child.exited,
    ]);
    settled = true;
    expect(stopped).toBe(false);
    expect(cleanupFailed).toBe(false);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({
      directPrivateDescriptor: true,
      nestedOriginalDescriptorAndScan0to255Absent: true,
      nestedReapedExitCode: 0,
    });
  } finally {
    clearTimeout(timer);
    stop();
    await Promise.allSettled([stdoutRead, stderrRead, child.exited]);
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);
