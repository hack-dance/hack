import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pumpStream } from "../src/lib/background-command/output-pump.ts";
import {
  encodeSecrets,
  findMatches,
  pendingPrefixLength,
  REDACTION_VALUES_LIMIT,
  scanOutput,
  scanSliceBytes,
  searchStart,
  utf8SafeCut,
} from "../src/lib/background-command/output-scanner.ts";
import {
  STALL_PERIODS_LIMIT,
  StallTracker,
} from "../src/lib/background-command/stall.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Feed `chunks` through scanOutput as a supervisor would: append to a file
 * image, apply redactions in place, and collect emitted ranges.
 */
function simulate(opts: {
  readonly chunks: readonly string[];
  readonly secrets?: readonly string[];
  readonly captureLimit?: number;
  readonly maxRangeBytes?: number;
}): {
  file: Uint8Array;
  ranges: { offset: number; length: number }[];
  budgetReached: boolean;
} {
  const secrets = encodeSecrets({ values: opts.secrets ?? [], minLength: 1 });
  // `raw` is what the child wrote (the supervisor's carry plus new bytes);
  // `file` is the stored image, redacted in place.
  let raw: Uint8Array = new Uint8Array(0);
  let file: Uint8Array = new Uint8Array(0);
  let emitted = 0;
  const ranges: { offset: number; length: number }[] = [];
  let budgetReached = false;
  const step = (final: boolean) => {
    const result = scanOutput({
      bytes: raw.subarray(emitted),
      offset: emitted,
      final,
      secrets,
      captureRemaining:
        (opts.captureLimit ?? 1 << 30) -
        ranges.reduce((sum, range) => sum + range.length, 0),
      maxRangeBytes: opts.maxRangeBytes ?? 16 * 1024,
    });
    for (const region of result.redactions) {
      // Ranges are final once emitted: redaction never touches them.
      expect(region.offset).toBeGreaterThanOrEqual(emitted);
      file.fill(0x2a, region.offset, region.offset + region.length);
    }
    for (const range of result.ranges) {
      expect(range.offset).toBe(emitted);
      ranges.push(range);
      emitted += range.length;
    }
    budgetReached ||= result.budgetReached;
  };
  for (const chunk of opts.chunks) {
    const bytes = encoder.encode(chunk);
    const nextRaw = new Uint8Array(raw.length + bytes.length);
    nextRaw.set(raw);
    nextRaw.set(bytes, raw.length);
    raw = nextRaw;
    const next = new Uint8Array(file.length + bytes.length);
    next.set(file);
    next.set(bytes, file.length);
    file = next;
    step(false);
  }
  step(true);
  return { file, ranges, budgetReached };
}

describe("utf8SafeCut", () => {
  test("never splits a multi-byte character", () => {
    const bytes = encoder.encode("aé€😀");
    // a(1) é(2) €(3) 😀(4) = 10 bytes
    expect(utf8SafeCut(bytes, 10)).toBe(10);
    expect(utf8SafeCut(bytes, 9)).toBe(6);
    expect(utf8SafeCut(bytes, 8)).toBe(6);
    expect(utf8SafeCut(bytes, 7)).toBe(6);
    expect(utf8SafeCut(bytes, 5)).toBe(3);
    expect(utf8SafeCut(bytes, 2)).toBe(1);
  });

  test("does not hold back invalid bytes forever", () => {
    const bytes = Uint8Array.from([0x61, 0xff, 0xfe]);
    expect(utf8SafeCut(bytes, 3)).toBe(3);
  });
});

describe("scanOutput", () => {
  test("ranges decode independently when a character arrives split", () => {
    const text = "héllo wörld 😀 done";
    const raw = encoder.encode(text);
    const chunks: string[] = [];
    // Split at every byte by feeding raw bytes through latin1-free pieces.
    const { ranges, file } = (() => {
      let file = new Uint8Array(0);
      let emitted = 0;
      const out: { offset: number; length: number }[] = [];
      for (let index = 0; index < raw.length; index += 1) {
        const next = new Uint8Array(file.length + 1);
        next.set(file);
        next[file.length] = raw[index] ?? 0;
        file = next;
        const result = scanOutput({
          bytes: file.subarray(emitted),
          offset: emitted,
          final: index === raw.length - 1,
          secrets: [],
          captureRemaining: 1 << 20,
          maxRangeBytes: 4,
        });
        for (const range of result.ranges) {
          out.push(range);
          emitted += range.length;
        }
      }
      return { ranges: out, file };
    })();
    expect(chunks).toEqual([]);
    for (const range of ranges) {
      expect(() =>
        decoder.decode(file.subarray(range.offset, range.offset + range.length))
      ).not.toThrow();
    }
    expect(decoder.decode(file)).toBe(text);
    expect(ranges.reduce((sum, range) => sum + range.length, 0)).toBe(
      raw.length
    );
  });

  test("redacts a value split across appends (carry-over window)", () => {
    const secret = "s3cr3t-token-value";
    const { file, ranges } = simulate({
      chunks: [
        "before s3cr3t-to",
        "ken-value after\n",
        "and s3cr3t-token-value again",
      ],
      secrets: [secret],
    });
    const text = decoder.decode(file);
    expect(text).not.toContain(secret);
    expect(text).toBe(
      `before ${"*".repeat(secret.length)} after\nand ${"*".repeat(secret.length)} again`
    );
    expect(ranges.reduce((sum, range) => sum + range.length, 0)).toBe(
      file.length
    );
  });

  test("redacts a value split one byte at a time", () => {
    const secret = "abcdefgh";
    const { file } = simulate({
      chunks: ["xx", ...secret.split(""), "yy"],
      secrets: [secret],
    });
    expect(decoder.decode(file)).toBe("xx********yy");
  });

  test("a value overlapping one redacted on an earlier append is still found", () => {
    const { file } = simulate({
      chunks: ["val=abcdef", "123456 end"],
      secrets: ["abcdef", "def123456"],
    });
    expect(decoder.decode(file)).toBe("val=************ end");
  });

  test("overlapping values are both redacted", () => {
    const { file } = simulate({
      chunks: ["val=abcdef123456 end"],
      secrets: ["abcdef", "def123456"],
    });
    expect(decoder.decode(file)).toBe("val=************ end");
  });

  test("periodic output against a periodic value yields one merged region, not one per occurrence", () => {
    const bytes = encoder.encode("a".repeat(1024 * 1024));
    const result = scanOutput({
      bytes,
      offset: 0,
      secrets: encodeSecrets({ values: ["aaaaaa"], minLength: 1 }),
      final: true,
      captureRemaining: bytes.length,
      maxRangeBytes: 16_384,
    });
    expect(result.redactions).toEqual([{ offset: 0, length: bytes.length }]);
    // Matches are merged as found: one interval, never a million objects.
    expect(
      findMatches(
        bytes,
        encodeSecrets({ values: ["aaaaaa"], minLength: 1 })[0] as Uint8Array
      )
    ).toEqual([{ start: 0, length: bytes.length }]);
    expect(
      findMatches(encoder.encode("ab-ab-xab"), encoder.encode("ab"))
    ).toEqual([
      { start: 0, length: 2 },
      { start: 3, length: 2 },
      { start: 7, length: 2 },
    ]);
  });

  test("many values over many runs keep one interval per run, not values x runs", () => {
    const run = `${"a".repeat(105)}b`;
    const bytes = encoder.encode(run.repeat(2000));
    const values = Array.from({ length: 100 }, (_, index) =>
      "a".repeat(6 + index)
    );
    const started = performance.now();
    const result = scanOutput({
      bytes,
      offset: 0,
      secrets: encodeSecrets({ values, minLength: 1 }),
      final: true,
      captureRemaining: bytes.length,
      maxRangeBytes: 16_384,
    });
    expect(result.redactions).toHaveLength(2000);
    expect(result.redactions[1]).toEqual({ offset: 106, length: 105 });
    // Loose bound: catches a regression to quadratic work, not a benchmark.
    expect(performance.now() - started).toBeLessThan(10_000);
  });

  test("holding back a partial long value is linear, not suffix by suffix", () => {
    const secrets = encodeSecrets({
      values: [`${"a".repeat(100_000)}b`],
      minLength: 1,
    });
    const scan = (text: string) => {
      const bytes = encoder.encode(text);
      const result = scanOutput({
        bytes,
        offset: 0,
        secrets,
        final: false,
        captureRemaining: 1 << 23,
        maxRangeBytes: 16_384,
      });
      return bytes.length - result.ranges.reduce((sum, r) => sum + r.length, 0);
    };
    const started = performance.now();
    // Could not start the value (ends in "c"): nothing held back.
    expect(scan(`${"a".repeat(100_000)}c`)).toBe(0);
    // Ends with a prefix of the value: exactly that prefix is held back.
    expect(scan(`${"x".repeat(10)}${"a".repeat(99_990)}`)).toBe(99_990);
    // Loose bound: the quadratic version took seconds here.
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("finding a long value in long periodic output is linear, overlaps included", () => {
    const started = performance.now();
    expect(
      findMatches(
        encoder.encode("a".repeat(262_144)),
        encoder.encode("a".repeat(100_000))
      )
    ).toEqual([{ start: 0, length: 262_144 }]);
    // Loose bound: the restart-by-one-byte search took seconds here.
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("single-pass matching agrees with a brute-force search, overlaps and held-back prefixes included", () => {
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7f_ff_ff_ff;
      return seed % n;
    };
    const word = (length: number) =>
      Array.from({ length }, () => "abc"[rand(3)]).join("");
    const encoder = new TextEncoder();
    for (let round = 0; round < 300; round += 1) {
      const values = Array.from({ length: 1 + rand(6) }, () =>
        word(1 + rand(7))
      );
      const secrets = encodeSecrets({ values, minLength: 1 });
      const text = word(rand(120));
      const bytes = encoder.encode(text);
      // Brute force: every occurrence of every value, merged.
      const covered = new Array<boolean>(text.length).fill(false);
      for (const value of new Set(values)) {
        for (
          let at = text.indexOf(value);
          at !== -1;
          at = text.indexOf(value, at + 1)
        ) {
          covered.fill(true, at, at + value.length);
        }
      }
      const expected: { offset: number; length: number }[] = [];
      covered.forEach((on, index) => {
        const last = expected.at(-1);
        if (on && last && last.offset + last.length === index) {
          last.length += 1;
        } else if (on) {
          expected.push({ offset: index, length: 1 });
        }
      });
      // Adjacent occurrences coalesce in the scanner too.
      const result = scanOutput({
        bytes,
        offset: 0,
        final: true,
        secrets,
        captureRemaining: 1 << 20,
        maxRangeBytes: 1 << 20,
      });
      expect(result.redactions).toEqual(expected);
      let pending = 0;
      for (const value of new Set(values)) {
        for (let length = value.length - 1; length > pending; length -= 1) {
          if (text.endsWith(value.slice(0, length))) {
            pending = length;
            break;
          }
        }
      }
      expect(pendingPrefixLength(bytes, secrets)).toBe(pending);
    }
  });

  test("one slice's work does not grow with the number of values", () => {
    expect(scanSliceBytes(0)).toBe(256 * 1024);
    expect(scanSliceBytes(REDACTION_VALUES_LIMIT)).toBe(256 * 1024);
    const values = Array.from(
      { length: REDACTION_VALUES_LIMIT },
      (_, index) => `redaction-value-${index}-${"p".repeat(16)}`
    );
    const secrets = encodeSecrets({ values, minLength: 6 });
    const bytes = new TextEncoder().encode(
      `${"x".repeat(200_000)}${values[700]}${"y".repeat(60_000)}`
    );
    const started = performance.now();
    const result = scanOutput({
      bytes,
      offset: 0,
      final: true,
      secrets,
      captureRemaining: 1 << 23,
      maxRangeBytes: 16 * 1024,
    });
    // Loose bound: the per-value search took about 0.3 s for this slice.
    expect(performance.now() - started).toBeLessThan(250);
    expect(result.redactions).toEqual([
      { offset: 200_000, length: (values[700] as string).length },
    ]);
  });

  test("a carried-over prefix is not searched again for every value", () => {
    const big = `BEGIN${"q".repeat(120_000)}END`;
    const values = [
      big,
      ...Array.from({ length: 1000 }, (_, index) => `short-${index}-value`),
    ];
    const secrets = encodeSecrets({ values, minLength: 1 });
    // Held back from the previous pass: all of the big value but its tail.
    const carry = `out:${big.slice(0, -2)}`;
    const bytes = encoder.encode(
      `${carry}${big.slice(-2)} done ${"z".repeat(16_000)}`
    );
    const scan = (scannedPrefix: number) => {
      const result = scanOutput({
        bytes,
        offset: 0,
        secrets,
        final: true,
        captureRemaining: 1 << 23,
        maxRangeBytes: 16_384,
        scannedPrefix,
      });
      return { result };
    };
    const full = scan(0);
    const bounded = scan(encoder.encode(carry).length);
    // Same regions: the only match ends in the new bytes.
    expect(bounded.result.redactions).toEqual(full.result.redactions);
    expect(bounded.result.redactions).toEqual([
      { offset: 4, length: encoder.encode(big).length },
    ]);
    // Each value is searched only from where a match could reach a new
    // byte: a short value skips nearly the whole carry; the big value starts
    // just far enough back to finish across the boundary.
    const carryBytes = encoder.encode(carry).length;
    expect(
      searchStart({
        scannedPrefix: carryBytes,
        scannedLength: bytes.length,
        valueLength: 17,
      })
    ).toBe(carryBytes - 16);
    expect(
      searchStart({
        scannedPrefix: carryBytes,
        scannedLength: bytes.length,
        valueLength: encoder.encode(big).length,
      })
    ).toBe(carryBytes - (encoder.encode(big).length - 1));
    expect(
      searchStart({ scannedPrefix: 0, scannedLength: 10, valueLength: 6 })
    ).toBe(0);
  });

  test("bytes past the capture budget are not scanned", () => {
    const bytes = encoder.encode(`${"x".repeat(40)}secret!${"y".repeat(10)}`);
    const result = scanOutput({
      bytes,
      offset: 0,
      secrets: encodeSecrets({ values: ["secret!"], minLength: 1 }),
      final: true,
      captureRemaining: 20,
      maxRangeBytes: 16_384,
    });
    expect(result.redactions).toEqual([]);
    expect(result.budgetReached).toBe(true);
  });

  test("ranges never exceed the event size", () => {
    const { ranges } = simulate({
      chunks: ["x".repeat(100)],
      maxRangeBytes: 16,
    });
    expect(ranges.every((range) => range.length <= 16)).toBe(true);
    expect(ranges.reduce((sum, range) => sum + range.length, 0)).toBe(100);
  });

  test("capture budget stops emission and reports it", () => {
    const { ranges, budgetReached } = simulate({
      chunks: ["a".repeat(30), "b".repeat(30)],
      captureLimit: 40,
    });
    expect(ranges.reduce((sum, range) => sum + range.length, 0)).toBe(40);
    expect(budgetReached).toBe(true);
  });

  test("only a suffix that could start a value is held back", () => {
    const secrets = encodeSecrets({ values: ["abcdefgh"], minLength: 1 });
    const unrelated = scanOutput({
      bytes: encoder.encode("first\n"),
      offset: 0,
      final: false,
      secrets,
      captureRemaining: 1 << 20,
      maxRangeBytes: 1024,
    });
    expect(unrelated.ranges).toEqual([{ offset: 0, length: 6 }]);
    const partial = scanOutput({
      bytes: encoder.encode("x=abc"),
      offset: 0,
      final: false,
      secrets,
      captureRemaining: 1 << 20,
      maxRangeBytes: 1024,
    });
    expect(partial.ranges).toEqual([{ offset: 0, length: 2 }]);
  });

  test("short values are not redacted", () => {
    expect(
      encodeSecrets({ values: ["1", "true", "abcdef"], minLength: 6 })
    ).toHaveLength(1);
  });
});

describe("StallTracker", () => {
  test("reports one stall per quiet period on the monotonic clock, then resumed", () => {
    const tracker = new StallTracker(1000, 0);
    expect(tracker.check(999)).toBeNull();
    expect(tracker.check(1000)).toEqual({
      type: "command.stalled",
      idleMs: 1000,
      lastOutputAt: null,
    });
    expect(tracker.check(5000)).toBeNull();
    expect(
      tracker.activity({
        nowMono: 5500,
        wall: "2026-11-11T00:00:00.000Z",
        output: true,
      })
    ).toEqual({ type: "command.resumed", idleMs: 5500 });
    expect(tracker.check(6000)).toBeNull();
    expect(tracker.check(6500)).toEqual({
      type: "command.stalled",
      idleMs: 1000,
      lastOutputAt: "2026-11-11T00:00:00.000Z",
    });
  });

  test("a state change also counts as activity", () => {
    const tracker = new StallTracker(1000, 0);
    expect(
      tracker.activity({ nowMono: 900, wall: "w", output: false })
    ).toBeNull();
    expect(tracker.check(1500)).toBeNull();
    expect(tracker.check(1900)?.type).toBe("command.stalled");
  });

  test("at most STALL_PERIODS_LIMIT stall periods are reported, each with its resume", () => {
    const tracker = new StallTracker(1, 0);
    let stalled = 0;
    let resumed = 0;
    for (let tick = 1; tick <= 4 * STALL_PERIODS_LIMIT; tick += 2) {
      if (tracker.check(tick * 10)?.type === "command.stalled") {
        stalled += 1;
      }
      const back = tracker.activity({
        nowMono: tick * 10 + 5,
        wall: "2026-01-01T00:00:00.000Z",
        output: true,
      });
      if (back?.type === "command.resumed") {
        resumed += 1;
      }
    }
    expect(stalled).toBe(STALL_PERIODS_LIMIT);
    expect(resumed).toBe(STALL_PERIODS_LIMIT);
    expect(tracker.isStalled).toBe(false);
  });

  test("0 turns detection off", () => {
    const tracker = new StallTracker(0, 0);
    expect(tracker.check(10_000_000)).toBeNull();
  });
});

describe("pumpStream", () => {
  test("an ordinary poll past its deadline stops after one slice; the next poll continues", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hack-bg-pump-"));
    try {
      const path = join(dir, "stdout");
      const text = "z".repeat(600_000);
      await writeFile(path, text, { mode: 0o600 });
      const secrets = encodeSecrets({
        values: Array.from(
          { length: REDACTION_VALUES_LIMIT },
          (_, index) => `value-${index}-padded`
        ),
        minLength: 6,
      });
      const slice = scanSliceBytes(secrets.length);
      const pump = (opts: { from: number; deadlineMono?: number }) =>
        pumpStream({
          path,
          stream: "stdout",
          final: false,
          ...opts,
          secrets,
          captureRemaining: 1 << 23,
          eventsRemaining: 65_536,
          redact: true,
          emit: async () => undefined,
        });
      const first = await pump({ from: 0, deadlineMono: 0 });
      expect(first.emittedTo).toBe(slice);
      const rest = await pump({ from: first.emittedTo });
      expect(rest.emittedTo).toBe(text.length);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the final drain reads past held-back slices until the file is consumed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hack-bg-pump-"));
    try {
      const path = join(dir, "stdout");
      // The whole output is the start of a value longer than two 256 KiB
      // slices: an ordinary poll holds all of it back, so only the final
      // drain can read past those held-back slices.
      const text = "a".repeat(600_000);
      await writeFile(path, text, { mode: 0o600 });
      const secrets = encodeSecrets({
        values: [
          `${"a".repeat(600_000)}b`,
          ...Array.from({ length: 511 }, (_, index) => `other-${index}-value`),
        ],
        minLength: 6,
      });
      const emitted: { offset: number; length: number }[] = [];
      const pump = (opts: {
        final: boolean;
        from: number;
        carry?: Uint8Array;
      }) =>
        pumpStream({
          path,
          stream: "stdout",
          ...opts,
          secrets,
          captureRemaining: 1 << 23,
          eventsRemaining: 65_536,
          redact: true,
          emit: async (range) => {
            emitted.push({ offset: range.offset, length: range.length });
          },
        });
      const first = await pump({ final: false, from: 0 });
      // Nothing emitted yet: the work is left to the final drain.
      expect(first.emittedTo).toBe(0);
      const last = await pump({
        final: true,
        from: first.emittedTo,
        carry: first.carry,
      });
      expect(last.emittedTo).toBe(text.length);
      expect(emitted.reduce((sum, range) => sum + range.length, 0)).toBe(
        text.length
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
