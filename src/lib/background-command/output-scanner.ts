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
  /**
   * Leading bytes already searched for values by an earlier scan (the
   * carried-over held-back bytes). A match wholly inside them was already
   * redacted, so each value is searched only from where a match could first
   * reach a new byte: work per value is its length plus the new bytes, never
   * the carry again.
   */
  readonly scannedPrefix?: number;
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
  const matcher = matcherFor(secrets);
  if (matcher.longest < 2 || bytes.length === 0) {
    return 0;
  }
  // A pending prefix is shorter than the longest value, so the state after
  // the last `longest - 1` bytes (read from the root) already holds it.
  let state = 0;
  for (const byte of bytes.subarray(
    Math.max(0, bytes.length - (matcher.longest - 1))
  )) {
    state = step(matcher, state, byte);
  }
  // The state is the longest suffix that is a prefix of some value; it is
  // pending only if some value continues past it.
  while (state !== 0 && matcher.firstChild[state] === -1) {
    state = matcher.fail[state] as number;
  }
  return matcher.depth[state] as number;
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
  // Keyed by the caller's array, so a supervisor builds its matcher once.
  const matcher = matcherFor(input.secrets);
  // Match against the raw bytes, so overlapping values are all found.
  const working = input.bytes;
  // Bytes past the capture budget are never published: scan only up to it,
  // plus enough for a value that starts inside it to finish.
  const longest = matcher.longest;
  const scanned = working.subarray(
    0,
    Math.min(working.length, Math.max(0, input.captureRemaining) + longest)
  );
  // One pass over the bytes finds every value (Aho-Corasick), so the work is
  // the byte count, not bytes x values.
  const union = findAllMatches({
    matcher,
    bytes: scanned,
    scannedPrefix: input.scannedPrefix ?? 0,
  });
  const redactions = union.map((match) => ({
    offset: input.offset + match.start,
    length: match.length,
  }));
  const holdback = input.final
    ? 0
    : pendingPrefixLength(working, input.secrets);
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
 * Where a value's search starts: the first position from which a match
 * could reach a byte after the already-searched prefix. Exported for tests.
 */
export function searchStart(opts: {
  readonly scannedPrefix: number;
  readonly scannedLength: number;
  readonly valueLength: number;
}): number {
  return Math.max(
    0,
    Math.min(opts.scannedLength, opts.scannedPrefix) - (opts.valueLength - 1)
  );
}

/**
 * Most distinct redaction values a full-capture command may have. Matching
 * is one pass over the output whatever the count; the limit bounds the
 * matcher's size and build time.
 */
export const REDACTION_VALUES_LIMIT = 1024;

/**
 * Slice length for one scan. Matching is one pass whatever the number of
 * values, so one slice's work is bounded by its length alone (8 MiB, so
 * 32 slices, measured under 0.4 s of CPU with 1,024 values, random or
 * adversarial; see scripts/bench-output-scanner.ts). The count is accepted
 * for compatibility.
 */
export function scanSliceBytes(_secretCount: number): number {
  return 256 * 1024;
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

// --- Multi-value matching (Aho-Corasick) --------------------------------

/**
 * A trie of the values with failure links, in typed arrays: per node its
 * byte, first child, next sibling, failure link, depth and the length of the
 * longest value that ends at it or at a node on its failure chain. The root's
 * children are also kept in a dense table, since most bytes return there.
 * Memory is about 22 bytes per byte of value text, plus a 1 KiB table for
 * each node with more than 16 children (at most about 80 bytes per byte).
 */
type Matcher = {
  readonly label: Uint8Array;
  readonly firstChild: Int32Array;
  readonly nextSibling: Int32Array;
  readonly fail: Int32Array;
  readonly depth: Int32Array;
  readonly best: Int32Array;
  readonly rootChild: Int32Array;
  /** Per node: offset of its 256-entry table in `dense`, or -1. */
  readonly denseAt: Int32Array;
  readonly dense: Int32Array;
  readonly longest: number;
};

/** Nodes with more children than this get a dense table: no long sibling scans. */
const DENSE_CHILDREN = 16;

const matchers = new WeakMap<readonly Uint8Array[], Matcher>();

/** The matcher for a set of values, built once per array (the supervisor keeps one). */
function matcherFor(secrets: readonly Uint8Array[]): Matcher {
  const cached = matchers.get(secrets);
  if (cached) {
    return cached;
  }
  const matcher = buildMatcher(secrets.filter((secret) => secret.length > 0));
  matchers.set(secrets, matcher);
  return matcher;
}

function buildMatcher(secrets: readonly Uint8Array[]): Matcher {
  const capacity = 1 + secrets.reduce((sum, secret) => sum + secret.length, 0);
  const label = new Uint8Array(capacity);
  const firstChild = new Int32Array(capacity).fill(-1);
  const nextSibling = new Int32Array(capacity).fill(-1);
  const fail = new Int32Array(capacity);
  const depth = new Int32Array(capacity);
  const best = new Int32Array(capacity);
  const rootChild = new Int32Array(256).fill(-1);
  let nodes = 1;
  const child = (node: number, byte: number): number => {
    if (node === 0) {
      return rootChild[byte] as number;
    }
    for (
      let c = firstChild[node] as number;
      c !== -1;
      c = nextSibling[c] as number
    ) {
      if (label[c] === byte) {
        return c;
      }
    }
    return -1;
  };
  let longest = 0;
  for (const secret of secrets) {
    longest = Math.max(longest, secret.length);
    let node = 0;
    for (const byte of secret) {
      let next = child(node, byte);
      if (next === -1) {
        next = nodes;
        nodes += 1;
        label[next] = byte;
        depth[next] = (depth[node] as number) + 1;
        nextSibling[next] = firstChild[node] as number;
        firstChild[node] = next;
        if (node === 0) {
          rootChild[byte] = next;
        }
      }
      node = next;
    }
    best[node] = Math.max(best[node] as number, secret.length);
  }
  linkFailures({ label, firstChild, nextSibling, fail, best, nodes, child });
  const { denseAt, dense } = denseTables({
    label,
    firstChild,
    nextSibling,
    nodes,
  });
  return {
    label,
    firstChild,
    nextSibling,
    fail,
    depth,
    best,
    rootChild,
    denseAt,
    dense,
    longest,
  };
}

/** Breadth-first failure links; `best` inherits along them. */
function linkFailures(opts: {
  readonly label: Uint8Array;
  readonly firstChild: Int32Array;
  readonly nextSibling: Int32Array;
  readonly fail: Int32Array;
  readonly best: Int32Array;
  readonly nodes: number;
  readonly child: (node: number, byte: number) => number;
}): void {
  const { label, firstChild, nextSibling, fail, best, child } = opts;
  const queue = new Int32Array(opts.nodes);
  let head = 0;
  let tail = 0;
  for (
    let c = firstChild[0] as number;
    c !== -1;
    c = nextSibling[c] as number
  ) {
    fail[c] = 0;
    queue[tail] = c;
    tail += 1;
  }
  while (head < tail) {
    const node = queue[head] as number;
    head += 1;
    for (
      let c = firstChild[node] as number;
      c !== -1;
      c = nextSibling[c] as number
    ) {
      const byte = label[c] as number;
      let f = fail[node] as number;
      let target = child(f, byte);
      while (target === -1 && f !== 0) {
        f = fail[f] as number;
        target = child(f, byte);
      }
      fail[c] = target === -1 || target === c ? 0 : target;
      best[c] = Math.max(best[c] as number, best[fail[c] as number] as number);
      queue[tail] = c;
      tail += 1;
    }
  }
}

/** A 256-entry child table for every node with many children. */
function denseTables(opts: {
  readonly label: Uint8Array;
  readonly firstChild: Int32Array;
  readonly nextSibling: Int32Array;
  readonly nodes: number;
}): { denseAt: Int32Array; dense: Int32Array } {
  const { label, firstChild, nextSibling } = opts;
  const denseAt = new Int32Array(opts.nodes).fill(-1);
  const wide: number[] = [];
  for (let node = 1; node < opts.nodes; node += 1) {
    let count = 0;
    for (
      let c = firstChild[node] as number;
      c !== -1;
      c = nextSibling[c] as number
    ) {
      count += 1;
    }
    if (count > DENSE_CHILDREN) {
      denseAt[node] = wide.length * 256;
      wide.push(node);
    }
  }
  const dense = new Int32Array(wide.length * 256).fill(-1);
  for (const node of wide) {
    const at = denseAt[node] as number;
    for (
      let c = firstChild[node] as number;
      c !== -1;
      c = nextSibling[c] as number
    ) {
      dense[at + (label[c] as number)] = c;
    }
  }
  return { denseAt, dense };
}

function step(matcher: Matcher, from: number, byte: number): number {
  let state = from;
  for (;;) {
    if (state === 0) {
      const next = matcher.rootChild[byte] as number;
      return next === -1 ? 0 : next;
    }
    const at = matcher.denseAt[state] as number;
    if (at !== -1) {
      const next = matcher.dense[at + byte] as number;
      if (next !== -1) {
        return next;
      }
      state = matcher.fail[state] as number;
      continue;
    }
    for (
      let c = matcher.firstChild[state] as number;
      c !== -1;
      c = matcher.nextSibling[c] as number
    ) {
      if (matcher.label[c] === byte) {
        return c;
      }
    }
    state = matcher.fail[state] as number;
  }
}

/**
 * Every occurrence of every value in `bytes`, overlapping ones included, as
 * merged sorted intervals (overlapping or adjacent occurrences coalesce).
 * Matches wholly inside the first `scannedPrefix` bytes were found by an
 * earlier scan and are skipped; the search starts where a match could first
 * reach a new byte.
 */
function findAllMatches(opts: {
  readonly matcher: Matcher;
  readonly bytes: Uint8Array;
  readonly scannedPrefix: number;
}): { start: number; length: number }[] {
  const { matcher, bytes } = opts;
  const merged: { start: number; length: number }[] = [];
  if (matcher.longest === 0) {
    return merged;
  }
  const prefix = Math.min(bytes.length, Math.max(0, opts.scannedPrefix));
  const from = Math.max(0, prefix - (matcher.longest - 1));
  let state = 0;
  for (let index = from; index < bytes.length; index += 1) {
    state = step(matcher, state, bytes[index] as number);
    const length = matcher.best[state] as number;
    if (length === 0 || index < prefix) {
      continue;
    }
    let start = index + 1 - length;
    const end = index + 1;
    // Intervals arrive in end order; a longer one can start before the
    // previous ones, so pop everything it overlaps or touches.
    for (;;) {
      const last = merged.at(-1);
      if (!last || start > last.start + last.length) {
        break;
      }
      start = Math.min(start, last.start);
      merged.pop();
    }
    merged.push({ start, length: end - start });
  }
  return merged;
}
