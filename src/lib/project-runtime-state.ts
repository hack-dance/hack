import { dirname, resolve } from "node:path";
import {
  buildStaleComposeEnvWarning,
  type ComposeEnvFingerprintRecord,
  evaluateComposeServiceEnvFreshness,
  parseComposeEnvFingerprintRecord,
  withComposeServiceEnvFingerprints,
  withoutComposeServiceEnvFingerprints,
} from "./compose-env-fingerprint.ts";
import { ensureDir, pathExists, readTextFile } from "./fs.ts";
import { getString, isRecord } from "./guards.ts";
import {
  withProjectsRegistryLock,
  writeProjectsRegistryAtomic,
} from "./projects-registry-lock.ts";

export type ProjectRuntimeStateEntry = {
  readonly composeProject: string;
  readonly envName: string | null;
  readonly updatedAt: string;
  /** Unique publication identity for a launch's failure cleanup. */
  readonly launchId?: string;
  /** Changes when a service-scoped command may have changed the running copy. */
  readonly serviceMutationId?: string;
  /** Digest of the Docker engine selection used for the launch. */
  readonly dockerEngineSelection?: string;
  /** Digest of the responding Docker daemon's ID when it was available. */
  readonly dockerDaemonIdentity?: string;
  readonly dockerDaemonIdentityState?: "unsupported" | "unverified";
  /** Effective Compose base name when this instance last started. */
  readonly launchComposeBase?: string;
  /** Logical copy in this checkout. Missing on records predating copy association. */
  readonly launchBranch?: string | null;
  /** Configured secret-store namespace used to resolve this launch's overlay. */
  readonly envProjectName?: string;
  /** Base name explicitly passed to Compose at startup, before any branch suffix. */
  readonly pinnedComposeBase?: string;
  /**
   * Value-free digests of the env set each service was last created with.
   * Absent for state written before fingerprints existed; exec then skips the
   * staleness check.
   */
  readonly envFingerprint?: ComposeEnvFingerprintRecord;
  /**
   * Compose profiles the last full up/restart activated (`--profile`, else
   * `COMPOSE_PROFILES` from the env Compose received). `down` reuses them so
   * a later env change cannot leave profiled containers running (HACK-2340).
   * Absent in state written before this field existed.
   */
  readonly composeProfiles?: readonly string[];
  /** Started target names, binding digests, and selection sources for teardown hooks. */
  readonly remoteTargets?: Readonly<Record<string, string>>;
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

/** Select the latest launch recorded for this checkout and logical copy. */
export async function readProjectRuntimeCopyLaunch(opts: {
  readonly projectDir: string;
  readonly branch: string | null;
}): Promise<ProjectRuntimeStateEntry | undefined> {
  const entries = await readProjectRuntimeState(opts);
  let latest: ProjectRuntimeStateEntry | undefined;
  for (const entry of entries) {
    if (
      entry.launchBranch === opts.branch &&
      entry.launchComposeBase &&
      (!latest || entry.updatedAt > latest.updatedAt)
    ) {
      latest = entry;
    }
  }
  return latest;
}

export async function upsertProjectRuntimeStateEntry(opts: {
  readonly projectDir: string;
  readonly entry: ProjectRuntimeStateEntry;
  readonly replaceComposeProject?: string;
}): Promise<void> {
  await mutateProjectRuntimeState(opts.projectDir, (entries) =>
    replaceRuntimeEntry(
      entries.filter(
        (entry) => entry.composeProject !== opts.replaceComposeProject
      ),
      opts.entry
    )
  );
}

/** Replace the launch and return the records displaced by this same write. */
export async function stageProjectRuntimeLaunch(opts: {
  readonly projectDir: string;
  readonly composeProject: string;
  readonly replaceComposeProject?: string;
  readonly buildEntry: (
    previous: ProjectRuntimeStateEntry | undefined
  ) => ProjectRuntimeStateEntry;
}): Promise<readonly ProjectRuntimeStateEntry[]> {
  let displaced: readonly ProjectRuntimeStateEntry[] = [];
  await mutateProjectRuntimeState(opts.projectDir, (entries) => {
    displaced = entries.filter(
      (entry) =>
        entry.composeProject === opts.composeProject ||
        entry.composeProject === opts.replaceComposeProject
    );
    const previous = displaced.find(
      (entry) =>
        entry.composeProject ===
        (opts.replaceComposeProject ?? opts.composeProject)
    );
    return replaceRuntimeEntry(
      entries.filter(
        (entry) => entry.composeProject !== opts.replaceComposeProject
      ),
      opts.buildEntry(previous)
    );
  });
  return displaced;
}

export async function removeProjectRuntimeStateEntry(opts: {
  readonly projectDir: string;
  readonly composeProject: string;
  readonly launchId?: string;
}): Promise<void> {
  await mutateProjectRuntimeState(opts.projectDir, (entries) => {
    const next = entries.filter(
      (entry) =>
        entry.composeProject !== opts.composeProject ||
        (opts.launchId !== undefined &&
          (entry.launchId !== opts.launchId ||
            entry.serviceMutationId !== undefined))
    );
    return next.length === entries.length ? null : next;
  });
}

/** Fence post-hook readiness and return a rollback for a refused dispatch. */
async function stageProjectRuntimeServiceMutation(opts: {
  readonly projectDir: string;
  readonly composeProject: string;
}): Promise<() => Promise<void>> {
  const serviceMutationId = crypto.randomUUID();
  let previous: string | undefined;
  await mutateProjectRuntimeState(opts.projectDir, (entries) => {
    const entry = entries.find(
      (current) => current.composeProject === opts.composeProject
    );
    previous = entry?.serviceMutationId;
    return entry
      ? replaceRuntimeEntry(entries, { ...entry, serviceMutationId })
      : null;
  });
  return () =>
    mutateProjectRuntimeState(opts.projectDir, (entries) => {
      const entry = entries.find(
        (current) => current.composeProject === opts.composeProject
      );
      if (entry?.serviceMutationId !== serviceMutationId) {
        return null;
      }
      const { serviceMutationId: _discarded, ...rest } = entry;
      return replaceRuntimeEntry(entries, {
        ...rest,
        ...(previous === undefined ? {} : { serviceMutationId: previous }),
      });
    });
}

/** Keep the mutation revision once the subprocess has been dispatched. */
export function createServiceMutationPublication(
  opts: Parameters<typeof stageProjectRuntimeServiceMutation>[0]
) {
  let rollback: (() => Promise<void>) | undefined;
  return {
    async stage() {
      rollback = await stageProjectRuntimeServiceMutation(opts);
    },
    dispatched() {
      rollback = undefined;
    },
    async settle() {
      await rollback?.();
    },
  };
}

/** Roll back an unpublished-to-Docker launch without replacing another writer's records. */
export async function restoreUndispatchedRuntimeLaunch(opts: {
  readonly projectDir: string;
  readonly composeProject: string;
  readonly launchId: string;
  readonly previous: readonly ProjectRuntimeStateEntry[];
}): Promise<void> {
  await mutateProjectRuntimeState(opts.projectDir, (entries) => {
    const current = entries.find(
      (entry) => entry.composeProject === opts.composeProject
    );
    if (current?.launchId !== opts.launchId) {
      return null;
    }
    const retained = entries.filter(
      (entry) => entry.composeProject !== opts.composeProject
    );
    const retainedKeys = new Set(retained.map((entry) => entry.composeProject));
    return [
      ...retained,
      ...opts.previous.filter(
        (entry) => !retainedKeys.has(entry.composeProject)
      ),
    ].sort((left, right) =>
      left.composeProject.localeCompare(right.composeProject)
    );
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
  await mutateProjectRuntimeState(opts.projectDir, (entries) => {
    const entry = entries.find(
      (current) => current.composeProject === opts.composeProject
    );
    if (!entry) {
      return null;
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
    return replaceRuntimeEntry(entries, {
      ...rest,
      ...(envFingerprint ? { envFingerprint } : {}),
    });
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
  const pinnedComposeBase = getString(value, "pinnedComposeBase");
  const launchComposeBase = getString(value, "launchComposeBase");
  const launchId = getString(value, "launchId");
  const serviceMutationId = getString(value, "serviceMutationId");
  const dockerEngineSelection = getString(value, "dockerEngineSelection");
  const dockerDaemonIdentity = getString(value, "dockerDaemonIdentity");
  const dockerDaemonIdentityState = getString(
    value,
    "dockerDaemonIdentityState"
  );
  const launchBranch = value.launchBranch;
  const envProjectName = getString(value, "envProjectName");
  const composeProfiles = Array.isArray(value.composeProfiles)
    ? value.composeProfiles.filter(
        (profile): profile is string =>
          typeof profile === "string" && profile.trim().length > 0
      )
    : null;

  const remoteTargets = isRecord(value.remoteTargets)
    ? Object.fromEntries(
        Object.entries(value.remoteTargets).flatMap(([name, target]) =>
          typeof target === "string" ? [[name, target]] : []
        )
      )
    : undefined;
  return {
    composeProject,
    envName,
    updatedAt,
    ...(launchId ? { launchId } : {}),
    ...(serviceMutationId ? { serviceMutationId } : {}),
    ...(dockerEngineSelection ? { dockerEngineSelection } : {}),
    ...(dockerDaemonIdentity ? { dockerDaemonIdentity } : {}),
    ...(dockerDaemonIdentityState === "unsupported" ||
    dockerDaemonIdentityState === "unverified"
      ? { dockerDaemonIdentityState }
      : {}),
    ...(launchComposeBase ? { launchComposeBase } : {}),
    ...(launchBranch === null || typeof launchBranch === "string"
      ? { launchBranch }
      : {}),
    ...(envProjectName ? { envProjectName } : {}),
    ...(pinnedComposeBase ? { pinnedComposeBase } : {}),
    ...(envFingerprint ? { envFingerprint } : {}),
    ...(composeProfiles ? { composeProfiles } : {}),
    ...(remoteTargets ? { remoteTargets } : {}),
  };
}

function replaceRuntimeEntry(
  entries: readonly ProjectRuntimeStateEntry[],
  entry: ProjectRuntimeStateEntry
): readonly ProjectRuntimeStateEntry[] {
  return [
    ...entries.filter(
      (current) => current.composeProject !== entry.composeProject
    ),
    entry,
  ].sort((left, right) =>
    left.composeProject.localeCompare(right.composeProject)
  );
}

/** Sibling copies share a state file even though their runtime locks differ. */
async function mutateProjectRuntimeState(
  projectDir: string,
  update: (
    entries: readonly ProjectRuntimeStateEntry[]
  ) => readonly ProjectRuntimeStateEntry[] | null
): Promise<void> {
  const path = resolveProjectRuntimeStatePath({ projectDir });
  await ensureDir(dirname(path), 0o700);
  await withProjectsRegistryLock({
    lockPath: `${path}.lock`,
    label: "Runtime state",
    run: async () => {
      const entries = update(await readProjectRuntimeState({ projectDir }));
      if (entries) {
        const state: ProjectRuntimeStateFile = { entries };
        await writeProjectsRegistryAtomic({
          path,
          text: `${JSON.stringify(state, null, 2)}\n`,
        });
      }
    },
  });
}
