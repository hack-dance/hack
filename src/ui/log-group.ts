/** Matches ISO 8601 timestamp prefix with trailing content (e.g., "2024-01-15T12:34:56.789Z rest...") */
const ISO_TIMESTAMP_PREFIX_REGEX =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s+([\s\S]*)$/;

export type LogLineFormatter = (line: string) => string;

export interface StructuredLogGrouper {
  handleLine(line: string): void;
  flush(): void;
}

type PendingJsonBuffer = {
  rawLines: string[];
  jsonLines: string[];
  size: number;
};

const MAX_JSON_LINES = 200;
const MAX_JSON_CHARS = 64_000;

export function createStructuredLogGrouper(opts: {
  readonly write: (text: string) => void;
  readonly formatLine?: LogLineFormatter;
}): StructuredLogGrouper {
  const buffers = new Map<string, PendingJsonBuffer>();

  const emit = (lines: readonly string[]) => {
    const formatted = opts.formatLine ? lines.map(opts.formatLine) : lines;
    opts.write(`${formatted.join("\n")}\n`);
  };

  const flushBuffer = (key: string) => {
    const buffer = buffers.get(key);
    if (!buffer) {
      return;
    }
    buffers.delete(key);
    emit(buffer.rawLines);
  };

  const handleLine = (line: string) => {
    const current: string | null = line;
    while (current) {
      const parsed = splitComposeLine(current);
      if (!parsed) {
        emit([current]);
        break;
      }

      const payloadNoTs = stripIsoTimestampPrefix(parsed.payload);
      const trimmed = payloadNoTs.trim();
      const key = parsed.service;
      const buffer = buffers.get(key);

      if (buffer) {
        if (!looksLikeJsonContinuation(trimmed)) {
          flushBuffer(key);
          continue;
        }

        buffer.rawLines.push(current);
        buffer.jsonLines.push(payloadNoTs);
        buffer.size += payloadNoTs.length;

        if (
          buffer.jsonLines.length >= MAX_JSON_LINES ||
          buffer.size >= MAX_JSON_CHARS ||
          isJsonComplete(buffer.jsonLines)
        ) {
          flushBuffer(key);
        }
        break;
      }

      if (looksLikeJsonStart(trimmed) && !isJsonComplete([payloadNoTs])) {
        buffers.set(key, {
          rawLines: [current],
          jsonLines: [payloadNoTs],
          size: payloadNoTs.length,
        });
        break;
      }

      emit([current]);
      break;
    }
  };

  const flush = () => {
    for (const key of [...buffers.keys()]) {
      flushBuffer(key);
    }
  };

  return { handleLine, flush };
}

function splitComposeLine(
  line: string
): { readonly service: string; readonly payload: string } | null {
  const idx = line.indexOf("|");
  if (idx === -1) {
    return null;
  }
  const service = line.slice(0, idx).trim();
  const after = line.slice(idx + 1);
  const payload = after.startsWith(" ") ? after.slice(1) : after;
  if (!service) {
    return null;
  }
  return { service, payload };
}

function stripIsoTimestampPrefix(payload: string): string {
  const match = payload.match(ISO_TIMESTAMP_PREFIX_REGEX);
  if (!match) {
    return payload;
  }
  return match[2] ?? payload;
}

function looksLikeJsonStart(trimmed: string): boolean {
  if (trimmed.length === 0) {
    return false;
  }
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function looksLikeJsonContinuation(trimmed: string): boolean {
  if (trimmed.length === 0) {
    return true;
  }
  const head = trimmed[0];
  return (
    head === "{" ||
    head === "}" ||
    head === "[" ||
    head === "]" ||
    head === '"' ||
    head === ","
  );
}

function isJsonComplete(lines: readonly string[]): boolean {
  const joined = lines.join("\n").trim();
  if (joined.length === 0) {
    return false;
  }
  if (!(joined.startsWith("{") || joined.startsWith("["))) {
    return false;
  }
  try {
    JSON.parse(joined);
    return true;
  } catch {
    return false;
  }
}
