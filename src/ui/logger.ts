import { log as clackLog } from "@clack/prompts"

import { isGumAvailable, tryGumLog } from "./gum.ts"

import type { GumFields } from "./gum.ts"

export type LogLevel = "debug" | "info" | "warn" | "error" | "success" | "step"

export type LogFieldValue = string | number | boolean
export type LogFields = Readonly<Record<string, LogFieldValue>>

export interface LogInput {
  readonly message: string
  readonly fields?: LogFields
}

export interface Logger {
  debug(input: LogInput): void
  info(input: LogInput): void
  warn(input: LogInput): void
  error(input: LogInput): void
  success(input: LogInput): void
  step(input: LogInput): void
}

type LoggerBackend = "gum" | "clack" | "console"

function resolveBackend(): LoggerBackend {
  const raw = (process.env.HACK_LOGGER ?? "").trim().toLowerCase()
  if (raw === "gum") return "gum"
  if (raw === "clack") return "clack"
  if (raw === "console" || raw === "plain") return "console"
  return isGumAvailable() ? "gum" : "clack"
}

function mergeFields(
  base: LogFields | undefined,
  extra: LogFields | undefined
): LogFields | undefined {
  if (!base && !extra) return undefined
  return { ...(base ?? {}), ...(extra ?? {}) }
}

function toGumLevel(level: LogLevel): "debug" | "info" | "warn" | "error" {
  if (level === "debug") return "debug"
  if (level === "warn") return "warn"
  if (level === "error") return "error"
  return "info"
}

function toGumFields(fields: LogFields | undefined): GumFields | undefined {
  return fields
}

function formatFieldsInline(fields: LogFields | undefined): string {
  if (!fields) return ""
  const parts: string[] = []
  for (const key of Object.keys(fields).sort()) {
    parts.push(`${key}=${String(fields[key])}`)
  }
  return parts.length > 0 ? ` (${parts.join(", ")})` : ""
}

function logWithClack(level: LogLevel, { message, fields }: LogInput): void {
  const suffix = formatFieldsInline(fields)
  const line = `${message}${suffix}`

  if (level === "debug" || level === "info") clackLog.info(line)
  else if (level === "warn") clackLog.warn(line)
  else if (level === "error") clackLog.error(line)
  else if (level === "success") clackLog.success(line)
  else clackLog.step(line)
}

function logWithConsole(level: LogLevel, { message, fields }: LogInput): void {
  const suffix = formatFieldsInline(fields)
  const line = `${level.toUpperCase()}: ${message}${suffix}\n`
  process.stderr.write(line)
}

function logWithGum(level: LogLevel, { message, fields }: LogInput): void {
  const extra =
    level === "success" ? ({ status: "success" } satisfies LogFields)
    : level === "step" ? ({ status: "step" } satisfies LogFields)
    : undefined

  const ok = tryGumLog({
    level: toGumLevel(level),
    message,
    fields: toGumFields(mergeFields(fields, extra))
  })

  if (!ok) {
    // Fallback without throwing.
    logWithClack(level, { message, fields })
  }
}

export const logger: Logger = (() => {
  const emit = (level: LogLevel, input: LogInput) => {
    const backend = resolveBackend()
    if (backend === "gum") return logWithGum(level, input)
    if (backend === "console") return logWithConsole(level, input)
    return logWithClack(level, input)
  }

  return {
    debug: input => emit("debug", input),
    info: input => emit("info", input),
    warn: input => emit("warn", input),
    error: input => emit("error", input),
    success: input => emit("success", input),
    step: input => emit("step", input)
  } satisfies Logger
})()
