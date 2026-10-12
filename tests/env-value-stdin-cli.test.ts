import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * End-to-end `--value-stdin` checks in fresh CLI subprocesses.
 *
 * Isolation: every run gets a temp HOME and global config, a temp project,
 * and either the project-key YAML store or an injected `encrypted_file`
 * backend with an env-provided key. No keychain, 1Password, Docker, or agent
 * client config is reached. A preload records argv/env of every child process
 * the CLI spawns so the sentinel can be proven absent from them.
 */

const REPO_ROOT = resolve(import.meta.dir, "..");
const ENTRYPOINT = resolve(REPO_ROOT, "index.ts");
const RECORDER = resolve(import.meta.dir, "fixtures/spawn-argv-recorder.ts");
const SENTINEL = "stdin-sentinel-c1-5b8e2d";
const SECRETS_FILE_KEY = "env-value-stdin-test-key";

type RunResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly spawnLog: string;
};

let root: string | null = null;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-env-value-stdin-"));
  await mkdir(join(root, "home"), { recursive: true });
});

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true });
    root = null;
  }
});

function requireRoot(): string {
  if (!root) {
    throw new Error("Missing temp root");
  }
  return root;
}

function isolatedEnv(spawnLog: string): Record<string, string> {
  const base = requireRoot();
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: join(base, "home"),
    TMPDIR: join(base, "home"),
    HACK_GLOBAL_CONFIG_PATH: join(base, "home", "hack-config.json"),
    HACK_LOGGER: "console",
    HACK_SECRETS_FILE_KEY: SECRETS_FILE_KEY,
    HACK_TEST_SPAWN_ARGV_LOG: spawnLog,
  };
}

async function runHack(input: {
  readonly args: readonly string[];
  readonly stdin?: string | Uint8Array | "ignore";
  readonly cwd?: string;
}): Promise<RunResult> {
  const base = requireRoot();
  const spawnLog = join(base, `spawn-${crypto.randomUUID()}.jsonl`);
  const stdinInput = input.stdin ?? "ignore";
  const proc = Bun.spawn(
    [process.execPath, "--preload", RECORDER, ENTRYPOINT, ...input.args],
    {
      cwd: input.cwd ?? REPO_ROOT,
      env: isolatedEnv(spawnLog),
      stdin: stdinInput === "ignore" ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  if (stdinInput !== "ignore" && proc.stdin) {
    proc.stdin.write(stdinInput);
    await proc.stdin.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const spawnLogText = await readFile(spawnLog, "utf8").catch(() => "");
  return { exitCode, stdout, stderr, spawnLog: spawnLogText };
}

function expectNoSentinel(result: RunResult): void {
  expect(result.stdout).not.toContain(SENTINEL);
  expect(result.stderr).not.toContain(SENTINEL);
  expect(result.spawnLog).not.toContain(SENTINEL);
}

async function createModernProject(): Promise<string> {
  const projectRoot = join(requireRoot(), "modern");
  const projectDir = join(projectRoot, ".hack");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, "docker-compose.yml"),
    "services:\n  api:\n    image: alpine:3.20\n"
  );
  await writeFile(
    join(projectDir, "hack.config.json"),
    `${JSON.stringify({ name: "value-stdin-modern", dev_host: "value-stdin-modern.hack" }, null, 2)}\n`
  );
  await writeFile(
    join(projectDir, "hack.env.default.yaml"),
    'version: 1\nenvironment: default\nsecretsprovider: project_key\nvalues:\n  global:\n    GLOBAL_FLAG: "1"\n'
  );
  return projectRoot;
}

async function readProjectEnvFiles(projectRoot: string): Promise<string> {
  const files = ["hack.env.default.yaml", "hack.env.local.yaml", ".env"];
  const contents = await Promise.all(
    files.map((file) =>
      readFile(join(projectRoot, ".hack", file), "utf8").catch(() => "")
    )
  );
  return contents.join("\n");
}

async function envGet(input: {
  readonly projectRoot: string;
  readonly key: string;
  readonly service?: string;
}): Promise<RunResult> {
  return await runHack({
    args: [
      "env",
      "get",
      input.key,
      "--path",
      input.projectRoot,
      ...(input.service ? ["--service", input.service] : []),
    ],
  });
}

test(
  "env add --secret --value-stdin stores the piped value without exposing it",
  async () => {
    const projectRoot = await createModernProject();
    const result = await runHack({
      args: [
        "env",
        "add",
        "API_TOKEN",
        "--service",
        "api",
        "--secret",
        "--value-stdin",
        "--path",
        projectRoot,
      ],
      stdin: `${SENTINEL}\n`,
    });
    expect(result.exitCode).toBe(0);
    expectNoSentinel(result);
    // The recorder is live: the write path's git probe was captured.
    expect(result.spawnLog).toContain('"git"');

    // Stored encrypted, never as plaintext in project files.
    expect(await readProjectEnvFiles(projectRoot)).not.toContain(SENTINEL);

    // Positive control for the output scan: an explicit disclosure does
    // contain the value, with exactly one trailing newline stripped.
    const read = await envGet({
      projectRoot,
      key: "API_TOKEN",
      service: "api",
    });
    expect(read.exitCode).toBe(0);
    expect(read.stdout).toBe(SENTINEL);
  },
  { timeout: 30_000 }
);

test(
  "env set --value-stdin keeps every newline beyond the single stripped one",
  async () => {
    const projectRoot = await createModernProject();
    const result = await runHack({
      args: ["env", "set", "MULTILINE", "--value-stdin", "--path", projectRoot],
      stdin: `${SENTINEL}\nsecond\n\n`,
    });
    expect(result.exitCode).toBe(0);
    expectNoSentinel(result);
    const read = await envGet({ projectRoot, key: "MULTILINE" });
    expect(read.exitCode).toBe(0);
    expect(read.stdout).toBe(`${SENTINEL}\nsecond\n`);
  },
  { timeout: 30_000 }
);

test(
  "the value never appears in the CLI process listing while it waits on stdin",
  async () => {
    const projectRoot = await createModernProject();
    const base = requireRoot();
    const spawnLog = join(base, "spawn-ps.jsonl");
    const proc = Bun.spawn(
      [
        process.execPath,
        "--preload",
        RECORDER,
        ENTRYPOINT,
        "env",
        "add",
        "PS_TOKEN",
        "--secret",
        "--value-stdin",
        "--path",
        projectRoot,
      ],
      {
        cwd: REPO_ROOT,
        env: isolatedEnv(spawnLog),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const ps = Bun.spawnSync(["ps", "-ww", "-o", "args=", "-p", `${proc.pid}`]);
    const listing = ps.stdout.toString();
    proc.stdin.write(`${SENTINEL}\n`);
    await proc.stdin.end();
    const [exitCode, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    expect(listing).toContain("--value-stdin");
    expect(listing).not.toContain(SENTINEL);
    expect(exitCode).toBe(0);
    expect(stderr).not.toContain(SENTINEL);
  },
  { timeout: 30_000 }
);

test(
  "positional value plus --value-stdin is refused without echoing the value",
  async () => {
    const projectRoot = await createModernProject();
    const before = await readProjectEnvFiles(projectRoot);
    const cases: readonly (readonly string[])[] = [
      ["env", "add", "API_TOKEN", SENTINEL, "--secret", "--value-stdin"],
      ["env", "set", "API_TOKEN", SENTINEL, "--value-stdin"],
      ["env", "set", `API_TOKEN=${SENTINEL}`, "--value-stdin"],
      ["env", "add", `API_TOKEN=${SENTINEL}`, "--value-stdin"],
    ];
    for (const args of cases) {
      const result = await runHack({
        args: [...args, "--path", projectRoot],
        stdin: "piped-should-not-be-read\n",
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "--value-stdin cannot be combined with a value argument"
      );
      expectNoSentinel(result);
    }
    expect(await readProjectEnvFiles(projectRoot)).toBe(before);
  },
  { timeout: 60_000 }
);

test(
  "oversize and empty stdin are refused and nothing is stored",
  async () => {
    const projectRoot = await createModernProject();
    const before = await readProjectEnvFiles(projectRoot);

    const oversize = await runHack({
      args: [
        "env",
        "add",
        "BIG_TOKEN",
        "--secret",
        "--value-stdin",
        "--path",
        projectRoot,
      ],
      stdin: SENTINEL.repeat(Math.ceil((64 * 1024 + 1) / SENTINEL.length)),
    });
    expect(oversize.exitCode).toBe(1);
    expect(oversize.stderr).toContain("exceeds the 65536-byte limit");
    expectNoSentinel(oversize);

    for (const stdin of ["", "\n"]) {
      const empty = await runHack({
        args: [
          "env",
          "add",
          "EMPTY_TOKEN",
          "--value-stdin",
          "--path",
          projectRoot,
        ],
        stdin,
      });
      expect(empty.exitCode).toBe(1);
      expect(empty.stderr).toContain("--value-stdin received an empty value");
    }

    const missingKey = await runHack({
      args: ["env", "add", "--value-stdin", "--path", projectRoot],
      stdin: `${SENTINEL}\n`,
    });
    expect(missingKey.exitCode).toBe(1);
    expect(missingKey.stderr).toContain("--value-stdin requires the key");
    expectNoSentinel(missingKey);

    expect(await readProjectEnvFiles(projectRoot)).toBe(before);
  },
  { timeout: 60_000 }
);

test(
  "non-TTY refusal suggests --value-stdin instead of a value argument",
  async () => {
    const projectRoot = await createModernProject();
    const result = await runHack({
      args: ["env", "add", "API_TOKEN", "--secret", "--path", projectRoot],
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("E_INTERACTIVE_REQUIRED");
    expect(result.stderr).toContain("--value-stdin");
    expect(result.stderr).not.toContain("Pass the value as an argument");
    expect(result.stderr).not.toContain("hack env add KEY value --secret");
  },
  { timeout: 30_000 }
);

test(
  "legacy env set --secret --value-stdin writes through an injected encrypted_file store",
  async () => {
    const base = requireRoot();
    const projectRoot = join(base, "legacy");
    const projectDir = join(projectRoot, ".hack");
    const storePath = join(base, "secrets.enc.json");
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, "docker-compose.yml"), "services: {}\n");
    await writeFile(
      join(projectDir, "hack.config.json"),
      `${JSON.stringify(
        {
          name: "value-stdin-legacy",
          controlPlane: {
            secrets: {
              backend: "encrypted_file",
              encryptedFile: { path: storePath },
            },
          },
        },
        null,
        2
      )}\n`
    );
    await writeFile(
      join(projectDir, "hack.env.json"),
      `${JSON.stringify(
        {
          version: 1,
          vars: [{ key: "API_KEY", required: false, source: "keychain" }],
        },
        null,
        2
      )}\n`
    );

    const result = await runHack({
      args: ["env", "set", "API_KEY", "--secret", "--value-stdin"],
      stdin: `${SENTINEL}\r\n`,
      cwd: projectRoot,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("encrypted_file");
    expectNoSentinel(result);
    expect(await readFile(storePath, "utf8")).not.toContain(SENTINEL);
    expect(
      await readFile(join(projectDir, ".env"), "utf8").catch(() => "")
    ).not.toContain(SENTINEL);

    const list = await runHack({
      args: ["env", "list", "--show-secrets", "--json"],
      cwd: projectRoot,
    });
    expect(list.exitCode).toBe(0);
    const payload = JSON.parse(list.stdout) as {
      readonly vars: ReadonlyArray<{
        readonly key: string;
        readonly value: string | null;
      }>;
    };
    expect(payload.vars.find((entry) => entry.key === "API_KEY")?.value).toBe(
      SENTINEL
    );
  },
  { timeout: 60_000 }
);
