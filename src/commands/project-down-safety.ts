import { CliUsageError } from "../cli/command.ts";
import { HackCliError } from "../lib/cli-result.ts";
import {
  type CacheVolumeKept,
  type DisposableCacheVolumeCandidate,
  findMountedNamedVolumeCandidates,
  foreignCacheMounts,
  listComposeVolumeNames,
  type MountedNamedVolumeCandidate,
  verifyDisposableCacheVolumes,
} from "../lib/disposable-cache-volumes.ts";
import { confirmSafe } from "../lib/interactivity.ts";
import type { RuntimeProject } from "../lib/runtime-projects.ts";
import { resolveImplicitDownTarget } from "../lib/worktree-runtime-target.ts";
import { display } from "../ui/display.ts";

export type DownSafetyNotice = {
  readonly level: "info" | "warn";
  readonly message: string;
};

export function reconcileImplicitDownTarget(opts: {
  readonly baseProjectName: string;
  readonly branch: string;
  readonly projectDir: string;
  readonly runtime: readonly RuntimeProject[];
  readonly writeNotice: (notice: DownSafetyNotice) => void;
}) {
  const resolution = resolveImplicitDownTarget({
    baseComposeProject: opts.baseProjectName,
    currentProjectDir: opts.projectDir,
    inferredBranch: opts.branch,
    runtime: opts.runtime,
  });
  if (resolution.kind === "inferred") {
    return resolution;
  }
  if (resolution.kind === "retargeted") {
    opts.writeNotice({
      level: "warn",
      message: `The current Git branch resolves to "${opts.baseProjectName}--${opts.branch}", but this worktree owns existing runtime "${resolution.composeProject}" (${resolution.states.join(", ") || "state unknown"}). Targeting the owned runtime; pass --branch <name> to override.`,
    });
    return resolution;
  }

  const choices = resolution.targets
    .map(
      (target) =>
        `"${target.composeProject}" (${target.states.join(", ") || "state unknown"})`
    )
    .join(", ");
  throw new CliUsageError(
    `This worktree owns multiple runtime instances: ${choices}. Refusing an ambiguous implicit down; pass --branch <name> to select one explicitly.`
  );
}

export async function prepareDisposableCachePrune(opts: {
  readonly composeProject: string;
  readonly json: boolean;
  readonly projectDir: string;
  readonly runtime: readonly RuntimeProject[];
  readonly writeNotice: (notice: DownSafetyNotice) => void;
  readonly yes: boolean;
  readonly kept: CacheVolumeKept[];
}): Promise<readonly DisposableCacheVolumeCandidate[]> {
  const selection = { ...opts, currentProjectDir: opts.projectDir };
  const names = await listComposeVolumeNames(opts.composeProject);
  if (names === null) {
    opts.writeNotice({
      level: "warn",
      message:
        "Could not list Compose volumes. Only current mounts can be checked.",
    });
  }
  const mountedElsewhere = foreignCacheMounts(selection);
  const selected = new Map<string, MountedNamedVolumeCandidate>(
    names?.map((name) => [name, { name, destinations: [], services: [] }])
  );
  for (const mount of findMountedNamedVolumeCandidates(selection)) {
    selected.set(mount.name, mount);
  }
  const candidates = [...selected.values()].filter((candidate) => {
    if (!mountedElsewhere.has(candidate.name)) {
      return true;
    }
    opts.kept.push({ name: candidate.name, reason: "mounted-elsewhere" });
    return false;
  });
  const verified = await verifyDisposableCacheVolumes({
    composeProject: opts.composeProject,
    candidates,
    kept: opts.kept,
  });
  const detached = opts.kept.filter(({ reason }) => reason === "no-live-mount");
  if (detached.length > 0) {
    opts.writeNotice({
      level: "info",
      message: `Kept volumes without current mounts: ${detached.map(({ name }) => name).join(", ")}. For disposable caches, run down --prune-caches before stopping, or add hack.cache.disposable=true to the volume.`,
    });
  }
  if (verified.length === 0) {
    opts.writeNotice({
      level: "info",
      message: `No removable Compose-owned disposable cache volumes found for "${opts.composeProject}".`,
    });
    return [];
  }
  if (opts.yes) {
    return verified;
  }
  if (opts.json) {
    throw new HackCliError({
      code: "E_INTERACTIVE_REQUIRED",
      message: `Removing ${verified.length} disposable cache volume(s) requires confirmation. Re-run with --prune-caches --yes.`,
      detail: {
        composeProject: opts.composeProject,
        volumes: verified.map((candidate) => candidate.name),
      },
    });
  }

  await display.section("Disposable cache volumes");
  await display.table({
    columns: ["Volume", "Selection", "Services", "Mount destinations"],
    rows: verified.map((candidate) => [
      candidate.name,
      candidate.reason === "explicit-label"
        ? "hack.cache.disposable=true"
        : ".next destination",
      candidate.services.join(", "),
      candidate.destinations.join(", "),
    ]),
  });
  const confirmed = await confirmSafe({
    message: `Remove these ${verified.length} Compose-owned disposable cache volume(s) after the project stops?`,
    initialValue: false,
    nonInteractive: "fail",
    hint: "Re-run with --prune-caches --yes to confirm non-interactively.",
  });
  if (!confirmed) {
    opts.kept.push(
      ...verified.map(({ name }) => ({
        name,
        reason: "not-confirmed" as const,
      }))
    );
  }
  return confirmed ? verified : [];
}
