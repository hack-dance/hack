import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "bun:test"

import { readTextFile } from "../src/lib/fs.ts"
import { createJobStore } from "../src/control-plane/extensions/supervisor/job-store.ts"
import { runJob } from "../src/control-plane/extensions/supervisor/runner.ts"

let tempDir: string | null = null

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = null
  }
})

test("runJob writes logs and completes successfully", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-supervisor-runner-"))
  const projectDir = join(tempDir, ".hack")
  await mkdir(projectDir, { recursive: true })

  const store = await createJobStore({ projectDir })
  await store.createJob({
    jobId: "job-1",
    runner: "generic",
    command: [process.execPath, "-e", "console.log('hello'); console.error('oops')"],
    projectId: "proj-1",
    projectName: "demo"
  })

  const result = await runJob({
    jobStore: store,
    jobId: "job-1"
  })

  expect(result.exitCode).toBe(0)
  expect(result.status).toBe("completed")

  const paths = store.getJobPaths({ jobId: "job-1" })
  const stdout = await readTextFile(paths.stdoutPath)
  const stderr = await readTextFile(paths.stderrPath)
  const combined = await readTextFile(paths.combinedPath)

  expect(stdout ?? "").toContain("hello")
  expect(stderr ?? "").toContain("oops")
  expect(combined ?? "").toContain("hello")
  expect(combined ?? "").toContain("oops")

  const meta = await store.readJobMeta({ jobId: "job-1" })
  expect(meta?.status).toBe("completed")
  expect(meta?.lastEventSeq).toBe(4)
})

test("runJob records failed status for non-zero exit", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-supervisor-runner-"))
  const projectDir = join(tempDir, ".hack")
  await mkdir(projectDir, { recursive: true })

  const store = await createJobStore({ projectDir })
  await store.createJob({
    jobId: "job-2",
    runner: "generic",
    command: [process.execPath, "-e", "process.exit(1)"]
  })

  const result = await runJob({
    jobStore: store,
    jobId: "job-2"
  })

  expect(result.exitCode).toBe(1)
  expect(result.status).toBe("failed")

  const meta = await store.readJobMeta({ jobId: "job-2" })
  expect(meta?.status).toBe("failed")

  const events = await store.readEvents({ jobId: "job-2" })
  const types = events.map(event => event.type)
  expect(types).toContain("job.failed")
})
