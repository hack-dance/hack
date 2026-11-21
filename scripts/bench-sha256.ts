#!/usr/bin/env bun
/**
 * SHA-256 throughput of the ways the CLI can hash an executable.
 *
 * Usage: bun scripts/bench-sha256.ts [--file <path>] [--runs 3] [--iterations 5]
 *
 * Method: one thread; each case runs `iterations` times and reports the median;
 * the whole set runs `runs` times; the report gives the best median and the
 * range of medians (MiB/s). Every run prints the CPU model, core count and load
 * average. (a) in-memory: one 256 MiB buffer, and a 16 KiB buffer repeated to
 * 256 MiB, through `Bun.CryptoHasher`, `node:crypto` and `crypto.subtle`.
 * (b) a file (default: this Bun executable, about 90 MiB) with a warm page
 * cache: hashing paths, and the same reads without hashing so the bound
 * (read or hash) is visible.
 */
import { createHash } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { arch, cpus, loadavg, platform } from "node:os";

const MIB = 1024 * 1024;

function option(name: string, fallback: string): string {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? (Bun.argv[index + 1] ?? fallback) : fallback;
}
const file = option("--file", process.execPath);
const runs = Number(option("--runs", "3"));
const iterations = Number(option("--iterations", "5"));

function cpuModel(): string {
  if (platform() === "darwin") {
    const out = Bun.spawnSync(["sysctl", "-n", "machdep.cpu.brand_string"]);
    return new TextDecoder().decode(out.stdout).trim();
  }
  try {
    const info = readFileSync("/proc/cpuinfo", "utf8");
    const model = /^model name\s*:\s*(.+)$/m.exec(info)?.[1];
    const sha = /^flags\s*:.*\bsha_ni\b/m.test(info)
      ? "sha_ni"
      : /^Features\s*:.*\bsha2\b/m.test(info)
        ? "sha2"
        : "no SHA extension flag";
    return `${model ?? cpus()[0]?.model ?? "unknown"} (${sha})`;
  } catch {
    return cpus()[0]?.model ?? "unknown";
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

type Case = {
  readonly name: string;
  readonly bytes: number;
  readonly run: () => Promise<unknown> | unknown;
};

const big = new Uint8Array(256 * MIB);
crypto.getRandomValues(big.subarray(0, 65_536));
for (let offset = 65_536; offset < big.length; offset *= 2) {
  big.copyWithin(offset, 0, Math.min(offset, big.length - offset));
}
const small = big.subarray(0, 16 * 1024);
const repeats = big.length / small.length;
const size = Bun.file(file).size;

/** Today's CLI path (`nativeHttpsExecutableSha256`): a Node read stream. */
async function nodeStream(hashing: boolean): Promise<void> {
  const handle = await open(file, constants.O_RDONLY);
  try {
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      if (hashing) {
        hash.update(chunk);
      }
    }
    hash.digest("hex");
  } finally {
    await handle.close();
  }
}

/** One reused buffer, read with positional reads, no per-chunk allocation. */
async function bufferedRead(
  hashing: boolean,
  bufferBytes: number
): Promise<void> {
  const handle = await open(file, constants.O_RDONLY);
  try {
    const hasher = new Bun.CryptoHasher("sha256");
    const buffer = new Uint8Array(bufferBytes);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        position
      );
      if (bytesRead === 0) {
        break;
      }
      if (hashing) {
        hasher.update(buffer.subarray(0, bytesRead));
      }
      position += bytesRead;
    }
    hasher.digest("hex");
  } finally {
    await handle.close();
  }
}

/** Two reused buffers: the next read runs while the current chunk is hashed. */
async function pipelinedRead(bufferBytes: number): Promise<void> {
  const handle = await open(file, constants.O_RDONLY);
  try {
    const hasher = new Bun.CryptoHasher("sha256");
    const buffers = [new Uint8Array(bufferBytes), new Uint8Array(bufferBytes)];
    let position = 0;
    let turn = 0;
    let pending = handle.read(buffers[0] as Uint8Array, 0, bufferBytes, 0);
    for (;;) {
      const { bytesRead, buffer } = await pending;
      if (bytesRead === 0) {
        break;
      }
      position += bytesRead;
      turn ^= 1;
      pending = handle.read(
        buffers[turn] as Uint8Array,
        0,
        bufferBytes,
        position
      );
      hasher.update(buffer.subarray(0, bytesRead));
    }
    hasher.digest("hex");
  } finally {
    await handle.close();
  }
}

const cases: Case[] = [
  {
    name: "memory 256 MiB, Bun.CryptoHasher",
    bytes: big.length,
    run: () => new Bun.CryptoHasher("sha256").update(big).digest("hex"),
  },
  {
    name: "memory 256 MiB, node:crypto",
    bytes: big.length,
    run: () => createHash("sha256").update(big).digest("hex"),
  },
  {
    name: "memory 256 MiB, crypto.subtle",
    bytes: big.length,
    run: () => crypto.subtle.digest("SHA-256", big),
  },
  {
    name: "memory 16 KiB x16384, Bun.CryptoHasher",
    bytes: big.length,
    run: () => {
      const hasher = new Bun.CryptoHasher("sha256");
      for (let index = 0; index < repeats; index += 1) {
        hasher.update(small);
      }
      return hasher.digest("hex");
    },
  },
  {
    name: "memory 16 KiB x16384, crypto.subtle (one digest each)",
    bytes: big.length,
    run: async () => {
      for (let index = 0; index < repeats; index += 1) {
        await crypto.subtle.digest("SHA-256", small);
      }
    },
  },
  {
    name: "file, today: node stream + node:crypto",
    bytes: size,
    run: () => nodeStream(true),
  },
  {
    name: "file, read only: node stream",
    bytes: size,
    run: () => nodeStream(false),
  },
  {
    name: "file, 1 MiB reused buffer + CryptoHasher",
    bytes: size,
    run: () => bufferedRead(true, MIB),
  },
  {
    name: "file, read only: 1 MiB reused buffer",
    bytes: size,
    run: () => bufferedRead(false, MIB),
  },
  {
    name: "file, 8 MiB reused buffer + CryptoHasher",
    bytes: size,
    run: () => bufferedRead(true, 8 * MIB),
  },
  {
    name: "file, pipelined 2x4 MiB reads + CryptoHasher",
    bytes: size,
    run: () => pipelinedRead(4 * MIB),
  },
  {
    name: "file, Bun.file().arrayBuffer() + one update",
    bytes: size,
    run: async () =>
      new Bun.CryptoHasher("sha256")
        .update(await Bun.file(file).arrayBuffer())
        .digest("hex"),
  },
  {
    name: "file, read only: Bun.file().arrayBuffer()",
    bytes: size,
    run: () => Bun.file(file).arrayBuffer(),
  },
  {
    name: "file, Bun.mmap + one update",
    bytes: size,
    run: () =>
      new Bun.CryptoHasher("sha256")
        .update(Bun.mmap(file, { shared: false }))
        .digest("hex"),
  },
];

console.log(
  `bun ${Bun.version} ${platform()} ${arch()}; file ${file} (${(size / MIB).toFixed(1)} MiB); median of ${iterations}, ${runs} runs`
);
const medians = new Map<string, number[]>();
for (let run = 1; run <= runs; run += 1) {
  const load = loadavg()
    .map((value) => value.toFixed(2))
    .join(" ");
  console.log(
    `run ${run}: cpu ${cpuModel()}, ${cpus().length} cores, load ${load}`
  );
  for (const item of cases) {
    // One warm-up keeps the page cache and JIT warm.
    await item.run();
    const rates: number[] = [];
    for (let index = 0; index < iterations; index += 1) {
      const start = Bun.nanoseconds();
      await item.run();
      const seconds = (Bun.nanoseconds() - start) / 1e9;
      rates.push(item.bytes / MIB / seconds);
    }
    const value = median(rates);
    medians.set(item.name, [...(medians.get(item.name) ?? []), value]);
  }
}
console.log("\ncase | best MiB/s | range of run medians | ms per file (best)");
for (const item of cases) {
  const values = medians.get(item.name) ?? [];
  const best = Math.max(...values);
  const ms =
    item.bytes === size ? `${((size / MIB / best) * 1000).toFixed(1)}` : "";
  console.log(
    `${item.name} | ${best.toFixed(0)} | ${Math.min(...values).toFixed(0)}-${best.toFixed(0)} | ${ms}`
  );
}
