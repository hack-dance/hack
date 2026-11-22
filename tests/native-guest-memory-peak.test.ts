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
  readonly page: string;
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
  readonly shell?: string;
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
    ["page_file=/proc/self/smaps", `page_file=${opts.paths.page}`],
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
      opts.shell ?? "sh",
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
    page: join(root, "smaps"),
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
  await writeFile(paths.page, smaps(4));
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

/** The start of `/proc/self/smaps` on a kernel with the given base page size. */
function smaps(pageKib: number | null): string {
  return [
    "aaaab0000000-aaaab00f0000 r-xp 00000000 fe:00 1234    /bin/busybox",
    "Size:                960 kB",
    ...(pageKib === null ? [] : [`KernelPageSize:       ${pageKib} kB`]),
    "MMUPageSize:           4 kB",
    "",
  ].join("\n");
}

const STEP_STAND_INS = [
  'if test -f "$meminfo_file.$rounds"; then cat "$meminfo_file.$rounds" > "$meminfo_file"; fi',
  'if test -f "$vmstat_file.$rounds"; then cat "$vmstat_file.$rounds" > "$vmstat_file"; fi',
  "",
].join("\n");

test("memory the provider's balloon holds is not counted as in use", async () => {
  const { root, paths } = await fixture();
  try {
    // An idle guest: 230,000 KiB in use. In the second sample the provider's balloon
    // holds 1,250,000 pages of 4 KiB, so the kernel reports 5,000,000 KiB less available.
    await writeFile(paths.meminfo, meminfo(6_000_000, 5_770_000));
    await writeFile(`${paths.meminfo}.1`, meminfo(6_000_000, 770_000));
    await writeFile(
      `${paths.vmstat}.1`,
      "nr_balloon_pages 1250000\nballoon_inflate 1250000\nballoon_deflate 0\noom_kill 0\npgmajfault 2065\n"
    );
    await writeFile(`${paths.meminfo}.2`, meminfo(6_000_000, 5_770_000));
    await writeFile(
      `${paths.vmstat}.2`,
      "nr_balloon_pages 0\nballoon_inflate 1250000\nballoon_deflate 1250000\noom_kill 0\npgmajfault 2065\n"
    );
    await writeFile(paths.between, STEP_STAND_INS);
    const result = await run({ paths });
    expect(result.exitCode).toBe(0);
    expect(await readFile(paths.status, "utf8")).toBe(
      "memory-peak-v1 peak_kib=230000 samples=3 total_kib=6000000 some_us=1075081 full_us=40211 oom_kill=0 pgmajfault=2065\n"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real use under an inflated balloon is still recorded", async () => {
  const { root, paths } = await fixture();
  try {
    // 3,000,000 KiB unavailable, of which the balloon holds 500,000 pages (2,000,000 KiB).
    await writeFile(paths.meminfo, meminfo(6_000_000, 3_000_000));
    await writeFile(paths.vmstat, "nr_balloon_pages 500000\noom_kill 0\n");
    const result = await run({ paths, rounds: 1 });
    expect(result.exitCode).toBe(0);
    expect(await readFile(paths.status, "utf8")).toContain(
      "peak_kib=1000000 samples=1 "
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the balloon is sized in the base pages the kernel itself reports", async () => {
  for (const pageKib of [4, 16, 64]) {
    const { root, paths } = await fixture();
    try {
      // 4,000,000 KiB unavailable; the balloon holds 10,000 base pages.
      await writeFile(paths.page, smaps(pageKib));
      await writeFile(paths.meminfo, meminfo(6_000_000, 2_000_000));
      await writeFile(paths.vmstat, "nr_balloon_pages 10000\n");
      const result = await run({ paths, rounds: 1 });
      expect(result.exitCode, String(pageKib)).toBe(0);
      expect(await readFile(paths.status, "utf8"), String(pageKib)).toContain(
        `peak_kib=${4_000_000 - 10_000 * pageKib} samples=1 `
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("on a kernel that does not report its page size, a sample under a balloon cannot raise the peak", async () => {
  for (const page of [smaps(null), smaps(8), null]) {
    const { root, paths } = await fixture();
    try {
      if (page === null) {
        await rm(paths.page);
      } else {
        await writeFile(paths.page, page);
      }
      // Sample 1: no balloon, 230,000 KiB in use. Sample 2: a balloon of unknown page size.
      // Sample 3: the balloon is gone again, 240,000 KiB in use.
      await writeFile(paths.meminfo, meminfo(6_000_000, 5_770_000));
      await writeFile(paths.vmstat, "nr_balloon_pages 0\noom_kill 0\n");
      await writeFile(`${paths.meminfo}.1`, meminfo(6_000_000, 770_000));
      await writeFile(`${paths.vmstat}.1`, "nr_balloon_pages 1250000\n");
      await writeFile(`${paths.meminfo}.2`, meminfo(6_000_000, 5_760_000));
      await writeFile(`${paths.vmstat}.2`, "nr_balloon_pages 0\n");
      await writeFile(paths.between, STEP_STAND_INS);
      const result = await run({ paths });
      expect(result.exitCode).toBe(0);
      expect(await readFile(paths.status, "utf8")).toContain(
        "peak_kib=240000 samples=3 "
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("when no sample can be corrected, the pressure counters are still recorded", async () => {
  const { root, paths } = await fixture();
  try {
    // No page size, and the balloon holds something at every sample: the peak stays 0,
    // but the samples are counted so the reading, and its OOM kill, are kept.
    await rm(paths.page);
    await writeFile(paths.meminfo, meminfo(6_000_000, 770_000));
    await writeFile(
      paths.vmstat,
      "nr_balloon_pages 1000\noom_kill 1\npgmajfault 9\n"
    );
    const result = await run({ paths });
    expect(result.exitCode).toBe(0);
    expect(await readFile(paths.status, "utf8")).toBe(
      "memory-peak-v1 peak_kib=0 samples=3 total_kib=6000000 some_us=1075081 full_us=40211 oom_kill=1 pgmajfault=9\n"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a kernel with only the balloon's event counters is corrected from their difference", async () => {
  const { root, paths } = await fixture();
  try {
    await writeFile(paths.meminfo, meminfo(6_000_000, 1_000_000));
    await writeFile(
      paths.vmstat,
      "balloon_inflate 1300000\nballoon_deflate 100000\noom_kill 0\n"
    );
    const result = await run({ paths, rounds: 1 });
    expect(result.exitCode).toBe(0);
    // 5,000,000 KiB unavailable less 1,200,000 pages of 4 KiB.
    expect(await readFile(paths.status, "utf8")).toContain(
      "peak_kib=200000 samples=1 "
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a balloon reading that cannot be right never breaks the figure or the sampler", async () => {
  const cases: readonly (readonly [string, number])[] = [
    // Larger than everything unavailable: the sample counts as nothing in use.
    ["nr_balloon_pages 9000000\n", 0],
    // Not a number, and no event counters: no correction.
    ["nr_balloon_pages lots\n", 4_000_000],
    // Deflated more than inflated: no correction.
    ["balloon_inflate 5\nballoon_deflate 9\n", 4_000_000],
    // No balloon in this kernel at all.
    ["oom_kill 0\n", 4_000_000],
    // Leading zeros, which shell arithmetic would read as octal: 8 pages of 4 KiB.
    ["nr_balloon_pages 08\n", 3_999_968],
    ["nr_balloon_pages 000\n", 4_000_000],
    // A count that would overflow when multiplied: refused, no correction.
    ["nr_balloon_pages 4611686018427387903\n", 4_000_000],
    ["balloon_inflate 4611686018427387903\nballoon_deflate 0\n", 4_000_000],
  ];
  for (const shell of ["sh", "dash", "bash"].filter(
    (name) => Bun.which(name) !== null
  )) {
    for (const [vmstat, expected] of cases) {
      const { root, paths } = await fixture();
      try {
        await writeFile(paths.meminfo, meminfo(6_000_000, 2_000_000));
        await writeFile(paths.vmstat, vmstat);
        const result = await run({ paths, rounds: 2, shell });
        expect(result.exitCode, `${shell} ${vmstat}`).toBe(0);
        // Two samples: a sampler that died on the first would have written one or none.
        expect(
          await readFile(paths.status, "utf8"),
          `${shell} ${vmstat}`
        ).toContain(`peak_kib=${expected} samples=2 `);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }
});

test("a balloon that moves during one sample is subtracted at its larger reading", async () => {
  // One sample opens, in this order: the vmstat stand-in (balloon before), the memory
  // figures, vmstat again (balloon after), the pressure counters, and vmstat a third time.
  // Named pipes stand in for all three files and one writer feeds them in that order.
  // Each of its writes blocks until the sampler opens that pipe, and the sampler opens the
  // next pipe only after it has read the one before to its end, so every read gets
  // exactly the contents meant for it without any timing.
  const growing = ["nr_balloon_pages 0\n", "nr_balloon_pages 1000000\n"];
  const shrinking = ["nr_balloon_pages 1000000\n", "nr_balloon_pages 0\n"];
  for (const [before, after] of [growing, shrinking]) {
    const { root, paths } = await fixture();
    let writer: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const feeds: readonly (readonly [string, string])[] = [
        [paths.vmstat, before],
        // 5,000,000 KiB unavailable; at its larger reading the balloon holds 4,000,000.
        [paths.meminfo, meminfo(6_000_000, 1_000_000)],
        [paths.vmstat, after],
        [paths.pressure, PRESSURE],
        [paths.vmstat, "oom_kill 0\npgmajfault 7\n"],
      ];
      for (const pipe of [paths.vmstat, paths.meminfo, paths.pressure]) {
        await rm(pipe);
        expect(spawnSyncBounded(["mkfifo", pipe]).exitCode).toBe(0);
      }
      // The writer is one shell that runs only builtins. Each redirection is opened by
      // that shell itself, so a blocked open is in that one process, it has no child,
      // and killing it is a complete cleanup. Contents and pipes are its arguments.
      const steps = feeds.map((_, index) => {
        const text = `\${${2 * index + 1}}`;
        const pipe = `\${${2 * index + 2}}`;
        return `{ printf '%s' "${text}"; } > "${pipe}"`;
      });
      writer = Bun.spawn(
        [
          "sh",
          "-c",
          steps.join(" && "),
          "feed",
          ...feeds.flatMap(([pipe, text]) => [text, pipe]),
        ],
        { stdout: "ignore", stderr: "ignore" }
      );
      const result = await run({ paths, rounds: 1 });
      expect(result.exitCode, before).toBe(0);
      const fed = await Promise.race([
        writer.exited,
        new Promise<"late">((resolve) =>
          setTimeout(() => resolve("late"), 5000)
        ),
      ]);
      expect(fed, before).toBe(0);
      expect(await readFile(paths.status, "utf8"), before).toBe(
        "memory-peak-v1 peak_kib=1000000 samples=1 total_kib=6000000 some_us=1075081 full_us=40211 oom_kill=0 pgmajfault=7\n"
      );
    } finally {
      // A sampler that stopped early leaves the writer blocked on a pipe nobody opens.
      // The writer has no child process (see above), so this ends all it started.
      writer?.kill("SIGKILL");
      await writer?.exited;
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("the first balloon reading is taken before the memory figures are opened", async () => {
  const script = await Bun.file(SCRIPT).text();
  const loop = script.slice(script.indexOf("while :; do"));
  const before = loop.indexOf("read_balloon\n  balloon_before=$balloon");
  const opened = loop.indexOf('if test -r "$meminfo_file"; then');
  const closed = loop.indexOf('done < "$meminfo_file"');
  const after = loop.indexOf("read_balloon", closed);
  expect(before).toBe(loop.indexOf("\n") + 3);
  expect(opened).toBeGreaterThan(before);
  expect(closed).toBeGreaterThan(opened);
  expect(after).toBeGreaterThan(closed);
  expect(loop.split("read_balloon").length).toBe(3);
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

test("every POSIX shell on this host gives the same status line", async () => {
  // The guest runs BusyBox ash. Of the shells a host may have, dash is the closest and
  // the strictest; bash and the platform's sh are run as well when present.
  const shells = ["sh", "dash", "bash"].filter(
    (name) => Bun.which(name) !== null
  );
  expect(shells).toContain("sh");
  for (const shell of shells) {
    const { root, paths } = await fixture();
    try {
      const result = await run({ paths, shell });
      expect(result.exitCode, shell).toBe(0);
      expect(await readFile(paths.status, "utf8"), shell).toBe(
        "memory-peak-v1 peak_kib=3343816 samples=3 total_kib=6087220 some_us=1075081 full_us=40211 oom_kill=0 pgmajfault=2065\n"
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

// Shell syntax, builtins of the guest's shell, the script's own functions, and `sleep`.
const ALLOWED_COMMANDS = new Set([
  "while",
  "do",
  "done",
  "if",
  "then",
  "fi",
  "case",
  "esac",
  "test",
  "read",
  "break",
  "exit",
  "printf",
  "check",
  "count",
  "read_balloon",
  "sleep",
  ":",
  "{",
  "}",
]);
// Words that introduce a command without being one.
const LEADING_KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "while",
  "do",
  "{",
  "!",
]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const CASE_PATTERN = /^[A-Za-z_:' |*!?[\]0-9-]*\)\s*/;

/**
 * Every command word the shell would run in `code`: the first word of each simple
 * command, after any `NAME=value` prefixes and any leading keyword. Lines continued
 * with a backslash or a trailing `&&` are read as one line.
 */
function commandWords(code: string): string[] {
  const logical: string[] = [];
  let pending = "";
  // An arithmetic expansion is a value, not a command.
  for (const raw of code.replaceAll(/\$\(\([^()]*\)\)/g, "0").split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#")) {
      continue;
    }
    if (line.endsWith("\\")) {
      pending += `${line.slice(0, -1)} `;
      continue;
    }
    if (line.endsWith("&&")) {
      pending += `${line} `;
      continue;
    }
    logical.push(pending + line);
    pending = "";
  }
  logical.push(pending);
  const words: string[] = [];
  for (const line of logical) {
    for (const part of line
      .replace(CASE_PATTERN, "")
      .split(/;;|;|&&|\|\||\||&/)) {
      const tokens = part
        .trim()
        .split(/\s+/)
        .filter((token) => token !== "");
      // Keep each keyword, then look past it and past assignment prefixes for the command.
      while (tokens.length > 0) {
        const word = tokens[0] ?? "";
        if (LEADING_KEYWORDS.has(word)) {
          words.push(word);
          tokens.shift();
        } else if (ASSIGNMENT.test(word)) {
          tokens.shift();
        } else {
          words.push(word);
          break;
        }
      }
    }
  }
  return words;
}

function notAllowed(code: string): string[] {
  return commandWords(code).filter((word) => !ALLOWED_COMMANDS.has(word));
}

/**
 * What in `code` would start a process in the guest's shell besides a named command:
 * command substitution, a pipe, a subshell or a background job.
 */
function processStarters(code: string): string[] {
  // A `|` between the patterns of a case arm is not a pipe.
  const text = code
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .map((line) => line.trimStart().replace(CASE_PATTERN, ""))
    .join("\n")
    .replaceAll("$((", "");
  const found: string[] = [];
  if (text.includes("$(")) {
    found.push("command substitution");
  }
  if (text.includes("`")) {
    found.push("backquotes");
  }
  if (text.includes("|")) {
    found.push("pipe");
  }
  if (/^\(/m.test(text)) {
    found.push("subshell");
  }
  if (text.replaceAll("&&", "").includes("&")) {
    found.push("background job");
  }
  return found;
}

/** The body of one of the script's own functions, without its first and last line. */
function functionBody(script: string, name: string): string {
  const start = script.indexOf(`${name}() {`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const whole = script.slice(start, script.indexOf("\n}\n", start));
  return whole.slice(whole.indexOf("\n"));
}

test("one sample runs shell builtins only, and one sleep", async () => {
  const script = await Bun.file(SCRIPT).text();
  const loop = script.slice(script.indexOf("while :; do"));
  expect(loop.length).toBeGreaterThan(0);
  expect(processStarters(loop)).toEqual([]);

  const commands = commandWords(loop);
  expect(commands.length).toBeGreaterThan(40);
  expect(notAllowed(loop)).toEqual([]);
  expect(commands.filter((word) => word === "sleep").length).toBe(1);

  // The loop calls the script's own functions on every sample: the same rules hold in each.
  for (const name of ["check", "count", "read_balloon"]) {
    const body = functionBody(script, name);
    expect(body.trim().length, name).toBeGreaterThan(0);
    expect(processStarters(body), name).toEqual([]);
    expect(notAllowed(body), name).toEqual([]);
    expect(commandWords(body).includes("sleep"), name).toBe(false);
  }
  // Every function the loop calls is one of those three.
  const called = commands.filter((word) => script.includes(`\n${word}() {`));
  expect([...new Set(called)].sort()).toEqual(["check", "read_balloon"]);
  expect(commandWords(functionBody(script, "read_balloon"))).toContain("count");
  expect(commandWords(functionBody(script, "count"))).toContain("check");
});

test("the process check sees a substitution, a pipe, a subshell and a background job", () => {
  expect(processStarters('counted=$(printf "%s" "$counted")')).toEqual([
    "command substitution",
  ]);
  expect(processStarters("counted=`cat /proc/uptime`")).toEqual(["backquotes"]);
  expect(processStarters("read -r a < /proc/uptime | :")).toEqual(["pipe"]);
  expect(processStarters("  (cd /; :)")).toEqual(["subshell"]);
  expect(processStarters(": & :")).toEqual(["background job"]);
  // Arithmetic, `&&` and a commented substitution are not processes.
  expect(
    processStarters("used=$((total - available))\ntest 1 = 1 && :\n# $(date)")
  ).toEqual([]);
});

test("the builtins check sees a command behind a prefix, a keyword or a continuation", () => {
  const planted: readonly (readonly [string, string])[] = [
    ["  head -1 /proc/uptime > /dev/null", "head"],
    ["  sample_probe=1 head /proc/meminfo", "head"],
    ["  test 1 = 1 &&\n    head /proc/meminfo", "head"],
    ["  if grep -q x /proc/meminfo; then :; fi", "grep"],
    ["  while cat /proc/uptime; do break; done", "cat"],
    ["  printf x \\\n    > /dev/null; awk 1 /proc/uptime", "awk"],
    ["  a=1 b=2 date", "date"],
    ["  : & head /proc/meminfo", "head"],
    ["  MemTotal:) total=$value; cut -c1 /proc/uptime ;;", "cut"],
  ];
  for (const [line, command] of planted) {
    expect(notAllowed(`while :; do\n${line}\ndone`), line).toEqual([command]);
  }
  // Assignments, keywords and builtins alone are not reported.
  expect(
    notAllowed(
      'while :; do\n  total=\n  if test "$a" -gt 1 &&\n    test "$b" -gt 2; then\n    a=$b\n  fi\ndone'
    )
  ).toEqual([]);
});
