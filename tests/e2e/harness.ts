import type { Dirent } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Core end-to-end harness for the hack CLI.
 *
 * Every scenario drives the ACTUAL working-tree CLI by spawning
 * `bun <repoRoot>/index.ts <args>` (non-TTY by design — this is the
 * agent-reality surface we are testing) against disposable fixture repos.
 *
 * Isolation model: every CLI invocation runs with `HACK_HOME=<tempdir>` so
 * global state (projects registry, global config) never touches the real
 * `~/.hack`. The CLI must honor `HACK_HOME`; `runIsolationCanary` verifies
 * that before any scenario runs and the whole suite aborts if it does not.
 */

/** Absolute path to the repo root (tests/e2e/harness.ts → ../..). */
export const REPO_ROOT = resolve(import.meta.dir, "..", "..");

/** CLI entrypoint spawned for every scenario command. */
export const CLI_ENTRYPOINT = resolve(REPO_ROOT, "index.ts");

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const REGISTRY_SCAN_MAX_DEPTH = 6;
const OUTPUT_EXCERPT_LIMIT = 2000;

/** Environment keys forwarded from the parent process into CLI invocations. */
const PASSTHROUGH_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "USER",
  "SHELL",
  "LANG",
  "LC_ALL",
  "DOCKER_HOST",
  "DOCKER_CONFIG",
] as const;

export type CliResult = {
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** stdout followed by stderr, for loose content assertions. */
  readonly combined: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
};

export type CliInvocation = {
  readonly args: readonly string[];
  readonly cwd: string;
  /** Extra env entries layered on top of the isolated base env. */
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
};

export type ScenarioTier = "local" | "docker";

export type ScenarioContext = {
  readonly repoRoot: string;
  /** Per-scenario isolated HACK_HOME directory. */
  readonly hackHome: string;
  /** Per-scenario temp root for fixtures; removed after the scenario. */
  readonly tempRoot: string;
  /** Run the working-tree CLI with the isolated env. */
  readonly cli: (invocation: CliInvocation) => Promise<CliResult>;
  /** Structured progress log line (plain text, no colors). */
  readonly log: (message: string) => void;
  /** Abort the scenario as skipped (does not fail the suite). */
  readonly skip: (reason: string) => never;
};

export type Scenario = {
  readonly name: string;
  readonly tier: ScenarioTier;
  readonly summary: string;
  readonly run: (ctx: ScenarioContext) => Promise<void>;
};

export type ScenarioOutcome = {
  readonly name: string;
  readonly tier: ScenarioTier;
  readonly status: "pass" | "fail" | "skip";
  readonly durationMs: number;
  readonly reason: string | null;
};

/** Thrown by ctx.skip to mark a scenario as skipped instead of failed. */
export class ScenarioSkip extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ScenarioSkip";
  }
}

/** Thrown by assertion helpers with enough context to debug from the summary. */
export class ScenarioAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioAssertionError";
  }
}

/**
 * Assert a condition inside a scenario, failing with a plain-text message.
 */
export function expect(opts: {
  readonly that: boolean;
  readonly message: string;
  readonly result?: CliResult;
}): void {
  if (opts.that) {
    return;
  }
  const details = opts.result ? `\n${formatCliResult(opts.result)}` : "";
  throw new ScenarioAssertionError(`${opts.message}${details}`);
}

/**
 * Assert a CLI invocation exited with one of the accepted codes.
 */
export function expectExit(opts: {
  readonly result: CliResult;
  readonly codes: readonly number[];
  readonly message: string;
}): void {
  expect({
    that: !opts.result.timedOut && opts.codes.includes(opts.result.exitCode),
    message: `${opts.message} (expected exit ${opts.codes.join("|")}, got ${
      opts.result.timedOut ? "timeout" : opts.result.exitCode
    })`,
    result: opts.result,
  });
}

/**
 * Extract the first parseable JSON object from CLI stdout. Tolerates notice
 * lines around the payload (the CLI logs notices to stderr, but stay lenient).
 */
export function extractJsonObject<T = Record<string, unknown>>(opts: {
  readonly text: string;
}): T | null {
  const trimmed = opts.text.trim();
  const direct = tryParseJson<T>({ text: trimmed });
  if (direct !== null) {
    return direct;
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  return tryParseJson<T>({ text: trimmed.slice(start, end + 1) });
}

function tryParseJson<T>(opts: { readonly text: string }): T | null {
  try {
    return JSON.parse(opts.text) as T;
  } catch {
    return null;
  }
}

function formatCliResult(result: CliResult): string {
  return [
    `command: ${result.command}`,
    `exit: ${result.timedOut ? "timeout" : result.exitCode}`,
    `stdout:\n${truncate({ text: result.stdout })}`,
    `stderr:\n${truncate({ text: result.stderr })}`,
  ].join("\n");
}

function truncate(opts: { readonly text: string }): string {
  const trimmed = opts.text.trimEnd();
  if (trimmed.length <= OUTPUT_EXCERPT_LIMIT) {
    return trimmed;
  }
  return `${trimmed.slice(0, OUTPUT_EXCERPT_LIMIT)}\n... [truncated]`;
}

/**
 * Build the isolated environment for a CLI invocation.
 *
 * Only a small allowlist of parent env vars is forwarded; everything hack
 * reads globally is redirected through HACK_HOME. Interactive and color
 * surfaces are disabled so output is stable for assertions.
 */
export function buildCliEnv(opts: {
  readonly hackHome: string;
  readonly extra?: Readonly<Record<string, string>>;
}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === "string" && value.length > 0) {
      env[key] = value;
    }
  }
  env.HACK_HOME = opts.hackHome;
  env.HACK_SETUP_SYNC_MODE = "off";
  env.HACK_NO_INTERACTIVE = "1";
  env.NO_COLOR = "1";
  env.CLICOLOR = "0";
  env.TERM = "dumb";
  return { ...env, ...(opts.extra ?? {}) };
}

/**
 * Seed a fresh isolated HACK_HOME:
 * - `controlPlane.daemon.autoStart=false` so read commands never spawn a
 *   hackd daemon against the throwaway home (a daemon grandchild would also
 *   outlive the scenario).
 * - an `e2e_probe` sentinel equal to the HACK_HOME path, which the isolation
 *   canary reads back via `hack config get --global e2e_probe`.
 */
export async function seedIsolatedHackHome(opts: {
  readonly hackHome: string;
}): Promise<void> {
  const config = {
    $schema: "https://schemas.hack/hack.config.schema.json",
    e2e_probe: opts.hackHome,
    controlPlane: {
      daemon: { autoStart: false },
    },
  };
  await mkdir(opts.hackHome, { recursive: true });
  await Bun.write(
    join(opts.hackHome, "hack.config.json"),
    `${JSON.stringify(config, null, 2)}\n`
  );
}

let outputCaptureCounter = 0;

/**
 * Spawn the working-tree CLI (`bun index.ts <args>`) with stdin closed so any
 * unexpected prompt fails fast instead of hanging. stdout/stderr are captured
 * via temp files (not pipes) so a spawned grandchild (e.g. a daemon) can
 * never hold the capture open past the CLI's own exit.
 */
export async function runCli(opts: {
  readonly invocation: CliInvocation;
  readonly hackHome: string;
}): Promise<CliResult> {
  const env = buildCliEnv({
    hackHome: opts.hackHome,
    extra: opts.invocation.env,
  });
  const command = `hack ${opts.invocation.args.join(" ")}`;
  const timeoutMs = opts.invocation.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const startedAt = Date.now();

  outputCaptureCounter += 1;
  const captureDir = join(opts.hackHome, ".e2e-capture");
  await mkdir(captureDir, { recursive: true });
  const stdoutPath = join(captureDir, `${outputCaptureCounter}.out`);
  const stderrPath = join(captureDir, `${outputCaptureCounter}.err`);

  const proc = Bun.spawn(["bun", CLI_ENTRYPOINT, ...opts.invocation.args], {
    cwd: opts.invocation.cwd,
    env,
    stdin: "ignore",
    stdout: Bun.file(stdoutPath),
    stderr: Bun.file(stderrPath),
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  const exitCode = await proc.exited;
  clearTimeout(timer);

  const stdout = await readCapture({ path: stdoutPath });
  const stderr = await readCapture({ path: stderrPath });

  return {
    command,
    exitCode,
    stdout,
    stderr,
    combined: `${stdout}\n${stderr}`,
    timedOut,
    durationMs: Date.now() - startedAt,
  };
}

async function readCapture(opts: { readonly path: string }): Promise<string> {
  try {
    const file = Bun.file(opts.path);
    if (!(await file.exists())) {
      return "";
    }
    return await file.text();
  } catch {
    return "";
  }
}

/**
 * Run a plain shell command (git, docker, ...) inside the harness.
 */
export async function runCommand(opts: {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}): Promise<CliResult> {
  const proc = Bun.spawn([...opts.argv], {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const startedAt = Date.now();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return {
    command: opts.argv.join(" "),
    exitCode,
    stdout,
    stderr,
    combined: `${stdout}\n${stderr}`,
    timedOut,
    durationMs: Date.now() - startedAt,
  };
}

/** Create a fresh temp directory for a scenario or the canary. */
export async function makeTempDir(opts: {
  readonly prefix: string;
}): Promise<string> {
  return await mkdtemp(join(tmpdir(), `${opts.prefix}-`));
}

/**
 * Recursively find files with a given basename under a root (bounded depth).
 * Used to locate the projects registry regardless of the exact layout the
 * CLI chooses under HACK_HOME.
 */
export async function findFilesByName(opts: {
  readonly root: string;
  readonly basename: string;
  readonly maxDepth?: number;
}): Promise<string[]> {
  const found: string[] = [];
  const maxDepth = opts.maxDepth ?? REGISTRY_SCAN_MAX_DEPTH;

  async function listDir(dir: string): Promise<Dirent[]> {
    try {
      return await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  }

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) {
      return;
    }
    for (const entry of await listDir(dir)) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path, depth + 1);
      } else if (entry.name === opts.basename) {
        found.push(path);
      }
    }
  }

  await walk(opts.root, 0);
  return found;
}

export type IsolationCanaryResult =
  | { readonly ok: true; readonly registryPath: string }
  | { readonly ok: false; readonly message: string };

/**
 * Fail-fast isolation canary. Runs before any scenario.
 *
 * Probe A (read-only): the isolated HACK_HOME is seeded with a global config
 * containing an `e2e_probe` sentinel whose value is the HACK_HOME path;
 * `hack config get --global e2e_probe` must echo it back. If the CLI instead
 * reads the real ~/.hack config the sentinel is absent and we abort without
 * ever having written anything outside the temp dirs.
 *
 * Probe B (write, only after A passes): register a throwaway canary project
 * via `hack config get name` and assert (1) the canary name does NOT appear
 * in the real ~/.hack/projects.json (targeted removal + abort if it does)
 * and (2) a projects.json containing the canary appeared under HACK_HOME.
 */
export async function runIsolationCanary(): Promise<IsolationCanaryResult> {
  const hackHome = await makeTempDir({ prefix: "hack-e2e-canary-home" });
  const workDir = await makeTempDir({ prefix: "hack-e2e-canary-work" });
  await seedIsolatedHackHome({ hackHome });

  try {
    const probeA = await runCli({
      hackHome,
      invocation: {
        args: ["config", "get", "--global", "e2e_probe"],
        cwd: workDir,
      },
    });
    if (probeA.timedOut) {
      return {
        ok: false,
        message: `Isolation canary timed out running 'hack config get --global e2e_probe'.\n${formatCliResult(probeA)}`,
      };
    }
    if (probeA.exitCode !== 0 || !probeA.combined.includes(hackHome)) {
      return {
        ok: false,
        message: [
          "HACK_HOME isolation is NOT honored by the CLI.",
          `Probe: 'hack config get --global e2e_probe' with HACK_HOME=${hackHome}`,
          "Expected the CLI to read the seeded global config under HACK_HOME and echo the sentinel value.",
          "This suite refuses to run because scenarios would read/write the real ~/.hack (projects registry pollution).",
          "Fix: land the HACK_HOME override in src/lib/config-paths.ts + src/lib/projects-registry.ts (worktree-ax-overhaul Phase 5), then re-run.",
          formatCliResult(probeA),
        ].join("\n"),
      };
    }

    return await runRegistryWriteProbe({ hackHome, workDir });
  } finally {
    await rm(hackHome, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  }
}

async function runRegistryWriteProbe(opts: {
  readonly hackHome: string;
  readonly workDir: string;
}): Promise<IsolationCanaryResult> {
  const realRegistryPath = resolve(
    process.env.HOME ?? homedir(),
    ".hack",
    "projects.json"
  );

  const canaryName = `hack-e2e-canary-${randomHex()}`;
  const projectRoot = join(opts.workDir, canaryName);
  await writeCanaryProject({ projectRoot, name: canaryName });

  const probeB = await runCli({
    hackHome: opts.hackHome,
    invocation: { args: ["config", "get", "name"], cwd: projectRoot },
  });

  // Precise leak check: the canary name appearing in the REAL registry is
  // the pollution signal. (Whole-content comparison would race with
  // legitimate concurrent hack usage on a live dev machine.)
  const after = await readTextIfExists({ path: realRegistryPath });
  if (after?.includes(canaryName) === true) {
    await removeRegistryEntriesByName({
      registryPath: realRegistryPath,
      name: canaryName,
    });
    return {
      ok: false,
      message: [
        "HACK_HOME isolation leak: the canary project was registered in the REAL ~/.hack/projects.json while HACK_HOME was set.",
        `Canary project: ${projectRoot}`,
        "The canary entry was removed best-effort. Aborting the run.",
        formatCliResult(probeB),
      ].join("\n"),
    };
  }

  const registries = await findFilesByName({
    root: opts.hackHome,
    basename: "projects.json",
  });
  const registryPath = await findRegistryContaining({
    paths: registries,
    needle: canaryName,
  });
  if (registryPath === null) {
    return {
      ok: false,
      message: [
        "HACK_HOME isolation is incomplete: the canary project registration never appeared under HACK_HOME.",
        `Searched for projects.json under ${opts.hackHome} containing "${canaryName}".`,
        "The registry write path (src/lib/projects-registry.ts) likely does not honor HACK_HOME yet.",
        formatCliResult(probeB),
      ].join("\n"),
    };
  }

  return { ok: true, registryPath };
}

/**
 * Targeted cleanup for a detected leak: drop registry entries with the given
 * name while preserving everything else (no whole-file snapshot restore, so
 * concurrent legitimate writes are never clobbered).
 */
async function removeRegistryEntriesByName(opts: {
  readonly registryPath: string;
  readonly name: string;
}): Promise<void> {
  try {
    const text = await readTextIfExists({ path: opts.registryPath });
    if (text === null) {
      return;
    }
    const parsed = JSON.parse(text) as {
      projects?: { name?: string }[];
    } & Record<string, unknown>;
    if (!Array.isArray(parsed.projects)) {
      return;
    }
    parsed.projects = parsed.projects.filter(
      (entry) => entry?.name !== opts.name
    );
    await Bun.write(opts.registryPath, `${JSON.stringify(parsed, null, 2)}\n`);
  } catch {
    // best-effort cleanup; the run is aborting anyway
  }
}

async function findRegistryContaining(opts: {
  readonly paths: readonly string[];
  readonly needle: string;
}): Promise<string | null> {
  for (const path of opts.paths) {
    const text = await readTextIfExists({ path });
    if (text?.includes(opts.needle)) {
      return path;
    }
  }
  return null;
}

async function writeCanaryProject(opts: {
  readonly projectRoot: string;
  readonly name: string;
}): Promise<void> {
  const hackDir = join(opts.projectRoot, ".hack");
  await mkdir(hackDir, { recursive: true });
  const config = {
    $schema: "https://schemas.hack/hack.config.schema.json",
    name: opts.name,
    dev_host: `${opts.name}.hack`,
  };
  await Bun.write(
    join(hackDir, "hack.config.json"),
    `${JSON.stringify(config, null, 2)}\n`
  );
  await Bun.write(
    join(hackDir, "docker-compose.yml"),
    ["services: {}", ""].join("\n")
  );
  await runCommand({
    argv: ["git", "init", "-q", "-b", "main"],
    cwd: opts.projectRoot,
  });
}

async function readTextIfExists(opts: {
  readonly path: string;
}): Promise<string | null> {
  try {
    const file = Bun.file(opts.path);
    if (!(await file.exists())) {
      return null;
    }
    return await file.text();
  } catch {
    return null;
  }
}

function randomHex(): string {
  return Math.random().toString(16).slice(2, 10);
}

export type RunScenariosOptions = {
  readonly scenarios: readonly Scenario[];
  readonly dockerEnabled: boolean;
  readonly only?: readonly string[];
  readonly keepTempDirs?: boolean;
};

/**
 * Run scenarios sequentially, printing a plain-text progress log and a final
 * summary table. Returns the outcomes; the caller decides the exit code.
 */
export async function runScenarios(
  opts: RunScenariosOptions
): Promise<ScenarioOutcome[]> {
  const outcomes: ScenarioOutcome[] = [];
  const selected = opts.scenarios.filter(
    (scenario) =>
      !opts.only || opts.only.length === 0 || opts.only.includes(scenario.name)
  );

  for (const scenario of selected) {
    const startedAt = Date.now();

    if (scenario.tier === "docker" && !opts.dockerEnabled) {
      outcomes.push({
        name: scenario.name,
        tier: scenario.tier,
        status: "skip",
        durationMs: 0,
        reason: "docker tier disabled (set HACK_E2E_DOCKER=1 to enable)",
      });
      printOutcome(outcomes.at(-1) as ScenarioOutcome);
      continue;
    }

    const hackHome = await makeTempDir({ prefix: "hack-e2e-home" });
    const tempRoot = await makeTempDir({ prefix: "hack-e2e-fixture" });
    await seedIsolatedHackHome({ hackHome });
    const ctx: ScenarioContext = {
      repoRoot: REPO_ROOT,
      hackHome,
      tempRoot,
      cli: (invocation) => runCli({ invocation, hackHome }),
      log: (message) => {
        process.stdout.write(`  [${scenario.name}] ${message}\n`);
      },
      skip: (reason) => {
        throw new ScenarioSkip(reason);
      },
    };

    process.stdout.write(`-- ${scenario.name} (${scenario.tier}) --\n`);
    let outcome: ScenarioOutcome;
    try {
      await scenario.run(ctx);
      outcome = {
        name: scenario.name,
        tier: scenario.tier,
        status: "pass",
        durationMs: Date.now() - startedAt,
        reason: null,
      };
    } catch (error: unknown) {
      outcome =
        error instanceof ScenarioSkip
          ? {
              name: scenario.name,
              tier: scenario.tier,
              status: "skip",
              durationMs: Date.now() - startedAt,
              reason: error.message,
            }
          : {
              name: scenario.name,
              tier: scenario.tier,
              status: "fail",
              durationMs: Date.now() - startedAt,
              reason: error instanceof Error ? error.message : String(error),
            };
    } finally {
      if (opts.keepTempDirs !== true) {
        await rm(tempRoot, { recursive: true, force: true });
        await rm(hackHome, { recursive: true, force: true });
      }
    }
    outcomes.push(outcome);
    printOutcome(outcome);
  }

  printSummary({ outcomes });
  return outcomes;
}

function printOutcome(outcome: ScenarioOutcome): void {
  const seconds = (outcome.durationMs / 1000).toFixed(1);
  const suffix = outcome.reason ? ` — ${firstLine(outcome.reason)}` : "";
  process.stdout.write(
    `${outcome.status.toUpperCase().padEnd(4)} ${outcome.name} (${seconds}s)${suffix}\n\n`
  );
}

function printSummary(opts: {
  readonly outcomes: readonly ScenarioOutcome[];
}): void {
  const nameWidth = Math.max(
    8,
    ...opts.outcomes.map((outcome) => outcome.name.length)
  );
  process.stdout.write("== hack e2e summary ==\n");
  process.stdout.write(
    `${"scenario".padEnd(nameWidth)}  tier    status  detail\n`
  );
  for (const outcome of opts.outcomes) {
    const detail =
      outcome.status === "pass"
        ? `${(outcome.durationMs / 1000).toFixed(1)}s`
        : firstLine(outcome.reason ?? "");
    process.stdout.write(
      `${outcome.name.padEnd(nameWidth)}  ${outcome.tier.padEnd(6)}  ${outcome.status.padEnd(6)}  ${detail}\n`
    );
  }
  const passed = opts.outcomes.filter((o) => o.status === "pass").length;
  const failed = opts.outcomes.filter((o) => o.status === "fail").length;
  const skipped = opts.outcomes.filter((o) => o.status === "skip").length;
  process.stdout.write(
    `\ntotal=${opts.outcomes.length} pass=${passed} fail=${failed} skip=${skipped}\n`
  );
  for (const outcome of opts.outcomes) {
    if (outcome.status === "fail" && outcome.reason) {
      process.stdout.write(`\n--- failure: ${outcome.name} ---\n`);
      process.stdout.write(`${outcome.reason}\n`);
    }
  }
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0] ?? "";
}
