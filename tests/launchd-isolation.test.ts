import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
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
import { basename, join, resolve } from "node:path";
import {
  DAEMON_LAUNCHD_PLIST_FILENAME,
  GLOBAL_DAEMON_DIR_NAME,
  GLOBAL_DAEMON_SOCKET_FILENAME,
  GLOBAL_HACK_DIR_NAME,
} from "../src/constants.ts";
import {
  DAEMON_AUTOSTART_DISABLE_ENV,
  resolveDaemonAutostartAccess,
} from "../src/daemon/client.ts";
import {
  LAUNCHD_ALLOW_ISOLATED_ENV,
  LAUNCHD_DISABLE_ENV,
  renderLaunchdPlist,
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
  readonly hackLog: string;
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
  const hackLog = join(root, "hack.log");
  // When HACK_TEST_STUB_SOCKET is set, a "started" daemon is a plain file at
  // that path: it ends the autostart socket wait at once, and the request to
  // it then fails, as for an incompatible daemon.
  const touchSocket =
    'if [ -n "$HACK_TEST_STUB_SOCKET" ]; then mkdir -p "$(dirname "$HACK_TEST_STUB_SOCKET")" && : > "$HACK_TEST_STUB_SOCKET"; fi';
  // Answers `print` as a loaded, running service so the pre-fix code takes
  // its repair/kickstart branches; every call is recorded.
  await writeStub(
    join(tools, "launchctl"),
    [
      `printf '%s\\n' "$*" >> "${launchctlLog}"`,
      // HACK_TEST_LAUNCHCTL_FAIL=<verb> makes that verb fail (HACK-2216).
      'if [ -n "$HACK_TEST_LAUNCHCTL_FAIL" ] && [ "$1" = "$HACK_TEST_LAUNCHCTL_FAIL" ]; then echo "simulated $1 failure" >&2; exit 5; fi',
      `if [ "$1" = "print" ]; then printf 'state = running\\npid = 4242\\n'; fi`,
      `if [ "$1" = "kickstart" ]; then ${touchSocket}; fi`,
      "exit 0",
    ].join("\n")
  );
  // resolveLaunchdHackBinPath needs some `hack` on PATH to render a plist. It
  // also stands in for the stable `hack` that a direct autostart would run.
  await writeStub(
    join(tools, "hack"),
    [
      `printf '%s\\n' "$*" >> "${hackLog}"`,
      `if [ "$*" = "daemon start" ]; then ${touchSocket}; fi`,
      "exit 0",
    ].join("\n")
  );

  await writeStub(join(tools, "security"), "exit 0");

  return {
    root,
    home,
    isolatedHackHome,
    plistPath,
    launchctlLog,
    hackLog,
    env: (extra) =>
      privateCliEnv({
        root,
        home,
        env: {
          PATH: `${tools}:/usr/bin:/bin`,
          HACK_NO_INTERACTIVE: "1",
          NO_COLOR: "1",
          // Keep human diagnostics on stdout even when Linux has gum installed.
          HACK_LOGGER: "clack",
          HACK_TEST_STUB_LAUNCHCTL: join(tools, "launchctl"),
          // This file asserts daemon starts against stubs, so it opts in. A
          // case that tests the opt-out sets it again through `extra`.
          [DAEMON_AUTOSTART_DISABLE_ENV]: undefined,
          ...extra,
        },
      }),
  };
}

async function loggedCalls(path: string): Promise<string[]> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text.split("\n").filter((line) => line.length > 0);
}

async function launchctlCalls(fixture: Fixture): Promise<string[]> {
  return await loggedCalls(fixture.launchctlLog);
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

test("repairs legacy output paths even when the installed program is still current", async () => {
  const fixture = await makeFixture();
  const plist = renderLaunchdPlist({
    hackBinPath: join(fixture.root, "tools", "hack"),
    home: fixture.home,
    runAtLoad: false,
    guiSessionOnly: false,
  });
  await writeFile(
    fixture.plistPath,
    plist.replaceAll("/dev/null", "/tmp/hackd.stderr.log")
  );
  const run = await runAsDarwin({
    argv: [DRIVER, "repair-output"],
    cwd: fixture.root,
    env: fixture.env({ HACK_HOME: join(fixture.home, ".hack") }),
  });
  expect(run.code).toBe(0);
  expect(JSON.parse(run.stdout)).toEqual({
    repair: "refreshed",
    secondRepair: "ok",
  });
  expect(await readFile(fixture.plistPath, "utf8")).toBe(plist);
  const verbs = (await launchctlCalls(fixture)).map(
    (line) => line.split(" ")[0]
  );
  expect(verbs).toEqual(["bootout", "bootstrap"]);
});

/** Runs the driver's two repairs against `plist`; returns results and calls. */
async function repairPlist(
  plist: (fixture: Fixture) => string,
  extraEnv: Readonly<Record<string, string>> = {}
): Promise<{
  readonly results: unknown;
  readonly after: string;
  readonly verbs: string[];
}> {
  const fixture = await makeFixture();
  await writeFile(fixture.plistPath, plist(fixture));
  const run = await runAsDarwin({
    argv: [DRIVER, "repair-output"],
    cwd: fixture.root,
    env: fixture.env({ HACK_HOME: join(fixture.home, ".hack"), ...extraEnv }),
  });
  expect(run.code).toBe(0);
  return {
    results: JSON.parse(run.stdout),
    after: await readFile(fixture.plistPath, "utf8"),
    verbs: (await launchctlCalls(fixture)).map(
      (line) => line.split(" ")[0] ?? ""
    ),
  };
}

test("a plist that runs another existing hack is never retargeted (HACK-2216)", async () => {
  let written = "";
  const { results, after, verbs } = await repairPlist((fixture) => {
    const other = join(fixture.root, "other-bin", "hack");
    // Created before the driver runs: another installed hack the user chose.
    mkdirSync(join(fixture.root, "other-bin"), { recursive: true });
    copyFileSync(join(fixture.root, "tools", "hack"), other);
    chmodSync(other, 0o755);
    written = renderLaunchdPlist({
      hackBinPath: other,
      home: fixture.home,
      runAtLoad: false,
      guiSessionOnly: false,
    });
    return written;
  });
  expect(results).toEqual({
    repair: "other-program",
    secondRepair: "other-program",
  });
  expect(after).toBe(written);
  expect(verbs).toEqual([]);
});

/** What an earlier Hack wrote: no marker, and an older environment. */
function legacyPlist(fixture: Fixture): { legacy: string; current: string } {
  const current = renderLaunchdPlist({
    hackBinPath: join(fixture.root, "tools", "hack"),
    home: fixture.home,
    runAtLoad: false,
    guiSessionOnly: false,
  });
  const legacy = current
    .split("\n")
    .filter((line) => !line.startsWith("<!-- Managed by hack"))
    .join("\n")
    .replace(":/opt/homebrew/bin", "");
  return { legacy, current };
}

test("an unmarked legacy plist with Hack's label and this hack's program is refreshed, with the marker (HACK-2216)", async () => {
  let current = "";
  let legacy = "";
  const { results, after, verbs } = await repairPlist((fixture) => {
    ({ legacy, current } = legacyPlist(fixture));
    return legacy;
  });
  expect(legacy).not.toContain("<!-- Managed by hack");
  expect(results).toEqual({ repair: "refreshed", secondRepair: "ok" });
  expect(after).toBe(current);
  expect(after).toContain("<!-- Managed by hack");
  expect(verbs).toEqual(["bootout", "bootstrap"]);
});

test("an unmarked plist with another label is not refreshed (HACK-2216)", async () => {
  let written = "";
  const { results, after, verbs } = await repairPlist((fixture) => {
    written = legacyPlist(fixture).legacy.replace(
      "<string>dance.hack.hackd</string>",
      "<string>example.custom.hackd</string>"
    );
    return written;
  });
  expect(written).toContain("example.custom.hackd");
  expect(results).toEqual({ repair: "unmanaged", secondRepair: "unmanaged" });
  expect(after).toBe(written);
  expect(verbs).toEqual([]);
});

test("a managed plist for this hack with an older environment is refreshed (HACK-2216)", async () => {
  let current = "";
  const { results, after, verbs } = await repairPlist((fixture) => {
    current = renderLaunchdPlist({
      hackBinPath: join(fixture.root, "tools", "hack"),
      home: fixture.home,
      runAtLoad: false,
      guiSessionOnly: false,
    });
    return current.replace(":/opt/homebrew/bin", "");
  });
  expect(results).toEqual({ repair: "refreshed", secondRepair: "ok" });
  expect(after).toBe(current);
  expect(verbs).toEqual(["bootout", "bootstrap"]);
});

// Review round 2 (HACK-2216).

test("a refresh whose unload fails reports failed and leaves the plist", async () => {
  let legacy = "";
  const { results, after, verbs } = await repairPlist(
    (fixture) => {
      ({ legacy } = legacyPlist(fixture));
      return legacy;
    },
    { HACK_TEST_LAUNCHCTL_FAIL: "bootout" }
  );
  expect(results).toEqual({ repair: "failed", secondRepair: "failed" });
  expect(after).toBe(legacy);
  expect(verbs).toEqual(["bootout", "bootout"]);
});

test("a refresh whose load fails after a successful unload reports failed", async () => {
  const { results, verbs } = await repairPlist(
    (fixture) => legacyPlist(fixture).legacy,
    { HACK_TEST_LAUNCHCTL_FAIL: "bootstrap" }
  );
  expect((results as { repair: string }).repair).toBe("failed");
  expect(verbs.slice(0, 2)).toEqual(["bootout", "bootstrap"]);
});

/** A plist whose program is set with `Program` (and optionally args). */
function programPlist(opts: {
  readonly program: string;
  readonly firstArgument?: string;
}): string {
  const args =
    opts.firstArgument === undefined
      ? ""
      : `  <key>ProgramArguments</key>\n  <array>\n    <string>${opts.firstArgument}</string>\n    <string>daemon</string>\n  </array>\n`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>dance.hack.hackd</string>\n  <key>Program</key>\n  <string>${opts.program}</string>\n${args}</dict>\n</plist>\n`;
}

function otherHack(fixture: Fixture): string {
  const other = join(fixture.root, "other-bin", "hack");
  mkdirSync(join(fixture.root, "other-bin"), { recursive: true });
  copyFileSync(join(fixture.root, "tools", "hack"), other);
  chmodSync(other, 0o755);
  return other;
}

test("a plist with only Program set to another existing hack is not overwritten", async () => {
  let written = "";
  const { results, after, verbs } = await repairPlist((fixture) => {
    written = programPlist({ program: otherHack(fixture) });
    return written;
  });
  expect(results).toEqual({
    repair: "other-program",
    secondRepair: "other-program",
  });
  expect(after).toBe(written);
  expect(verbs).toEqual([]);
});

test("Program wins over ProgramArguments[0], as in launchd", async () => {
  let written = "";
  const { results, after, verbs } = await repairPlist((fixture) => {
    written = programPlist({
      program: otherHack(fixture),
      firstArgument: join(fixture.root, "tools", "hack"),
    });
    return written;
  });
  expect(results).toEqual({
    repair: "other-program",
    secondRepair: "other-program",
  });
  expect(after).toBe(written);
  expect(verbs).toEqual([]);
});

test("an unreadable plist program is never replaced", async () => {
  let written = "";
  const { results, after, verbs } = await repairPlist(() => {
    written = programPlist({ program: "relative/hack" });
    return written;
  });
  expect(results).toEqual({
    repair: "unknown-program",
    secondRepair: "unknown-program",
  });
  expect(after).toBe(written);
  expect(verbs).toEqual([]);
});

// Review round 3 (HACK-2216).

/** Hack's plist shape with a top-level program and extra root entries. */
function rootPlist(opts: {
  readonly firstArgument: string;
  readonly extra: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>dance.hack.hackd</string>\n${opts.extra}\n  <key>ProgramArguments</key>\n  <array>\n    <string>${opts.firstArgument}</string>\n    <string>daemon</string>\n  </array>\n</dict>\n</plist>\n`;
}

test("a nested Program key does not make a foreign top-level program missing", async () => {
  let written = "";
  const { results, after, verbs } = await repairPlist((fixture) => {
    written = rootPlist({
      firstArgument: otherHack(fixture),
      extra:
        "  <key>EnvironmentVariables</key>\n  <dict>\n    <key>Program</key>\n    <string>/missing/path</string>\n  </dict>",
    });
    return written;
  });
  expect(results).toEqual({
    repair: "other-program",
    secondRepair: "other-program",
  });
  expect(after).toBe(written);
  expect(verbs).toEqual([]);
});

test("a commented-out Program key does not make a foreign top-level program missing", async () => {
  let written = "";
  const { results, after, verbs } = await repairPlist((fixture) => {
    written = rootPlist({
      firstArgument: otherHack(fixture),
      extra: "  <!-- <key>Program</key>\n  <string>/missing/path</string> -->",
    });
    return written;
  });
  expect(results).toEqual({
    repair: "other-program",
    secondRepair: "other-program",
  });
  expect(after).toBe(written);
  expect(verbs).toEqual([]);
});

test("an XML-escaped Program key pointing at another hack is never replaced", async () => {
  let written = "";
  const { results, after, verbs } = await repairPlist((fixture) => {
    // `Progr&#97;m` is `Program` to launchd; no ProgramArguments, so a
    // reader that missed it would see no program and retarget.
    written = `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>dance.hack.hackd</string>\n  <key>Progr&#97;m</key>\n  <string>${otherHack(fixture)}</string>\n</dict>\n</plist>\n`;
    return written;
  });
  expect(results).toEqual({
    repair: "unknown-program",
    secondRepair: "unknown-program",
  });
  expect(after).toBe(written);
  expect(verbs).toEqual([]);
});

test.skipIf(process.getuid?.() === 0)(
  "a program path that cannot be checked (EACCES) is never replaced",
  async () => {
    let locked = "";
    let written = "";
    try {
      const { results, after, verbs } = await repairPlist((fixture) => {
        locked = join(fixture.root, "locked");
        mkdirSync(locked, { recursive: true });
        copyFileSync(join(fixture.root, "tools", "hack"), join(locked, "hack"));
        // No search permission: stat of locked/hack fails with EACCES.
        chmodSync(locked, 0o000);
        written = rootPlist({
          firstArgument: join(locked, "hack"),
          extra: "",
        });
        return written;
      });
      expect(results).toEqual({
        repair: "unknown-program",
        secondRepair: "unknown-program",
      });
      expect(after).toBe(written);
      expect(verbs).toEqual([]);
    } finally {
      if (locked) {
        chmodSync(locked, 0o755);
      }
    }
  }
);

test("macOS restart --json refuses a launchd service running another hack, before stopping anything", async () => {
  const fixture = await makeFixture();
  const plist = programPlist({ program: otherHack(fixture) });
  await writeFile(fixture.plistPath, plist);
  const run = await runAsDarwin({
    argv: [CLI, "daemon", "restart", "--json"],
    cwd: fixture.root,
    env: fixture.env({ HACK_HOME: join(fixture.home, ".hack") }),
  });
  expect(run.code).toBe(1);
  const envelope = JSON.parse(run.stdout) as {
    ok: boolean;
    error: { code: string; message: string; detail: Record<string, unknown> };
  };
  expect(envelope.ok).toBe(false);
  expect(envelope.error.code).toBe("E_DAEMON_SERVICE");
  expect(envelope.error.message).toContain("hack daemon install");
  expect(envelope.error.detail).toMatchObject({
    schema: "hack.daemon-restart/v1",
    manager: "launchd",
    action: "none",
    blocked: "other-program",
  });
  // Only the status read reached launchctl: nothing was stopped,
  // unloaded or kickstarted.
  const verbs = (await launchctlCalls(fixture)).map(
    (line) => line.split(" ")[0] ?? ""
  );
  expect(verbs.every((verb) => verb === "print")).toBe(true);
  expect(await readFile(fixture.plistPath, "utf8")).toBe(plist);
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

/*
 * HACK-1368: a candidate run (`hack-next`, or the bundled `hack-v5` launcher)
 * must never autostart hackd. Autostart starts whatever the host resolves:
 * the per-user launchd plist (the stable binary) or the first `hack` on PATH
 * (the stable CLI). The driver's `autostart` mode reports TTYs so the
 * interactive autostart gate is open, then makes one default daemon request.
 */

test("daemon autostart access: candidate runs and the opt-out never autostart", () => {
  const cases: ReadonlyArray<{
    readonly env: Record<string, string | undefined>;
    readonly allowed: boolean;
    readonly reason?: string;
  }> = [
    { env: {}, allowed: true },
    { env: { HACK_CANDIDATE_ENTRYPOINT: "" }, allowed: true },
    { env: { HACK_CANDIDATE_ENTRYPOINT: "  " }, allowed: true },
    { env: { [DAEMON_AUTOSTART_DISABLE_ENV]: "0" }, allowed: true },
    { env: { [DAEMON_AUTOSTART_DISABLE_ENV]: "true" }, allowed: true },
    {
      env: { HACK_CANDIDATE_ENTRYPOINT: "hack-next" },
      allowed: false,
      reason: "candidate",
    },
    {
      env: { HACK_CANDIDATE_ENTRYPOINT: "hack-v5" },
      allowed: false,
      reason: "candidate",
    },
    {
      // An inherited opt-in value cannot re-enable autostart for a candidate.
      env: {
        HACK_CANDIDATE_ENTRYPOINT: "hack-next",
        [DAEMON_AUTOSTART_DISABLE_ENV]: "0",
      },
      allowed: false,
      reason: "candidate",
    },
    {
      env: { [DAEMON_AUTOSTART_DISABLE_ENV]: " 1 " },
      allowed: false,
      reason: "disabled",
    },
    {
      env: {
        HACK_CANDIDATE_ENTRYPOINT: "hack-v5",
        [DAEMON_AUTOSTART_DISABLE_ENV]: "1",
      },
      allowed: false,
      reason: "disabled",
    },
  ];
  for (const testCase of cases) {
    const access = resolveDaemonAutostartAccess({ env: testCase.env });
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

const AUTOSTART_CASES = [
  {
    label: "a hack-next run on the default hack home",
    env: { HACK_CANDIDATE_ENTRYPOINT: "hack-next" },
    denied: true,
    isolated: false,
    launchctl: [],
    hack: [],
  },
  {
    label: "a hack-next run on an isolated hack home",
    env: { HACK_CANDIDATE_ENTRYPOINT: "hack-next" },
    denied: true,
    isolated: true,
    launchctl: [],
    hack: [],
  },
  {
    label: "a hack-v5 launcher run (Compose backend, caller's hack home)",
    env: {
      HACK_CANDIDATE_ENTRYPOINT: "hack-v5",
      [DAEMON_AUTOSTART_DISABLE_ENV]: "1",
    },
    denied: true,
    isolated: false,
    launchctl: [],
    hack: [],
  },
  {
    label: "the opt-out alone",
    env: { [DAEMON_AUTOSTART_DISABLE_ENV]: "1" },
    denied: true,
    isolated: false,
    launchctl: [],
    hack: [],
  },
  {
    // Positive control: the same driver does reach launchd without a marker.
    label: "positive control: a stable run on the default hack home",
    env: {},
    denied: false,
    isolated: false,
    launchctl: ["print", "kickstart"],
    hack: [],
  },
  {
    // Positive control: and runs the `hack` on PATH when launchd is denied.
    label: "positive control: a stable run on an isolated hack home",
    env: {},
    denied: false,
    isolated: true,
    launchctl: [],
    hack: ["daemon start"],
  },
] as const;

for (const autostartCase of AUTOSTART_CASES) {
  test(`daemon request autostart: ${autostartCase.label}`, async () => {
    const fixture = await makeFixture();
    const before = await plistSnapshot(fixture);
    const hackHome = autostartCase.isolated
      ? fixture.isolatedHackHome
      : join(fixture.home, GLOBAL_HACK_DIR_NAME);
    const socketPath = join(
      hackHome,
      GLOBAL_DAEMON_DIR_NAME,
      GLOBAL_DAEMON_SOCKET_FILENAME
    );

    const run = await runAsDarwin({
      argv: [DRIVER, "autostart"],
      cwd: fixture.root,
      env: fixture.env({
        HACK_HOME: hackHome,
        HACK_NO_INTERACTIVE: undefined,
        HACK_TEST_STUB_SOCKET: socketPath,
        ...autostartCase.env,
      }),
    });
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    const output = JSON.parse(run.stdout) as {
      readonly response: unknown;
      readonly configPath: string;
      readonly observed: {
        readonly files: readonly string[];
        readonly which: readonly string[];
        readonly spawns: readonly string[];
      };
    };
    expect(output.response).toBeNull();
    expect(output.configPath.startsWith(fixture.root)).toBe(true);
    const spawned = output.observed.spawns.map((bin) => basename(bin));
    if (autostartCase.denied) {
      // The autostart guard runs first: a denied run reads no config, does
      // no PATH lookup and spawns nothing (no launchctl, no `hack`).
      expect(output.observed.files).not.toContain(output.configPath);
      expect(output.observed.which).toEqual([]);
      expect(spawned).toEqual([]);
    } else {
      // Positive control: the same recorder sees the config read and the
      // launchd or PATH start.
      expect(output.observed.files).toContain(output.configPath);
      expect(spawned).toContain(autostartCase.isolated ? "hack" : "launchctl");
    }

    const verbs = (await launchctlCalls(fixture)).map(
      (line) => line.split(" ")[0]
    );
    expect(verbs).toEqual([...autostartCase.launchctl]);
    expect(await loggedCalls(fixture.hackLog)).toEqual([...autostartCase.hack]);
    expect(await plistSnapshot(fixture)).toEqual(before);
    const started =
      autostartCase.launchctl.length > 0 || autostartCase.hack.length > 0;
    expect(
      await stat(socketPath).then(
        () => true,
        () => false
      )
    ).toBe(started);
  });
}

const FOLLOWUPS_DRIVER = resolve(
  import.meta.dir,
  "fixtures/launchd-followups-driver.ts"
);

for (const mode of ["client", "offer", "tls"] as const) {
  for (const accessCase of [
    "isolated",
    "disabled",
    "default",
    "opt-in",
  ] as const) {
    test(`launchd follow-ups: ${mode} ${accessCase}`, async () => {
      const fixture = await makeFixture();
      const allowed = accessCase === "default" || accessCase === "opt-in";
      const hackHome =
        accessCase === "default"
          ? join(fixture.home, GLOBAL_HACK_DIR_NAME)
          : fixture.isolatedHackHome;
      const socketPath = join(
        hackHome,
        GLOBAL_DAEMON_DIR_NAME,
        GLOBAL_DAEMON_SOCKET_FILENAME
      );
      const run = await runAsDarwin({
        argv: [FOLLOWUPS_DRIVER, mode],
        cwd: fixture.root,
        env: fixture.env({
          HACK_HOME: hackHome,
          HACK_NO_INTERACTIVE: undefined,
          HACK_TEST_STUB_SOCKET: socketPath,
          [LAUNCHD_ALLOW_ISOLATED_ENV]:
            accessCase === "opt-in" || accessCase === "disabled"
              ? "1"
              : undefined,
          [LAUNCHD_DISABLE_ENV]: accessCase === "disabled" ? "1" : undefined,
        }),
      });
      expect(run.stderr).toBe("");
      expect(run.code).toBe(0);
      const output = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "") as {
        readonly statusCalls: number;
      };
      if (mode === "tls") {
        expect(
          await readFile(
            join(hackHome, "caddy", "pki", "caddy-host-trust-env.sh"),
            "utf8"
          )
        ).toContain("NODE_EXTRA_CA_CERTS");
        const calls = await launchctlCalls(fixture);
        expect(calls.length > 0).toBe(allowed);
        expect(calls.every((call) => call.startsWith("setenv "))).toBe(true);
        expect(
          run.stdout.includes("registered it for future macOS shells")
        ).toBe(allowed);
      } else {
        // Observe entry to the helper: its own admission guards must not mask
        // removal of the caller's independent defense-in-depth guard.
        expect(output.statusCalls).toBe(allowed ? 1 : 0);
        expect(await launchctlCalls(fixture)).toEqual([]);
        if (mode === "client") {
          expect(await loggedCalls(fixture.hackLog)).toEqual(["daemon start"]);
        }
      }
    });
  }
}

test("a relative HOME cannot make a cwd-relative HACK_HOME look like the owner", () => {
  expect(
    resolveLaunchdAccess({
      env: { HOME: "relative-home", HACK_HOME: "relative-home/.hack" },
    }).allowed
  ).toBe(false);
});
