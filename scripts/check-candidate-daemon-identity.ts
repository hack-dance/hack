#!/usr/bin/env bun
/**
 * Release gate for a built prerelease bundle (HACK-2263): a candidate run
 * must start its own hackd, and that hackd must report the CLI's version.
 *
 * Usage: bun scripts/check-candidate-daemon-identity.ts <bundle-dir> [<version>]
 *
 * For each launcher marker (`hack-next`, as the channel manager sets it, and
 * the bundle's own `hack-v5`), in a fresh temp HOME with a fake stable
 * `hack` first on PATH, it runs `<bundle>/hack-v5 daemon start --json` and
 * asserts that:
 *
 * - the fake stable `hack` was never run;
 * - the started hackd's executable is the bundle's `hack-cli`;
 * - `version --json`, the start result, `daemon status --json` (CLI and
 *   hackd API) all report one version, and it is `<version>` when given.
 *
 * Hermetic: temp HOME and Hack home, `HACK_DAEMON_AUTOSTART_DISABLE=1`, no
 * Docker event watcher, no login service. It stops the hackd it started.
 */
import { realpathSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

type Json = Record<string, unknown>;

const TIMEOUT_MS = 60_000;

function fail(message: string): never {
  throw new Error(message);
}

function record(value: unknown, what: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${what} is not a JSON object`);
  }
  return value as Json;
}

async function runJson(opts: {
  readonly argv: readonly string[];
  readonly env: Record<string, string>;
  readonly cwd: string;
  readonly what: string;
}): Promise<{ readonly exitCode: number; readonly json: Json }> {
  const child = Bun.spawn([...opts.argv], {
    cwd: opts.cwd,
    env: opts.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: TIMEOUT_MS,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    fail(
      `${opts.what}: no JSON on stdout (exit ${exitCode})\nstdout: ${stdout}\nstderr: ${stderr}`
    );
  }
  return { exitCode, json: record(parsed, opts.what) };
}

/** The executable of a running process, by its kernel's own record. */
async function processExecutable(pid: number): Promise<string> {
  if (process.platform === "linux") {
    return await readlink(`/proc/${pid}/exe`);
  }
  const ps = Bun.spawnSync(["/bin/ps", "-o", "comm=", "-p", String(pid)], {
    timeout: 10_000,
  });
  const path = ps.stdout.toString().trim();
  if (ps.exitCode !== 0 || path === "") {
    fail(`pid ${pid} is not running`);
  }
  return path;
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

type RunCli = (
  args: readonly string[],
  what: string
) => Promise<{ readonly exitCode: number; readonly json: Json }>;

/** `version --json`, checked against the release version when given. */
async function readCliVersion(opts: {
  readonly run: RunCli;
  readonly expected: string | null;
}): Promise<string> {
  const version = await opts.run(["version", "--json"], "version --json");
  const cliVersion = record(version.json.data, "version data").version;
  if (typeof cliVersion !== "string") {
    fail("version --json reported no version");
  }
  if (opts.expected !== null && cliVersion !== opts.expected) {
    fail(`CLI reports ${cliVersion}, the release is ${opts.expected}`);
  }
  return cliVersion;
}

/** `daemon status --json`: hackd's API and the CLI report `cliVersion`. */
async function checkStatusAgrees(opts: {
  readonly run: RunCli;
  readonly cliVersion: string;
}): Promise<void> {
  const status = await opts.run(
    ["daemon", "status", "--json"],
    "daemon status"
  );
  if (
    status.exitCode !== 0 ||
    status.json.version !== opts.cliVersion ||
    status.json.cli_version !== opts.cliVersion ||
    status.json.api_compatible !== true
  ) {
    fail(`daemon status disagrees: ${JSON.stringify(status.json)}`);
  }
}

async function checkOne(opts: {
  readonly bundle: string;
  readonly marker: "hack-next" | "hack-v5";
  readonly expectedVersion: string | null;
}): Promise<string> {
  // A short root: hackd's unix socket path must fit the platform limit.
  const root = realpathSync(await mkdtemp("/tmp/hack-cdi-"));
  const launcher = join(opts.bundle, "hack-v5");
  const cli = realpathSync(join(opts.bundle, "hack-cli"));
  const stableLog = join(root, "stable-hack.log");
  const stableBin = join(root, "stable-bin");
  const home = join(root, "home");
  // hackd refuses a state directory other users could write (umask aside).
  for (const dir of [home, stableBin]) {
    await mkdir(dir, { mode: 0o700 });
    await chmod(dir, 0o700);
  }
  // The fake stable `hack`: it records any call and starts nothing.
  await writeFile(
    join(stableBin, "hack"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${stableLog}"\nexit 0\n`,
    { mode: 0o755 }
  );
  const env: Record<string, string> = {
    HOME: home,
    PATH: `${stableBin}:/usr/bin:/bin`,
    TMPDIR: root,
    LANG: "C",
    NO_COLOR: "1",
    HACK_LOGGER: "console",
    HACK_NO_INTERACTIVE: "1",
    HACK_DAEMON_AUTOSTART_DISABLE: "1",
    HACK_DAEMON_DISABLE_DOCKER_EVENTS: "1",
    ...(opts.marker === "hack-next"
      ? { HACK_CANDIDATE_ENTRYPOINT: "hack-next" }
      : {}),
  };
  const run: RunCli = (args, what) =>
    runJson({ argv: [launcher, ...args], env, cwd: root, what });
  let startedPid: number | null = null;
  try {
    const cliVersion = await readCliVersion({
      run,
      expected: opts.expectedVersion,
    });

    const start = await run(["daemon", "start", "--json"], "daemon start");
    const startData = record(
      start.json.data ?? record(start.json.error, "start error").detail,
      "daemon start data"
    );
    const daemon = record(startData.daemon, "daemon start observation");
    if (typeof daemon.pid === "number") {
      startedPid = daemon.pid;
    }
    const stableCalls = await readFile(stableLog, "utf8").catch(() => "");
    if (stableCalls !== "") {
      fail(`the stable hack on PATH was run: ${stableCalls.trim()}`);
    }
    if (start.exitCode !== 0 || start.json.ok !== true) {
      fail(`daemon start failed: ${JSON.stringify(start.json)}`);
    }
    if (startedPid === null) {
      fail("daemon start reported no pid");
    }
    const executable = realpathOrSelf(await processExecutable(startedPid));
    if (executable !== cli) {
      fail(`hackd pid ${startedPid} runs ${executable}, not ${cli}`);
    }
    if (daemon.version !== cliVersion || startData.cli_version !== cliVersion) {
      fail(
        `daemon start: hackd ${String(daemon.version)}, CLI ${String(startData.cli_version)}, version --json ${cliVersion}`
      );
    }

    await checkStatusAgrees({ run, cliVersion });
    return `${opts.marker}: hackd pid ${startedPid} runs the bundle's hack-cli; CLI and hackd report ${cliVersion}`;
  } finally {
    await runJson({
      argv: [launcher, "daemon", "stop", "--json"],
      env,
      cwd: root,
      what: "daemon stop",
    }).catch(() => undefined);
    if (startedPid !== null) {
      // Only a process proven to run this bundle's hack-cli is signalled.
      const still = await processExecutable(startedPid).catch(() => null);
      if (still !== null && realpathOrSelf(still) === cli) {
        process.kill(startedPid, "SIGKILL");
      }
    }
    await rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const [bundleArg, versionArg] = process.argv.slice(2);
  if (!bundleArg) {
    fail(
      "Usage: bun scripts/check-candidate-daemon-identity.ts <bundle-dir> [<version>]"
    );
  }
  const bundle = realpathSync(resolve(bundleArg));
  const expectedVersion =
    versionArg && versionArg.trim() !== "" ? versionArg.trim() : null;
  for (const marker of ["hack-next", "hack-v5"] as const) {
    console.log(await checkOne({ bundle, marker, expectedVersion }));
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(
      `candidate daemon identity check failed: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  });
}
