/**
 * Pure decisions for turning appended output bytes into redactions and
 * output-event ranges. The supervisor reads the unemitted tail of a stream
 * file, asks {@link scanOutput} what to do, overwrites redacted bytes in place
 * and appends one event per range.
 *
 * Invariants:
 * - Emitted ranges are final: bytes are only redacted before they are
 *   emitted. A trailing run of bytes that is the start of some value (at
 *   most `longestSecret - 1` bytes) is held back until more
 *   output arrives or the stream ends, so a value split across two appends is
 *   still seen whole (the carry-over window).
 * - Redaction replaces each byte of a match with `*`, keeping offsets stable.
 *   Matching runs on raw bytes: the caller keeps the raw (unredacted) carry
 *   of held-back bytes and passes it in front of newly appended bytes, so a
 *   value that overlaps an already redacted one is still found.
 * - Ranges end on UTF-8 character boundaries while more bytes may follow, so
 *   each range decodes on its own; at end of stream the remainder is emitted
 *   as is and a reader withholds it if it is not valid UTF-8.
 * - No range is longer than `maxRangeBytes`; total emitted bytes never pass
 *   the capture budget.
 */

export type ScanInput = {
  /** Unemitted raw bytes of one stream, starting at file offset `offset`. */
  readonly bytes: Uint8Array;
  readonly offset: number;
  /** True when no more bytes will ever follow `bytes` (stream ended). */
  readonly final: boolean;
  /** Values to redact, already encoded; empty values are ignored. */
  readonly secrets: readonly Uint8Array[];
  /** Bytes the command may still capture, across both streams. */
  readonly captureRemaining: number;
  readonly maxRangeBytes: number;
};

export type ScanResult = {
  /** File regions to overwrite with `*` before any range is emitted. */
  readonly redactions: readonly {
    readonly offset: number;
    readonly length: number;
  }[];
  readonly ranges: readonly {
    readonly offset: number;
    readonly length: number;
  }[];
  /** True when the capture budget stopped emission inside the available bytes. */
  readonly budgetReached: boolean;
};

function isContinuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

function sequenceLength(lead: number): number {
  if (lead < 0x80) {
    return 1;
  }
  if ((lead & 0xe0) === 0xc0) {
    return 2;
  }
  if ((lead & 0xf0) === 0xe0) {
    return 3;
  }
  if ((lead & 0xf8) === 0xf0) {
    return 4;
  }
  return 1; // Invalid lead byte: never hold it back.
}

/**
 * Largest cut `<= end` that does not split a UTF-8 sequence. Invalid bytes do
 * not move the cut; at most 3 bytes are given back.
 */
export function utf8SafeCut(bytes: Uint8Array, end: number): number {
  let lead = end;
  let back = 0;
  while (lead > 0 && back < 3 && isContinuation(bytes[lead - 1] ?? 0)) {
    lead -= 1;
    back += 1;
  }
  if (lead === 0) {
    return back === 0 ? end : 0;
  }
  const start = lead - 1;
  const leadByte = bytes[start] ?? 0;
  if (isContinuation(leadByte)) {
    return end; // More than 3 continuation bytes: invalid, do not hold back.
  }
  const needed = sequenceLength(leadByte);
  return start + needed > end ? start : end;
}

/**
 * Length of the longest suffix of `bytes` that is a proper prefix of some
 * secret: those bytes may become a match once more output arrives. Output
 * that cannot start a value is never delayed.
 */
export function pendingPrefixLength(
  bytes: Uint8Array,
  secrets: readonly Uint8Array[]
): number {
  let longest = 0;
  for (const secret of secrets) {
    const max = Math.min(secret.length - 1, bytes.length);
    for (let length = max; length > longest; length -= 1) {
      if (suffixMatchesPrefix(bytes, secret, length)) {
        longest = length;
        break;
      }
    }
  }
  return longest;
}

function suffixMatchesPrefix(
  bytes: Uint8Array,
  secret: Uint8Array,
  length: number
): boolean {
  const start = bytes.length - length;
  for (let index = 0; index < length; index += 1) {
    if (bytes[start + index] !== secret[index]) {
      return false;
    }
  }
  return true;
}

/**
 * Every occurrence of `needle`, overlapping ones included, as merged
 * intervals: a run of overlapping or adjacent occurrences (for example a
 * periodic value in periodic output) is one interval, so memory grows with
 * the number of separate runs, never with the number of occurrences.
 * Exported for tests.
 */
export function findMatches(
  haystack: Uint8Array,
  needle: Uint8Array
): { readonly start: number; readonly length: number }[] {
  const matches: { start: number; length: number }[] = [];
  if (needle.length === 0 || needle.length > haystack.length) {
    return matches;
  }
  const buffer = Buffer.from(
    haystack.buffer,
    haystack.byteOffset,
    haystack.byteLength
  );
  let from = 0;
  while (from <= buffer.length - needle.length) {
    const index = buffer.indexOf(needle, from);
    if (index < 0) {
      break;
    }
    const last = matches.at(-1);
    if (last && index <= last.start + last.length) {
      last.length = index + needle.length - last.start;
    } else {
      matches.push({ start: index, length: needle.length });
    }
    from = index + 1;
  }
  return matches;
}

export function scanOutput(input: ScanInput): ScanResult {
  const secrets = input.secrets.filter((secret) => secret.length > 0);
  // Match against the raw bytes, so overlapping values are all found.
  const working = input.bytes;
  // Bytes past the capture budget are never published: scan only up to it,
  // plus enough for a value that starts inside it to finish.
  const longest = secrets.reduce(
    (max, secret) => Math.max(max, secret.length),
    0
  );
  const scanned = working.subarray(
    0,
    Math.min(working.length, Math.max(0, input.captureRemaining) + longest)
  );
  const redactions: { offset: number; length: number }[] = [];
  for (const secret of secrets) {
    for (const match of findMatches(scanned, secret)) {
      redactions.push({
        offset: input.offset + match.start,
        length: match.length,
      });
    }
  }
  const holdback = input.final ? 0 : pendingPrefixLength(working, secrets);
  let end = Math.max(0, working.length - holdback);
  if (!input.final) {
    end = utf8SafeCut(working, end);
  }
  let budgetReached = false;
  const budget = Math.max(0, input.captureRemaining);
  if (end > budget) {
    end = utf8SafeCut(working, budget);
    budgetReached = true;
  }
  const ranges: { offset: number; length: number }[] = [];
  let cursor = 0;
  while (cursor < end) {
    let next = Math.min(end, cursor + input.maxRangeBytes);
    if (next < end) {
      const cut = utf8SafeCut(working, next);
      next = cut > cursor ? cut : next;
    }
    ranges.push({ offset: input.offset + cursor, length: next - cursor });
    cursor = next;
  }
  return { redactions: mergeRedactions(redactions), ranges, budgetReached };
}

function mergeRedactions(
  regions: readonly { readonly offset: number; readonly length: number }[]
): { offset: number; length: number }[] {
  const sorted = [...regions].sort((left, right) => left.offset - right.offset);
  const merged: { offset: number; length: number }[] = [];
  for (const region of sorted) {
    const last = merged.at(-1);
    if (last && region.offset <= last.offset + last.length) {
      last.length =
        Math.max(last.offset + last.length, region.offset + region.length) -
        last.offset;
    } else {
      merged.push({ ...region });
    }
  }
  return merged;
}

/** Encode redaction values; values shorter than `minLength` bytes are skipped. */
export function encodeSecrets(opts: {
  readonly values: readonly string[];
  readonly minLength: number;
}): Uint8Array[] {
  const encoder = new TextEncoder();
  const unique = new Set(opts.values);
  return [...unique]
    .map((value) => encoder.encode(value))
    .filter((bytes) => bytes.length >= opts.minLength)
    .sort((left, right) => right.length - left.length);
}
