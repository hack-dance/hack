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
    longest = Math.max(longest, longestSuffixPrefix(bytes, secret));
  }
  return longest;
}

/**
 * Length of the longest proper prefix of `secret` that `bytes` ends with, in
 * linear time (KMP prefix function over the secret, then one pass over at
 * most `secret.length - 1` trailing bytes). A naive suffix-by-suffix
 * comparison is quadratic and, with a long value, could stall a capture poll
 * (and so cancel and timeout handling) for seconds.
 */
function longestSuffixPrefix(bytes: Uint8Array, secret: Uint8Array): number {
  if (secret.length < 2 || bytes.length === 0) {
    return 0;
  }
  const failure = prefixFunction(secret);
  const tail = bytes.subarray(Math.max(0, bytes.length - (secret.length - 1)));
  let matched = 0;
  for (const byte of tail) {
    while (matched > 0 && secret[matched] !== byte) {
      matched = failure[matched - 1] ?? 0;
    }
    if (secret[matched] === byte) {
      matched += 1;
    }
    if (matched === secret.length) {
      matched = failure[matched - 1] ?? 0;
    }
  }
  return matched;
}

function prefixFunction(secret: Uint8Array): Uint32Array {
  const failure = new Uint32Array(secret.length);
  let k = 0;
  for (let index = 1; index < secret.length; index += 1) {
    while (k > 0 && secret[index] !== secret[k]) {
      k = failure[k - 1] ?? 0;
    }
    if (secret[index] === secret[k]) {
      k += 1;
    }
    failure[index] = k;
  }
  return failure;
}

/**
 * Every occurrence of `needle`, overlapping ones included, as merged
 * intervals: a run of overlapping or adjacent occurrences (for example a
 * periodic value in periodic output) is one interval, so memory grows with
 * the number of separate runs, never with the number of occurrences. Linear
 * time (KMP): a byte-by-byte `indexOf` restart would compare nearly the whole
 * value again at every overlapping position. Exported for tests.
 */
export function findMatches(
  haystack: Uint8Array,
  needle: Uint8Array
): { readonly start: number; readonly length: number }[] {
  const matches: { start: number; length: number }[] = [];
  if (needle.length === 0 || needle.length > haystack.length) {
    return matches;
  }
  const failure = prefixFunction(needle);
  let matched = 0;
  for (let index = 0; index < haystack.length; index += 1) {
    const byte = haystack[index];
    while (matched > 0 && needle[matched] !== byte) {
      matched = failure[matched - 1] ?? 0;
    }
    if (needle[matched] === byte) {
      matched += 1;
    }
    if (matched === needle.length) {
      const start = index + 1 - needle.length;
      const last = matches.at(-1);
      if (last && start <= last.start + last.length) {
        last.length = index + 1 - last.start;
      } else {
        matches.push({ start, length: needle.length });
      }
      matched = failure[matched - 1] ?? 0;
    }
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
  // Each value's (already merged) intervals are merged into one running
  // sorted list, so memory stays at the number of separate runs in the union
  // rather than values x runs.
  let union: { start: number; length: number }[] = [];
  for (const secret of secrets) {
    union = mergeSortedIntervals(union, findMatches(scanned, secret));
  }
  const redactions = union.map((match) => ({
    offset: input.offset + match.start,
    length: match.length,
  }));
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
  return { redactions, ranges, budgetReached };
}

/**
 * Merge two lists of sorted, non-overlapping intervals into one (linear):
 * overlapping or adjacent intervals coalesce.
 */
function mergeSortedIntervals(
  left: readonly { readonly start: number; readonly length: number }[],
  right: readonly { readonly start: number; readonly length: number }[]
): { start: number; length: number }[] {
  const merged: { start: number; length: number }[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    const a = left[i];
    const b = right[j];
    const next =
      b === undefined || (a !== undefined && a.start <= b.start) ? a : b;
    if (next === a) {
      i += 1;
    } else {
      j += 1;
    }
    if (!next) {
      break;
    }
    const last = merged.at(-1);
    if (last && next.start <= last.start + last.length) {
      last.length =
        Math.max(last.start + last.length, next.start + next.length) -
        last.start;
    } else {
      merged.push({ start: next.start, length: next.length });
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
