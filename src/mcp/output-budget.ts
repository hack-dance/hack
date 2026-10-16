export const MCP_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;

/** Share one byte budget across command output streams, before decoding or line
 * buffering. Over-budget data is drained without retention while the owner stops
 * the command. Exact-limit output is valid; an additional byte triggers the limit.
 */
export function createMcpOutputBudget(opts: {
  readonly onLimit: () => void;
  readonly maxBytes?: number;
}): {
  readonly exceeded: () => boolean;
  readonly wrap: (
    stream: ReadableStream<Uint8Array>
  ) => ReadableStream<Uint8Array>;
} {
  let remaining = opts.maxBytes ?? MCP_OUTPUT_LIMIT_BYTES;
  if (!Number.isSafeInteger(remaining) || remaining < 1) {
    throw new RangeError("MCP output budget must be a positive integer");
  }
  let exceeded = false;
  return {
    exceeded: () => exceeded,
    wrap: (stream) => {
      const reader = stream.getReader();
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              reader.releaseLock();
              controller.close();
              return;
            }
            const accepted = Math.min(remaining, value.byteLength);
            remaining -= accepted;
            if (accepted < value.byteLength && !exceeded) {
              exceeded = true;
              opts.onLimit();
            }
            if (accepted > 0) {
              // Do not keep a reference to a larger discarded backing buffer.
              controller.enqueue(value.slice(0, accepted));
              return;
            }
          }
        },
        async cancel(reason) {
          await reader.cancel(reason);
          reader.releaseLock();
        },
      });
    },
  };
}
