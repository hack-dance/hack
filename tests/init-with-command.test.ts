import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerScopedModuleMock } from "./helpers/scoped-module-mock.ts";

/**
 * CLI-level coverage for `hack init --with <agent>`.
 *
 * These tests run with a stubbed PATH (no agent binaries) and
 * HACK_NO_INTERACTIVE=1, so the handoff always takes the printed-prompt
 * fallback and never spawns an interactive session. HACK_HOME points at a
 * temp dir so the projects registry is isolated from the real ~/.hack.
 */

type CapturedRunResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

type SavedEnv = Record<string, string | undefined>;

const ENV_KEYS = [
  "PATH",
  "HACK_HOME",
  "HACK_NO_INTERACTIVE",
  "HACK_LOGGER",
] as const;

let tempDir: string | null = null;
let savedEnv: SavedEnv = {};
let discoveryMarkerRoot: string | null = null;
let markerDiscoveryCall = 0;
let discoveryCalls = 0;

const { discoverRepo: realDiscoverRepo } = await import(
  "../src/init/discovery.ts"
);
const discoveryMock = await registerScopedModuleMock({
  importerPath: import.meta.path,
  specifier: "../src/init/discovery.ts",
  overrides: {
    discoverRepo: async (repoRoot: string) => {
      const result = await realDiscoverRepo(repoRoot);
      if (repoRoot === discoveryMarkerRoot) {
        discoveryCalls += 1;
        if (discoveryCalls === markerDiscoveryCall) {
          await Bun.write(join(repoRoot, ".hack", "hack.project.json"), "{}\n");
        }
      }
      return result;
    },
  },
});

beforeAll(() => {
  discoveryMock.activate();
});

afterAll(() => {
  discoveryMock.deactivate();
});

beforeEach(async () => {
  discoveryMarkerRoot = null;
  discoveryCalls = 0;
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }

  // realpath avoids /var vs /private/var symlink mismatches in the
  // projects-registry path equality checks on macOS.
  tempDir = await realpath(await mkdtemp(join(tmpdir(), "hack-init-with-")));
  process.env.PATH = join(tempDir, "empty-path");
  process.env.HACK_HOME = join(tempDir, "hack-home");
  process.env.HACK_NO_INTERACTIVE = "1";
  process.env.HACK_LOGGER = "console";
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

async function setupTempRepo(): Promise<string> {
  const repoRoot = join(tempDir ?? "", "repo");
  await Bun.write(
    join(repoRoot, "package.json"),
    JSON.stringify({ name: "demo", scripts: { dev: "bun run dev.ts" } })
  );
  return repoRoot;
}

test("hack init --auto --with claude initializes and prints the prompt when no binary exists", async () => {
  const repoRoot = await setupTempRepo();

  const result = await runCliWithCapturedOutput([
    "init",
    "--auto",
    "--with",
    "claude",
    "--path",
    repoRoot,
  ]);

  expect(result.exitCode).toBe(0);
  const generated = await Bun.file(
    join(repoRoot, ".hack", "hack.config.json")
  ).json();
  expect(generated.dev_host).toBe("repo.hack.local");
  expect(
    await Bun.file(join(repoRoot, ".hack", "hack.config.json")).exists()
  ).toBe(true);
  // Non-interactive: never spawn, always print the onboarding prompt.
  expect(result.stdout).toContain("hack onboarding");
  expect(result.stdout).toContain("## Phase 1 — Inventory the repo");
  expect(result.stdout).toContain("node_modules:/app/node_modules");
  expect(result.stdout).toContain("stand up hack in this repo");
});

test("hack init --auto --with proceeds to handoff when .hack already exists", async () => {
  const repoRoot = await setupTempRepo();

  const first = await runCliWithCapturedOutput([
    "init",
    "--auto",
    "--dev-host",
    "existing.hack",
    "--path",
    repoRoot,
  ]);
  expect(first.exitCode).toBe(0);

  const second = await runCliWithCapturedOutput([
    "init",
    "--auto",
    "--with",
    "codex",
    "--path",
    repoRoot,
  ]);

  expect(second.exitCode).toBe(0);
  expect(`${second.stdout}${second.stderr}`).toContain("already exists");
  expect(second.stdout).toContain("adopt the existing hack setup in this repo");
  expect(second.stdout).toContain("existing.hack");
  expect(
    (await Bun.file(join(repoRoot, ".hack", "hack.config.json")).json())
      .dev_host
  ).toBe("existing.hack");
});

for (const nativeKind of [
  "valid",
  "invalid",
  "directory",
  "symlink",
] as const) {
  for (const auto of [false, true]) {
    test(`hack init ${auto ? "--auto --with" : "interactive"} refuses ${nativeKind} native markers before prompting or handoff`, async () => {
      const repoRoot = await setupTempRepo();
      const nativeFile = join(repoRoot, ".hack", "hack.project.json");
      if (nativeKind === "directory") {
        await mkdir(nativeFile, { recursive: true });
      } else if (nativeKind === "symlink") {
        await mkdir(join(repoRoot, ".hack"), { recursive: true });
        await symlink(join(repoRoot, "absent-native.json"), nativeFile);
      } else {
        await Bun.write(
          nativeFile,
          nativeKind === "valid" ? "{}\n" : "{broken\n"
        );
      }

      const result = await runCliWithCapturedOutput([
        "init",
        ...(auto ? ["--auto", "--with", "codex"] : []),
        "--path",
        repoRoot,
      ]);

      expect(result.exitCode).toBe(1);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain("E_NATIVE_PROJECT_UNSUPPORTED");
      expect(output).not.toContain("hack onboarding");
      expect(output).not.toContain("asks for project name");
      for (const file of [
        "hack.config.json",
        "docker-compose.yml",
        ".gitignore",
        "README.md",
      ]) {
        expect(await Bun.file(join(repoRoot, ".hack", file)).exists()).toBe(
          false
        );
      }
      expect(
        await Bun.file(
          join(process.env.HACK_HOME ?? "", "projects.json")
        ).exists()
      ).toBe(false);
      if (nativeKind === "valid" || nativeKind === "invalid") {
        expect(await Bun.file(nativeFile).text()).toBe(
          nativeKind === "valid" ? "{}\n" : "{broken\n"
        );
      }
    });
  }
}

for (const legacyDir of [".hack", ".dev"] as const) {
  test(`hack init --auto --with refuses native plus ${legacyDir} inputs without changes`, async () => {
    const repoRoot = await setupTempRepo();
    const nativeFile = join(repoRoot, ".hack", "hack.project.json");
    const composeFile = join(repoRoot, legacyDir, "docker-compose.yml");
    const configFile = join(repoRoot, legacyDir, "hack.config.json");
    const compose = "name: existing\nservices:\n  app: {}\n";
    const config = '{"name":"existing","dev_host":"existing.hack"}\n';
    await Bun.write(nativeFile, "{broken\n");
    await Bun.write(composeFile, compose);
    await Bun.write(configFile, config);

    const result = await runCliWithCapturedOutput([
      "init",
      "--auto",
      "--with",
      "claude",
      "--path",
      repoRoot,
    ]);

    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "E_NATIVE_PROJECT_CONFLICT"
    );
    expect(result.stdout).not.toContain("hack onboarding");
    expect(await Bun.file(nativeFile).text()).toBe("{broken\n");
    expect(await Bun.file(composeFile).text()).toBe(compose);
    expect(await Bun.file(configFile).text()).toBe(config);
    expect(await Bun.file(join(repoRoot, ".hack", ".gitignore")).exists()).toBe(
      false
    );
    expect(
      await Bun.file(
        join(process.env.HACK_HOME ?? "", "projects.json")
      ).exists()
    ).toBe(false);
  });
}

test("hack init from a nested native project refuses before choosing an ancestor package root", async () => {
  const outerRoot = await setupTempRepo();
  const nativeRoot = join(outerRoot, "native");
  const startDir = join(nativeRoot, "src", "nested");
  await mkdir(startDir, { recursive: true });
  await Bun.write(join(nativeRoot, ".hack", "hack.project.json"), "{}\n");

  const result = await runCliWithCapturedOutput([
    "init",
    "--auto",
    "--with",
    "codex",
    "--path",
    startDir,
  ]);

  expect(result.exitCode).toBe(1);
  expect(`${result.stdout}${result.stderr}`).toContain(
    "E_NATIVE_PROJECT_UNSUPPORTED"
  );
  expect(result.stdout).not.toContain("hack onboarding");
  expect(
    await Bun.file(join(outerRoot, ".hack", "hack.config.json")).exists()
  ).toBe(false);
});

for (const discoveryCall of [1, 2]) {
  test(`hack init rechecks native inputs after discovery pass ${discoveryCall} before any scaffold write`, async () => {
    const repoRoot = await setupTempRepo();
    discoveryMarkerRoot = repoRoot;
    markerDiscoveryCall = discoveryCall;

    const result = await runCliWithCapturedOutput([
      "init",
      "--auto",
      "--with",
      "codex",
      "--path",
      repoRoot,
    ]);

    expect(result.exitCode).toBe(1);
    expect(discoveryCalls).toBe(discoveryCall);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "E_NATIVE_PROJECT_UNSUPPORTED"
    );
    expect(result.stdout).not.toContain("hack onboarding");
    for (const file of [
      "hack.config.json",
      "docker-compose.yml",
      ".gitignore",
      "README.md",
    ]) {
      expect(await Bun.file(join(repoRoot, ".hack", file)).exists()).toBe(
        false
      );
    }
  });
}

test("new default routes and README retain the canonical OAuth alias", async () => {
  const repoRoot = await setupTempRepo();
  const result = await runCliWithCapturedOutput([
    "init",
    "--auto",
    "--oauth",
    "--path",
    repoRoot,
  ]);
  expect(result.exitCode).toBe(0);
  const compose = await Bun.file(
    join(repoRoot, ".hack", "docker-compose.yml")
  ).text();
  const readme = await Bun.file(join(repoRoot, ".hack", "README.md")).text();
  expect(compose).toContain("repo.hack.local, repo.hack.gy");
  expect(compose).not.toContain("hack.local.gy");
  expect(readme).toContain("https://repo.hack.gy");
  expect(readme).not.toContain("hack.local.gy");
});

test("global default_domain drives new project config, routes and open without changing explicit hosts", async () => {
  const hackHome = process.env.HACK_HOME ?? "";
  await mkdir(hackHome, { recursive: true });
  await Bun.write(
    join(hackHome, "hack.config.json"),
    JSON.stringify({ default_domain: "hack.gy" })
  );
  const repoRoot = await setupTempRepo();
  const result = await runCliWithCapturedOutput([
    "init",
    "--auto",
    "--oauth",
    "--path",
    repoRoot,
  ]);
  expect(result.exitCode).toBe(0);
  const config = await Bun.file(
    join(repoRoot, ".hack", "hack.config.json")
  ).json();
  const compose = await Bun.file(
    join(repoRoot, ".hack", "docker-compose.yml")
  ).text();
  expect(config.dev_host).toBe("repo.hack.gy");
  expect(compose).toContain("caddy: repo.hack.gy");
  expect(compose).not.toContain("repo.hack.gy.gy");

  const opened = await runCliWithCapturedOutput([
    "open",
    "--json",
    "--path",
    repoRoot,
  ]);
  expect(opened.exitCode).toBe(0);
  expect(JSON.parse(opened.stdout)).toEqual({ url: "https://repo.hack.gy" });
});

test("explicit --dev-host wins over global default_domain", async () => {
  const hackHome = process.env.HACK_HOME ?? "";
  await mkdir(hackHome, { recursive: true });
  await Bun.write(
    join(hackHome, "hack.config.json"),
    JSON.stringify({ default_domain: "hack.gy" })
  );
  const repoRoot = await setupTempRepo();
  const result = await runCliWithCapturedOutput([
    "init",
    "--auto",
    "--dev-host",
    "app.example.test",
    "--path",
    repoRoot,
  ]);
  expect(result.exitCode).toBe(0);
  const config = await Bun.file(
    join(repoRoot, ".hack", "hack.config.json")
  ).json();
  expect(config.dev_host).toBe("app.example.test");
});

test("invalid configured default_domain refuses init before scaffold writes", async () => {
  const hackHome = process.env.HACK_HOME ?? "";
  await mkdir(hackHome, { recursive: true });
  await Bun.write(
    join(hackHome, "hack.config.json"),
    JSON.stringify({ default_domain: "https://bad.example.test/" })
  );
  const repoRoot = await setupTempRepo();
  const result = await runCliWithCapturedOutput([
    "init",
    "--auto",
    "--path",
    repoRoot,
  ]);
  expect(result.exitCode).not.toBe(0);
  expect(
    await Bun.file(join(repoRoot, ".hack", "hack.config.json")).exists()
  ).toBe(false);
});

test("explicit custom hosts are preserved without inventing OAuth aliases", async () => {
  const repoRoot = await setupTempRepo();
  const result = await runCliWithCapturedOutput([
    "init",
    "--auto",
    "--oauth",
    "--dev-host",
    "demo.example.test",
    "--path",
    repoRoot,
  ]);
  expect(result.exitCode).toBe(0);
  const config = await Bun.file(
    join(repoRoot, ".hack", "hack.config.json")
  ).json();
  const compose = await Bun.file(
    join(repoRoot, ".hack", "docker-compose.yml")
  ).text();
  expect(config.dev_host).toBe("demo.example.test");
  expect(compose).toContain("demo.example.test");
  expect(compose).not.toContain("demo.example.test.gy");
});

test("hack init --with rejects unknown agents with a usage error", async () => {
  const repoRoot = await setupTempRepo();

  const result = await runCliWithCapturedOutput([
    "init",
    "--auto",
    "--with",
    "cursor",
    "--path",
    repoRoot,
  ]);

  // The usage error message is emitted via the logger (bypasses the stubbed
  // streams), so assert on behavior: failed exit and no scaffold written.
  expect(result.exitCode).not.toBe(0);
  expect(
    await Bun.file(join(repoRoot, ".hack", "hack.config.json")).exists()
  ).toBe(false);
});

test("hack init --with rejects removed both option before scaffolding with a usage error", async () => {
  const repoRoot = await setupTempRepo();

  const result = await runCliWithCapturedOutput([
    "init",
    "--auto",
    "--with",
    "both",
    "--path",
    repoRoot,
  ]);

  // The usage error message is emitted via the logger (bypasses the stubbed
  // streams), so assert on behavior: failed exit and no scaffold written.
  expect(result.exitCode).not.toBe(0);
  expect(
    await Bun.file(join(repoRoot, ".hack", "hack.config.json")).exists()
  ).toBe(false);
});

async function runCliWithCapturedOutput(
  args: readonly string[]
): Promise<CapturedRunResult> {
  let stdout = "";
  let stderr = "";
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;

  try {
    const { runCli } = await import("../src/cli/run.ts");
    const exitCode = await runCli(args);
    return { exitCode, stdout, stderr };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}
