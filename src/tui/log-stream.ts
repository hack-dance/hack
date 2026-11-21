/**
 * Reads a child's output stream line by line into `onLine` while the view is
 * active. When the view closes, it stops reading, unless `drainWhenInactive`
 * asks it to keep reading (and drop the lines) to the end of the stream.
 */
export async function consumeLogStream(opts: {
  readonly stream: ReadableStream<Uint8Array>;
  readonly isActive: () => boolean;
  readonly onLine: (line: string) => void;
  /**
   * Keep reading to the end after the view closes, dropping the lines, so a
   * child that still writes never blocks on a full pipe.
   */
  readonly drainWhenInactive?: boolean;
}): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";

  const reader = opts.stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (!opts.isActive()) {
        if (opts.drainWhenInactive) {
          continue;
        }
        break;
      }
      if (!value || value.length === 0) {
        continue;
      }
      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf("\n");
      while (idx >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.trim().length > 0) {
          opts.onLine(line);
        }
        idx = buffer.indexOf("\n");
      }
    }
  } finally {
    reader.releaseLock();
  }

  const rest = buffer.trim();
  if (rest.length > 0 && opts.isActive()) {
    opts.onLine(rest);
  }
}
