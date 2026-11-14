import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PROJECT_ENV_KEY_FILENAME } from "../src/constants.ts";
import { setProjectEnvValue } from "../src/lib/project-env-config.ts";
import { privateCliEnv, privateCliHome } from "./helpers/private-cli-env.ts";

/**
 * HACK-2218: `hack up`, `down` and `restart` append to the activity log and
 * `hack activity --json` reads it back. A stub `docker` stands in for the
 * engine. Every value is a synthetic canary that must never reach the log.
 */
const CANARY = "activity-synthetic-canary";
const SECRET_VALUE = `${CANARY}-secret-value`;
const CLI = resolve(import.meta.dir, "..", "index.ts");

let root: string;
let projectRoot: string;
let hackHome: string;

const STUB = [
  "#!/bin/sh",
  'if [ "$1" = "compose" ]; then',
  '  case " $* " in',
  '    *" up "*)',
  '      if [ "${STUB_FAIL_UP:-}" = "1" ]; then exit 42; fi',
  "      exit 0",
  "      ;;",
  '    *" ps "*)',
  '      if [ "${STUB_WORKER_EXITED:-}" = "1" ]; then',
  '        printf "%s\\n" \'{"ID":"fixture-web","Service":"web","State":"running","ExitCode":0}\' \'{"ID":"fixture-worker","Service":"worker","State":"exited","ExitCode":1}\'',
  "      else",
  '        printf "%s\\n" \'{"ID":"fixture-web","Service":"web","State":"running","ExitCode":0}\' \'{"ID":"fixture-worker","Service":"worker","State":"running","ExitCode":0}\'',
  "      fi",
  "      exit 0",
  "      ;;",
  "    *) exit 0 ;;",
  "  esac",
  "fi",
  "exit 0",
  "",
].join("\n");

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "hack-activity-cli-")));
  projectRoot = join(root, "project");
  hackHome = join(privateCliHome(root), ".hack");
  const hackDir = join(projectRoot, ".hack");
  await mkdir(hackDir, { recursive: true });
  await mkdir(join(root, "bin"));
  await writeFile(join(root, "bin", "docker"), STUB);
  await chmod(join(root, "bin", "docker"), 0o755);
  await writeFile(
    join(hackDir, "hack.config.json"),
    `${JSON.stringify({
      name: "activityshop",
      dev_host: "activityshop.hack",
      internal: { dns: false, tls: false },
      logs: { follow_backend: "compose", snapshot_backend: "compose" },
    })}\n`
  );
  await writeFile(
    join(hackDir, "docker-compose.yml"),
    [
      "services:",
      "  web:",
      "    image: alpine:3.22",
      "  worker:",
      "    image: alpine:3.22",
      "",
    ].join("\n")
  );
  await writeFile(join(projectRoot, PROJECT_ENV_KEY_FILENAME), "synthetic-key");
  await setProjectEnvValue({
    projectRoot,
    projectDir: hackDir,
    envName: null,
    scope: "global",
    key: "SECRET_TOKEN",
    value: SECRET_VALUE,
    secret: true,
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function runCli(opts: {
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, CLI, ...opts.args], {
    cwd: projectRoot,
    env: privateCliEnv({
      root,
      env: {
        PATH: `${join(root, "bin")}:/usr/bin:/bin`,
        HACK_NO_INTERACTIVE: "1",
        // A value-bearing variable of the caller's own: never recorded.
        CALLER_TOKEN: `${CANARY}-caller-env`,
        ...opts.env,
      },
    }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

type Entry = Record<string, unknown>;

async function activity(args: readonly string[] = []): Promise<Entry[]> {
  const result = await runCli({ args: ["activity", "--json", ...args] });
  expect(result.exitCode).toBe(0);
  const envelope = JSON.parse(result.stdout) as {
    ok: boolean;
    data: { version: number; entries: Entry[] };
  };
  expect(envelope.ok).toBe(true);
  expect(envelope.data.version).toBe(1);
  return envelope.data.entries;
}

test("up, a failed up, restart and down are recorded with names only", async () => {
  expect((await runCli({ args: ["up", "--json"] })).exitCode).toBe(0);
  const failed = await runCli({
    args: ["up", "--json"],
    env: { STUB_WORKER_EXITED: "1", HACK_ORIGIN: "app" },
  });
  expect(failed.exitCode).not.toBe(0);
  expect(
    (await runCli({ args: ["restart", "--json"], env: { HACK_ORIGIN: "x" } }))
      .exitCode
  ).toBe(0);
  expect((await runCli({ args: ["down", "--json"] })).exitCode).toBe(0);

  const entries = await activity();
  expect(entries.map((e) => [e.action, e.outcome, e.origin])).toEqual([
    ["down", "ok", "cli"],
    ["restart", "ok", "cli"],
    ["up", "failed", "app"],
    ["up", "ok", "cli"],
  ]);
  for (const entry of entries) {
    expect(entry.project).toBe("activityshop");
    expect(entry.branch).toBeNull();
    expect(typeof entry.duration_ms).toBe("number");
  }
  expect(entries[2]?.failed_services).toEqual(["worker"]);
  expect(await activity(["--project", "other"])).toEqual([]);
  expect(await activity(["--limit", "1"])).toHaveLength(1);

  // Sentinel: no value, env value, path or command line is at rest.
  const path = join(hackHome, "activity.jsonl");
  expect((await lstat(path)).mode & 0o777).toBe(0o600);
  const text = await readFile(path, "utf8");
  for (const forbidden of [
    CANARY,
    "SECRET_TOKEN",
    "CALLER_TOKEN",
    root,
    "--json",
    "docker",
    "compose",
    "alpine",
  ]) {
    expect(text).not.toContain(forbidden);
  }
});

test("a write failure does not change the exit code or the envelope", async () => {
  const baseline = await runCli({ args: ["up", "--json"] });
  expect(baseline.exitCode).toBe(0);
  // The log path is a directory: every write fails.
  const path = join(hackHome, "activity.jsonl");
  await rm(path, { force: true });
  await mkdir(path);
  const up = await runCli({ args: ["up", "--json"] });
  expect(up.exitCode).toBe(baseline.exitCode);
  expect(JSON.parse(up.stdout).ok).toBe(true);
  const failed = await runCli({
    args: ["up", "--json"],
    env: { STUB_FAIL_UP: "1" },
  });
  expect(failed.exitCode).not.toBe(0);
  expect(JSON.parse(failed.stdout).ok).toBe(false);
  // The reader reports the unreadable log instead of an empty history.
  const read = await runCli({ args: ["activity", "--json"] });
  expect(read.exitCode).toBe(1);
  expect(JSON.parse(read.stdout).error.code).toBe("E_PATH_CONFLICT");
});

test("native lifecycle commands write the same records", async () => {
  const nativeHome = join(root, "native-home");
  await mkdir(nativeHome, { mode: 0o700 });
  const binary = join(root, "native-runtime");
  // A stopped runtime: every request answers with a closed code and exit 1.
  await writeFile(
    binary,
    `#!/bin/sh\nprintf '%s' '{"code":"runtime_not_running"}' >&2\nexit 1\n`,
    { mode: 0o700 }
  );
  const env = {
    HACK_RUNTIME_BACKEND: "native",
    HACK_NATIVE_BINARY: binary,
    HACK_NATIVE_HOME: nativeHome,
    HACK_ORIGIN: "agent",
  };
  const results: number[] = [];
  for (const action of ["down", "up"]) {
    const result = await runCli({
      args: ["--path", projectRoot, "--branch", "alpha", action, "--json"],
      env,
    });
    results.push(result.exitCode);
    expect(result.stdout + result.stderr).not.toContain(CANARY);
  }
  const entries = await activity();
  expect(entries.map((e) => [e.action, e.origin, e.branch])).toEqual([
    ["up", "agent", "alpha"],
    ["down", "agent", "alpha"],
  ]);
  expect(entries.map((e) => e.outcome)).toEqual(
    [...results].reverse().map((code) => (code === 0 ? "ok" : "failed"))
  );
  const text = await readFile(join(hackHome, "activity.jsonl"), "utf8");
  expect(text).not.toContain(CANARY);
  expect(text).not.toContain(root);
});
