import { afterEach, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createJobStore } from "../src/control-plane/extensions/supervisor/job-store.ts";
import { createSupervisorService } from "../src/control-plane/extensions/supervisor/service.ts";
import { readTextFile } from "../src/lib/fs.ts";

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

test("Supervisor service creates and lists jobs", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-supervisor-service-"));
  const projectDir = join(tempDir, ".hack");
  await mkdir(projectDir, { recursive: true });

  const service = createSupervisorService();
  const created = await service.createJob({
    projectDir,
    runner: "generic",
    command: [process.execPath, "-e", "console.log('ok')"],
  });

  const result = await created.run;
  expect(result.status).toBe("completed");

  const list = await service.listJobs({ projectDir });
  expect(list.length).toBe(1);
  expect(list[0]?.jobId).toBe(created.jobId);

  const job = await service.getJob({ projectDir, jobId: created.jobId });
  expect(job?.status).toBe("completed");

  const paths = join(
    projectDir,
    "supervisor",
    "jobs",
    created.jobId,
    "combined.log"
  );
  const combined = await readTextFile(paths);
  expect(combined ?? "").toContain("ok");
});

test("Supervisor service cancels running jobs", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-supervisor-service-"));
  const projectDir = join(tempDir, ".hack");
  await mkdir(projectDir, { recursive: true });

  const service = createSupervisorService();
  const created = await service.createJob({
    projectDir,
    runner: "generic",
    command: [process.execPath, "-e", "setTimeout(() => {}, 5000)"],
  });

  await waitForJobStatus({
    service,
    projectDir,
    jobId: created.jobId,
    status: "running",
    timeoutMs: 10_000,
  });

  const cancel = await service.cancelJob({ projectDir, jobId: created.jobId });
  expect(cancel.ok).toBe(true);
  // A successful cancellation response includes durable terminal state.
  expect(
    (await service.getJob({ projectDir, jobId: created.jobId }))?.status
  ).toBe("cancelled");
  const store = await createJobStore({ projectDir });
  const events = await store.readEvents({ jobId: created.jobId });
  expect(events.filter((event) => event.type === "job.cancelled")).toHaveLength(
    1
  );
  expect(events.some((event) => event.type === "job.failed")).toBe(false);
  const result = await created.run;
  expect(result.status).toBe("cancelled");
  expect(await service.cancelJob({ projectDir, jobId: created.jobId })).toEqual(
    { ok: false, status: "not_running" }
  );

  const job = await service.getJob({ projectDir, jobId: created.jobId });
  expect(job?.status).toBe("cancelled");
});

test("cancellation waits for startup publication after observing running", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-supervisor-service-"));
  const projectDir = join(tempDir, ".hack");
  const gap = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const published = Promise.withResolvers<void>();
  const cancelRead = Promise.withResolvers<void>();
  const service = createSupervisorService({
    createStore: async (opts) => {
      const store = await createJobStore(opts);
      return {
        ...store,
        readJobMeta: async (input) => {
          const meta = await store.readJobMeta(input);
          if (meta?.status === "running") {
            cancelRead.resolve();
          }
          return meta;
        },
        appendEvent: async (input) => {
          if (input.type !== "job.started") {
            return await store.appendEvent(input);
          }
          gap.resolve();
          await release.promise;
          try {
            return await store.appendEvent(input);
          } finally {
            published.resolve();
          }
        },
      };
    },
  });
  const created = await service.createJob({
    projectDir,
    runner: "generic",
    command: [process.execPath, "-e", "setTimeout(() => {}, 5000)"],
  });
  await gap.promise;
  const store = await createJobStore({ projectDir });
  expect((await store.readJobMeta({ jobId: created.jobId }))?.status).toBe(
    "running"
  );
  let settled = false;
  const cancellation = service
    .cancelJob({ projectDir, jobId: created.jobId })
    .finally(() => {
      settled = true;
    });
  try {
    await cancelRead.promise;
    // Allow the cancellation continuation to run while startup remains explicitly
    // blocked. This is an event-loop handoff, not a race against an elapsed delay.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    release.resolve();
    expect(await cancellation).toEqual({ ok: true, status: "cancelled" });
    expect((await created.run).status).toBe("cancelled");
    expect((await store.readJobMeta({ jobId: created.jobId }))?.status).toBe(
      "cancelled"
    );
    expect(
      (await store.readEvents({ jobId: created.jobId })).map(
        (event) => event.type
      )
    ).toEqual(["job.created", "job.starting", "job.started", "job.cancelled"]);
  } finally {
    release.resolve();
    await published.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await service.cancelJob({ projectDir, jobId: created.jobId });
    await created.run;
  }
});

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForJobStatus(opts: {
  readonly service: ReturnType<typeof createSupervisorService>;
  readonly projectDir: string;
  readonly jobId: string;
  readonly status:
    | "starting"
    | "running"
    | "completed"
    | "failed"
    | "cancelled";
  readonly timeoutMs: number;
}): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    const job = await opts.service.getJob({
      projectDir: opts.projectDir,
      jobId: opts.jobId,
    });
    if (job?.status === opts.status) {
      return;
    }
    await sleep(25);
  }
  throw new Error(`Timed out waiting for job status: ${opts.status}`);
}

for (const failurePoint of ["status", "event-before", "event-after"] as const) {
  test(`cancellation persistence failure at ${failurePoint} preserves the claimed outcome`, async () => {
    tempDir = await mkdtemp(join(tmpdir(), "hack-supervisor-service-"));
    const projectDir = join(tempDir, ".hack");
    const failure = new Error(`Injected ${failurePoint} failure`);
    const service = createSupervisorService({
      createStore: async (opts) => {
        const store = await createJobStore(opts);
        return {
          ...store,
          updateJobStatus: async (input) => {
            if (input.status === "cancelled" && failurePoint === "status") {
              throw failure;
            }
            return await store.updateJobStatus(input);
          },
          appendEvent: async (input) => {
            if (input.type !== "job.cancelled") {
              return await store.appendEvent(input);
            }
            if (failurePoint === "event-before") {
              throw failure;
            }
            if (failurePoint === "event-after") {
              const meta = await store.readJobMeta({ jobId: input.jobId });
              if (!meta) {
                throw new Error("Missing test job");
              }
              // Fail after the event append, before its sequence reaches metadata.
              await appendFile(
                store.getJobPaths(input).eventsPath,
                `${JSON.stringify({
                  seq: meta.lastEventSeq + 1,
                  ts: new Date().toISOString(),
                  type: input.type,
                })}\n`
              );
              throw failure;
            }
            return await store.appendEvent(input);
          },
        };
      },
    });
    const created = await service.createJob({
      projectDir,
      runner: "generic",
      command: [process.execPath, "-e", "setTimeout(() => {}, 5000)"],
    });
    const outcome = created.run.catch((error: unknown) => error);
    await waitForJobStatus({
      service,
      projectDir,
      jobId: created.jobId,
      status: "running",
      timeoutMs: 10_000,
    });
    await expect(
      service.cancelJob({ projectDir, jobId: created.jobId })
    ).rejects.toThrow(failure.message);
    expect(await outcome).toBe(failure);
    const stored = await service.getJob({ projectDir, jobId: created.jobId });
    expect(stored?.status).toBe(
      failurePoint === "status" ? "running" : "cancelled"
    );
    const store = await createJobStore({ projectDir });
    const events = await store.readEvents({ jobId: created.jobId });
    expect(stored?.lastEventSeq).toBe(3);
    expect(events.filter((event) => event.type === "job.failed")).toHaveLength(
      0
    );
    expect(
      events.filter((event) => event.type === "job.cancelled")
    ).toHaveLength(failurePoint === "event-after" ? 1 : 0);
  });
}

test("completion event persistence failure does not replace completed with failed", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-supervisor-service-"));
  const projectDir = join(tempDir, ".hack");
  const failure = new Error("Injected completion event failure");
  const service = createSupervisorService({
    createStore: async (opts) => {
      const store = await createJobStore(opts);
      return {
        ...store,
        appendEvent: async (input) => {
          const event = await store.appendEvent(input);
          if (input.type === "job.completed") {
            throw failure;
          }
          return event;
        },
      };
    },
  });
  const created = await service.createJob({
    projectDir,
    runner: "generic",
    command: [process.execPath, "-e", "process.exit(0)"],
  });
  await expect(created.run).rejects.toThrow(failure.message);
  expect(
    (await service.getJob({ projectDir, jobId: created.jobId }))?.status
  ).toBe("completed");
  const store = await createJobStore({ projectDir });
  expect(
    (await store.readEvents({ jobId: created.jobId })).map(
      (event) => event.type
    )
  ).toEqual(["job.created", "job.starting", "job.started", "job.completed"]);
});
