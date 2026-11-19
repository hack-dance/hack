import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSyncBounded } from "./helpers/bounded-spawn-sync.ts";

const SCRIPT = "packages/runtime-core/src/provider/guest-memory-peak.sh";

const PRESSURE = [
  "some avg10=0.61 avg60=0.72 avg300=0.22 total=1075081",
  "full avg10=0.00 avg60=0.10 avg300=0.02 total=40211",
  "",
].join("\n");
const VMSTAT =
  "pgfault 99\noom_kill 0\npgmajfault 2065\nworkingset_refault 7\n";

function meminfo(totalKib: number, availableKib: number): string {
  return [
    `MemTotal:        ${totalKib} kB`,
    "MemFree:          833804 kB",
    `MemAvailable:    ${availableKib} kB`,
    "Buffers:           12345 kB",
    "",
  ].join("\n");
}

type Paths = {
  readonly meminfo: string;
  readonly pressure: string;
  readonly vmstat: string;
  readonly status: string;
  readonly marker: string;
  readonly owner: string;
  readonly boot: string;
  readonly between: string;
};

/**
 * Runs the guest script against stand-in files for `rounds` samples. In place of the
 * sleep between two samples it sources `between`, which a test may use to change the
 * stand-in counters.
 */
async function run(opts: {
  readonly paths: Paths;
  readonly rounds?: number;
  readonly identity?: readonly [string, string];
}): Promise<{ exitCode: number; stdout: string }> {
  // Every stand-in must replace exactly one place in the script. A target that is no
  // longer there would leave the script pointing at the real system file.
  const swaps: readonly (readonly [string, string])[] = [
    ["meminfo_file=/proc/meminfo", `meminfo_file=${opts.paths.meminfo}`],
    [
      "pressure_file=/proc/pressure/memory",
      `pressure_file=${opts.paths.pressure}`,
    ],
    ["vmstat_file=/proc/vmstat", `vmstat_file=${opts.paths.vmstat}`],
    [
      "status_file=/run/hack-local/memory-peak.status",
      `status_file=${opts.paths.status}`,
    ],
    [
      "marker_file=/run/hack-local/memory-peak.started",
      `marker_file=${opts.paths.marker}`,
    ],
    ["/storage/.hack-local-owner", opts.paths.owner],
    ["/proc/sys/kernel/random/boot_id", opts.paths.boot],
    ["max_rounds=0", `max_rounds=${opts.rounds ?? 3}`],
    ['sleep "$interval_seconds"', `. ${opts.paths.between}`],
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
      "guest-memory-peak",
      ...(opts.identity ?? ["owner-token", "boot-id"]),
    ],
    { timeout: 10_000 }
  );
  return { exitCode: result.exitCode, stdout: result.stdout.toString() };
}

async function fixture(): Promise<{ root: string; paths: Paths }> {
  const root = await mkdtemp(join(tmpdir(), "hack-guest-memory-peak-"));
  const paths = {
    meminfo: join(root, "meminfo"),
    pressure: join(root, "pressure"),
    vmstat: join(root, "vmstat"),
    status: join(root, "status"),
    marker: join(root, "started"),
    owner: join(root, "owner"),
    boot: join(root, "boot"),
    between: join(root, "between.sh"),
  };
  await writeFile(paths.owner, "owner-token\n");
  await writeFile(paths.boot, "boot-id\n");
  await writeFile(paths.meminfo, meminfo(6_087_220, 2_743_404));
  await writeFile(paths.pressure, PRESSURE);
  await writeFile(paths.vmstat, VMSTAT);
  await writeFile(paths.between, ":\n");
  return { root, paths };
}

test("the status line carries memory in use and the kernel's pressure counters", async () => {
  const { root, paths } = await fixture();
  try {
    const result = await run({ paths });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(await readFile(paths.status, "utf8")).toBe(
      "memory-peak-v1 peak_kib=3343816 samples=3 total_kib=6087220 some_us=1075081 full_us=40211 oom_kill=0 pgmajfault=2065\n"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the peak is the highest sample, and the counters are the latest", async () => {
  const { root, paths } = await fixture();
  try {
    // Sample 1 sees 1,000,000 KiB in use, sample 2 sees 5,000,000, sample 3 sees 2,000,000.
    await writeFile(paths.meminfo, meminfo(6_000_000, 5_000_000));
    await writeFile(`${paths.meminfo}.1`, meminfo(6_000_000, 1_000_000));
    await writeFile(`${paths.meminfo}.2`, meminfo(6_000_000, 4_000_000));
    await writeFile(`${paths.vmstat}.2`, "oom_kill 3\npgmajfault 9000\n");
    await writeFile(
      paths.between,
      [
        'if test -f "$meminfo_file.$rounds"; then cat "$meminfo_file.$rounds" > "$meminfo_file"; fi',
        'if test -f "$vmstat_file.$rounds"; then cat "$vmstat_file.$rounds" > "$vmstat_file"; fi',
        "",
      ].join("\n")
    );
    const result = await run({ paths });
    expect(result.exitCode).toBe(0);
    expect(await readFile(paths.status, "utf8")).toBe(
      "memory-peak-v1 peak_kib=5000000 samples=3 total_kib=6000000 some_us=1075081 full_us=40211 oom_kill=3 pgmajfault=9000\n"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("counters the kernel does not offer are recorded as unavailable", async () => {
  const { root, paths } = await fixture();
  try {
    await rm(paths.pressure);
    await rm(paths.vmstat);
    const result = await run({ paths });
    expect(result.exitCode).toBe(0);
    expect(await readFile(paths.status, "utf8")).toBe(
      "memory-peak-v1 peak_kib=3343816 samples=3 total_kib=6087220 some_us=unavailable full_us=unavailable oom_kill=unavailable pgmajfault=unavailable\n"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory figures that do not read as numbers count as no sample", async () => {
  const { root, paths } = await fixture();
  try {
    for (const content of [
      "garbage\n",
      "MemTotal: many kB\nMemAvailable: 5 kB\n",
      // Available above total is not a sample either.
      meminfo(1000, 2000),
    ]) {
      await rm(paths.marker, { force: true });
      await writeFile(paths.meminfo, content);
      const result = await run({ paths });
      expect(result.exitCode).toBe(0);
      expect(await readFile(paths.status, "utf8")).toStartWith(
        "memory-peak-v1 peak_kib=0 samples=0 "
      );
    }
    await rm(paths.marker);
    await rm(paths.meminfo);
    const result = await run({ paths });
    expect(result.exitCode).toBe(0);
    expect(await readFile(paths.status, "utf8")).toBe(
      "memory-peak-v1 peak_kib=0 samples=0 total_kib=unavailable some_us=1075081 full_us=40211 oom_kill=0 pgmajfault=2065\n"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a status file that cannot be written does not stop or fail the sampler", async () => {
  const { root, paths } = await fixture();
  try {
    await mkdir(paths.status);
    const result = await run({ paths });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
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
      const result = await run({ paths, identity });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    }
    expect(await Bun.file(paths.status).exists()).toBe(false);
    expect(await Bun.file(paths.marker).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a second start in the same boot does nothing", async () => {
  const { root, paths } = await fixture();
  try {
    await run({ paths });
    await writeFile(paths.status, "kept\n");
    const second = await run({ paths });
    expect(second.exitCode).toBe(0);
    expect(await readFile(paths.status, "utf8")).toBe("kept\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one sample starts no process but the sleep", async () => {
  const script = await Bun.file(SCRIPT).text();
  const loop = script.slice(script.indexOf("while :; do"));
  expect(loop.length).toBeGreaterThan(0);
  // Command substitution, pipes and subshells each start a process in the guest's shell.
  const code = loop
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
    .replaceAll("$((", "");
  expect(code).not.toContain("$(");
  expect(code).not.toContain("`");
  expect(code).not.toContain("|");
  expect(code).not.toMatch(/^\s*\(/m);
  const commands = code.match(/\b(awk|sed|grep|cat|cut|tr|mv|date)\b/g) ?? [];
  expect(commands).toEqual([]);
  expect(code.match(/\bsleep\b/g)?.length).toBe(1);
});
