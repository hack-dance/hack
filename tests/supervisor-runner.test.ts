import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJobStore } from "../src/control-plane/extensions/supervisor/job-store.ts";
import { runJob } from "../src/control-plane/extensions/supervisor/runner.ts";
import { readTextFile } from "../src/lib/fs.ts";

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

test("runJob writes logs and completes successfully", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-supervisor-runner-"));
  const projectDir = join(tempDir, ".hack");
  await mkdir(projectDir, { recursive: true });

  const store = await createJobStore({ projectDir });
  await store.createJob({
    jobId: "job-1",
    runner: "generic",
    command: [
      process.execPath,
      "-e",
      "console.log('hello'); console.error('oops')",
    ],
    projectId: "proj-1",
    projectName: "demo",
  });

  const result = await runJob({
    jobStore: store,
    jobId: "job-1",
  });

  expect(result.exitCode).toBe(0);
  expect(result.status).toBe("completed");

  const paths = store.getJobPaths({ jobId: "job-1" });
  const stdout = await readTextFile(paths.stdoutPath);
  const stderr = await readTextFile(paths.stderrPath);
  const combined = await readTextFile(paths.combinedPath);

  expect(stdout ?? "").toContain("hello");
  expect(stderr ?? "").toContain("oops");
  expect(combined ?? "").toContain("hello");
  expect(combined ?? "").toContain("oops");

  const meta = await store.readJobMeta({ jobId: "job-1" });
  expect(meta?.status).toBe("completed");
  expect(meta?.lastEventSeq).toBe(4);
});

test("runJob records failed status for non-zero exit", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-supervisor-runner-"));
  const projectDir = join(tempDir, ".hack");
  await mkdir(projectDir, { recursive: true });

  const store = await createJobStore({ projectDir });
  await store.createJob({
    jobId: "job-2",
    runner: "generic",
    command: [process.execPath, "-e", "process.exit(1)"],
  });

  const result = await runJob({
    jobStore: store,
    jobId: "job-2",
  });

  expect(result.exitCode).toBe(1);
  expect(result.status).toBe("failed");

  const meta = await store.readJobMeta({ jobId: "job-2" });
  expect(meta?.status).toBe("failed");

  const events = await store.readEvents({ jobId: "job-2" });
  const types = events.map((event) => event.type);
  expect(types).toContain("job.failed");
});

test("cancellation survives process exit before terminal persistence and is recorded once", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-supervisor-runner-"));
  const store = await createJobStore({ projectDir: join(tempDir, ".hack") });
  await store.createJob({
    jobId: "cancel-before-write",
    runner: "generic",
    command: [process.execPath, "-e", "setTimeout(() => {}, 5000)"],
  });
  const terminalWrite = Promise.withResolvers<void>();
  const allowWrite = Promise.withResolvers<void>();
  let cancel: () => Promise<boolean> = async () => false;
  let cancellations: Promise<boolean>[] = [];
  let processExited: Promise<number> = Promise.resolve(0);
  const run = runJob({
    jobId: "cancel-before-write",
    jobStore: {
      ...store,
      updateJobStatus: async (opts) => {
        if (["cancelled", "completed", "failed"].includes(opts.status)) {
          terminalWrite.resolve();
          await allowWrite.promise;
        }
        return await store.updateJobStatus(opts);
      },
    },
    onSpawn: (control) => {
      cancel = control.cancel;
      processExited = control.proc.exited;
      cancellations = [cancel(), cancel()];
    },
  });
  try {
    await terminalWrite.promise;
    await processExited;
    // The killed process has exited, but no terminal metadata has been saved.
    expect(
      (await store.readJobMeta({ jobId: "cancel-before-write" }))?.status
    ).toBe("running");
  } finally {
    allowWrite.resolve();
    await run;
  }
  expect(await Promise.all(cancellations)).toEqual([true, true]);
  expect((await run).status).toBe("cancelled");
  expect(
    (await store.readJobMeta({ jobId: "cancel-before-write" }))?.status
  ).toBe("cancelled");
  const events = await store.readEvents({ jobId: "cancel-before-write" });
  expect(events.map((event) => event.type)).toEqual([
    "job.created",
    "job.starting",
    "job.started",
    "job.cancelled",
  ]);
  expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
});

test("late cancellation cannot replace a completed outcome while its write is pending", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-supervisor-runner-"));
  const store = await createJobStore({ projectDir: join(tempDir, ".hack") });
  await store.createJob({
    jobId: "completion-first",
    runner: "generic",
    command: [process.execPath, "-e", "process.exit(0)"],
  });
  const terminalWrite = Promise.withResolvers<void>();
  const allowWrite = Promise.withResolvers<void>();
  let cancel: () => Promise<boolean> = async () => false;
  const run = runJob({
    jobId: "completion-first",
    jobStore: {
      ...store,
      updateJobStatus: async (opts) => {
        if (opts.status === "completed") {
          terminalWrite.resolve();
          await allowWrite.promise;
        }
        return await store.updateJobStatus(opts);
      },
    },
    onSpawn: (control) => {
      cancel = control.cancel;
    },
  });
  try {
    await terminalWrite.promise;
    expect(await cancel()).toBe(false);
  } finally {
    allowWrite.resolve();
    await run;
  }
  expect((await run).status).toBe("completed");
  expect((await store.readJobMeta({ jobId: "completion-first" }))?.status).toBe(
    "completed"
  );
  const events = await store.readEvents({ jobId: "completion-first" });
  expect(events.map((event) => event.type)).toEqual([
    "job.created",
    "job.starting",
    "job.started",
    "job.completed",
  ]);
});

test("cancellation acknowledgement does not wait for a process that ignores SIGTERM", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-supervisor-runner-"));
  const readyPath = join(tempDir, "ready");
  const store = await createJobStore({ projectDir: join(tempDir, ".hack") });
  await store.createJob({
    jobId: "ignores-signal",
    runner: "generic",
    command: [
      process.execPath,
      "-e",
      `process.on("SIGTERM", () => {}); await Bun.write(${JSON.stringify(readyPath)}, "ready"); setInterval(() => {}, 1000);`,
    ],
  });
  let control:
    | Parameters<NonNullable<Parameters<typeof runJob>[0]["onSpawn"]>>[0]
    | undefined;
  const run = runJob({
    jobStore: store,
    jobId: "ignores-signal",
    onSpawn: (value) => {
      control = value;
    },
  });
  let exited = false;
  const observedRun = run.finally(() => {
    exited = true;
  });
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = Date.now() + 2000;
    while (!(await Bun.file(readyPath).exists())) {
      if (Date.now() > deadline) {
        throw new Error("Child did not become ready");
      }
      await Bun.sleep(10);
    }
    if (!control) {
      throw new Error("Missing process control");
    }
    const deadlinePromise = new Promise<never>((_resolve, reject) => {
      deadlineTimer = setTimeout(
        () => reject(new Error("Cancellation waited for process exit")),
        2000
      );
    });
    expect(await Promise.race([control.cancel(), deadlinePromise])).toBe(true);
    expect(exited).toBe(false);
    expect((await store.readJobMeta({ jobId: "ignores-signal" }))?.status).toBe(
      "cancelled"
    );
  } finally {
    clearTimeout(deadlineTimer);
    control?.proc.kill("SIGKILL");
    await observedRun;
  }
  expect((await run).status).toBe("cancelled");
});
