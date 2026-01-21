import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createJobStore } from "../src/control-plane/extensions/supervisor/job-store.ts";

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

test("job store writes meta and events with incrementing seq", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-supervisor-"));
  const projectDir = join(tempDir, ".hack");
  await mkdir(projectDir, { recursive: true });

  const store = await createJobStore({ projectDir });
  const created = await store.createJob({
    jobId: "job-1",
    runner: "generic",
    command: ["echo", "hello"],
    projectId: "proj-1",
    projectName: "demo",
  });

  expect(created.status).toBe("queued");
  expect(created.lastEventSeq).toBe(1);

  const meta = await store.readJobMeta({ jobId: "job-1" });
  expect(meta?.runner).toBe("generic");
  expect(meta?.projectId).toBe("proj-1");
  expect(meta?.lastEventSeq).toBe(1);

  const event = await store.appendEvent({
    jobId: "job-1",
    type: "job.started",
    payload: { status: "running" },
  });
  expect(event.seq).toBe(2);

  const updated = await store.readJobMeta({ jobId: "job-1" });
  expect(updated?.lastEventSeq).toBe(2);

  const events = await store.readEvents({ jobId: "job-1" });
  expect(events.length).toBe(2);
  expect(events[0]?.type).toBe("job.created");
  expect(events[1]?.type).toBe("job.started");
});
