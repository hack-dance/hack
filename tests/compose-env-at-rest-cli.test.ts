import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PROJECT_ENV_KEY_FILENAME } from "../src/constants.ts";
import { renderManagedComposeEnvOverride } from "../src/lib/compose-managed-env.ts";
import {
  setProjectEnvValue,
  unsetProjectEnvValue,
} from "../src/lib/project-env-config.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/**
 * HACK-1273: the Compose backend must not leave decrypted env values at rest
 * in `.hack/.internal/compose.env.override.yml`, whatever way `up` ends. A
 * stub `docker` stands in for the engine; it records what Compose would read
 * (the override bytes and its process env) so the test can prove the values
 * were still delivered. Every value is a synthetic canary.
 */
const CANARY = "g5-synthetic-canary";
const SECRET_VALUE = `${CANARY}-secret-value`;
const PLAIN_VALUE = `${CANARY}-web-only`;
const CLI = resolve(import.meta.dir, "..", "index.ts");

let root: string;
let projectRoot: string;
let capture: string;
let overridePath: string;

const STUB = [
  "#!/bin/sh",
  'printf "%s\\n" "$*" >> "$STUB_CAPTURE/docker-args.log"',
  'if [ "$1" = "compose" ]; then',
  '  case " $* " in',
  '    *" up "*)',
  '      prev=""',
  '      for arg in "$@"; do',
  '        if [ "$prev" = "-f" ]; then',
  '          case "$arg" in',
  '            *compose.env.override.yml) cp "$arg" "$STUB_CAPTURE/override-at-up.yml" ;;',
  "          esac",
  "        fi",
  '        prev="$arg"',
  "      done",
  // Delivery evidence only: the synthetic values Compose would interpolate.
  '      env > "$STUB_CAPTURE/compose-process-env.txt"',
  '      if [ "${STUB_BLOCK_UP:-}" = "1" ]; then',
  '        parent="$PPID"',
  '        : > "$STUB_CAPTURE/up-started"',
  '        while kill -0 "$parent" 2>/dev/null; do sleep 0.1; done',
  "        exit 143",
  "      fi",
  '      if [ "${STUB_FAIL_UP:-}" = "1" ]; then exit 42; fi',
  "      exit 0",
  "      ;;",
  '    *" ps "*)',
  '      printf "%s\\n" \'{"Service":"web","State":"running","ExitCode":0}\' \'{"Service":"worker","State":"running","ExitCode":0}\'',
  "      exit 0",
  "      ;;",
  "    *) exit 0 ;;",
  "  esac",
  "fi",
  "exit 0",
  "",
].join("\n");

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "hack-env-at-rest-")));
  projectRoot = join(root, "project");
  capture = join(root, "capture");
  const hackDir = join(projectRoot, ".hack");
  overridePath = join(hackDir, ".internal", "compose.env.override.yml");
  await mkdir(hackDir, { recursive: true });
  await mkdir(capture);
  await mkdir(join(root, "bin"));
  await writeFile(join(root, "bin", "docker"), STUB);
  await chmod(join(root, "bin", "docker"), 0o755);
  await writeFile(
    join(hackDir, "hack.config.json"),
    `${JSON.stringify({
      name: "envatrest",
      dev_host: "envatrest.hack",
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
  await setProjectEnvValue({
    projectRoot,
    projectDir: hackDir,
    envName: null,
    scope: "web",
    key: "WEB_ONLY",
    value: PLAIN_VALUE,
    secret: false,
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function cliEnv(extra?: Readonly<Record<string, string>>) {
  return privateCliEnv({
    root,
    env: {
      // Stub docker plus base system tools only: no host mutagen or brew.
      PATH: `${join(root, "bin")}:/usr/bin:/bin`,
      STUB_CAPTURE: capture,
      HACK_NO_INTERACTIVE: "1",
      ...extra,
    },
  });
}

async function runCli(opts: {
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, CLI, ...opts.args], {
    cwd: projectRoot,
    env: cliEnv(opts.env),
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

/** Seeds the literal file an earlier Hack version left behind. */
async function seedEarlierVersionPlaintext(): Promise<void> {
  await mkdir(join(projectRoot, ".hack", ".internal"), { recursive: true });
  const text = renderManagedComposeEnvOverride({
    targetServices: ["web", "worker"],
    globalEnv: { SECRET_TOKEN: SECRET_VALUE },
    serviceEnv: {
      web: { SECRET_TOKEN: SECRET_VALUE, WEB_ONLY: PLAIN_VALUE },
      worker: { SECRET_TOKEN: SECRET_VALUE },
    },
  });
  await writeFile(overridePath, text ?? "", { mode: 0o600 });
  expect(await readFile(overridePath, "utf8")).toContain(CANARY);
}

/** No canary at rest: the override is absent or value-free, 0600 and ours. */
async function expectNoPlaintextAtRest(): Promise<void> {
  const info = await lstat(overridePath).catch(() => null);
  if (info === null) {
    return;
  }
  expect(info.isFile()).toBe(true);
  expect(info.mode & 0o777).toBe(0o600);
  expect(info.uid).toBe(process.getuid?.() ?? info.uid);
  const text = await readFile(overridePath, "utf8");
  expect(text).not.toContain(CANARY);
  expect(text).toContain("${HACK_ENV_");
}

function expectNoCanary(result: {
  readonly stdout: string;
  readonly stderr: string;
}): void {
  expect(result.stdout).not.toContain(CANARY);
  expect(result.stderr).not.toContain(CANARY);
}

/**
 * Fixture files holding a canary, except the stub's delivery evidence. The
 * authored env config holds the non-secret value by design (the secret is
 * stored encrypted there), so only the secret is searched in it.
 */
async function filesHoldingCanary(dir: string): Promise<string[]> {
  const authored = join(projectRoot, ".hack", "hack.env.default.yaml");
  const hits: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      hits.push(...(await filesHoldingCanary(path)));
      continue;
    }
    if (!entry.isFile() || path === join(capture, "compose-process-env.txt")) {
      continue;
    }
    const text = await readFile(path, "utf8").catch(() => "");
    if (text.includes(path === authored ? SECRET_VALUE : CANARY)) {
      hits.push(path.slice(root.length + 1));
    }
  }
  return hits;
}

test("up delivers values through the Compose process env and keeps only references at rest; down keeps nothing literal", async () => {
  const up = await runCli({ args: ["up", "--detach", "--json"] });
  expectNoCanary(up);
  expect(up.exitCode).toBe(0);

  const atUp = await readFile(join(capture, "override-at-up.yml"), "utf8");
  expect(atUp).not.toContain(CANARY);
  expect(atUp).toMatch(
    /SECRET_TOKEN: "\$\{HACK_ENV_[0-9A-F]{12}_SECRET_TOKEN\}"/
  );
  expect(atUp).toMatch(/WEB_ONLY: "\$\{HACK_ENV_[0-9A-F]{12}_WEB_ONLY\}"/);
  const delivered = await readFile(
    join(capture, "compose-process-env.txt"),
    "utf8"
  );
  expect(delivered).toMatch(
    new RegExp(`^HACK_ENV_[0-9A-F]{12}_SECRET_TOKEN=${SECRET_VALUE}$`, "m")
  );
  expect(delivered).toMatch(
    new RegExp(`^HACK_ENV_[0-9A-F]{12}_WEB_ONLY=${PLAIN_VALUE}$`, "m")
  );
  await expectNoPlaintextAtRest();
  expect(await lstat(overridePath).then((info) => info.isFile())).toBe(true);

  const down = await runCli({ args: ["down", "--json"] });
  expectNoCanary(down);
  expect(down.exitCode).toBe(0);
  await expectNoPlaintextAtRest();

  const args = await readFile(join(capture, "docker-args.log"), "utf8");
  expect(args).not.toContain(CANARY);
  expect(await filesHoldingCanary(root)).toEqual([]);
}, 60_000);

test("down removes a literal override left by an earlier version", async () => {
  await seedEarlierVersionPlaintext();
  const down = await runCli({ args: ["down", "--json"] });
  expectNoCanary(down);
  expect(down.exitCode).toBe(0);
  expect(await lstat(overridePath).catch(() => null)).toBeNull();
  expect(await filesHoldingCanary(root)).toEqual([]);
}, 60_000);

test("down removes a literal override even when its down-before hook fails", async () => {
  const configPath = join(projectRoot, ".hack", "hack.config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  await writeFile(
    configPath,
    `${JSON.stringify({ ...config, lifecycle: { down: { before: ["exit 17"] } } })}\n`
  );
  await seedEarlierVersionPlaintext();
  const down = await runCli({ args: ["down", "--json"] });
  expectNoCanary(down);
  expect(down.exitCode).toBe(17);
  expect(await lstat(overridePath).catch(() => null)).toBeNull();
  expect(await filesHoldingCanary(root)).toEqual([]);
}, 60_000);

test("up that renders no override removes a literal one (env config without values)", async () => {
  const hackDir = join(projectRoot, ".hack");
  for (const [scope, key] of [
    ["global", "SECRET_TOKEN"],
    ["web", "WEB_ONLY"],
  ] as const) {
    await unsetProjectEnvValue({
      projectRoot,
      projectDir: hackDir,
      envName: null,
      scope,
      key,
    });
  }
  await seedEarlierVersionPlaintext();
  const up = await runCli({ args: ["up", "--detach", "--json"] });
  expectNoCanary(up);
  expect(up.exitCode).toBe(0);
  expect(await lstat(overridePath).catch(() => null)).toBeNull();
  expect(
    await readFile(join(capture, "docker-args.log"), "utf8")
  ).not.toContain("compose.env.override.yml");
  expect(await filesHoldingCanary(root)).toEqual([]);
}, 60_000);

test("up that renders no override removes a literal one (no env config)", async () => {
  await rm(join(projectRoot, ".hack", "hack.env.default.yaml"));
  await seedEarlierVersionPlaintext();
  const up = await runCli({ args: ["up", "--detach", "--json"] });
  expectNoCanary(up);
  expect(up.exitCode).toBe(0);
  expect(await lstat(overridePath).catch(() => null)).toBeNull();
  expect(await filesHoldingCanary(root)).toEqual([]);
}, 60_000);

test("up that renders no override removes a literal one (legacy contract, no value for these services)", async () => {
  // Legacy `hack.env.json` path: the contract has a var, but only for a
  // service this stack does not run, so no service gets an override.
  const hackDir = join(projectRoot, ".hack");
  await rm(join(hackDir, "hack.env.default.yaml"));
  await writeFile(
    join(hackDir, "hack.env.json"),
    `${JSON.stringify({
      version: 1,
      vars: [{ key: "OTHER_ONLY", source: "plain_env", services: ["other"] }],
    })}\n`
  );
  await writeFile(join(hackDir, ".env"), "OTHER_ONLY=synthetic-other\n", {
    mode: 0o600,
  });
  await seedEarlierVersionPlaintext();
  const up = await runCli({ args: ["up", "--detach", "--json"] });
  expectNoCanary(up);
  expect(up.exitCode).toBe(0);
  expect(await lstat(overridePath).catch(() => null)).toBeNull();
  expect(
    await readFile(join(capture, "docker-args.log"), "utf8")
  ).not.toContain("compose.env.override.yml");
  expect(await filesHoldingCanary(root)).toEqual([]);
}, 60_000);

test("a failed up leaves no literal override, even over an earlier version's file", async () => {
  await seedEarlierVersionPlaintext();
  const up = await runCli({
    args: ["up", "--detach", "--json"],
    env: { STUB_FAIL_UP: "1" },
  });
  expectNoCanary(up);
  expect(up.exitCode).not.toBe(0);
  expect(
    await readFile(join(capture, "override-at-up.yml"), "utf8")
  ).not.toContain(CANARY);
  await expectNoPlaintextAtRest();
  expect(await filesHoldingCanary(root)).toEqual([]);
}, 60_000);

test("an up interrupted by SIGTERM during Compose startup leaves no literal override", async () => {
  await seedEarlierVersionPlaintext();
  const child = Bun.spawn([process.execPath, CLI, "up", "--detach", "--json"], {
    cwd: projectRoot,
    env: cliEnv({ STUB_BLOCK_UP: "1" }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const started = join(capture, "up-started");
  const deadline = Date.now() + 30_000;
  while (
    (await lstat(started).catch(() => null)) === null &&
    Date.now() < deadline
  ) {
    await Bun.sleep(50);
  }
  expect(await lstat(started).catch(() => null)).not.toBeNull();
  // Compose is reading the override right now: it must already be value-free.
  await expectNoPlaintextAtRest();
  child.kill("SIGTERM");
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expectNoCanary({ stdout, stderr });
  expect(exitCode).not.toBe(0);
  await expectNoPlaintextAtRest();
  expect(await filesHoldingCanary(root)).toEqual([]);
}, 60_000);

test("doctor reports a literal override by counts only and leaves removal to --fix", async () => {
  await seedEarlierVersionPlaintext();
  const doctor = await runCli({ args: ["doctor", "--json"] });
  expectNoCanary(doctor);
  const report = JSON.parse(doctor.stdout) as {
    readonly data?: {
      readonly checks?: readonly {
        readonly id: string;
        readonly status: string;
        readonly detail: string;
      }[];
    };
  };
  const check = report.data?.checks?.find(
    (entry) => entry.id === "compose env at rest"
  );
  expect(check?.status).toBe("warn");
  expect(check?.detail).toContain(
    ".hack/.internal/compose.env.override.yml holds 3 literal env value(s) for 2 service(s)"
  );
  expect(check?.detail).toContain("hack doctor --fix");
  expect(await readFile(overridePath, "utf8")).toContain(CANARY);
}, 120_000);
