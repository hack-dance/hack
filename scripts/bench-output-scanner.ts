/**
 * Benchmark for the background command redaction scanner: the work one
 * supervisor does to drain a full capture (8 MiB) against many redaction
 * values, slice by slice as the supervisor does. Prints CPU and wall time.
 *
 *   bun scripts/bench-output-scanner.ts [values=1024] [megabytes=8] [valueBytes=32] [random|adversarial]
 *
 * random: output is random lowercase text with a few real values planted, so
 * the scanner finds matches and holds back partial prefixes like real output.
 * adversarial: every value starts with the same two bytes and every third
 * byte occurs, and the output keeps re-entering that shared prefix, which
 * is the worst case for a trie node with many children.
 */
import {
  encodeSecrets,
  scanOutput,
  scanSliceBytes,
} from "../src/lib/background-command/output-scanner.ts";

const valueCount = Number(Bun.argv[2] ?? 1024);
const megabytes = Number(Bun.argv[3] ?? 8);
const valueBytes = Number(Bun.argv[4] ?? 32);
const adversarial = Bun.argv[5] === "adversarial";

// Deterministic pseudo-random bytes (xorshift32), so runs are comparable
// and only the planted values match.
let seed = 0x21_62;
const nextByte = (): number => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return 97 + ((seed >>> 0) % 26);
};
const values = Array.from({ length: valueCount }, (_, index) =>
  adversarial
    ? `QZ${String.fromCharCode(index % 256)}${String.fromCharCode(...Array.from({ length: valueBytes - 3 }, nextByte))}${index}`
    : String.fromCharCode(...Array.from({ length: valueBytes }, nextByte))
);
const secrets = encodeSecrets({ values, minLength: 6 });
const total = megabytes * 1024 * 1024;
const output = new Uint8Array(total);
for (let i = 0; i < total; i += 1) {
  output[i] = adversarial ? ([0x51, 0x5a, 0][i % 3] as number) : nextByte();
}
// Plant one value every 64 KiB.
const encoder = new TextEncoder();
for (let at = 0, n = 0; at + valueBytes < total; at += 64 * 1024, n += 1) {
  output.set(encoder.encode(values[n % values.length] as string), at);
}

const slice = scanSliceBytes(secrets.length);
const cpuStart = process.cpuUsage();
const wallStart = performance.now();
let offset = 0;
// Each byte counted once: a rescanned carry finds its matches again.
const redactedMap = new Uint8Array(total);
let carry = 0;
while (offset < total) {
  const end = Math.min(total, offset + slice);
  const from = offset - carry;
  const result = scanOutput({
    bytes: output.subarray(from, end),
    offset: from,
    final: end === total,
    secrets,
    captureRemaining: total,
    scannedPrefix: carry,
    maxRangeBytes: 16 * 1024,
  });
  for (const r of result.redactions) {
    redactedMap.fill(1, r.offset, r.offset + r.length);
  }
  const emitted = result.ranges.reduce((sum, r) => sum + r.length, 0);
  carry = end - (from + emitted);
  offset = end;
}
const wallMs = performance.now() - wallStart;
const cpu = process.cpuUsage(cpuStart);
console.log(
  JSON.stringify({
    values: secrets.length,
    megabytes,
    valueBytes,
    sliceBytes: slice,
    redactedBytes: redactedMap.reduce((sum, byte) => sum + byte, 0),
    cpuMs: Math.round((cpu.user + cpu.system) / 1000),
    wallMs: Math.round(wallMs),
  })
);
