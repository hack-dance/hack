import { appendFile } from "node:fs/promises";

import type { JobStatus, JobStore } from "./job-store.ts";

export type JobRunResult = {
  readonly jobId: string;
  readonly status: JobStatus;
  readonly exitCode: number;
};

export type JobSpawnListener = (opts: {
  readonly proc: SpawnedProcess;
  /** Request cancellation before terminal status persistence begins. */
  readonly cancel: () => Promise<boolean>;
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
 * @param opts.onTerminalClaim - Observe the chosen outcome before persistence yields.
 * @returns Final job status and exit code.
 */
export async function runJob(opts: {
  readonly jobStore: JobStore;
  readonly jobId: string;
  readonly command?: readonly string[];
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly onSpawn?: JobSpawnListener;
  readonly onTerminalClaim?: (opts: { readonly status: JobStatus }) => void;
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

  let terminalStatus: JobStatus | undefined;
  let terminalWrite: Promise<JobStatus> | undefined;
  const finish = (input: {
    readonly status: JobStatus;
    readonly exitCode?: number;
  }): Promise<JobStatus> => {
    if (terminalWrite) {
      return terminalWrite;
    }
    // Claim the outcome before storage yields; both paths share one writer.
    terminalStatus = input.status;
    opts.onTerminalClaim?.({ status: input.status });
    terminalWrite = (async () => {
      await opts.jobStore.updateJobStatus({
        jobId: opts.jobId,
        status: input.status,
      });
      await opts.jobStore.appendEvent({
        jobId: opts.jobId,
        type: `job.${input.status}`,
        ...(input.exitCode === undefined
          ? {}
          : { payload: { exitCode: input.exitCode } }),
      });
      return input.status;
    })();
    return terminalWrite;
  };
  opts.onSpawn?.({
    proc,
    cancel: async () => {
      if (terminalStatus && terminalStatus !== "cancelled") {
        return false;
      }
      if (!terminalStatus) {
        proc.kill();
      }
      await finish({ status: "cancelled" });
      return true;
    },
  });

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

  const status = await finish({
    status: exitCode === 0 ? "completed" : "failed",
    exitCode,
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
