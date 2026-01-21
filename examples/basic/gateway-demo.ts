type GatewayConfig = {
  readonly baseUrl: string
  readonly token: string
  readonly projectId?: string
  readonly command: string
  readonly allowWrites: boolean
  readonly runner: string
  readonly cwd?: string
  readonly timeoutMs: number
}

async function main(): Promise<void> {
  const config = loadGatewayConfig()
  if (!config) return

  const headers = buildAuthHeaders({ token: config.token })
  await printStatus({ baseUrl: config.baseUrl, headers })
  await printProjects({ baseUrl: config.baseUrl, headers })

  if (!config.allowWrites) {
    process.stderr.write("Skipping job create (set HACK_ALLOW_WRITES=1 to enable).\n")
    return
  }

  if (!config.projectId) {
    process.stderr.write("Missing HACK_PROJECT_ID for job create.\n")
    return
  }

  const job = await createJob({
    baseUrl: config.baseUrl,
    headers,
    projectId: config.projectId,
    runner: config.runner,
    command: config.command,
    cwd: config.cwd
  })
  if (!job) return

  await streamJob({
    baseUrl: config.baseUrl,
    token: config.token,
    projectId: config.projectId,
    jobId: job.jobId,
    timeoutMs: config.timeoutMs
  })
}

function loadGatewayConfig(): GatewayConfig | null {
  const baseUrl = (process.env.HACK_GATEWAY_URL ?? "http://127.0.0.1:7788").trim()
  const token = (process.env.HACK_GATEWAY_TOKEN ?? "").trim()
  const projectId = (process.env.HACK_PROJECT_ID ?? "").trim() || undefined
  const command = (process.env.HACK_COMMAND ?? "echo hello from gateway").trim()
  const allowWrites = (process.env.HACK_ALLOW_WRITES ?? "").trim() === "1"
  const runner = (process.env.HACK_RUNNER ?? "generic").trim()
  const cwd = (process.env.HACK_COMMAND_CWD ?? "").trim() || undefined
  const timeoutMs = Number.parseInt(process.env.HACK_JOB_TIMEOUT_MS ?? "60000", 10)

  if (!token) {
    process.stderr.write("Missing HACK_GATEWAY_TOKEN.\n")
    process.stderr.write("Export a token from: hack x gateway token-create\n")
    return null
  }

  return {
    baseUrl,
    token,
    projectId,
    command,
    allowWrites,
    runner,
    cwd,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 60_000
  }
}

function buildAuthHeaders(opts: { readonly token: string }): Record<string, string> {
  return { Authorization: `Bearer ${opts.token}` }
}

async function printStatus(opts: {
  readonly baseUrl: string
  readonly headers: Record<string, string>
}): Promise<void> {
  const res = await fetch(new URL("/v1/status", opts.baseUrl), { headers: opts.headers })
  const body = await res.text()
  process.stdout.write(`Status: ${body}\n`)
}

async function printProjects(opts: {
  readonly baseUrl: string
  readonly headers: Record<string, string>
}): Promise<void> {
  const url = new URL("/v1/projects", opts.baseUrl)
  url.searchParams.set("include_unregistered", "true")
  const res = await fetch(url, { headers: opts.headers })
  const body = await res.text()
  process.stdout.write(`Projects: ${body}\n`)
}

type JobCreateResponse = {
  readonly jobId: string
}

async function createJob(opts: {
  readonly baseUrl: string
  readonly headers: Record<string, string>
  readonly projectId: string
  readonly runner: string
  readonly command: string
  readonly cwd?: string
}): Promise<JobCreateResponse | null> {
  const url = new URL(`/control-plane/projects/${opts.projectId}/jobs`, opts.baseUrl)
  const payload = {
    runner: opts.runner,
    command: ["bash", "-lc", opts.command],
    ...(opts.cwd ? { cwd: opts.cwd } : {})
  }
  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...opts.headers,
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  })
  const body = await res.text()
  if (!res.ok) {
    process.stderr.write(`Job create failed (${res.status}): ${body}\n`)
    return null
  }

  const parsed = safeJsonParse({ text: body })
  const job = parsed?.["job"]
  if (!job || typeof job !== "object") {
    process.stderr.write("Job create response missing job payload.\n")
    return null
  }
  const jobId = (job as Record<string, unknown>)["jobId"]
  if (typeof jobId !== "string") {
    process.stderr.write("Job create response missing jobId.\n")
    return null
  }

  process.stdout.write(`Created job ${jobId}\n`)
  return { jobId }
}

async function streamJob(opts: {
  readonly baseUrl: string
  readonly token: string
  readonly projectId: string
  readonly jobId: string
  readonly timeoutMs: number
}): Promise<void> {
  const wsUrl = toWebSocketUrl({
    baseUrl: opts.baseUrl,
    path: `/control-plane/projects/${opts.projectId}/jobs/${opts.jobId}/stream`,
    token: opts.token
  })

  process.stdout.write(`Streaming job ${opts.jobId}...\n`)

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => {
      ws.close(1000, "timeout")
      reject(new Error("Job stream timed out"))
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
      if (!parsed) {
        process.stdout.write(data)
        return
      }

      if (parsed["type"] === "log" && typeof parsed["data"] === "string") {
        process.stdout.write(parsed["data"])
      } else if (parsed["type"] === "event") {
        const eventPayload = parsed["event"]
        const eventType =
          typeof eventPayload === "object" && eventPayload ?
            (eventPayload as Record<string, unknown>)["type"]
          : undefined
        process.stdout.write(`Event: ${String(eventType ?? "unknown")}\n`)
        if (eventType === "job.completed" || eventType === "job.failed") {
          ws.close(1000, "job_complete")
        }
      }
    })

    ws.addEventListener("close", () => {
      clearTimeout(timer)
      resolve()
    })

    ws.addEventListener("error", () => {
      clearTimeout(timer)
      reject(new Error("WebSocket error"))
    })
  })
}

function toWebSocketUrl(opts: {
  readonly baseUrl: string
  readonly path: string
  readonly token?: string
}): string {
  const url = new URL(opts.path, opts.baseUrl)
  if (url.protocol === "https:") {
    url.protocol = "wss:"
  } else {
    url.protocol = "ws:"
  }
  if (opts.token) {
    url.searchParams.set("token", opts.token)
  }
  return url.toString()
}

function safeJsonParse(opts: {
  readonly text: string
}): Record<string, unknown> | null {
  const trimmed = opts.text.trim()
  if (trimmed.length === 0) return null
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

void main().catch(error => {
  const message = error instanceof Error ? error.message : "Unexpected error"
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
