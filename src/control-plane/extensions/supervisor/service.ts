import { randomUUID } from "node:crypto"
import { readdir } from "node:fs/promises"

import { logger as baseLogger } from "../../../ui/logger.ts"
import { createJobStore } from "./job-store.ts"
import { runJob } from "./runner.ts"

import type { Logger } from "../../../ui/logger.ts"
import type { JobMeta } from "./job-store.ts"
import type { JobRunResult } from "./runner.ts"

export type CreateJobResult = {
  readonly jobId: string
  readonly meta: JobMeta
  readonly run: Promise<JobRunResult>
}

export type CancelJobResult =
  | { readonly ok: true; readonly status: "cancelled" }
  | { readonly ok: false; readonly status: "not_found" | "not_running" }

export type SupervisorService = {
  /**
   * Create a new job and begin execution immediately.
   *
   * @param opts.projectDir - Project .hack directory.
   * @param opts.projectId - Stable project id.
   * @param opts.projectName - Human-readable project name.
   * @param opts.runner - Runner identifier (e.g. "generic").
   * @param opts.command - Command and args.
   * @param opts.cwd - Optional working directory.
   * @param opts.env - Optional environment overrides.
   * @returns Job id, meta, and completion promise.
   */
  createJob: (opts: {
    readonly projectDir: string
    readonly projectId?: string
    readonly projectName?: string
    readonly runner: string
    readonly command: readonly string[]
    readonly cwd?: string
    readonly env?: Record<string, string>
  }) => Promise<CreateJobResult>
  /**
   * Attempt to cancel a running job.
   *
   * @param opts.projectDir - Project .hack directory.
   * @param opts.jobId - Job id to cancel.
   * @returns Cancel outcome.
   */
  cancelJob: (opts: { readonly projectDir: string; readonly jobId: string }) => Promise<CancelJobResult>
  /**
   * Fetch a single job meta record.
   *
   * @param opts.projectDir - Project .hack directory.
   * @param opts.jobId - Job id to fetch.
   * @returns Job metadata or null.
   */
  getJob: (opts: { readonly projectDir: string; readonly jobId: string }) => Promise<JobMeta | null>
  /**
   * List all jobs for a project.
   *
   * @param opts.projectDir - Project .hack directory.
   * @returns Job metadata list.
   */
  listJobs: (opts: { readonly projectDir: string }) => Promise<readonly JobMeta[]>
}

/**
 * Create a supervisor service for managing jobs and their metadata.
 *
 * @param opts.logger - Optional logger override.
 * @returns Supervisor service helpers.
 */
export function createSupervisorService(opts?: {
  readonly logger?: Logger
}): SupervisorService {
  const logger = opts?.logger ?? baseLogger
  const runningJobs = new Map<string, { readonly proc: ReturnType<typeof Bun.spawn> }>()

  const createJob = async (input: {
    readonly projectDir: string
    readonly projectId?: string
    readonly projectName?: string
    readonly runner: string
    readonly command: readonly string[]
    readonly cwd?: string
    readonly env?: Record<string, string>
  }): Promise<CreateJobResult> => {
    const store = await createJobStore({ projectDir: input.projectDir })
    const jobId = randomUUID()
    const meta = await store.createJob({
      jobId,
      runner: input.runner,
      command: input.command,
      projectId: input.projectId,
      projectName: input.projectName
    })

    const run = runJob({
      jobStore: store,
      jobId,
      command: input.command,
      cwd: input.cwd,
      env: input.env,
      onSpawn: ({ proc }) => {
        runningJobs.set(jobId, { proc })
      }
    }).catch(async error => {
      logger.error({ message: `Job failed: ${formatError(error)}` })
      await store.updateJobStatus({ jobId, status: "failed" })
      await store.appendEvent({
        jobId,
        type: "job.failed",
        payload: { error: formatError(error) }
      })
      const fallback: JobRunResult = { jobId, status: "failed", exitCode: 1 }
      return fallback
    }).finally(() => {
      runningJobs.delete(jobId)
    })

    return { jobId, meta, run }
  }

  const cancelJob = async ({
    projectDir,
    jobId
  }: {
    readonly projectDir: string
    readonly jobId: string
  }): Promise<CancelJobResult> => {
    const store = await createJobStore({ projectDir })
    const meta = await store.readJobMeta({ jobId })
    if (!meta) return { ok: false, status: "not_found" }

    const running = runningJobs.get(jobId)
    if (!running) return { ok: false, status: "not_running" }

    running.proc.kill()
    await store.updateJobStatus({ jobId, status: "cancelled" })
    await store.appendEvent({ jobId, type: "job.cancelled" })

    return { ok: true, status: "cancelled" }
  }

  const getJob = async ({
    projectDir,
    jobId
  }: {
    readonly projectDir: string
    readonly jobId: string
  }): Promise<JobMeta | null> => {
    const store = await createJobStore({ projectDir })
    return await store.readJobMeta({ jobId })
  }

  const listJobs = async ({
    projectDir
  }: {
    readonly projectDir: string
  }): Promise<readonly JobMeta[]> => {
    const store = await createJobStore({ projectDir })
    const entries = await safeReadDir(store.jobsRoot)
    const metas = await Promise.all(
      entries.map(jobId => store.readJobMeta({ jobId }))
    )
    return metas.filter((meta): meta is JobMeta => meta !== null)
  }

  return { createJob, cancelJob, getJob, listJobs }
}

async function safeReadDir(dir: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch {
    return []
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message
  return "Unknown error"
}
