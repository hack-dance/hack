import { expect, test } from "bun:test"

const shouldRun = process.env.HACK_GATEWAY_E2E === "1"
const runTest = shouldRun ? test : test.skip

const baseUrl = (process.env.HACK_GATEWAY_URL ?? "").trim()
const token = (process.env.HACK_GATEWAY_TOKEN ?? "").trim()

runTest("gateway status responds", async () => {
  assertConfig({ baseUrl, token })
  const res = await fetch(new URL("/v1/status", baseUrl), {
    headers: buildAuthHeaders({ token })
  })
  expect(res.status).toBe(200)
  const json = (await res.json()) as Record<string, unknown>
  expect(json["status"]).toBe("ok")
})

const shouldRunWrite = shouldRun && process.env.HACK_GATEWAY_E2E_WRITE === "1"
const runWriteTest = shouldRunWrite ? test : test.skip

runWriteTest("gateway job create + stream", async () => {
  const projectId = requireEnv({ name: "HACK_PROJECT_ID" })
  const job = await createJob({
    baseUrl,
    token,
    projectId,
    command: "echo gateway e2e"
  })
  expect(job).not.toBeNull()
  if (!job) return

  const outcome = await streamJobUntilExit({
    baseUrl,
    token,
    projectId,
    jobId: job.jobId,
    timeoutMs: 30_000
  })
  expect(outcome).toBe("completed")
})

type JobCreateResponse = {
  readonly jobId: string
}

function assertConfig(opts: { readonly baseUrl: string; readonly token: string }): void {
  if (!opts.baseUrl) {
    throw new Error("Missing HACK_GATEWAY_URL")
  }
  if (!opts.token) {
    throw new Error("Missing HACK_GATEWAY_TOKEN")
  }
}

function requireEnv(opts: { readonly name: string }): string {
  const value = (process.env[opts.name] ?? "").trim()
  if (!value) throw new Error(`Missing ${opts.name}`)
  return value
}

function buildAuthHeaders(opts: { readonly token: string }): Record<string, string> {
  return { Authorization: `Bearer ${opts.token}` }
}

async function createJob(opts: {
  readonly baseUrl: string
  readonly token: string
  readonly projectId: string
  readonly command: string
}): Promise<JobCreateResponse | null> {
  const url = new URL(`/control-plane/projects/${opts.projectId}/jobs`, opts.baseUrl)
  const payload = {
    runner: "generic",
    command: ["bash", "-lc", opts.command]
  }
  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...buildAuthHeaders({ token: opts.token }),
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Job create failed (${res.status}): ${body}`)
  }

  const parsed = (await res.json()) as Record<string, unknown>
  const job = parsed["job"]
  if (!job || typeof job !== "object") return null
  const jobId = (job as Record<string, unknown>)["jobId"]
  return typeof jobId === "string" ? { jobId } : null
}

async function streamJobUntilExit(opts: {
  readonly baseUrl: string
  readonly token: string
  readonly projectId: string
  readonly jobId: string
  readonly timeoutMs: number
}): Promise<"completed" | "failed" | "unknown"> {
  const wsUrl = toWebSocketUrl({
    baseUrl: opts.baseUrl,
    path: `/control-plane/projects/${opts.projectId}/jobs/${opts.jobId}/stream`
  })

  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, {
      headers: buildAuthHeaders({ token: opts.token })
    })
    const timer = setTimeout(() => {
      ws.close(1000, "timeout")
      resolve("unknown")
    }, opts.timeoutMs)

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "hello", logsFrom: 0, eventsFrom: 0 }))
    })

    ws.addEventListener("message", event => {
      const data =
        typeof event.data === "string" ?
          event.data
        : event.data instanceof ArrayBuffer ?
          new TextDecoder().decode(new Uint8Array(event.data))
        : event.data.toString()
      const parsed = safeJsonParse({ text: data })
      if (!parsed) return
      if (parsed["type"] !== "event") return
      const eventPayload = parsed["event"]
      const eventType =
        typeof eventPayload === "object" && eventPayload ?
          (eventPayload as Record<string, unknown>)["type"]
          : undefined
      if (eventType === "job.completed") {
        clearTimeout(timer)
        ws.close(1000, "completed")
        resolve("completed")
      } else if (eventType === "job.failed") {
        clearTimeout(timer)
        ws.close(1000, "failed")
        resolve("failed")
      }
    })

    ws.addEventListener("error", () => {
      clearTimeout(timer)
      reject(new Error("WebSocket error"))
    })

    ws.addEventListener("close", () => {
      clearTimeout(timer)
    })
  })
}

function toWebSocketUrl(opts: { readonly baseUrl: string; readonly path: string }): string {
  const url = new URL(opts.path, opts.baseUrl)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  return url.toString()
}

function safeJsonParse(opts: { readonly text: string }): Record<string, unknown> | null {
  const trimmed = opts.text.trim()
  if (trimmed.length === 0) return null
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}
