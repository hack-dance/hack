import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findProjectContext } from "../src/lib/project.ts";
import { upsertProjectRegistration } from "../src/lib/projects-registry.ts";

type CliRunResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

let tempDir: string | null = null;
const originalHome = process.env.HOME;
const originalGlobalConfigPath = process.env.HACK_GLOBAL_CONFIG_PATH;
const originalLogger = process.env.HACK_LOGGER;
const originalSetupSyncMode = process.env.HACK_SETUP_SYNC_MODE;
const originalGitHubTokenEnv = process.env.HACK_GITHUB_APP_TOKEN;
const originalFetch = globalThis.fetch;

const { runCli } = await import("../src/cli/run.ts");

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-dispatch-local-"));
  process.env.HOME = tempDir;
  process.env.HACK_GLOBAL_CONFIG_PATH = resolve(tempDir, "hack.config.json");
  process.env.HACK_LOGGER = "console";
  process.env.HACK_SETUP_SYNC_MODE = "off";
  await writeFile(process.env.HACK_GLOBAL_CONFIG_PATH, "{}\n");
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
  if (originalHome === undefined) {
    process.env.HOME = undefined;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalGlobalConfigPath === undefined) {
    process.env.HACK_GLOBAL_CONFIG_PATH = undefined;
  } else {
    process.env.HACK_GLOBAL_CONFIG_PATH = originalGlobalConfigPath;
  }
  if (originalLogger === undefined) {
    process.env.HACK_LOGGER = undefined;
  } else {
    process.env.HACK_LOGGER = originalLogger;
  }
  if (originalSetupSyncMode === undefined) {
    process.env.HACK_SETUP_SYNC_MODE = undefined;
  } else {
    process.env.HACK_SETUP_SYNC_MODE = originalSetupSyncMode;
  }
  if (originalGitHubTokenEnv === undefined) {
    process.env.HACK_GITHUB_APP_TOKEN = undefined;
  } else {
    process.env.HACK_GITHUB_APP_TOKEN = originalGitHubTokenEnv;
  }
  globalThis.fetch = originalFetch;
});

test("dispatch run --local executes in the project workspace and persists terminalState", async () => {
  if (!tempDir) {
    throw new Error("Missing temp dir");
  }
  const repoRoot = resolve(tempDir, "repo");
  await createMinimalHackRepo({ repoRoot });

  const result = await runCliWithCapturedIo({
    argv: [
      "dispatch",
      "run",
      "--project",
      "dispatch-local-test",
      "--local",
      "--json",
      "--",
      "bash",
      "-lc",
      "printf 'hello from local dispatch\\n'",
    ],
  });

  expect(result.exitCode).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    readonly runId: string;
    readonly status: string;
    readonly terminalState?: string;
    readonly artifacts: {
      readonly manifestPath: string;
      readonly logPath: string;
    };
    readonly exitCode?: number;
  };
  expect(payload.status).toBe("completed");
  expect(payload.terminalState).toBe("completed");
  expect(payload.exitCode).toBe(0);

  const manifest = JSON.parse(
    await readFile(payload.artifacts.manifestPath, "utf8")
  ) as {
    readonly status: string;
    readonly terminalState?: string;
    readonly mode?: string;
  };
  expect(manifest.status).toBe("completed");
  expect(manifest.terminalState).toBe("completed");
  expect(manifest.mode).toBe("local");

  const logText = await readFile(payload.artifacts.logPath, "utf8");
  expect(logText).toContain("hello from local dispatch");
});

test("dispatch run --local --pr returns no_diff when branch has no committed diff", async () => {
  if (!tempDir) {
    throw new Error("Missing temp dir");
  }
  const repoRoot = resolve(tempDir, "repo-no-diff");
  await createMinimalHackRepo({ repoRoot });
  await initGitRepo({ repoRoot, remoteName: "origin" });

  process.env.HACK_GITHUB_APP_TOKEN = "test-token";

  const result = await runCliWithCapturedIo({
    argv: [
      "dispatch",
      "run",
      "--project",
      "dispatch-local-test",
      "--local",
      "--pr",
      "--json",
      "--",
      "bash",
      "-lc",
      "printf 'no-op\\n'",
    ],
  });

  expect(result.exitCode).toBe(20);
  const payload = JSON.parse(result.stdout) as {
    readonly status: string;
    readonly terminalState?: string;
    readonly artifacts: {
      readonly manifestPath: string;
    };
  };
  expect(payload.status).toBe("completed");
  expect(payload.terminalState).toBe("no_diff");

  const manifest = JSON.parse(
    await readFile(payload.artifacts.manifestPath, "utf8")
  ) as {
    readonly terminalState?: string;
  };
  expect(manifest.terminalState).toBe("no_diff");
});

test("dispatch run --local --pr returns no_commit when command leaves local diff uncommitted", async () => {
  if (!tempDir) {
    throw new Error("Missing temp dir");
  }
  const repoRoot = resolve(tempDir, "repo-no-commit");
  await createMinimalHackRepo({ repoRoot });
  await initGitRepo({ repoRoot, remoteName: "origin" });
  await git({ cwd: repoRoot, cmd: ["checkout", "-b", "feat/no-commit"] });

  process.env.HACK_GITHUB_APP_TOKEN = "test-token";

  const result = await runCliWithCapturedIo({
    argv: [
      "dispatch",
      "run",
      "--project",
      "dispatch-local-test",
      "--local",
      "--pr",
      "--json",
      "--",
      "bash",
      "-lc",
      "printf 'dirty\\n' >> local-change.txt",
    ],
  });

  expect(result.exitCode).toBe(21);
  const payload = JSON.parse(result.stdout) as {
    readonly terminalState?: string;
    readonly artifacts: {
      readonly manifestPath: string;
    };
  };
  expect(payload.terminalState).toBe("no_commit");

  const manifest = JSON.parse(
    await readFile(payload.artifacts.manifestPath, "utf8")
  ) as {
    readonly terminalState?: string;
  };
  expect(manifest.terminalState).toBe("no_commit");
});

test(
  "dispatch run --local --pr creates a pull request when branch is committed and ahead",
  { timeout: 15_000 },
  async () => {
    if (!tempDir) {
      throw new Error("Missing temp dir");
    }
    const repoRoot = resolve(tempDir, "repo-pr-created");
    await createMinimalHackRepo({ repoRoot });
    await initGitRepo({ repoRoot, remoteName: "origin" });
    await git({ cwd: repoRoot, cmd: ["checkout", "-b", "feat/local-pr"] });
    await writeFile(resolve(repoRoot, "feature.txt"), "feature\n");
    await git({ cwd: repoRoot, cmd: ["add", "feature.txt"] });
    await git({
      cwd: repoRoot,
      cmd: ["commit", "-m", "Add local feature for PR"],
    });

    process.env.HACK_GITHUB_APP_TOKEN = "test-token";
    globalThis.fetch = async (input, init) => {
      const requestUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = init?.method ?? "GET";
      if (
        method === "GET" &&
        requestUrl.includes("/repos/acme/dispatch-local-test/pulls?")
      ) {
        return Response.json([]);
      }
      if (
        method === "POST" &&
        requestUrl.endsWith("/repos/acme/dispatch-local-test/pulls")
      ) {
        return Response.json({
          number: 42,
          url: "https://api.github.com/repos/acme/dispatch-local-test/pulls/42",
          html_url: "https://github.com/acme/dispatch-local-test/pull/42",
          title: "hack: dispatch-local-test (feat/local-pr)",
          state: "open",
          head: { ref: "feat/local-pr" },
          base: { ref: "main" },
        });
      }
      if (
        method === "POST" &&
        requestUrl.endsWith(
          "/repos/acme/dispatch-local-test/issues/42/comments"
        )
      ) {
        return Response.json({
          id: 7,
          url: "https://api.github.com/repos/acme/dispatch-local-test/issues/comments/7",
        });
      }
      return new Response("unexpected request", { status: 500 });
    };

    const result = await runCliWithCapturedIo({
      argv: [
        "dispatch",
        "run",
        "--project",
        "dispatch-local-test",
        "--local",
        "--pr",
        "--json",
        "--",
        "bash",
        "-lc",
        "printf 'ready\\n'",
      ],
    });

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      readonly terminalState?: string;
      readonly pr?: {
        readonly ok: boolean;
        readonly pull?: {
          readonly number: number;
          readonly htmlUrl: string;
        };
      };
    };
    expect(payload.terminalState).toBe("pr_created");
    expect(payload.pr?.ok).toBe(true);
    expect(payload.pr?.pull?.number).toBe(42);
  }
);

test(
  "dispatch run --local --pr returns pr_failed when GitHub PR automation fails",
  { timeout: 15_000 },
  async () => {
    if (!tempDir) {
      throw new Error("Missing temp dir");
    }
    const repoRoot = resolve(tempDir, "repo-pr-failed");
    await createMinimalHackRepo({ repoRoot });
    await initGitRepo({ repoRoot, remoteName: "origin" });
    await git({ cwd: repoRoot, cmd: ["checkout", "-b", "feat/pr-fails"] });
    await writeFile(resolve(repoRoot, "feature.txt"), "feature\n");
    await git({ cwd: repoRoot, cmd: ["add", "feature.txt"] });
    await git({
      cwd: repoRoot,
      cmd: ["commit", "-m", "Add local feature for failing PR"],
    });

    process.env.HACK_GITHUB_APP_TOKEN = "test-token";
    globalThis.fetch = async (input, init) => {
      const requestUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = init?.method ?? "GET";
      if (
        method === "GET" &&
        requestUrl.includes("/repos/acme/dispatch-local-test/pulls?")
      ) {
        return Response.json([]);
      }
      if (
        method === "POST" &&
        requestUrl.endsWith("/repos/acme/dispatch-local-test/pulls")
      ) {
        return Response.json(
          {
            message: "validation failed",
          },
          { status: 422 }
        );
      }
      return new Response("unexpected request", { status: 500 });
    };

    const result = await runCliWithCapturedIo({
      argv: [
        "dispatch",
        "run",
        "--project",
        "dispatch-local-test",
        "--local",
        "--pr",
        "--json",
        "--",
        "bash",
        "-lc",
        "printf 'ready\\n'",
      ],
    });

    expect(result.exitCode).toBe(22);
    const payload = JSON.parse(result.stdout) as {
      readonly terminalState?: string;
      readonly pr?: {
        readonly ok: boolean;
        readonly error?: string;
      };
    };
    expect(payload.terminalState).toBe("pr_failed");
    expect(payload.pr?.ok).toBe(false);
    expect(payload.pr?.error).toContain("GitHub PR upsert failed");
  }
);

async function createMinimalHackRepo(input: {
  readonly repoRoot: string;
}): Promise<void> {
  await mkdir(resolve(input.repoRoot, ".hack"), { recursive: true });
  await writeFile(
    resolve(input.repoRoot, ".hack", "docker-compose.yml"),
    "services: {}\n"
  );
  await writeFile(
    resolve(input.repoRoot, ".hack", "hack.config.json"),
    `${JSON.stringify({ name: "dispatch-local-test" }, null, 2)}\n`
  );
  const ctx = await findProjectContext(input.repoRoot);
  if (!ctx) {
    throw new Error("Missing project context");
  }
  await upsertProjectRegistration({ project: ctx });
}

async function initGitRepo(input: {
  readonly repoRoot: string;
  readonly remoteName: string;
}): Promise<void> {
  const bareRemoteRoot = resolve(
    input.repoRoot,
    "..",
    "dispatch-local-test.git"
  );
  await git({ cwd: input.repoRoot, cmd: ["init", "-b", "main"] });
  await git({
    cwd: input.repoRoot,
    cmd: ["config", "user.name", "Hack Test"],
  });
  await git({
    cwd: input.repoRoot,
    cmd: ["config", "user.email", "hack@example.com"],
  });
  await writeFile(resolve(input.repoRoot, "README.md"), "# dispatch local\n");
  await git({ cwd: input.repoRoot, cmd: ["add", "."] });
  await git({
    cwd: input.repoRoot,
    cmd: ["commit", "-m", "Initial commit"],
  });

  await git({
    cwd: resolve(input.repoRoot, ".."),
    cmd: ["init", "--bare", bareRemoteRoot],
  });
  await git({
    cwd: input.repoRoot,
    cmd: [
      "remote",
      "add",
      input.remoteName,
      "https://github.com/acme/dispatch-local-test.git",
    ],
  });
  await git({
    cwd: input.repoRoot,
    cmd: ["remote", "set-url", "--push", input.remoteName, bareRemoteRoot],
  });
  await git({
    cwd: input.repoRoot,
    cmd: ["push", "-u", input.remoteName, "main"],
  });
}

async function git(input: {
  readonly cwd: string;
  readonly cmd: readonly string[];
}): Promise<void> {
  const proc = Bun.spawn(["git", ...input.cmd], {
    cwd: input.cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(
      `git ${input.cmd.join(" ")} failed with ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`
    );
  }
}

async function runCliWithCapturedIo(input: {
  readonly argv: readonly string[];
}): Promise<CliRunResult> {
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
    const exitCode = await runCli(input.argv);
    return { exitCode, stdout, stderr };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}
