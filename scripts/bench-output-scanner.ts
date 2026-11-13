/**
 * Benchmark for the background command redaction scanner: the work one
 * supervisor does to drain a full capture (8 MiB) against many redaction
 * values, slice by slice as the supervisor does. Prints CPU and wall time.
 *
 *   bun scripts/bench-output-scanner.ts [values=1024] [megabytes=8] [valueBytes=32]
 *
 * Output is random lowercase text with a few real values planted, so the
 * scanner finds matches and holds back partial prefixes like real output.
 */
import {
  encodeSecrets,
  scanOutput,
  scanSliceBytes,
} from "../src/lib/background-command/output-scanner.ts";

const valueCount = Number(Bun.argv[2] ?? 1024);
const megabytes = Number(Bun.argv[3] ?? 8);
const valueBytes = Number(Bun.argv[4] ?? 32);

// Deterministic pseudo-random bytes, so runs are comparable.
let seed = 0x21_62;
const nextByte = (): number => {
  seed = (seed * 1_103_515_245 + 12_345) & 0x7f_ff_ff_ff;
  return 97 + (seed % 26);
};
const values = Array.from({ length: valueCount }, () =>
  String.fromCharCode(...Array.from({ length: valueBytes }, nextByte))
);
const secrets = encodeSecrets({ values, minLength: 6 });
const total = megabytes * 1024 * 1024;
const output = new Uint8Array(total);
for (let i = 0; i < total; i += 1) {
  output[i] = nextByte();
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
let redacted = 0;
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
  redacted += result.redactions.reduce((sum, r) => sum + r.length, 0);
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
    redactedBytes: redacted,
    cpuMs: Math.round((cpu.user + cpu.system) / 1000),
    wallMs: Math.round(wallMs),
  })
);
