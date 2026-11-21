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
import {
  buildComposeDownCommand,
  composeRuntimeBackend,
} from "../src/backends/runtime-backend.ts";
import { HackCliError } from "../src/lib/cli-result.ts";
import {
  DEFAULT_COMPOSE_DOWN_CAP_MS,
  formatComposeDownCapTimeoutMessage,
  parseComposeDownTimeoutFlag,
  resolveComposeDownCapMs,
  resolveComposeDownTimeoutSeconds,
} from "../src/lib/compose-down-budget.ts";
import { upsertLifecycleStateEntry } from "../src/lib/lifecycle-runtime.ts";
import {
  LIFECYCLE_TMUX_INTERRUPT_GRACE_MS,
  LIFECYCLE_TMUX_INTERRUPT_POLL_INTERVAL_MS,
  resolveLifecycleSessionName,
  stopLifecycleProcessController,
  waitForInterruptedTmuxPanes,
} from "../src/lib/project-lifecycle-controller.ts";
import {
  type MuxBackend,
  MuxCommandTimeoutError,
} from "../src/mux/mux-backend.ts";
import type { ResolvedMux } from "../src/mux/mux-resolver.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const CLI_ENTRY = join(REPO_ROOT, "index.ts");
const CLI_TIMEOUT_MS = 25_000;

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function restoreEnv(key: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = previous;
  }
}

type FakeDockerConfig = {
  readonly downExitCode?: number;
  readonly downDelayMs?: number;
  readonly psJson?: string;
};

async function createComposeFixture(opts?: {
  readonly name?: string;
  readonly config?: Record<string, unknown>;
  readonly composeYaml?: string;
  readonly dockerConfig?: FakeDockerConfig;
}): Promise<{
  readonly root: string;
  readonly projectDir: string;
  readonly homeDir: string;
  readonly binDir: string;
  readonly dockerLogPath: string;
  readonly setDockerConfig: (next: FakeDockerConfig) => Promise<void>;
}> {
  const root = await makeTempDir("hack-down-bounded-");
  const projectDir = join(root, ".hack");
  const homeDir = join(root, "home");
  const binDir = join(root, "bin");
  const dockerLogPath = join(root, "docker-calls.jsonl");
  const dockerConfigPath = join(root, "docker-config.json");
  await mkdir(projectDir, { recursive: true });
  await mkdir(join(homeDir, ".hack"), { recursive: true });
  await mkdir(binDir, { recursive: true });

  await writeFile(join(homeDir, ".hack", "hack.config.json"), "{}\n");
  await writeFile(
    join(projectDir, "hack.config.json"),
    `${JSON.stringify(
      {
        name: opts?.name ?? "demo",
        ...(opts?.config ?? {}),
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    join(projectDir, "docker-compose.yml"),
    opts?.composeYaml ??
      [
        "services:",
        "  api:",
        "    image: alpine:3.20",
        '    command: ["sleep", "3600"]',
        "",
      ].join("\n")
  );

  const setDockerConfig = async (next: FakeDockerConfig) => {
    await writeFile(dockerConfigPath, JSON.stringify(next));
  };
  await setDockerConfig(opts?.dockerConfig ?? {});

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

describe("compose down stop timeout validation, argv, and cap", () => {
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
      "05",
      "00",
      "+5",
      "10s",
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

  test("validates compose.downTimeoutSeconds with E_CONFIG_INVALID and gives --timeout precedence", () => {
    expect(resolveComposeDownTimeoutSeconds({})).toBeUndefined();
    expect(resolveComposeDownTimeoutSeconds({ projectValue: 0 })).toBe(0);
    expect(resolveComposeDownTimeoutSeconds({ projectValue: 5 })).toBe(5);
    expect(
      resolveComposeDownTimeoutSeconds({ flagValue: "2", projectValue: 30 })
    ).toBe(2);
    expect(
      resolveComposeDownTimeoutSeconds({
        flagTimeoutSeconds: 0,
        projectValue: 30,
      })
    ).toBe(0);

    for (const invalid of [-1, 601, 2.5, Number.NaN]) {
      let caught: unknown;
      try {
        resolveComposeDownTimeoutSeconds({ projectValue: invalid });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(HackCliError);
      expect((caught as HackCliError).code).toBe("E_CONFIG_INVALID");
    }
  });

  test("keeps exact 90s cap when unset and scales to max(90s, timeout * runningServices + 30s) with no lower ceiling", () => {
    expect(DEFAULT_COMPOSE_DOWN_CAP_MS).toBe(90_000);
    // Unset: exact default cap regardless of running service count.
    expect(resolveComposeDownCapMs()).toBe(90_000);
    expect(
      resolveComposeDownCapMs({
        timeoutSeconds: undefined,
        runningServiceCount: 20,
      })
    ).toBe(90_000);

    // Timeout set with small product stays on the 90 s floor.
    expect(
      resolveComposeDownCapMs({ timeoutSeconds: 0, runningServiceCount: 5 })
    ).toBe(90_000);
    expect(
      resolveComposeDownCapMs({ timeoutSeconds: 2, runningServiceCount: 3 })
    ).toBe(90_000);
    expect(
      resolveComposeDownCapMs({ timeoutSeconds: 10, runningServiceCount: 4 })
    ).toBe(90_000);

    // Scales cleanly above 90 s with no artificial ceiling below timeout * runningServices + 30 s.
    expect(
      resolveComposeDownCapMs({ timeoutSeconds: 60, runningServiceCount: 7 })
    ).toBe(450_000);
    expect(
      resolveComposeDownCapMs({ timeoutSeconds: 600, runningServiceCount: 2 })
    ).toBe(1_230_000);
    expect(
      resolveComposeDownCapMs({ timeoutSeconds: 600, runningServiceCount: 1 })
    ).toBe(630_000);
    expect(resolveComposeDownCapMs({ timeoutSeconds: 600 })).toBe(630_000);

    expect(() =>
      resolveComposeDownCapMs({ timeoutSeconds: 601, runningServiceCount: 1 })
    ).toThrow(HackCliError);
  });

  test("builds docker compose down argv with and without --timeout", () => {
    const base = {
      composeFiles: ["/tmp/demo/.hack/docker-compose.yml"],
      composeProject: "demo",
      profiles: [],
      cwd: "/tmp/demo/.hack",
    };
    expect(buildComposeDownCommand(base)).toEqual([
      "docker",
      "compose",
      "-p",
      "demo",
      "--project-directory",
      "/tmp/demo/.hack",
      "-f",
      "/tmp/demo/.hack/docker-compose.yml",
      "down",
    ]);
    expect(
      buildComposeDownCommand({ ...base, timeoutSeconds: 0 }).slice(-3)
    ).toEqual(["down", "--timeout", "0"]);
    expect(
      buildComposeDownCommand({ ...base, timeoutSeconds: 12 }).slice(-3)
    ).toEqual(["down", "--timeout", "12"]);
  });

  test("CLI down forwards --timeout/config, preserves unset argv without extra ps, and enforces precedence", async () => {
    const fixture = await createComposeFixture({ name: "demo" });

    // Unset: no --timeout passed and 0 pre-down compose ps calls in text mode.
    const unsetRun = await runCli({
      args: ["down"],
      cwd: fixture.root,
      homeDir: fixture.homeDir,
      binDir: fixture.binDir,
    });
    expect(unsetRun.exitCode).toBe(0);
    const unsetCalls = await readDockerCalls(fixture.dockerLogPath);
    const unsetDownIdx = unsetCalls.findIndex(
      (argv) => argv[0] === "compose" && argv.includes("down")
    );
    expect(unsetDownIdx).toBeGreaterThanOrEqual(0);
    expect(unsetCalls[unsetDownIdx]).not.toContain("--timeout");
    expect(
      unsetCalls
        .slice(0, unsetDownIdx)
        .filter((argv) => argv[0] === "compose" && argv.includes("ps"))
    ).toHaveLength(0);

    // Explicit --timeout 2: passes --timeout 2.
    await writeFile(fixture.dockerLogPath, "");
    const flagRun = await runCli({
      args: ["down", "--timeout", "2", "--json"],
      cwd: fixture.root,
      homeDir: fixture.homeDir,
      binDir: fixture.binDir,
    });
    expect(flagRun.exitCode).toBe(0);
    const flagCalls = await readDockerCalls(fixture.dockerLogPath);
    const flagDown = flagCalls.find(
      (argv) => argv[0] === "compose" && argv.includes("down")
    );
    expect(flagDown?.slice(-3)).toEqual(["down", "--timeout", "2"]);

    // Config compose.downTimeoutSeconds applies when flag is unset, and flag overrides it.
    await writeFile(
      join(fixture.projectDir, "hack.config.json"),
      JSON.stringify({ name: "demo", compose: { downTimeoutSeconds: 4 } })
    );
    await writeFile(fixture.dockerLogPath, "");
    const configRun = await runCli({
      args: ["down", "--json"],
      cwd: fixture.root,
      homeDir: fixture.homeDir,
      binDir: fixture.binDir,
    });
    expect(configRun.exitCode).toBe(0);
    const configDown = (await readDockerCalls(fixture.dockerLogPath)).find(
      (argv) => argv[0] === "compose" && argv.includes("down")
    );
    expect(configDown?.slice(-3)).toEqual(["down", "--timeout", "4"]);

    await writeFile(fixture.dockerLogPath, "");
    const overrideRun = await runCli({
      args: ["down", "--timeout", "1", "--json"],
      cwd: fixture.root,
      homeDir: fixture.homeDir,
      binDir: fixture.binDir,
    });
    expect(overrideRun.exitCode).toBe(0);
    const overrideDown = (await readDockerCalls(fixture.dockerLogPath)).find(
      (argv) => argv[0] === "compose" && argv.includes("down")
    );
    expect(overrideDown?.slice(-3)).toEqual(["down", "--timeout", "1"]);
  }, 60_000);

  test("CLI down refuses invalid flag/config values and refuses --timeout on native without HACK_NATIVE_BINARY", async () => {
    const fixture = await createComposeFixture({ name: "demo" });

    for (const badFlag of ["-1", "601", "1.5", "abc", "05"]) {
      const run = await runCli({
        args: ["down", "--timeout", badFlag, "--json"],
        cwd: fixture.root,
        homeDir: fixture.homeDir,
        binDir: fixture.binDir,
      });
      expect(run.exitCode).toBe(1);
      const parsed = JSON.parse(run.stdout) as {
        readonly ok: boolean;
        readonly error: { readonly code: string };
      };
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe("E_USAGE");
    }
    expect(await readDockerCalls(fixture.dockerLogPath)).toHaveLength(0);

    // Invalid compose.downTimeoutSeconds in hack.config.json refuses with E_CONFIG_INVALID.
    await writeFile(
      join(fixture.projectDir, "hack.config.json"),
      JSON.stringify({ name: "demo", compose: { downTimeoutSeconds: 999 } })
    );
    const badConfigRun = await runCli({
      args: ["down", "--json"],
      cwd: fixture.root,
      homeDir: fixture.homeDir,
      binDir: fixture.binDir,
    });
    expect(badConfigRun.exitCode).toBe(1);
    const badConfigParsed = JSON.parse(badConfigRun.stdout) as {
      readonly ok: boolean;
      readonly error: { readonly code: string };
    };
    expect(badConfigParsed.ok).toBe(false);
    expect(badConfigParsed.error.code).toBe("E_CONFIG_INVALID");

    // Native backend must refuse --timeout with E_USAGE before resolving any native binary.
    const nativeRun = await runCli({
      args: ["down", "--timeout", "1", "--json"],
      cwd: fixture.root,
      homeDir: fixture.homeDir,
      binDir: fixture.binDir,
      extraEnv: {
        HACK_RUNTIME_BACKEND: "native",
      },
    });
    expect(nativeRun.exitCode).toBe(1);
    const nativeParsed = JSON.parse(nativeRun.stdout) as {
      readonly ok: boolean;
      readonly error: { readonly code: string; readonly message: string };
    };
    expect(nativeParsed.ok).toBe(false);
    expect(nativeParsed.error.code).toBe("E_USAGE");
    expect(nativeParsed.error.message).toContain("--timeout");
  }, 60_000);

  test("overall cap exit 124 emits one explicit message in text and JSON, and a low cap terminates hung compose down", async () => {
    const fixture = await createComposeFixture({ name: "cap-demo" });

    // Real low-cap enforcement through composeRuntimeBackend.down.
    await fixture.setDockerConfig({ downDelayMs: 5000, downExitCode: 0 });
    const previousPath = process.env.PATH;
    process.env.PATH = `${fixture.binDir}:${previousPath ?? ""}`;
    let lowCapCode = 0;
    const t0 = performance.now();
    try {
      lowCapCode = await composeRuntimeBackend.down({
        composeFiles: [join(fixture.projectDir, "docker-compose.yml")],
        composeProject: "cap-demo",
        profiles: [],
        cwd: fixture.projectDir,
        timeoutSeconds: 1,
        capMs: 200,
      });
    } finally {
      restoreEnv("PATH", previousPath);
    }
    expect(lowCapCode).toBe(124);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(formatComposeDownCapTimeoutMessage(200)).toContain("200ms cap");

    // CLI text and JSON cap output on exit 124 with --timeout 1.
    await fixture.setDockerConfig({ downDelayMs: 0, downExitCode: 124 });
    const jsonRun = await runCli({
      args: ["down", "--timeout", "1", "--json"],
      cwd: fixture.root,
      homeDir: fixture.homeDir,
      binDir: fixture.binDir,
    });
    expect(jsonRun.exitCode).toBe(124);
    const parsed = JSON.parse(jsonRun.stdout) as {
      readonly ok: boolean;
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly detail: {
          readonly exitCode: number;
          readonly timedOut?: boolean;
          readonly capMs?: number;
        };
      };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("E_COMPOSE_FAILED");
    expect(parsed.error.message).toBe(
      formatComposeDownCapTimeoutMessage(90_000)
    );
    expect(parsed.error.detail).toEqual({
      exitCode: 124,
      timedOut: true,
      capMs: 90_000,
    });

    const textRun = await runCli({
      args: ["down", "--timeout", "1"],
      cwd: fixture.root,
      homeDir: fixture.homeDir,
      binDir: fixture.binDir,
    });
    expect(textRun.exitCode).toBe(124);
    expect(`${textRun.stdout}\n${textRun.stderr}`).toContain(
      formatComposeDownCapTimeoutMessage(90_000)
    );
  }, 60_000);
});

describe("lifecycle tmux interrupt bounded poll and forced retirement", () => {
  test("returns immediately with zero sleeps when panes have already exited", async () => {
    let nowMs = 1000;
    const sleeps: number[] = [];
    const result = await waitForInterruptedTmuxPanes({
      windowNames: ["web", "worker"],
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
    let rounds = 0;
    const result = await waitForInterruptedTmuxPanes({
      windowNames: ["api"],
      readPanes: async () => {
        rounds += 1;
        return rounds < 3 ? [1234] : [];
      },
      now: () => nowMs,
      sleep: async (ms) => {
        sleeps.push(ms);
        nowMs += ms;
      },
    });
    expect(result).toEqual([[]]);
    expect(rounds).toBe(3);
    expect(sleeps).toEqual([
      LIFECYCLE_TMUX_INTERRUPT_POLL_INTERVAL_MS,
      LIFECYCLE_TMUX_INTERRUPT_POLL_INTERVAL_MS,
    ]);
    expect(nowMs - 5000).toBeLessThan(LIFECYCLE_TMUX_INTERRUPT_GRACE_MS);
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
    expect(reads).toBe(3);
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

  test("two windows with one stalled keeps sibling surviving PIDs and treats timed-out window as unknown/still-present", async () => {
    // Case 1: Window "web" returns surviving [4242] while sibling "worker" stalls on round 0.
    const t0 = performance.now();
    const seenTimeouts: number[] = [];
    const twoWinStall = await waitForInterruptedTmuxPanes({
      windowNames: ["web", "worker"],
      initialPanes: [[], [5353]],
      graceMs: 80,
      pollIntervalMs: 10,
      readPanes: async (windowName, readOpts) => {
        if (readOpts?.timeoutMs !== undefined) {
          seenTimeouts.push(readOpts.timeoutMs);
        }
        if (windowName === "web") {
          return [4242];
        }
        await Bun.sleep(5000);
        return [];
      },
    });
    expect(performance.now() - t0).toBeLessThan(400);
    expect(twoWinStall).toEqual([[4242], [5353]]);
    expect(seenTimeouts.every((ms) => ms > 0 && ms <= 80)).toBe(true);

    // Case 2: Window "web" exits [] while "worker" throws MuxCommandTimeoutError after returning [7777] on round 0.
    // Timed-out window is treated as unknown/still-present (not exited), keeps polling until graceMs, and preserves [7777].
    let nowMs = 0;
    const sleeps: number[] = [];
    let webReads = 0;
    let workerReads = 0;
    const keepLastOnTimeout = await waitForInterruptedTmuxPanes({
      windowNames: ["web", "worker"],
      graceMs: 60,
      pollIntervalMs: 25,
      now: () => nowMs,
      sleep: async (ms) => {
        sleeps.push(ms);
        nowMs += ms;
      },
      readPanes: async (windowName) => {
        if (windowName === "web") {
          webReads += 1;
          return [];
        }
        workerReads += 1;
        if (workerReads === 1) {
          return [7777];
        }
        throw new MuxCommandTimeoutError(["tmux", "list-panes"]);
      },
    });
    expect(keepLastOnTimeout).toEqual([[], [7777]]);
    expect(webReads).toBe(1); // Confirmed exited on round 0; not polled again.
    expect(workerReads).toBe(3); // Kept polling until grace deadline instead of exiting early.
    expect(sleeps).toEqual([25, 25, 10]);
  });

  test("stopLifecycleProcessController with two windows and one stalled passes both surviving and recorded PIDs to forced retirement", async () => {
    const root = await makeTempDir("hack-tmux-retire-");
    const projectDir = join(root, ".hack");
    const binDir = join(root, "bin");
    const tmuxLogPath = join(root, "tmux-calls.jsonl");
    await mkdir(projectDir, { recursive: true });
    await mkdir(binDir, { recursive: true });

    // Fake tmux shim: "web" returns process.pid on list-panes, while "worker" stalls for 5 s.
    const tmuxShim = join(binDir, "tmux");
    await writeFile(
      tmuxShim,
      [
        `#!${process.execPath}`,
        'import { appendFileSync } from "node:fs";',
        `appendFileSync(${JSON.stringify(tmuxLogPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
        "const args = process.argv.slice(2);",
        'if (args.includes("list-panes")) {',
        '  const target = args[args.indexOf("-t") + 1] ?? "";',
        '  if (target.endsWith(":worker")) {',
        "    await Bun.sleep(5000);",
        "  }",
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
    const ownershipToken = "tok-two-windows-stalled";
    const recordedWorkerPid = 999_991;

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
            name: "web",
            windowName: "web",
            logPath: join(projectDir, ".internal", "lifecycle", "web.log"),
          },
          {
            name: "worker",
            windowName: "worker",
            logPath: join(projectDir, ".internal", "lifecycle", "worker.log"),
            panePid: recordedWorkerPid,
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
          windows: 2,
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
    const t0 = performance.now();
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

    // Must settle near the 750 ms grace bound even though worker's list-panes stalls for 5 s.
    expect(performance.now() - t0).toBeLessThan(3000);
    const tmuxCalls = (await readFile(tmuxLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(tmuxCalls.some((argv) => argv.includes("send-keys"))).toBe(true);
    // Both web's live surviving PID and worker's recorded PID must reach forced retirement.
    expect(retiredPids).toEqual([process.pid, recordedWorkerPid]);
    expect(LIFECYCLE_TMUX_INTERRUPT_GRACE_MS).toBe(750);
  }, 15_000);
});
