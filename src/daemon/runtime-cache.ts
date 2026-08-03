import { resolve } from "node:path";
import { PROJECT_COMPOSE_FILENAME } from "../constants.ts";
import { resolveProjectMeta } from "../lib/project-meta.ts";
import {
  buildProjectViews,
  serializeProjectView,
} from "../lib/project-views.ts";
import { readProjectsRegistry } from "../lib/projects-registry.ts";
import type { RuntimeProject } from "../lib/runtime-projects.ts";
import {
  autoRegisterRuntimeHackProjects,
  createRuntimeInspectCache,
  filterRuntimeProjects,
  getRuntimeInspectCacheDiagnostics,
  readRuntimeProjects,
} from "../lib/runtime-projects.ts";
import {
  buildRuntimeFingerprint,
  detectRuntimeDrift,
  type RuntimeDriftField,
  type RuntimeIdentity,
  readRuntimeIdentity,
} from "./runtime-health.ts";

export type RuntimeHealth = {
  readonly ok: boolean;
  readonly error: string | null;
  readonly checkedAtMs: number | null;
  readonly lastOkAtMs: number | null;
  readonly lastResetAtMs: number | null;
  readonly resetCount: number;
  readonly fingerprint: string | null;
  readonly identity: RuntimeIdentity | null;
  readonly lastResetChanges: readonly RuntimeDriftField[];
  readonly lastResetSummary: string | null;
  readonly lastRepairAtMs: number | null;
  readonly lastRepairAction: string | null;
  readonly lastRepairOutcome: "stabilized" | "manual_action_required" | null;
  readonly nextStep: string | null;
  readonly resetFromNonEmptyRuntime: boolean;
};

export type RuntimeSnapshot = {
  readonly runtime: readonly RuntimeProject[];
  readonly updatedAtMs: number | null;
  readonly health: RuntimeHealth;
};

export type ProjectsPayload = {
  readonly generated_at: string;
  readonly filter: string | null;
  readonly include_global: boolean;
  readonly include_unregistered: boolean;
  readonly include_meta: boolean;
  readonly runtime_ok: boolean;
  readonly runtime_error: string | null;
  readonly runtime_checked_at: string | null;
  readonly runtime_last_ok_at: string | null;
  readonly runtime_reset_at: string | null;
  readonly runtime_reset_count: number;
  readonly runtime_reset_summary: string | null;
  readonly runtime_reset_changes: readonly RuntimeDriftField[];
  readonly runtime_last_repair_at: string | null;
  readonly runtime_repair_action: string | null;
  readonly runtime_repair_outcome:
    | "stabilized"
    | "manual_action_required"
    | null;
  readonly runtime_next_step: string | null;
  readonly projects: readonly Record<string, unknown>[];
};

export type PsItem = {
  readonly Service: string;
  readonly Name: string;
  readonly Status: string;
  readonly Ports: string;
};

export type PsPayload = {
  readonly project: string;
  readonly branch: string | null;
  readonly composeProject: string;
  readonly runtime_ok: boolean;
  readonly runtime_error: string | null;
  readonly runtime_checked_at: string | null;
  readonly runtime_last_ok_at: string | null;
  readonly runtime_reset_at: string | null;
  readonly runtime_reset_count: number;
  readonly runtime_reset_summary: string | null;
  readonly runtime_reset_changes: readonly RuntimeDriftField[];
  readonly runtime_last_repair_at: string | null;
  readonly runtime_repair_action: string | null;
  readonly runtime_repair_outcome:
    | "stabilized"
    | "manual_action_required"
    | null;
  readonly runtime_next_step: string | null;
  readonly items: readonly PsItem[];
};

export interface RuntimeCache {
  refresh(opts: {
    readonly reason: string;
    readonly forceInspect?: boolean;
  }): Promise<void>;
  getProjectsPayload(opts: {
    readonly filter: string | null;
    readonly includeGlobal: boolean;
    readonly includeUnregistered: boolean;
    readonly includeMeta: boolean;
  }): Promise<ProjectsPayload>;
  getPsPayload(opts: {
    readonly composeProject: string;
    readonly project: string;
    readonly branch: string | null;
  }): PsPayload;
  getSnapshot(): RuntimeSnapshot | null;
  getDiagnostics(): RuntimeCacheDiagnostics;
}

export type RuntimeCacheDiagnostics = {
  readonly refreshInFlight: boolean;
  readonly lastRefreshDurationMs: number | null;
  readonly maxRefreshDurationMs: number | null;
  readonly inspectCalls: number;
  readonly inspectIds: number;
  readonly inspectCacheHits: number;
  readonly inspectCacheMisses: number;
  readonly inspectFullRefreshes: number;
};

type QueuedRefresh = {
  readonly reason: string;
  readonly forceInspect: boolean;
};

export function createRuntimeCache(opts: {
  readonly onRefresh?: (snapshot: RuntimeSnapshot) => void;
  readonly deps?: {
    readonly readProjectsRegistry?: typeof readProjectsRegistry;
    readonly buildProjectViews?: typeof buildProjectViews;
    readonly serializeProjectView?: typeof serializeProjectView;
    readonly resolveProjectMeta?: typeof resolveProjectMeta;
  };
}): RuntimeCache {
  const deps = {
    readProjectsRegistry:
      opts.deps?.readProjectsRegistry ?? readProjectsRegistry,
    buildProjectViews: opts.deps?.buildProjectViews ?? buildProjectViews,
    serializeProjectView:
      opts.deps?.serializeProjectView ?? serializeProjectView,
    resolveProjectMeta: opts.deps?.resolveProjectMeta ?? resolveProjectMeta,
  } as const;

  let snapshot: RuntimeSnapshot | null = null;
  let refreshTask: Promise<void> | null = null;
  let pendingRefresh: QueuedRefresh | null = null;
  let lastRefreshDurationMs: number | null = null;
  let maxRefreshDurationMs: number | null = null;
  const inspectCache = createRuntimeInspectCache();
  let health: RuntimeHealth = {
    ok: false,
    error: "runtime_not_checked",
    checkedAtMs: null,
    lastOkAtMs: null,
    lastResetAtMs: null,
    resetCount: 0,
    fingerprint: null,
    identity: null,
    lastResetChanges: [],
    lastResetSummary: null,
    lastRepairAtMs: null,
    lastRepairAction: null,
    lastRepairOutcome: null,
    nextStep: null,
    resetFromNonEmptyRuntime: false,
  };

  const refresh = async ({
    reason,
    forceInspect = true,
  }: {
    readonly reason: string;
    readonly forceInspect?: boolean;
  }): Promise<void> => {
    if (refreshTask) {
      queueRefresh({
        forceInspect,
        reason: `pending:${reason}`,
        priority: "normal",
      });
      await refreshTask;
      return;
    }

    refreshTask = drainRefreshes({
      initialRefresh: { reason, forceInspect },
    });
    await refreshTask;
  };

  async function drainRefreshes(opts: {
    readonly initialRefresh: QueuedRefresh;
  }): Promise<void> {
    let nextRefresh: QueuedRefresh | null = opts.initialRefresh;
    try {
      while (nextRefresh) {
        await runRefresh(nextRefresh);
        nextRefresh = pendingRefresh;
        pendingRefresh = null;
      }
    } catch (error: unknown) {
      pendingRefresh = null;
      throw error;
    } finally {
      refreshTask = null;
    }
  }

  async function runRefresh({
    reason,
    forceInspect,
  }: QueuedRefresh): Promise<void> {
    const startedAtMs = Date.now();
    try {
      const checkedAtMs = Date.now();
      const previousSnapshot = snapshot;
      const runtimeResult = await readRuntimeProjects({
        includeGlobal: true,
        inspectCache,
        forceInspect,
      });
      const refreshed = await resolveRefreshResult({
        checkedAtMs,
        currentHealth: health,
        previousSnapshot,
        reason,
        runtimeResult,
      });
      if (refreshed.repairReason) {
        queueRefresh({
          forceInspect: true,
          reason: refreshed.repairReason,
          priority: "repair",
        });
      }

      let nextSnapshot: RuntimeSnapshot;
      if (runtimeResult.ok) {
        await autoRegisterRuntimeHackProjects({
          runtime: runtimeResult.runtime,
        });
        nextSnapshot = {
          runtime: runtimeResult.runtime,
          updatedAtMs: checkedAtMs,
          health: refreshed.health,
        };
      } else {
        nextSnapshot = {
          runtime: snapshot?.runtime ?? [],
          updatedAtMs: snapshot?.updatedAtMs ?? null,
          health: refreshed.health,
        };
      }

      health = refreshed.health;
      snapshot = nextSnapshot;
      opts.onRefresh?.(nextSnapshot);
    } finally {
      const durationMs = Math.max(0, Date.now() - startedAtMs);
      lastRefreshDurationMs = durationMs;
      maxRefreshDurationMs = Math.max(maxRefreshDurationMs ?? 0, durationMs);
    }
  }

  const getProjectsPayload = async ({
    filter,
    includeGlobal,
    includeUnregistered,
    includeMeta,
  }: {
    readonly filter: string | null;
    readonly includeGlobal: boolean;
    readonly includeUnregistered: boolean;
    readonly includeMeta: boolean;
  }): Promise<ProjectsPayload> => {
    if (!snapshot) {
      await refresh({ reason: "projects" });
    }
    const registry = await deps.readProjectsRegistry();
    const runtime = filterRuntimeProjects({
      runtime: snapshot?.runtime ?? [],
      includeGlobal,
    });
    const views = await deps.buildProjectViews({
      registryProjects: registry.projects,
      runtime,
      runtimeOk: health.ok,
      filter,
      includeUnregistered,
    });

    const runtimeMeta = serializeRuntimeHealth({ health });

    const registryByName = new Map(
      registry.projects.map((p) => [p.name, p] as const)
    );
    const metas = includeMeta
      ? await Promise.all(
          views.map(async (view) => {
            if (view.kind !== "registered") {
              return null;
            }
            const reg = registryByName.get(view.name) ?? null;
            if (!reg) {
              return null;
            }
            try {
              return await deps.resolveProjectMeta({
                projectName: reg.name,
                repoRoot: reg.repoRoot,
                projectDir: reg.projectDir,
                composeFile: resolve(reg.projectDir, PROJECT_COMPOSE_FILENAME),
              });
            } catch {
              return null;
            }
          })
        )
      : [];
    return {
      generated_at: new Date().toISOString(),
      filter,
      include_global: includeGlobal,
      include_unregistered: includeUnregistered,
      include_meta: includeMeta,
      runtime_ok: runtimeMeta.ok,
      runtime_error: runtimeMeta.error,
      runtime_checked_at: runtimeMeta.checkedAt,
      runtime_last_ok_at: runtimeMeta.lastOkAt,
      runtime_reset_at: runtimeMeta.lastResetAt,
      runtime_reset_count: runtimeMeta.resetCount,
      runtime_reset_summary: runtimeMeta.lastResetSummary,
      runtime_reset_changes: runtimeMeta.lastResetChanges,
      runtime_last_repair_at: runtimeMeta.lastRepairAt,
      runtime_repair_action: runtimeMeta.lastRepairAction,
      runtime_repair_outcome: runtimeMeta.lastRepairOutcome,
      runtime_next_step: runtimeMeta.nextStep,
      projects: views.map((view, i) => ({
        ...deps.serializeProjectView(view),
        ...(includeMeta ? { meta: metas[i] ?? null } : {}),
      })),
    };
  };

  const getPsPayload = ({
    composeProject,
    project,
    branch,
  }: {
    readonly composeProject: string;
    readonly project: string;
    readonly branch: string | null;
  }): PsPayload => {
    const runtime = snapshot?.runtime ?? [];
    const match = resolveRuntimeProjectForComposeProject({
      runtime,
      composeProject,
    });
    const items = match ? buildPsItems({ runtime: match }) : [];
    const runtimeMeta = serializeRuntimeHealth({ health });
    return {
      project,
      branch,
      composeProject,
      runtime_ok: runtimeMeta.ok,
      runtime_error: runtimeMeta.error,
      runtime_checked_at: runtimeMeta.checkedAt,
      runtime_last_ok_at: runtimeMeta.lastOkAt,
      runtime_reset_at: runtimeMeta.lastResetAt,
      runtime_reset_count: runtimeMeta.resetCount,
      runtime_reset_summary: runtimeMeta.lastResetSummary,
      runtime_reset_changes: runtimeMeta.lastResetChanges,
      runtime_last_repair_at: runtimeMeta.lastRepairAt,
      runtime_repair_action: runtimeMeta.lastRepairAction,
      runtime_repair_outcome: runtimeMeta.lastRepairOutcome,
      runtime_next_step: runtimeMeta.nextStep,
      items,
    };
  };

  function queueRefresh(opts: {
    readonly forceInspect: boolean;
    readonly reason: string;
    readonly priority: "normal" | "repair";
  }): void {
    if (opts.priority === "repair") {
      pendingRefresh = {
        forceInspect: true,
        reason: opts.reason,
      };
      return;
    }
    if (!pendingRefresh) {
      pendingRefresh = {
        forceInspect: opts.forceInspect,
        reason: opts.reason,
      };
      return;
    }
    if (opts.forceInspect && !pendingRefresh.forceInspect) {
      pendingRefresh = {
        forceInspect: true,
        reason: opts.reason,
      };
    }
  }

  return {
    refresh,
    getProjectsPayload,
    getPsPayload,
    getSnapshot: () => snapshot,
    getDiagnostics: () => {
      const inspect = getRuntimeInspectCacheDiagnostics({
        cache: inspectCache,
      });
      return {
        refreshInFlight: refreshTask !== null,
        lastRefreshDurationMs,
        maxRefreshDurationMs,
        inspectCalls: inspect.inspectCalls,
        inspectIds: inspect.inspectIds,
        inspectCacheHits: inspect.cacheHits,
        inspectCacheMisses: inspect.cacheMisses,
        inspectFullRefreshes: inspect.fullRefreshes,
      };
    },
  };
}

async function resolveRefreshResult(opts: {
  readonly checkedAtMs: number;
  readonly currentHealth: RuntimeHealth;
  readonly previousSnapshot: RuntimeSnapshot | null;
  readonly reason: string;
  readonly runtimeResult: Awaited<ReturnType<typeof readRuntimeProjects>>;
}): Promise<{
  readonly health: RuntimeHealth;
  readonly repairReason: string | null;
}> {
  if (opts.runtimeResult.ok) {
    return await resolveHealthyRefreshResult({
      ...opts,
      runtimeResult: opts.runtimeResult,
    });
  }
  return {
    health: resolveUnavailableRefreshHealth({
      checkedAtMs: opts.checkedAtMs,
      currentHealth: opts.currentHealth,
      reason: opts.reason,
      runtimeError: opts.runtimeResult.error ?? "runtime_unavailable",
    }),
    repairReason: null,
  };
}

async function resolveHealthyRefreshResult(opts: {
  readonly checkedAtMs: number;
  readonly currentHealth: RuntimeHealth;
  readonly previousSnapshot: RuntimeSnapshot | null;
  readonly reason: string;
  readonly runtimeResult: Extract<
    Awaited<ReturnType<typeof readRuntimeProjects>>,
    { readonly ok: true }
  >;
}): Promise<{
  readonly health: RuntimeHealth;
  readonly repairReason: string | null;
}> {
  const identityResult = await readRuntimeIdentity();
  const nextHealth = {
    ...opts.currentHealth,
    ok: true,
    error: null,
    checkedAtMs: opts.checkedAtMs,
    lastOkAtMs: opts.checkedAtMs,
  } satisfies RuntimeHealth;
  if (!identityResult.ok) {
    return {
      health: nextHealth,
      repairReason: null,
    };
  }

  const identity = identityResult.identity;
  const fingerprint = buildRuntimeFingerprint({ identity });
  const drift = detectRuntimeDrift({
    previous: opts.currentHealth.identity,
    current: identity,
  });
  const resetDetected =
    opts.currentHealth.fingerprint !== null &&
    fingerprint !== opts.currentHealth.fingerprint;
  if (resetDetected) {
    return resolveResetRefreshHealth({
      ...opts,
      drift,
      fingerprint,
      identity,
    });
  }
  if (isAutoRepairReason({ reason: opts.reason })) {
    return {
      health: resolveStableAutoRepairHealth({
        ...opts,
        fingerprint,
        identity,
      }),
      repairReason: null,
    };
  }
  return {
    health: {
      ...nextHealth,
      fingerprint,
      identity,
    },
    repairReason: null,
  };
}

function resolveResetRefreshHealth(opts: {
  readonly checkedAtMs: number;
  readonly currentHealth: RuntimeHealth;
  readonly previousSnapshot: RuntimeSnapshot | null;
  readonly reason: string;
  readonly runtimeResult: Extract<
    Awaited<ReturnType<typeof readRuntimeProjects>>,
    { readonly ok: true }
  >;
  readonly drift: ReturnType<typeof detectRuntimeDrift>;
  readonly fingerprint: string;
  readonly identity: RuntimeIdentity;
}): {
  readonly health: RuntimeHealth;
  readonly repairReason: string | null;
} {
  const resetFromNonEmptyRuntime =
    countRuntimeContainers({
      runtime: opts.previousSnapshot?.runtime ?? [],
    }) > 0;
  const health = {
    ...opts.currentHealth,
    ok: true,
    error: null,
    checkedAtMs: opts.checkedAtMs,
    lastOkAtMs: opts.checkedAtMs,
    fingerprint: opts.fingerprint,
    identity: opts.identity,
    resetCount: opts.currentHealth.resetCount + 1,
    lastResetAtMs: opts.checkedAtMs,
    lastResetChanges: opts.drift.changed,
    lastResetSummary: opts.drift.summary,
    lastRepairAtMs: opts.checkedAtMs,
    lastRepairAction: "refresh_runtime_snapshot",
    lastRepairOutcome: isAutoRepairReason({ reason: opts.reason })
      ? "manual_action_required"
      : null,
    nextStep: isAutoRepairReason({ reason: opts.reason })
      ? describeRepairGuidance({
          hadRuntimeBeforeReset: resetFromNonEmptyRuntime,
          runtime: opts.runtimeResult.runtime,
          reason: "still_resetting",
        })
      : null,
    resetFromNonEmptyRuntime,
  } satisfies RuntimeHealth;
  return {
    health,
    repairReason: isAutoRepairReason({ reason: opts.reason })
      ? null
      : `auto-repair:${opts.reason}`,
  };
}

function resolveStableAutoRepairHealth(opts: {
  readonly checkedAtMs: number;
  readonly currentHealth: RuntimeHealth;
  readonly runtimeResult: Extract<
    Awaited<ReturnType<typeof readRuntimeProjects>>,
    { readonly ok: true }
  >;
  readonly fingerprint: string;
  readonly identity: RuntimeIdentity;
}): RuntimeHealth {
  const nextStep = describeRepairGuidance({
    hadRuntimeBeforeReset: opts.currentHealth.resetFromNonEmptyRuntime,
    runtime: opts.runtimeResult.runtime,
    reason: "post_reset",
  });
  return {
    ...opts.currentHealth,
    ok: true,
    error: null,
    checkedAtMs: opts.checkedAtMs,
    lastOkAtMs: opts.checkedAtMs,
    fingerprint: opts.fingerprint,
    identity: opts.identity,
    lastRepairAtMs: opts.checkedAtMs,
    lastRepairAction: "refresh_runtime_snapshot",
    lastRepairOutcome: nextStep ? "manual_action_required" : "stabilized",
    nextStep,
  };
}

function resolveUnavailableRefreshHealth(opts: {
  readonly checkedAtMs: number;
  readonly currentHealth: RuntimeHealth;
  readonly reason: string;
  readonly runtimeError: string;
}): RuntimeHealth {
  const nextHealth = {
    ...opts.currentHealth,
    ok: false,
    error: opts.runtimeError,
    checkedAtMs: opts.checkedAtMs,
  } satisfies RuntimeHealth;
  if (!isAutoRepairReason({ reason: opts.reason })) {
    return nextHealth;
  }
  return {
    ...nextHealth,
    lastRepairAtMs: opts.checkedAtMs,
    lastRepairAction: "refresh_runtime_snapshot",
    lastRepairOutcome: "manual_action_required",
    nextStep: describeRepairGuidance({
      hadRuntimeBeforeReset: opts.currentHealth.resetFromNonEmptyRuntime,
      runtime: [],
      reason: "runtime_unavailable",
    }),
  };
}

function buildPsItems(opts: { readonly runtime: RuntimeProject }): PsItem[] {
  const out: PsItem[] = [];
  for (const service of opts.runtime.services.values()) {
    for (const container of service.containers) {
      out.push({
        Service: service.service,
        Name: container.name,
        Status: container.status,
        Ports: container.ports,
      });
    }
  }
  return out.sort((a, b) => {
    const serviceCmp = a.Service.localeCompare(b.Service);
    if (serviceCmp !== 0) {
      return serviceCmp;
    }
    return a.Name.localeCompare(b.Name);
  });
}

/**
 * Docker compose project names can be normalized by the engine (for example,
 * stripping unsupported punctuation) before labels are applied on containers.
 * Resolve runtime projects with exact match first, then a normalized fallback
 * to keep `hack ps --json` stable across historical compose naming variants.
 */
function resolveRuntimeProjectForComposeProject(opts: {
  readonly runtime: readonly RuntimeProject[];
  readonly composeProject: string;
}): RuntimeProject | null {
  const exact = opts.runtime.find(
    (project) => project.project === opts.composeProject
  );
  if (exact) {
    return exact;
  }

  const targetKey = normalizeComposeProjectLookupKey(opts.composeProject);
  if (targetKey.length === 0) {
    return null;
  }

  const matches = opts.runtime.filter(
    (project) => normalizeComposeProjectLookupKey(project.project) === targetKey
  );
  if (matches.length === 1) {
    return matches[0] ?? null;
  }
  return null;
}

function normalizeComposeProjectLookupKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "");
}

function serializeRuntimeHealth(opts: { readonly health: RuntimeHealth }): {
  readonly ok: boolean;
  readonly error: string | null;
  readonly checkedAt: string | null;
  readonly lastOkAt: string | null;
  readonly lastResetAt: string | null;
  readonly resetCount: number;
  readonly lastResetSummary: string | null;
  readonly lastResetChanges: readonly RuntimeDriftField[];
  readonly lastRepairAt: string | null;
  readonly lastRepairAction: string | null;
  readonly lastRepairOutcome: "stabilized" | "manual_action_required" | null;
  readonly nextStep: string | null;
} {
  const checkedAt = toIso({ ms: opts.health.checkedAtMs });
  const lastOkAt = toIso({ ms: opts.health.lastOkAtMs });
  const lastResetAt = toIso({ ms: opts.health.lastResetAtMs });
  const lastRepairAt = toIso({ ms: opts.health.lastRepairAtMs });
  return {
    ok: opts.health.ok,
    error: opts.health.error,
    checkedAt,
    lastOkAt,
    lastResetAt,
    resetCount: opts.health.resetCount,
    lastResetSummary: opts.health.lastResetSummary,
    lastResetChanges: opts.health.lastResetChanges,
    lastRepairAt,
    lastRepairAction: opts.health.lastRepairAction,
    lastRepairOutcome: opts.health.lastRepairOutcome,
    nextStep: opts.health.nextStep,
  };
}

function toIso(opts: { readonly ms: number | null }): string | null {
  if (typeof opts.ms !== "number") {
    return null;
  }
  return new Date(opts.ms).toISOString();
}

function isAutoRepairReason(opts: { readonly reason: string }): boolean {
  return opts.reason.startsWith("auto-repair:");
}

function describeRepairGuidance(opts: {
  readonly hadRuntimeBeforeReset: boolean;
  readonly runtime: readonly RuntimeProject[];
  readonly reason: "post_reset" | "runtime_unavailable" | "still_resetting";
}): string | null {
  const currentContainers = countRuntimeContainers({ runtime: opts.runtime });

  if (opts.reason === "runtime_unavailable") {
    return "Docker is still unavailable. Run `hack doctor` and retry your command.";
  }

  if (currentContainers === 0 && opts.hadRuntimeBeforeReset) {
    return "Docker restarted and cleared previously detected project containers. Restart affected projects with `hack up`.";
  }

  if (opts.reason === "still_resetting") {
    return "Docker runtime identity is still changing. Run `hack doctor` and retry your command.";
  }

  return null;
}

function countRuntimeContainers(opts: {
  readonly runtime: readonly RuntimeProject[];
}): number {
  let count = 0;
  for (const project of opts.runtime) {
    for (const service of project.services.values()) {
      count += service.containers.length;
    }
  }
  return count;
}
