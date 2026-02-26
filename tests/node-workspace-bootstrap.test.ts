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
    resolve(tempDir, ".hack", "projects", "bootstrap-target")
  );
  expect(body.workspace?.projectDir).toBe(
    resolve(tempDir, ".hack", "projects", "bootstrap-target", ".hack")
  );

  const map = await readNodeWorkspaceMap({ homeDir: tempDir });
  expect(map.entries).toHaveLength(1);
  expect(map.entries[0]?.projectName).toBe("bootstrap-target");
  expect(map.entries[0]?.source).toBe("managed");
  expect(map.entries[0]?.workspaceRoot).toBe(
    resolve(tempDir, ".hack", "projects", "bootstrap-target")
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

test("workspace ensure can recover from node map when registry is missing", async () => {
  if (!tempDir) {
    throw new Error("Missing tempDir");
  }
  const sourceRepo = join(tempDir, "source-repo");
  await createMinimalHackRepo({ root: sourceRepo });

  const bootstrapRequest = new Request(
    "http://127.0.0.1:7788/v1/node/workspaces/ensure",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project: "bootstrap-target",
        bootstrap: {
          repo_url: sourceRepo,
          project_name: "bootstrap-target",
        },
      }),
    }
  );
  const bootstrapResponse = await handleNodeRoutes({
    req: bootstrapRequest,
    url: new URL(bootstrapRequest.url),
    version: "test",
    pid: 123,
    startedAtMs: Date.now(),
  });
  expect(bootstrapResponse?.status).toBe(200);

  await rm(resolve(tempDir, ".hack", "projects.json"), { force: true });

  const mappedRequest = new Request(
    "http://127.0.0.1:7788/v1/node/workspaces/ensure",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project: "bootstrap-target",
        branch: "main",
      }),
    }
  );
  const mappedResponse = await handleNodeRoutes({
    req: mappedRequest,
    url: new URL(mappedRequest.url),
    version: "test",
    pid: 123,
    startedAtMs: Date.now(),
  });
  expect(mappedResponse?.status).toBe(200);
  if (!mappedResponse) {
    return;
  }
  const body = (await mappedResponse.json()) as {
    readonly workspace?: {
      readonly projectRoot?: string;
      readonly branch?: string | null;
    };
  };
  expect(body.workspace?.branch).toBe("main");
  expect(body.workspace?.projectRoot).toBe(
    resolve(tempDir, ".hack", "projects", "bootstrap-target")
  );
});

test("workspace ensure resolves by controller project id when node project id differs", async () => {
  if (!tempDir) {
    throw new Error("Missing tempDir");
  }
  const sourceRepo = join(tempDir, "source-repo");
  await createMinimalHackRepo({ root: sourceRepo });

  const bootstrapRequest = new Request(
    "http://127.0.0.1:7788/v1/node/workspaces/ensure",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project: "bootstrap-target",
        controller_project_id: "controller-project-id",
        controller_project_name: "event-agent",
        bootstrap: {
          repo_url: sourceRepo,
          project_name: "bootstrap-target",
        },
      }),
    }
  );
  const bootstrapResponse = await handleNodeRoutes({
    req: bootstrapRequest,
    url: new URL(bootstrapRequest.url),
    version: "test",
    pid: 123,
    startedAtMs: Date.now(),
  });
  expect(bootstrapResponse?.status).toBe(200);

  const map = await readNodeWorkspaceMap({ homeDir: tempDir });
  expect(map.entries).toHaveLength(1);
  expect(map.entries[0]?.projectId).toBe("controller-project-id");
  expect(map.entries[0]?.projectName).toBe("event-agent");

  await rm(resolve(tempDir, ".hack", "projects.json"), { force: true });

  const mappedRequest = new Request(
    "http://127.0.0.1:7788/v1/node/workspaces/ensure",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project: "completely-different-name",
        controller_project_id: "controller-project-id",
        branch: "main",
      }),
    }
  );
  const mappedResponse = await handleNodeRoutes({
    req: mappedRequest,
    url: new URL(mappedRequest.url),
    version: "test",
    pid: 123,
    startedAtMs: Date.now(),
  });
  expect(mappedResponse?.status).toBe(200);
  if (!mappedResponse) {
    return;
  }
  const mappedBody = (await mappedResponse.json()) as {
    readonly workspace?: {
      readonly projectRoot?: string;
      readonly branch?: string | null;
    };
  };
  expect(mappedBody.workspace?.branch).toBe("main");
  expect(mappedBody.workspace?.projectRoot).toBe(
    resolve(tempDir, ".hack", "projects", "bootstrap-target")
  );
});

async function readNodeWorkspaceMap(opts: {
  readonly homeDir: string;
}): Promise<{
  readonly entries: readonly {
    readonly projectName?: string;
    readonly projectId?: string;
    readonly source?: string;
    readonly workspaceRoot?: string;
  }[];
}> {
  const file = Bun.file(resolve(opts.homeDir, ".hack", "projects.config.json"));
  const text = await file.text();
  const parsed = JSON.parse(text) as {
    readonly entries?: readonly {
      readonly projectName?: string;
      readonly projectId?: string;
      readonly source?: string;
      readonly workspaceRoot?: string;
    }[];
  };
  return {
    entries: parsed.entries ?? [],
  };
}

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
