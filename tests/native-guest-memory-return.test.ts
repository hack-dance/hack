import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSyncBounded } from "./helpers/bounded-spawn-sync.ts";

const SCRIPT = "packages/runtime-core/src/provider/guest-memory-return.sh";
const IDLE_STAT = "cpu  100 0 100 100000 0 0 0 0 0 0\n";

type Paths = {
  readonly order: string;
  readonly compact: string;
  readonly stat: string;
  readonly status: string;
  readonly marker: string;
  readonly owner: string;
  readonly boot: string;
};

/**
 * Runs the guest script against stand-in files: no sleep between windows, at most
 * three windows, and `quietTicks` busy ticks allowed per window.
 */
async function run(opts: {
  readonly paths: Paths;
  readonly quietTicks: number;
  readonly identity?: readonly [string, string];
}): Promise<{ exitCode: number; stdout: string }> {
  // Every stand-in must replace exactly one place in the script. A target that is no
  // longer there would leave the script pointing at the real system file.
  const swaps: readonly (readonly [string, string])[] = [
    [
      "order_file=/sys/module/page_reporting/parameters/page_reporting_order",
      `order_file=${opts.paths.order}`,
    ],
    [
      "compact_file=/proc/sys/vm/compact_memory",
      `compact_file=${opts.paths.compact}`,
    ],
    ["stat_file=/proc/stat", `stat_file=${opts.paths.stat}`],
    [
      "status_file=/run/hack-local/memory-return.status",
      `status_file=${opts.paths.status}`,
    ],
    [
      "marker_file=/run/hack-local/memory-return.started",
      `marker_file=${opts.paths.marker}`,
    ],
    ["/storage/.hack-local-owner", opts.paths.owner],
    ["/proc/sys/kernel/random/boot_id", opts.paths.boot],
    ["window_seconds=15", "window_seconds=0"],
    ["max_windows=60", "max_windows=3"],
    ["quiet_windows=6", "quiet_windows=2"],
    ["quiet_ticks=$((window_seconds * 15))", `quiet_ticks=${opts.quietTicks}`],
  ];
  let script = await Bun.file(SCRIPT).text();
  for (const [from, to] of swaps) {
    expect(script.split(from).length, from).toBe(2);
    script = script.replace(from, to);
  }
  const result = spawnSyncBounded(
    [
      "sh",
      "-c",
      script,
      "guest-memory-return",
      ...(opts.identity ?? ["owner-token", "boot-id"]),
    ],
    { timeout: 10_000 }
  );
  return { exitCode: result.exitCode, stdout: result.stdout.toString() };
}

async function fixture(): Promise<{ root: string; paths: Paths }> {
  const root = await mkdtemp(join(tmpdir(), "hack-guest-memory-"));
  const paths = {
    order: join(root, "order"),
    compact: join(root, "compact"),
    stat: join(root, "stat"),
    status: join(root, "status"),
    marker: join(root, "started"),
    owner: join(root, "owner"),
    boot: join(root, "boot"),
  };
  await writeFile(paths.owner, "owner-token\n");
  await writeFile(paths.boot, "boot-id\n");
  await writeFile(paths.order, "9\n");
  await writeFile(paths.compact, "");
  await writeFile(paths.stat, IDLE_STAT);
  return { root, paths };
}

test("a quiet guest reports smaller free blocks and compacts once", async () => {
  const { root, paths } = await fixture();
  try {
    const result = await run({ paths, quietTicks: 10 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "memory-return-v1 order=2 compaction=done windows=2\n"
    );
    expect(await readFile(paths.order, "utf8")).toBe("2\n");
    expect(await readFile(paths.compact, "utf8")).toBe("1\n");
    expect(await readFile(paths.status, "utf8")).toBe(result.stdout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a guest that never goes quiet is left alone after the bound, and says so", async () => {
  const { root, paths } = await fixture();
  try {
    // No window can have fewer than zero busy ticks, so no window counts as quiet.
    const result = await run({ paths, quietTicks: 0 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "memory-return-v1 order=2 compaction=gave-up windows=3\n"
    );
    expect(await readFile(paths.compact, "utf8")).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a kernel without either knob is not an error", async () => {
  const { root, paths } = await fixture();
  try {
    await rm(paths.order);
    await rm(paths.compact);
    const result = await run({ paths, quietTicks: 10 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "memory-return-v1 order=unavailable compaction=unavailable windows=0\n"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a refused write is recorded and does not fail the start", async () => {
  const { root, paths } = await fixture();
  try {
    // A directory passes the writable test and refuses the write.
    await rm(paths.order);
    await rm(paths.compact);
    await mkdir(paths.order);
    await mkdir(paths.compact);
    const result = await run({ paths, quietTicks: 10 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "memory-return-v1 order=refused compaction=refused windows=2\n"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unreadable CPU counters end the wait without compacting", async () => {
  const { root, paths } = await fixture();
  try {
    await rm(paths.stat);
    const result = await run({ paths, quietTicks: 10 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "memory-return-v1 order=2 compaction=unreadable windows=1\n"
    );
    expect(await readFile(paths.compact, "utf8")).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("another pool's guest or a later boot is left untouched", async () => {
  const { root, paths } = await fixture();
  try {
    for (const identity of [
      ["other-token", "boot-id"],
      ["owner-token", "later-boot"],
    ] as const) {
      const result = await run({ paths, quietTicks: 10, identity });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    }
    expect(await readFile(paths.order, "utf8")).toBe("9\n");
    expect(await readFile(paths.compact, "utf8")).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a second start in the same boot does nothing", async () => {
  const { root, paths } = await fixture();
  try {
    const first = await run({ paths, quietTicks: 10 });
    expect(first.stdout).toBe(
      "memory-return-v1 order=2 compaction=done windows=2\n"
    );
    await writeFile(paths.compact, "");
    const second = await run({ paths, quietTicks: 10 });
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toBe("");
    expect(await readFile(paths.compact, "utf8")).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
