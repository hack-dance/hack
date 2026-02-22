import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { handleNodeRoutes } from "../src/daemon/routes/node.ts";
import { exec } from "../src/lib/shell.ts";

let tempDir: string | null = null;
let originalHome: string | undefined;
let originalGlobalConfigPath: string | undefined;

beforeEach(async () => {
  originalHome = process.env.HOME;
  originalGlobalConfigPath = process.env.HACK_GLOBAL_CONFIG_PATH;
  tempDir = await mkdtemp(join(tmpdir(), "hack-node-bootstrap-"));
  process.env.HOME = tempDir;
  process.env.HACK_GLOBAL_CONFIG_PATH = undefined;
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
  process.env.HOME = originalHome;
  if (originalGlobalConfigPath !== undefined) {
    process.env.HACK_GLOBAL_CONFIG_PATH = originalGlobalConfigPath;
  } else {
    process.env.HACK_GLOBAL_CONFIG_PATH = undefined;
  }
});

test("workspace ensure bootstraps a missing project by cloning repo", async () => {
  if (!tempDir) {
    throw new Error("Missing tempDir");
  }
  const sourceRepo = join(tempDir, "source-repo");
  await createMinimalHackRepo({ root: sourceRepo });

  const request = new Request(
    "http://127.0.0.1:7788/v1/node/workspaces/ensure",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project: "bootstrap-target",
        branch: "main",
        bootstrap: {
          repo_url: sourceRepo,
          project_name: "bootstrap-target",
        },
      }),
    }
  );
  const response = await handleNodeRoutes({
    req: request,
    url: new URL(request.url),
    version: "test",
    pid: 123,
    startedAtMs: Date.now(),
  });

  expect(response).not.toBeNull();
  if (!response) {
    return;
  }
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    readonly workspace?: {
      readonly projectName?: string;
      readonly projectRoot?: string;
      readonly projectDir?: string;
      readonly branch?: string | null;
    };
  };
  expect(body.workspace?.projectName).toBe("bootstrap-target");
  expect(body.workspace?.branch).toBe("main");
  expect(body.workspace?.projectRoot).toBe(
    resolve(tempDir, "dev", "hack-nodes", "bootstrap-target")
  );
  expect(body.workspace?.projectDir).toBe(
    resolve(tempDir, "dev", "hack-nodes", "bootstrap-target", ".hack")
  );
});

test("workspace ensure still returns unknown project when bootstrap is absent", async () => {
  const request = new Request(
    "http://127.0.0.1:7788/v1/node/workspaces/ensure",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project: "unknown-project",
      }),
    }
  );
  const response = await handleNodeRoutes({
    req: request,
    url: new URL(request.url),
    version: "test",
    pid: 123,
    startedAtMs: Date.now(),
  });

  expect(response).not.toBeNull();
  if (!response) {
    return;
  }
  expect(response.status).toBe(404);
  const body = (await response.json()) as { readonly error?: string };
  expect(body.error).toBe("unknown_project_name");
});

async function createMinimalHackRepo(opts: {
  readonly root: string;
}): Promise<void> {
  await mkdir(join(opts.root, ".hack"), { recursive: true });
  await writeFile(
    join(opts.root, ".hack", "docker-compose.yml"),
    "services: {}\n"
  );
  await writeFile(
    join(opts.root, ".hack", "hack.config.json"),
    '{ "name": "bootstrap-target" }\n'
  );
  await writeFile(join(opts.root, "README.md"), "# bootstrap\n");

  await runGit({ cwd: opts.root, args: ["init"] });
  await runGit({ cwd: opts.root, args: ["branch", "-M", "main"] });
  await runGit({ cwd: opts.root, args: ["add", "."] });
  await runGit({
    cwd: opts.root,
    args: [
      "-c",
      "user.name=hack",
      "-c",
      "user.email=hack@example.com",
      "commit",
      "-m",
      "init",
    ],
  });
}

async function runGit(opts: {
  readonly cwd: string;
  readonly args: readonly string[];
}): Promise<void> {
  const result = await exec(["git", ...opts.args], {
    cwd: opts.cwd,
    stdin: "ignore",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${opts.args.join(" ")} failed: ${result.stderr || result.stdout}`
    );
  }
}
