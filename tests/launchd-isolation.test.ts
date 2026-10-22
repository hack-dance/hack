import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DAEMON_LAUNCHD_PLIST_FILENAME } from "../src/constants.ts";
import {
  LAUNCHD_ALLOW_ISOLATED_ENV,
  LAUNCHD_DISABLE_ENV,
  resolveLaunchdAccess,
} from "../src/daemon/launchd.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/*
 * HACK-1313: an isolated HACK_HOME must never manage the per-user hackd
 * launchd service. Subprocess cases run with `process.platform` preloaded as
 * darwin (so they prove the guard on any host), a private HOME whose
 * LaunchAgents holds a seeded hackd plist, and a stub `launchctl` first on
 * PATH that records every call. Nothing here can reach the real HOME or the
 * real launchd domain.
 */

const REPO = resolve(import.meta.dir, "..");
const CLI = resolve(REPO, "index.ts");
const DRIVER = resolve(import.meta.dir, "fixtures/launchd-isolation-driver.ts");
const DARWIN_PRELOAD = resolve(
  import.meta.dir,
  "helpers/darwin-platform-preload.ts"
);
const SEEDED_PLIST =
  "<plist><!-- seeded by launchd-isolation.test --></plist>\n";
const SEEDED_MTIME = new Date("2026-01-01T00:00:00Z");

let cleanupRoot: string | null = null;

afterEach(async () => {
  if (cleanupRoot) {
    await rm(cleanupRoot, { recursive: true, force: true });
    cleanupRoot = null;
  }
});

type Fixture = {
  readonly root: string;
  readonly home: string;
  readonly isolatedHackHome: string;
  readonly plistPath: string;
  readonly launchctlLog: string;
  readonly env: (
    extra: Readonly<Record<string, string | undefined>>
  ) => Record<string, string>;
};

async function writeStub(path: string, body: string): Promise<void> {
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
}

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "hack-launchd-isolation-"));
  cleanupRoot = root;
  const home = join(root, "user-home");
  const isolatedHackHome = join(root, "isolated-hack-home");
  const launchAgents = join(home, "Library", "LaunchAgents");
  await mkdir(launchAgents, { recursive: true });
  await mkdir(isolatedHackHome, { recursive: true });
  const plistPath = join(launchAgents, DAEMON_LAUNCHD_PLIST_FILENAME);
  await writeFile(plistPath, SEEDED_PLIST);
  await utimes(plistPath, SEEDED_MTIME, SEEDED_MTIME);

  const tools = join(root, "tools");
  await mkdir(tools);
  const launchctlLog = join(root, "launchctl.log");
  // Answers `print` as a loaded, running service so the pre-fix code takes
  // its repair/kickstart branches; every call is recorded.
  await writeStub(
    join(tools, "launchctl"),
    [
      `printf '%s\\n' "$*" >> "${launchctlLog}"`,
      `if [ "$1" = "print" ]; then printf 'state = running\\npid = 4242\\n'; fi`,
      "exit 0",
    ].join("\n")
  );
  // resolveLaunchdHackBinPath needs some `hack` on PATH to render a plist.
  await writeStub(join(tools, "hack"), "exit 0");

  return {
    root,
    home,
    isolatedHackHome,
    plistPath,
    launchctlLog,
    env: (extra) =>
      privateCliEnv({
        root,
        home,
        env: {
          PATH: `${tools}:/usr/bin:/bin`,
          HACK_NO_INTERACTIVE: "1",
          NO_COLOR: "1",
          HACK_TEST_STUB_LAUNCHCTL: join(tools, "launchctl"),
          ...extra,
        },
      }),
  };
}

async function launchctlCalls(fixture: Fixture): Promise<string[]> {
  const text = await readFile(fixture.launchctlLog, "utf8").catch(() => "");
  return text.split("\n").filter((line) => line.length > 0);
}

async function plistSnapshot(fixture: Fixture): Promise<{
  readonly entries: readonly string[];
  readonly sha256: string | null;
  readonly mtimeMs: number | null;
}> {
  const dir = join(fixture.home, "Library", "LaunchAgents");
  const entries = (await readdir(dir).catch(() => [])).sort();
  try {
    const bytes = await readFile(fixture.plistPath);
    const info = await stat(fixture.plistPath);
    return {
      entries,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      mtimeMs: info.mtimeMs,
    };
  } catch {
    return { entries, sha256: null, mtimeMs: null };
  }
}

async function runAsDarwin(opts: {
  readonly argv: readonly string[];
  readonly env: Record<string, string>;
  readonly cwd: string;
}): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(
    [process.execPath, "--preload", DARWIN_PRELOAD, ...opts.argv],
    {
      cwd: opts.cwd,
      env: opts.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

test("launchd access: only the default hack home may manage launchd", () => {
  const home = "/tmp/hack-launchd-real-home";
  const cases: ReadonlyArray<{
    readonly env: Record<string, string | undefined>;
    readonly allowed: boolean;
    readonly reason?: string;
  }> = [
    { env: { HOME: home }, allowed: true },
    { env: { HOME: home, HACK_HOME: "  " }, allowed: true },
    { env: { HOME: home, HACK_HOME: `${home}/.hack` }, allowed: true },
    { env: { HOME: home, HACK_HOME: `${home}/.hack/` }, allowed: true },
    {
      env: { HOME: home, HACK_HOME: "/tmp/hack-e2e-home-1" },
      allowed: false,
      reason: "isolated-hack-home",
    },
    {
      env: {
        HOME: home,
        HACK_HOME: "/tmp/hack-e2e-home-1",
        [LAUNCHD_ALLOW_ISOLATED_ENV]: "1",
      },
      allowed: true,
    },
    {
      env: { HOME: home, [LAUNCHD_DISABLE_ENV]: "1" },
      allowed: false,
      reason: "disabled",
    },
    {
      // The hard deny wins over the opt-in and over the default home.
      env: {
        HOME: home,
        HACK_HOME: "/tmp/hack-e2e-home-1",
        [LAUNCHD_ALLOW_ISOLATED_ENV]: "1",
        [LAUNCHD_DISABLE_ENV]: "1",
      },
      allowed: false,
      reason: "disabled",
    },
  ];
  for (const testCase of cases) {
    const access = resolveLaunchdAccess({ env: testCase.env });
    expect({ env: testCase.env, allowed: access.allowed }).toEqual({
      env: testCase.env,
      allowed: testCase.allowed,
    });
    if (!access.allowed) {
      expect(access.reason).toBe(testCase.reason as typeof access.reason);
      expect(access.message).not.toContain("\n");
    }
  }
});

test("every launchd operation is a no-op under an isolated HACK_HOME", async () => {
  const fixture = await makeFixture();
  const before = await plistSnapshot(fixture);

  const run = await runAsDarwin({
    argv: [DRIVER],
    cwd: fixture.root,
    env: fixture.env({ HACK_HOME: fixture.isolatedHackHome }),
  });
  expect(run.stderr).toBe("");
  expect(run.code).toBe(0);
  const results = JSON.parse(run.stdout) as Record<string, unknown>;
  expect(results.platform).toBe("darwin");
  expect(results.access).toMatchObject({
    allowed: false,
    reason: "isolated-hack-home",
  });
  expect(results.status).toEqual({
    installed: false,
    loaded: false,
    running: false,
    pid: null,
    exitStatus: null,
  });
  expect(results.repair).toBe("not-installed");
  expect(results.install).toMatchObject({
    ok: false,
    blocked: "isolated-hack-home",
  });
  expect(results.kickstart).toMatchObject({ ok: false });
  expect(results.stop).toMatchObject({ ok: false });
  expect(results.uninstall).toMatchObject({
    ok: false,
    blocked: "isolated-hack-home",
  });

  expect(await launchctlCalls(fixture)).toEqual([]);
  expect(await plistSnapshot(fixture)).toEqual(before);
});

test("positive control: the default hack home reaches the stub launchctl and rewrites the plist", async () => {
  const fixture = await makeFixture();
  const before = await plistSnapshot(fixture);

  const run = await runAsDarwin({
    argv: [DRIVER],
    cwd: fixture.root,
    env: fixture.env({ HACK_HOME: join(fixture.home, ".hack") }),
  });
  expect(run.code).toBe(0);
  const results = JSON.parse(run.stdout) as Record<string, unknown>;
  expect(results.access).toEqual({ allowed: true });
  expect(results.install).toMatchObject({ ok: true });

  const verbs = (await launchctlCalls(fixture)).map(
    (line) => line.split(" ")[0]
  );
  expect(verbs).toContain("print");
  expect(verbs).toContain("bootstrap");
  expect(verbs).toContain("kickstart");
  expect(verbs).toContain("bootout");
  // The driver ends with uninstall, which removes the rewritten plist.
  expect(await plistSnapshot(fixture)).not.toEqual(before);
});

const CLI_CASES = [
  { label: "daemon install", args: ["daemon", "install"], refuses: true },
  { label: "daemon uninstall", args: ["daemon", "uninstall"], refuses: true },
  {
    label: "daemon status --json",
    args: ["daemon", "status", "--json"],
    refuses: false,
  },
] as const;

for (const cliCase of CLI_CASES) {
  test(`hack ${cliCase.label} under an isolated HACK_HOME leaves launchd alone`, async () => {
    const fixture = await makeFixture();
    const before = await plistSnapshot(fixture);

    const run = await runAsDarwin({
      argv: [CLI, ...cliCase.args],
      cwd: fixture.root,
      env: fixture.env({ HACK_HOME: fixture.isolatedHackHome }),
    });

    expect(await launchctlCalls(fixture)).toEqual([]);
    expect(await plistSnapshot(fixture)).toEqual(before);
    if (cliCase.refuses) {
      expect(run.code).toBe(1);
      const output = `${run.stdout}\n${run.stderr}`;
      const lines = output
        .split("\n")
        .map((line) => line.trim())
        // The logger's bare "│" gutter line is decoration, not a message.
        .filter((line) => line.length > 0 && line !== "│");
      expect(lines).toEqual([expect.any(String)]);
      expect(lines[0]).toContain(
        "E_PERMISSION: launchd management is disabled for an isolated HACK_HOME"
      );
      expect(output).not.toMatch(/^\s+at /m);
      expect(output).not.toContain("--help");
      // The refusal precedes any global config write.
      expect(
        await stat(join(fixture.isolatedHackHome, "hack.config.json")).then(
          () => true,
          () => false
        )
      ).toBe(false);
    }
  });
}

test("positive control: the opt-in lets daemon status inspect launchd", async () => {
  const fixture = await makeFixture();
  await runAsDarwin({
    argv: [CLI, "daemon", "status", "--json"],
    cwd: fixture.root,
    env: fixture.env({
      HACK_HOME: fixture.isolatedHackHome,
      [LAUNCHD_ALLOW_ISOLATED_ENV]: "1",
    }),
  });
  const calls = await launchctlCalls(fixture);
  expect(calls.some((line) => line.startsWith("print "))).toBe(true);
});
