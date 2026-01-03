import { appendFile } from "node:fs/promises"

export type DaemonLogLevel = "info" | "warn" | "error"

export interface DaemonLogger {
  info(opts: { readonly message: string }): void
  warn(opts: { readonly message: string }): void
  error(opts: { readonly message: string }): void
}

export function createDaemonLogger({
  logPath,
  foreground
}: {
  readonly logPath: string
  readonly foreground: boolean
}): DaemonLogger {
  let queue = Promise.resolve()

  const writeLine = (level: DaemonLogLevel, message: string) => {
    const timestamp = new Date().toISOString()
    const line = `[${timestamp}] ${level.toUpperCase()} ${message}\n`
    if (foreground) {
      process.stderr.write(line)
    }
    queue = queue.then(() => appendFile(logPath, line)).catch(() => undefined)
  }

  return {
    info: ({ message }) => writeLine("info", message),
    warn: ({ message }) => writeLine("warn", message),
    error: ({ message }) => writeLine("error", message)
  }
}
