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

test("on a kernel that does not report its page size, a sample under a balloon is not used", async () => {
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
        "peak_kib=240000 samples=2 "
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
  // The balloon is read before and after the memory figures. A named pipe stands in for
  // /proc/vmstat so each of the sample's three reads can be given different contents:
  // before the memory figures, after them, and the read for the other counters.
  const growing = ["nr_balloon_pages 0\n", "nr_balloon_pages 1000000\n"];
  const shrinking = ["nr_balloon_pages 1000000\n", "nr_balloon_pages 0\n"];
  for (const [before, after] of [growing, shrinking]) {
    const { root, paths } = await fixture();
    const feeds = [before, after, "oom_kill 0\npgmajfault 7\n"];
    try {
      await rm(paths.vmstat);
      expect(spawnSyncBounded(["mkfifo", paths.vmstat]).exitCode).toBe(0);
      for (const [index, text] of feeds.entries()) {
        await writeFile(join(root, `feed.${index}`), text);
      }
      // Each write blocks until the script opens the pipe; the pause lets the script
      // close it before the next contents are offered.
      const writer = Bun.spawn(
        [
          "sh",
          "-c",
          'for n in 0 1 2; do cat "$1/feed.$n" > "$2"; sleep 0.3; done',
          "feed",
          root,
          paths.vmstat,
        ],
        { stdout: "ignore", stderr: "ignore" }
      );
      // 5,000,000 KiB unavailable; at its larger reading the balloon holds 4,000,000 KiB.
      await writeFile(paths.meminfo, meminfo(6_000_000, 1_000_000));
      const result = await run({ paths, rounds: 1 });
      await writer.exited;
      expect(result.exitCode, before).toBe(0);
      expect(await readFile(paths.status, "utf8"), before).toBe(
        "memory-peak-v1 peak_kib=1000000 samples=1 total_kib=6000000 some_us=1075081 full_us=40211 oom_kill=0 pgmajfault=7\n"
      );
    } finally {
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
const CASE_PATTERN = /^[A-Za-z_:' |*![\]0-9-]*\)\s*/;

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

test("one sample runs shell builtins only, and one sleep", async () => {
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
  // A background job is a process too.
  expect(code.replaceAll("&&", "")).not.toContain("&");

  const commands = commandWords(loop);
  expect(commands.length).toBeGreaterThan(40);
  expect(notAllowed(loop)).toEqual([]);
  expect(commands.filter((word) => word === "sleep").length).toBe(1);

  // The loop calls `read_balloon` twice a sample: the same rules hold inside it.
  const start = script.indexOf("read_balloon() {");
  expect(start).toBeGreaterThanOrEqual(0);
  const body = script.slice(start, script.indexOf("\n}\n", start));
  const bodyCode = body
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
    .replaceAll("$((", "");
  expect(bodyCode).not.toContain("$(");
  expect(bodyCode).not.toContain("`");
  expect(bodyCode).not.toContain("|");
  expect(bodyCode.replaceAll("&&", "")).not.toContain("&");
  expect(notAllowed(body.slice(body.indexOf("\n")))).toEqual([]);
  expect(commandWords(body).includes("sleep")).toBe(false);
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
