import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../src/lib/guards.ts";

async function capture(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal
) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => {
    reader.cancel().catch(() => {});
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
      if (size > 512 * 1024) {
        cancel();
        throw new Error("Diagnostic control output exceeded its budget.");
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

async function accounting(
  scenario: "matched" | "pending" | "shell" | "unregistered"
) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "hack-cpu-tree-"))
  );
  const child = Bun.spawn(
    [
      "/usr/bin/python3",
      join(import.meta.dir, "fixtures/native-cpu-accounting.py"),
      process.execPath,
      join(import.meta.dir, "fixtures/native-cpu-accounting.ts"),
      join(directory, "report.json"),
      scenario,
    ],
    {
      env: { PATH: "/usr/bin:/bin" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: process.platform !== "win32",
    }
  );
  const io = new AbortController();
  let settled = false;
  let stopped = false;
  let cleanupFailed = false;
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
        if (!isRecord(error) || error.code !== "ESRCH") {
          cleanupFailed = true;
        }
      }
    }
    io.abort();
  };
  const stdout = capture(child.stdout, io.signal);
  const stderr = capture(child.stderr, io.signal);
  const timer = setTimeout(stop, 8000);
  try {
    const [output, diagnostics, exitCode] = await Promise.all([
      stdout,
      stderr,
      child.exited,
    ]);
    settled = true;
    expect(stopped).toBe(false);
    expect(cleanupFailed).toBe(false);
    expect(exitCode).toBe(0);
    expect(diagnostics).toBe("");
    for (const canary of ["argument", "env", "output", "error"]) {
      expect(output).not.toContain(`synthetic-${canary}-canary`);
    }
    const value: unknown = JSON.parse(output);
    if (!(isRecord(value) && isRecord(value.report))) {
      throw new Error("Expected closed numeric accounting observations");
    }
    return { observation: value, report: value.report };
  } finally {
    clearTimeout(timer);
    stop();
    await Promise.allSettled([stdout, stderr, child.exited]);
    await rm(directory, { recursive: true, force: true });
  }
}

test("real child and waited grandchild CPU plus process-birth self CPU reconcile with independent wait4", async () => {
  const { observation, report } = await accounting("matched");
  expect(observation.reapedExitCode).toBe(0);
  expect(report).toMatchObject({ recordsComplete: true, started: 2, ended: 2 });
  if (!Array.isArray(report.records) || report.records.length !== 2) {
    throw new Error("Missing exact child accounting matrix");
  }
  let childrenCpuMs = 0;
  for (const record of report.records) {
    if (!isRecord(record) || typeof record.cpuTimeMs !== "number") {
      throw new Error("Missing child CPU");
    }
    expect(record.exitCode).toBe(0);
    expect(record.category).toBe("other");
    expect(Number.isFinite(record.cpuTimeMs)).toBe(true);
    expect(record.maxRssBytes).toBeGreaterThan(0);
    childrenCpuMs += record.cpuTimeMs;
  }
  expect(report.records[0].cpuTimeMs).toBeGreaterThanOrEqual(50);
  // The direct parent waits for a real 120ms CPU-burning grandchild. Its reported
  // usage must include that work rather than silently omitting the descendant.
  expect(report.records[1].cpuTimeMs).toBeGreaterThanOrEqual(120);
  const selfCpuMs = Number(report.selfUserMs) + Number(report.selfSystemMs);
  expect(Number.isFinite(selfCpuMs)).toBe(true);
  expect(selfCpuMs).toBeGreaterThanOrEqual(80);
  const outerCpuMs = Number(observation.outerCpuTimeMs);
  expect(Number.isFinite(outerCpuMs) && outerCpuMs > 0).toBe(true);
  expect(Math.abs(selfCpuMs + childrenCpuMs - outerCpuMs)).toBeLessThanOrEqual(
    Math.max(50, outerCpuMs * 0.05)
  );
}, 10_000);

test("a deliberately unregistered real child fails outer CPU completeness despite an internally closed matrix", async () => {
  const { observation, report } = await accounting("unregistered");
  expect(observation.reapedExitCode).toBe(0);
  expect(report).toMatchObject({
    recordsComplete: true,
    started: 0,
    ended: 0,
    records: [],
  });
  const selfCpuMs = Number(report.selfUserMs) + Number(report.selfSystemMs);
  const outerCpuMs = Number(observation.outerCpuTimeMs);
  expect(Number.isFinite(selfCpuMs) && selfCpuMs >= 80).toBe(true);
  expect(Number.isFinite(outerCpuMs) && outerCpuMs > 0).toBe(true);
  expect(Math.abs(selfCpuMs - outerCpuMs)).toBeGreaterThan(
    Math.max(50, outerCpuMs * 0.05)
  );
}, 10_000);

test("a real registered child not reaped at finalization cannot qualify or later rewrite accounting", async () => {
  const { observation, report } = await accounting("pending");
  expect(observation.reapedExitCode).toBe(0);
  expect(report).toMatchObject({
    recordsComplete: false,
    started: 1,
    ended: 0,
    records: [],
  });
}, 10_000);

test("active diagnostics preserve real shell callbacks and share a single child usage sample", async () => {
  const { observation, report } = await accounting("shell");
  expect(report).toMatchObject({
    recordsComplete: true,
    exitCode: 17,
    started: 1,
    ended: 1,
  });
  if (!(isRecord(observation.shell) && Array.isArray(report.records))) {
    throw new Error("Missing real shell completion observations");
  }
  const record: unknown = report.records[0];
  if (!isRecord(record)) {
    throw new Error("Missing real shell child usage");
  }
  expect(observation.shell).toMatchObject({
    calls: ["spawn", "exit"],
    usageReads: 1,
    settledBeforeSpawnCallback: true,
    code: 17,
    callbackCpuMs: record.cpuTimeMs,
    callbackRssBytes: record.maxRssBytes,
  });
  expect(record).toMatchObject({ category: "other", exitCode: 17 });
}, 10_000);
