import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildComposeDownCommand } from "../src/backends/runtime-backend.ts";
import { buildDoctorJsonData } from "../src/commands/doctor.ts";
import { buildLifecycleJsonData } from "../src/commands/project.ts";
import { HackCliError } from "../src/lib/cli-result.ts";
import {
  DEFAULT_COMPOSE_DOWN_CAP_MS,
  MAX_COMPOSE_DOWN_CAP_MS,
  parseComposeDownTimeoutFlag,
  resolveComposeDownCapMs,
  resolveComposeDownTimeoutSeconds,
} from "../src/lib/compose-down-budget.ts";
import {
  buildSlowStopHints,
  finalizeComposeDownSlowStops,
  formatSlowStopHint,
  observeComposeDownSlowStops,
  parseComposeDownDieEvents,
  parseComposeDurationMs,
  readComposeServiceStopMeta,
  readProjectSlowStops,
  recordProjectSlowStops,
  resolveProjectSlowStopsPath,
  SLOW_STOP_EVENTS_TIMEOUT_MS,
  SLOW_STOP_RECORD_TTL_MS,
  slowStopProbeThresholdMs,
} from "../src/lib/compose-down-slow-stop.ts";
import {
  COMPOSE_SLOW_STOPS_CHECK,
  checkComposeSlowStops,
} from "../src/lib/doctor-compose-slow-stops.ts";
import { upsertLifecycleStateEntry } from "../src/lib/lifecycle-runtime.ts";
import { findProjectContext, readProjectConfig } from "../src/lib/project.ts";
import {
  LIFECYCLE_TMUX_INTERRUPT_GRACE_MS,
  LIFECYCLE_TMUX_INTERRUPT_POLL_INTERVAL_MS,
  resolveLifecycleSessionName,
  stopLifecycleProcessController,
  waitForInterruptedTmuxPanes,
} from "../src/lib/project-lifecycle-controller.ts";
import type { MuxBackend } from "../src/mux/mux-backend.ts";
import type { ResolvedMux } from "../src/mux/mux-resolver.ts";
import { setLoggerBackendOverride } from "../src/ui/logger.ts";
import { restoreEnv } from "./helpers/env.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const CLI_ENTRY = join(REPO_ROOT, "index.ts");
const CLI_TIMEOUT_MS = 30_000;

const tempDirs: string[] = [];

afterEach(async () => {
  setLoggerBackendOverride({ backend: null });
  for (const dir of tempDirs.splice(0)) {
    // Restore permissions in case a test marked .internal or slow-stops.json read-only.
    await chmod(join(dir, ".hack", ".internal"), 0o700).catch(() => undefined);
    await chmod(
      join(dir, ".hack", ".internal", "slow-stops.json"),
      0o600
    ).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

type FakeDockerConfig = {
  readonly psJson?: string;
  readonly downDelayMs?: number;
  readonly downExitCode?: number;
  readonly eventsStdout?: string;
  readonly eventsExitCode?: number;
};

async function createComposeFixture(opts?: {
  readonly name?: string;
  readonly composeYaml?: string;
  readonly config?: Record<string, unknown>;
  readonly dockerConfig?: FakeDockerConfig;
}): Promise<{
  readonly root: string;
  readonly projectDir: string;
  readonly homeDir: string;
  readonly binDir: string;
  readonly dockerLogPath: string;
  readonly setDockerConfig: (config: FakeDockerConfig) => Promise<void>;
}> {
  const root = await makeTempDir("hack-down-bounded-");
  const projectDir = join(root, ".hack");
  const homeDir = join(root, "home");
  const binDir = join(root, "bin");
  const dockerLogPath = join(root, "docker-calls.jsonl");
  const dockerConfigPath = join(root, "fake-docker-config.json");
  await mkdir(projectDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });

  const setDockerConfig = async (config: FakeDockerConfig): Promise<void> => {
    await writeFile(dockerConfigPath, JSON.stringify(config));
  };
  await setDockerConfig(opts?.dockerConfig ?? {});

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

  // Fake `docker` shim with paths baked in so `dockerHelperEnvironment` env stripping
  // never hides `docker events` calls or fixture behavior.
  const dockerShim = join(binDir, "docker");
  await writeFile(
    dockerShim,
    [
      `#!${process.execPath}`,
      'import { appendFileSync, readFileSync } from "node:fs";',
      `const logPath = ${JSON.stringify(dockerLogPath)};`,
      `const configPath = ${JSON.stringify(dockerConfigPath)};`,
      "let cfg = {};",
      'try { cfg = JSON.parse(readFileSync(configPath, "utf8")); } catch {}',
      "const args = process.argv.slice(2);",
      'appendFileSync(logPath, JSON.stringify(args) + "\\n");',
      'if (args[0] === "compose" && args.includes("ps")) {',
      '  process.stdout.write(typeof cfg.psJson === "string" ? cfg.psJson : "[]\\n");',
      "  process.exit(0);",
      "}",
      'if (args[0] === "compose" && args.includes("down")) {',
      "  const delayMs = Number(cfg.downDelayMs ?? 0);",
      "  if (Number.isFinite(delayMs) && delayMs > 0) {",
      "    await Bun.sleep(delayMs);",
      "  }",
      "  const code = Number(cfg.downExitCode ?? 0);",
      "  process.exit(Number.isInteger(code) ? code : 0);",
      "}",
      'if (args[0] === "ps") {',
      '  process.stdout.write("");',
      "  process.exit(0);",
      "}",
      'if (args[0] === "info") {',
      '  process.stdout.write(typeof cfg.infoStdout === "string" ? cfg.infoStdout : `${new Date().toISOString()}\\n`);',
      "  process.exit(0);",
      "}",
      'if (args[0] === "events") {',
      '  process.stdout.write(typeof cfg.eventsStdout === "string" ? cfg.eventsStdout : "");',
      "  const code = Number(cfg.eventsExitCode ?? 0);",
      "  process.exit(Number.isInteger(code) ? code : 0);",
      "}",
      "process.exit(0);",
      "",
    ].join("\n")
  );
  await chmod(dockerShim, 0o755);

  return { root, projectDir, homeDir, binDir, dockerLogPath, setDockerConfig };
}

async function runCli(opts: {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly homeDir: string;
  readonly binDir: string;
  readonly extraEnv?: Readonly<Record<string, string>>;
}): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const proc = Bun.spawn([process.execPath, CLI_ENTRY, ...opts.args], {
    cwd: opts.cwd,
    env: privateCliEnv({
      root: opts.cwd,
      home: opts.homeDir,
      env: {
        PATH: `${opts.binDir}:${process.env.PATH ?? ""}`,
        XDG_CONFIG_HOME: join(opts.homeDir, ".config"),
        HACK_GLOBAL_CONFIG_PATH: join(
          opts.homeDir,
          ".hack",
          "hack.config.json"
        ),
        HACK_NO_INTERACTIVE: "1",
        HACK_RUNTIME_BACKEND: "compose",
        HACK_LOGGER: "console",
        ...(opts.extraEnv ?? {}),
      },
    }),
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

function makeDieEventJson(opts: {
  readonly composeProject: string;
  readonly service: string;
  readonly exitCode: string;
}): string {
  return JSON.stringify({
    Type: "container",
    Action: "die",
    Actor: {
      ID: `cid-${opts.service}`,
      Attributes: {
        "com.docker.compose.project": opts.composeProject,
        "com.docker.compose.service": opts.service,
        exitCode: opts.exitCode,
      },
    },
  });
}

describe("compose down stop timeout validation and cap", () => {
  test("accepts canonical integers 0..600 and refuses whitespace, leading zeros, and out-of-range values", () => {
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
      " 5 ",
      "007",
      "00",
      "+5",
      "1e2",
      "Infinity",
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
      resolveComposeDownTimeoutSeconds({
        flagValue: undefined,
        projectValue: undefined,
      })
    ).toBeUndefined();
    expect(
      resolveComposeDownTimeoutSeconds({
        flagTimeoutSeconds: 0,
        projectValue: 25,
      })
    ).toBe(0);
    expect(
      resolveComposeDownTimeoutSeconds({
        flagValue: undefined,
        projectValue: 12,
      })
    ).toBe(12);

    for (const bad of [-1, 601, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      let caught: unknown;
      try {
        resolveComposeDownTimeoutSeconds({
          flagValue: undefined,
          projectValue: bad,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(HackCliError);
      expect((caught as HackCliError).code).toBe("E_CONFIG_INVALID");
    }

    const fixture = await createComposeFixture({
      config: { compose: { downTimeoutSeconds: 4 } },
    });
    const ctx = await findProjectContext(fixture.root);
    expect(ctx).not.toBeNull();
    const cfg = await readProjectConfig(ctx!);
    expect(cfg.compose?.downTimeoutSeconds).toBe(4);
  });

  test("keeps overall down cap at or above the 90s floor and bounds it at 15 minutes", () => {
    expect(DEFAULT_COMPOSE_DOWN_CAP_MS).toBe(90_000);
    expect(MAX_COMPOSE_DOWN_CAP_MS).toBe(900_000);
    expect(resolveComposeDownCapMs(undefined)).toBe(90_000);

    // Must never go below today's 90 s floor for low --timeout values.
    for (const low of [0, 1, 2, 5, 9, 10, 30]) {
      expect(resolveComposeDownCapMs(low)).toBe(90_000);
    }

    // Scales cleanly above 90 s for larger valid timeouts, capped at 900 s (not 3,630 s).
    expect(resolveComposeDownCapMs(60)).toBe(150_000);
    expect(resolveComposeDownCapMs(300)).toBe(630_000);
    expect(resolveComposeDownCapMs(600)).toBe(900_000);

    expect(() => resolveComposeDownCapMs(-1)).toThrow(HackCliError);
    expect(() => resolveComposeDownCapMs(601)).toThrow(HackCliError);
  });

  test("builds docker compose down argv with and without --timeout", () => {
    const baseOpts = {
      composeFiles: ["/repo/.hack/docker-compose.yml"],
      composeProject: "demo",
      profiles: [] as const,
      cwd: "/repo/.hack",
    };
    expect(buildComposeDownCommand(baseOpts)).toEqual([
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
    expect(
      buildComposeDownCommand({ ...baseOpts, timeoutSeconds: 0 }).slice(-3)
    ).toEqual(["down", "--timeout", "0"]);
    expect(
      buildComposeDownCommand({ ...baseOpts, timeoutSeconds: 7 }).slice(-3)
    ).toEqual(["down", "--timeout", "7"]);
  });

  test("CLI down forwards --timeout/config and keeps clean --timeout 1 on the zero-events fast path", async () => {
    // 1. Unset: no --timeout passed, 0 docker events calls.
    const unsetFixture = await createComposeFixture();
    const unsetRun = await runCli({
      args: ["down"],
      cwd: unsetFixture.root,
      homeDir: unsetFixture.homeDir,
      binDir: unsetFixture.binDir,
    });
    expect(unsetRun.exitCode).toBe(0);
    const unsetCalls = await readDockerCalls(unsetFixture.dockerLogPath);
    const unsetDown = unsetCalls.find(
      (argv) => argv[0] === "compose" && argv.includes("down")
    );
    expect(unsetDown).toBeDefined();
    expect(unsetDown).not.toContain("--timeout");
    expect(unsetCalls.filter((argv) => argv[0] === "events")).toHaveLength(0);

    // 2. Clean --timeout 1 fast stop makes 0 docker events calls.
    const cleanOneFixture = await createComposeFixture();
    const cleanOneRun = await runCli({
      args: ["down", "--timeout", "1"],
      cwd: cleanOneFixture.root,
      homeDir: cleanOneFixture.homeDir,
      binDir: cleanOneFixture.binDir,
    });
    expect(cleanOneRun.exitCode).toBe(0);
    const cleanOneCalls = await readDockerCalls(cleanOneFixture.dockerLogPath);
    expect(
      cleanOneCalls
        .find((argv) => argv[0] === "compose" && argv.includes("down"))
        ?.slice(-3)
    ).toEqual(["down", "--timeout", "1"]);
    expect(cleanOneCalls.filter((argv) => argv[0] === "events")).toHaveLength(
      0
    );

    // 3. Config compose.downTimeoutSeconds + CLI override precedence.
    const cfgFixture = await createComposeFixture({
      config: { compose: { downTimeoutSeconds: 8 } },
    });
    const cfgRun = await runCli({
      args: ["down"],
      cwd: cfgFixture.root,
      homeDir: cfgFixture.homeDir,
      binDir: cfgFixture.binDir,
    });
    expect(cfgRun.exitCode).toBe(0);
    const cfgCalls = await readDockerCalls(cfgFixture.dockerLogPath);
    expect(
      cfgCalls
        .find((argv) => argv[0] === "compose" && argv.includes("down"))
        ?.slice(-3)
    ).toEqual(["down", "--timeout", "8"]);

    const overrideRun = await runCli({
      args: ["down", "--timeout", "2"],
      cwd: cfgFixture.root,
      homeDir: cfgFixture.homeDir,
      binDir: cfgFixture.binDir,
    });
    expect(overrideRun.exitCode).toBe(0);
    const allCfgCalls = await readDockerCalls(cfgFixture.dockerLogPath);
    expect(
      allCfgCalls
        .filter((argv) => argv[0] === "compose" && argv.includes("down"))
        .at(-1)
        ?.slice(-3)
    ).toEqual(["down", "--timeout", "2"]);
  }, 60_000);

  test("CLI down refuses invalid flag/config values and refuses --timeout on the native backend", async () => {
    // 1. Invalid --timeout (including "007") refuses with E_USAGE and 0 Docker calls.
    const badFlagFixture = await createComposeFixture();
    const badFlagRun = await runCli({
      args: ["down", "--timeout", "007", "--json"],
      cwd: badFlagFixture.root,
      homeDir: badFlagFixture.homeDir,
      binDir: badFlagFixture.binDir,
    });
    expect(badFlagRun.exitCode).toBe(1);
    expect(JSON.parse(badFlagRun.stdout)).toMatchObject({
      ok: false,
      error: { code: "E_USAGE" },
    });
    expect(await readDockerCalls(badFlagFixture.dockerLogPath)).toHaveLength(0);

    // 2. Invalid compose.downTimeoutSeconds refuses with E_CONFIG_INVALID.
    const badCfgFixture = await createComposeFixture({
      config: { compose: { downTimeoutSeconds: -5 } },
    });
    const badCfgRun = await runCli({
      args: ["down", "--json"],
      cwd: badCfgFixture.root,
      homeDir: badCfgFixture.homeDir,
      binDir: badCfgFixture.binDir,
    });
    expect(badCfgRun.exitCode).toBe(1);
    expect(JSON.parse(badCfgRun.stdout)).toMatchObject({
      ok: false,
      error: { code: "E_CONFIG_INVALID" },
    });
    expect(await readDockerCalls(badCfgFixture.dockerLogPath)).toHaveLength(0);

    // 3. Native backend refuses --timeout cleanly without calling Docker.
    const nativeFixture = await createComposeFixture();
    const nativeRun = await runCli({
      args: ["down", "--timeout", "2", "--json"],
      cwd: nativeFixture.root,
      homeDir: nativeFixture.homeDir,
      binDir: nativeFixture.binDir,
      extraEnv: {
        HACK_RUNTIME_BACKEND: "native",
        HACK_NATIVE_BINARY: "/nonexistent-native-binary",
      },
    });
    expect(nativeRun.exitCode).toBe(1);
    const nativeCombined = `${nativeRun.stdout}\n${nativeRun.stderr}`;
    expect(nativeCombined).toContain("--timeout");
    expect(nativeCombined).toContain("Native down");
    expect(await readDockerCalls(nativeFixture.dockerLogPath)).toHaveLength(0);
  }, 60_000);
});

describe("lifecycle tmux interrupt bounded poll and forced retirement", () => {
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
  });

  test("stops polling as soon as all panes exit without waiting the full 750 ms grace period", async () => {
    let nowMs = 5000;
    const sleeps: number[] = [];
    const polls = new Map<string, number>([
      ["api", 0],
      ["worker", 0],
    ]);
    const result = await waitForInterruptedTmuxPanes({
      windowNames: ["api", "worker"],
      readPanes: async (windowName) => {
        const count = (polls.get(windowName) ?? 0) + 1;
        polls.set(windowName, count);
        if (windowName === "api") {
          return count >= 2 ? [] : [101];
        }
        return count >= 3 ? [] : [202];
      },
      now: () => nowMs,
      sleep: async (ms) => {
        sleeps.push(ms);
        nowMs += ms;
      },
    });
    expect(result).toEqual([[], []]);
    expect(sleeps).toEqual([
      LIFECYCLE_TMUX_INTERRUPT_POLL_INTERVAL_MS,
      LIFECYCLE_TMUX_INTERRUPT_POLL_INTERVAL_MS,
    ]);
    expect(nowMs - 5000).toBe(50);
  });

  test("bounds polling at the grace deadline and clamps the final sleep when panes survive", async () => {
    let nowMs = 10_000;
    const sleeps: number[] = [];
    let reads = 0;
    const result = await waitForInterruptedTmuxPanes({
      windowNames: ["stubborn"],
      graceMs: 60,
      pollIntervalMs: 25,
      readPanes: async () => {
        reads += 1;
        if (reads > 10) {
          throw new Error("poll loop exceeded hang guard");
        }
        return [999];
      },
      now: () => nowMs,
      sleep: async (ms) => {
        sleeps.push(ms);
        nowMs += ms;
      },
    });
    expect(result).toEqual([[999]]);
    expect(sleeps).toEqual([25, 25, 10]);
    expect(nowMs - 10_000).toBe(60);
    expect(reads).toBe(4);
  });

  test("stops immediately if assertFresh throws during polling", async () => {
    let nowMs = 0;
    let checks = 0;
    const sleeps: number[] = [];
    await expect(
      waitForInterruptedTmuxPanes({
        windowNames: ["api"],
        readPanes: async () => [42],
        assertFresh: async () => {
          checks += 1;
          if (checks === 2) {
            throw new Error("ownership displaced");
          }
        },
        now: () => nowMs,
        sleep: async (ms) => {
          sleeps.push(ms);
          nowMs += ms;
        },
      })
    ).rejects.toThrow("ownership displaced");
    expect(sleeps).toEqual([LIFECYCLE_TMUX_INTERRUPT_POLL_INTERVAL_MS]);
  });

  test("stopLifecycleProcessController polls tmux grace and passes surviving panes to forced retirement", async () => {
    const root = await makeTempDir("hack-tmux-retire-");
    const projectDir = join(root, ".hack");
    const binDir = join(root, "bin");
    const tmuxLogPath = join(root, "tmux-calls.jsonl");
    await mkdir(projectDir, { recursive: true });
    await mkdir(binDir, { recursive: true });

    // Fake tmux shim: logs every invocation and keeps returning the live runner PID on list-panes
    // so the grace poll runs and hands the stubborn pane PID off to forced retirement.
    const tmuxShim = join(binDir, "tmux");
    await writeFile(
      tmuxShim,
      [
        `#!${process.execPath}`,
        'import { appendFileSync } from "node:fs";',
        `appendFileSync(${JSON.stringify(tmuxLogPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
        'if (process.argv.slice(2).includes("list-panes")) {',
        `  process.stdout.write("${process.pid}\\n");`,
        "}",
        "process.exit(0);",
        "",
      ].join("\n")
    );
    await chmod(tmuxShim, 0o755);

    const projectName = "demo";
    const composeProject = "demo";
    const sessionName = resolveLifecycleSessionName({
      projectName,
      branch: null,
    });
    const ownershipToken = "tok-stubborn-pane";

    await upsertLifecycleStateEntry({
      projectDir,
      entry: {
        projectName,
        composeProject,
        branch: null,
        sessionName,
        backend: "tmux",
        definitionHash: "def-hash",
        ownershipToken,
        updatedAt: new Date().toISOString(),
        processes: [
          {
            name: "worker",
            windowName: "worker",
            logPath: join(projectDir, ".internal", "lifecycle", "worker.log"),
          },
        ],
      },
    });

    const backend: MuxBackend = {
      name: "tmux",
      available: true,
      listSessions: async () => [
        {
          name: sessionName,
          backend: "tmux",
          attached: false,
          path: root,
          windows: 1,
          createdAt: null,
        },
      ],
      createSession: async () => ({ ok: true, session: null }),
      killSession: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      execInSession: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      sendInput: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      readLifecycleOwnerToken: async () => ownershipToken,
      readSessionPresence: async () => "present",
    };
    const resolvedMux: ResolvedMux = {
      mode: "tmux",
      backends: new Map([["tmux", backend]]),
    };

    const retiredPids: number[] = [];
    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;
    try {
      await stopLifecycleProcessController({
        project: { projectRoot: root, projectDir },
        definitionHash: "def-hash",
        projectName,
        branch: null,
        composeProject,
        mux: async () => resolvedMux,
        retireSession: async (retireOpts) => {
          for (const proc of retireOpts.processes) {
            if (proc.panePid !== undefined) {
              retiredPids.push(proc.panePid);
            }
          }
          expect(await retireOpts.stopSession()).toBe(true);
          return true;
        },
      });
    } finally {
      restoreEnv("PATH", previousPath);
    }

    const tmuxCalls = (await readFile(tmuxLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(tmuxCalls.some((argv) => argv.includes("send-keys"))).toBe(true);
    // Must poll list-panes multiple times during the grace window (fails if grace poll is disabled).
    const listPaneCalls = tmuxCalls.filter((argv) =>
      argv.includes("list-panes")
    );
    expect(listPaneCalls.length).toBeGreaterThan(1);
    // Surviving pane PID must reach forced retirement (fails if retirement handoff is disabled).
    expect(retiredPids).toEqual([process.pid]);
    expect(LIFECYCLE_TMUX_INTERRUPT_GRACE_MS).toBe(750);
  }, 15_000);
});

describe("compose down slow-stop probe, persistence, cap hints, and hack doctor", () => {
  test("parses Compose stop_grace_period durations and computes effective probe thresholds", async () => {
    expect(parseComposeDurationMs("3s")).toBe(3000);
    expect(parseComposeDurationMs("500ms")).toBe(500);
    expect(parseComposeDurationMs("1m30s")).toBe(90_000);
    expect(parseComposeDurationMs("0s")).toBe(0);
    expect(parseComposeDurationMs(4)).toBe(4000);
    expect(parseComposeDurationMs("not-a-duration")).toBeUndefined();

    const fixture = await createComposeFixture({
      composeYaml: [
        "services:",
        "  fast:",
        "    image: alpine:3.20",
        "  slow:",
        "    image: alpine:3.20",
        "    stop_grace_period: 3s",
        "    init: true",
        "",
      ].join("\n"),
    });
    const meta = await readComposeServiceStopMeta(
      join(fixture.projectDir, "docker-compose.yml")
    );
    expect(meta?.defined).toEqual(new Set(["fast", "slow"]));
    expect(meta?.withInit).toEqual(new Set(["slow"]));
    expect(meta?.minPositiveGraceMs).toBe(3000);

    // 3 s stop_grace_period with no --timeout flag probes at >= 3000 ms (catches 4.1 s down!).
    expect(
      slowStopProbeThresholdMs({
        timeoutSeconds: undefined,
        minServiceGraceMs: meta?.minPositiveGraceMs,
      })
    ).toBe(3000);
    // Clean --timeout 1 does not probe below 1000 ms.
    expect(slowStopProbeThresholdMs({ timeoutSeconds: 1 })).toBe(1000);
    // --timeout 0 never probes.
    expect(slowStopProbeThresholdMs({ timeoutSeconds: 0 })).toBeNull();
    // Default (no flag, no stop_grace_period) uses Docker's 10 s default.
    expect(slowStopProbeThresholdMs()).toBe(10_000);
  });

  test("enforces exact daemon-clock docker events argv (--since, --until, --format) and 5s timeout bound", async () => {
    const calls: {
      readonly cmd: readonly string[];
      readonly timeoutMs: number | undefined;
    }[] = [];
    let daemonSystemTime: string | null = "2030-01-01T12:00:10.462820446Z";
    const execImpl = async (
      cmd: readonly string[],
      opts?: { readonly timeoutMs?: number }
    ) => {
      calls.push({ cmd, timeoutMs: opts?.timeoutMs });
      if (cmd[1] === "info") {
        return daemonSystemTime
          ? { exitCode: 0, stdout: `${daemonSystemTime}\n`, stderr: "" }
          : { exitCode: 1, stdout: "", stderr: "info unavailable" };
      }
      return {
        exitCode: 0,
        stdout: [
          makeDieEventJson({
            composeProject: "demo",
            service: "slow",
            exitCode: "137",
          }),
          makeDieEventJson({
            composeProject: "demo",
            service: "clean",
            exitCode: "0",
          }),
          makeDieEventJson({
            composeProject: "other-project",
            service: "ignored",
            exitCode: "137",
          }),
        ].join("\n"),
        stderr: "",
      };
    };

    // Fast path below 3s stop_grace_period: 0 calls.
    const fast3s = await observeComposeDownSlowStops({
      composeProject: "demo",
      downElapsedMs: 900,
      minServiceGraceMs: 3000,
      cwd: "/tmp",
      execImpl,
    });
    expect(fast3s).toEqual({
      status: "fast",
      probed: false,
      exited137: [],
      exitedClean: [],
    });
    expect(calls).toHaveLength(0);

    // Clean --timeout 1 under 1000 ms: 0 calls.
    const cleanTimeout1 = await observeComposeDownSlowStops({
      composeProject: "demo",
      downElapsedMs: 850,
      timeoutSeconds: 1,
      cwd: "/tmp",
      execImpl,
    });
    expect(cleanTimeout1.probed).toBe(false);
    expect(calls).toHaveLength(0);

    // 3s stop_grace_period taking 4.1 s with no flag: uses daemon SystemTime (nanosecond --until, skew-free --since).
    const slow3s = await observeComposeDownSlowStops({
      composeProject: "demo",
      downElapsedMs: 4100,
      minServiceGraceMs: 3000,
      cwd: "/tmp",
      execImpl,
    });
    expect(slow3s).toEqual({
      status: "ok",
      probed: true,
      exited137: ["slow"],
      exitedClean: ["clean"],
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.cmd).toEqual([
      "docker",
      "info",
      "--format",
      "{{.SystemTime}}",
    ]);
    expect(calls[0]?.timeoutMs).toBeLessThanOrEqual(
      SLOW_STOP_EVENTS_TIMEOUT_MS
    );
    const eventsCall = calls[1]!;
    expect(eventsCall.timeoutMs).toBeLessThanOrEqual(
      SLOW_STOP_EVENTS_TIMEOUT_MS
    );
    expect(eventsCall.cmd).toEqual([
      "docker",
      "events",
      "--since",
      "2030-01-01T12:00:05.362Z",
      "--until",
      "2030-01-01T12:00:10.462820446Z",
      "--filter",
      "type=container",
      "--filter",
      "event=die",
      "--filter",
      "label=com.docker.compose.project=demo",
      "--format",
      "{{json .}}",
    ]);

    // When `docker info` fails, falls back to `--since <N>s --until -1s` (never `--until 0s`).
    calls.length = 0;
    daemonSystemTime = null;
    const fallback = await observeComposeDownSlowStops({
      composeProject: "demo",
      downElapsedMs: 4100,
      minServiceGraceMs: 3000,
      cwd: "/tmp",
      execImpl,
    });
    expect(fallback.status).toBe("ok");
    expect(calls[1]?.cmd).toEqual([
      "docker",
      "events",
      "--since",
      "6s",
      "--until",
      "-1s",
      "--filter",
      "type=container",
      "--filter",
      "event=die",
      "--filter",
      "label=com.docker.compose.project=demo",
      "--format",
      "{{json .}}",
    ]);
  });

  test("failed or timed-out events probe and second down on stopped project preserve existing doctor record", async () => {
    const fixture = await createComposeFixture({
      name: "demo",
      composeYaml: [
        "services:",
        "  slow:",
        "    image: alpine:3.20",
        "  clean:",
        "    image: alpine:3.20",
        "",
      ].join("\n"),
    });
    const composeFile = join(fixture.projectDir, "docker-compose.yml");

    // Seed an observed slow stop.
    await recordProjectSlowStops({
      projectDir: fixture.projectDir,
      composeProject: "demo",
      services: ["slow"],
    });

    // 1. docker events exits 1 -> must NOT erase ["slow"].
    await finalizeComposeDownSlowStops({
      projectDir: fixture.projectDir,
      composeFile,
      composeProject: "demo",
      downElapsedMs: 11_000,
      cwd: fixture.projectDir,
      execImpl: async () => ({ exitCode: 1, stdout: "", stderr: "daemon err" }),
    });
    expect(
      (await checkComposeSlowStops({ startDir: fixture.root })).composeSlowStops
        ?.services
    ).toEqual(["slow"]);

    // 2. docker events throws (e.g. timeout) -> must NOT erase ["slow"].
    await finalizeComposeDownSlowStops({
      projectDir: fixture.projectDir,
      composeFile,
      composeProject: "demo",
      downElapsedMs: 11_000,
      cwd: fixture.projectDir,
      execImpl: async () => {
        throw new Error("timed out");
      },
    });
    expect(
      (await checkComposeSlowStops({ startDir: fixture.root })).composeSlowStops
        ?.services
    ).toEqual(["slow"]);

    // 3. Second hack down on an already-stopped project (0 die events in text mode) -> must NOT erase ["slow"].
    await finalizeComposeDownSlowStops({
      projectDir: fixture.projectDir,
      composeFile,
      composeProject: "demo",
      downElapsedMs: 200,
      cwd: fixture.projectDir,
      execImpl: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });
    expect(
      (await checkComposeSlowStops({ startDir: fixture.root })).composeSlowStops
        ?.services
    ).toEqual(["slow"]);

    // 4. Second hack down in --json mode with runningBeforeDown: [] -> 0 events calls and preserves ["slow"].
    let eventsCalled = 0;
    await finalizeComposeDownSlowStops({
      projectDir: fixture.projectDir,
      composeFile,
      composeProject: "demo",
      downElapsedMs: 200,
      runningBeforeDown: [],
      cwd: fixture.projectDir,
      execImpl: async () => {
        eventsCalled += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(eventsCalled).toBe(0);
    expect(
      (await checkComposeSlowStops({ startDir: fixture.root })).composeSlowStops
        ?.services
    ).toEqual(["slow"]);

    // 5. After fixing the service and stopping it cleanly (die exitCode=0), record clears and doctor is ok.
    await finalizeComposeDownSlowStops({
      projectDir: fixture.projectDir,
      composeFile,
      composeProject: "demo",
      downElapsedMs: 300,
      cwd: fixture.projectDir,
      execImpl: async () => ({
        exitCode: 0,
        stdout: makeDieEventJson({
          composeProject: "demo",
          service: "slow",
          exitCode: "0",
        }),
        stderr: "",
      }),
    });
    expect(
      (await checkComposeSlowStops({ startDir: fixture.root })).status
    ).toBe("ok");
  });

  test("hack down and hack doctor stay consistent when a service with init: true still exits 137, and doctor expires old records", async () => {
    const fixture = await createComposeFixture({
      name: "demo",
      composeYaml: [
        "services:",
        "  traps-term:",
        "    image: alpine:3.20",
        "    init: true",
        "",
      ].join("\n"),
    });
    const composeFile = join(fixture.projectDir, "docker-compose.yml");
    const t0 = Date.parse("2026-11-21T12:00:00.000Z");

    const downHints = await finalizeComposeDownSlowStops({
      projectDir: fixture.projectDir,
      composeFile,
      composeProject: "demo",
      downElapsedMs: 3000,
      timeoutSeconds: 2,
      cwd: fixture.projectDir,
      nowMs: t0,
      execImpl: async () => ({
        exitCode: 0,
        stdout: makeDieEventJson({
          composeProject: "demo",
          service: "traps-term",
          exitCode: "137",
        }),
        stderr: "",
      }),
    });

    const expectedHint = formatSlowStopHint("traps-term", { hasInit: true });
    expect(expectedHint).toContain("already sets init: true");
    expect(expectedHint).not.toContain("Add init: true");
    expect(downHints).toEqual([
      { service: "traps-term", exitCode: 137, hint: expectedHint },
    ]);

    // Doctor must NOT hide traps-term and must emit the exact same hint as hack down.
    const doctorWarn = await checkComposeSlowStops({
      startDir: fixture.root,
      nowMs: t0 + 1000,
    });
    expect(doctorWarn.status).toBe("warn");
    expect(doctorWarn.composeSlowStops?.services).toEqual(["traps-term"]);
    expect(doctorWarn.message).toBe(expectedHint);

    // Doctor JSON output includes composeSlowStops cleanly.
    const jsonData = buildDoctorJsonData({
      results: [{ ...doctorWarn, durationMs: 1 }],
    });
    expect(jsonData.checks[0]?.id).toBe(COMPOSE_SLOW_STOPS_CHECK);
    expect(jsonData.checks[0]?.composeSlowStops?.services).toEqual([
      "traps-term",
    ]);

    // After TTL expires (7 days + 1 ms), doctor no longer warns.
    const expired = await checkComposeSlowStops({
      startDir: fixture.root,
      nowMs: t0 + SLOW_STOP_RECORD_TTL_MS + 1,
    });
    expect(expired.status).toBe("ok");

    // Corrupt state file is tolerated cleanly without throwing.
    await writeFile(
      resolveProjectSlowStopsPath({ projectDir: fixture.projectDir }),
      "{corrupt"
    );
    expect(
      await readProjectSlowStops({ projectDir: fixture.projectDir })
    ).toEqual([]);
  });

  test("read-only slow-stops state file never fails hack down or skips down-after hooks", async () => {
    const markerName = "after-hook-ran.txt";
    const fixture = await createComposeFixture({
      name: "ro-demo",
      config: {
        lifecycle: {
          down: {
            after: [
              {
                name: "write-marker",
                command: `printf ok > ${markerName}`,
              },
            ],
          },
        },
      },
      dockerConfig: {
        downDelayMs: 1050,
        eventsStdout: `${makeDieEventJson({
          composeProject: "ro-demo",
          service: "api",
          exitCode: "137",
        })}\n`,
      },
    });
    const internalDir = join(fixture.projectDir, ".internal");
    const lifecycleDir = join(internalDir, "lifecycle");
    const statePath = resolveProjectSlowStopsPath({
      projectDir: fixture.projectDir,
    });
    await mkdir(lifecycleDir, { recursive: true });
    await writeFile(statePath, '{"entries":[]}\n');
    await chmod(statePath, 0o444);
    await chmod(internalDir, 0o555);

    try {
      const run = await runCli({
        args: ["down", "--timeout", "1", "--json"],
        cwd: fixture.root,
        homeDir: fixture.homeDir,
        binDir: fixture.binDir,
      });

      expect(run.exitCode).toBe(0);
      expect(run.stderr).not.toContain("EACCES");
      expect(run.stdout).not.toContain("EACCES");
      expect(await readFile(join(fixture.root, markerName), "utf8")).toBe("ok");

      const parsed = JSON.parse(run.stdout) as {
        readonly ok: boolean;
        readonly data: {
          readonly slowStops?: readonly { readonly service: string }[];
          readonly warnings?: readonly string[];
        };
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.data.slowStops?.map((entry) => entry.service)).toEqual([
        "api",
      ]);
      expect(parsed.data.warnings?.[0]).toContain("service api exited 137");
    } finally {
      await chmod(internalDir, 0o755).catch(() => {});
      await chmod(statePath, 0o644).catch(() => {});
    }
  }, 60_000);

  test("overall cap exit 124 emits slow-stop or cap explanation in both text and JSON modes", async () => {
    const fixture = await createComposeFixture({ name: "cap-demo" });
    const dieEvent = `${makeDieEventJson({
      composeProject: "cap-demo",
      service: "api",
      exitCode: "137",
    })}\n`;

    // Exit 124 with exit-137 event in --json mode.
    await fixture.setDockerConfig({
      downExitCode: 124,
      eventsStdout: dieEvent,
    });
    const jsonRun = await runCli({
      args: ["down", "--timeout", "2", "--json"],
      cwd: fixture.root,
      homeDir: fixture.homeDir,
      binDir: fixture.binDir,
    });
    expect(jsonRun.exitCode).toBe(124);
    const parsed = JSON.parse(jsonRun.stdout) as {
      readonly ok: boolean;
      readonly error: {
        readonly code: string;
        readonly detail: {
          readonly timedOut?: boolean;
          readonly capMs?: number;
          readonly slowStops?: readonly { readonly service: string }[];
          readonly warnings?: readonly string[];
        };
      };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("E_COMPOSE_FAILED");
    expect(parsed.error.detail.timedOut).toBe(true);
    expect(parsed.error.detail.capMs).toBe(90_000);
    expect(parsed.error.detail.slowStops?.map((s) => s.service)).toEqual([
      "api",
    ]);
    expect(parsed.error.detail.warnings?.[0]).toContain(
      "service api exited 137"
    );

    // Exit 124 with no die events yet (still hanging) prints the cap explanation in text mode.
    await fixture.setDockerConfig({
      downExitCode: 124,
      eventsStdout: "",
    });
    const textRun = await runCli({
      args: ["down", "--timeout", "2"],
      cwd: fixture.root,
      homeDir: fixture.homeDir,
      binDir: fixture.binDir,
    });
    expect(textRun.exitCode).toBe(124);
    expect(`${textRun.stdout}\n${textRun.stderr}`).toContain(
      "reached its 90s cap"
    );
  }, 60_000);

  test("parseComposeDownDieEvents and buildLifecycleJsonData separate exit 137 from clean exits", () => {
    const parsed = parseComposeDownDieEvents({
      composeProject: "demo",
      stdout: [
        makeDieEventJson({
          composeProject: "demo",
          service: "worker",
          exitCode: "137",
        }),
        makeDieEventJson({
          composeProject: "demo",
          service: "api",
          exitCode: "0",
        }),
        // If a service died 137 AND another replica exited 0, 137 wins.
        makeDieEventJson({
          composeProject: "demo",
          service: "worker",
          exitCode: "0",
        }),
      ].join("\n"),
    });
    expect(parsed).toEqual({
      exited137: ["worker"],
      exitedClean: ["api"],
    });

    const hints = buildSlowStopHints(parsed.exited137);
    const jsonData = buildLifecycleJsonData({
      action: "down",
      project: "demo",
      branch: null,
      composeProject: "demo",
      slowStops: hints,
      durationMs: 12_000,
    });
    expect(jsonData.slowStops).toEqual(hints);
    expect(jsonData.warnings).toEqual([hints[0]!.hint]);
  });
});
