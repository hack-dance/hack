import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
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
  buildComposeDownFailure,
  countDistinctRunningServices,
  DEFAULT_COMPOSE_DOWN_CAP_MS,
  formatComposeDownCapTimeoutMessage,
  parseComposeDownTimeoutFlag,
  resolveComposeDownCapMs,
  resolveComposeDownTimeoutSeconds,
} from "../src/lib/compose-down-budget.ts";
import { classifyComposeStartupState } from "../src/lib/compose-startup-state.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const CLI_ENTRY = join(REPO_ROOT, "index.ts");
const RUNTIME_BACKEND_ENTRY = join(
  REPO_ROOT,
  "src",
  "backends",
  "runtime-backend.ts"
);
const CLI_TIMEOUT_MS = 25_000;
const HERMETIC_SYSTEM_PATH = "/usr/bin:/bin";

function hermeticPath(binDir: string): string {
  return `${binDir}:${HERMETIC_SYSTEM_PATH}`;
}

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
  readonly secondDownExitCode?: number;
  readonly secondDownDelayMs?: number;
  readonly psJson?: string;
  readonly psJsonAfterRm?: string;
  readonly networks?: readonly string[];
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
  readonly dockerConfigPath: string;
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
      "let priorCalls = [];",
      "try {",
      '  priorCalls = readFileSync(logPath, "utf8").split("\\n").filter(Boolean).map((line) => JSON.parse(line));',
      "} catch {}",
      'const rmCalled = priorCalls.some((call) => call[0] === "rm");',
      'const downCount = priorCalls.filter((call) => call[0] === "compose" && call.includes("down")).length;',
      'if (args[0] === "compose" && args.includes("ps")) {',
      '  const body = rmCalled && typeof cfg.psJsonAfterRm === "string" ? cfg.psJsonAfterRm : typeof cfg.psJson === "string" ? cfg.psJson : "[]\\n";',
      "  process.stdout.write(body);",
      "  process.exit(0);",
      "}",
      'if (args[0] === "compose" && args.includes("down")) {',
      "  const isRetry = downCount >= 2;",
      "  const delayMs = Number(isRetry && cfg.secondDownDelayMs !== undefined ? cfg.secondDownDelayMs : (cfg.downDelayMs ?? 0));",
      "  if (Number.isFinite(delayMs) && delayMs > 0) {",
      "    await Bun.sleep(delayMs);",
      "  }",
      "  const code = Number(isRetry && cfg.secondDownExitCode !== undefined ? cfg.secondDownExitCode : (cfg.downExitCode ?? 0));",
      "  process.exit(Number.isInteger(code) ? code : 0);",
      "}",
      'if (args[0] === "network" && args[1] === "ls") {',
      '  const out = Array.isArray(cfg.networks) && cfg.networks.length > 0 ? cfg.networks.join("\\n") + "\\n" : "";',
      "  process.stdout.write(out);",
      "  process.exit(0);",
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

  return {
    root,
    projectDir,
    homeDir,
    binDir,
    dockerLogPath,
    dockerConfigPath,
    setDockerConfig,
  };
}

async function runCli(opts: {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly homeDir: string;
  readonly binDir: string;
  readonly preloadPath?: string;
  readonly extraEnv?: Readonly<Record<string, string>>;
}): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const argv = opts.preloadPath
    ? [process.execPath, "--preload", opts.preloadPath, CLI_ENTRY, ...opts.args]
    : [process.execPath, CLI_ENTRY, ...opts.args];
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: privateCliEnv({
      root: opts.cwd,
      home: opts.homeDir,
      env: {
        PATH: hermeticPath(opts.binDir),
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

  test("counts distinct running services rather than container replicas when scaling the cap", () => {
    const replicaStates = classifyComposeStartupState([
      { service: "api", state: "running", exitCode: null },
      { service: "api", state: "running", exitCode: null },
      { service: "api", state: "running", exitCode: null },
    ]);
    // classifyComposeStartupState lists one entry per container; cap must deduplicate.
    expect(replicaStates.running).toEqual(["api", "api", "api"]);
    expect(countDistinctRunningServices(replicaStates.running)).toBe(1);
    expect(
      resolveComposeDownCapMs({
        timeoutSeconds: 60,
        runningServiceCount: countDistinctRunningServices(
          replicaStates.running
        ),
      })
    ).toBe(90_000);

    const distinctStates = classifyComposeStartupState([
      { service: "api", state: "running", exitCode: null },
      { service: "web", state: "running", exitCode: null },
      { service: "worker", state: "running", exitCode: null },
    ]);
    expect(countDistinctRunningServices(distinctStates.running)).toBe(3);
    expect(
      resolveComposeDownCapMs({
        timeoutSeconds: 60,
        runningServiceCount: countDistinctRunningServices(
          distinctStates.running
        ),
      })
    ).toBe(210_000);

    // Unreadable or empty service list stays on the 90 s floor.
    expect(countDistinctRunningServices([])).toBe(0);
    expect(
      resolveComposeDownCapMs({
        timeoutSeconds: 60,
        runningServiceCount: countDistinctRunningServices([]),
      })
    ).toBe(90_000);
  });

  test("reports cap timeout only when the subprocess timer fires, not when docker exits 124 on its own", async () => {
    const fixture = await createComposeFixture({ name: "cap-demo" });

    // 1. Real low-cap enforcement through composeRuntimeBackend.down sets timedOut=true.
    await fixture.setDockerConfig({ downDelayMs: 5000, downExitCode: 0 });
    const previousPath = process.env.PATH;
    process.env.PATH = hermeticPath(fixture.binDir);
    let lowCapCode = 0;
    const lowCapOutcomes: Array<{
      readonly exitCode: number;
      readonly timedOut: boolean;
    }> = [];
    const t0 = performance.now();
    try {
      lowCapCode = await composeRuntimeBackend.down({
        composeFiles: [join(fixture.projectDir, "docker-compose.yml")],
        composeProject: "cap-demo",
        profiles: [],
        cwd: fixture.projectDir,
        timeoutSeconds: 1,
        capMs: 200,
        onOutcome: (outcome) => {
          lowCapOutcomes.push(outcome);
        },
      });
    } finally {
      restoreEnv("PATH", previousPath);
    }
    expect(lowCapCode).toBe(124);
    expect(lowCapOutcomes).toEqual([{ exitCode: 124, timedOut: true }]);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(
      buildComposeDownFailure({ exitCode: 124, timedOut: true, capMs: 200 })
    ).toEqual({
      message: formatComposeDownCapTimeoutMessage(200),
      detail: { exitCode: 124, timedOut: true, capMs: 200 },
      capWarning: formatComposeDownCapTimeoutMessage(200),
    });

    // 2. Child exiting 124 immediately does NOT set timedOut=true.
    await fixture.setDockerConfig({ downDelayMs: 0, downExitCode: 124 });
    process.env.PATH = hermeticPath(fixture.binDir);
    let selfExitCode = 0;
    const selfExitOutcomes: Array<{
      readonly exitCode: number;
      readonly timedOut: boolean;
    }> = [];
    try {
      selfExitCode = await composeRuntimeBackend.down({
        composeFiles: [join(fixture.projectDir, "docker-compose.yml")],
        composeProject: "cap-demo",
        profiles: [],
        cwd: fixture.projectDir,
        timeoutSeconds: 1,
        capMs: 5000,
        onOutcome: (outcome) => {
          selfExitOutcomes.push(outcome);
        },
      });
    } finally {
      restoreEnv("PATH", previousPath);
    }
    expect(selfExitCode).toBe(124);
    expect(selfExitOutcomes).toEqual([{ exitCode: 124, timedOut: false }]);

    // 3. CLI text and JSON treat child's own exit 124 as an ordinary failure, not a cap timeout.
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
        readonly detail: Record<string, unknown>;
      };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("E_COMPOSE_FAILED");
    expect(parsed.error.message).toBe("docker compose down failed (exit 124)");
    expect(parsed.error.detail).toEqual({ exitCode: 124 });

    const textRun = await runCli({
      args: ["down", "--timeout", "1"],
      cwd: fixture.root,
      homeDir: fixture.homeDir,
      binDir: fixture.binDir,
    });
    expect(textRun.exitCode).toBe(124);
    expect(`${textRun.stdout}\n${textRun.stderr}`).not.toContain("reached its");
  }, 60_000);

  async function runDownThroughCommandPath(opts: {
    readonly fixture: Awaited<ReturnType<typeof createComposeFixture>>;
    readonly timeout?: string;
    readonly json?: boolean;
  }): Promise<{
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly downCalls: readonly {
      readonly timeoutSeconds: number | undefined;
      readonly capMs: number | undefined;
    }[];
  }> {
    const downCallsPath = join(opts.fixture.root, "compose-down-calls.jsonl");
    const preloadPath = join(opts.fixture.root, "compose-down-spy-preload.ts");
    await rm(downCallsPath, { force: true });
    await writeFile(
      preloadPath,
      [
        'import { appendFileSync, writeFileSync } from "node:fs";',
        `import { composeRuntimeBackend } from ${JSON.stringify(RUNTIME_BACKEND_ENTRY)};`,
        `const downCallsPath = ${JSON.stringify(downCallsPath)};`,
        `const dockerConfigPath = ${JSON.stringify(opts.fixture.dockerConfigPath)};`,
        "(composeRuntimeBackend as { down: typeof composeRuntimeBackend.down }).down = async (downOpts) => {",
        "  appendFileSync(",
        "    downCallsPath,",
        '    JSON.stringify({ timeoutSeconds: downOpts.timeoutSeconds, capMs: downOpts.capMs }) + "\\n"',
        "  );",
        '  writeFileSync(dockerConfigPath, JSON.stringify({ psJson: "[]\\n" }));',
        "  downOpts.onOutcome?.({ exitCode: 0, timedOut: false });",
        "  return 0;",
        "};",
        "",
      ].join("\n")
    );

    const result = await runCli({
      args: [
        "down",
        "--path",
        opts.fixture.root,
        ...(opts.timeout !== undefined ? ["--timeout", opts.timeout] : []),
        ...(opts.json ? ["--json"] : []),
      ],
      cwd: opts.fixture.root,
      homeDir: opts.fixture.homeDir,
      binDir: opts.fixture.binDir,
      preloadPath,
    });

    const downCallsFile = Bun.file(downCallsPath);
    const downCalls: Array<{
      readonly timeoutSeconds: number | undefined;
      readonly capMs: number | undefined;
    }> = (await downCallsFile.exists())
      ? (await downCallsFile.text())
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .map((line) => {
            const parsed = JSON.parse(line) as {
              readonly timeoutSeconds?: number;
              readonly capMs?: number;
            };
            return {
              timeoutSeconds: parsed.timeoutSeconds,
              capMs: parsed.capMs,
            };
          })
      : [];

    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      downCalls,
    };
  }

  test("CLI down arms 90s cap for three replicas of one service and 210s for three distinct services at --timeout 60", async () => {
    const fixture = await createComposeFixture({ name: "replica-cap" });

    // Three running replicas of a single service (`api`) -> 1 distinct service -> 90 s floor.
    await fixture.setDockerConfig({
      psJson: [
        JSON.stringify({ ID: "c1", Service: "api", State: "running" }),
        JSON.stringify({ ID: "c2", Service: "api", State: "running" }),
        JSON.stringify({ ID: "c3", Service: "api", State: "running" }),
      ].join("\n"),
    });
    const replicaRun = await runDownThroughCommandPath({
      fixture,
      timeout: "60",
      json: true,
    });
    expect({
      exitCode: replicaRun.exitCode,
      stderr: replicaRun.stderr,
      ...(replicaRun.exitCode === 0 ? {} : { stdout: replicaRun.stdout }),
    }).toEqual({ exitCode: 0, stderr: "" });
    expect(replicaRun.downCalls).toEqual([
      { timeoutSeconds: 60, capMs: 90_000 },
    ]);

    // Three distinct running services -> 3 * 60 s + 30 s = 210 s cap.
    await fixture.setDockerConfig({
      psJson: [
        JSON.stringify({ ID: "c1", Service: "api", State: "running" }),
        JSON.stringify({ ID: "c2", Service: "web", State: "running" }),
        JSON.stringify({ ID: "c3", Service: "worker", State: "running" }),
      ].join("\n"),
    });
    const distinctRun = await runDownThroughCommandPath({
      fixture,
      timeout: "60",
      json: true,
    });
    expect({
      exitCode: distinctRun.exitCode,
      stderr: distinctRun.stderr,
      ...(distinctRun.exitCode === 0 ? {} : { stdout: distinctRun.stdout }),
    }).toEqual({ exitCode: 0, stderr: "" });
    expect(distinctRun.downCalls).toEqual([
      { timeoutSeconds: 60, capMs: 210_000 },
    ]);
  }, 60_000);

  test("CLI down produces the same cap and stopped list whether compose ps prints JSON lines or a JSON array", async () => {
    const fixture = await createComposeFixture({ name: "ps-encoding" });
    const rows = [
      { ID: "c1", Service: "api", State: "running" },
      { ID: "c2", Service: "web", State: "running" },
      { ID: "c3", Service: "worker", State: "running" },
    ];

    const encodings = [
      rows.map((row) => JSON.stringify(row)).join("\n"),
      JSON.stringify(rows),
      JSON.stringify(rows, null, 2),
    ];

    const results: Array<{
      readonly capMs: number | undefined;
      readonly stopped: readonly string[];
    }> = [];
    for (const psJson of encodings) {
      await fixture.setDockerConfig({ psJson });
      const run = await runDownThroughCommandPath({
        fixture,
        timeout: "60",
        json: true,
      });
      expect({
        exitCode: run.exitCode,
        stderr: run.stderr,
        ...(run.exitCode === 0 ? {} : { stdout: run.stdout }),
      }).toEqual({ exitCode: 0, stderr: "" });
      expect(run.downCalls).toEqual([{ timeoutSeconds: 60, capMs: 210_000 }]);
      const parsed = JSON.parse(run.stdout) as {
        readonly ok: boolean;
        readonly data: {
          readonly services: { readonly stopped: readonly string[] };
        };
      };
      expect(parsed.ok).toBe(true);
      results.push({
        capMs: run.downCalls[0]?.capMs,
        stopped: parsed.data.services.stopped,
      });
    }

    expect(results[0]).toEqual({
      capMs: 210_000,
      stopped: ["api", "web", "worker"],
    });
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  }, 60_000);

  test("HACK_RUNTIME_BACKEND selection agrees with --timeout refusal for both 'native' and 'NATIVE'", async () => {
    const fixture = await createComposeFixture({ name: "backend-case" });

    // Lowercase 'native' selects native backend both with and without --timeout.
    const nativeWithFlag = await runCli({
      args: ["down", "--timeout", "2", "--json"],
      cwd: fixture.root,
      homeDir: fixture.homeDir,
      binDir: fixture.binDir,
      extraEnv: { HACK_RUNTIME_BACKEND: "native" },
    });
    expect(nativeWithFlag.exitCode).toBe(1);
    const nativeWithFlagParsed = JSON.parse(nativeWithFlag.stdout) as {
      readonly ok: boolean;
      readonly error: { readonly code: string; readonly message: string };
    };
    expect(nativeWithFlagParsed.ok).toBe(false);
    expect(nativeWithFlagParsed.error.code).toBe("E_USAGE");
    expect(nativeWithFlagParsed.error.message).toContain("--timeout");
    expect(await readDockerCalls(fixture.dockerLogPath)).toHaveLength(0);

    const nativeWithoutFlag = await runCli({
      args: ["down", "--json"],
      cwd: fixture.root,
      homeDir: fixture.homeDir,
      binDir: fixture.binDir,
      extraEnv: { HACK_RUNTIME_BACKEND: "native" },
    });
    expect(nativeWithoutFlag.exitCode).toBe(1);
    expect(await readDockerCalls(fixture.dockerLogPath)).toHaveLength(0);

    // Uppercase 'NATIVE' does not select native; runs Compose both with and without --timeout.
    await writeFile(fixture.dockerLogPath, "");
    const upperWithoutFlag = await runCli({
      args: ["down", "--json"],
      cwd: fixture.root,
      homeDir: fixture.homeDir,
      binDir: fixture.binDir,
      extraEnv: { HACK_RUNTIME_BACKEND: "NATIVE" },
    });
    expect(upperWithoutFlag.exitCode).toBe(0);
    const upperWithoutDown = (
      await readDockerCalls(fixture.dockerLogPath)
    ).find((argv) => argv[0] === "compose" && argv.includes("down"));
    expect(upperWithoutDown).toBeDefined();
    expect(upperWithoutDown).not.toContain("--timeout");

    await writeFile(fixture.dockerLogPath, "");
    const upperWithFlag = await runCli({
      args: ["down", "--timeout", "2", "--json"],
      cwd: fixture.root,
      homeDir: fixture.homeDir,
      binDir: fixture.binDir,
      extraEnv: { HACK_RUNTIME_BACKEND: "NATIVE" },
    });
    expect(upperWithFlag.exitCode).toBe(0);
    const upperWithDown = (await readDockerCalls(fixture.dockerLogPath)).find(
      (argv) => argv[0] === "compose" && argv.includes("down")
    );
    expect(upperWithDown?.slice(-3)).toEqual(["down", "--timeout", "2"]);
  }, 60_000);
});

describe("compose down leftover-cleanup retry outcome (HACK-2547)", () => {
  test("stalling second compose down fails with E_COMPOSE_FAILED (exit 124) naming leftovers and next steps in JSON and text", async () => {
    const fixture = await createComposeFixture({ name: "retry-stall" });
    const canonicalProjectDir = await realpath(fixture.projectDir);
    await fixture.setDockerConfig({
      downExitCode: 0,
      downDelayMs: 0,
      secondDownExitCode: 0,
      secondDownDelayMs: 10_000,
      psJson: `${JSON.stringify({
        ID: "leftover1",
        Service: "worker",
        State: "running",
        Labels: `com.docker.compose.project.working_dir=${canonicalProjectDir}`,
      })}\n`,
      psJsonAfterRm: "[]\n",
      networks: ["hack_default"],
    });

    // Shorten only the 2nd composeRuntimeBackend.down call's capMs while still
    // running the real subprocess runner and timeout timer against the docker shim.
    const preloadPath = join(fixture.root, "retry-cap-preload.ts");
    await writeFile(
      preloadPath,
      [
        `import { composeRuntimeBackend } from ${JSON.stringify(RUNTIME_BACKEND_ENTRY)};`,
        "const originalDown = composeRuntimeBackend.down.bind(composeRuntimeBackend);",
        "let downCallCount = 0;",
        "(composeRuntimeBackend as { down: typeof composeRuntimeBackend.down }).down = async (downOpts) => {",
        "  downCallCount += 1;",
        "  return await originalDown(downCallCount >= 2 ? { ...downOpts, capMs: 250 } : downOpts);",
        "};",
        "",
      ].join("\n")
    );

    const jsonRun = await runCli({
      args: ["down", "--path", fixture.root, "--json"],
      cwd: fixture.root,
      homeDir: fixture.homeDir,
      binDir: fixture.binDir,
      preloadPath,
    });
    expect(jsonRun.exitCode).toBe(124);
    const parsed = JSON.parse(jsonRun.stdout) as {
      readonly ok: boolean;
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly detail: Record<string, unknown>;
      };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("E_COMPOSE_FAILED");
    expect(parsed.error.detail).toEqual({
      exitCode: 124,
      retry: true,
      timedOut: true,
      capMs: DEFAULT_COMPOSE_DOWN_CAP_MS,
      containers: [],
      networks: ["hack_default"],
    });
    expect(parsed.error.message).toContain("90s cap");
    expect(parsed.error.message).toContain("hack_default");
    expect(parsed.error.message).toContain("hack ps --json");
    expect(parsed.error.message).toContain("hack down");
    expect(parsed.error.message).toContain("--timeout <seconds>");

    const calls = await readDockerCalls(fixture.dockerLogPath);
    const downCalls = calls.filter(
      (argv) => argv[0] === "compose" && argv.includes("down")
    );
    expect(downCalls).toHaveLength(2);
    expect(calls.some((argv) => argv[0] === "stop")).toBe(true);
    expect(calls.some((argv) => argv[0] === "rm")).toBe(true);
    expect(calls).toContainEqual([
      "network",
      "ls",
      "--filter",
      "label=com.docker.compose.project=hack",
      "--format",
      "{{.Name}}",
    ]);

    await writeFile(fixture.dockerLogPath, "");
    const textRun = await runCli({
      args: ["down", "--path", fixture.root],
      cwd: fixture.root,
      homeDir: fixture.homeDir,
      binDir: fixture.binDir,
      preloadPath,
    });
    expect(textRun.exitCode).toBe(124);
    const textOutput = `${textRun.stdout}\n${textRun.stderr}`;
    expect(textOutput).toContain("90s cap");
    expect(textOutput).toContain("hack_default");
    expect(textOutput).toContain("hack ps --json");
    expect(textOutput).toContain("hack down");
  }, 60_000);

  test("non-timeout second compose down failure fails with E_COMPOSE_FAILED naming remaining containers and networks", async () => {
    const fixture = await createComposeFixture({ name: "retry-fail" });
    const canonicalProjectDir = await realpath(fixture.projectDir);
    const leftoverRow = `${JSON.stringify({
      ID: "leftover1",
      Service: "worker",
      State: "exited",
      Labels: `com.docker.compose.project.working_dir=${canonicalProjectDir}`,
    })}\n`;
    await fixture.setDockerConfig({
      downExitCode: 0,
      secondDownExitCode: 1,
      psJson: leftoverRow,
      psJsonAfterRm: leftoverRow,
      networks: ["retry-fail_default"],
    });

    const jsonRun = await runCli({
      args: ["down", "--path", fixture.root, "--json"],
      cwd: fixture.root,
      homeDir: fixture.homeDir,
      binDir: fixture.binDir,
    });
    expect(jsonRun.exitCode).toBe(1);
    const parsed = JSON.parse(jsonRun.stdout) as {
      readonly ok: boolean;
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly detail: Record<string, unknown>;
      };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("E_COMPOSE_FAILED");
    expect(parsed.error.detail).toEqual({
      exitCode: 1,
      retry: true,
      containers: ["worker"],
      networks: ["retry-fail_default"],
    });
    expect(parsed.error.message).toContain("exit 1");
    expect(parsed.error.message).not.toContain("reached its");
    expect(parsed.error.message).toContain("worker");
    expect(parsed.error.message).toContain("retry-fail_default");
    expect(parsed.error.message).toContain("hack ps --json");
    expect(parsed.error.message).toContain("hack down");

    // Retry exits 0 while a project network is still present -> E_DOWN_INCOMPLETE.
    await writeFile(fixture.dockerLogPath, "");
    await fixture.setDockerConfig({
      downExitCode: 0,
      secondDownExitCode: 0,
      psJson: leftoverRow,
      psJsonAfterRm: "[]\n",
      networks: ["retry-fail_default"],
    });
    const leftoverNetRun = await runCli({
      args: ["down", "--path", fixture.root, "--json"],
      cwd: fixture.root,
      homeDir: fixture.homeDir,
      binDir: fixture.binDir,
    });
    expect(leftoverNetRun.exitCode).toBe(1);
    const leftoverNetParsed = JSON.parse(leftoverNetRun.stdout) as {
      readonly ok: boolean;
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly detail: Record<string, unknown>;
      };
    };
    expect(leftoverNetParsed.ok).toBe(false);
    expect(leftoverNetParsed.error.code).toBe("E_DOWN_INCOMPLETE");
    expect(leftoverNetParsed.error.detail).toEqual({
      running: [],
      foreign: [],
      networks: ["retry-fail_default"],
    });
    expect(leftoverNetParsed.error.message).toContain("retry-fail_default");
    expect(leftoverNetParsed.error.message).toContain("hack ps --json");
    expect(leftoverNetParsed.error.message).toContain("hack down");

    // Retry exits 0 with a surviving one-off container holding the network -> exit 0.
    const oneOffRow = `${JSON.stringify({
      ID: "oneshot1",
      Service: "api",
      State: "running",
      Labels: `com.docker.compose.oneoff=True,com.docker.compose.project.working_dir=${canonicalProjectDir}`,
    })}\n`;
    await writeFile(fixture.dockerLogPath, "");
    await fixture.setDockerConfig({
      downExitCode: 0,
      secondDownExitCode: 0,
      psJson: `${leftoverRow}${oneOffRow}`,
      psJsonAfterRm: oneOffRow,
      networks: ["retry-fail_default"],
    });
    const oneOffRetryRun = await runCli({
      args: ["down", "--path", fixture.root, "--json"],
      cwd: fixture.root,
      homeDir: fixture.homeDir,
      binDir: fixture.binDir,
    });
    expect(oneOffRetryRun.exitCode).toBe(0);
    expect(
      (JSON.parse(oneOffRetryRun.stdout) as { readonly ok: boolean }).ok
    ).toBe(true);

    // Retry exits 0 with containers and project networks gone -> ok: true.
    await writeFile(fixture.dockerLogPath, "");
    await fixture.setDockerConfig({
      downExitCode: 0,
      secondDownExitCode: 0,
      psJson: leftoverRow,
      psJsonAfterRm: "[]\n",
      networks: [],
    });
    const cleanRetryRun = await runCli({
      args: ["down", "--path", fixture.root, "--json"],
      cwd: fixture.root,
      homeDir: fixture.homeDir,
      binDir: fixture.binDir,
    });
    expect(cleanRetryRun.exitCode).toBe(0);
    expect(
      (JSON.parse(cleanRetryRun.stdout) as { readonly ok: boolean }).ok
    ).toBe(true);

    // Ordinary fast path (no owned leftover containers, no retry) skips docker network ls.
    await writeFile(fixture.dockerLogPath, "");
    await fixture.setDockerConfig({
      downExitCode: 0,
      psJson: "[]\n",
      networks: ["retry-fail_default"],
    });
    const fastRun = await runCli({
      args: ["down", "--path", fixture.root, "--json"],
      cwd: fixture.root,
      homeDir: fixture.homeDir,
      binDir: fixture.binDir,
    });
    expect(fastRun.exitCode).toBe(0);
    expect((JSON.parse(fastRun.stdout) as { readonly ok: boolean }).ok).toBe(
      true
    );
    const fastCalls = await readDockerCalls(fixture.dockerLogPath);
    expect(
      fastCalls.filter((argv) => argv[0] === "compose" && argv.includes("down"))
    ).toHaveLength(1);
    expect(fastCalls.some((argv) => argv[0] === "network")).toBe(false);
  }, 60_000);
});
