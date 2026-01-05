import { appendFile } from "node:fs/promises"

import type { LogFields, LogInput, LogLevel, Logger } from "../ui/logger.ts"

export type DaemonLogLevel = LogLevel
export type DaemonLogger = Logger

export function createDaemonLogger({
  logPath,
  foreground
}: {
  readonly logPath: string
  readonly foreground: boolean
}): DaemonLogger {
  let queue = Promise.resolve()

  const writeLine = ({ level, input }: { readonly level: DaemonLogLevel; readonly input: LogInput }) => {
    const timestamp = new Date().toISOString()
    const fields = input.fields
    const suffix = fields
      ? ` (${Object.keys(fields)
          .sort()
          .map(key => `${key}=${String(fields[key])}`)
          .join(", ")})`
      : ""
    const line = `[${timestamp}] ${level.toUpperCase()} ${input.message}${suffix}\n`
    if (foreground) {
      process.stderr.write(line)
    }
    queue = queue.then(() => appendFile(logPath, line)).catch(() => undefined)
  }

  return {
    debug: input => writeLine({ level: "debug", input }),
    info: input => writeLine({ level: "info", input }),
    warn: input => writeLine({ level: "warn", input }),
    error: input => writeLine({ level: "error", input }),
    success: input => writeLine({ level: "success", input }),
    step: input => writeLine({ level: "step", input })
  }
}
