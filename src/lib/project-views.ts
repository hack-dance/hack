import { resolve } from "node:path";

import { YAML } from "bun";
import { PROJECT_COMPOSE_FILENAME } from "../constants.ts";
import { readControlPlaneConfig } from "../control-plane/sdk/config.ts";
import { pathExists, readTextFile } from "./fs.ts";
import { isRecord } from "./guards.ts";
import type { RegisteredProject } from "./projects-registry.ts";
import {
  countRunningServices,
  type RuntimeProject,
  serializeRuntimeProject,
} from "./runtime-projects.ts";

export type BranchRuntime = {
  readonly branch: string;
  readonly runtime: RuntimeProject;
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

export async function buildProjectViews(opts: {
  readonly registryProjects: readonly RegisteredProject[];
  readonly runtime: readonly RuntimeProject[];
  readonly runtimeOk: boolean;
  readonly filter: string | null;
  readonly includeUnregistered: boolean;
}): Promise<ProjectView[]> {
  const byName = new Map(
    opts.registryProjects.map((p) => [p.name, p] as const)
  );
  const runtimeByName = new Map(
    opts.runtime.map((p) => [p.project, p] as const)
  );
  const names = collectProjectNames({
    registryProjects: opts.registryProjects,
    runtime: opts.runtime,
    includeUnregistered: opts.includeUnregistered,
  });

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
          reg,
          runtime,
          runtimeOk: opts.runtimeOk,
          runtimeProjects: opts.runtime,
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

function collectProjectNames(opts: {
  readonly registryProjects: readonly RegisteredProject[];
  readonly runtime: readonly RuntimeProject[];
  readonly includeUnregistered: boolean;
}): ReadonlySet<string> {
  const names = new Set<string>();
  for (const p of opts.registryProjects) {
    names.add(p.name);
  }
  if (!opts.includeUnregistered) {
    return names;
  }
  for (const p of opts.runtime) {
    names.add(p.project);
  }
  return names;
}

async function buildRegisteredProjectView(opts: {
  readonly name: string;
  readonly reg: RegisteredProject;
  readonly runtime: RuntimeProject | null;
  readonly runtimeOk: boolean;
  readonly runtimeProjects: readonly RuntimeProject[];
}): Promise<ProjectView> {
  const composeMeta = await resolveComposeMeta({
    projectDir: opts.reg.projectDir,
  });
  const running = countRunningServices(opts.runtime);
  const runtimeStatus = resolveRuntimeStatus({
    projectDirOk: composeMeta.projectDirOk,
    composeExists: composeMeta.composeExists,
    runtimeOk: opts.runtimeOk,
    running,
  });
  const status = resolveProjectStatus({
    projectDirOk: composeMeta.projectDirOk,
    runtimeOk: opts.runtimeOk,
    running,
  });
  const branchRuntime = collectBranchRuntime({
    baseName: opts.name,
    runtimeProjects: opts.runtimeProjects,
  });
  const extensions = composeMeta.projectDirOk
    ? await resolveProjectExtensions({ projectDir: opts.reg.projectDir })
    : null;

  return {
    projectId: opts.reg.id,
    name: opts.name,
    devHost: opts.reg.devHost ?? null,
    repoRoot: opts.reg.repoRoot,
    projectDir: opts.reg.projectDir,
    definedServices: composeMeta.definedServices,
    extensionsEnabled: extensions?.enabled ?? null,
    features: extensions?.features ?? null,
    serviceHosts: composeMeta.serviceHosts,
    runtimeConfigured: composeMeta.composeExists,
    runtimeStatus,
    runtime: opts.runtime,
    branchRuntime,
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
  const runtimeStatus = resolveUnregisteredRuntimeStatus({
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
    kind: "unregistered",
    status: "unregistered",
  };
}

type ComposeMeta = {
  readonly projectDirOk: boolean;
  readonly composeExists: boolean;
  readonly definedServices: readonly string[] | null;
  readonly serviceHosts: Readonly<Record<string, readonly string[]>> | null;
};

async function resolveComposeMeta(opts: {
  readonly projectDir: string;
}): Promise<ComposeMeta> {
  const projectDirOk = await pathExists(opts.projectDir);
  const composeFile = resolve(opts.projectDir, PROJECT_COMPOSE_FILENAME);
  const composeExists = projectDirOk && (await pathExists(composeFile));
  if (!composeExists) {
    return {
      projectDirOk,
      composeExists,
      definedServices: null,
      serviceHosts: null,
    };
  }

  const [definedServices, serviceHosts] = await Promise.all([
    readComposeServices({ composeFile }),
    readComposeServiceHosts({ composeFile }),
  ]);

  return {
    projectDirOk,
    composeExists,
    definedServices,
    serviceHosts,
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
    kind: view.kind,
    status: view.status,
  };
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
