import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  const result = await created.run;
  expect(result.status).toBe("cancelled");

  const job = await service.getJob({ projectDir, jobId: created.jobId });
  expect(job?.status).toBe("cancelled");
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
