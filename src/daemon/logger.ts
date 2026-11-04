import { Buffer } from "node:buffer";
import { open } from "node:fs/promises";

import type { Logger, LogInput, LogLevel } from "../ui/logger.ts";

export type DaemonLogLevel = LogLevel;
export type DaemonLogger = Logger & { readonly flush: () => Promise<void> };

export const DAEMON_LOG_MAX_BYTES = 5 * 1024 * 1024;

/**
 * One daemon owns this file. Truncate in place before an append would exceed
 * the cap, including an oversized file inherited from an older version.
 * The final bytes of an oversized record are retained; it may start mid-line.
 * Serializing stat/truncate/write prevents concurrent logger calls exceeding it.
 */
async function appendBoundedLog(opts: {
  readonly logPath: string;
  readonly line: string;
}): Promise<void> {
  const bytes = Buffer.from(opts.line).subarray(-DAEMON_LOG_MAX_BYTES);
  const file = await open(opts.logPath, "a", 0o600);
  try {
    const { size } = await file.stat();
    if (size + bytes.length > DAEMON_LOG_MAX_BYTES) {
      await file.truncate(0);
    }
    await file.writeFile(bytes);
  } finally {
    await file.close();
  }
}

export function createDaemonLogger({
  logPath,
  foreground,
}: {
  readonly logPath: string;
  readonly foreground: boolean;
}): DaemonLogger {
  let queue = Promise.resolve();

  const writeLine = ({
    level,
    input,
  }: {
    readonly level: DaemonLogLevel;
    readonly input: LogInput;
  }) => {
    const timestamp = new Date().toISOString();
    const fields = input.fields;
    const suffix = fields
      ? ` (${Object.keys(fields)
          .sort()
          .map((key) => `${key}=${String(fields[key])}`)
          .join(", ")})`
      : "";
    const line = `[${timestamp}] ${level.toUpperCase()} ${input.message}${suffix}\n`;
    if (foreground) {
      process.stderr.write(line);
    }
    queue = queue
      .then(() => appendBoundedLog({ logPath, line }))
      .catch(() => undefined);
  };

  return {
    flush: () => queue,
    debug: (input) => writeLine({ level: "debug", input }),
    info: (input) => writeLine({ level: "info", input }),
    warn: (input) => writeLine({ level: "warn", input }),
    error: (input) => writeLine({ level: "error", input }),
    success: (input) => writeLine({ level: "success", input }),
    step: (input) => writeLine({ level: "step", input }),
  };
}
