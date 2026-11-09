import { CliUsageError } from "../cli/command.ts";
import { resolveEffectiveBranch } from "../lib/branches.ts";
import { emitCliResult, okResult } from "../lib/cli-result.ts";
import {
  findProjectContext,
  readProjectConfig,
  resolveWorktreeAutoBranch,
  sanitizeBranchSlug,
} from "../lib/project.ts";
import type {
  NativeProjectRunForeignHomeInspection,
  NativeProjectRunForeignHomeRelease,
  NativeProjectRunScope,
} from "./native-project-run.ts";
import {
  describeNativeForeignHomeMapping,
  inspectNativeProjectRunMapping,
  nativeForeignHomeReleaseCommand,
  recoverNativeProjectRunFilesystem,
  releaseNativeProjectRunForeignHome,
} from "./native-project-run.ts";
import type { NativeRuntimeSelection } from "./native-runtime-client.ts";

const SELECTION = /^[a-f0-9]{64}$/;

type Selection =
  | { readonly action: "inspect" }
  | { readonly action: "repair"; readonly expectSelection: string }
  | { readonly action: "release"; readonly expectSelection: string };

/**
 * A device rebind and a foreign-home release are explicit selected metadata changes,
 * never automatic Doctor fixes; each requires the exact inspected selection.
 */
export function parseNativeRunMappingRecoveryOptions(opts: {
  readonly action?: string;
  readonly expectSelection?: string;
  readonly acceptLegacyDeviceRebind?: boolean;
  readonly branch?: string;
  readonly otherOptions: boolean;
}): Selection | null {
  if (opts.action === undefined) {
    if (
      opts.expectSelection !== undefined ||
      opts.acceptLegacyDeviceRebind ||
      opts.branch !== undefined
    ) {
      throw new CliUsageError(
        "Run-mapping selection and branch options require --native-run-mapping inspect|repair|release."
      );
    }
    return null;
  }
  if (opts.otherOptions) {
    throw new CliUsageError(
      "--native-run-mapping cannot be combined with other Doctor repair or browser options."
    );
  }
  if (opts.action === "inspect") {
    if (opts.expectSelection !== undefined || opts.acceptLegacyDeviceRebind) {
      throw new CliUsageError(
        "Run-mapping inspection is read-only; omit repair selection and acceptance flags."
      );
    }
    return { action: "inspect" };
  }
  if (opts.action === "release") {
    if (
      opts.acceptLegacyDeviceRebind ||
      !opts.expectSelection ||
      !SELECTION.test(opts.expectSelection)
    ) {
      throw new CliUsageError(
        "Run-mapping release requires --native-run-mapping release --expect-selection <64-hex> and no device-rebind acceptance."
      );
    }
    return { action: "release", expectSelection: opts.expectSelection };
  }
  if (
    opts.action !== "repair" ||
    !opts.acceptLegacyDeviceRebind ||
    !opts.expectSelection ||
    opts.expectSelection.length !== 64 ||
    !SELECTION.test(opts.expectSelection)
  ) {
    throw new CliUsageError(
      "Run-mapping repair requires --native-run-mapping repair --expect-selection <64-hex> --accept-legacy-device-rebind."
    );
  }
  return { action: "repair", expectSelection: opts.expectSelection };
}

/** Repair only mapping scope metadata. Native graph, socket and data authority remain unchanged. */
export async function runNativeProjectMappingCommand(opts: {
  readonly selection: Selection;
  readonly startDir: string;
  readonly branch?: string;
  readonly runtime: NativeRuntimeSelection;
  readonly json: boolean;
}): Promise<number> {
  const project = await findProjectContext(opts.startDir);
  if (!project) {
    throw new CliUsageError(
      "Native run-mapping recovery requires a Hack project."
    );
  }
  const cfg = await readProjectConfig(project);
  if (cfg.parseError) {
    throw new CliUsageError(
      "Native run-mapping recovery requires valid project configuration."
    );
  }
  const explicit = opts.branch?.trim();
  if (explicit !== undefined && explicit.length === 0) {
    throw new CliUsageError("--branch requires a nonempty instance selection.");
  }
  const selected = await resolveEffectiveBranch({
    explicitBranch: explicit ? sanitizeBranchSlug(explicit) || "branch" : null,
    projectRoot: project.projectRoot,
    autoBranchEnabled: resolveWorktreeAutoBranch(cfg),
  });
  if (selected.source === "detached-worktree") {
    throw new CliUsageError(
      "Detached worktree recovery requires --branch <name>."
    );
  }
  const scope = {
    projectRoot: project.projectRoot,
    projectDir: project.projectDir,
    nativeHome: opts.runtime.home,
    branch: selected.branch,
  };
  const data = await selectedMappingAction({
    selection: opts.selection,
    scope,
    runtime: opts.runtime,
  });
  if (opts.json) {
    emitCliResult({ result: okResult({ data }) });
  } else {
    process.stdout.write(
      mappingText({
        data,
        action: opts.selection.action,
        branch: selected.branch,
      })
    );
  }
  return 0;
}

function selectedMappingAction(opts: {
  readonly selection: Selection;
  readonly scope: NativeProjectRunScope;
  readonly runtime: NativeRuntimeSelection;
}) {
  if (opts.selection.action === "inspect") {
    return inspectNativeProjectRunMapping({
      scope: opts.scope,
      runtime: opts.runtime,
    });
  }
  if (opts.selection.action === "release") {
    return releaseNativeProjectRunForeignHome({
      scope: opts.scope,
      expectSelection: opts.selection.expectSelection,
    });
  }
  return recoverNativeProjectRunFilesystem({
    scope: opts.scope,
    runtime: opts.runtime,
    expectSelection: opts.selection.expectSelection,
    acceptLegacyDeviceRebind: true,
  });
}

function mappingText(opts: {
  readonly data: Awaited<ReturnType<typeof selectedMappingAction>>;
  readonly action: Selection["action"];
  readonly branch: string | null;
}): string {
  const { data } = opts;
  if ("state" in data && data.state === "foreign-home") {
    return foreignHomeText(data, opts.branch);
  }
  if ("state" in data) {
    return (
      `Native run mapping is current: branch=${opts.branch ?? "base"}, run=${data.run.run}\n` +
      `graph=${data.graph ? `${data.graph.phase}, ownership ${data.graph.ownershipMatches ? "matches" : "differs"}` : "unavailable"}\n` +
      "No repair is needed. Graph recovery, retained-data readback and application readiness require separate verification.\n"
    );
  }
  return (
    `Native run mapping ${opts.action === "repair" ? "repaired" : "inspected"}: branch=${opts.branch ?? "base"}, run=${data.run.run}\n` +
    `selection=${data.selectionSha256}\nqualification=${data.qualification}\n` +
    "Graph recovery, retained-data readback and application readiness require separate verification.\n"
  );
}

function foreignHomeText(
  data:
    | NativeProjectRunForeignHomeInspection
    | NativeProjectRunForeignHomeRelease,
  branch: string | null
): string {
  const head = `branch=${branch ?? "base"}, run=${data.run.run}\nowner home=${data.ownerHome}, owner=${data.owner}${data.ownerPid === null ? "" : ` (frontend pid ${data.ownerPid})`}\n`;
  if ("released" in data) {
    return (
      `Native run mapping released from another native home: ${head}` +
      `audit=${data.auditPath}\n` +
      "Its graph and retained data stay in that home. Run hack up to start this instance from this home.\n"
    );
  }
  if (data.selectionSha256 !== null) {
    return (
      `Native run mapping belongs to another native home: ${head}selection=${data.selectionSha256}\n` +
      `Release it from this home with ${nativeForeignHomeReleaseCommand({ selectionSha256: data.selectionSha256, branch })}\n`
    );
  }
  return `Native run mapping belongs to another native home: ${head}${describeNativeForeignHomeMapping({ inspection: data, branch })}\n`;
}
