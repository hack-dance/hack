export const MCP_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;

/** Share one byte budget across command output streams, before decoding or line
 * buffering. Over-budget data is drained without retention while the owner stops
 * the command. Exact-limit output is valid; an additional byte triggers the limit.
 *
 * With `codePointSafe`, a stream never ends on a cut through a UTF-8 code point:
 * an incomplete trailing sequence is held until its next chunk arrives, and the
 * limit cut backs off to the preceding code point boundary. Bytes are charged
 * to the budget when they arrive, so the limit decision is unchanged; only the
 * retained prefix can be up to three bytes shorter. Source bytes that are
 * themselves invalid UTF-8 are passed through untouched at stream end.
 */
export function createMcpOutputBudget(opts: {
  readonly onLimit: () => void;
  readonly maxBytes?: number;
  readonly codePointSafe?: boolean;
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
  /** Charge a chunk to the shared budget; returns the accepted byte count. */
  const charge = (size: number): number => {
    const accepted = Math.min(remaining, size);
    remaining -= accepted;
    if (accepted < size && !exceeded) {
      exceeded = true;
      opts.onLimit();
    }
    return accepted;
  };
  return {
    exceeded: () => exceeded,
    wrap: (stream) => {
      const reader = stream.getReader();
      const retain =
        opts.codePointSafe === true
          ? createCodePointRetainer()
          : BYTE_EXACT_RETAINER;
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              reader.releaseLock();
              const rest = retain.flush();
              if (rest.byteLength > 0) {
                controller.enqueue(rest);
              }
              controller.close();
              return;
            }
            const kept = retain.take(value, charge(value.byteLength));
            if (kept.byteLength > 0) {
              controller.enqueue(kept);
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

/** Decides which accepted bytes of one stream are emitted now. */
type Retainer = {
  /** `accepted` is the prefix of `chunk` charged to the budget. */
  readonly take: (chunk: Uint8Array, accepted: number) => Uint8Array;
  readonly flush: () => Uint8Array;
};

const EMPTY = new Uint8Array(0);

const BYTE_EXACT_RETAINER: Retainer = {
  // Copy so a larger discarded backing buffer is not kept alive.
  take: (chunk, accepted) => (accepted > 0 ? chunk.slice(0, accepted) : EMPTY),
  flush: () => EMPTY,
};

function createCodePointRetainer(): Retainer {
  /** Accepted bytes of an incomplete trailing code point. */
  let held = EMPTY;
  return {
    take: (chunk, accepted) => {
      const candidate = concatBytes(held, chunk.subarray(0, accepted));
      const keep = candidate.byteLength - incompleteUtf8TailLength(candidate);
      // After a cut this stream retains nothing more, so a partial code point
      // is dropped instead of being held for a continuation.
      held = accepted < chunk.byteLength ? EMPTY : candidate.slice(keep);
      return keep > 0 ? candidate.slice(0, keep) : EMPTY;
    },
    flush: () => {
      const rest = held;
      held = EMPTY;
      return rest;
    },
  };
}

/**
 * Number of trailing bytes that start a UTF-8 sequence the buffer does not
 * complete (0-3). An invalid lead byte or an over-long continuation run counts
 * as complete, so malformed input is never held back indefinitely.
 */
export function incompleteUtf8TailLength(bytes: Uint8Array): number {
  const end = bytes.byteLength;
  for (let back = 1; back <= Math.min(4, end); back += 1) {
    const byte = bytes[end - back] ?? 0;
    if ((byte & 0xc0) === 0x80) {
      continue;
    }
    return back < utf8SequenceLength(byte) ? back : 0;
  }
  return 0;
}

function utf8SequenceLength(lead: number): number {
  if ((lead & 0xe0) === 0xc0) {
    return 2;
  }
  if ((lead & 0xf0) === 0xe0) {
    return 3;
  }
  if ((lead & 0xf8) === 0xf0) {
    return 4;
  }
  return 1;
}

function concatBytes(head: Uint8Array, tail: Uint8Array): Uint8Array {
  if (head.byteLength === 0) {
    return tail;
  }
  const joined = new Uint8Array(head.byteLength + tail.byteLength);
  joined.set(head, 0);
  joined.set(tail, head.byteLength);
  return joined;
}
