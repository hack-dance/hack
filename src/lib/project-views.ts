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

  const names = new Set<string>();
  for (const p of opts.registryProjects) {
    names.add(p.name);
  }
  if (opts.includeUnregistered) {
    for (const p of opts.runtime) {
      names.add(p.project);
    }
  }

  const out: ProjectView[] = [];
  for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
    if (opts.filter && name !== opts.filter) {
      continue;
    }

    const reg = byName.get(name) ?? null;
    const runtime = runtimeByName.get(name) ?? null;

    if (reg) {
      const projectDirOk = await pathExists(reg.projectDir);
      const composeFile = resolve(reg.projectDir, PROJECT_COMPOSE_FILENAME);
      const composeExists = projectDirOk && (await pathExists(composeFile));
      const definedServices = composeExists
        ? await readComposeServices({ composeFile })
        : null;
      const running = countRunningServices(runtime);
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
        baseName: name,
        runtimeProjects: opts.runtime,
      });
      const extensions = projectDirOk
        ? await resolveProjectExtensions({ projectDir: reg.projectDir })
        : null;

      out.push({
        projectId: reg.id,
        name,
        devHost: reg.devHost ?? null,
        repoRoot: reg.repoRoot,
        projectDir: reg.projectDir,
        definedServices,
        extensionsEnabled: extensions?.enabled ?? null,
        features: extensions?.features ?? null,
        runtimeConfigured,
        runtimeStatus,
        runtime,
        branchRuntime,
        kind: "registered",
        status,
      });
      continue;
    }

    if (opts.includeUnregistered) {
      const running = countRunningServices(runtime);
      const runtimeStatus: ProjectRuntimeStatus =
        resolveUnregisteredRuntimeStatus({
          runtimeOk: opts.runtimeOk,
          running,
        });
      out.push({
        name,
        devHost: null,
        repoRoot: null,
        projectDir: null,
        definedServices: null,
        extensionsEnabled: null,
        features: null,
        runtimeConfigured: null,
        runtimeStatus,
        runtime,
        branchRuntime: [],
        kind: "unregistered",
        status: "unregistered",
      });
    }
  }

  return out;
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
