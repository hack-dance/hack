#!/usr/bin/env bun
/**
 * End-to-end baseline for the costs a developer pays in daily use: CLI start
 * and read commands, the candidate launcher, `up`/`down` against raw
 * `docker compose`, and hackd's idle and `/v1/projects` cost.
 *
 * Usage: bun scripts/benchmark-cli-latency.ts [--hack PATH] [--launcher PATH]
 *          [--runs N] [--cold-runs N] [--lifecycle-runs N] [--idle-seconds S]
 *          [--image REF] [--env KEY=VALUE]... [--skip-docker] [--skip-daemon]
 *          [--out FILE]
 *   --hack            executable to measure (default ./dist/hack; build first)
 *   --launcher        an installed channel launcher (`<root>/bin/hack-next`).
 *                     Its selected bundle's `hack-cli` is timed directly, then
 *                     through `hack-v5` and through the launcher (`--version`
 *                     only, so nothing is written to that installation).
 *   --runs            warm samples per command (default 10)
 *   --cold-runs       cold samples per command (default 3)
 *   --lifecycle-runs  up/no-op/down trials per side (default 5)
 *   --idle-seconds    idle sampling window for hackd and `mcp serve` (default 60)
 *   --image           image for the fixture services; it must already be local,
 *                     the script never pulls (default alpine:3.20)
 *   --env             extra variable for every measured Hack process
 *   --out             write the full JSON report (raw samples) to FILE
 *
 * Measurement boundary. Every Hack process runs with a private HOME under a
 * fresh 0700 directory in /tmp and never autostarts a daemon. The Docker
 * engine is the host's real one: the script resolves its endpoint once and
 * passes it as DOCKER_HOST, owns only the Compose projects it names
 * (`hkperf-<id>`), and on exit, an error or SIGINT/SIGTERM it waits for the
 * commands in flight, runs `docker compose down` for both projects by name
 * and removes its directory. Only a local unix-socket engine is used: a TLS
 * or SSH endpoint needs client settings a private config does not carry, so
 * the Docker sections are skipped there. Other containers on the engine are
 * counted in the report because they add to Docker list and inspect time.
 *
 * "Cold" is the first run of a fresh copy of the executable against a fresh
 * HOME: first-use Hack state, plus whatever the OS does for a file it has not
 * run before. It is not a cold-disk number: the page cache is not dropped,
 * the copy itself leaves the file cached on Linux, and on APFS the copy is a
 * clone. "Warm" samples run round-robin across commands so drift spreads
 * evenly. Lifecycle trials alternate which side runs first. p95 is printed
 * only from 20 samples up; below that it would just repeat the maximum.
 *
 * Idle CPU is the growth in cumulative CPU seconds of the processes that
 * are in the tree at both ends of the window. A process that starts or exits
 * inside the window is not counted (the report says how many exited), so the
 * figure is a lower bound. Idle memory is the tree's summed RSS (resident
 * pages, shared pages included), not footprint. The per-command RSS column is
 * the largest single process the command waited for, not a tree total, so
 * do not compare it between `hack` and `docker compose` rows.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import {
  arch,
  cpus,
  homedir,
  loadavg,
  platform,
  release,
  totalmem,
} from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

type Env = Record<string, string>;

type Sample = {
  readonly wallMs: number;
  /** Null where no child process was measured (an in-process request). */
  readonly cpuMs: number | null;
  readonly maxRssKb: number | null;
};

type Summary = {
  readonly label: string;
  readonly n: number;
  readonly failures: number;
  readonly medianMs: number | null;
  readonly minMs: number | null;
  readonly p95Ms: number | null;
  readonly maxMs: number | null;
  readonly medianCpuMs: number | null;
  readonly medianMaxRssMb: number | null;
  readonly samplesMs: readonly number[];
};

type RunResult = {
  readonly sample: Sample;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

type Command = {
  readonly label: string;
  readonly args: readonly string[];
  /** Confirms the output is the intended result before its time counts. */
  readonly accept: (stdout: string) => boolean;
};

type IdleReport = {
  readonly label: string;
  readonly windowSeconds: number;
  readonly cpuSeconds: number;
  readonly cpuPercentOfOneCore: number;
  readonly rssMedianMb: number;
  readonly rssMaxMb: number;
  readonly processes: number;
  /** Processes in the tree at the start that were gone at the end. */
  readonly exitedDuringWindow: number;
};

const SERVICES = ["web", "api", "worker"] as const;
const COMMAND_TIMEOUT_MS = 180_000;
/** Below this many samples a 95th percentile is the maximum under another name. */
const P95_MIN_SAMPLES = 20;

/** Thrown in place of a spawn once a signal or cleanup has begun. */
class Interrupted extends Error {}

/** Set by a signal and by cleanup: no measured process may start after it. */
let stopping = false;
/** Every `run` child still alive, so cleanup can wait for it. */
const inflight = new Set<{ readonly exited: Promise<number> }>();

function quantile(sorted: readonly number[], q: number): number {
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(q * sorted.length) - 1)
  );
  return sorted[index] ?? Number.NaN;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? Number.NaN;
  if (sorted.length % 2 === 1) {
    return upper;
  }
  return ((sorted[middle - 1] ?? Number.NaN) + upper) / 2;
}

function round(value: number | null, digits = 1): number | null {
  if (value === null) {
    return null;
  }
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function summarize(
  label: string,
  samples: readonly Sample[],
  failures: number
): Summary {
  const wall = samples.map((sample) => sample.wallMs).sort((a, b) => a - b);
  const has = wall.length > 0;
  return {
    label,
    n: wall.length,
    failures,
    medianMs: round(median(wall)),
    minMs: has ? round(wall[0] ?? null) : null,
    p95Ms: wall.length >= P95_MIN_SAMPLES ? round(quantile(wall, 0.95)) : null,
    maxMs: has ? round(wall.at(-1) ?? null) : null,
    medianCpuMs: round(
      median(
        samples.flatMap((sample) =>
          sample.cpuMs === null ? [] : [sample.cpuMs]
        )
      )
    ),
    medianMaxRssMb: round(
      median(
        samples.flatMap((sample) =>
          sample.maxRssKb === null ? [] : [sample.maxRssKb / 1024]
        )
      )
    ),
    samplesMs: wall.map((value) => round(value) ?? Number.NaN),
  };
}

async function run(opts: {
  readonly argv: readonly string[];
  readonly env: Env;
  readonly cwd: string;
  /** Cleanup's own commands run after `stopping` is set. */
  readonly duringCleanup?: boolean;
}): Promise<RunResult> {
  if (stopping && opts.duringCleanup !== true) {
    throw new Interrupted("interrupted");
  }
  const started = performance.now();
  const child = Bun.spawn([...opts.argv], {
    cwd: opts.cwd,
    env: opts.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: COMMAND_TIMEOUT_MS,
  });
  inflight.add(child);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]).finally(() => inflight.delete(child));
  const wallMs = performance.now() - started;
  const usage = child.resourceUsage();
  const cpuMicros = usage
    ? Number(usage.cpuTime.user) + Number(usage.cpuTime.system)
    : 0;
  // Bun reports maxRSS in bytes (checked on Linux; not yet on macOS).
  const maxRssKb = usage ? Number(usage.maxRSS) / 1024 : 0;
  return {
    sample: { wallMs, cpuMs: cpuMicros / 1000, maxRssKb },
    exitCode,
    stdout,
    stderr,
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function composeYaml(name: string, image: string): string {
  const lines = [`name: ${name}`, "services:"];
  for (const service of SERVICES) {
    lines.push(
      `  ${service}:`,
      `    image: ${image}`,
      "    pull_policy: never",
      "    init: true",
      "    stop_grace_period: 1s",
      `    command: sh -c 'i=0; while [ $$i -lt 60 ]; do echo ${service} line $$i; i=$$((i+1)); done; exec sleep 2147483647'`
    );
  }
  return `${lines.join("\n")}\n`;
}

/** A Hack project with three idle services and one plaintext env value. */
function writeProject(opts: {
  readonly root: string;
  readonly name: string;
  readonly image: string;
}): string {
  const directory = join(opts.root, opts.name);
  const hackDir = join(directory, ".hack");
  mkdirSync(hackDir, { recursive: true });
  writeFileSync(
    join(hackDir, "hack.config.json"),
    `${JSON.stringify(
      {
        name: opts.name,
        dev_host: `${opts.name}.hack`,
        logs: {
          follow_backend: "compose",
          snapshot_backend: "compose",
          clear_on_down: false,
        },
        internal: { dns: false, tls: false },
        oauth: { enabled: false, tld: "gy" },
        open: { prefer: "auto" },
      },
      null,
      2
    )}\n`
  );
  writeFileSync(
    join(hackDir, "docker-compose.yml"),
    composeYaml(opts.name, opts.image)
  );
  writeFileSync(
    join(hackDir, "hack.env.default.yaml"),
    [
      "version: 1",
      "environment: default",
      "secretsprovider: project_key",
      "values:",
      "  global:",
      "    PERF_PLAIN: plain-value",
      "",
    ].join("\n")
  );
  return directory;
}

/** The engine endpoint the caller's own Docker client would use. */
function resolveDockerHost(): string | null {
  if (process.env.DOCKER_HOST) {
    return process.env.DOCKER_HOST;
  }
  const result = Bun.spawnSync(
    ["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
    { stdout: "pipe", stderr: "ignore", timeout: 15_000 }
  );
  const host = result.stdout.toString().trim();
  return result.exitCode === 0 && host.length > 0 ? host : null;
}

function dockerText(env: Env, args: readonly string[]): string | null {
  const result = Bun.spawnSync(["docker", ...args], {
    env,
    stdout: "pipe",
    stderr: "ignore",
    timeout: 30_000,
  });
  return result.exitCode === 0 ? result.stdout.toString().trim() : null;
}

function runningContainers(env: Env, project: string): number {
  const text = dockerText(env, [
    "ps",
    "-q",
    "--filter",
    `label=com.docker.compose.project=${project}`,
  ]);
  return text === null ? -1 : text.split("\n").filter(Boolean).length;
}

function allContainers(env: Env, project: string): number {
  const text = dockerText(env, [
    "ps",
    "-aq",
    "--filter",
    `label=com.docker.compose.project=${project}`,
  ]);
  return text === null ? -1 : text.split("\n").filter(Boolean).length;
}

function ownedNetworks(env: Env, project: string): number {
  const text = dockerText(env, [
    "network",
    "ls",
    "-q",
    "--filter",
    `label=com.docker.compose.project=${project}`,
  ]);
  return text === null ? -1 : text.split("\n").filter(Boolean).length;
}

type ProcessRow = {
  readonly pid: number;
  readonly ppid: number;
  readonly rssKb: number;
  readonly cpuSeconds: number;
};

function parseCpuTime(text: string): number {
  // `ps` cumulative CPU: [[DD-]HH:]MM:SS[.cc]
  const [days, rest] = text.includes("-")
    ? (text.split("-") as [string, string])
    : ["0", text];
  let seconds = 0;
  for (const part of rest.split(":")) {
    seconds = seconds * 60 + Number(part);
  }
  return Number(days) * 86_400 + seconds;
}

function linuxCpuSeconds(pid: number, ticksPerSecond: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return (Number(fields[11]) + Number(fields[12])) / ticksPerSecond;
  } catch {
    return null;
  }
}

/** One process and all of its descendants, from a single `ps` listing. */
function processTree(rootPid: number, ticksPerSecond: number): ProcessRow[] {
  const result = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid=,rss=,time="], {
    stdout: "pipe",
    stderr: "ignore",
    timeout: 15_000,
  });
  const rows = new Map<number, ProcessRow>();
  for (const line of result.stdout.toString().split("\n")) {
    const [pid, ppid, rss, time] = line.trim().split(/\s+/);
    if (!(pid && ppid && rss && time)) {
      continue;
    }
    rows.set(Number(pid), {
      pid: Number(pid),
      ppid: Number(ppid),
      rssKb: Number(rss),
      cpuSeconds: parseCpuTime(time),
    });
  }
  const tree: ProcessRow[] = [];
  const pending = [rootPid];
  while (pending.length > 0) {
    const pid = pending.pop() as number;
    const row = rows.get(pid);
    if (!row) {
      continue;
    }
    // Linux `ps` rounds CPU to whole seconds; /proc has clock-tick precision.
    const precise =
      platform() === "linux" ? linuxCpuSeconds(pid, ticksPerSecond) : null;
    tree.push(precise === null ? row : { ...row, cpuSeconds: precise });
    for (const candidate of rows.values()) {
      if (candidate.ppid === pid) {
        pending.push(candidate.pid);
      }
    }
  }
  return tree;
}

function clockTicks(): number {
  const result = Bun.spawnSync(["getconf", "CLK_TCK"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const ticks = Number(result.stdout.toString().trim());
  return Number.isFinite(ticks) && ticks > 0 ? ticks : 100;
}

async function sampleIdle(opts: {
  readonly targets: readonly { readonly label: string; readonly pid: number }[];
  readonly seconds: number;
}): Promise<IdleReport[]> {
  const ticks = clockTicks();
  const total = (rows: readonly ProcessRow[], key: "cpuSeconds" | "rssKb") =>
    rows.reduce((sum, row) => sum + row[key], 0);
  const first = opts.targets.map((target) => processTree(target.pid, ticks));
  const rss: number[][] = opts.targets.map(() => []);
  const started = performance.now();
  const intervalMs = Math.min(5000, (opts.seconds * 1000) / 4);
  let last = first;
  while (performance.now() - started < opts.seconds * 1000) {
    await Bun.sleep(intervalMs);
    last = opts.targets.map((target) => processTree(target.pid, ticks));
    for (const [index, rows] of last.entries()) {
      rss[index]?.push(total(rows, "rssKb") / 1024);
    }
  }
  const windowSeconds = (performance.now() - started) / 1000;
  return opts.targets.map((target, index) => {
    const before = new Map(
      (first[index] ?? []).map((row) => [row.pid, row.cpuSeconds])
    );
    const after = last[index] ?? [];
    // Only processes present at both ends: one that exited would otherwise
    // subtract all the CPU it had used before the window.
    let cpuSeconds = 0;
    let survivors = 0;
    for (const row of after) {
      const earlier = before.get(row.pid);
      if (earlier !== undefined) {
        cpuSeconds += row.cpuSeconds - earlier;
        survivors += 1;
      }
    }
    const values = rss[index] ?? [];
    return {
      label: target.label,
      windowSeconds: round(windowSeconds) ?? 0,
      cpuSeconds: round(cpuSeconds, 2) ?? 0,
      cpuPercentOfOneCore: round((cpuSeconds / windowSeconds) * 100, 2) ?? 0,
      rssMedianMb: round(median(values)) ?? 0,
      rssMaxMb: round(Math.max(0, ...values)) ?? 0,
      processes: after.length,
      exitedDuringWindow: before.size - survivors,
    };
  });
}

function formatMs(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(1);
}

function table(headers: readonly string[], rows: readonly string[][]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function latencyTable(summaries: readonly Summary[]): string {
  return table(
    [
      "measurement",
      "n",
      "median ms",
      "min",
      "p95",
      "max",
      "cpu ms",
      "max single-process RSS MB",
      "failed",
    ],
    summaries.map((summary) => [
      summary.label,
      String(summary.n),
      formatMs(summary.medianMs),
      formatMs(summary.minMs),
      formatMs(summary.p95Ms),
      formatMs(summary.maxMs),
      formatMs(summary.medianCpuMs),
      formatMs(summary.medianMaxRssMb),
      String(summary.failures),
    ])
  );
}

const { values: flags } = parseArgs({
  options: {
    hack: { type: "string" },
    launcher: { type: "string" },
    runs: { type: "string", default: "10" },
    "cold-runs": { type: "string", default: "3" },
    "lifecycle-runs": { type: "string", default: "5" },
    "idle-seconds": { type: "string", default: "60" },
    image: { type: "string", default: "alpine:3.20" },
    env: { type: "string", multiple: true, default: [] },
    "skip-docker": { type: "boolean", default: false },
    "skip-daemon": { type: "boolean", default: false },
    out: { type: "string" },
  },
});

function positive(name: string, text: string): number {
  const value = Number(text);
  if (!(Number.isInteger(value) && value > 0)) {
    throw new Error(`--${name} must be a positive integer.`);
  }
  return value;
}

const repoRoot = resolve(import.meta.dir, "..");
const hack = resolve(flags.hack ?? join(repoRoot, "dist/hack"));
if (!existsSync(hack)) {
  throw new Error(
    `No executable at ${hack}; run bun run build or pass --hack.`
  );
}
const runs = positive("runs", flags.runs);
const coldRuns = positive("cold-runs", flags["cold-runs"]);
const lifecycleRuns = positive("lifecycle-runs", flags["lifecycle-runs"]);
const idleSeconds = positive("idle-seconds", flags["idle-seconds"]);
const image = flags.image;

const extraEnv: Env = {};
for (const pair of flags.env) {
  const split = pair.indexOf("=");
  if (split <= 0) {
    throw new Error(`--env expects KEY=VALUE, got ${pair}`);
  }
  extraEnv[pair.slice(0, split)] = pair.slice(split + 1);
}

type LauncherPlan = {
  readonly launcher: string;
  readonly selected: string;
  readonly bundle: string;
};

/**
 * Resolves an installed channel from its launcher before any work starts, so
 * a wrong path costs nothing and cannot lose the report. Returns the reason
 * as text when the path is not a usable launcher.
 */
function planLauncher(path: string): LauncherPlan | string {
  try {
    // The launcher may be reached through a symlink on PATH.
    const launcher = realpathSync(path);
    const channel = dirname(dirname(launcher));
    const selected = record(
      parseJson(readFileSync(join(channel, ".selection.json"), "utf8"))
    )?.selected;
    if (typeof selected !== "string") {
      return "The launcher has no selected candidate; launcher timing skipped.";
    }
    const bundle = join(channel, "versions", selected, "bundle");
    if (
      !(
        existsSync(join(bundle, "hack-cli")) &&
        existsSync(join(bundle, "hack-v5"))
      )
    ) {
      return "The selected candidate has no hack-cli and hack-v5; launcher timing skipped.";
    }
    return { launcher, selected, bundle };
  } catch {
    return "--launcher is not a channel launcher (no readable <root>/.selection.json beside its bin directory); launcher timing skipped.";
  }
}

const launcherPlan = flags.launcher ? planLauncher(flags.launcher) : null;
const notes: string[] = [];
const report: Record<string, unknown> = {};
const sections: string[] = [];
let failed = false;
let signalExit: number | null = null;

// Everything above only validates input. From here the script owns a
// directory, so every later step runs inside the try below.
// Unix socket paths are short (104 bytes on macOS); keep the root in /tmp.
const root = mkdtempSync("/tmp/hkperf-");
const id = root
  .slice(-6)
  .toLowerCase()
  .replace(/[^a-z0-9]/g, "x");
const projectName = `hkperf-${id}`;
const rawName = `hkperf-${id}-raw`;
const home = join(root, "home");
const dockerConfig = join(root, "docker-client");
const project = join(root, projectName);
const composeFile = join(project, ".hack", "docker-compose.yml");
let dockerHost: string | null = null;
let dockerReady = false;

function baseEnv(homeDir: string): Env {
  return {
    PATH: process.env.PATH ?? "",
    HOME: homeDir,
    HACK_DAEMON_AUTOSTART_DISABLE: "1",
    HACK_NO_INTERACTIVE: "1",
    NO_COLOR: "1",
    DOCKER_CONFIG: dockerConfig,
    ...(dockerHost ? { DOCKER_HOST: dockerHost } : {}),
    ...extraEnv,
  };
}

/**
 * Homebrew and some Docker Desktop or OrbStack installs find `docker compose`
 * through `cliPluginsExtraDirs` in the user's client config. Copy that one
 * key, and nothing else, into the private config.
 */
function adoptPluginDirectories(): boolean {
  try {
    const directories = record(
      parseJson(readFileSync(join(homedir(), ".docker", "config.json"), "utf8"))
    )?.cliPluginsExtraDirs;
    if (
      !(
        Array.isArray(directories) &&
        directories.length > 0 &&
        directories.every((entry) => typeof entry === "string")
      )
    ) {
      return false;
    }
    writeFileSync(
      join(dockerConfig, "config.json"),
      `${JSON.stringify({ cliPluginsExtraDirs: directories })}\n`,
      { mode: 0o600 }
    );
    return true;
  } catch {
    return false;
  }
}

/** hackd and `mcp serve`, which run until stopped. */
const longLived = new Set<{
  kill(signal?: NodeJS.Signals): void;
  exited: Promise<number>;
}>();
let cleaning: Promise<void> | null = null;

async function removeOwnedResources(): Promise<void> {
  stopping = true;
  for (const child of longLived) {
    child.kill("SIGTERM");
  }
  // A signal reaches the commands in flight too; let them finish dying so
  // none of them creates a container after the `down` below.
  await Promise.all(
    [...longLived, ...inflight].map((child) =>
      Promise.race([child.exited, Bun.sleep(15_000)])
    )
  );
  if (dockerHost !== null) {
    for (const name of [projectName, rawName]) {
      // By project name, not by file: it also removes a network left by a
      // start that failed before it created a container.
      await run({
        argv: [
          "docker",
          "compose",
          "-p",
          name,
          "down",
          "--remove-orphans",
          "-t",
          "1",
        ],
        env: baseEnv(home),
        cwd: root,
        duringCleanup: true,
      });
    }
  }
  rmSync(root, { recursive: true, force: true });
}

function cleanup(): Promise<void> {
  cleaning ??= removeOwnedResources();
  return cleaning;
}

for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  process.on(signal, () => {
    stopping = true;
    signalExit = code;
    cleanup().finally(() => process.exit(code));
  });
}

try {
  chmodSync(root, 0o700);
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(dockerConfig, { mode: 0o700 });
  // A private HOME hides user-installed CLI plugins (`docker compose`); link
  // only the plugin directory, never the user's config or credentials.
  const userPlugins = join(homedir(), ".docker", "cli-plugins");
  if (existsSync(userPlugins)) {
    symlinkSync(userPlugins, join(dockerConfig, "cli-plugins"));
  }
  writeProject({ root, name: projectName, image });

  if (flags["skip-docker"]) {
    notes.push("Docker sections skipped (--skip-docker).");
  } else {
    const resolved = resolveDockerHost();
    if (resolved === null) {
      notes.push(
        "Docker sections skipped: no Docker endpoint could be resolved."
      );
    } else if (resolved.startsWith("unix://")) {
      dockerHost = resolved;
    } else {
      notes.push(
        "Docker sections skipped: the engine endpoint is not a local unix socket, and a private client config does not carry its TLS or SSH settings."
      );
    }
  }
  const env = baseEnv(home);
  if (dockerHost !== null) {
    const compose = () =>
      dockerText(env, ["compose", "version", "--short"]) !== null;
    if (!(compose() || (adoptPluginDirectories() && compose()))) {
      notes.push(
        "Docker sections skipped: `docker compose` is not available with a private client config (plugin not in ~/.docker/cli-plugins or cliPluginsExtraDirs)."
      );
    } else if (
      dockerText(env, ["image", "inspect", "--format", "{{.Id}}", image]) ===
      null
    ) {
      notes.push(
        `Docker sections skipped: the engine is not reachable or has no local ${image} (the script never pulls).`
      );
    } else {
      dockerReady = true;
    }
  }

  const measure = async (opts: {
    readonly label: string;
    readonly argv: readonly string[];
    readonly accept: (stdout: string) => boolean;
    readonly env?: Env;
    readonly cwd?: string;
    readonly into: Sample[];
  }): Promise<boolean> => {
    const result = await run({
      argv: opts.argv,
      env: opts.env ?? env,
      cwd: opts.cwd ?? project,
    });
    const ok = result.exitCode === 0 && opts.accept(result.stdout);
    if (ok) {
      opts.into.push(result.sample);
    } else {
      failed = true;
      process.stderr.write(
        `[failed] ${opts.label}: exit ${result.exitCode}\n${result.stderr.slice(-600)}\n`
      );
    }
    return ok;
  };

  const versionText = (
    await run({ argv: [hack, "--version"], env, cwd: project })
  ).stdout.trim();
  const git = (args: readonly string[]) =>
    Bun.spawnSync(["git", "-C", repoRoot, ...args], {
      stdout: "pipe",
      stderr: "ignore",
    })
      .stdout.toString()
      .trim();
  const metadata = {
    executable_version: versionText,
    executable_bytes: Bun.file(hack).size,
    source_sha: git(["rev-parse", "HEAD"]),
    source_dirty: git(["status", "--porcelain"]).length > 0,
    bun: Bun.version,
    os: `${platform()} ${release()} ${arch()}`,
    cpu: `${cpus()[0]?.model ?? "unknown"} x${cpus().length}`,
    memory_gb: round(totalmem() / 1024 ** 3),
    load_average_start: loadavg().map((value) => round(value, 2)),
    docker_server: dockerHost
      ? dockerText(env, ["version", "--format", "{{.Server.Version}}"])
      : null,
    engine_containers_running: dockerHost
      ? (dockerText(env, ["ps", "-q"])?.split("\n").filter(Boolean).length ??
        null)
      : null,
    fixture_image: image,
    runs: {
      warm: runs,
      cold: coldRuns,
      lifecycle: lifecycleRuns,
      idle_seconds: idleSeconds,
    },
    extra_env_keys: Object.keys(extraEnv),
  };
  report.metadata = metadata;

  // 1. up / no-op up / down against raw docker compose on the same file.
  if (dockerReady) {
    const sides = {
      hack: {
        name: projectName,
        up: [hack, "up", "-d"],
        down: [hack, "down"],
      },
      compose: {
        name: rawName,
        up: ["docker", "compose", "-p", rawName, "-f", composeFile, "up", "-d"],
        down: ["docker", "compose", "-p", rawName, "-f", composeFile, "down"],
      },
    } as const;
    const lifecycle: Record<string, Sample[]> = {};
    for (let trial = 0; trial < lifecycleRuns; trial += 1) {
      const order =
        trial % 2 === 0
          ? (["hack", "compose"] as const)
          : (["compose", "hack"] as const);
      for (const key of order) {
        const side = sides[key];
        const steps = [
          { step: "up -d (start)", argv: side.up, expect: SERVICES.length },
          {
            step: "up -d (already running)",
            argv: side.up,
            expect: SERVICES.length,
          },
          { step: "down", argv: side.down, expect: 0 },
        ];
        for (const { step, argv, expect } of steps) {
          const label = `${key === "hack" ? "hack" : "docker compose"} ${step}`;
          lifecycle[label] ??= [];
          const result = await run({ argv, env, cwd: project });
          const count =
            step === "down"
              ? allContainers(env, side.name)
              : runningContainers(env, side.name);
          if (result.exitCode === 0 && count === expect) {
            lifecycle[label].push(result.sample);
          } else {
            failed = true;
            process.stderr.write(
              `[failed] ${label}: exit ${result.exitCode}, containers ${count}, expected ${expect}\n${result.stderr.slice(-600)}\n`
            );
          }
        }
      }
    }
    const summaries = Object.entries(lifecycle).map(([label, samples]) =>
      summarize(label, samples, lifecycleRuns - samples.length)
    );
    report.lifecycle = summaries;
    const overhead = ["up -d (start)", "up -d (already running)", "down"].map(
      (step) => {
        const mine =
          summaries.find((summary) => summary.label === `hack ${step}`)
            ?.medianMs ?? null;
        const raw =
          summaries.find(
            (summary) => summary.label === `docker compose ${step}`
          )?.medianMs ?? null;
        return [
          step,
          formatMs(mine),
          formatMs(raw),
          mine !== null && raw !== null ? formatMs(round(mine - raw)) : "n/a",
          mine !== null && raw ? `${(mine / raw).toFixed(2)}x` : "n/a",
        ];
      }
    );
    sections.push(
      `### Lifecycle on a 3-service fixture (${lifecycleRuns} alternating trials)\n\n${latencyTable(summaries)}\n\n${table(["step", "hack median ms", "docker compose median ms", "Hack overhead ms", "ratio"], overhead)}`
    );
  }

  // 2. Read commands, with the fixture running when Docker is available.
  let fixtureUp = false;
  if (dockerReady) {
    const up = await run({ argv: [hack, "up", "-d"], env, cwd: project });
    fixtureUp =
      up.exitCode === 0 &&
      runningContainers(env, projectName) === SERVICES.length;
    if (!fixtureUp) {
      failed = true;
      notes.push(
        "The fixture did not start; read commands ran against a stopped project."
      );
    }
  }
  const commands: Command[] = [
    {
      label: "hack --version",
      args: ["--version"],
      accept: (stdout) => /\d+\.\d+\.\d+/.test(stdout),
    },
    {
      label: "hack ps --json",
      args: ["ps", "--json"],
      accept: (stdout) => {
        const items = record(parseJson(stdout))?.items;
        return (
          Array.isArray(items) &&
          items.length === (fixtureUp ? SERVICES.length : 0)
        );
      },
    },
    {
      label: "hack env list --json",
      args: ["env", "list", "--json"],
      accept: (stdout) => record(parseJson(stdout))?.project === projectName,
    },
    {
      label: "hack open --json",
      args: ["open", "--json"],
      accept: (stdout) => typeof record(parseJson(stdout))?.url === "string",
    },
  ];
  if (fixtureUp) {
    commands.push({
      label: "hack logs --json --no-follow --tail 50",
      args: ["logs", "--json", "--no-follow", "--tail", "50"],
      accept: (stdout) => stdout.includes('"type":"log"'),
    });
  }

  const warm = new Map<string, Sample[]>(
    commands.map((command) => [command.label, []])
  );
  // One unmeasured pass creates the private HOME's state so warm is steady.
  for (const command of commands) {
    await run({ argv: [hack, ...command.args], env, cwd: project });
  }
  for (let index = 0; index < runs; index += 1) {
    for (const command of commands) {
      await measure({
        label: command.label,
        argv: [hack, ...command.args],
        accept: command.accept,
        into: warm.get(command.label) as Sample[],
      });
    }
  }
  const cold = new Map<string, Sample[]>(
    commands.map((command) => [command.label, []])
  );
  for (let index = 0; index < coldRuns; index += 1) {
    for (const [position, command] of commands.entries()) {
      const directory = join(root, `cold-${index}-${position}`);
      mkdirSync(join(directory, "home"), { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      const copy = join(directory, "hack");
      copyFileSync(hack, copy);
      chmodSync(copy, 0o755);
      await measure({
        label: `${command.label} (cold)`,
        argv: [copy, ...command.args],
        accept: command.accept,
        env: baseEnv(join(directory, "home")),
        into: cold.get(command.label) as Sample[],
      });
      rmSync(directory, { recursive: true, force: true });
    }
  }
  const readSummaries = commands.flatMap((command) => [
    summarize(
      `${command.label} (cold)`,
      cold.get(command.label) ?? [],
      coldRuns - (cold.get(command.label)?.length ?? 0)
    ),
    summarize(
      `${command.label} (warm)`,
      warm.get(command.label) ?? [],
      runs - (warm.get(command.label)?.length ?? 0)
    ),
  ]);
  report.read_commands = readSummaries;
  sections.unshift(
    `### CLI read commands (fixture ${fixtureUp ? "running, 3 services" : "stopped"})\n\n${latencyTable(readSummaries)}`
  );

  // 3. Launcher overhead.
  const launcherSummaries: Summary[] = [];
  const timeVersion = async (
    label: string,
    argv: readonly string[],
    launcherEnv: Env
  ) => {
    const samples: Sample[] = [];
    await run({ argv, env: launcherEnv, cwd: root });
    for (let index = 0; index < runs; index += 1) {
      await measure({
        label,
        argv,
        accept: (stdout) => /\d+\.\d+\.\d+/.test(stdout),
        env: launcherEnv,
        cwd: root,
        into: samples,
      });
    }
    launcherSummaries.push(summarize(label, samples, runs - samples.length));
  };
  // The bundle's shell frontend alone, around this executable.
  const bundle = join(root, "bundle");
  mkdirSync(bundle, { mode: 0o700 });
  copyFileSync(join(repoRoot, "scripts/hack-v5.sh"), join(bundle, "hack-v5"));
  chmodSync(join(bundle, "hack-v5"), 0o755);
  symlinkSync(hack, join(bundle, "hack-cli"));
  writeFileSync(join(bundle, "hack-native"), "#!/bin/sh\nexit 69\n", {
    mode: 0o755,
  });
  const composeEnv = { ...env, HACK_RUNTIME_BACKEND: "compose" };
  await timeVersion(
    "executable directly: --version",
    [hack, "--version"],
    composeEnv
  );
  await timeVersion(
    "through hack-v5 shell frontend: --version",
    [join(bundle, "hack-v5"), "--version"],
    composeEnv
  );
  if (launcherPlan === null) {
    notes.push(
      "hack-next launcher not measured: pass --launcher <root>/bin/hack-next on a host with the prerelease channel installed (macOS only)."
    );
  } else if (typeof launcherPlan === "string") {
    notes.push(launcherPlan);
  } else {
    // The launcher owns its own homes; it runs with the caller's real HOME.
    // `--version` writes nothing, and no run may start a daemon there.
    const realEnv: Env = {
      PATH: process.env.PATH ?? "",
      HOME: homedir(),
      NO_COLOR: "1",
      HACK_DAEMON_AUTOSTART_DISABLE: "1",
    };
    const { launcher, selected, bundle: installed } = launcherPlan;
    await timeVersion(
      `installed ${selected} hack-cli directly: --version`,
      [join(installed, "hack-cli"), "--version"],
      realEnv
    );
    await timeVersion(
      `installed ${selected} through hack-v5: --version`,
      [join(installed, "hack-v5"), "--version"],
      realEnv
    );
    await timeVersion(
      `installed ${selected} through hack-next launcher: --version`,
      [launcher, "--version"],
      realEnv
    );
  }
  report.launcher = launcherSummaries;
  sections.push(`### Launcher overhead\n\n${latencyTable(launcherSummaries)}`);

  // 4. hackd: /v1/projects latency by registry size, then idle cost.
  if (!flags["skip-daemon"]) {
    const daemon = Bun.spawn([hack, "daemon", "start", "--foreground"], {
      cwd: root,
      env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    longLived.add(daemon);
    const socket = join(home, ".hack", "daemon", "hackd.sock");
    const fetchProjects = async (query: string) => {
      const started = performance.now();
      const response = await fetch(`http://localhost/v1/projects${query}`, {
        unix: socket,
      });
      const body = await response.text();
      return { ok: response.ok, body, wallMs: performance.now() - started };
    };
    const registered = async (): Promise<number> => {
      try {
        const projects = record(
          parseJson((await fetchProjects("")).body)
        )?.projects;
        return Array.isArray(projects) ? projects.length : -1;
      } catch {
        return -1;
      }
    };
    const deadline = performance.now() + 30_000;
    while ((await registered()) < 0 && performance.now() < deadline) {
      await Bun.sleep(200);
    }
    const daemonSummaries: Summary[] = [];
    const sizes: number[] = [];
    let extra = 0;
    const base = await registered();
    if (base > 1) {
      notes.push(
        `${base - 1} other running Hack project(s) on this engine were auto-registered into the private registry; they count toward the registry sizes below.`
      );
    }
    for (const target of [1, 5, 20]) {
      let count = await registered();
      while (count < target) {
        extra += 1;
        const directory = writeProject({
          root,
          name: `${projectName}-p${extra}`,
          image,
        });
        await run({
          argv: [hack, "projects", "--json", "--summary", "--no-daemon"],
          env,
          cwd: directory,
        });
        const settle = performance.now() + 20_000;
        const before = count;
        while (count <= before && performance.now() < settle) {
          await Bun.sleep(250);
          count = await registered();
        }
        if (count <= before) {
          failed = true;
          notes.push(
            `hackd did not list a newly registered project within 20 s (at ${count}).`
          );
          break;
        }
      }
      for (const [suffix, query] of [
        ["full", ""],
        ["summary", "?summary=true"],
      ] as const) {
        const samples: Sample[] = [];
        let bytes = 0;
        for (let index = 0; index < runs * 3; index += 1) {
          const result = await fetchProjects(query);
          if (result.ok) {
            bytes = result.body.length;
            samples.push({
              wallMs: result.wallMs,
              cpuMs: null,
              maxRssKb: null,
            });
          }
        }
        daemonSummaries.push(
          summarize(
            `GET /v1/projects (${suffix}), ${count} projects, ${bytes} bytes`,
            samples,
            runs * 3 - samples.length
          )
        );
      }
      sizes.push(count);
    }
    report.daemon_projects = daemonSummaries;
    sections.push(
      `### hackd /v1/projects (unix socket, cached reads)\n\n${table(
        ["request", "n", "median ms", "min", "p95", "max"],
        daemonSummaries.map((summary) => [
          summary.label,
          String(summary.n),
          formatMs(summary.medianMs),
          formatMs(summary.minMs),
          formatMs(summary.p95Ms),
          formatMs(summary.maxMs),
        ])
      )}`
    );

    const mcp = Bun.spawn([hack, "mcp", "serve"], {
      cwd: project,
      env,
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    });
    longLived.add(mcp);
    mcp.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "benchmark-cli-latency", version: "0" },
        },
      })}\n`
    );
    mcp.stdin.flush();
    await Bun.sleep(3000);
    const idle = await sampleIdle({
      targets: [
        {
          label: `hackd (${sizes.at(-1) ?? 0} projects registered, fixture ${fixtureUp ? "running" : "stopped"})`,
          pid: daemon.pid,
        },
        { label: "hack mcp serve (initialized, no calls)", pid: mcp.pid },
      ],
      seconds: idleSeconds,
    });
    report.idle = idle;
    sections.push(
      `### Idle cost over ${idleSeconds} s\n\n${table(
        [
          "process tree",
          "CPU s",
          "CPU % of one core",
          "RSS median MB",
          "RSS max MB",
          "processes",
          "exited in window",
        ],
        idle.map((entry) => [
          entry.label,
          entry.cpuSeconds.toFixed(2),
          entry.cpuPercentOfOneCore.toFixed(2),
          entry.rssMedianMb.toFixed(1),
          entry.rssMaxMb.toFixed(1),
          String(entry.processes),
          String(entry.exitedDuringWindow),
        ])
      )}`
    );
  }

  if (fixtureUp) {
    await run({ argv: [hack, "down"], env, cwd: project });
  }
  // After Hack's own `down` and before the script's cleanup: what the
  // measured commands themselves left behind.
  const leftovers = dockerReady
    ? [projectName, rawName].reduce(
        (sum, name) =>
          sum + allContainers(env, name) + ownedNetworks(env, name),
        0
      )
    : 0;
  report.cleanup = { containers_and_networks_left: leftovers };
  if (leftovers !== 0) {
    failed = true;
  }
  report.notes = notes;
  report.load_average_end = loadavg().map((value) => round(value, 2));

  const header = [
    "## Hack CLI latency baseline",
    "",
    `- executable: ${metadata.executable_version} (${round(metadata.executable_bytes / 1024 ** 2)} MB), source ${metadata.source_sha.slice(0, 12)}${metadata.source_dirty ? " (dirty)" : ""}`,
    `- host: ${metadata.os}, ${metadata.cpu}, ${metadata.memory_gb} GB`,
    `- Docker server ${metadata.docker_server ?? "not used"}; ${metadata.engine_containers_running ?? "n/a"} other containers running on the engine; fixture image ${image}`,
    `- load average at start ${metadata.load_average_start.join(" ")}, at end ${loadavg()
      .map((value) => value.toFixed(2))
      .join(" ")}`,
    `- cleanup: ${leftovers} fixture containers and networks left by the measured commands`,
    ...notes.map((note) => `- note: ${note}`),
  ].join("\n");
  process.stdout.write(`${header}\n\n${sections.join("\n\n")}\n`);
  if (flags.out) {
    writeFileSync(resolve(flags.out), `${JSON.stringify(report, null, 2)}\n`);
  }
} catch (error) {
  if (!(error instanceof Interrupted)) {
    throw error;
  }
} finally {
  await cleanup();
}
process.exit(signalExit ?? (failed ? 1 : 0));
