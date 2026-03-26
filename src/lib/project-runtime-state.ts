import { resolve } from "node:path";
import { ensureDir, pathExists, readTextFile, writeTextFile } from "./fs.ts";
import { getString, isRecord } from "./guards.ts";

export type ProjectRuntimeStateEntry = {
  readonly composeProject: string;
  readonly envName: string | null;
  readonly updatedAt: string;
};

type ProjectRuntimeStateFile = {
  readonly entries: readonly ProjectRuntimeStateEntry[];
};

const PROJECT_RUNTIME_STATE_FILENAME = "runtime-state.json" as const;

export function resolveProjectRuntimeStatePath(opts: {
  readonly projectDir: string;
}): string {
  return resolve(opts.projectDir, ".internal", PROJECT_RUNTIME_STATE_FILENAME);
}

export async function readProjectRuntimeState(opts: {
  readonly projectDir: string;
}): Promise<readonly ProjectRuntimeStateEntry[]> {
  const path = resolveProjectRuntimeStatePath({ projectDir: opts.projectDir });
  if (!(await pathExists(path))) {
    return [];
  }

  const text = await readTextFile(path);
  if (!text) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }

  if (!isRecord(parsed)) {
    return [];
  }

  const entriesRaw = parsed.entries;
  if (!Array.isArray(entriesRaw)) {
    return [];
  }

  const entries: ProjectRuntimeStateEntry[] = [];
  for (const entry of entriesRaw) {
    const parsedEntry = parseProjectRuntimeStateEntry(entry);
    if (parsedEntry) {
      entries.push(parsedEntry);
    }
  }
  return entries;
}

export async function readProjectRuntimeStateEntry(opts: {
  readonly projectDir: string;
  readonly composeProject: string;
}): Promise<ProjectRuntimeStateEntry | null> {
  const state = await readProjectRuntimeState({ projectDir: opts.projectDir });
  return (
    state.find((entry) => entry.composeProject === opts.composeProject) ?? null
  );
}

export async function upsertProjectRuntimeStateEntry(opts: {
  readonly projectDir: string;
  readonly entry: ProjectRuntimeStateEntry;
}): Promise<void> {
  const state = await readProjectRuntimeState({ projectDir: opts.projectDir });
  const next: ProjectRuntimeStateFile = {
    entries: [
      ...state.filter(
        (entry) => entry.composeProject !== opts.entry.composeProject
      ),
      opts.entry,
    ].sort((a, b) => a.composeProject.localeCompare(b.composeProject)),
  };

  await writeProjectRuntimeStateFile({
    projectDir: opts.projectDir,
    state: next,
  });
}

export async function removeProjectRuntimeStateEntry(opts: {
  readonly projectDir: string;
  readonly composeProject: string;
}): Promise<void> {
  const state = await readProjectRuntimeState({ projectDir: opts.projectDir });
  const nextEntries = state.filter(
    (entry) => entry.composeProject !== opts.composeProject
  );
  if (nextEntries.length === state.length) {
    return;
  }

  await writeProjectRuntimeStateFile({
    projectDir: opts.projectDir,
    state: { entries: nextEntries },
  });
}

function parseProjectRuntimeStateEntry(
  value: unknown
): ProjectRuntimeStateEntry | null {
  if (!isRecord(value)) {
    return null;
  }

  const composeProject = getString(value, "composeProject")?.trim();
  const updatedAt = getString(value, "updatedAt")?.trim();
  if (!(composeProject && updatedAt)) {
    return null;
  }

  const envNameRaw = value.envName;
  const envName =
    typeof envNameRaw === "string" ? envNameRaw.trim() || null : null;

  return {
    composeProject,
    envName,
    updatedAt,
  };
}

async function writeProjectRuntimeStateFile(opts: {
  readonly projectDir: string;
  readonly state: ProjectRuntimeStateFile;
}): Promise<void> {
  const path = resolveProjectRuntimeStatePath({ projectDir: opts.projectDir });
  await ensureDir(resolve(opts.projectDir, ".internal"));
  await writeTextFile(path, `${JSON.stringify(opts.state, null, 2)}\n`);
}
