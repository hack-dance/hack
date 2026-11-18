import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CLI_COMPILE_DEFINE_ARGS } from "../scripts/lib/cli-compile-define.ts";
import { fixtureChildren } from "./helpers/fixture-children.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/*
 * HACK-2263: the release gate on a compiled candidate bundle. The bundle
 * here is this checkout's CLI compiled with a prerelease version, the real
 * `hack-v5` launcher and a stub executor; the gate puts a fake stable
 * `hack` first on PATH in a temp HOME and starts hackd from the launcher.
 */

const REPO = resolve(import.meta.dir, "..");
const VERSION = "5.0.0-next.97";
const children = fixtureChildren("candidate-daemon-identity");
let root: string | null = null;

afterEach(async () => {
  await children.stopAll();
  if (root) {
    await rm(root, { recursive: true, force: true });
    root = null;
  }
});

test.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
  "a compiled candidate starts its own hackd, which reports the release version",
  async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "hack-cdi-test-")));
    const bundle = join(root, "bundle");
    const build = await children.run({
      cmd: [
        process.execPath,
        "build",
        join(REPO, "index.ts"),
        "--compile",
        ...CLI_COMPILE_DEFINE_ARGS,
        "--define",
        `__HACK_BUILD_VERSION__="${VERSION}"`,
        "--outfile",
        join(bundle, "hack-cli"),
      ],
      cwd: root,
      env: privateCliEnv({ root }),
    });
    expect(build.exitCode).toBe(0);
    await copyFile(
      join(REPO, "scripts", "hack-v5.sh"),
      join(bundle, "hack-v5")
    );
    await chmod(join(bundle, "hack-v5"), 0o755);
    await writeFile(join(bundle, "hack-native"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });

    const gate = await children.run({
      cmd: [
        process.execPath,
        join(REPO, "scripts", "check-candidate-daemon-identity.ts"),
        bundle,
        VERSION,
      ],
      cwd: root,
      env: privateCliEnv({ root }),
    });
    expect(gate.stderr).toBe("");
    expect(gate.exitCode).toBe(0);
    expect(gate.stdout).toContain("hack-next: hackd pid");
    expect(gate.stdout).toContain("hack-v5: hackd pid");
    expect(gate.stdout).toContain(`CLI and hackd report ${VERSION}`);
  },
  120_000
);

/** Compiles this checkout's CLI to `outfile` with a build version. */
async function compileHack(opts: {
  readonly fixture: string;
  readonly outfile: string;
  readonly version: string;
}): Promise<void> {
  const build = await children.run({
    cmd: [
      process.execPath,
      "build",
      join(REPO, "index.ts"),
      "--compile",
      ...CLI_COMPILE_DEFINE_ARGS,
      "--define",
      `__HACK_BUILD_VERSION__="${opts.version}"`,
      "--outfile",
      opts.outfile,
    ],
    cwd: opts.fixture,
    env: privateCliEnv({ root: opts.fixture }),
  });
  expect(build.exitCode).toBe(0);
}

test.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
  "a candidate never starts over, restarts or stops a stable hackd on a shared home",
  async () => {
    // A short root keeps hackd's socket path inside the platform limit.
    root = await realpath(await mkdtemp("/tmp/hack-cdi-shared-"));
    const bundle = join(root, "bundle");
    const stable = join(root, "stable");
    const home = join(root, "home");
    await compileHack({
      fixture: root,
      outfile: join(bundle, "hack-cli"),
      version: VERSION,
    });
    await compileHack({
      fixture: root,
      outfile: join(stable, "hack"),
      version: "4.9.9",
    });
    await copyFile(
      join(REPO, "scripts", "hack-v5.sh"),
      join(bundle, "hack-v5")
    );
    await chmod(join(bundle, "hack-v5"), 0o755);
    await writeFile(join(bundle, "hack-native"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    await mkdir(home, { mode: 0o700 });
    await chmod(home, 0o700);
    // Both lines share HOME and so ~/.hack, as a Compose candidate does.
    const env: Record<string, string> = {
      HOME: home,
      PATH: `${stable}:/usr/bin:/bin`,
      TMPDIR: root,
      NO_COLOR: "1",
      HACK_LOGGER: "console",
      HACK_DAEMON_AUTOSTART_DISABLE: "1",
      HACK_DAEMON_DISABLE_DOCKER_EVENTS: "1",
    };
    const json = async (argv: readonly string[], extra = {}) => {
      const result = await children.run({
        cmd: argv,
        cwd: root,
        env: { ...env, ...extra },
      });
      return {
        exitCode: result.exitCode,
        json: JSON.parse(result.stdout) as {
          ok: boolean;
          data?: { daemon?: { pid: number | null; version: string | null } };
          error?: { message: string };
        },
      };
    };
    const stableHack = join(stable, "hack");
    const started = await json([stableHack, "daemon", "start", "--json"]);
    expect(started.exitCode).toBe(0);
    const stablePid = started.json.data?.daemon?.pid;
    expect(typeof stablePid).toBe("number");
    try {
      for (const command of ["start", "restart", "stop"]) {
        const result = await json(
          [join(bundle, "hack-v5"), "daemon", command, "--json"],
          { HACK_RUNTIME_BACKEND: "compose" }
        );
        expect(result.exitCode).toBe(1);
        expect(result.json.error?.message).toContain(
          `hackd version 4.9.9 (pid ${stablePid}) runs for this Hack home`
        );
      }
      // The stable hackd loses its pid file but keeps the home's socket: the
      // candidate cannot identify it, so it signals nothing.
      const pidPath = join(home, ".hack", "daemon", "hackd.pid");
      const pidText = await readFile(pidPath, "utf8");
      await rm(pidPath);
      for (const command of ["clear", "start"]) {
        const result = await children.run({
          cmd: [join(bundle, "hack-v5"), "daemon", command],
          cwd: root,
          env: { ...env, HACK_RUNTIME_BACKEND: "compose" },
        });
        expect(result.exitCode).toBe(1);
        expect(result.stdout + result.stderr).toContain(
          `hackd process ${stablePid} holds this Hack home without its pid file`
        );
      }
      expect(() => process.kill(stablePid as number, 0)).not.toThrow();
      await writeFile(pidPath, pidText);
      const status = await children.run({
        cmd: [stableHack, "daemon", "status", "--json"],
        cwd: root,
        env,
      });
      const report = JSON.parse(status.stdout) as {
        pid: number;
        version: string;
      };
      expect(report.pid).toBe(stablePid as number);
      expect(report.version).toBe("4.9.9");
    } finally {
      await json([stableHack, "daemon", "stop", "--json"]);
    }
  },
  120_000
);
