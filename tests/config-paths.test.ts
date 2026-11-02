import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { resolveDaemonPaths } from "@daemon/paths.ts";
import {
  resolveGlobalConfigPath,
  resolveGlobalHackDir,
} from "@lib/config-paths.ts";
import { resolveUserHomeDir } from "@lib/home-dir.ts";
import { readProjectsRegistry } from "@lib/projects-registry.ts";
import {
  GLOBAL_CONFIG_FILENAME,
  GLOBAL_DAEMON_DIR_NAME,
  GLOBAL_HACK_DIR_NAME,
  GLOBAL_PROJECTS_REGISTRY_FILENAME,
} from "@/constants.ts";

const originalHome = process.env.HOME;
const originalHackHome = process.env.HACK_HOME;
const originalGlobalConfigPath = process.env.HACK_GLOBAL_CONFIG_PATH;

const tempDirs: string[] = [];

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
}

afterEach(async () => {
  restoreEnv("HOME", originalHome);
  restoreEnv("HACK_HOME", originalHackHome);
  restoreEnv("HACK_GLOBAL_CONFIG_PATH", originalGlobalConfigPath);
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

test("resolveGlobalConfigPath prefers HOME when no explicit override is set", () => {
  process.env.HACK_GLOBAL_CONFIG_PATH = "";
  process.env.HACK_HOME = "";
  process.env.HOME = "/tmp/hack-home";

  expect(resolveGlobalConfigPath()).toBe(
    resolve("/tmp/hack-home", GLOBAL_HACK_DIR_NAME, GLOBAL_CONFIG_FILENAME)
  );
});

test("resolveGlobalConfigPath prefers explicit override", () => {
  process.env.HACK_GLOBAL_CONFIG_PATH = "/tmp/custom-config.json";
  process.env.HOME = "/tmp/hack-home";

  expect(resolveGlobalConfigPath()).toBe("/tmp/custom-config.json");
});

test("resolveGlobalConfigPath override beats HACK_HOME", () => {
  process.env.HACK_GLOBAL_CONFIG_PATH = "/tmp/custom-config.json";
  process.env.HACK_HOME = "/tmp/hack-isolated";
  process.env.HOME = "/tmp/hack-home";

  expect(resolveGlobalConfigPath()).toBe("/tmp/custom-config.json");
});

test("resolveGlobalHackDir defaults to HOME/.hack when HACK_HOME is unset", () => {
  Reflect.deleteProperty(process.env, "HACK_HOME");
  process.env.HACK_GLOBAL_CONFIG_PATH = "";
  process.env.HOME = "/tmp/hack-home";

  expect(resolveGlobalHackDir()).toBe(
    resolve("/tmp/hack-home", GLOBAL_HACK_DIR_NAME)
  );
});

test("resolveGlobalHackDir uses HACK_HOME as-is when set", () => {
  process.env.HACK_HOME = "/tmp/hack-isolated";
  process.env.HOME = "/tmp/hack-home";

  expect(resolveGlobalHackDir()).toBe("/tmp/hack-isolated");
});

test("resolveGlobalHackDir ignores whitespace-only HACK_HOME", () => {
  process.env.HACK_HOME = "   ";
  process.env.HOME = "/tmp/hack-home";

  expect(resolveGlobalHackDir()).toBe(
    resolve("/tmp/hack-home", GLOBAL_HACK_DIR_NAME)
  );
});

test("resolveGlobalConfigPath lands under HACK_HOME when set", () => {
  process.env.HACK_GLOBAL_CONFIG_PATH = "";
  process.env.HACK_HOME = "/tmp/hack-isolated";
  process.env.HOME = "/tmp/hack-home";

  expect(resolveGlobalConfigPath()).toBe(
    resolve("/tmp/hack-isolated", GLOBAL_CONFIG_FILENAME)
  );
});

test("resolveDaemonPaths lands under HACK_HOME when set", () => {
  process.env.HACK_HOME = "/tmp/hack-isolated";
  process.env.HOME = "/tmp/hack-home";

  const paths = resolveDaemonPaths({});
  const root = resolve("/tmp/hack-isolated", GLOBAL_DAEMON_DIR_NAME);
  expect(paths.root).toBe(root);
  expect(paths.socketPath.startsWith(`${root}/`)).toBe(true);
  expect(paths.pidPath.startsWith(`${root}/`)).toBe(true);
  expect(paths.logPath.startsWith(`${root}/`)).toBe(true);
  // The launchd plist stays under the real home LaunchAgents directory.
  expect(
    paths.launchdPlistPath.startsWith("/tmp/hack-home/Library/LaunchAgents/")
  ).toBe(true);
});

test("resolveDaemonPaths explicit home wins over HACK_HOME", () => {
  process.env.HACK_HOME = "/tmp/hack-isolated";
  process.env.HOME = "/tmp/hack-home";

  const paths = resolveDaemonPaths({ home: "/tmp/explicit-home" });
  expect(paths.root).toBe(
    resolve("/tmp/explicit-home", GLOBAL_HACK_DIR_NAME, GLOBAL_DAEMON_DIR_NAME)
  );
});

test("resolveDaemonPaths is home-based when HACK_HOME is unset", () => {
  Reflect.deleteProperty(process.env, "HACK_HOME");
  process.env.HOME = "/tmp/hack-home";

  const paths = resolveDaemonPaths({});
  expect(paths.root).toBe(
    resolve("/tmp/hack-home", GLOBAL_HACK_DIR_NAME, GLOBAL_DAEMON_DIR_NAME)
  );
});

test("projects registry is read from under HACK_HOME when set", async () => {
  const hackHome = await makeTempDir("hack-home-");
  process.env.HACK_HOME = hackHome;
  process.env.HOME = "/tmp/hack-home";
  Reflect.deleteProperty(process.env, "HACK_GLOBAL_CONFIG_PATH");

  const registryPath = join(hackHome, GLOBAL_PROJECTS_REGISTRY_FILENAME);
  const record = {
    version: 1,
    projects: [
      {
        id: "test-project-id",
        name: "test-project",
        repoRoot: "/tmp/test-project",
        projectDirName: ".hack",
        projectDir: "/tmp/test-project/.hack",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
  await Bun.write(registryPath, `${JSON.stringify(record, null, 2)}\n`);

  const registry = await readProjectsRegistry();
  expect(registry.projects).toHaveLength(1);
  expect(registry.projects[0]?.id).toBe("test-project-id");
});

// HACK-1357: an empty or relative HOME/HACK_HOME must never make global state
// (registry, daemon socket/pid, secret key material) resolve under the cwd.
function expectOutsideCwd(path: string): void {
  expect(path.startsWith("/")).toBe(true);
  expect(path === process.cwd() || path.startsWith(`${process.cwd()}/`)).toBe(
    false
  );
}

for (const [label, home] of [
  ["empty", ""],
  ["whitespace", "   "],
  ["relative", "relative-home"],
  ["dot-relative", "./relative-home"],
] as const) {
  test(`resolveGlobalHackDir treats ${label} HOME as unset`, () => {
    Reflect.deleteProperty(process.env, "HACK_HOME");
    process.env.HOME = home;

    const dir = resolveGlobalHackDir();
    expectOutsideCwd(dir);
    expect(dir).toBe(resolve(homedir(), GLOBAL_HACK_DIR_NAME));
  });

  test(`resolveGlobalConfigPath stays out of the cwd with ${label} HOME`, () => {
    Reflect.deleteProperty(process.env, "HACK_HOME");
    Reflect.deleteProperty(process.env, "HACK_GLOBAL_CONFIG_PATH");
    process.env.HOME = home;

    expectOutsideCwd(resolveGlobalConfigPath());
  });

  test(`resolveDaemonPaths stays out of the cwd with ${label} HOME`, () => {
    Reflect.deleteProperty(process.env, "HACK_HOME");
    process.env.HOME = home;

    const paths = resolveDaemonPaths({});
    expect(paths.root).toBe(
      resolve(homedir(), GLOBAL_HACK_DIR_NAME, GLOBAL_DAEMON_DIR_NAME)
    );
    for (const path of Object.values(paths)) {
      expectOutsideCwd(path);
    }
  });
}

test("resolveDaemonPaths treats an empty explicit home as unset", () => {
  Reflect.deleteProperty(process.env, "HACK_HOME");
  process.env.HOME = "/tmp/hack-home";

  const paths = resolveDaemonPaths({ home: "" });
  expect(paths.root).toBe(
    resolve("/tmp/hack-home", GLOBAL_HACK_DIR_NAME, GLOBAL_DAEMON_DIR_NAME)
  );
  expect(
    paths.launchdPlistPath.startsWith("/tmp/hack-home/Library/LaunchAgents/")
  ).toBe(true);
});

test("resolveDaemonPaths refuses a relative explicit home", () => {
  process.env.HOME = "/tmp/hack-home";

  expect(() => resolveDaemonPaths({ home: "relative-home" })).toThrow(
    /absolute path/
  );
});

for (const [label, hackHome] of [
  ["relative", "relative-hack-home"],
  ["dot-relative", "./relative-hack-home"],
] as const) {
  test(`resolveGlobalHackDir refuses ${label} HACK_HOME`, () => {
    process.env.HACK_HOME = hackHome;
    process.env.HOME = "/tmp/hack-home";

    expect(() => resolveGlobalHackDir()).toThrow(
      /HACK_HOME must be an absolute path/
    );
  });

  test(`resolveDaemonPaths refuses ${label} HACK_HOME`, () => {
    process.env.HACK_HOME = hackHome;
    process.env.HOME = "/tmp/hack-home";

    expect(() => resolveDaemonPaths({})).toThrow(
      /HACK_HOME must be an absolute path/
    );
  });
}

test("resolveGlobalHackDir treats empty HACK_HOME as unset", () => {
  process.env.HACK_HOME = "";
  process.env.HOME = "/tmp/hack-home";

  expect(resolveGlobalHackDir()).toBe(
    resolve("/tmp/hack-home", GLOBAL_HACK_DIR_NAME)
  );
});

test("resolveDaemonPaths honors an absolute HACK_HOME even without a usable HOME", () => {
  process.env.HACK_HOME = "/tmp/hack-isolated";
  process.env.HOME = "relative-home";

  // Daemon state comes from HACK_HOME alone; only the launchd plist needs a
  // home, and it is resolved lazily (refusing if no absolute home exists).
  const paths = resolveDaemonPaths({});
  const root = resolve("/tmp/hack-isolated", GLOBAL_DAEMON_DIR_NAME);
  expect(paths.root).toBe(root);
  expect(paths.socketPath.startsWith(`${root}/`)).toBe(true);
  expect(paths.pidPath.startsWith(`${root}/`)).toBe(true);
  expect(paths.launchdPlistPath.startsWith(`${resolveUserHomeDir()}/`)).toBe(
    true
  );
});

test("daemon state resolves under HACK_HOME in a process started with a relative HOME", async () => {
  // Bun's os.homedir() echoes the HOME a process was started with, so this
  // needs a real child process to reproduce (HACK-1357 review).
  const cwd = await makeTempDir("hack-rel-home-cwd-");
  const hackHome = await makeTempDir("hack-rel-home-state-");
  const pathsModule = resolve(import.meta.dir, "../src/daemon/paths.ts");
  const script = `
    const { resolveDaemonPaths } = await import(${JSON.stringify(pathsModule)});
    const paths = resolveDaemonPaths({});
    let plist = "ok";
    try { void paths.launchdPlistPath; } catch (error) { plist = String(error); }
    console.log(JSON.stringify({ socketPath: paths.socketPath, plist }));
  `;
  const proc = Bun.spawn([process.execPath, "-e", script], {
    cwd,
    env: { ...process.env, HOME: "relative-home", HACK_HOME: hackHome },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  const result = JSON.parse(stdout.trim()) as {
    readonly socketPath: string;
    readonly plist: string;
  };
  expect(
    result.socketPath.startsWith(resolve(hackHome, GLOBAL_DAEMON_DIR_NAME))
  ).toBe(true);
  expect(result.plist).toMatch(/HOME is empty or not an absolute path/);
});
