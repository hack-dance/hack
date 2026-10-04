import { CliUsageError } from "../cli/command.ts";
import { resolveEffectiveBranch } from "../lib/branches.ts";
import { emitCliResult, okResult } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";
import {
  findProjectContext,
  readProjectConfig,
  resolveWorktreeAutoBranch,
  sanitizeBranchSlug,
} from "../lib/project.ts";
import { inspectNativeProjectGraph } from "./native-project-inspect.ts";
import {
  loadNativeProjectRun,
  type NativeProjectRun,
  type NativeProjectRunScope,
} from "./native-project-run.ts";
import type {
  invokeNativeRuntime,
  NativeRuntimeSelection,
} from "./native-runtime-client.ts";

const PHASES = new Set([
  "ready-observed",
  "failed-retained",
  "cleanup-intent",
  "stopped-data-retained",
]);
const KINDS = new Set([
  "partial_shutdown",
  "interrupted_startup_candidate",
  "unclassified",
]);
const GUIDANCE =
  "No uncertain stop was replayed. Preserve receipts and run mappings. Pending cleanup requires explicit owned recovery; review every graph sharing the pool before stopping it, and do not roll over its boot repeatedly.";

function refused(): Error {
  return new Error(
    "Native cleanup inspection is unconfirmed; owned mapping or observations are unavailable or changed. Values omitted; no recovery was requested."
  );
}

function verifiedSnapshot(value: unknown, run: NativeProjectRun) {
  if (
    !(
      isRecord(value) &&
      isRecord(value.receipt) &&
      isRecord(value.observations)
    ) ||
    value.journal_incomplete !== false
  ) {
    throw refused();
  }
  const { receipt, observations } = value;
  if (
    receipt.run !== run.run ||
    receipt.owner !== run.owner ||
    receipt.namespace !== run.namespace ||
    receipt.plan_id !== run.planId ||
    typeof receipt.phase !== "string" ||
    !PHASES.has(receipt.phase) ||
    !isRecord(receipt.resources)
  ) {
    throw refused();
  }
  return {
    receipt,
    observations,
    resources: receipt.resources,
    phase: receipt.phase,
    hint: value.pending_cleanup,
  };
}

function containerState(
  value: unknown
): "running" | "exited" | "created" | "absent" {
  switch (value) {
    case "running":
    case "exited":
    case "created":
    case "absent":
      return value;
    default:
      throw refused();
  }
}

function observedCounts(
  resources: Record<string, unknown>,
  observations: Record<string, unknown>
) {
  const counts = {
    running: 0,
    exited: 0,
    created: 0,
    absent: 0,
    volumesPresent: 0,
    volumesAbsent: 0,
  };
  for (const [key, resource] of Object.entries(resources)) {
    const observation = observations[key];
    if (!(isRecord(resource) && isRecord(observation))) {
      throw refused();
    }
    if (resource.kind === "container") {
      counts[containerState(observation.state)]++;
    }
    if (resource.kind === "volume") {
      switch (observation.state) {
        case "present":
          counts.volumesPresent++;
          break;
        case "absent":
          counts.volumesAbsent++;
          break;
        default:
          throw refused();
      }
    }
  }
  if (counts.running + counts.exited + counts.created + counts.absent > 32) {
    throw refused();
  }
  return counts;
}

function cleanupKind(pending: boolean, hint: unknown): string {
  if (!pending) {
    return "not_pending";
  }
  if (
    isRecord(hint) &&
    hint.version === 1 &&
    typeof hint.kind === "string" &&
    KINDS.has(hint.kind)
  ) {
    return hint.kind;
  }
  return "unclassified";
}

/** Read-only diagnostics for one mapped graph. A presentation hint is never a
 * recovery selection, retained-data acknowledgement or authority to stop a pool.
 */
export async function inspectNativeProjectCleanup(opts: {
  readonly scope: NativeProjectRunScope;
  readonly runtime: NativeRuntimeSelection;
  readonly invoke?: typeof invokeNativeRuntime;
}) {
  const run = await loadNativeProjectRun(opts.scope);
  if (!run) {
    return {
      state: "not_started",
      pending: false,
      guidance: "No mapped native graph; no recovery was requested.",
    } as const;
  }
  const value = await inspectNativeProjectGraph({
    runtime: opts.runtime,
    projectRoot: opts.scope.projectRoot,
    run: run.run,
    invoke: opts.invoke,
  });
  const { receipt, observations, resources, phase, hint } = verifiedSnapshot(
    value,
    run
  );
  const pending =
    phase === "cleanup-intent" &&
    isRecord(receipt.relay_cleanup) &&
    receipt.relay_cleanup.phase === "pending";
  return {
    state: cleanupKind(pending, hint),
    pending,
    run: run.run,
    phase,
    counts: observedCounts(resources, observations),
    guidance: pending
      ? GUIDANCE
      : "No pending retaining cleanup was observed. This does not establish application readiness.",
  } as const;
}

export async function runNativeProjectCleanupCommand(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly startDir: string;
  readonly branch?: string;
  readonly json: boolean;
}): Promise<number> {
  const project = await findProjectContext(opts.startDir);
  if (!project) {
    throw new CliUsageError(
      "Native cleanup inspection requires a Hack project."
    );
  }
  const config = await readProjectConfig(project);
  if (config.parseError) {
    throw new CliUsageError(
      "Native cleanup inspection requires valid project configuration."
    );
  }
  const explicit = opts.branch?.trim();
  if (explicit !== undefined && !explicit) {
    throw new CliUsageError("--branch requires a nonempty instance selection.");
  }
  const selected = await resolveEffectiveBranch({
    explicitBranch: explicit ? sanitizeBranchSlug(explicit) || "branch" : null,
    projectRoot: project.projectRoot,
    autoBranchEnabled: resolveWorktreeAutoBranch(config),
  });
  if (selected.source === "detached-worktree") {
    throw new CliUsageError(
      "Detached worktree cleanup inspection requires --branch <name>."
    );
  }
  const data = await inspectNativeProjectCleanup({
    runtime: opts.runtime,
    scope: {
      ...project,
      nativeHome: opts.runtime.home,
      branch: selected.branch,
    },
  });
  if (opts.json) {
    emitCliResult({ result: okResult({ data }) });
  } else {
    process.stdout.write(`Native cleanup: ${data.state}.\n${data.guidance}\n`);
  }
  return data.pending ? 1 : 0;
}
