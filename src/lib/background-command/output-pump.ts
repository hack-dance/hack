import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { OUTPUT_EVENT_MAX_BYTES, type OutputStream } from "./journal.ts";
import { scanOutput } from "./output-scanner.ts";

const READ_SLICE_BYTES = 1024 * 1024;

export type PumpResult = {
  /** File offset up to which output events now exist. */
  readonly emittedTo: number;
  /** Raw bytes from `emittedTo` that were read but held back. */
  readonly carry: Uint8Array;
  readonly emittedBytes: number;
  readonly events: number;
  readonly budgetReached: boolean;
  /** Current file size (bytes the kernel has appended so far). */
  readonly size: number;
};

/**
 * Turn the unemitted tail of one stream file into output events.
 *
 * Bytes are read from `from` to the current end of file in bounded slices.
 * Redactions are written in place (same length, so offsets never move)
 * before the range that covers them is announced. `emit` is called once per
 * range, in order; it must append the event before returning.
 */
export async function pumpStream(opts: {
  readonly path: string;
  readonly stream: OutputStream;
  readonly from: number;
  /**
   * Raw bytes from `from` that an earlier call held back (the carry-over
   * window). On disk they may already be redacted; matching needs them raw.
   */
  readonly carry?: Uint8Array;
  /** No more bytes will be appended (the child is gone). */
  readonly final: boolean;
  readonly secrets: readonly Uint8Array[];
  readonly captureRemaining: number;
  readonly eventsRemaining: number;
  /** False for a reader taking over from a lost supervisor: no values to redact. */
  readonly redact: boolean;
  readonly emit: (range: {
    readonly stream: OutputStream;
    readonly offset: number;
    readonly length: number;
  }) => Promise<void>;
}): Promise<PumpResult> {
  const handle = await open(
    opts.path,
    (opts.redact ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW
  ).catch(() => null);
  if (!handle) {
    return {
      emittedTo: opts.from,
      carry: opts.carry ?? new Uint8Array(0),
      emittedBytes: 0,
      events: 0,
      budgetReached: false,
      size: 0,
    };
  }
  const state: PumpState = {
    from: opts.from,
    carry: opts.carry ?? new Uint8Array(0),
    emittedBytes: 0,
    events: 0,
    budgetReached: false,
    size: 0,
  };
  try {
    for (;;) {
      state.size = (await handle.stat()).size;
      const slice = await readSlice({ handle, state, final: opts.final });
      if (!slice) {
        break;
      }
      const scan = scanOutput({
        bytes: slice.bytes,
        offset: state.from,
        final: slice.final,
        secrets: opts.redact ? opts.secrets : [],
        captureRemaining: opts.captureRemaining - state.emittedBytes,
        maxRangeBytes: OUTPUT_EVENT_MAX_BYTES,
      });
      await writeRedactions({ handle, regions: scan.redactions });
      const sliceStart = state.from;
      const progressed = await emitRanges({ opts, state, ranges: scan.ranges });
      state.budgetReached ||= scan.budgetReached;
      state.carry = slice.bytes.slice(state.from - sliceStart);
      if (state.budgetReached || !progressed) {
        break;
      }
    }
  } finally {
    await handle.close();
  }
  return {
    emittedTo: state.from,
    carry: state.carry,
    emittedBytes: state.emittedBytes,
    events: state.events,
    budgetReached: state.budgetReached,
    size: state.size,
  };
}

type PumpState = {
  from: number;
  carry: Uint8Array;
  emittedBytes: number;
  events: number;
  budgetReached: boolean;
  size: number;
};

/** Carry plus the next bounded slice of new bytes; null when nothing to scan. */
async function readSlice(opts: {
  readonly handle: FileHandle;
  readonly state: PumpState;
  readonly final: boolean;
}): Promise<{ readonly bytes: Uint8Array; readonly final: boolean } | null> {
  const { state } = opts;
  const readFrom = state.from + state.carry.length;
  if (state.from >= state.size || (readFrom >= state.size && !opts.final)) {
    return null;
  }
  const end = Math.max(
    readFrom,
    Math.min(state.size, readFrom + READ_SLICE_BYTES)
  );
  const fresh = new Uint8Array(end - readFrom);
  const { bytesRead } = await opts.handle.read(
    fresh,
    0,
    fresh.length,
    readFrom
  );
  const bytes = new Uint8Array(state.carry.length + bytesRead);
  bytes.set(state.carry);
  bytes.set(fresh.subarray(0, bytesRead), state.carry.length);
  return { bytes, final: opts.final && readFrom + bytesRead >= state.size };
}

/** Overwrite matched values with `*` in place, before any range covers them. */
async function writeRedactions(opts: {
  readonly handle: FileHandle;
  readonly regions: readonly {
    readonly offset: number;
    readonly length: number;
  }[];
}): Promise<void> {
  for (const region of opts.regions) {
    await opts.handle.write(
      Buffer.alloc(region.length, "*"),
      0,
      region.length,
      region.offset
    );
  }
  if (opts.regions.length > 0) {
    await opts.handle.sync().catch(() => undefined);
  }
}

async function emitRanges(opts: {
  readonly opts: Parameters<typeof pumpStream>[0];
  readonly state: PumpState;
  readonly ranges: readonly {
    readonly offset: number;
    readonly length: number;
  }[];
}): Promise<boolean> {
  const { state } = opts;
  let progressed = false;
  for (const range of opts.ranges) {
    if (state.events >= opts.opts.eventsRemaining) {
      state.budgetReached = true;
      break;
    }
    await opts.opts.emit({ stream: opts.opts.stream, ...range });
    state.from = range.offset + range.length;
    state.emittedBytes += range.length;
    state.events += 1;
    progressed = true;
  }
  return progressed;
}
