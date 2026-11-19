#!/usr/bin/env bun
/**
 * Like-for-like runtime benchmark: one project, one CLI build, run on the
 * Compose backend and on the native backend of the same host.
 *
 * Usage: bun scripts/benchmark-runtime-footprint.ts --lane compose|native
 *          --hack PATH --out DIR [--workload FILE] [--project DIR]
 *          [--native-tool PATH --native-home DIR --native-https-port N]
 *          [--compose-address HOST:PORT] [--compose-cacert FILE]
 *          [--docker-vm-pattern REGEX]
 *          [--phases LIST] [--idle-seconds S] [--warm-runs N] [--max-load L]
 *          [--env KEY=VALUE]... [--hack-arg ARG]... [--keep-running]
 *          [--attached]
 *
 *   --lane        which backend this run measures. One lane per invocation: the
 *                 caller alternates lanes and owns any host lock between runs.
 *   --hack        the CLI under test (a bundle's `hack-v5` or an installed
 *                 launcher). The same executable must drive both lanes.
 *   --workload    JSON descriptor of what to probe (default: the fixture's
 *                 `bench.json`). See `scripts/fixtures/runtime-bench/`.
 *   --project     project root (default: the descriptor's directory).
 *   --phases      comma list from: cold,warm,restart,idle,watch,tasks,latency,
 *                 io,stop (default: all that the descriptor supports).
 *   --max-load    1-minute load above which a timing is flagged, not dropped
 *                 (default 40). `summary` leaves flagged samples out of its
 *                 medians; each phase's own figures use every completed
 *                 sample and say how many were flagged.
 *   --attached    measure a project that is already running (no cold phase).
 *                 The warm, restart and stop phases, when listed, stop that
 *                 project; the native VM is never stopped in this mode.
 *
 * Measurement boundary. Readiness is the descriptor's routed HTTP checks
 * returning the expected status through the backend's own proxy, never a
 * process start. Timings are wall time of the CLI command plus the wait for
 * readiness, with the 1-minute load recorded before and after.
 *
 * Memory is reported per quantity and never summed across kinds:
 *   - per container: cgroup `memory.current` and `memory.stat` (anon, file),
 *     read inside each container the same way on both lanes;
 *   - guest: `/proc/meminfo` read from one container. On Compose that is the
 *     shared Docker VM with every other project in it; the report says how
 *     many other containers were running;
 *   - host: for each VM process, resident size (`ps`) and physical footprint
 *     (the `phys_footprint` line of `footprint`, the kernel's own charge to
 *     the process). The two differ a lot between VM implementations, because
 *     some map guest memory in a way macOS does not charge to the process,
 *     and resident size drops when the host compresses memory. Read both, and
 *     compare like with like.
 * Idle CPU is the growth of cumulative CPU time over the window: host VM
 * processes from `ps`, containers from cgroup `cpu.stat`, the guest from
 * `/proc/stat`. Nothing is executed in the project during the window; host
 * processes are listed every 15 seconds.
 *
 * "Cold" means the images were absent from the engine before the first start.
 * The script records which images were present; a start with any image present
 * is labelled `first` instead. The host page cache is never flushed.
 *
 * The script stops only the project it was pointed at, and the native VM only
 * when this run booted it. Before a cold start on the native lane it refuses
 * to begin while any provider VM process is running. The project must be a
 * copy outside this repository: a run writes state, dependencies and scratch
 * files into it.
 */
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { arch, cpus, loadavg, release, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  execGaveUp,
  type JobResult,
  jobPollArgv,
  jobStartArgv,
  parseJobPoll,
  parsePhysFootprintBytes,
} from "./lib/runtime-bench-job.ts";

type Env = Record<string, string>;

type Route = {
  readonly host: string;
  readonly path: string;
  /** Exact expected status (default 200), unless `statusBelow` is set. */
  readonly status?: number;
  /** Accept any complete response below this status, for example 500. */
  readonly statusBelow?: number;
};

function accepts(route: Route, status: number): boolean {
  if (route.statusBelow !== undefined) {
    return status >= 100 && status < route.statusBelow;
  }
  return status === (route.status ?? 200);
}

type Task = {
  readonly label: string;
  readonly service: string;
  readonly argv: readonly string[];
  readonly runs?: number;
};

type Workload = {
  readonly name: string;
  /** Every route must answer before a start counts as ready. */
  readonly routes: readonly Route[];
  /** Services whose cgroup and guest counters are read. */
  readonly services: readonly string[];
  readonly latency?: Route;
  /** POST a 32-hex marker, then read it back after restarts. */
  readonly data?: { readonly write: Route; readonly read: Route };
  /**
   * A host file whose content routed endpoints serve after a reload. Each probe
   * is one reload mechanism; every probe is tried with an in-place save and with
   * an atomic (write a temporary file, then rename) save.
   */
  readonly watch?: {
    readonly file: string;
    readonly template: string;
    /** A probe may name its own file, so one edit moves one mechanism only. */
    readonly probes: readonly (Route & {
      readonly label: string;
      readonly file?: string;
      readonly template?: string;
    })[];
  };
  readonly tasks?: readonly Task[];
  /** Container paths for throughput: a bind mount and a named volume. */
  readonly io?: {
    readonly service: string;
    readonly bind: string;
    readonly volume: string;
  };
};

type Timing = {
  readonly phase: string;
  readonly label: string;
  readonly at: string;
  readonly loadBefore: number;
  readonly loadAfter: number;
  readonly seconds: number;
  readonly commandSeconds?: number;
  readonly cliCpuSeconds?: number | null;
  readonly ok: boolean;
  /** Load exceeded `--max-load`: kept, and left out of the `summary` medians. */
  readonly flagged: boolean;
  readonly detail?: string;
};

type Exec = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly seconds: number;
  readonly cpuSeconds: number | null;
};

const PHASES = [
  "cold",
  "warm",
  "restart",
  "idle",
  "watch",
  "tasks",
  "latency",
  "io",
  "stop",
] as const;
type Phase = (typeof PHASES)[number];

const PROVIDER_VM = /(^|\/)(smolvm-bin|krun)$/;
const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/;
const CPU_TIME = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/;

const { values } = parseArgs({
  options: {
    lane: { type: "string" },
    hack: { type: "string" },
    out: { type: "string" },
    workload: { type: "string" },
    project: { type: "string" },
    "native-tool": { type: "string" },
    "native-home": { type: "string" },
    "native-https-port": { type: "string", default: "18443" },
    "compose-address": { type: "string" },
    "compose-cacert": { type: "string" },
    "docker-vm-pattern": {
      type: "string",
      default:
        "OrbStack Helper|com\\.docker\\.(virtualization|krun|hyperkit)|vfkit|krunkit|limactl",
    },
    phases: { type: "string" },
    "idle-seconds": { type: "string", default: "300" },
    "settle-seconds": { type: "string", default: "60" },
    "warm-runs": { type: "string", default: "3" },
    "max-load": { type: "string", default: "40" },
    "start-timeout": { type: "string", default: "1800" },
    env: { type: "string", multiple: true, default: [] },
    "hack-arg": { type: "string", multiple: true, default: [] },
    "keep-running": { type: "boolean", default: false },
    attached: { type: "boolean", default: false },
  },
});

function fail(message: string): never {
  process.stderr.write(`benchmark-runtime-footprint: ${message}\n`);
  process.exit(2);
}

function required(name: keyof typeof values): string {
  const value = values[name];
  if (typeof value !== "string" || value === "") {
    fail(`--${name} is required`);
  }
  return value;
}

function positive(name: keyof typeof values): number {
  const value = Number(values[name]);
  if (!(Number.isFinite(value) && value >= 0)) {
    fail(`--${name} must be a number`);
  }
  return value;
}

const lane = required("lane");
if (lane !== "compose" && lane !== "native") {
  fail("--lane must be compose or native");
}
const hack = resolve(required("hack"));
const outDir = resolve(required("out"));
const repoRoot = resolve(dirname(import.meta.dir));
const workloadPath = resolve(
  values.workload ?? join(repoRoot, "scripts/fixtures/runtime-bench/bench.json")
);
const workload = JSON.parse(readFileSync(workloadPath, "utf8")) as Workload;
const project = resolve(values.project ?? dirname(workloadPath));
if (project === repoRoot || project.startsWith(`${repoRoot}/`)) {
  // A run writes runtime state, dependencies and I/O scratch files into the project.
  fail("--project must be outside this repository; copy the fixture first");
}
const nativeTool = values["native-tool"]
  ? resolve(values["native-tool"])
  : null;
const nativeHome = values["native-home"]
  ? resolve(values["native-home"])
  : null;
const nativePort = positive("native-https-port");
const composeAddress = values["compose-address"] ?? null;
const composeCa = values["compose-cacert"]
  ? resolve(values["compose-cacert"])
  : null;
const dockerVm = new RegExp(values["docker-vm-pattern"] ?? "^$");
const idleSeconds = positive("idle-seconds");
const settleSeconds = positive("settle-seconds");
const warmRuns = positive("warm-runs");
const maxLoad = positive("max-load");
const startTimeout = positive("start-timeout");
const hackArgs = values["hack-arg"] ?? [];

if (lane === "native" && !(nativeTool && nativeHome)) {
  fail("--lane native needs --native-tool and --native-home");
}

const extraEnv: Env = {};
for (const pair of values.env ?? []) {
  const at = pair.indexOf("=");
  if (at <= 0) {
    fail(`--env needs KEY=VALUE, got ${pair}`);
  }
  extraEnv[pair.slice(0, at)] = pair.slice(at + 1);
}

function supported(phase: Phase): boolean {
  if (phase === "watch") {
    return workload.watch !== undefined;
  }
  if (phase === "tasks") {
    return (workload.tasks ?? []).length > 0;
  }
  if (phase === "latency") {
    return workload.latency !== undefined;
  }
  if (phase === "io") {
    return workload.io !== undefined;
  }
  return true;
}

const phases = new Set<Phase>(
  (values.phases ? values.phases.split(",") : [...PHASES]).map((name) => {
    if (!(PHASES as readonly string[]).includes(name)) {
      fail(`unknown phase ${name}`);
    }
    return name as Phase;
  })
);
for (const phase of [...phases]) {
  if (!supported(phase)) {
    phases.delete(phase);
  }
}

const env: Env = {
  ...(process.env as Env),
  HACK_NO_INTERACTIVE: "1",
  HACK_DAEMON_AUTOSTART_DISABLE: "1",
  NO_COLOR: "1",
  ...(lane === "native"
    ? { HACK_RUNTIME_BACKEND: "native", HACK_NATIVE_SHARED_SOURCE: "1" }
    : { HACK_RUNTIME_BACKEND: "compose" }),
  ...extraEnv,
};

mkdirSync(outDir, { recursive: true, mode: 0o700 });
chmodSync(outDir, 0o700);
const logPath = join(outDir, "commands.log");
writeFileSync(logPath, "");

const timings: Timing[] = [];
const notes: string[] = [];
const report: Record<string, unknown> = {};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function load1(): number {
  return Math.round((loadavg()[0] ?? 0) * 100) / 100;
}

function log(line: string): void {
  process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${line}\n`);
}

async function run(opts: {
  readonly argv: readonly string[];
  readonly timeoutSeconds?: number;
  readonly stdin?: string;
}): Promise<Exec> {
  const started = performance.now();
  const child = Bun.spawn([...opts.argv], {
    cwd: project,
    env,
    stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
    stdout: "pipe",
    stderr: "pipe",
    timeout: (opts.timeoutSeconds ?? 120) * 1000,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const seconds = (performance.now() - started) / 1000;
  const usage = child.resourceUsage();
  const cpuSeconds = usage
    ? (Number(usage.cpuTime.user) + Number(usage.cpuTime.system)) / 1_000_000
    : null;
  appendFileSync(
    logPath,
    `$ ${opts.argv.join(" ").slice(0, 400)}\n# exit ${exitCode} in ${seconds.toFixed(2)}s\n${stderr.slice(-2000)}\n`
  );
  return { exitCode, stdout, stderr, seconds, cpuSeconds };
}

function cli(args: readonly string[], timeoutSeconds = 120): Promise<Exec> {
  return run({ argv: [hack, ...args, ...hackArgs], timeoutSeconds });
}

/** Runs a command inside a running service container. */
function inService(
  service: string,
  argv: readonly string[],
  timeoutSeconds = 120
): Promise<Exec> {
  return run({
    argv: [hack, "exec", ...hackArgs, service, "--", ...argv],
    timeoutSeconds,
  });
}

function caFile(): string | null {
  if (lane === "compose") {
    return composeCa;
  }
  return join(
    nativeHome ?? "",
    "native-https/data/caddy/pki/authorities/local/root.crt"
  );
}

/**
 * Native serves its routes on a loopback port. The Compose proxy is reached the
 * way a browser reaches it, through the host's resolver, unless
 * `--compose-address` pins an address.
 */
function curlArgs(route: Route): string[] {
  const ca = caFile();
  const port = lane === "native" ? nativePort : 443;
  const target = lane === "native" ? `127.0.0.1:${nativePort}` : composeAddress;
  return [
    "curl",
    "--silent",
    "--show-error",
    "--max-time",
    "10",
    ...(ca && existsSync(ca) ? ["--cacert", ca] : ["--insecure"]),
    ...(target ? ["--connect-to", `${route.host}:${port}:${target}`] : []),
    `https://${route.host}${port === 443 ? "" : `:${port}`}${route.path}`,
  ];
}

async function fetchRoute(
  route: Route,
  body?: string
): Promise<{ status: number; text: string }> {
  const result = await run({
    argv: [
      ...curlArgs(route),
      "--write-out",
      "\n%{http_code}",
      ...(body === undefined ? [] : ["--request", "POST", "--data", body]),
    ],
    timeoutSeconds: 15,
  });
  const at = result.stdout.lastIndexOf("\n");
  return {
    status: Number(result.stdout.slice(at + 1)) || 0,
    text: at < 0 ? "" : result.stdout.slice(0, at),
  };
}

async function ready(): Promise<boolean> {
  for (const route of workload.routes) {
    const answer = await fetchRoute(route);
    if (!accepts(route, answer.status)) {
      return false;
    }
  }
  return true;
}

async function waitReady(timeoutSeconds: number): Promise<boolean> {
  const deadline = performance.now() + timeoutSeconds * 1000;
  while (performance.now() < deadline) {
    if (await ready()) {
      return true;
    }
    await Bun.sleep(500);
  }
  return false;
}

/** Times one CLI command plus the wait until every route answers. */
async function timed(opts: {
  readonly phase: string;
  readonly label: string;
  readonly args: readonly string[];
  readonly expectReady: boolean;
  readonly timeoutSeconds?: number;
  /** Checked after the timing ends; a false answer fails the sample. */
  readonly verify?: () => Promise<boolean>;
}): Promise<Timing> {
  const loadBefore = load1();
  const at = new Date().toISOString();
  const started = performance.now();
  const result = await cli(opts.args, opts.timeoutSeconds ?? startTimeout);
  let ok = result.exitCode === 0;
  if (ok && opts.expectReady) {
    ok = await waitReady(120);
  }
  const seconds = (performance.now() - started) / 1000;
  const loadAfter = load1();
  let detail = `exit ${result.exitCode}: ${result.stderr.slice(-400)}`;
  if (ok && opts.verify && !(await opts.verify())) {
    ok = false;
    detail = "ready, but the data marker written after the first start is gone";
  }
  const timing: Timing = {
    phase: opts.phase,
    label: opts.label,
    at,
    loadBefore,
    loadAfter,
    seconds: Math.round(seconds * 100) / 100,
    commandSeconds: Math.round(result.seconds * 100) / 100,
    cliCpuSeconds: result.cpuSeconds,
    ok,
    flagged: Math.max(loadBefore, loadAfter) > maxLoad,
    ...(ok ? {} : { detail }),
  };
  timings.push(timing);
  log(
    `${opts.label}: ${timing.seconds}s ok=${ok} load ${loadBefore}->${loadAfter}${timing.flagged ? " FLAGGED" : ""}`
  );
  save();
  return timing;
}

// --- host processes --------------------------------------------------------

type HostProcess = {
  readonly pid: number;
  readonly rssBytes: number;
  readonly cpuSeconds: number;
  readonly command: string;
};

function cpuTimeSeconds(text: string): number {
  const match = CPU_TIME.exec(text);
  if (!match) {
    return 0;
  }
  return (
    Number(match[1] ?? 0) * 86_400 +
    Number(match[2] ?? 0) * 3600 +
    Number(match[3]) * 60 +
    Number(match[4])
  );
}

function hostProcesses(): HostProcess[] {
  const listing = Bun.spawnSync([
    "ps",
    "-A",
    "-ww",
    "-o",
    "pid=,rss=,time=,command=",
  ]);
  const rows: HostProcess[] = [];
  for (const line of listing.stdout.toString().split("\n")) {
    const match = PS_ROW.exec(line);
    if (match) {
      rows.push({
        pid: Number(match[1]),
        rssBytes: Number(match[2]) * 1024,
        cpuSeconds: cpuTimeSeconds(match[3] ?? ""),
        command: match[4] ?? "",
      });
    }
  }
  return rows;
}

function isProviderVm(row: HostProcess): boolean {
  return PROVIDER_VM.test(row.command.split(" ")[0] ?? "");
}

/** The host processes that carry this lane's runtime. */
function laneProcesses(): { vm: HostProcess[]; helpers: HostProcess[] } {
  const rows = hostProcesses();
  if (lane === "native") {
    const home = nativeHome ?? "\0";
    // Only this home's VM: another pool on the host is not this lane's cost.
    const vm = rows.filter(
      (row) => isProviderVm(row) && row.command.includes(home)
    );
    const helpers = rows.filter(
      (row) =>
        !isProviderVm(row) &&
        row.pid !== process.pid &&
        (row.command.includes(home) || row.command.includes("/hkp-"))
    );
    return { vm, helpers };
  }
  return { vm: rows.filter((row) => dockerVm.test(row.command)), helpers: [] };
}

function footprintBytes(pid: number): number | null {
  const result = Bun.spawnSync([
    "footprint",
    "--format",
    "bytes",
    "--noCategories",
    "--pid",
    String(pid),
  ]);
  return parsePhysFootprintBytes(result.stdout.toString());
}

function hostSnapshot(withFootprint: boolean): Record<string, unknown> {
  const { vm, helpers } = laneProcesses();
  const sum = (rows: readonly HostProcess[], key: "rssBytes" | "cpuSeconds") =>
    rows.reduce((total, row) => total + row[key], 0);
  let footprint: number | null = null;
  if (withFootprint) {
    footprint = 0;
    for (const row of vm) {
      const bytes = footprintBytes(row.pid);
      if (bytes === null) {
        footprint = null;
        break;
      }
      footprint += bytes;
    }
  }
  return {
    at: new Date().toISOString(),
    load1: load1(),
    vmProcesses: vm.length,
    vmResidentBytes: sum(vm, "rssBytes"),
    vmCpuSeconds: Math.round(sum(vm, "cpuSeconds") * 100) / 100,
    vmPhysicalFootprintBytes: footprint,
    helperProcesses: helpers.length,
    helperResidentBytes: sum(helpers, "rssBytes"),
    helperCpuSeconds: Math.round(sum(helpers, "cpuSeconds") * 100) / 100,
  };
}

// --- guest and container counters -------------------------------------------

const GUEST_SCRIPT = [
  "echo '#meminfo'; cat /proc/meminfo",
  "echo '#stat'; head -1 /proc/stat",
  "echo '#memory.current'; cat /sys/fs/cgroup/memory.current",
  "echo '#memory.stat'; cat /sys/fs/cgroup/memory.stat",
  "echo '#cpu.stat'; cat /sys/fs/cgroup/cpu.stat",
  "echo '#uptime'; cat /proc/uptime",
].join("; ");

function sections(text: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  let current: string[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("#")) {
      current = [];
      result.set(line.slice(1), current);
    } else if (line.trim() !== "") {
      current.push(line);
    }
  }
  return result;
}

function keyed(lines: readonly string[] | undefined): Record<string, number> {
  const result: Record<string, number> = {};
  for (const line of lines ?? []) {
    const [key, value] = line.replace(":", "").trim().split(/\s+/);
    if (key && value !== undefined) {
      result[key] = Number(value);
    }
  }
  return result;
}

type ServiceCounters = {
  readonly memoryCurrentBytes: number | null;
  readonly anonBytes: number | null;
  readonly fileBytes: number | null;
  readonly cpuSeconds: number | null;
  /** Guest uptime when these counters were read. */
  readonly uptimeSeconds: number | null;
};

type GuestCounters = {
  readonly services: Record<string, ServiceCounters | null>;
  readonly meminfoKb: Record<string, number> | null;
  /** Guest-wide busy and total CPU ticks from `/proc/stat`. */
  readonly cpuTicks: { readonly busy: number; readonly total: number } | null;
};

async function guestCounters(): Promise<GuestCounters> {
  const services: Record<string, ServiceCounters | null> = {};
  let meminfoKb: Record<string, number> | null = null;
  let cpuTicks: GuestCounters["cpuTicks"] = null;
  for (const service of workload.services) {
    const result = await inService(service, ["sh", "-c", GUEST_SCRIPT], 90);
    if (result.exitCode !== 0) {
      services[service] = null;
      continue;
    }
    const parts = sections(result.stdout);
    const memory = keyed(parts.get("memory.stat"));
    const cpu = keyed(parts.get("cpu.stat"));
    services[service] = {
      memoryCurrentBytes: Number(
        parts.get("memory.current")?.[0] ?? Number.NaN
      ),
      anonBytes: memory.anon ?? null,
      fileBytes: memory.file ?? null,
      cpuSeconds: cpu.usage_usec === undefined ? null : cpu.usage_usec / 1e6,
      uptimeSeconds:
        Number((parts.get("uptime")?.[0] ?? "").split(" ")[0] || Number.NaN) ||
        null,
    };
    if (meminfoKb === null) {
      meminfoKb = keyed(parts.get("meminfo"));
      const fields = (parts.get("stat")?.[0] ?? "")
        .split(/\s+/)
        .slice(1)
        .map(Number);
      const total = fields.reduce((sum, value) => sum + value, 0);
      const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
      cpuTicks = { busy: total - idle, total };
    }
  }
  return { services, meminfoKb, cpuTicks };
}

async function nativeStatus(): Promise<unknown> {
  if (!(nativeTool && nativeHome)) {
    return null;
  }
  const result = await run({
    argv: [
      nativeTool,
      "--candidate-root",
      nativeHome,
      "runtime",
      "status",
      "--json",
    ],
    timeoutSeconds: 60,
  });
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function engineContainers(): number | null {
  const result = Bun.spawnSync(["docker", "ps", "--quiet"], { env });
  return result.exitCode === 0
    ? result.stdout.toString().split("\n").filter(Boolean).length
    : null;
}

// --- phases ------------------------------------------------------------------

function save(): void {
  writeFileSync(
    join(outDir, "result.json"),
    `${JSON.stringify({ ...report, timings, notes }, null, 2)}\n`
  );
}

function median(values_: readonly number[]): number | null {
  if (values_.length === 0) {
    return null;
  }
  const sorted = [...values_].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? null)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function token(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

let marker: string | null = null;

async function writeMarker(): Promise<void> {
  if (!workload.data) {
    return;
  }
  marker = token();
  const answer = await fetchRoute(workload.data.write, marker);
  if (answer.status !== 200) {
    notes.push(`data marker write returned ${answer.status}`);
    marker = null;
  }
}

/** False when data written after the first start is gone; such a start does not count. */
async function markerSurvives(): Promise<boolean> {
  if (!(workload.data && marker)) {
    return true;
  }
  return (await fetchRoute(workload.data.read)).text.includes(marker);
}

async function imagesPresent(): Promise<Record<string, boolean> | null> {
  if (lane !== "compose") {
    return null;
  }
  const config = await run({
    argv: [
      "docker",
      "compose",
      "--file",
      join(project, ".hack/docker-compose.yml"),
      "config",
      "--images",
    ],
  });
  if (config.exitCode !== 0) {
    return null;
  }
  const present: Record<string, boolean> = {};
  for (const image of config.stdout.split("\n").filter(Boolean)) {
    const inspect = Bun.spawnSync(["docker", "image", "inspect", image], {
      env,
    });
    present[image] = inspect.exitCode === 0;
  }
  return present;
}

async function phaseStart(): Promise<boolean> {
  const present = await imagesPresent();
  const cold =
    lane === "native"
      ? // A native home that never booted a pool holds no images.
        (record(await nativeStatus())?.phase ?? null) === "uninitialized"
      : present !== null && Object.values(present).every((value) => !value);
  report.imagesPresentBeforeFirstStart = present;
  const first = await timed({
    phase: cold ? "cold-start" : "first-start",
    label: cold ? "cold up" : "first up (images or state present)",
    args: ["up", "--detach"],
    expectReady: true,
  });
  if (!first.ok) {
    return false;
  }
  await writeMarker();
  return true;
}

async function phaseWarm(): Promise<void> {
  for (let index = 1; index <= warmRuns; index += 1) {
    await timed({
      phase: "stop",
      label: `down ${index}`,
      args: ["down"],
      expectReady: false,
      timeoutSeconds: 600,
    });
    await timed({
      phase: "warm-start",
      label: `warm up ${index}`,
      args: ["up", "--detach"],
      expectReady: true,
      verify: markerSurvives,
    });
  }
}

async function phaseRestart(): Promise<void> {
  for (let index = 1; index <= warmRuns; index += 1) {
    await timed({
      phase: "restart",
      label: `restart ${index}`,
      // Without --json a native restart stays in the foreground as the owner.
      args: ["restart", "--json"],
      expectReady: true,
      verify: markerSurvives,
    });
  }
}

/**
 * One service's CPU between its two counter reads. The reads are further apart
 * than the host window (the settle pause and the reads themselves), so each
 * service is divided by its own interval on the guest clock.
 */
function idleUsage(
  a: ServiceCounters,
  b: ServiceCounters
): { cpu: number; between: number | null; percent: number | null } {
  const cpu = (b.cpuSeconds ?? 0) - (a.cpuSeconds ?? 0);
  const between =
    a.uptimeSeconds !== null && b.uptimeSeconds !== null
      ? b.uptimeSeconds - a.uptimeSeconds
      : null;
  const percent =
    between !== null && between > 0 ? (cpu / between) * 100 : null;
  return { cpu, between, percent };
}

async function phaseIdle(): Promise<void> {
  log(`settling ${settleSeconds}s before the idle window`);
  await Bun.sleep(settleSeconds * 1000);
  const guestBefore = await guestCounters();
  await Bun.sleep(5000);
  const before = hostSnapshot(true);
  const startedAt = performance.now();
  const samples: Record<string, unknown>[] = [before];
  while ((performance.now() - startedAt) / 1000 < idleSeconds) {
    await Bun.sleep(15_000);
    samples.push(hostSnapshot(false));
  }
  const after = hostSnapshot(true);
  const windowSeconds = (performance.now() - startedAt) / 1000;
  const guestAfter = await guestCounters();
  const status = lane === "native" ? await nativeStatus() : null;
  const delta = (key: string): number =>
    Number(after[key] ?? 0) - Number(before[key] ?? 0);
  const containers: Record<string, unknown> = {};
  let containerCpu = 0;
  let containerMemory = 0;
  for (const service of workload.services) {
    const a = guestBefore.services[service];
    const b = guestAfter.services[service];
    if (!(a && b)) {
      containers[service] = null;
      continue;
    }
    const usage = idleUsage(a, b);
    containerCpu =
      usage.percent === null ? Number.NaN : containerCpu + usage.percent;
    containerMemory += b.memoryCurrentBytes ?? 0;
    containers[service] = {
      ...b,
      idleCpuSeconds: Math.round(usage.cpu * 1000) / 1000,
      betweenReadsSeconds: usage.between,
      idleCpuPercentOfOneCore:
        usage.percent === null ? null : Math.round(usage.percent * 10) / 10,
    };
  }
  const ticks =
    guestBefore.cpuTicks && guestAfter.cpuTicks
      ? {
          busy: guestAfter.cpuTicks.busy - guestBefore.cpuTicks.busy,
          total: guestAfter.cpuTicks.total - guestBefore.cpuTicks.total,
        }
      : null;
  const loads = samples.map((sample) => Number(sample.load1));
  report.idle = {
    windowSeconds: Math.round(windowSeconds),
    loadMedian: median(loads),
    loadMax: Math.max(...loads),
    flagged: Math.max(...loads) > maxLoad,
    host: {
      before,
      after,
      vmCpuPercentOfOneCore:
        Math.round((delta("vmCpuSeconds") / windowSeconds) * 1000) / 10,
      helperCpuPercentOfOneCore:
        Math.round((delta("helperCpuSeconds") / windowSeconds) * 1000) / 10,
      vmSharedWithOtherProjects: lane === "compose",
      otherEngineContainers: lane === "compose" ? engineContainers() : null,
    },
    containers,
    containersCpuPercentOfOneCore: Number.isNaN(containerCpu)
      ? null
      : Math.round(containerCpu * 10) / 10,
    containersMemoryCurrentBytes: containerMemory,
    guest: {
      meminfoKb: guestAfter.meminfoKb,
      // Guest busy share of all guest CPUs; the guest counter window includes the
      // counter reads themselves, so it overstates a quiet guest slightly.
      busyPercentOfAllCpus: ticks
        ? Math.round((ticks.busy / Math.max(ticks.total, 1)) * 1000) / 10
        : null,
    },
    nativeStatus: status,
    samples,
  };
  save();
}

const WATCH_EDITS = 5;
const WATCH_TIMEOUT_MS = 15_000;

type WatchProbe = Route & { readonly label: string };

/** One host edit: seconds until the probe serves it, or null on timeout. */
async function watchEdit(opts: {
  readonly probe: WatchProbe;
  readonly label: string;
  readonly template: string;
  readonly write: (content: string) => void;
}): Promise<number | null> {
  const value = token();
  const loadBefore = load1();
  const started = performance.now();
  opts.write(opts.template.replace("{token}", value));
  let seen = false;
  while (!seen && performance.now() - started < WATCH_TIMEOUT_MS) {
    seen = (await fetchRoute(opts.probe)).text.includes(value);
    if (!seen) {
      await Bun.sleep(25);
    }
  }
  const seconds = (performance.now() - started) / 1000;
  const loadAfter = load1();
  timings.push({
    phase: "watch",
    label: opts.label,
    at: new Date().toISOString(),
    loadBefore,
    loadAfter,
    seconds: Math.round(seconds * 1000) / 1000,
    ok: seen,
    flagged: Math.max(loadBefore, loadAfter) > maxLoad,
  });
  return seen ? seconds : null;
}

/** Puts edited files back; also run when the script is interrupted. */
let restoreWatched: (() => void) | null = null;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    restoreWatched?.();
    process.exit(130);
  });
}

async function phaseWatch(): Promise<void> {
  const watch = workload.watch;
  if (!watch) {
    return;
  }
  const originals = new Map<string, string>();
  for (const probe of watch.probes) {
    const file = join(project, probe.file ?? watch.file);
    originals.set(file, readFileSync(file, "utf8"));
  }
  restoreWatched = () => {
    for (const [file, original] of originals) {
      writeFileSync(file, original);
      rmSync(`${file}.bench-tmp`, { force: true });
    }
  };
  const results: Record<string, unknown> = {};
  try {
    for (const probe of watch.probes) {
      const file = join(project, probe.file ?? watch.file);
      const styles = {
        "in-place": (content: string) => writeFileSync(file, content),
        atomic: (content: string) => {
          writeFileSync(`${file}.bench-tmp`, content);
          renameSync(`${file}.bench-tmp`, file);
        },
      } as const;
      for (const [style, write] of Object.entries(styles)) {
        const samples: number[] = [];
        const before = timings.length;
        for (let index = 0; index < WATCH_EDITS; index += 1) {
          const seconds = await watchEdit({
            probe,
            label: `${probe.label} ${style} ${index + 1}`,
            template: probe.template ?? watch.template,
            write,
          });
          if (seconds !== null) {
            samples.push(seconds);
          }
          await Bun.sleep(1000);
        }
        // Each sample includes the polling requests through the proxy.
        results[`${probe.label} ${style}`] = {
          medianSeconds: median(samples),
          maxSeconds: samples.length > 0 ? Math.max(...samples) : null,
          notServedWithinTimeout: WATCH_EDITS - samples.length,
          of: WATCH_EDITS,
          flaggedForLoad: flaggedSince(before),
        };
        log(
          `watch ${probe.label} ${style}: median ${median(samples)}s, ${WATCH_EDITS - samples.length}/${WATCH_EDITS} not served`
        );
      }
    }
  } finally {
    restoreWatched();
    restoreWatched = null;
  }
  report.watch = { timeoutSeconds: WATCH_TIMEOUT_MS / 1000, results };
  save();
}

/** How many of the timings recorded since `index` were taken above `--max-load`. */
function flaggedSince(index: number): number {
  return timings.slice(index).filter((row) => row.flagged).length;
}

type JobOutcome = JobResult & {
  /** Set when the job could not be started, polled or finished in time. */
  readonly failure?: string;
};

/**
 * Runs a command inside a service as a background job and polls for its exit.
 * One non-interactive exec has a time limit on the native lane, and an exec
 * that gives up leaves the command running; a detached job has neither problem
 * and is timed on the guest clock, so the poll interval does not enter it.
 */
async function serviceJob(
  service: string,
  argv: readonly string[],
  timeoutSeconds: number
): Promise<JobOutcome> {
  const failed = (failure: string, stderr = ""): JobOutcome => ({
    exitCode: -1,
    seconds: 0,
    stdout: "",
    stderr,
    failure,
  });
  if (uncertainServices.has(service)) {
    return failed("skipped: an earlier job in this service may still run");
  }
  const id = token().slice(0, 16);
  const started = await inService(service, jobStartArgv(id, argv), 60);
  if (started.exitCode !== 0) {
    if (execGaveUp(started.stderr)) {
      // The start may have happened; nothing more is measured in this service.
      uncertainServices.add(service);
      return failed("exec gave up at start; the job may run", started.stderr);
    }
    return failed("start failed", started.stderr);
  }
  const deadline = performance.now() + timeoutSeconds * 1000;
  while (performance.now() < deadline) {
    await Bun.sleep(1000);
    const poll = await inService(service, jobPollArgv(id), 60);
    if (poll.exitCode !== 0) {
      // A poll that gave up says nothing about the job; ask again.
      continue;
    }
    try {
      const result = parseJobPoll(id, poll.stdout);
      if (result) {
        return result;
      }
    } catch {
      // A cut-off reply is not a result either; the next poll may be whole.
    }
  }
  uncertainServices.add(service);
  return failed(`no exit within ${timeoutSeconds}s; the job may still run`);
}

/** Services where a job may still be running; a later job there would overlap it. */
const uncertainServices = new Set<string>();

async function phaseTasks(): Promise<void> {
  const results: Record<string, unknown> = {};
  for (const task of workload.tasks ?? []) {
    const samples: number[] = [];
    let first: number | null = null;
    const before = timings.length;
    for (let index = 0; index < (task.runs ?? 3); index += 1) {
      const loadBefore = load1();
      const result = await serviceJob(task.service, task.argv, 1800);
      const loadAfter = load1();
      timings.push({
        phase: "task",
        label: `${task.label} ${index + 1}`,
        at: new Date().toISOString(),
        loadBefore,
        loadAfter,
        seconds: Math.round(result.seconds * 100) / 100,
        ok: result.exitCode === 0,
        flagged: Math.max(loadBefore, loadAfter) > maxLoad,
        ...(result.exitCode === 0
          ? {}
          : { detail: result.failure ?? result.stderr.slice(-400) }),
      });
      if (result.exitCode === 0 && index === 0) {
        first = result.seconds;
      } else if (result.exitCode === 0) {
        samples.push(result.seconds);
      }
      log(
        `${task.label} ${index + 1}: ${result.seconds.toFixed(2)}s ${result.failure ?? `exit ${result.exitCode}`}`
      );
    }
    // The first run of a task can fill a cache the later runs reuse, so it is
    // reported apart, and only when it was the first run that succeeded.
    results[task.label] = {
      firstSeconds: first,
      laterMedianSeconds: median(samples),
      flaggedForLoad: flaggedSince(before),
      of: timings.length - before,
    };
  }
  report.tasks = results;
  save();
}

async function phaseLatency(): Promise<void> {
  const route = workload.latency;
  if (!route) {
    return;
  }
  const count = 200;
  const base = curlArgs(route);
  const url = base.at(-1) ?? "";
  const format = ["--write-out", "%{http_code} %{time_total}\n"];
  const accepted = (stdout: string): number[] => {
    const samples: number[] = [];
    for (const line of stdout.split("\n")) {
      const [status, seconds] = line.split(" ");
      if (accepts(route, Number(status))) {
        samples.push(Number(seconds) * 1000);
      }
    }
    return samples;
  };
  const measure = async (reuse: boolean): Promise<number[]> => {
    if (reuse) {
      // One extra request first: it pays the connection and TLS handshake.
      const transfers = Array.from({ length: count + 1 }, () => [
        "--output",
        "/dev/null",
        url,
      ]).flat();
      const result = await run({
        argv: [...base.slice(0, -1), ...format, ...transfers],
        timeoutSeconds: 300,
      });
      return accepted(result.stdout).slice(1);
    }
    const samples: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const result = await run({
        argv: [...base.slice(0, -1), ...format, "--output", "/dev/null", url],
        timeoutSeconds: 15,
      });
      samples.push(...accepted(result.stdout));
    }
    return samples;
  };
  const summarize = (samples: number[]) => {
    const sorted = [...samples].sort((a, b) => a - b);
    return {
      n: sorted.length,
      of: count,
      medianMs: median(sorted),
      p95Ms: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? null,
      maxMs: sorted.at(-1) ?? null,
    };
  };
  const loadBefore = load1();
  const reused = summarize(await measure(true));
  const fresh = summarize(await measure(false));
  report.latency = {
    route: `${route.host}${route.path}`,
    loadBefore,
    loadAfter: load1(),
    flagged: Math.max(loadBefore, load1()) > maxLoad,
    // One curl process, one connection, 200 requests.
    reusedConnection: reused,
    // One curl process and one TLS handshake per request.
    newConnection: fresh,
  };
  log(
    `latency: reused median ${reused.medianMs}ms, new connection median ${fresh.medianMs}ms`
  );
  save();
}

const IO_SCRIPT = `
set -e
d="$1/.runtime-bench-io"
rm -rf "$d"; mkdir -p "$d"
trap 'rm -rf "$d"' EXIT
now() { cut -d" " -f1 /proc/uptime; }
t0=$(now); dd if=/dev/zero of="$d/big" bs=1M count=512 conv=fsync 2>/dev/null; t1=$(now)
dd if="$d/big" of=/dev/null bs=1M 2>/dev/null; t2=$(now)
i=0; while [ $i -lt 5000 ]; do echo "$i" > "$d/f$i"; i=$((i+1)); done; sync; t3=$(now)
cat "$d"/f* > /dev/null; t4=$(now)
rm -rf "$d"; t5=$(now)
echo "$t0 $t1 $t2 $t3 $t4 $t5"
`;

async function phaseIo(): Promise<void> {
  const io = workload.io;
  if (!io) {
    return;
  }
  const results: Record<string, unknown> = {};
  for (const [kind, path] of [
    ["bindMount", io.bind],
    ["namedVolume", io.volume],
  ] as const) {
    const runs: Record<string, number>[] = [];
    const before = timings.length;
    for (let index = 0; index < 3; index += 1) {
      const loadBefore = load1();
      const result = await serviceJob(
        io.service,
        ["sh", "-c", IO_SCRIPT, "sh", path],
        900
      );
      const stamps = result.stdout.trim().split(/\s+/).map(Number);
      const ok = result.exitCode === 0 && stamps.length === 6;
      timings.push({
        phase: "io",
        label: `${kind} ${index + 1}`,
        at: new Date().toISOString(),
        loadBefore,
        loadAfter: load1(),
        seconds: Math.round(result.seconds * 100) / 100,
        ok,
        flagged: Math.max(loadBefore, load1()) > maxLoad,
        ...(ok ? {} : { detail: result.failure ?? result.stderr.slice(-400) }),
      });
      if (!ok) {
        continue;
      }
      const span = (from: number, to: number): number =>
        (stamps[to] ?? 0) - (stamps[from] ?? 0);
      runs.push({
        write512MibFsyncMibPerSecond: 512 / span(0, 1),
        // The file was just written, so this read is served from the guest page cache.
        readBack512MibMibPerSecond: 512 / span(1, 2),
        create5000SmallFilesSeconds: span(2, 3),
        read5000SmallFilesSeconds: span(3, 4),
        remove5001FilesSeconds: span(4, 5),
      });
    }
    const keys = Object.keys(runs[0] ?? {});
    results[kind] = {
      ...Object.fromEntries(
        keys.map((key) => [
          key,
          Math.round(
            (median(runs.map((entry) => entry[key] ?? 0)) ?? 0) * 1000
          ) / 1000,
        ])
      ),
      completedRuns: runs.length,
      flaggedForLoad: flaggedSince(before),
    };
  }
  report.io = results;
  log(`io: ${JSON.stringify(results)}`);
  save();
}

async function phaseStop(): Promise<void> {
  await timed({
    phase: "stop",
    label: "final down",
    args: ["down"],
    expectReady: false,
    timeoutSeconds: 600,
  });
  // The VM is stopped only when this run booted it: an attached run found the
  // pool running, and other projects may be in it.
  if (lane !== "native" || !(nativeTool && nativeHome) || !bootedHere) {
    return;
  }
  const loadBefore = load1();
  const result = await run({
    argv: [
      nativeTool,
      "--candidate-root",
      nativeHome,
      "runtime",
      "down",
      "--json",
    ],
    timeoutSeconds: 600,
  });
  timings.push({
    phase: "vm-stop",
    label: "runtime down",
    at: new Date().toISOString(),
    loadBefore,
    loadAfter: load1(),
    seconds: Math.round(result.seconds * 100) / 100,
    ok: result.exitCode === 0,
    flagged: Math.max(loadBefore, load1()) > maxLoad,
  });
  await Bun.sleep(3000);
  const left = laneProcesses().vm.length;
  report.providerVmProcessesAfterStop = left;
  if (left > 0) {
    notes.push(
      `${left} provider VM process(es) still running after runtime down`
    );
  }
}

function summarizeTimings(): Record<string, unknown> {
  const groups = new Map<string, Timing[]>();
  for (const timing of timings) {
    // One group per operation: the label without its run number.
    const key = `${timing.phase}: ${timing.label.replace(/ \d+$/, "")}`;
    groups.set(key, [...(groups.get(key) ?? []), timing]);
  }
  const summary: Record<string, unknown> = {};
  for (const [phase, rows] of groups) {
    const admitted = rows.filter((row) => row.ok && !row.flagged);
    summary[phase] = {
      n: rows.length,
      failed: rows.filter((row) => !row.ok).length,
      flaggedForLoad: rows.filter((row) => row.flagged).length,
      admittedMedianSeconds: median(admitted.map((row) => row.seconds)),
      allSeconds: rows.map((row) => row.seconds),
    };
  }
  return summary;
}

/** True once this run performed the first start, so the runtime is its own to stop. */
let bootedHere = false;

function preflight(): void {
  if (!(phases.has("cold") || values.attached)) {
    // Without the cold phase the project was started by someone else, and the
    // warm, restart and stop phases would stop it.
    fail(
      "no cold phase: pass --attached to measure a project that is already running"
    );
  }
  if (
    lane === "native" &&
    phases.has("cold") &&
    hostProcesses().some(isProviderVm)
  ) {
    fail("a provider VM process is already running; one pool at a time");
  }
}

async function main(): Promise<void> {
  preflight();
  const version = await cli(["--version"], 60);
  report.schema = "hack-runtime-footprint/1";
  report.lane = lane;
  report.workload = workload.name;
  report.startedAt = new Date().toISOString();
  report.host = {
    arch: arch(),
    osRelease: release(),
    cpus: cpus().length,
    memoryBytes: totalmem(),
    loadAtStart: load1(),
  };
  report.cli = { version: version.stdout.trim().split("\n")[0] ?? null };
  report.maxLoad = maxLoad;
  report.phases = [...phases];
  save();

  let running = false;
  try {
    if (phases.has("cold")) {
      bootedHere = true;
      running = await phaseStart();
      if (!running) {
        notes.push("first start failed; later phases skipped");
        return;
      }
    } else {
      running = await ready();
      if (!running) {
        fail("the project is not serving its routes; include the cold phase");
      }
      await writeMarker();
    }
    if (phases.has("warm")) {
      await phaseWarm();
    }
    if (phases.has("restart")) {
      await phaseRestart();
    }
    if (phases.has("watch")) {
      await phaseWatch();
    }
    if (phases.has("latency")) {
      await phaseLatency();
    }
    if (phases.has("tasks")) {
      await phaseTasks();
    }
    if (phases.has("io")) {
      await phaseIo();
    }
    if (phases.has("idle")) {
      await phaseIdle();
    }
  } finally {
    if (phases.has("stop") && !values["keep-running"]) {
      await phaseStop();
    }
    report.finishedAt = new Date().toISOString();
    report.summary = summarizeTimings();
    save();
  }
}

await main();
process.stdout.write(`${join(outDir, "result.json")}\n`);
