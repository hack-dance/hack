import { posix } from "node:path";
import { HackCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";
import {
  type LocalDirectoriesPlan,
  planProjectLocalDirectories,
} from "../lib/local-directories.ts";

/**
 * `localDirectories` on the native backend (HACK-2358): the same plan the
 * Compose override uses, applied to the native Compose model before
 * adaptation. Each planned entry becomes one declared named volume, owned by
 * the native run like any other volume (kept across `hack down`, deleted by
 * `hack down --remove-data`), mounted at each planned container path. The
 * volumes live on the guest disk, so installs and builds there never cross
 * the host share.
 */

/** What `prepareNativeProjectInput` records from `.hack/hack.config.json`. */
export type NativeLocalDirectories = {
  readonly projectRoot: string;
  readonly composeFile: string;
  readonly entries: readonly string[];
  /** Set when the setting is invalid; applying it refuses. */
  readonly error?: string;
};

function normalizeTarget(target: string): string {
  const normalized = posix.normalize(target);
  return normalized.length > 1 && normalized.endsWith("/")
    ? normalized.slice(0, -1)
    : normalized;
}

/** The literal target of one authored mount entry, or null when it has none. */
function authoredTarget(value: unknown): string | null {
  if (typeof value === "string") {
    const parts = value.replace(/\$\{[^}]*\}/g, "\u0000").split(":");
    const target = parts.length === 1 ? parts[0] : parts[1];
    return target && !target.includes("\u0000") && !target.includes("$")
      ? normalizeTarget(target)
      : null;
  }
  return isRecord(value) && typeof value.target === "string"
    ? normalizeTarget(value.target)
    : null;
}

/**
 * Writes a plan into a parsed native Compose model, in place. The planner
 * only plans a target that is free or holds a bind of that same checkout
 * directory, so an authored entry at a planned target is that bind: it is
 * removed, because the runtime refuses two mounts at one target.
 */
export function applyLocalDirectoriesPlan(opts: {
  readonly compose: Record<string, unknown>;
  readonly plan: LocalDirectoriesPlan;
}): void {
  const services = opts.compose.services;
  if (!isRecord(services)) {
    return;
  }
  const declared: Record<string, unknown> = isRecord(opts.compose.volumes)
    ? opts.compose.volumes
    : {};
  let added = false;
  for (const [name, mounts] of Object.entries(opts.plan.services)) {
    const spec = services[name];
    if (!(isRecord(spec) && mounts.length > 0)) {
      continue;
    }
    const targets = new Set(mounts.map((mount) => mount.target));
    const existing = Array.isArray(spec.volumes) ? spec.volumes : [];
    spec.volumes = [
      ...existing.filter((value) => {
        const target = authoredTarget(value);
        return target === null || !targets.has(target);
      }),
      ...mounts.map((mount) => ({
        type: "volume",
        source: mount.volume,
        target: mount.target,
        ...(mount.readOnly ? { read_only: true } : {}),
      })),
    ];
    for (const mount of mounts) {
      // Plain declarations: native warns on (and never applies) labels.
      if (!Object.hasOwn(declared, mount.volume)) {
        declared[mount.volume] = {};
        added = true;
      }
    }
  }
  if (added) {
    opts.compose.volumes = declared;
  }
}

/** The plan without mounts at `targets`; a service left with none drops out. */
function withoutTargets(
  plan: LocalDirectoriesPlan,
  targets: ReadonlySet<string> | undefined
): LocalDirectoriesPlan {
  if (!targets || targets.size === 0) {
    return plan;
  }
  const services: Record<string, LocalDirectoriesPlan["services"][string]> = {};
  for (const [name, mounts] of Object.entries(plan.services)) {
    const kept = mounts.filter((mount) => !targets.has(mount.target));
    if (kept.length > 0) {
      services[name] = kept;
    }
  }
  return { ...plan, services };
}

/**
 * Applies the recorded setting to a parsed native Compose model and returns
 * the notices `up` prints. An invalid setting refuses with `E_CONFIG_INVALID`
 * (a backstop: `up` and `restart` refuse it first).
 */
export async function applyNativeLocalDirectories(opts: {
  readonly compose: Record<string, unknown>;
  readonly selection: NativeLocalDirectories | undefined;
  /** Container paths another native mechanism owns (a workspace cache). */
  readonly leaveTargets?: ReadonlySet<string>;
}): Promise<string[]> {
  const selection = opts.selection;
  if (selection?.error) {
    throw new HackCliError({
      code: "E_CONFIG_INVALID",
      message: selection.error,
    });
  }
  if (!selection || selection.entries.length === 0) {
    return [];
  }
  const { plan, notices } = await planProjectLocalDirectories({
    projectRoot: selection.projectRoot,
    composeFile: selection.composeFile,
    compose: opts.compose,
    entries: selection.entries,
  });
  applyLocalDirectoriesPlan({
    compose: opts.compose,
    plan: withoutTargets(plan, opts.leaveTargets),
  });
  return notices;
}
