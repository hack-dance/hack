import { resolve } from "node:path";
import {
  buildStaleComposeEnvWarning,
  type ComposeEnvFingerprintRecord,
  evaluateComposeServiceEnvFreshness,
  parseComposeEnvFingerprintRecord,
  withComposeServiceEnvFingerprints,
  withoutComposeServiceEnvFingerprints,
} from "./compose-env-fingerprint.ts";
import { ensureDir, pathExists, readTextFile, writeTextFile } from "./fs.ts";
import { getString, isRecord } from "./guards.ts";

export type ProjectRuntimeStateEntry = {
  readonly composeProject: string;
  readonly envName: string | null;
  readonly updatedAt: string;
  /**
   * Value-free digests of the env set each service was last created with.
   * Absent for state written before fingerprints existed; exec then skips the
   * staleness check.
   */
  readonly envFingerprint?: ComposeEnvFingerprintRecord;
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

/**
 * Refresh or forget the env digests of `services` after a service-scoped
 * (re)create, preserving the rest of the stack's entry.
 *
 * - No entry: nothing is written. Service-scoped commands never create the
 *   stack entry (its env selection belongs to a full `up`/`restart`).
 * - `applied` with the entry's env selection: digests are recorded.
 * - Otherwise (`unknown` outcome, or a different env selection): the digests
 *   are dropped so exec reports nothing rather than a wrong comparison.
 */
export async function updateProjectRuntimeServiceEnvFingerprints(opts: {
  readonly projectDir: string;
  readonly composeProject: string;
  readonly effectiveEnvName: string | null;
  readonly services: readonly string[];
  readonly envByService: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
  readonly outcome: "applied" | "unknown";
}): Promise<void> {
  const entry = await readProjectRuntimeStateEntry({
    projectDir: opts.projectDir,
    composeProject: opts.composeProject,
  });
  if (!entry) {
    return;
  }
  const envFingerprint =
    opts.outcome === "applied" && entry.envName === opts.effectiveEnvName
      ? withComposeServiceEnvFingerprints({
          existing: entry.envFingerprint,
          services: opts.services,
          envByService: opts.envByService,
        })
      : withoutComposeServiceEnvFingerprints({
          existing: entry.envFingerprint,
          services: opts.services,
        });
  const { envFingerprint: _previous, ...rest } = entry;
  await upsertProjectRuntimeStateEntry({
    projectDir: opts.projectDir,
    entry: { ...rest, ...(envFingerprint ? { envFingerprint } : {}) },
  });
}

/**
 * Closed warning for `hack exec` when the env resolved now differs from the
 * env `service` was created with; null when unchanged or unknown. Never
 * includes a key or value.
 */
export async function resolveComposeExecStaleEnvWarning(opts: {
  readonly projectDir: string;
  readonly composeProject: string;
  readonly service: string;
  readonly currentEnv: Readonly<Record<string, string>>;
}): Promise<string | null> {
  const entry = await readProjectRuntimeStateEntry({
    projectDir: opts.projectDir,
    composeProject: opts.composeProject,
  });
  const freshness = evaluateComposeServiceEnvFreshness({
    record: entry?.envFingerprint,
    service: opts.service,
    currentEnv: opts.currentEnv,
  });
  return freshness === "changed"
    ? buildStaleComposeEnvWarning({ service: opts.service })
    : null;
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

  const envFingerprint = parseComposeEnvFingerprintRecord(value.envFingerprint);

  return {
    composeProject,
    envName,
    updatedAt,
    ...(envFingerprint ? { envFingerprint } : {}),
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
