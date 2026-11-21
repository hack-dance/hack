import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildComposeDownCommand } from "../src/backends/runtime-backend.ts";
import { buildDoctorJsonData } from "../src/commands/doctor.ts";
import {
  buildLifecycleJsonData,
  runDownCommand,
} from "../src/commands/project.ts";
import { HackCliError } from "../src/lib/cli-result.ts";
import {
  COMPOSE_DOWN_DEPENDENCY_LEVELS,
  COMPOSE_DOWN_OVERHEAD_MS,
  DEFAULT_COMPOSE_DOWN_CAP_MS,
  DEFAULT_DOCKER_STOP_TIMEOUT_SECONDS,
  parseComposeDownTimeoutFlag,
  resolveComposeDownCapMs,
  resolveComposeDownTimeoutSeconds,
} from "../src/lib/compose-down-budget.ts";
import {
  buildSlowStopHints,
  formatSlowStopHint,
  observeComposeDownSlowStops,
  parseComposeDownExit137Services,
  readProjectSlowStops,
  recordProjectSlowStops,
  slowStopProbeThresholdMs,
} from "../src/lib/compose-down-slow-stop.ts";
import {
  COMPOSE_SLOW_STOPS_CHECK,
  checkComposeSlowStops,
} from "../src/lib/doctor-compose-slow-stops.ts";
import { findProjectContext, readProjectConfig } from "../src/lib/project.ts";
import {
  LIFECYCLE_TMUX_INTERRUPT_GRACE_MS,
  LIFECYCLE_TMUX_INTERRUPT_POLL_INTERVAL_MS,
  waitForInterruptedTmuxPanes,
} from "../src/lib/project-lifecycle-controller.ts";
import { setLoggerBackendOverride } from "../src/ui/logger.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const CLI_ENTRY = join(REPO_ROOT, "index.ts");
const CLI_TIMEOUT_MS = 10_000;

const tempDirs: string[] = [];

afterEach(async () => {
  setLoggerBackendOverride({ backend: null });
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function createComposeFixture(opts?: {
  readonly name?: string;
  readonly composeYaml?: string;
  readonly config?: Record<string, unknown>;
}): Promise<{
  readonly root: string;
  readonly projectDir: string;
  readonly homeDir: string;
  readonly binDir: string;
  readonly dockerLogPath: string;
}> {
  const root = await makeTempDir("hack-down-bounded-");
  const projectDir = join(root, ".hack");
  const homeDir = join(root, "home");
  const binDir = join(root, "bin");
  const dockerLogPath = join(root, "docker-calls.jsonl");
  await mkdir(projectDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });

  await writeFile(
    join(projectDir, "docker-compose.yml"),
    opts?.composeYaml ??
      [
        "services:",
        "  api:",
        "    image: alpine:3.20",
        "  web:",
        "    image: alpine:3.20",
        "",
      ].join("\n")
  );
  await writeFile(
    join(projectDir, "hack.config.json"),
    `${JSON.stringify(
      {
        name: opts?.name ?? "bounded-demo",
        ...(opts?.config ?? {}),
      },
      null,
      2
    )}\n`
  );

  // Fake `docker` shim that records every invocation and returns empty JSON
  // for inspection calls so `hack down` never touches a real Docker daemon.
  const dockerShim = join(binDir, "docker");
  await writeFile(
    dockerShim,
    [
      "#!/usr/bin/env bun",
      'import { appendFileSync } from "node:fs";',
      "const logPath = process.env.FAKE_DOCKER_LOG;",
      "const args = process.argv.slice(2);",
      "if (logPath) {",
      '  appendFileSync(logPath, JSON.stringify(args) + "\\n");',
      "}",
      'if (args[0] === "compose" && args.includes("ps")) {',
      '  process.stdout.write("[]\\n");',
      "  process.exit(0);",
      "}",
      'if (args[0] === "ps") {',
      '  process.stdout.write("");',
      "  process.exit(0);",
      "}",
      'if (args[0] === "events") {',
      '  const out = process.env.FAKE_DOCKER_EVENTS_STDOUT ?? "";',
      "  process.stdout.write(out);",
      "  process.exit(0);",
      "}",
      "process.exit(0);",
      "",
    ].join("\n")
  );
  await chmod(dockerShim, 0o755);

  return { root, projectDir, homeDir, binDir, dockerLogPath };
}

async function runCli(opts: {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly homeDir: string;
  readonly binDir: string;
  readonly dockerLogPath: string;
  readonly extraEnv?: Readonly<Record<string, string>>;
}): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const proc = Bun.spawn([process.execPath, CLI_ENTRY, ...opts.args], {
    cwd: opts.cwd,
    env: {
      ...process.env,
      PATH: `${opts.binDir}:${process.env.PATH ?? ""}`,
      HOME: opts.homeDir,
      XDG_CONFIG_HOME: join(opts.homeDir, ".config"),
      HACK_GLOBAL_CONFIG_PATH: join(opts.homeDir, ".hack", "hack.config.json"),
      HACK_DAEMON_AUTOSTART_DISABLE: "1",
      HACK_NO_INTERACTIVE: "1",
      HACK_RUNTIME_BACKEND: "compose",
      HACK_LOGGER: "console",
      FAKE_DOCKER_LOG: opts.dockerLogPath,
      ...(opts.extraEnv ?? {}),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => {
    proc.kill("SIGKILL");
  }, CLI_TIMEOUT_MS);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

async function readDockerCalls(
  path: string
): Promise<readonly (readonly string[])[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return [];
  }
  const text = await file.text();
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as string[]);
}

describe("compose down stop timeout validation and cap", () => {
  test("accepts integer 0..600 and refuses invalid --timeout values with E_USAGE without clamping", () => {
    expect(parseComposeDownTimeoutFlag(undefined)).toBeUndefined();
    expect(parseComposeDownTimeoutFlag("0")).toBe(0);
    expect(parseComposeDownTimeoutFlag("1")).toBe(1);
    expect(parseComposeDownTimeoutFlag("15")).toBe(15);
    expect(parseComposeDownTimeoutFlag("600")).toBe(600);

    for (const invalid of [
      "-1",
      "601",
      "1.5",
      "abc",
      "",
      "   ",
      "10s",
      "NaN",
    ]) {
      let caught: unknown;
      try {
        parseComposeDownTimeoutFlag(invalid);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(HackCliError);
      expect((caught as HackCliError).code).toBe("E_USAGE");
    }
  });

  test("validates compose.downTimeoutSeconds with E_CONFIG_INVALID and gives --timeout precedence", async () => {
    expect(
      resolveComposeDownTimeoutSeconds({ flagValue: "3", projectValue: 12 })
    ).toBe(3);
    expect(resolveComposeDownTimeoutSeconds({ projectValue: 0 })).toBe(0);
    expect(resolveComposeDownTimeoutSeconds({ projectValue: 600 })).toBe(600);
    expect(resolveComposeDownTimeoutSeconds({})).toBeUndefined();

    for (const invalid of [
      -1,
      601,
      2.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      let caught: unknown;
      try {
        resolveComposeDownTimeoutSeconds({ projectValue: invalid });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(HackCliError);
      expect((caught as HackCliError).code).toBe("E_CONFIG_INVALID");
    }

    // Verify project config parsing preserves valid integers and maps invalid JSON values to NaN.
    const validFixture = await createComposeFixture({
      config: { compose: { downTimeoutSeconds: 4 } },
    });
    const validCtx = await findProjectContext(validFixture.root);
    expect(validCtx).not.toBeNull();
    const validCfg = await readProjectConfig(validCtx!);
    expect(validCfg.compose?.downTimeoutSeconds).toBe(4);

    for (const badRaw of [-1, 601, 1.5, "5", null, true]) {
      const badFixture = await createComposeFixture({
        config: { compose: { downTimeoutSeconds: badRaw } },
      });
      const badCtx = await findProjectContext(badFixture.root);
      const badCfg = await readProjectConfig(badCtx!);
      let caught: unknown;
      try {
        resolveComposeDownTimeoutSeconds({
          projectValue: badCfg.compose?.downTimeoutSeconds,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(HackCliError);
      expect((caught as HackCliError).code).toBe("E_CONFIG_INVALID");
    }
  });

  test("derives overall down cap from the stop timeout instead of the start-up constant", () => {
    expect(DEFAULT_COMPOSE_DOWN_CAP_MS).toBe(
      DEFAULT_DOCKER_STOP_TIMEOUT_SECONDS *
        COMPOSE_DOWN_DEPENDENCY_LEVELS *
        1000 +
        COMPOSE_DOWN_OVERHEAD_MS
    );
    expect(resolveComposeDownCapMs(undefined)).toBe(
      DEFAULT_COMPOSE_DOWN_CAP_MS
    );
    expect(resolveComposeDownCapMs(0)).toBe(COMPOSE_DOWN_OVERHEAD_MS);
    expect(resolveComposeDownCapMs(5)).toBe(
      5 * COMPOSE_DOWN_DEPENDENCY_LEVELS * 1000 + COMPOSE_DOWN_OVERHEAD_MS
    );
    expect(resolveComposeDownCapMs(600)).toBe(
      600 * COMPOSE_DOWN_DEPENDENCY_LEVELS * 1000 + COMPOSE_DOWN_OVERHEAD_MS
    );
  });

  test("builds docker compose down argv with and without --timeout", () => {
    const base = {
      composeFiles: ["/repo/.hack/docker-compose.yml"],
      composeProject: "demo",
      cwd: "/repo/.hack",
    } as const;

    expect(buildComposeDownCommand(base)).toEqual([
      "docker",
      "compose",
      "-p",
      "demo",
      "--project-directory",
      "/repo/.hack",
      "-f",
      "/repo/.hack/docker-compose.yml",
      "down",
    ]);

    expect(buildComposeDownCommand({ ...base, timeoutSeconds: 0 })).toEqual([
      "docker",
      "compose",
      "-p",
      "demo",
      "--project-directory",
      "/repo/.hack",
      "-f",
      "/repo/.hack/docker-compose.yml",
      "down",
      "--timeout",
      "0",
    ]);

    expect(buildComposeDownCommand({ ...base, timeoutSeconds: 7 })).toEqual([
      "docker",
      "compose",
      "-p",
      "demo",
      "--project-directory",
      "/repo/.hack",
      "-f",
      "/repo/.hack/docker-compose.yml",
      "down",
      "--timeout",
      "7",
    ]);
  });

  test(
    "CLI down passes --timeout only when configured and refuses invalid flag/config values",
    async () => {
      // 1. Unset: no --timeout flag passed to docker compose down, 0 docker events calls.
      const unsetFixture = await createComposeFixture();
      const unsetRun = await runCli({
        args: ["down"],
        cwd: unsetFixture.root,
        homeDir: unsetFixture.homeDir,
        binDir: unsetFixture.binDir,
        dockerLogPath: unsetFixture.dockerLogPath,
      });
      expect(unsetRun.exitCode).toBe(0);
      const unsetCalls = await readDockerCalls(unsetFixture.dockerLogPath);
      const unsetDownCall = unsetCalls.find(
        (argv) => argv[0] === "compose" && argv.includes("down")
      );
      expect(unsetDownCall).toBeDefined();
      expect(unsetDownCall).not.toContain("--timeout");
      expect(unsetCalls.filter((argv) => argv[0] === "events")).toHaveLength(0);

      // 2. Project config compose.downTimeoutSeconds passes --timeout <n>.
      const cfgFixture = await createComposeFixture({
        config: { compose: { downTimeoutSeconds: 8 } },
      });
      const cfgRun = await runCli({
        args: ["down"],
        cwd: cfgFixture.root,
        homeDir: cfgFixture.homeDir,
        binDir: cfgFixture.binDir,
        dockerLogPath: cfgFixture.dockerLogPath,
      });
      expect(cfgRun.exitCode).toBe(0);
      const cfgCalls = await readDockerCalls(cfgFixture.dockerLogPath);
      const cfgDownCall = cfgCalls.find(
        (argv) => argv[0] === "compose" && argv.includes("down")
      );
      expect(cfgDownCall?.slice(-3)).toEqual(["down", "--timeout", "8"]);

      // 3. CLI --timeout overrides compose.downTimeoutSeconds.
      const overrideRun = await runCli({
        args: ["down", "--timeout", "2"],
        cwd: cfgFixture.root,
        homeDir: cfgFixture.homeDir,
        binDir: cfgFixture.binDir,
        dockerLogPath: cfgFixture.dockerLogPath,
      });
      expect(overrideRun.exitCode).toBe(0);
      const allCfgCalls = await readDockerCalls(cfgFixture.dockerLogPath);
      const overrideDownCall = allCfgCalls
        .filter((argv) => argv[0] === "compose" && argv.includes("down"))
        .at(-1);
      expect(overrideDownCall?.slice(-3)).toEqual(["down", "--timeout", "2"]);

      // 4. Invalid --timeout refuses with E_USAGE in --json mode without touching Docker.
      const badFlagFixture = await createComposeFixture();
      const badFlagRun = await runCli({
        args: ["down", "--timeout", "601", "--json"],
        cwd: badFlagFixture.root,
        homeDir: badFlagFixture.homeDir,
        binDir: badFlagFixture.binDir,
        dockerLogPath: badFlagFixture.dockerLogPath,
      });
      expect(badFlagRun.exitCode).toBe(1);
      const badFlagJson = JSON.parse(badFlagRun.stdout) as {
        ok: boolean;
        error: { code: string; message: string };
      };
      expect(badFlagJson.ok).toBe(false);
      expect(badFlagJson.error.code).toBe("E_USAGE");
      expect(await readDockerCalls(badFlagFixture.dockerLogPath)).toHaveLength(
        0
      );

      // 5. Invalid compose.downTimeoutSeconds refuses with E_CONFIG_INVALID in --json mode.
      const badCfgFixture = await createComposeFixture({
        config: { compose: { downTimeoutSeconds: -5 } },
      });
      const badCfgRun = await runCli({
        args: ["down", "--json"],
        cwd: badCfgFixture.root,
        homeDir: badCfgFixture.homeDir,
        binDir: badCfgFixture.binDir,
        dockerLogPath: badCfgFixture.dockerLogPath,
      });
      expect(badCfgRun.exitCode).toBe(1);
      const badCfgJson = JSON.parse(badCfgRun.stdout) as {
        ok: boolean;
        error: { code: string; message: string };
      };
      expect(badCfgJson.ok).toBe(false);
      expect(badCfgJson.error.code).toBe("E_CONFIG_INVALID");
      expect(await readDockerCalls(badCfgFixture.dockerLogPath)).toHaveLength(
        0
      );
    },
    CLI_TIMEOUT_MS * 2
  );
});

describe("lifecycle tmux interrupt bounded poll", () => {
  test("returns immediately with zero sleeps when panes have already exited", async () => {
    let nowMs = 1000;
    const sleeps: number[] = [];
    const result = await waitForInterruptedTmuxPanes({
      windowNames: ["api", "worker"],
      readPanes: async () => [],
      now: () => nowMs,
      sleep: async (ms) => {
        sleeps.push(ms);
        nowMs += ms;
      },
    });
    expect(result).toEqual([[], []]);
    expect(sleeps).toEqual([]);
  }, 5000);

  test("stops polling as soon as all panes exit without waiting the full 750 ms grace period", async () => {
    let nowMs = 10_000;
    let pollRound = 0;
    const sleeps: number[] = [];
    const maxSteps = 100;

    const result = await waitForInterruptedTmuxPanes({
      windowNames: ["api", "worker"],
      readPanes: async (windowName) => {
        if (windowName === "api") {
          pollRound += 1;
        }
        if (pollRound >= 3) {
          return [];
        }
        return windowName === "api" ? [101] : pollRound === 1 ? [202] : [];
      },
      now: () => nowMs,
      sleep: async (ms) => {
        if (sleeps.length >= maxSteps) {
          throw new Error(
            "hang guard triggered in waitForInterruptedTmuxPanes"
          );
        }
        sleeps.push(ms);
        nowMs += ms;
      },
    });

    expect(result).toEqual([[], []]);
    expect(sleeps).toEqual([
      LIFECYCLE_TMUX_INTERRUPT_POLL_INTERVAL_MS,
      LIFECYCLE_TMUX_INTERRUPT_POLL_INTERVAL_MS,
    ]);
    expect(nowMs - 10_000).toBe(50);
  }, 5000);

  test("bounds polling at the grace deadline and clamps the final sleep when panes survive", async () => {
    let nowMs = 50_000;
    const sleeps: number[] = [];
    const maxSteps = 100;

    const result = await waitForInterruptedTmuxPanes({
      windowNames: ["stubborn"],
      graceMs: 70,
      pollIntervalMs: 25,
      readPanes: async () => [4242],
      now: () => nowMs,
      sleep: async (ms) => {
        if (sleeps.length >= maxSteps) {
          throw new Error(
            "hang guard triggered in waitForInterruptedTmuxPanes"
          );
        }
        sleeps.push(ms);
        nowMs += ms;
      },
    });

    expect(result).toEqual([[4242]]);
    expect(sleeps).toEqual([25, 25, 20]);
    expect(nowMs - 50_000).toBe(70);
    expect(LIFECYCLE_TMUX_INTERRUPT_GRACE_MS).toBe(750);
  }, 5000);

  test("stops immediately if assertFresh throws during polling", async () => {
    let checks = 0;
    let nowMs = 0;
    await expect(
      waitForInterruptedTmuxPanes({
        windowNames: ["api"],
        readPanes: async () => [99],
        now: () => nowMs,
        sleep: async (ms) => {
          nowMs += ms;
        },
        assertFresh: async () => {
          checks += 1;
          if (checks === 2) {
            throw new Error("ownership lost");
          }
        },
      })
    ).rejects.toThrow("ownership lost");
    expect(checks).toBe(2);
  }, 5000);
});

describe("compose down exit-137 slow-stop hints and hack doctor", () => {
  test("makes 0 extra Docker calls on the fast path and with --timeout 0, and 1 bounded call on the slow path", async () => {
    expect(slowStopProbeThresholdMs(0)).toBeNull();
    expect(slowStopProbeThresholdMs(1)).toBe(750);
    expect(slowStopProbeThresholdMs(undefined)).toBe(5000);

    const fastCalls: (readonly string[])[] = [];
    const fast = await observeComposeDownSlowStops({
      composeProject: "demo",
      downElapsedMs: 400,
      downStartedAtMs: 1_700_000_000_000,
      downEndedAtMs: 1_700_000_000_400,
      cwd: "/tmp",
      execImpl: async (cmd) => {
        fastCalls.push(cmd);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(fast).toEqual({ probed: false, services: [] });
    expect(fastCalls).toHaveLength(0);

    const zeroTimeoutCalls: (readonly string[])[] = [];
    const zeroTimeout = await observeComposeDownSlowStops({
      composeProject: "demo",
      downElapsedMs: 12_000,
      downStartedAtMs: 1_700_000_000_000,
      downEndedAtMs: 1_700_000_012_000,
      timeoutSeconds: 0,
      cwd: "/tmp",
      execImpl: async (cmd) => {
        zeroTimeoutCalls.push(cmd);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(zeroTimeout).toEqual({ probed: false, services: [] });
    expect(zeroTimeoutCalls).toHaveLength(0);

    const slowCalls: {
      cmd: readonly string[];
      env?: Record<string, string>;
    }[] = [];
    const eventsStdout = [
      JSON.stringify({
        Type: "container",
        Action: "die",
        timeNano: 1_700_000_010_500 * 1_000_000,
        Actor: {
          Attributes: {
            "com.docker.compose.project": "demo",
            "com.docker.compose.service": "api",
            exitCode: "137",
          },
        },
      }),
      JSON.stringify({
        Type: "container",
        Action: "die",
        timeNano: 1_700_000_001_000 * 1_000_000,
        Actor: {
          Attributes: {
            "com.docker.compose.project": "demo",
            "com.docker.compose.service": "db",
            exitCode: "0",
          },
        },
      }),
      JSON.stringify({
        Type: "container",
        Action: "die",
        timeNano: 1_700_000_010_500 * 1_000_000,
        Actor: {
          Attributes: {
            "com.docker.compose.project": "other-project",
            "com.docker.compose.service": "worker",
            exitCode: "137",
          },
        },
      }),
      JSON.stringify({
        Type: "container",
        Action: "die",
        timeNano: 1_699_999_998_000 * 1_000_000,
        Actor: {
          Attributes: {
            "com.docker.compose.project": "demo",
            "com.docker.compose.service": "stale",
            exitCode: "137",
          },
        },
      }),
    ].join("\n");

    const slow = await observeComposeDownSlowStops({
      composeProject: "demo",
      downElapsedMs: 10_500,
      downStartedAtMs: 1_700_000_000_000,
      downEndedAtMs: 1_700_000_010_500,
      cwd: "/tmp",
      env: {
        DOCKER_HOST: "unix:///var/run/docker.sock",
        HACK_ENV_0123456789AB_SECRET: "do-not-leak",
      },
      execImpl: async (cmd, opts) => {
        slowCalls.push({ cmd, env: opts?.env });
        return { exitCode: 0, stdout: eventsStdout, stderr: "" };
      },
    });
    expect(slow).toEqual({ probed: true, services: ["api"] });
    expect(slowCalls).toHaveLength(1);
    expect(slowCalls[0]?.cmd).toContain("events");
    expect(slowCalls[0]?.cmd).toContain(
      "label=com.docker.compose.project=demo"
    );
    expect(slowCalls[0]?.env?.DOCKER_HOST).toBe("unix:///var/run/docker.sock");
    expect(slowCalls[0]?.env?.HACK_ENV_0123456789AB_SECRET).toBeUndefined();

    expect(
      parseComposeDownExit137Services({
        stdout: eventsStdout,
        composeProject: "demo",
        windowStartMs: 1_700_000_000_000,
      })
    ).toEqual(["api"]);
  });

  test("emits one-line exit-137 hint in text mode and valid JSON with hint fields in JSON mode", async () => {
    const fixture = await createComposeFixture({ name: "slow-stop-demo" });
    const prevPath = process.env.PATH;
    const prevHome = process.env.HOME;
    const prevXdg = process.env.XDG_CONFIG_HOME;
    const prevGlobalCfg = process.env.HACK_GLOBAL_CONFIG_PATH;
    const prevAutostart = process.env.HACK_DAEMON_AUTOSTART_DISABLE;
    const prevNoInteractive = process.env.HACK_NO_INTERACTIVE;
    const prevBackend = process.env.HACK_RUNTIME_BACKEND;
    const prevDockerLog = process.env.FAKE_DOCKER_LOG;

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    const origStderrWrite = process.stderr.write.bind(process.stderr);

    const eventsLine = JSON.stringify({
      Type: "container",
      Action: "die",
      timeNano: 1_700_000_010_200 * 1_000_000,
      Actor: {
        Attributes: {
          "com.docker.compose.project": "slow-stop-demo",
          "com.docker.compose.service": "api",
          exitCode: "137",
        },
      },
    });

    const restoreEnv = (key: string, prev: string | undefined) => {
      if (prev === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prev;
      }
    };
    try {
      process.env.PATH = `${fixture.binDir}:${prevPath ?? ""}`;
      process.env.HOME = fixture.homeDir;
      process.env.XDG_CONFIG_HOME = join(fixture.homeDir, ".config");
      process.env.HACK_GLOBAL_CONFIG_PATH = join(
        fixture.homeDir,
        ".hack",
        "hack.config.json"
      );
      process.env.HACK_DAEMON_AUTOSTART_DISABLE = "1";
      process.env.HACK_NO_INTERACTIVE = "1";
      process.env.HACK_RUNTIME_BACKEND = "compose";
      process.env.FAKE_DOCKER_LOG = fixture.dockerLogPath;
      setLoggerBackendOverride({ backend: "console" });

      process.stdout.write = ((chunk: string | Uint8Array) => {
        stdoutChunks.push(
          typeof chunk === "string"
            ? chunk
            : Buffer.from(chunk).toString("utf8")
        );
        return true;
      }) as typeof process.stdout.write;
      process.stderr.write = ((chunk: string | Uint8Array) => {
        stderrChunks.push(
          typeof chunk === "string"
            ? chunk
            : Buffer.from(chunk).toString("utf8")
        );
        return true;
      }) as typeof process.stderr.write;

      const baseArgs = {
        options: {
          path: fixture.root,
          project: undefined,
          env: undefined,
          branch: undefined,
          profile: undefined,
          target: undefined,
          timeout: undefined,
          pruneCaches: false,
          removeData: false,
          yes: false,
          json: false,
          progress: false,
          recoverNativeCompose: false,
        },
        positionals: {},
        raw: { argv: [], positionals: [] },
      } as const;

      // Text mode: prints one line naming the service and suggesting init: true / signal handler.
      const textNow = [1_700_000_000_000, 1_700_000_010_500];
      const textPerf = [0, 10_500];
      let textNowIdx = 0;
      let textPerfIdx = 0;
      const textCode = await runDownCommand({
        ctx: {
          cwd: fixture.root,
          cli: {
            name: "hack",
            version: "0.0.0-test",
            summary: "",
            commands: [],
            globalOptions: [],
          },
        },
        args: baseArgs,
        json: false,
        slowStopDeps: {
          nowMs: () => textNow[Math.min(textNowIdx++, textNow.length - 1)]!,
          perfNowMs: () =>
            textPerf[Math.min(textPerfIdx++, textPerf.length - 1)]!,
          execImpl: async () => ({
            exitCode: 0,
            stdout: `${eventsLine}\n`,
            stderr: "",
          }),
        },
      });
      expect(textCode).toBe(0);
      const textOutput = stderrChunks.join("");
      const hintLine = formatSlowStopHint("api");
      expect(textOutput).toContain(hintLine);
      expect(hintLine).toContain("api");
      expect(hintLine).toContain("137");
      expect(hintLine).toContain("init: true");
      expect(hintLine).toContain("SIGTERM");
      expect(hintLine.includes("\n")).toBe(false);

      // Persisted slow-stop entry is available for hack doctor.
      const persisted = await readProjectSlowStops({
        projectDir: fixture.projectDir,
      });
      expect(persisted).toHaveLength(1);
      expect(persisted[0]?.services).toEqual(["api"]);

      // JSON mode: stdout is strictly valid JSON containing slowStops & warnings, no raw text.
      stdoutChunks.length = 0;
      stderrChunks.length = 0;
      const jsonNow = [1_700_000_000_000, 1_700_000_010_500];
      const jsonPerf = [0, 10_500];
      let jsonNowIdx = 0;
      let jsonPerfIdx = 0;
      const jsonCode = await runDownCommand({
        ctx: {
          cwd: fixture.root,
          cli: {
            name: "hack",
            version: "0.0.0-test",
            summary: "",
            commands: [],
            globalOptions: [],
          },
        },
        args: {
          ...baseArgs,
          options: { ...baseArgs.options, json: true },
        },
        json: true,
        startedAtMs: 1_700_000_000_000,
        slowStopDeps: {
          nowMs: () => jsonNow[Math.min(jsonNowIdx++, jsonNow.length - 1)]!,
          perfNowMs: () =>
            jsonPerf[Math.min(jsonPerfIdx++, jsonPerf.length - 1)]!,
          execImpl: async () => ({
            exitCode: 0,
            stdout: `${eventsLine}\n`,
            stderr: "",
          }),
        },
      });
      expect(jsonCode).toBe(0);
      const rawStdout = stdoutChunks.join("");
      const parsed = JSON.parse(rawStdout) as {
        ok: boolean;
        data: {
          action: string;
          slowStops?: readonly {
            service: string;
            exitCode: number;
            hint: string;
          }[];
          warnings?: readonly string[];
        };
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.data.action).toBe("down");
      expect(parsed.data.slowStops).toEqual(buildSlowStopHints(["api"]));
      expect(parsed.data.warnings).toContain(hintLine);
      expect(stderrChunks.join("")).not.toContain(hintLine);

      // Clean down clears the persisted slow-stop record.
      stdoutChunks.length = 0;
      const cleanNow = [1_700_000_020_000, 1_700_000_020_200];
      const cleanPerf = [0, 200];
      let cleanNowIdx = 0;
      let cleanPerfIdx = 0;
      const cleanCode = await runDownCommand({
        ctx: {
          cwd: fixture.root,
          cli: {
            name: "hack",
            version: "0.0.0-test",
            summary: "",
            commands: [],
            globalOptions: [],
          },
        },
        args: {
          ...baseArgs,
          options: { ...baseArgs.options, json: true },
        },
        json: true,
        startedAtMs: 1_700_000_020_000,
        slowStopDeps: {
          nowMs: () => cleanNow[Math.min(cleanNowIdx++, cleanNow.length - 1)]!,
          perfNowMs: () =>
            cleanPerf[Math.min(cleanPerfIdx++, cleanPerf.length - 1)]!,
          execImpl: async () => {
            throw new Error("should not call docker events on fast path");
          },
        },
      });
      expect(cleanCode).toBe(0);
      const cleanParsed = JSON.parse(stdoutChunks.join("")) as {
        ok: boolean;
        data: { slowStops?: unknown; warnings?: unknown };
      };
      expect(cleanParsed.ok).toBe(true);
      expect(cleanParsed.data.slowStops).toBeUndefined();
      expect(cleanParsed.data.warnings).toBeUndefined();
      expect(
        await readProjectSlowStops({ projectDir: fixture.projectDir })
      ).toEqual([]);
    } finally {
      process.stdout.write = origStdoutWrite;
      process.stderr.write = origStderrWrite;
      restoreEnv("PATH", prevPath);
      restoreEnv("HOME", prevHome);
      restoreEnv("XDG_CONFIG_HOME", prevXdg);
      restoreEnv("HACK_GLOBAL_CONFIG_PATH", prevGlobalCfg);
      restoreEnv("HACK_DAEMON_AUTOSTART_DISABLE", prevAutostart);
      restoreEnv("HACK_NO_INTERACTIVE", prevNoInteractive);
      restoreEnv("HACK_RUNTIME_BACKEND", prevBackend);
      restoreEnv("FAKE_DOCKER_LOG", prevDockerLog);
    }

    // Verify buildLifecycleJsonData merges interruption + slowStop warnings cleanly.
    const combined = buildLifecycleJsonData({
      action: "down",
      project: "demo",
      branch: null,
      composeProject: "demo",
      interruption: { services: ["migrate"], warning: "Interrupted migrate." },
      slowStops: buildSlowStopHints(["api"]),
      durationMs: 123,
    });
    expect(combined.slowStops).toEqual(buildSlowStopHints(["api"]));
    expect(combined.warnings).toEqual([
      "Interrupted migrate.",
      formatSlowStopHint("api"),
    ]);
  });

  test("hack doctor surfaces recorded and live exit-137 services and clears them after init: true is added", async () => {
    const fixture = await createComposeFixture({ name: "doctor-slow-demo" });

    // 1. Clean project -> ok.
    const cleanCheck = await checkComposeSlowStops({
      startDir: fixture.root,
      dockerOk: false,
    });
    expect(cleanCheck.name).toBe(COMPOSE_SLOW_STOPS_CHECK);
    expect(cleanCheck.status).toBe("ok");
    expect(cleanCheck.composeSlowStops).toBeUndefined();

    // 2. Recorded exit-137 service -> warn with same hint + structured JSON field.
    await recordProjectSlowStops({
      projectDir: fixture.projectDir,
      composeProject: "doctor-slow-demo",
      services: ["api"],
    });
    const warnCheck = await checkComposeSlowStops({
      startDir: fixture.root,
      dockerOk: false,
    });
    expect(warnCheck.status).toBe("warn");
    expect(warnCheck.message).toContain(formatSlowStopHint("api"));
    expect(warnCheck.composeSlowStops).toEqual({
      services: ["api"],
      exitCode: 137,
      hints: buildSlowStopHints(["api"]),
    });

    const doctorJson = buildDoctorJsonData({
      results: [{ ...warnCheck, durationMs: 2 }],
    });
    expect(doctorJson.checks).toHaveLength(1);
    const checkJson = doctorJson.checks[0]!;
    expect(checkJson.id).toBe(COMPOSE_SLOW_STOPS_CHECK);
    expect(checkJson.area).toBe("engine");
    expect(checkJson.scope).toBe("project");
    expect(checkJson.status).toBe("warn");
    expect(checkJson.composeSlowStops).toEqual(warnCheck.composeSlowStops);

    // 3. Live exited-137 container reported by Docker is also surfaced.
    const liveWarnCheck = await checkComposeSlowStops({
      startDir: fixture.root,
      dockerOk: true,
      readRuntime: async () => ({
        ok: true,
        error: null,
        checkedAtMs: 1,
        runtime: [
          {
            project: "doctor-slow-demo",
            workingDir: fixture.projectDir,
            isGlobal: false,
            services: new Map([
              [
                "web",
                {
                  service: "web",
                  containers: [
                    {
                      id: "c1",
                      project: "doctor-slow-demo",
                      service: "web",
                      state: "exited",
                      status: "Exited (137) 10 seconds ago",
                      name: "doctor-slow-demo-web-1",
                      ports: "",
                      workingDir: fixture.projectDir,
                      image: "alpine:3.20",
                      labels: null,
                      mounts: [],
                      networks: [],
                    },
                  ],
                },
              ],
            ]),
          },
        ],
      }),
    });
    expect(liveWarnCheck.status).toBe("warn");
    expect(liveWarnCheck.composeSlowStops?.services).toEqual(["api", "web"]);

    // 4. Adding `init: true` to the service clears the finding.
    await writeFile(
      join(fixture.projectDir, "docker-compose.yml"),
      [
        "services:",
        "  api:",
        "    image: alpine:3.20",
        "    init: true",
        "  web:",
        "    image: alpine:3.20",
        "",
      ].join("\n")
    );
    const fixedCheck = await checkComposeSlowStops({
      startDir: fixture.root,
      dockerOk: false,
    });
    expect(fixedCheck.status).toBe("ok");
    expect(fixedCheck.composeSlowStops).toBeUndefined();
  });
});
