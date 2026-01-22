import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveGatewayConfig } from "../src/control-plane/extensions/gateway/config.ts";
import {
  createGatewayToken,
  revokeGatewayToken,
} from "../src/control-plane/extensions/gateway/tokens.ts";
import { resolveDaemonPaths } from "../src/daemon/paths.ts";
import { readDaemonStatus } from "../src/daemon/status.ts";
import { resolveGlobalConfigPath } from "../src/lib/config-paths.ts";
import { isRecord } from "../src/lib/guards.ts";
import { resolveHackInvocation } from "../src/lib/hack-cli.ts";
import { findProjectContext } from "../src/lib/project.ts";
import { upsertProjectRegistration } from "../src/lib/projects-registry.ts";
import { shouldRunNetwork } from "./helpers/ci.ts";

const shouldRun = process.env.HACK_GATEWAY_E2E === "1" && shouldRunNetwork;
const runTest = shouldRun ? test : test.skip;

interface GatewayE2eContext {
  readonly baseUrl: string;
  readonly rootDir: string;
  readonly token: string;
  readonly tokenId: string;
  readonly projectId: string;
  readonly writeToken?: string;
  readonly writeTokenId?: string;
}

interface PreferredProject {
  readonly projectId: string;
  readonly name: string;
  readonly projectRoot: string;
}

let gatewayContext: GatewayE2eContext | null = null;
let gatewayConfigRestore: {
  readonly path: string;
  readonly existed: boolean;
  readonly text: string | null;
} | null = null;

beforeAll(async () => {
  if (!shouldRun) {
    return;
  }
  gatewayContext = await prepareGatewayContext({
    requireWrite: shouldRunWrite,
  });
});

afterAll(async () => {
  if (gatewayConfigRestore) {
    await restoreGatewayConfig({ restore: gatewayConfigRestore });
    gatewayConfigRestore = null;
    await restartHackDaemon();
  }
  if (gatewayContext) {
    await revokeGatewayToken({
      rootDir: gatewayContext.rootDir,
      tokenId: gatewayContext.tokenId,
    });
    if (gatewayContext.writeTokenId) {
      await revokeGatewayToken({
        rootDir: gatewayContext.rootDir,
        tokenId: gatewayContext.writeTokenId,
      });
    }
  }
});

runTest("gateway status responds", async () => {
  const ctx = requireContext();
  const res = await fetch(new URL("/v1/status", ctx.baseUrl), {
    headers: buildAuthHeaders({ token: ctx.token }),
  });
  expect(res.status).toBe(200);
  const json = (await res.json()) as Record<string, unknown>;
  expect(json.status).toBe("ok");
});

const shouldRunWrite = shouldRun && process.env.HACK_GATEWAY_E2E_WRITE === "1";
const runWriteTest = shouldRunWrite ? test : test.skip;

runWriteTest("gateway job create + stream", async () => {
  const ctx = requireContext();
  if (!ctx.writeToken) {
    throw new Error("Missing write token for gateway e2e");
  }
  const job = await createJobWithRetry({
    baseUrl: ctx.baseUrl,
    token: ctx.writeToken,
    projectId: ctx.projectId,
    command: "echo gateway e2e",
    retries: 1,
  });
  expect(job).not.toBeNull();
  if (!job) {
    return;
  }

  const outcome = await streamJobUntilExit({
    baseUrl: ctx.baseUrl,
    token: ctx.writeToken,
    projectId: ctx.projectId,
    jobId: job.jobId,
    timeoutMs: 30_000,
  });
  expect(outcome).toBe("completed");
});

interface JobCreateResponse {
  readonly jobId: string;
}

type JobCreateResult =
  | { readonly ok: true; readonly job: JobCreateResponse }
  | {
      readonly ok: false;
      readonly status: number;
      readonly error?: string;
      readonly body?: string;
    };

function requireContext(): GatewayE2eContext {
  if (!gatewayContext) {
    throw new Error(
      "Gateway e2e context not initialized (missing HACK_GATEWAY_E2E=1?)"
    );
  }
  return gatewayContext;
}

function buildAuthHeaders(opts: {
  readonly token: string;
}): Record<string, string> {
  return { Authorization: `Bearer ${opts.token}` };
}

async function prepareGatewayContext(opts: {
  readonly requireWrite: boolean;
}): Promise<GatewayE2eContext> {
  const preferredProject = await resolvePreferredProject();

  if (preferredProject) {
    await runGatewayEnable({ projectRoot: preferredProject.projectRoot });
  }

  let gatewayResolution = await resolveGatewayConfig();

  if (!gatewayResolution.config.enabled) {
    throw new Error(
      "Gateway is not enabled (run: hack gateway enable in a project)"
    );
  }

  if (preferredProject) {
    const enabled = gatewayResolution.enabledProjects.some(
      (project) => project.projectId === preferredProject.projectId
    );
    if (!enabled) {
      throw new Error(
        `Project ${preferredProject.name} is not gateway-enabled. Run 'hack gateway enable' in that project.`
      );
    }
  }

  await ensureHackDaemonRunning();

  const baseUrl = buildGatewayUrl({
    bind: gatewayResolution.config.bind,
    port: gatewayResolution.config.port,
  });

  const daemonPaths = resolveDaemonPaths({});
  let readToken: Awaited<ReturnType<typeof createGatewayToken>> | null = null;
  let writeToken: Awaited<ReturnType<typeof createGatewayToken>> | null = null;

  try {
    readToken = await createGatewayToken({
      rootDir: daemonPaths.root,
      label: "gateway-e2e",
      scope: "read",
    });

    await waitForGatewayReady({ baseUrl, token: readToken.token });

    const projectId =
      preferredProject?.projectId ??
      gatewayResolution.enabledProjects[0]?.projectId ??
      (await resolveProjectIdViaGateway({ baseUrl, token: readToken.token }));

    if (!projectId) {
      throw new Error(
        "Gateway enabled but project id is missing (run: hack projects --details)"
      );
    }

    if (opts.requireWrite && !gatewayResolution.config.allowWrites) {
      gatewayConfigRestore = await enableGatewayWritesForTest();
      await restartHackDaemon();
      gatewayResolution = await resolveGatewayConfig();
    }

    if (opts.requireWrite) {
      if (!gatewayResolution.config.allowWrites) {
        throw new Error(
          "Gateway writes disabled (run: hack config set --global 'controlPlane.gateway.allowWrites' true)"
        );
      }
      writeToken = await createGatewayToken({
        rootDir: daemonPaths.root,
        label: "gateway-e2e-write",
        scope: "write",
      });
    }

    return {
      baseUrl,
      rootDir: daemonPaths.root,
      token: readToken.token,
      tokenId: readToken.record.id,
      projectId,
      ...(writeToken
        ? { writeToken: writeToken.token, writeTokenId: writeToken.record.id }
        : {}),
    };
  } catch (error) {
    if (readToken) {
      await revokeGatewayToken({
        rootDir: daemonPaths.root,
        tokenId: readToken.record.id,
      });
    }
    if (writeToken) {
      await revokeGatewayToken({
        rootDir: daemonPaths.root,
        tokenId: writeToken.record.id,
      });
    }
    throw error;
  }
}

function buildGatewayUrl(opts: {
  readonly bind: string;
  readonly port: number;
}): string {
  const trimmed = opts.bind.trim();
  const host =
    trimmed === "" || trimmed === "0.0.0.0" || trimmed === "::"
      ? "127.0.0.1"
      : trimmed;
  const formatted = host.includes(":") ? `[${host}]` : host;
  return `http://${formatted}:${opts.port}`;
}

async function resolveProjectIdViaGateway(opts: {
  readonly baseUrl: string;
  readonly token: string;
}): Promise<string | null> {
  const res = await fetch(new URL("/v1/projects", opts.baseUrl), {
    headers: buildAuthHeaders({ token: opts.token }),
  });
  if (!res.ok) {
    return null;
  }
  const json = (await res.json()) as Record<string, unknown>;
  const projects = json.projects;
  if (!Array.isArray(projects) || projects.length === 0) {
    return null;
  }
  for (const project of projects) {
    if (!project || typeof project !== "object") {
      continue;
    }
    const id = (project as Record<string, unknown>).project_id;
    if (typeof id === "string" && id.length > 0) {
      return id;
    }
  }
  return null;
}

async function enableGatewayWritesForTest(): Promise<{
  readonly path: string;
  readonly existed: boolean;
  readonly text: string | null;
}> {
  const path = resolveGlobalConfigPath();
  let existingText: string | null = null;
  let existed = true;

  try {
    existingText = await readFile(path, "utf8");
  } catch {
    existed = false;
  }

  const trimmedExisting = existingText?.trim() ?? "";
  const parsed =
    trimmedExisting.length > 0
      ? safeJsonParse({ text: existingText ?? "" })
      : {};
  if (trimmedExisting.length > 0 && parsed === null) {
    throw new Error(
      `Global config parse error (${path}). Fix JSON or set allowWrites manually.`
    );
  }

  const root = parsed && isRecord(parsed) ? { ...parsed } : {};
  const controlPlane = isRecord(root.controlPlane)
    ? { ...root.controlPlane }
    : {};
  const gateway = isRecord(controlPlane.gateway)
    ? { ...controlPlane.gateway }
    : {};
  gateway.allowWrites = true;
  controlPlane.gateway = gateway;
  root.controlPlane = controlPlane;

  const nextText = `${JSON.stringify(root, null, 2)}\n`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, nextText);

  return { path, existed, text: existingText };
}

async function restoreGatewayConfig(opts: {
  readonly restore: {
    readonly path: string;
    readonly existed: boolean;
    readonly text: string | null;
  };
}): Promise<void> {
  if (opts.restore.existed) {
    await writeFile(opts.restore.path, opts.restore.text ?? "");
  } else {
    await rm(opts.restore.path, { force: true });
  }
}

async function createJob(opts: {
  readonly baseUrl: string;
  readonly token: string;
  readonly projectId: string;
  readonly command: string;
}): Promise<JobCreateResult> {
  const url = new URL(
    `/control-plane/projects/${opts.projectId}/jobs`,
    opts.baseUrl
  );
  const payload = {
    runner: "generic",
    command: ["bash", "-lc", opts.command],
  };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...buildAuthHeaders({ token: opts.token }),
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text();
    const error = safeJsonParse({ text: body })?.error;
    return {
      ok: false,
      status: res.status,
      ...(typeof error === "string" ? { error } : {}),
      body,
    };
  }

  const parsed = (await res.json()) as Record<string, unknown>;
  const job = parsed.job;
  if (!job || typeof job !== "object") {
    return { ok: false, status: res.status, body: JSON.stringify(parsed) };
  }
  const jobId = (job as Record<string, unknown>).jobId;
  if (typeof jobId !== "string") {
    return { ok: false, status: res.status, body: JSON.stringify(parsed) };
  }
  return { ok: true, job: { jobId } };
}

async function createJobWithRetry(opts: {
  readonly baseUrl: string;
  readonly token: string;
  readonly projectId: string;
  readonly command: string;
  readonly retries: number;
}): Promise<JobCreateResponse | null> {
  const result = await createJob(opts);
  if (result.ok) {
    return result.job;
  }

  if (result.error === "writes_disabled" && opts.retries > 0) {
    await restartHackDaemon();
    return await createJobWithRetry({ ...opts, retries: opts.retries - 1 });
  }

  const message = result.body
    ? `Job create failed (${result.status}): ${result.body}`
    : `Job create failed (${result.status})`;
  throw new Error(message);
}

async function streamJobUntilExit(opts: {
  readonly baseUrl: string;
  readonly token: string;
  readonly projectId: string;
  readonly jobId: string;
  readonly timeoutMs: number;
}): Promise<"completed" | "failed" | "unknown"> {
  const wsUrl = toWebSocketUrl({
    baseUrl: opts.baseUrl,
    path: `/control-plane/projects/${opts.projectId}/jobs/${opts.jobId}/stream`,
    token: opts.token,
  });

  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      ws.close(1000, "timeout");
      resolve("unknown");
    }, opts.timeoutMs);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "hello", logsFrom: 0, eventsFrom: 0 }));
    });

    ws.addEventListener("message", (event) => {
      const data =
        typeof event.data === "string"
          ? event.data
          : event.data instanceof ArrayBuffer
            ? new TextDecoder().decode(new Uint8Array(event.data))
            : event.data.toString();
      const parsed = safeJsonParse({ text: data });
      if (!parsed) {
        return;
      }
      if (parsed.type !== "event") {
        return;
      }
      const eventPayload = parsed.event;
      const eventType =
        typeof eventPayload === "object" && eventPayload
          ? (eventPayload as Record<string, unknown>).type
          : undefined;
      if (eventType === "job.completed") {
        clearTimeout(timer);
        ws.close(1000, "completed");
        resolve("completed");
      } else if (eventType === "job.failed") {
        clearTimeout(timer);
        ws.close(1000, "failed");
        resolve("failed");
      }
    });

    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("WebSocket error"));
    });

    ws.addEventListener("close", () => {
      clearTimeout(timer);
    });
  });
}

function toWebSocketUrl(opts: {
  readonly baseUrl: string;
  readonly path: string;
  readonly token?: string;
}): string {
  const url = new URL(opts.path, opts.baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (opts.token) {
    url.searchParams.set("token", opts.token);
  }
  return url.toString();
}

function safeJsonParse(opts: {
  readonly text: string;
}): Record<string, unknown> | null {
  const trimmed = opts.text.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function restartHackDaemon(): Promise<void> {
  const invocation = await resolveHackInvocation();
  const stopProc = Bun.spawn(
    [invocation.bin, ...invocation.args, "daemon", "stop"],
    {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }
  );
  await stopProc.exited;

  const startProc = Bun.spawn(
    [invocation.bin, ...invocation.args, "daemon", "start"],
    {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }
  );
  await startProc.exited;

  await waitForGatewayReady();
}

async function runGatewayEnable(opts: {
  readonly projectRoot: string;
}): Promise<void> {
  const invocation = await resolveHackInvocation();
  const enableProc = Bun.spawn(
    [
      invocation.bin,
      ...invocation.args,
      "gateway",
      "enable",
      "--path",
      opts.projectRoot,
    ],
    {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }
  );
  const exitCode = await enableProc.exited;
  if (exitCode !== 0) {
    throw new Error(`Failed to enable gateway for ${opts.projectRoot}`);
  }
}

async function waitForGatewayReady(opts?: {
  readonly baseUrl?: string;
  readonly token?: string;
}): Promise<void> {
  const baseUrl = opts?.baseUrl ?? gatewayContext?.baseUrl;
  const token = opts?.token ?? gatewayContext?.token;
  if (!(baseUrl && token)) {
    return;
  }

  const maxAttempts = 10;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const res = await fetch(new URL("/v1/status", baseUrl), {
        headers: buildAuthHeaders({ token }),
      });
      if (res.ok) {
        return;
      }
    } catch {
      // ignore and retry
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Gateway did not become ready after restart");
}

async function resolvePreferredProject(): Promise<PreferredProject | null> {
  const project = await findProjectContext(process.cwd());
  if (!project) {
    return null;
  }
  const outcome = await upsertProjectRegistration({ project });
  if (outcome.status === "conflict") {
    return null;
  }
  return {
    projectId: outcome.project.id,
    name: outcome.project.name,
    projectRoot: project.projectRoot,
  };
}

async function ensureHackDaemonRunning(): Promise<void> {
  const daemonPaths = resolveDaemonPaths({});
  const daemonStatus = await readDaemonStatus({ paths: daemonPaths });
  if (!daemonStatus.running) {
    await startHackDaemon();
  }
}

async function startHackDaemon(): Promise<void> {
  const invocation = await resolveHackInvocation();
  const startProc = Bun.spawn(
    [invocation.bin, ...invocation.args, "daemon", "start"],
    {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }
  );
  await startProc.exited;

  const daemonPaths = resolveDaemonPaths({});
  const daemonStatus = await readDaemonStatus({ paths: daemonPaths });
  if (!daemonStatus.running) {
    throw new Error("hackd is not running (run: hack daemon start)");
  }
}
