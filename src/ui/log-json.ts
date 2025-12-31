import { isRecord } from "../lib/guards.ts"

export type LogLevel = "debug" | "info" | "warn" | "error"

export type LogJsonEntry = {
  readonly source: "compose" | "loki"
  readonly message: string
  readonly raw: string
  readonly stream?: "stdout" | "stderr"
  readonly project?: string
  readonly service?: string
  readonly instance?: string
  readonly labels?: Record<string, string>
  readonly timestamp?: string
  readonly timestamp_ns?: string
  readonly level?: LogLevel
  readonly fields?: Record<string, string>
}

type JsonLog = Record<string, unknown> & {
  readonly level?: unknown
  readonly lvl?: unknown
  readonly severity?: unknown
  readonly msg?: unknown
  readonly message?: unknown
  readonly ts?: unknown
  readonly time?: unknown
  readonly timestamp?: unknown
}

const OMIT_FIELDS = new Set(["level", "lvl", "severity", "msg", "message", "ts", "time", "timestamp"])

export function parseComposeLogLine(opts: {
  readonly line: string
  readonly stream: "stdout" | "stderr"
  readonly projectName?: string
}): LogJsonEntry {
  const split = splitDockerPrefix(opts.line)
  const serviceInfo = split ?
      parseComposeServiceAndInstance({
        rawPrefix: split.service,
        projectName: opts.projectName
      })
    : { service: null, instance: null }

  const payload = split ? split.payload : opts.line
  const { timestampIso, payload: cleanPayload } = splitIsoTimestampPrefix(payload)
  const parsed = parseLogPayload(cleanPayload)

  return {
    source: "compose",
    message: parsed.message,
    raw: opts.line,
    stream: opts.stream,
    ...(opts.projectName ? { project: opts.projectName } : {}),
    ...(serviceInfo.service ? { service: serviceInfo.service } : {}),
    ...(serviceInfo.instance ? { instance: serviceInfo.instance } : {}),
    ...(timestampIso ? { timestamp: timestampIso } : {}),
    ...(parsed.level ? { level: parsed.level } : {}),
    ...(parsed.fields ? { fields: parsed.fields } : {})
  }
}

export function parseLokiLogLine(opts: {
  readonly labels: Record<string, string>
  readonly tsNs?: string
  readonly line: string
}): LogJsonEntry {
  const parsed = parseLogPayload(opts.line)
  const timestamp = opts.tsNs ? formatNsTimestampIso(opts.tsNs) : null
  const labels = Object.keys(opts.labels).length > 0 ? opts.labels : null

  return {
    source: "loki",
    message: parsed.message,
    raw: opts.line,
    ...(opts.labels["project"] ? { project: opts.labels["project"] } : {}),
    ...(opts.labels["service"] ? { service: opts.labels["service"] } : {}),
    ...(labels ? { labels } : {}),
    ...(opts.tsNs ? { timestamp_ns: opts.tsNs } : {}),
    ...(timestamp ? { timestamp } : {}),
    ...(parsed.level ? { level: parsed.level } : {}),
    ...(parsed.fields ? { fields: parsed.fields } : {})
  }
}

export function writeJsonLogLine(entry: LogJsonEntry): void {
  process.stdout.write(`${JSON.stringify(entry)}\n`)
}

function parseLogPayload(payload: string): {
  readonly message: string
  readonly level?: LogLevel
  readonly fields?: Record<string, string>
} {
  const json = tryParseJson(payload)
  if (!json) return { message: payload }

  const level = parseAnyLevel(json.level) ?? parseAnyLevel(json.lvl) ?? parseAnyLevel(json.severity)
  const message =
    typeof json.msg === "string" ? json.msg
    : typeof json.message === "string" ? json.message
    : payload
  const fields = extractFields(json)

  return {
    message,
    ...(level ? { level } : {}),
    ...(fields ? { fields } : {})
  }
}

function tryParseJson(text: string): JsonLog | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null
  try {
    const value: unknown = JSON.parse(trimmed)
    return isRecord(value) ? (value as JsonLog) : null
  } catch {
    return null
  }
}

function parseAnyLevel(raw: unknown): LogLevel | null {
  if (typeof raw === "string") return normalizeLevel(raw)
  if (typeof raw === "number") return normalizePinoLevel(raw)
  return null
}

function normalizeLevel(raw: string): LogLevel {
  const v = raw.trim().toLowerCase()
  if (v === "debug") return "debug"
  if (v === "warn" || v === "warning") return "warn"
  if (v === "error" || v === "fatal" || v === "panic") return "error"
  return "info"
}

function normalizePinoLevel(level: number): LogLevel {
  if (level >= 50) return "error"
  if (level >= 40) return "warn"
  if (level >= 30) return "info"
  return "debug"
}

function extractFields(json: JsonLog): Record<string, string> | null {
  const out: Record<string, string> = {}
  for (const key of Object.keys(json)) {
    if (OMIT_FIELDS.has(key)) continue
    const v = json[key]
    if (v === null || v === undefined) continue
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[key] = String(v)
    }
  }
  return Object.keys(out).length > 0 ? out : null
}

function splitDockerPrefix(
  line: string
): { readonly service: string; readonly payload: string } | null {
  const idx = line.indexOf("|")
  if (idx === -1) return null
  const service = line.slice(0, idx).trim()
  const after = line.slice(idx + 1)
  const payload = after.startsWith(" ") ? after.slice(1) : after
  if (!service) return null
  return { service, payload }
}

function parseComposeServiceAndInstance(opts: {
  readonly rawPrefix: string
  readonly projectName?: string
}): { readonly service: string | null; readonly instance: string | null } {
  const trimmed = opts.rawPrefix.trim()
  if (trimmed.length === 0) return { service: null, instance: null }
  const withoutProjectPrefix =
    opts.projectName && trimmed.startsWith(`${opts.projectName}-`) ?
      trimmed.slice(`${opts.projectName}-`.length)
    : trimmed

  const match = withoutProjectPrefix.match(/^(.*?)-(\d+)$/)
  if (!match) return { service: withoutProjectPrefix, instance: null }

  const base = match[1] ?? ""
  const instance = match[2] ?? null
  return { service: base.length > 0 ? base : withoutProjectPrefix, instance }
}

function splitIsoTimestampPrefix(payload: string): {
  readonly timestampIso: string | null
  readonly payload: string
} {
  const match = payload.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)([\s\S]*)$/)
  if (!match) return { timestampIso: null, payload }

  const iso = match[1] ?? null
  let rest = match[2] ?? ""
  if (rest.startsWith(" ")) rest = rest.slice(1)
  return { timestampIso: iso, payload: rest }
}

function safeParseBigInt(value: string): bigint | null {
  try {
    return BigInt(value)
  } catch {
    return null
  }
}

function formatNsTimestampIso(ns: string): string | null {
  const value = safeParseBigInt(ns)
  if (value === null) return null
  const ms = value / 1_000_000n
  const date = new Date(Number(ms))
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}
