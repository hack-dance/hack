import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { YAML } from "bun";
import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
  PROJECT_ENV_FILENAME,
} from "../constants.ts";
import { readControlPlaneConfig } from "../control-plane/sdk/config.ts";
import { pathExists, readTextFile } from "./fs.ts";
import { isRecord } from "./guards.ts";
import {
  type ProjectLifecycleCommand,
  type ProjectLifecycleProcess,
  readProjectConfig,
} from "./project.ts";
import type { RegisteredProject } from "./projects-registry.ts";
import {
  countRunningServices,
  type RuntimeProject,
  serializeRuntimeProject,
} from "./runtime-projects.ts";
import { exec } from "./shell.ts";

export type BranchRuntime = {
  readonly branch: string;
  readonly runtime: RuntimeProject;
};

export type MuxSession = {
  readonly name: string;
  readonly backend: "tmux" | "zellij";
  readonly attached: boolean;
  readonly path: string | null;
  readonly windows: number | null;
  readonly createdAt: number | null;
};

export type ProjectSession = {
  readonly name: string;
  readonly backend: "tmux" | "zellij";
  readonly source: "hack" | "external";
  readonly attached: boolean;
  readonly path: string | null;
  readonly windows: number | null;
  readonly createdAt: number | null;
};

export type ProjectLifecycleCommandView = {
  readonly name: string | null;
  readonly command: string;
  readonly cwd: string | null;
  readonly service: string;
};

export type ProjectLifecycleProcessView = {
  readonly name: string;
  readonly command: string;
  readonly cwd: string | null;
  readonly service: string;
};

export type ProjectLifecycleView = {
  readonly upBefore: readonly ProjectLifecycleCommandView[];
  readonly upAfter: readonly ProjectLifecycleCommandView[];
  readonly downBefore: readonly ProjectLifecycleCommandView[];
  readonly downAfter: readonly ProjectLifecycleCommandView[];
  readonly processes: readonly ProjectLifecycleProcessView[];
};

export type ProjectView = {
  readonly projectId?: string;
  readonly name: string;
  readonly devHost: string | null;
  readonly repoRoot: string | null;
  readonly projectDir: string | null;
  readonly definedServices: readonly string[] | null;
  readonly extensionsEnabled: readonly string[] | null;
  readonly features: readonly string[] | null;
  readonly serviceHosts: Readonly<Record<string, readonly string[]>> | null;
  readonly runtimeConfigured: boolean | null;
  readonly runtimeStatus: ProjectRuntimeStatus;
  readonly runtime: RuntimeProject | null;
  readonly branchRuntime: readonly BranchRuntime[];
  readonly sessions: readonly ProjectSession[];
  readonly lifecycle: ProjectLifecycleView | null;
  readonly kind: "registered" | "unregistered";
  readonly status:
    | "running"
    | "stopped"
    | "missing"
    | "unregistered"
    | "unknown";
};

export type ProjectRuntimeStatus =
  | "running"
  | "stopped"
  | "missing"
  | "unknown"
  | "not_configured";

type BuildProjectViewsOptions = {
  readonly registryProjects: readonly RegisteredProject[];
  readonly runtime: readonly RuntimeProject[];
  readonly runtimeOk: boolean;
  readonly filter: string | null;
  readonly includeUnregistered: boolean;
  readonly muxSessions?: readonly MuxSession[];
};

export async function buildProjectViews(
  opts: BuildProjectViewsOptions
): Promise<ProjectView[]> {
  const byName = new Map(
    opts.registryProjects.map((p) => [p.name, p] as const)
  );
  const runtimeByName = new Map(
    opts.runtime.map((p) => [p.project, p] as const)
  );

  const names = new Set<string>();
  for (const p of opts.registryProjects) {
    names.add(p.name);
  }
  if (opts.includeUnregistered) {
    for (const p of opts.runtime) {
      names.add(p.project);
    }
  }
  const muxSessions = opts.muxSessions ?? (await listMuxSessions());

  const out: ProjectView[] = [];
  for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
    if (opts.filter && name !== opts.filter) {
      continue;
    }

    const reg = byName.get(name) ?? null;
    const runtime = runtimeByName.get(name) ?? null;

    if (reg) {
      out.push(
        await buildRegisteredProjectView({
          name,
          registration: reg,
          runtime,
          allRuntime: opts.runtime,
          runtimeOk: opts.runtimeOk,
          muxSessions,
        })
      );
      continue;
    }

    if (opts.includeUnregistered) {
      out.push(
        buildUnregisteredProjectView({
          name,
          runtime,
          runtimeOk: opts.runtimeOk,
        })
      );
    }
  }

  return out;
}

async function buildRegisteredProjectView(opts: {
  readonly name: string;
  readonly registration: RegisteredProject;
  readonly runtime: RuntimeProject | null;
  readonly allRuntime: readonly RuntimeProject[];
  readonly runtimeOk: boolean;
  readonly muxSessions: readonly MuxSession[];
}): Promise<ProjectView> {
  const projectDirOk = await pathExists(opts.registration.projectDir);
  const composeFile = resolve(
    opts.registration.projectDir,
    PROJECT_COMPOSE_FILENAME
  );
  const composeExists = projectDirOk && (await pathExists(composeFile));
  const definedServices = composeExists
    ? await readComposeServices({ composeFile })
    : null;
  const serviceHosts = composeExists
    ? await readComposeServiceHosts({ composeFile })
    : null;
  const running = countRunningServices(opts.runtime);
  const runtimeConfigured = composeExists;
  const runtimeStatus: ProjectRuntimeStatus = resolveRuntimeStatus({
    projectDirOk,
    composeExists,
    runtimeOk: opts.runtimeOk,
    running,
  });
  const status: ProjectView["status"] = resolveProjectStatus({
    projectDirOk,
    runtimeOk: opts.runtimeOk,
    running,
  });
  const branchRuntime = collectBranchRuntime({
    baseName: opts.name,
    runtimeProjects: opts.allRuntime,
  });
  const sessions = collectProjectSessions({
    projectName: opts.name,
    repoRoot: opts.registration.repoRoot,
    muxSessions: opts.muxSessions,
  });
  const extensions = projectDirOk
    ? await resolveProjectExtensions({
        projectDir: opts.registration.projectDir,
      })
    : null;
  const lifecycle = projectDirOk
    ? await resolveProjectLifecycleView({
        registration: opts.registration,
      })
    : null;

  return {
    projectId: opts.registration.id,
    name: opts.name,
    devHost: opts.registration.devHost ?? null,
    repoRoot: opts.registration.repoRoot,
    projectDir: opts.registration.projectDir,
    definedServices,
    extensionsEnabled: extensions?.enabled ?? null,
    features: extensions?.features ?? null,
    serviceHosts,
    runtimeConfigured,
    runtimeStatus,
    runtime: opts.runtime,
    branchRuntime,
    sessions,
    lifecycle,
    kind: "registered",
    status,
  };
}

function buildUnregisteredProjectView(opts: {
  readonly name: string;
  readonly runtime: RuntimeProject | null;
  readonly runtimeOk: boolean;
}): ProjectView {
  const running = countRunningServices(opts.runtime);
  const runtimeStatus: ProjectRuntimeStatus = resolveUnregisteredRuntimeStatus({
    runtimeOk: opts.runtimeOk,
    running,
  });
  return {
    name: opts.name,
    devHost: null,
    repoRoot: null,
    projectDir: null,
    definedServices: null,
    extensionsEnabled: null,
    features: null,
    serviceHosts: null,
    runtimeConfigured: null,
    runtimeStatus,
    runtime: opts.runtime,
    branchRuntime: [],
    sessions: [],
    lifecycle: null,
    kind: "unregistered",
    status: "unregistered",
  };
}

export function serializeProjectView(
  view: ProjectView
): Record<string, unknown> {
  return {
    project_id: view.projectId ?? null,
    name: view.name,
    dev_host: view.devHost ?? null,
    repo_root: view.repoRoot ?? null,
    project_dir: view.projectDir ?? null,
    defined_services: view.definedServices ?? null,
    extensions_enabled: view.extensionsEnabled ?? null,
    features: view.features ?? null,
    service_hosts: view.serviceHosts ?? null,
    runtime_configured: view.runtimeConfigured ?? null,
    runtime_status: view.runtimeStatus,
    runtime: view.runtime ? serializeRuntimeProject(view.runtime) : null,
    branch_runtime: view.branchRuntime.map((entry) => ({
      branch: entry.branch,
      runtime: serializeRuntimeProject(entry.runtime),
    })),
    sessions: view.sessions.map((entry) => ({
      name: entry.name,
      backend: entry.backend,
      source: entry.source,
      attached: entry.attached,
      path: entry.path,
      windows: entry.windows,
      created_at: entry.createdAt,
    })),
    lifecycle: view.lifecycle
      ? {
          up_before: view.lifecycle.upBefore.map((entry) => ({
            name: entry.name,
            command: entry.command,
            cwd: entry.cwd,
            service: entry.service,
          })),
          up_after: view.lifecycle.upAfter.map((entry) => ({
            name: entry.name,
            command: entry.command,
            cwd: entry.cwd,
            service: entry.service,
          })),
          down_before: view.lifecycle.downBefore.map((entry) => ({
            name: entry.name,
            command: entry.command,
            cwd: entry.cwd,
            service: entry.service,
          })),
          down_after: view.lifecycle.downAfter.map((entry) => ({
            name: entry.name,
            command: entry.command,
            cwd: entry.cwd,
            service: entry.service,
          })),
          processes: view.lifecycle.processes.map((entry) => ({
            name: entry.name,
            command: entry.command,
            cwd: entry.cwd,
            service: entry.service,
          })),
        }
      : null,
    kind: view.kind,
    status: view.status,
  };
}

async function resolveProjectLifecycleView(opts: {
  readonly registration: RegisteredProject;
}): Promise<ProjectLifecycleView | null> {
  const config = await readProjectConfig({
    projectRoot: opts.registration.repoRoot,
    projectDirName: opts.registration.projectDirName,
    projectDir: opts.registration.projectDir,
    composeFile: resolve(
      opts.registration.projectDir,
      PROJECT_COMPOSE_FILENAME
    ),
    envFile: resolve(opts.registration.projectDir, PROJECT_ENV_FILENAME),
    configFile: resolve(opts.registration.projectDir, PROJECT_CONFIG_FILENAME),
  });
  const lifecycle = config.lifecycle;
  if (!lifecycle) {
    return null;
  }

  const upBefore = mapLifecycleCommandView({
    commands: lifecycle.up?.before,
  });
  const upAfter = mapLifecycleCommandView({
    commands: lifecycle.up?.after,
  });
  const downBefore = mapLifecycleCommandView({
    commands: lifecycle.down?.before,
  });
  const downAfter = mapLifecycleCommandView({
    commands: lifecycle.down?.after,
  });
  const processes = mapLifecycleProcessView({
    processes: lifecycle.processes,
  });

  const hasEntries =
    upBefore.length > 0 ||
    upAfter.length > 0 ||
    downBefore.length > 0 ||
    downAfter.length > 0 ||
    processes.length > 0;
  if (!hasEntries) {
    return null;
  }

  return {
    upBefore,
    upAfter,
    downBefore,
    downAfter,
    processes,
  };
}

function mapLifecycleCommandView(opts: {
  readonly commands: readonly ProjectLifecycleCommand[] | undefined;
}): readonly ProjectLifecycleCommandView[] {
  const commands = opts.commands ?? [];
  return commands.map((command, index) => ({
    name: command.name ?? null,
    command: command.command,
    cwd: command.cwd ?? null,
    service: resolveLifecycleCommandService({
      command,
      index,
    }),
  }));
}

function mapLifecycleProcessView(opts: {
  readonly processes: readonly ProjectLifecycleProcess[] | undefined;
}): readonly ProjectLifecycleProcessView[] {
  const processes = opts.processes ?? [];
  return processes.map((process) => ({
    name: process.name,
    command: process.command,
    cwd: process.cwd ?? null,
    service: process.name,
  }));
}

function resolveLifecycleCommandService(opts: {
  readonly command: ProjectLifecycleCommand;
  readonly index: number;
}): string {
  const fromName = (opts.command.name ?? "").trim();
  if (fromName.length > 0) {
    return fromName;
  }
  return `hook-${opts.index + 1}`;
}

function collectBranchRuntime(opts: {
  readonly baseName: string;
  readonly runtimeProjects: readonly RuntimeProject[];
}): readonly BranchRuntime[] {
  const prefix = `${opts.baseName}--`;
  const out: BranchRuntime[] = [];
  for (const runtime of opts.runtimeProjects) {
    if (!runtime.project.startsWith(prefix)) {
      continue;
    }
    const branch = runtime.project.slice(prefix.length);
    if (branch.length === 0) {
      continue;
    }
    out.push({ branch, runtime });
  }
  return out;
}

function collectProjectSessions(opts: {
  readonly projectName: string;
  readonly repoRoot: string;
  readonly muxSessions: readonly MuxSession[];
}): readonly ProjectSession[] {
  const projectRoot = canonicalPath(opts.repoRoot);
  const out: ProjectSession[] = [];

  for (const session of opts.muxSessions) {
    if (
      !isSessionForProject({
        sessionName: session.name,
        sessionPath: session.path,
        projectName: opts.projectName,
        projectRoot,
      })
    ) {
      continue;
    }

    out.push({
      name: session.name,
      backend: session.backend,
      source: classifySessionSource({
        sessionName: session.name,
        projectName: opts.projectName,
      }),
      attached: session.attached,
      path: session.path,
      windows: session.windows,
      createdAt: session.createdAt,
    });
  }

  return out.sort((a, b) => {
    if (a.source !== b.source) {
      return a.source === "hack" ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}

function classifySessionSource(opts: {
  readonly sessionName: string;
  readonly projectName: string;
}): "hack" | "external" {
  if (matchesHackSessionName(opts)) {
    return "hack";
  }
  return "external";
}

function isSessionForProject(opts: {
  readonly sessionName: string;
  readonly sessionPath: string | null;
  readonly projectName: string;
  readonly projectRoot: string;
}): boolean {
  if (
    matchesHackSessionName({
      sessionName: opts.sessionName,
      projectName: opts.projectName,
    })
  ) {
    return true;
  }

  if (!opts.sessionPath) {
    return false;
  }
  const sessionPath = canonicalPath(opts.sessionPath);
  return (
    sessionPath === opts.projectRoot ||
    sessionPath.startsWith(`${opts.projectRoot}/`)
  );
}

function matchesHackSessionName(opts: {
  readonly sessionName: string;
  readonly projectName: string;
}): boolean {
  const [sessionBase] = opts.sessionName.split(":");
  const normalizedProject = normalizeSessionToken(opts.projectName);
  const normalizedSessionBase = normalizeSessionToken(sessionBase ?? "");
  if (normalizedProject.length === 0 || normalizedSessionBase.length === 0) {
    return false;
  }
  return (
    opts.sessionName === opts.projectName ||
    opts.sessionName.startsWith(`${opts.projectName}:`) ||
    normalizedSessionBase === normalizedProject
  );
}

function normalizeSessionToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
}

function canonicalPath(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

async function listMuxSessions(): Promise<readonly MuxSession[]> {
  const [tmux, zellij] = await Promise.all([
    listTmuxSessions(),
    listZellijSessions(),
  ]);
  return [...tmux, ...zellij];
}

async function listTmuxSessions(): Promise<readonly MuxSession[]> {
  const separator = "|||HACK_SESSION_FIELD|||";
  const format = [
    "#{session_name}",
    "#{session_attached}",
    "#{session_path}",
    "#{session_windows}",
    "#{session_created}",
  ].join(separator);
  const result = await exec(["tmux", "list-sessions", "-F", format], {
    stdin: "ignore",
  });
  if (result.exitCode !== 0) {
    return [];
  }

  const out: MuxSession[] = [];
  const lines = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    const fields = parseTmuxSessionFields(line, separator, 5);
    if (!fields) {
      continue;
    }
    const [name, attachedRaw, pathRaw, windowsRaw, createdAtRaw] = fields;
    if (!name) {
      continue;
    }
    const windows = windowsRaw ? Number.parseInt(windowsRaw, 10) : Number.NaN;
    const createdAt = createdAtRaw
      ? Number.parseInt(createdAtRaw, 10)
      : Number.NaN;
    out.push({
      name,
      backend: "tmux",
      attached: attachedRaw === "1",
      path: pathRaw && pathRaw.length > 0 ? pathRaw : null,
      windows: Number.isFinite(windows) ? windows : null,
      createdAt: Number.isFinite(createdAt) ? createdAt : null,
    });
  }
  return out;
}

function parseTmuxSessionFields(
  line: string,
  separator: string,
  expectedCount: number
): readonly string[] | null {
  const bySeparator = line.split(separator);
  if (bySeparator.length === expectedCount) {
    return bySeparator;
  }
  const byTab = line.split("\t");
  if (byTab.length === expectedCount) {
    return byTab;
  }
  return null;
}

async function listZellijSessions(): Promise<readonly MuxSession[]> {
  const result = await exec(["zellij", "list-sessions", "--no-formatting"], {
    stdin: "ignore",
  });
  if (result.exitCode !== 0) {
    return [];
  }

  const out: MuxSession[] = [];
  const lines = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (line.includes("(EXITED")) {
      continue;
    }
    const name = parseZellijSessionName(line);
    if (!name) {
      continue;
    }
    out.push({
      name,
      backend: "zellij",
      attached: false,
      path: null,
      windows: null,
      createdAt: null,
    });
  }

  return out;
}

function parseZellijSessionName(line: string): string | null {
  const boundaries = [line.indexOf(" ["), line.indexOf(" (")].filter(
    (index) => index > 0
  );
  const end = boundaries.length > 0 ? Math.min(...boundaries) : line.length;
  const name = line.slice(0, end).trim();
  return name.length > 0 ? name : null;
}

async function readComposeServices(opts: {
  readonly composeFile: string;
}): Promise<readonly string[] | null> {
  const text = await readTextFile(opts.composeFile);
  if (!text) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }

  const servicesRaw = parsed.services;
  if (!isRecord(servicesRaw)) {
    return [];
  }

  return Object.keys(servicesRaw).sort((a, b) => a.localeCompare(b));
}

async function readComposeServiceHosts(opts: {
  readonly composeFile: string;
}): Promise<Readonly<Record<string, readonly string[]>> | null> {
  const text = await readTextFile(opts.composeFile);
  if (!text) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }

  const servicesRaw = parsed.services;
  if (!isRecord(servicesRaw)) {
    return null;
  }

  const out: Record<string, readonly string[]> = {};
  for (const [serviceName, serviceRaw] of Object.entries(servicesRaw)) {
    if (!isRecord(serviceRaw)) {
      continue;
    }
    const labels = serviceRaw.labels;
    const caddyLabel = extractLabelValue(labels, "caddy");
    if (!caddyLabel) {
      continue;
    }
    const hosts = caddyLabel
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (hosts.length > 0) {
      out[serviceName] = hosts;
    }
  }

  return Object.keys(out).length > 0 ? out : null;
}

function extractLabelValue(labels: unknown, key: string): string | null {
  if (isRecord(labels)) {
    const value = labels[key];
    return typeof value === "string" ? value : null;
  }
  if (Array.isArray(labels)) {
    for (const entry of labels) {
      if (typeof entry !== "string") {
        continue;
      }
      const [k, ...rest] = entry.split("=");
      if (!k) {
        continue;
      }
      if (k.trim() === key) {
        const value = rest.join("=").trim();
        if (value.length > 0) {
          return value;
        }
      }
    }
  }
  return null;
}

async function resolveProjectExtensions(opts: {
  readonly projectDir: string;
}): Promise<{
  readonly enabled: readonly string[];
  readonly features: readonly string[];
}> {
  const { config } = await readControlPlaneConfig({
    projectDir: opts.projectDir,
  });
  const enabled = Object.entries(config.extensions)
    .filter(([, value]) => value.enabled)
    .map(([key]) => key)
    .sort((a, b) => a.localeCompare(b));
  const features = enabled
    .map((id) => mapExtensionFeature(id))
    .filter((value): value is string => value !== null)
    .sort((a, b) => a.localeCompare(b));
  return { enabled, features };
}

function mapExtensionFeature(id: string): string | null {
  switch (id) {
    case "dance.hack.tickets":
      return "tickets";
    case "dance.hack.cloudflare":
      return "cloudflare";
    case "dance.hack.tailscale":
      return "tailscale";
    default:
      return id;
  }
}

/**
 * Resolves the runtime status for a registered project.
 */
function resolveRuntimeStatus(opts: {
  readonly projectDirOk: boolean;
  readonly composeExists: boolean;
  readonly runtimeOk: boolean;
  readonly running: number;
}): ProjectRuntimeStatus {
  if (!opts.projectDirOk) {
    return "missing";
  }
  if (!opts.composeExists) {
    return "not_configured";
  }
  if (!opts.runtimeOk) {
    return "unknown";
  }
  if (opts.running > 0) {
    return "running";
  }
  return "stopped";
}

/**
 * Resolves the project status for a registered project.
 */
function resolveProjectStatus(opts: {
  readonly projectDirOk: boolean;
  readonly runtimeOk: boolean;
  readonly running: number;
}): ProjectView["status"] {
  if (!opts.projectDirOk) {
    return "missing";
  }
  if (!opts.runtimeOk) {
    return "unknown";
  }
  if (opts.running > 0) {
    return "running";
  }
  return "stopped";
}

/**
 * Resolves the runtime status for an unregistered project.
 */
function resolveUnregisteredRuntimeStatus(opts: {
  readonly runtimeOk: boolean;
  readonly running: number;
}): ProjectRuntimeStatus {
  if (!opts.runtimeOk) {
    return "unknown";
  }
  if (opts.running > 0) {
    return "running";
  }
  return "stopped";
}
