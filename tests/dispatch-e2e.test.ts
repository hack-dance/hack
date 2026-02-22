import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  deleteNodeAuthToken,
  upsertNodeRecord,
} from "../src/lib/nodes-registry.ts";
import { findProjectContext } from "../src/lib/project.ts";
import { upsertProjectRegistration } from "../src/lib/projects-registry.ts";

const shouldRun = process.env.HACK_DISPATCH_E2E === "1";
const runTest = shouldRun ? test : test.skip;

type DispatchJsonOutput = {
  readonly runId: string;
  readonly status: string;
  readonly workspace: {
    readonly projectId: string;
    readonly projectName: string;
    readonly branch: string | null;
  };
  readonly artifacts: {
    readonly rootDir: string;
    readonly summaryPath: string;
    readonly patchPath: string;
    readonly testsPath: string;
    readonly logPath: string;
    readonly manifestPath: string;
    readonly eventsPath: string;
  };
};

type FakeGatewayState = {
  ensurePayload: Record<string, unknown> | null;
  jobCreatePayload: Record<string, unknown> | null;
  jobStatus: "running" | "completed";
  jobPolls: number;
};

const trackedAuthRefs: string[] = [];
let tempHome: string | null = null;
let previousHome: string | undefined;
let previousGlobalConfigPath: string | undefined;

afterEach(async () => {
  for (const authRef of trackedAuthRefs.splice(0)) {
    await deleteNodeAuthToken({ authRef }).catch(() => undefined);
  }
  if (tempHome) {
    await rm(tempHome, { recursive: true, force: true });
    tempHome = null;
  }
  process.env.HOME = previousHome;
  if (previousGlobalConfigPath !== undefined) {
    process.env.HACK_GLOBAL_CONFIG_PATH = previousGlobalConfigPath;
  } else {
    process.env.HACK_GLOBAL_CONFIG_PATH = undefined;
  }
});

runTest(
  "dispatch run executes against remote node and persists artifacts",
  async () => {
    tempHome = await mkdtemp(join(tmpdir(), "hack-dispatch-e2e-"));
    previousHome = process.env.HOME;
    previousGlobalConfigPath = process.env.HACK_GLOBAL_CONFIG_PATH;
    process.env.HOME = tempHome;
    process.env.HACK_GLOBAL_CONFIG_PATH = "";

    const workspace = join(tempHome, "workspace");
    await mkdir(workspace, { recursive: true });
    const projectRoot = join(workspace, "dispatch-project");
    await createMinimalProject({ projectRoot, projectName: "dispatch-e2e" });
    await initializeGitRepo({ projectRoot });
    await runGit({
      cwd: projectRoot,
      args: ["remote", "add", "origin", "https://github.com/example/repo.git"],
    });

    const project = await findProjectContext(projectRoot);
    if (!project) {
      throw new Error("Failed to resolve project context");
    }
    const registered = await upsertProjectRegistration({ project });
    if (registered.status === "conflict") {
      throw new Error("Unexpected project registration conflict in e2e test");
    }

    const nodeToken = "dispatch-e2e-node-token";
    const nodeTokenEnv = "HACK_DISPATCH_E2E_NODE_TOKEN";
    const nodeId = "dispatch-e2e-node";
    const authRef = `env:${nodeTokenEnv}`;
    trackedAuthRefs.push(authRef);
    process.env[nodeTokenEnv] = nodeToken;
    const gateway = await startFakeNodeGateway({
      token: nodeToken,
      projectName: "dispatch-e2e",
      projectId: "dispatch-e2e-project-id",
      branch: "feat/e2e-branch",
      projectRoot: "/remote/workspaces/dispatch-e2e",
    });

    try {
      await upsertNodeRecord({
        id: nodeId,
        name: "Dispatch E2E Node",
        labels: ["e2e"],
        capabilities: ["runtime", "gateway", "supervisor"],
        endpoint: gateway.baseUrl,
        authRef,
        lastSeenAt: new Date().toISOString(),
        status: "healthy",
        platform: "linux",
        arch: "x64",
        version: "test",
      });

      const command = [
        "bun",
        resolve(import.meta.dir, "../index.ts"),
        "dispatch",
        "run",
        "--project",
        "dispatch-e2e",
        "--node",
        nodeId,
        "--branch",
        "feat/e2e-branch",
        "--json",
        "--",
        "echo",
        "dispatch-e2e",
      ] as const;

      const result = await runCommand({
        cmd: command,
        cwd: resolve(import.meta.dir, ".."),
        env: {
          ...process.env,
          HOME: tempHome,
          HACK_GLOBAL_CONFIG_PATH: "",
          [nodeTokenEnv]: nodeToken,
          NO_COLOR: "1",
        },
      });
      if (result.exitCode !== 0) {
        throw new Error(
          `dispatch command failed\nstdout:\n${result.stdout}\n\nstderr:\n${result.stderr}`
        );
      }
      const output = parseDispatchJson({ text: result.stdout });
      expect(output.status).toBe("completed");
      expect(output.workspace.projectId).toBe("dispatch-e2e-project-id");
      expect(output.workspace.branch).toBe("feat/e2e-branch");

      const ensurePayload = gateway.state.ensurePayload;
      if (!ensurePayload) {
        throw new Error("Missing workspace ensure payload");
      }
      expect(ensurePayload.branch).toBe("feat/e2e-branch");
      const bootstrap = ensurePayload.bootstrap as
        | Record<string, unknown>
        | undefined;
      expect(bootstrap?.repo_url).toBe("https://github.com/example/repo.git");
      expect(bootstrap?.project_name).toBe("dispatch-e2e");
      const jobCreatePayload = gateway.state.jobCreatePayload;
      if (!jobCreatePayload) {
        throw new Error("Missing job create payload");
      }
      expect(jobCreatePayload.cwd).toBe("/remote/workspaces/dispatch-e2e");

      const summary = await readFile(output.artifacts.summaryPath, "utf8");
      const logs = await readFile(output.artifacts.logPath, "utf8");
      const manifest = await readFile(output.artifacts.manifestPath, "utf8");
      const events = await readFile(output.artifacts.eventsPath, "utf8");

      expect(summary).toContain(`# Dispatch Run ${output.runId}`);
      expect(summary).toContain("status: completed");
      expect(logs).toContain("remote: dispatch run log line");
      expect(manifest).toContain('"jobStatus": "completed"');
      expect(events).toContain('"type":"job.event"');
    } finally {
      gateway.stop();
    }
  }
);

/**
 * Create a minimal project fixture with `.hack` metadata required by project discovery.
 */
async function createMinimalProject(input: {
  readonly projectRoot: string;
  readonly projectName: string;
}): Promise<void> {
  await mkdir(resolve(input.projectRoot, ".hack"), { recursive: true });
  await writeFile(
    resolve(input.projectRoot, ".hack", "docker-compose.yml"),
    "services: {}\n"
  );
  await writeFile(
    resolve(input.projectRoot, ".hack", "hack.config.json"),
    `${JSON.stringify({ name: input.projectName }, null, 2)}\n`
  );
  await writeFile(resolve(input.projectRoot, "README.md"), "# dispatch-e2e\n");
}

/**
 * Initialize a git repository with a first commit so dispatch can derive origin metadata.
 */
async function initializeGitRepo(input: {
  readonly projectRoot: string;
}): Promise<void> {
  await runGit({ cwd: input.projectRoot, args: ["init"] });
  await runGit({ cwd: input.projectRoot, args: ["branch", "-M", "main"] });
  await runGit({ cwd: input.projectRoot, args: ["add", "."] });
  await runGit({
    cwd: input.projectRoot,
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

async function runGit(input: {
  readonly cwd: string;
  readonly args: readonly string[];
}): Promise<void> {
  const result = await runCommand({
    cmd: ["git", ...input.args],
    cwd: input.cwd,
    env: process.env,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${input.args.join(" ")} failed: ${result.stderr || result.stdout}`
    );
  }
}

async function runCommand(input: {
  readonly cmd: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const proc = Bun.spawn([...input.cmd], {
    cwd: input.cwd,
    env: input.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function parseDispatchJson(input: {
  readonly text: string;
}): DispatchJsonOutput {
  const trimmed = input.text.trim();
  if (!trimmed) {
    throw new Error("Dispatch output is empty");
  }
  return JSON.parse(trimmed) as DispatchJsonOutput;
}

/**
 * Start a fake node gateway that exposes the subset of endpoints dispatch needs.
 */
async function startFakeNodeGateway(input: {
  readonly token: string;
  readonly projectName: string;
  readonly projectId: string;
  readonly branch: string;
  readonly projectRoot: string;
}): Promise<{
  readonly baseUrl: string;
  readonly state: FakeGatewayState;
  readonly stop: () => void;
}> {
  const state: FakeGatewayState = {
    ensurePayload: null,
    jobCreatePayload: null,
    jobStatus: "running",
    jobPolls: 0,
  };
  const streamPath = `/control-plane/projects/${input.projectId}/jobs/job-1/stream`;
  const serve = Bun.serve<{ readonly authorized: boolean }>({
    port: 0,
    fetch: async (req, server): Promise<Response | undefined> => {
      if (!isAuthorizedRequest({ req, token: input.token })) {
        return jsonResponse(
          { error: "unauthorized", message: "Invalid bearer token" },
          401
        );
      }
      const url = new URL(req.url);
      if (url.pathname === "/v1/node/status" && req.method === "GET") {
        return jsonResponse({
          status: "ok",
          version: "test",
          pid: 1,
          started_at: new Date().toISOString(),
          uptime_ms: 1,
          node: {
            name: "dispatch-e2e-node",
            platform: "linux",
            arch: "x64",
            bun: Bun.version,
          },
          gateway: {
            enabled: true,
            bind: "127.0.0.1",
            port: server.port,
            allowWrites: true,
            projects: [
              {
                project_id: input.projectId,
                project_name: input.projectName,
              },
            ],
          },
          supervisor: {
            enabled: true,
            maxConcurrentJobs: 4,
          },
          devcontainers: {
            running: 0,
            sessions: [],
          },
        });
      }
      if (
        url.pathname === "/v1/node/workspaces/ensure" &&
        req.method === "POST"
      ) {
        state.ensurePayload = (await req.json()) as Record<string, unknown>;
        return jsonResponse({
          workspace: {
            projectId: input.projectId,
            projectName: input.projectName,
            projectRoot: input.projectRoot,
            projectDir: resolve(input.projectRoot, ".hack"),
            branch: input.branch,
          },
        });
      }
      if (
        url.pathname === `/control-plane/projects/${input.projectId}/jobs` &&
        req.method === "POST"
      ) {
        state.jobCreatePayload = (await req.json()) as Record<string, unknown>;
        state.jobStatus = "running";
        state.jobPolls = 0;
        return jsonResponse({
          job: {
            jobId: "job-1",
            status: "running",
            command: ["echo", "dispatch-e2e"],
          },
        });
      }
      if (
        url.pathname ===
          `/control-plane/projects/${input.projectId}/jobs/job-1` &&
        req.method === "GET"
      ) {
        state.jobPolls += 1;
        if (state.jobPolls >= 2) {
          state.jobStatus = "completed";
        }
        return jsonResponse({
          job: {
            jobId: "job-1",
            status: state.jobStatus,
            command: ["echo", "dispatch-e2e"],
          },
        });
      }
      if (url.pathname === streamPath) {
        if (
          server.upgrade(req, {
            data: {
              authorized: true,
            },
          })
        ) {
          return;
        }
        return jsonResponse(
          { error: "upgrade_failed", message: "WebSocket upgrade failed" },
          400
        );
      }
      return jsonResponse({ error: "not_found", message: "not found" }, 404);
    },
    websocket: {
      message: (ws) => {
        ws.send(
          JSON.stringify({
            type: "ready",
            logsOffset: 0,
            eventsSeq: 0,
          })
        );
        ws.send(
          JSON.stringify({
            type: "log",
            data: "remote: dispatch run log line\n",
            offset: 30,
          })
        );
        ws.send(
          JSON.stringify({
            type: "event",
            event: {
              seq: 1,
              type: "job.completed",
              payload: {
                exitCode: 0,
              },
            },
          })
        );
        state.jobStatus = "completed";
      },
    },
  });

  return {
    baseUrl: `http://127.0.0.1:${serve.port}`,
    state,
    stop: () => {
      serve.stop();
    },
  };
}

function isAuthorizedRequest(input: {
  readonly req: Request;
  readonly token: string;
}): boolean {
  const header = input.req.headers.get("authorization") ?? "";
  if (header === `Bearer ${input.token}`) {
    return true;
  }
  const url = new URL(input.req.url);
  return url.searchParams.get("token") === input.token;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}
