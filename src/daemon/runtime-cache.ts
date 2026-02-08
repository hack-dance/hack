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
  filterRuntimeProjects,
  readRuntimeProjects,
} from "../lib/runtime-projects.ts";
import {
  buildRuntimeFingerprint,
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
  readonly items: readonly PsItem[];
};

export interface RuntimeCache {
  refresh(opts: { readonly reason: string }): Promise<void>;
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
}

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
  let pending = false;
  let health: RuntimeHealth = {
    ok: false,
    error: "runtime_not_checked",
    checkedAtMs: null,
    lastOkAtMs: null,
    lastResetAtMs: null,
    resetCount: 0,
    fingerprint: null,
  };

  const refresh = async ({
    reason,
  }: {
    readonly reason: string;
  }): Promise<void> => {
    if (refreshTask) {
      pending = true;
      await refreshTask;
      return;
    }

    refreshTask = (async () => {
      const checkedAtMs = Date.now();
      const runtimeResult = await readRuntimeProjects({ includeGlobal: true });
      let nextHealth: RuntimeHealth = {
        ...health,
        checkedAtMs,
      };

      if (runtimeResult.ok) {
        const identityResult = await readRuntimeIdentity();
        let fingerprint = health.fingerprint;
        let resetCount = health.resetCount;
        let lastResetAtMs = health.lastResetAtMs;
        if (identityResult.ok) {
          fingerprint = buildRuntimeFingerprint({
            identity: identityResult.identity,
          });
          if (health.fingerprint && fingerprint !== health.fingerprint) {
            resetCount += 1;
            lastResetAtMs = checkedAtMs;
          }
        }
        nextHealth = {
          ...nextHealth,
          ok: true,
          error: null,
          lastOkAtMs: checkedAtMs,
          fingerprint,
          resetCount,
          lastResetAtMs,
        };
      } else {
        nextHealth = {
          ...nextHealth,
          ok: false,
          error: runtimeResult.error ?? "runtime_unavailable",
        };
      }

      health = nextHealth;

      if (runtimeResult.ok) {
        await autoRegisterRuntimeHackProjects({
          runtime: runtimeResult.runtime,
        });
        snapshot = {
          runtime: runtimeResult.runtime,
          updatedAtMs: checkedAtMs,
          health,
        };
      } else {
        snapshot = {
          runtime: snapshot?.runtime ?? [],
          updatedAtMs: snapshot?.updatedAtMs ?? null,
          health,
        };
      }

      opts.onRefresh?.(snapshot);
    })();

    await refreshTask;
    refreshTask = null;

    if (pending) {
      pending = false;
      await refresh({ reason: `pending:${reason}` });
    }
  };

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
    const match = runtime.find((p) => p.project === composeProject);
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
      items,
    };
  };

  return {
    refresh,
    getProjectsPayload,
    getPsPayload,
    getSnapshot: () => snapshot,
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

function serializeRuntimeHealth(opts: { readonly health: RuntimeHealth }): {
  readonly ok: boolean;
  readonly error: string | null;
  readonly checkedAt: string | null;
  readonly lastOkAt: string | null;
  readonly lastResetAt: string | null;
  readonly resetCount: number;
} {
  const checkedAt = toIso({ ms: opts.health.checkedAtMs });
  const lastOkAt = toIso({ ms: opts.health.lastOkAtMs });
  const lastResetAt = toIso({ ms: opts.health.lastResetAtMs });
  return {
    ok: opts.health.ok,
    error: opts.health.error,
    checkedAt,
    lastOkAt,
    lastResetAt,
    resetCount: opts.health.resetCount,
  };
}

function toIso(opts: { readonly ms: number | null }): string | null {
  if (typeof opts.ms !== "number") {
    return null;
  }
  return new Date(opts.ms).toISOString();
}
