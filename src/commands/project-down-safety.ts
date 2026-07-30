import { CliUsageError } from "../cli/command.ts";
import { HackCliError } from "../lib/cli-result.ts";
import {
  type DisposableCacheVolumeCandidate,
  findMountedNamedVolumeCandidates,
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

export function reconcileImplicitDownBranch(opts: {
  readonly baseProjectName: string;
  readonly branch: string;
  readonly projectDir: string;
  readonly runtime: readonly RuntimeProject[];
  readonly writeNotice: (notice: DownSafetyNotice) => void;
}): string | null {
  const resolution = resolveImplicitDownTarget({
    baseComposeProject: opts.baseProjectName,
    currentProjectDir: opts.projectDir,
    inferredBranch: opts.branch,
    runtime: opts.runtime,
  });
  if (resolution.kind === "inferred") {
    return resolution.branch;
  }
  if (resolution.kind === "retargeted") {
    opts.writeNotice({
      level: "warn",
      message: `The current Git branch resolves to "${opts.baseProjectName}--${opts.branch}", but this worktree owns existing runtime "${resolution.composeProject}" (${resolution.states.join(", ") || "state unknown"}). Targeting the owned runtime; pass --branch <name> to override.`,
    });
    return resolution.branch;
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
}): Promise<readonly DisposableCacheVolumeCandidate[]> {
  const observed = findMountedNamedVolumeCandidates({
    composeProject: opts.composeProject,
    currentProjectDir: opts.projectDir,
    runtime: opts.runtime,
  });
  const verified = await verifyDisposableCacheVolumes({
    composeProject: opts.composeProject,
    candidates: observed,
  });
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
  return confirmed ? verified : [];
}
