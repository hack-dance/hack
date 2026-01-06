type ProxyRequestBody = {
  baseUrl: string
  token: string
  path: string
  method?: string
  body?: unknown
}

type ParseResult =
  | { ok: true; value: ProxyRequestBody }
  | { ok: false; error: string }

export async function POST(req: Request): Promise<Response> {
  const parsed = parseBody({ value: await readJsonBody({ req }) })
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 400 })
  }

  const { baseUrl, token, path, method, body } = parsed.value
  const url = buildUrl({ baseUrl, path })
  const requestInit = buildRequestInit({ token, method: method ?? "GET", body })

  const response = await fetch(url, requestInit)
  const contentType = response.headers.get("content-type") ?? "application/json"
  const text = await response.text()

  return new Response(text, {
    status: response.status,
    headers: { "content-type": contentType }
  })
}

function parseBody(opts: { value: unknown }): ParseResult {
  if (!isRecord(opts.value)) {
    return { ok: false, error: "invalid_body" }
  }

  const baseUrl = getString(opts.value, "baseUrl")
  if (!baseUrl) return { ok: false, error: "missing_base_url" }

  const token = getString(opts.value, "token")
  if (!token) return { ok: false, error: "missing_token" }

  const path = getString(opts.value, "path")
  if (!path) return { ok: false, error: "missing_path" }
  if (!path.startsWith("/")) return { ok: false, error: "path_must_start_with_slash" }

  const method = normalizeMethod({ value: getString(opts.value, "method") })
  if (!method.ok) return method

  return {
    ok: true,
    value: {
      baseUrl,
      token,
      path,
      ...(method.value ? { method: method.value } : {}),
      ...(Object.prototype.hasOwnProperty.call(opts.value, "body") ? { body: opts.value.body } : {})
    }
  }
}

function normalizeMethod(opts: {
  value: string | null
}): { ok: true; value: string | null } | { ok: false; error: string } {
  if (!opts.value) return { ok: true, value: null }
  const upper = opts.value.toUpperCase()
  const allowed = ["GET", "POST", "PUT", "PATCH", "DELETE"]
  if (!allowed.includes(upper)) {
    return { ok: false, error: "unsupported_method" }
  }
  return { ok: true, value: upper }
}

function buildRequestInit(opts: {
  token: string
  method: string
  body?: unknown
}): RequestInit {
  const headers = new Headers({
    Authorization: `Bearer ${opts.token}`
  })
  if (opts.body !== undefined) {
    headers.set("content-type", "application/json")
  }

  return {
    method: opts.method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {})
  }
}

function buildUrl(opts: { baseUrl: string; path: string }): string {
  const base = opts.baseUrl.endsWith("/") ? opts.baseUrl.slice(0, -1) : opts.baseUrl
  return new URL(opts.path, base).toString()
}

async function readJsonBody(opts: { req: Request }): Promise<unknown | null> {
  try {
    return await opts.req.json()
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function getString(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key]
  return typeof value === "string" ? value.trim() : null
}
