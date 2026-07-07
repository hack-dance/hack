import { dirname, resolve } from "node:path";
import { resolveGlobalHackDir } from "./config-paths.ts";
import { ensureDir, readTextFile } from "./fs.ts";
import { getString, isRecord } from "./guards.ts";

const NODE_WORKSPACE_MAP_VERSION = 1 as const;
const NODE_WORKSPACE_MAP_FILENAME = "projects.config.json";
const NODE_MANAGED_PROJECTS_DIRNAME = "projects";

export type NodeWorkspaceSource = "managed" | "external";

export interface NodeWorkspaceMapEntry {
  readonly projectId?: string;
  readonly projectName?: string;
  readonly workspaceRoot: string;
  readonly workspaceProjectName: string;
  readonly workspaceProjectId?: string;
  readonly source: NodeWorkspaceSource;
  readonly repoUrl?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NodeWorkspaceMap {
  readonly version: typeof NODE_WORKSPACE_MAP_VERSION;
  readonly entries: readonly NodeWorkspaceMapEntry[];
}

/**
 * Resolve the node-local managed workspace root used for first-run project bootstrap.
 */
export function resolveManagedNodeProjectsRoot(): string {
  return resolve(resolveGlobalRoot(), NODE_MANAGED_PROJECTS_DIRNAME);
}

/**
 * Resolve the node-local workspace map config path.
 */
export function resolveNodeWorkspaceMapPath(): string {
  return resolve(resolveGlobalRoot(), NODE_WORKSPACE_MAP_FILENAME);
}

/**
 * Read the node-local workspace map with safe fallback to an empty map.
 */
export async function readNodeWorkspaceMap(): Promise<NodeWorkspaceMap> {
  const path = resolveNodeWorkspaceMapPath();
  const text = await readTextFile(path);
  if (!text) {
    return {
      version: NODE_WORKSPACE_MAP_VERSION,
      entries: [],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      version: NODE_WORKSPACE_MAP_VERSION,
      entries: [],
    };
  }

  return normalizeNodeWorkspaceMap(parsed);
}

/**
 * Find an existing workspace map entry by controller project id or project name.
 *
 * Id match has precedence over name match.
 */
export function findNodeWorkspaceMapEntry(opts: {
  readonly map: NodeWorkspaceMap;
  readonly projectId?: string;
  readonly projectName?: string;
}): NodeWorkspaceMapEntry | null {
  const projectId = normalizeSelectorValue(opts.projectId);
  const projectName = normalizeSelectorValue(opts.projectName);
  const projectNameKey = normalizeProjectNameKey(projectName);

  if (projectId) {
    const byId =
      opts.map.entries.find((entry) => entry.projectId === projectId) ?? null;
    if (byId) {
      return byId;
    }
  }

  if (!projectNameKey) {
    return null;
  }

  return (
    opts.map.entries.find(
      (entry) => normalizeProjectNameKey(entry.projectName) === projectNameKey
    ) ?? null
  );
}

/**
 * Create or update a node-local workspace map entry.
 */
export async function upsertNodeWorkspaceMapEntry(opts: {
  readonly projectId?: string;
  readonly projectName?: string;
  readonly workspaceRoot: string;
  readonly workspaceProjectName: string;
  readonly workspaceProjectId?: string;
  readonly source: NodeWorkspaceSource;
  readonly repoUrl?: string;
  readonly nowIso?: string;
}): Promise<NodeWorkspaceMapEntry | null> {
  const projectId = normalizeSelectorValue(opts.projectId);
  const projectName = normalizeSelectorValue(opts.projectName);
  const workspaceRoot = normalizeSelectorValue(opts.workspaceRoot);
  const workspaceProjectName = normalizeSelectorValue(
    opts.workspaceProjectName
  );
  const workspaceProjectId = normalizeSelectorValue(opts.workspaceProjectId);
  const repoUrl = normalizeSelectorValue(opts.repoUrl);
  if (!(workspaceRoot && workspaceProjectName && (projectId || projectName))) {
    return null;
  }

  const nowIso = opts.nowIso ?? new Date().toISOString();
  const map = await readNodeWorkspaceMap();
  const nextEntries = [...map.entries];
  const targetIndex = resolveEntryIndex({
    entries: nextEntries,
    projectId,
    projectName,
  });

  const existing = targetIndex >= 0 ? nextEntries[targetIndex] : null;
  const nextEntry: NodeWorkspaceMapEntry = {
    ...(projectId ? { projectId } : {}),
    ...(projectName ? { projectName } : {}),
    workspaceRoot,
    workspaceProjectName,
    ...(workspaceProjectId ? { workspaceProjectId } : {}),
    source: opts.source,
    ...(repoUrl ? { repoUrl } : {}),
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso,
  };

  if (targetIndex >= 0) {
    nextEntries[targetIndex] = nextEntry;
  } else {
    nextEntries.push(nextEntry);
  }

  await writeNodeWorkspaceMap({
    version: NODE_WORKSPACE_MAP_VERSION,
    entries: nextEntries,
  });
  return nextEntry;
}

/**
 * Remove a node-local workspace map entry by controller project id or name.
 */
export async function removeNodeWorkspaceMapEntry(opts: {
  readonly projectId?: string;
  readonly projectName?: string;
}): Promise<boolean> {
  const projectId = normalizeSelectorValue(opts.projectId);
  const projectName = normalizeSelectorValue(opts.projectName);
  if (!(projectId || projectName)) {
    return false;
  }

  const map = await readNodeWorkspaceMap();
  const nextEntries = [...map.entries];
  const targetIndex = resolveEntryIndex({
    entries: nextEntries,
    projectId,
    projectName,
  });
  if (targetIndex < 0) {
    return false;
  }
  nextEntries.splice(targetIndex, 1);
  await writeNodeWorkspaceMap({
    version: NODE_WORKSPACE_MAP_VERSION,
    entries: nextEntries,
  });
  return true;
}

function normalizeNodeWorkspaceMap(value: unknown): NodeWorkspaceMap {
  if (!isRecord(value)) {
    return {
      version: NODE_WORKSPACE_MAP_VERSION,
      entries: [],
    };
  }

  const entriesRaw = Array.isArray(value.entries) ? value.entries : [];
  const entries: NodeWorkspaceMapEntry[] = [];
  for (const raw of entriesRaw) {
    const parsed = parseNodeWorkspaceMapEntry(raw);
    if (parsed) {
      entries.push(parsed);
    }
  }

  return {
    version: NODE_WORKSPACE_MAP_VERSION,
    entries,
  };
}

function parseNodeWorkspaceMapEntry(
  value: unknown
): NodeWorkspaceMapEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  const projectId = getString(value, "projectId") ?? undefined;
  const projectName = getString(value, "projectName") ?? undefined;
  const workspaceRoot = getString(value, "workspaceRoot");
  const workspaceProjectName = getString(value, "workspaceProjectName");
  const workspaceProjectId =
    getString(value, "workspaceProjectId") ?? undefined;
  const repoUrl = getString(value, "repoUrl") ?? undefined;
  const createdAt = getString(value, "createdAt");
  const updatedAt = getString(value, "updatedAt");
  const source = parseWorkspaceSource(getString(value, "source"));

  if (
    !(
      workspaceRoot &&
      workspaceProjectName &&
      createdAt &&
      updatedAt &&
      source &&
      (projectId || projectName)
    )
  ) {
    return null;
  }

  return {
    ...(projectId ? { projectId } : {}),
    ...(projectName ? { projectName } : {}),
    workspaceRoot: workspaceRoot.trim(),
    workspaceProjectName: workspaceProjectName.trim(),
    ...(workspaceProjectId ? { workspaceProjectId } : {}),
    source,
    ...(repoUrl ? { repoUrl } : {}),
    createdAt,
    updatedAt,
  };
}

function parseWorkspaceSource(
  value: string | undefined
): NodeWorkspaceSource | null {
  if (value === "managed") {
    return "managed";
  }
  if (value === "external") {
    return "external";
  }
  return null;
}

function resolveEntryIndex(opts: {
  readonly entries: readonly NodeWorkspaceMapEntry[];
  readonly projectId?: string;
  readonly projectName?: string;
}): number {
  if (opts.projectId) {
    const byId = opts.entries.findIndex(
      (entry) => entry.projectId === opts.projectId
    );
    if (byId >= 0) {
      return byId;
    }
  }
  const nameKey = normalizeProjectNameKey(opts.projectName);
  if (!nameKey) {
    return -1;
  }
  return opts.entries.findIndex(
    (entry) => normalizeProjectNameKey(entry.projectName) === nameKey
  );
}

function normalizeSelectorValue(value: string | undefined): string | undefined {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeProjectNameKey(value: string | undefined): string | null {
  const trimmed = (value ?? "").trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveGlobalRoot(): string {
  const configPath = (process.env.HACK_GLOBAL_CONFIG_PATH ?? "").trim();
  if (configPath.length > 0) {
    return dirname(configPath);
  }
  return resolveGlobalHackDir();
}

async function writeNodeWorkspaceMap(map: NodeWorkspaceMap): Promise<void> {
  const path = resolveNodeWorkspaceMapPath();
  await ensureDir(dirname(path));
  await Bun.write(path, `${JSON.stringify(map, null, 2)}\n`);
}
