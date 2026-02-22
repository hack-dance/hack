import { randomUUID } from "node:crypto";
import { homedir, hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { resolveGatewayConfig } from "../../control-plane/extensions/gateway/config.ts";
import { readControlPlaneConfig } from "../../control-plane/sdk/config.ts";
import { ensureDir, pathExists } from "../../lib/fs.ts";
import {
  findProjectContext,
  readProjectConfig,
  sanitizeProjectSlug,
} from "../../lib/project.ts";
import {
  resolveRegisteredProjectById,
  resolveRegisteredProjectByName,
  upsertProjectRegistration,
} from "../../lib/projects-registry.ts";
import { exec, findExecutableInPath } from "../../lib/shell.ts";

type WorkspaceInfo = {
  readonly projectId: string;
  readonly projectName: string;
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly branch: string | null;
};

type DevcontainerSession = {
  readonly id: string;
  readonly workspace: WorkspaceInfo;
  readonly createdAt: string;
  readonly containerId: string | null;
  readonly output: string;
  readonly status: "running" | "stopped" | "failed";
  readonly updatedAt: string;
};

const DEVCONTAINER_SESSIONS = new Map<string, DevcontainerSession>();
const SAFE_BRANCH_PATTERN = /^[A-Za-z0-9._/-]+$/;
const DEVCONTAINER_JSON_ID_PATTERN = /"containerId"\s*:\s*"([^"]+)"/;
const DEVCONTAINER_TEXT_ID_PATTERN = /Container ID:\s*([A-Za-z0-9_-]+)/i;
const TRAILING_DOT_GIT_PATTERN = /\.git$/i;
const TRAILING_SLASH_PATTERN = /\/+$/;

type WorkspaceBootstrap = {
  readonly repoUrl: string;
  readonly projectName?: string;
  readonly projectRoot?: string;
};

type WorkspaceSeed = {
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly projectName: string;
  readonly projectId: string;
};

type NodeRoute =
  | { readonly kind: "status" }
  | { readonly kind: "workspaces_ensure" }
  | { readonly kind: "devcontainers_up" }
  | { readonly kind: "devcontainers_down" }
  | { readonly kind: "devcontainers_get"; readonly id: string };

type WorkspaceLookupResult =
  | { readonly kind: "resolved"; readonly workspace: WorkspaceSeed }
  | {
      readonly kind: "error";
      readonly error: string;
      readonly statusCode: number;
    }
  | { readonly kind: "skip" };

export async function handleNodeRoutes(opts: {
  readonly req: Request;
  readonly url: URL;
  readonly version: string;
  readonly pid: number;
  readonly startedAtMs: number;
}): Promise<Response | null> {
  const segments = opts.url.pathname.split("/").filter(Boolean);
  if (segments[0] !== "v1" || segments[1] !== "node") {
    return null;
  }
  const route = resolveNodeRoute({ segments });
  if (!route) {
    return jsonResponse({ error: "not_found" }, 404);
  }

  if (route.kind === "status") {
    if (opts.req.method !== "GET") {
      return jsonResponse({ error: "method_not_allowed" }, 405);
    }
    return await handleNodeStatus({
      version: opts.version,
      pid: opts.pid,
      startedAtMs: opts.startedAtMs,
    });
  }
  if (route.kind === "workspaces_ensure") {
    if (opts.req.method !== "POST") {
      return jsonResponse({ error: "method_not_allowed" }, 405);
    }
    return await handleWorkspaceEnsure({ req: opts.req });
  }
  if (route.kind === "devcontainers_up") {
    if (opts.req.method !== "POST") {
      return jsonResponse({ error: "method_not_allowed" }, 405);
    }
    return await handleDevcontainerUp({ req: opts.req });
  }
  if (route.kind === "devcontainers_down") {
    if (opts.req.method !== "POST") {
      return jsonResponse({ error: "method_not_allowed" }, 405);
    }
    return await handleDevcontainerDown({ req: opts.req });
  }
  if (opts.req.method !== "GET") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }
  const session = DEVCONTAINER_SESSIONS.get(route.id);
  if (!session) {
    return jsonResponse({ error: "not_found" }, 404);
  }
  return jsonResponse({ session });
}

function resolveNodeRoute(opts: {
  readonly segments: readonly string[];
}): NodeRoute | null {
  const segments = opts.segments;
  if (segments.length === 3 && segments[2] === "status") {
    return { kind: "status" };
  }
  if (
    segments.length === 4 &&
    segments[2] === "workspaces" &&
    segments[3] === "ensure"
  ) {
    return { kind: "workspaces_ensure" };
  }
  if (
    segments.length === 4 &&
    segments[2] === "devcontainers" &&
    segments[3] === "up"
  ) {
    return { kind: "devcontainers_up" };
  }
  if (
    segments.length === 4 &&
    segments[2] === "devcontainers" &&
    segments[3] === "down"
  ) {
    return { kind: "devcontainers_down" };
  }
  if (segments.length === 4 && segments[2] === "devcontainers" && segments[3]) {
    return { kind: "devcontainers_get", id: segments[3] };
  }
  return null;
}

async function handleNodeStatus(opts: {
  readonly version: string;
  readonly pid: number;
  readonly startedAtMs: number;
}): Promise<Response> {
  const [gateway, controlPlane] = await Promise.all([
    resolveGatewayConfig(),
    readControlPlaneConfig({}),
  ]);

  const runningDevcontainers = [...DEVCONTAINER_SESSIONS.values()].filter(
    (session) => session.status === "running"
  );

  return jsonResponse({
    status: "ok",
    version: opts.version,
    pid: opts.pid,
    started_at: new Date(opts.startedAtMs).toISOString(),
    uptime_ms: Date.now() - opts.startedAtMs,
    node: {
      name: hostname(),
      platform: process.platform,
      arch: process.arch,
      bun: Bun.version,
    },
    gateway: {
      enabled: gateway.config.enabled,
      bind: gateway.config.bind,
      port: gateway.config.port,
      allowWrites: gateway.config.allowWrites,
      projects: gateway.enabledProjects.map((project) => ({
        project_id: project.projectId,
        project_name: project.projectName,
      })),
    },
    supervisor: {
      enabled: controlPlane.config.supervisor.enabled,
      maxConcurrentJobs: controlPlane.config.supervisor.maxConcurrentJobs,
    },
    devcontainers: {
      running: runningDevcontainers.length,
      sessions: runningDevcontainers.map((session) => ({
        id: session.id,
        project_id: session.workspace.projectId,
        project_name: session.workspace.projectName,
        branch: session.workspace.branch,
        created_at: session.createdAt,
      })),
    },
  });
}

async function handleWorkspaceEnsure(opts: {
  readonly req: Request;
}): Promise<Response> {
  const body = await readJsonBody(opts.req);
  if (!body) {
    return jsonResponse({ error: "invalid_json" }, 400);
  }
  const ensured = await ensureWorkspaceFromInput({
    body,
  });
  if (!ensured.ok) {
    return jsonResponse({ error: ensured.error }, ensured.statusCode);
  }

  return jsonResponse({
    workspace: ensured.workspace,
  });
}

async function handleDevcontainerUp(opts: {
  readonly req: Request;
}): Promise<Response> {
  const body = await readJsonBody(opts.req);
  if (!body) {
    return jsonResponse({ error: "invalid_json" }, 400);
  }
  const ensured = await ensureWorkspaceFromInput({ body });
  if (!ensured.ok) {
    return jsonResponse({ error: ensured.error }, ensured.statusCode);
  }
  const workspace = ensured.workspace;

  const devcontainerBin = findExecutableInPath("devcontainer");
  if (!devcontainerBin) {
    return jsonResponse({ error: "missing_devcontainer_cli" }, 412);
  }

  const up = await exec(
    [devcontainerBin, "up", "--workspace-folder", workspace.projectRoot],
    {
      stdin: "ignore",
    }
  );
  const output = `${up.stdout}\n${up.stderr}`.trim();
  const containerId = resolveContainerId({ output });
  const session: DevcontainerSession = {
    id: randomUUID(),
    workspace,
    createdAt: new Date().toISOString(),
    containerId,
    output,
    status: up.exitCode === 0 ? "running" : "failed",
    updatedAt: new Date().toISOString(),
  };
  DEVCONTAINER_SESSIONS.set(session.id, session);
  if (up.exitCode !== 0) {
    return jsonResponse(
      {
        error: "devcontainer_up_failed",
        session,
      },
      500
    );
  }
  return jsonResponse({ session }, 201);
}

async function handleDevcontainerDown(opts: {
  readonly req: Request;
}): Promise<Response> {
  const body = await readJsonBody(opts.req);
  if (!body) {
    return jsonResponse({ error: "invalid_json" }, 400);
  }
  const id = getString(body.id);
  if (!id) {
    return jsonResponse({ error: "missing_id" }, 400);
  }
  const existing = DEVCONTAINER_SESSIONS.get(id);
  if (!existing) {
    return jsonResponse({ error: "not_found" }, 404);
  }
  if (existing.status !== "running") {
    return jsonResponse({ session: existing });
  }

  const devcontainerBin = findExecutableInPath("devcontainer");
  if (!devcontainerBin) {
    return jsonResponse({ error: "missing_devcontainer_cli" }, 412);
  }

  const down = await exec(
    [
      devcontainerBin,
      "down",
      "--workspace-folder",
      existing.workspace.projectRoot,
    ],
    {
      stdin: "ignore",
    }
  );
  const next: DevcontainerSession = {
    ...existing,
    status: down.exitCode === 0 ? "stopped" : "failed",
    output: `${existing.output}\n${down.stdout}\n${down.stderr}`.trim(),
    updatedAt: new Date().toISOString(),
  };
  DEVCONTAINER_SESSIONS.set(id, next);
  if (down.exitCode !== 0) {
    return jsonResponse(
      {
        error: "devcontainer_down_failed",
        session: next,
      },
      500
    );
  }
  return jsonResponse({ session: next });
}

async function ensureWorkspaceFromInput(opts: {
  readonly body: Record<string, unknown>;
}): Promise<
  | { readonly ok: true; readonly workspace: WorkspaceInfo }
  | { readonly ok: false; readonly error: string; readonly statusCode: number }
> {
  const projectName = getString(opts.body.project);
  const projectId = getString(opts.body.project_id);
  const path = getString(opts.body.path);
  const branch = getString(opts.body.branch);
  const bootstrap = parseWorkspaceBootstrap(opts.body.bootstrap);

  let workspace: WorkspaceSeed | null = null;
  const resolvers = [
    () => resolveWorkspaceByProjectId({ projectId }),
    () => resolveWorkspaceByProjectName({ projectName, bootstrap }),
    () => resolveWorkspaceByPath({ path }),
    () =>
      resolveWorkspaceByBootstrap({
        bootstrap,
        requestedProjectName: projectName ?? undefined,
        requestedPath: path ?? undefined,
      }),
  ] as const;

  for (const resolver of resolvers) {
    const result = await resolver();
    if (result.kind === "resolved") {
      workspace = result.workspace;
      break;
    }
    if (result.kind === "error") {
      return { ok: false, error: result.error, statusCode: result.statusCode };
    }
  }

  if (!workspace) {
    return {
      ok: false,
      error: "missing_project_selector (project | project_id | path)",
      statusCode: 400,
    };
  }

  const ensuredBranch = branch
    ? await ensureBranch({
        projectRoot: workspace.projectRoot,
        branch,
      })
    : await resolveCurrentBranch({ projectRoot: workspace.projectRoot });

  if (!ensuredBranch.ok) {
    return { ok: false, error: ensuredBranch.error, statusCode: 400 };
  }

  return {
    ok: true,
    workspace: {
      projectId: workspace.projectId,
      projectName: workspace.projectName,
      projectRoot: workspace.projectRoot,
      projectDir: workspace.projectDir,
      branch: ensuredBranch.branch,
    },
  };
}

async function resolveWorkspaceByProjectId(opts: {
  readonly projectId: string | null;
}): Promise<WorkspaceLookupResult> {
  if (!opts.projectId) {
    return { kind: "skip" };
  }
  const byId = await resolveRegisteredProjectById({ id: opts.projectId });
  if (!byId) {
    return { kind: "error", error: "unknown_project_id", statusCode: 404 };
  }
  return {
    kind: "resolved",
    workspace: {
      projectRoot: byId.project.projectRoot,
      projectDir: byId.project.projectDir,
      projectName: byId.registration.name,
      projectId: byId.registration.id,
    },
  };
}

async function resolveWorkspaceByProjectName(opts: {
  readonly projectName: string | null;
  readonly bootstrap: WorkspaceBootstrap | null;
}): Promise<WorkspaceLookupResult> {
  if (!opts.projectName) {
    return { kind: "skip" };
  }
  const byName = await resolveRegisteredProjectByName({
    name: opts.projectName,
  });
  if (!byName) {
    return opts.bootstrap
      ? { kind: "skip" }
      : { kind: "error", error: "unknown_project_name", statusCode: 404 };
  }
  const registered = await upsertProjectRegistration({ project: byName });
  if (registered.status === "conflict") {
    return { kind: "error", error: "project_name_conflict", statusCode: 409 };
  }
  return {
    kind: "resolved",
    workspace: {
      projectRoot: byName.projectRoot,
      projectDir: byName.projectDir,
      projectName: registered.project.name,
      projectId: registered.project.id,
    },
  };
}

async function resolveWorkspaceByPath(opts: {
  readonly path: string | null;
}): Promise<WorkspaceLookupResult> {
  if (!opts.path) {
    return { kind: "skip" };
  }
  const absolute = resolve(opts.path);
  const project = await findProjectContext(absolute);
  if (!project) {
    return { kind: "error", error: "path_not_a_project", statusCode: 404 };
  }
  const registered = await upsertProjectRegistration({ project });
  if (registered.status === "conflict") {
    return { kind: "error", error: "project_name_conflict", statusCode: 409 };
  }
  const config = await readProjectConfig(project);
  return {
    kind: "resolved",
    workspace: {
      projectRoot: project.projectRoot,
      projectDir: project.projectDir,
      projectName: config.name ?? registered.project.name,
      projectId: registered.project.id,
    },
  };
}

async function resolveWorkspaceByBootstrap(opts: {
  readonly bootstrap: WorkspaceBootstrap | null;
  readonly requestedProjectName?: string;
  readonly requestedPath?: string;
}): Promise<WorkspaceLookupResult> {
  if (!opts.bootstrap) {
    return { kind: "skip" };
  }
  const bootstrapped = await bootstrapWorkspace({
    bootstrap: opts.bootstrap,
    requestedProjectName: opts.requestedProjectName,
    requestedPath: opts.requestedPath,
  });
  if (!bootstrapped.ok) {
    return {
      kind: "error",
      error: bootstrapped.error,
      statusCode: bootstrapped.statusCode,
    };
  }
  return { kind: "resolved", workspace: bootstrapped.workspace };
}

/**
 * Parse optional workspace bootstrap payload for fresh nodes.
 */
function parseWorkspaceBootstrap(value: unknown): WorkspaceBootstrap | null {
  if (!isRecord(value)) {
    return null;
  }
  const repoUrl = getString(value.repo_url);
  if (!repoUrl) {
    return null;
  }
  const projectName = getString(value.project_name);
  const projectRoot = getString(value.project_root);
  return {
    repoUrl,
    ...(projectName ? { projectName } : {}),
    ...(projectRoot ? { projectRoot } : {}),
  };
}

/**
 * Clone/register a project workspace when it is not already present on the node.
 */
async function bootstrapWorkspace(opts: {
  readonly bootstrap: WorkspaceBootstrap;
  readonly requestedProjectName?: string;
  readonly requestedPath?: string;
}): Promise<
  | {
      readonly ok: true;
      readonly workspace: {
        readonly projectRoot: string;
        readonly projectDir: string;
        readonly projectName: string;
        readonly projectId: string;
      };
    }
  | { readonly ok: false; readonly error: string; readonly statusCode: number }
> {
  const repoUrl = normalizeRepoUrl(opts.bootstrap.repoUrl);
  if (!repoUrl) {
    return {
      ok: false,
      error: "invalid_bootstrap_repo_url",
      statusCode: 400,
    };
  }

  const targetRoot = resolveBootstrapRoot({
    requestedPath: opts.requestedPath,
    projectRoot: opts.bootstrap.projectRoot,
    requestedProjectName: opts.requestedProjectName,
    bootstrapProjectName: opts.bootstrap.projectName,
    repoUrl,
  });

  const gitDir = resolve(targetRoot, ".git");
  const rootExists = await pathExists(targetRoot);
  if (!rootExists) {
    await ensureDir(dirname(targetRoot));
    const clone = await exec(["git", "clone", repoUrl, targetRoot], {
      stdin: "ignore",
    });
    if (clone.exitCode !== 0) {
      return {
        ok: false,
        error: `bootstrap_clone_failed: ${normalizeCommandError(clone.stderr, clone.stdout)}`,
        statusCode: 500,
      };
    }
  } else if (await pathExists(gitDir)) {
    const origin = await exec(
      ["git", "-C", targetRoot, "remote", "get-url", "origin"],
      { stdin: "ignore" }
    );
    if (origin.exitCode === 0) {
      const existingOrigin = normalizeRepoUrl(origin.stdout);
      if (existingOrigin && existingOrigin !== repoUrl) {
        return {
          ok: false,
          error: "bootstrap_origin_mismatch",
          statusCode: 409,
        };
      }
    }
  } else {
    return {
      ok: false,
      error: "bootstrap_target_exists_not_git_repo",
      statusCode: 409,
    };
  }

  const project = await findProjectContext(targetRoot);
  if (!project) {
    return {
      ok: false,
      error: "bootstrap_path_not_hack_project",
      statusCode: 412,
    };
  }

  const registered = await upsertProjectRegistration({ project });
  if (registered.status === "conflict") {
    return {
      ok: false,
      error: "project_name_conflict",
      statusCode: 409,
    };
  }
  const config = await readProjectConfig(project);
  const preferredName =
    opts.requestedProjectName ?? opts.bootstrap.projectName ?? undefined;

  return {
    ok: true,
    workspace: {
      projectRoot: project.projectRoot,
      projectDir: project.projectDir,
      projectName: preferredName ?? config.name ?? registered.project.name,
      projectId: registered.project.id,
    },
  };
}

function normalizeRepoUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(TRAILING_SLASH_PATTERN, "");
}

function resolveBootstrapRoot(input: {
  readonly requestedPath?: string;
  readonly projectRoot?: string;
  readonly requestedProjectName?: string;
  readonly bootstrapProjectName?: string;
  readonly repoUrl: string;
}): string {
  if (input.requestedPath) {
    return resolve(input.requestedPath);
  }
  if (input.projectRoot) {
    return resolve(input.projectRoot);
  }

  const seed =
    input.requestedProjectName ??
    input.bootstrapProjectName ??
    deriveRepoName(input.repoUrl);
  const slug = sanitizeProjectSlug(seed);
  return resolve(resolveUserHomeDir(), "dev", "hack-nodes", slug);
}

function deriveRepoName(repoUrl: string): string {
  const trimmed = repoUrl
    .replace(TRAILING_DOT_GIT_PATTERN, "")
    .replace(TRAILING_SLASH_PATTERN, "");
  const parts = trimmed.split("/");
  const tail = parts.at(-1)?.trim();
  return tail && tail.length > 0 ? tail : "workspace";
}

function normalizeCommandError(stderr: string, stdout: string): string {
  const err = stderr.trim();
  if (err) {
    return err;
  }
  const out = stdout.trim();
  return out || "command_failed";
}

function resolveUserHomeDir(): string {
  const envHome = (process.env.HOME ?? "").trim();
  return envHome || homedir();
}

async function ensureBranch(opts: {
  readonly projectRoot: string;
  readonly branch: string;
}): Promise<
  | { readonly ok: true; readonly branch: string }
  | { readonly ok: false; readonly error: string }
> {
  const branch = opts.branch.trim();
  if (!(branch && SAFE_BRANCH_PATTERN.test(branch))) {
    return { ok: false, error: "invalid_branch" };
  }

  const current = await resolveCurrentBranch({ projectRoot: opts.projectRoot });
  if (current.ok && current.branch === branch) {
    return { ok: true, branch };
  }

  const localExists = await exec(
    [
      "git",
      "-C",
      opts.projectRoot,
      "show-ref",
      "--verify",
      `refs/heads/${branch}`,
    ],
    { stdin: "ignore" }
  );

  if (localExists.exitCode === 0) {
    const checkout = await exec(
      ["git", "-C", opts.projectRoot, "checkout", branch],
      {
        stdin: "ignore",
      }
    );
    if (checkout.exitCode !== 0) {
      return { ok: false, error: `checkout_failed: ${checkout.stderr.trim()}` };
    }
    return { ok: true, branch };
  }

  await exec(["git", "-C", opts.projectRoot, "fetch", "origin", branch], {
    stdin: "ignore",
  });
  const track = await exec(
    [
      "git",
      "-C",
      opts.projectRoot,
      "checkout",
      "-B",
      branch,
      "--track",
      `origin/${branch}`,
    ],
    { stdin: "ignore" }
  );
  if (track.exitCode !== 0) {
    const create = await exec(
      ["git", "-C", opts.projectRoot, "checkout", "-b", branch],
      { stdin: "ignore" }
    );
    if (create.exitCode !== 0) {
      return { ok: false, error: `checkout_failed: ${create.stderr.trim()}` };
    }
  }
  return { ok: true, branch };
}

async function resolveCurrentBranch(opts: {
  readonly projectRoot: string;
}): Promise<
  | { readonly ok: true; readonly branch: string | null }
  | { readonly ok: false; readonly error: string }
> {
  const res = await exec(
    ["git", "-C", opts.projectRoot, "rev-parse", "--abbrev-ref", "HEAD"],
    { stdin: "ignore" }
  );
  if (res.exitCode !== 0) {
    return { ok: false, error: `git_rev_parse_failed: ${res.stderr.trim()}` };
  }
  const branch = res.stdout.trim();
  return {
    ok: true,
    branch: branch.length > 0 && branch !== "HEAD" ? branch : null,
  };
}

function resolveContainerId(opts: { readonly output: string }): string | null {
  const patterns = [
    DEVCONTAINER_JSON_ID_PATTERN,
    DEVCONTAINER_TEXT_ID_PATTERN,
  ] as const;
  for (const pattern of patterns) {
    const match = opts.output.match(pattern);
    const value = match?.[1]?.trim();
    if (value) {
      return value;
    }
  }
  return null;
}

async function readJsonBody(
  req: Request
): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await req.json();
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
