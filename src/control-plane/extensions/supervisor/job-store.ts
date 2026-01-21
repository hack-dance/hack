import { appendFile } from "node:fs/promises"
import { resolve } from "node:path"

import { ensureDir, readTextFile, writeTextFile } from "../../../lib/fs.ts"
import { parseJsonLines } from "../../../lib/json-lines.ts"
import { isRecord } from "../../../lib/guards.ts"

export type JobStatus =
  | "queued"
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "awaiting_input"

export type JobMeta = {
  readonly jobId: string
  readonly status: JobStatus
  readonly runner: string
  readonly command?: readonly string[]
  readonly projectId?: string
  readonly projectName?: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly lastEventSeq: number
}

export type JobEvent = {
  readonly seq: number
  readonly ts: string
  readonly type: string
  readonly payload?: Record<string, unknown>
}

export type JobPaths = {
  readonly dir: string
  readonly metaPath: string
  readonly eventsPath: string
  readonly stdoutPath: string
  readonly stderrPath: string
  readonly combinedPath: string
}

export type JobStore = {
  readonly root: string
  readonly jobsRoot: string
  getJobPaths: (opts: { readonly jobId: string }) => JobPaths
  createJob: (opts: {
    readonly jobId: string
    readonly runner: string
    readonly command?: readonly string[]
    readonly projectId?: string
    readonly projectName?: string
  }) => Promise<JobMeta>
  readJobMeta: (opts: { readonly jobId: string }) => Promise<JobMeta | null>
  updateJobStatus: (opts: { readonly jobId: string; readonly status: JobStatus }) => Promise<JobMeta>
  appendEvent: (opts: {
    readonly jobId: string
    readonly type: string
    readonly payload?: Record<string, unknown>
  }) => Promise<JobEvent>
  readEvents: (opts: { readonly jobId: string }) => Promise<readonly JobEvent[]>
}

/**
 * Create a supervisor job store rooted at `<projectDir>/supervisor`.
 *
 * @param opts.projectDir - Project `.hack` directory to store supervisor data in.
 * @returns Job store helpers for metadata, events, and log paths.
 */
export async function createJobStore(opts: {
  readonly projectDir: string
}): Promise<JobStore> {
  const root = resolve(opts.projectDir, "supervisor")
  const jobsRoot = resolve(root, "jobs")
  await ensureDir(jobsRoot)

  const getJobPaths = ({ jobId }: { readonly jobId: string }): JobPaths => {
    const dir = resolve(jobsRoot, jobId)
    return {
      dir,
      metaPath: resolve(dir, "meta.json"),
      eventsPath: resolve(dir, "events.jsonl"),
      stdoutPath: resolve(dir, "stdout.log"),
      stderrPath: resolve(dir, "stderr.log"),
      combinedPath: resolve(dir, "combined.log")
    }
  }

  const createJob = async (input: {
    readonly jobId: string
    readonly runner: string
    readonly command?: readonly string[]
    readonly projectId?: string
    readonly projectName?: string
  }): Promise<JobMeta> => {
    const now = new Date().toISOString()
    const paths = getJobPaths({ jobId: input.jobId })
    await ensureDir(paths.dir)

    const meta: JobMeta = {
      jobId: input.jobId,
      status: "queued",
      runner: input.runner,
      ...(input.command ? { command: input.command } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.projectName ? { projectName: input.projectName } : {}),
      createdAt: now,
      updatedAt: now,
      lastEventSeq: 0
    }

    await writeTextFile(paths.metaPath, `${JSON.stringify(meta, null, 2)}\n`)
    const createdEvent = await appendEventInternal({
      paths,
      meta,
      event: {
        type: "job.created",
        payload: {
          status: meta.status,
          runner: meta.runner
        }
      }
    })
    return {
      ...meta,
      updatedAt: createdEvent.ts,
      lastEventSeq: createdEvent.seq
    }
  }

  const readJobMeta = async ({
    jobId
  }: {
    readonly jobId: string
  }): Promise<JobMeta | null> => {
    const paths = getJobPaths({ jobId })
    const raw = await readTextFile(paths.metaPath)
    if (!raw) return null
    const parsed = safeParseJson({ text: raw })
    return parsed ? parseJobMeta(parsed) : null
  }

  const updateJobStatus = async ({
    jobId,
    status
  }: {
    readonly jobId: string
    readonly status: JobStatus
  }): Promise<JobMeta> => {
    const paths = getJobPaths({ jobId })
    const meta = await readJobMeta({ jobId })
    if (!meta) {
      throw new Error(`Job not found: ${jobId}`)
    }

    const next: JobMeta = {
      ...meta,
      status,
      updatedAt: new Date().toISOString()
    }

    await writeTextFile(paths.metaPath, `${JSON.stringify(next, null, 2)}\n`)
    return next
  }

  const appendEvent = async ({
    jobId,
    type,
    payload
  }: {
    readonly jobId: string
    readonly type: string
    readonly payload?: Record<string, unknown>
  }): Promise<JobEvent> => {
    const paths = getJobPaths({ jobId })
    const meta = await readJobMeta({ jobId })
    if (!meta) {
      throw new Error(`Job not found: ${jobId}`)
    }
    return await appendEventInternal({
      paths,
      meta,
      event: { type, ...(payload ? { payload } : {}) }
    })
  }

  const readEvents = async ({
    jobId
  }: {
    readonly jobId: string
  }): Promise<readonly JobEvent[]> => {
    const paths = getJobPaths({ jobId })
    const raw = await readTextFile(paths.eventsPath)
    if (!raw) return []
    const parsed = parseJsonLines(raw)
    return parsed.map(parseJobEvent).filter((event): event is JobEvent => event !== null)
  }

  return {
    root,
    jobsRoot,
    getJobPaths,
    createJob,
    readJobMeta,
    updateJobStatus,
    appendEvent,
    readEvents
  }
}

async function appendEventInternal(opts: {
  readonly paths: JobPaths
  readonly meta: JobMeta
  readonly event: {
    readonly type: string
    readonly payload?: Record<string, unknown>
  }
}): Promise<JobEvent> {
  const nextSeq = opts.meta.lastEventSeq + 1
  const now = new Date().toISOString()
  const event: JobEvent = {
    seq: nextSeq,
    ts: now,
    type: opts.event.type,
    ...(opts.event.payload ? { payload: opts.event.payload } : {})
  }

  await appendFile(opts.paths.eventsPath, `${JSON.stringify(event)}\n`)
  const nextMeta: JobMeta = {
    ...opts.meta,
    updatedAt: now,
    lastEventSeq: nextSeq
  }
  await writeTextFile(opts.paths.metaPath, `${JSON.stringify(nextMeta, null, 2)}\n`)
  return event
}

function safeParseJson(opts: { readonly text: string }): unknown | null {
  try {
    return JSON.parse(opts.text)
  } catch {
    return null
  }
}

function parseJobMeta(value: unknown): JobMeta | null {
  if (!isRecord(value)) return null
  const jobId = value["jobId"]
  const status = value["status"]
  const runner = value["runner"]
  const createdAt = value["createdAt"]
  const updatedAt = value["updatedAt"]
  const lastEventSeq = value["lastEventSeq"]

  if (typeof jobId !== "string") return null
  if (!isJobStatus(status)) return null
  if (typeof runner !== "string") return null
  if (typeof createdAt !== "string") return null
  if (typeof updatedAt !== "string") return null
  if (typeof lastEventSeq !== "number") return null

  const command = Array.isArray(value["command"]) ? value["command"] : undefined
  const projectId = typeof value["projectId"] === "string" ? value["projectId"] : undefined
  const projectName = typeof value["projectName"] === "string" ? value["projectName"] : undefined

  return {
    jobId,
    status,
    runner,
    ...(command ? { command: command.filter(item => typeof item === "string") } : {}),
    ...(projectId ? { projectId } : {}),
    ...(projectName ? { projectName } : {}),
    createdAt,
    updatedAt,
    lastEventSeq
  }
}

function parseJobEvent(value: Record<string, unknown>): JobEvent | null {
  const seq = value["seq"]
  const ts = value["ts"]
  const type = value["type"]
  if (typeof seq !== "number" || typeof ts !== "string" || typeof type !== "string") return null

  const payload = isRecord(value["payload"]) ? value["payload"] : undefined
  return {
    seq,
    ts,
    type,
    ...(payload ? { payload } : {})
  }
}

function isJobStatus(value: unknown): value is JobStatus {
  return (
    value === "queued" ||
    value === "starting" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "awaiting_input"
  )
}
