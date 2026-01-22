import { appendFile } from "node:fs/promises";

import type { JobStatus, JobStore } from "./job-store.ts";

export type JobRunResult = {
  readonly jobId: string;
  readonly status: JobStatus;
  readonly exitCode: number;
};

export type JobSpawnListener = (opts: {
  readonly proc: SpawnedProcess;
}) => void;

type SpawnedProcess = ReturnType<typeof Bun.spawn>;

/**
 * Run a job command and stream logs into the job store.
 *
 * @param opts.jobStore - Job store for metadata and events.
 * @param opts.jobId - Job id to execute.
 * @param opts.command - Optional override command (defaults to meta command).
 * @param opts.cwd - Optional working directory for the process.
 * @param opts.env - Optional environment overrides.
 * @param opts.onSpawn - Optional hook with the spawned process handle.
 * @returns Final job status and exit code.
 */
export async function runJob(opts: {
  readonly jobStore: JobStore;
  readonly jobId: string;
  readonly command?: readonly string[];
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly onSpawn?: JobSpawnListener;
}): Promise<JobRunResult> {
  const meta = await opts.jobStore.readJobMeta({ jobId: opts.jobId });
  if (!meta) {
    throw new Error(`Job not found: ${opts.jobId}`);
  }

  const command = opts.command ?? meta.command;
  if (!command || command.length === 0) {
    throw new Error(`Missing command for job: ${opts.jobId}`);
  }

  await opts.jobStore.updateJobStatus({
    jobId: opts.jobId,
    status: "starting",
  });
  await opts.jobStore.appendEvent({
    jobId: opts.jobId,
    type: "job.starting",
  });

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([...command], {
      cwd: opts.cwd,
      env: buildEnv(opts.env),
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error: unknown) {
    await opts.jobStore.updateJobStatus({
      jobId: opts.jobId,
      status: "failed",
    });
    await opts.jobStore.appendEvent({
      jobId: opts.jobId,
      type: "job.failed",
      payload: { error: formatError(error) },
    });
    return { jobId: opts.jobId, status: "failed", exitCode: 1 };
  }

  await opts.jobStore.updateJobStatus({ jobId: opts.jobId, status: "running" });
  await opts.jobStore.appendEvent({
    jobId: opts.jobId,
    type: "job.started",
    payload: { pid: proc.pid },
  });
  opts.onSpawn?.({ proc });

  const paths = opts.jobStore.getJobPaths({ jobId: opts.jobId });
  const stdoutTask = pipeStreamToFiles({
    stream: proc.stdout,
    files: [paths.stdoutPath, paths.combinedPath],
  });
  const stderrTask = pipeStreamToFiles({
    stream: proc.stderr,
    files: [paths.stderrPath, paths.combinedPath],
  });

  const exitCode = await proc.exited;
  await Promise.all([stdoutTask, stderrTask]);

  const metaAfter = await opts.jobStore.readJobMeta({ jobId: opts.jobId });
  if (metaAfter?.status === "cancelled") {
    return { jobId: opts.jobId, status: "cancelled", exitCode };
  }

  const status: JobStatus = exitCode === 0 ? "completed" : "failed";
  await opts.jobStore.updateJobStatus({ jobId: opts.jobId, status });
  await opts.jobStore.appendEvent({
    jobId: opts.jobId,
    type: status === "completed" ? "job.completed" : "job.failed",
    payload: { exitCode },
  });

  return { jobId: opts.jobId, status, exitCode };
}

async function pipeStreamToFiles(opts: {
  readonly stream: ReadableStream<Uint8Array> | number | null | undefined;
  readonly files: readonly string[];
}): Promise<void> {
  if (!opts.stream || typeof opts.stream === "number") {
    return;
  }
  const reader = opts.stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.length === 0) {
        continue;
      }
      await Promise.all(opts.files.map((file) => appendFile(file, value)));
    }
  } finally {
    reader.releaseLock();
  }
}

function buildEnv(
  extra: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!extra) {
    return undefined;
  }
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      merged[key] = value;
    }
  }
  for (const [key, value] of Object.entries(extra)) {
    merged[key] = value;
  }
  return merged;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "Unknown error";
}
