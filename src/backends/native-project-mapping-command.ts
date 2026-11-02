import { CliUsageError } from "../cli/command.ts";
import { resolveEffectiveBranch } from "../lib/branches.ts";
import { emitCliResult, okResult } from "../lib/cli-result.ts";
import {
  findProjectContext,
  readProjectConfig,
  resolveWorktreeAutoBranch,
  sanitizeBranchSlug,
} from "../lib/project.ts";
import {
  inspectNativeProjectRunFilesystemRecovery,
  recoverNativeProjectRunFilesystem,
} from "./native-project-run.ts";
import type { NativeRuntimeSelection } from "./native-runtime-client.ts";

const SELECTION = /^[a-f0-9]{64}$/;

type Selection =
  | { readonly action: "inspect" }
  | { readonly action: "repair"; readonly expectSelection: string };

/** A device rebind is an explicit selected metadata migration, never an automatic Doctor fix. */
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
        "Run-mapping selection and branch options require --native-run-mapping inspect|repair."
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
  const data =
    opts.selection.action === "inspect"
      ? await inspectNativeProjectRunFilesystemRecovery({
          scope,
          runtime: opts.runtime,
        })
      : await recoverNativeProjectRunFilesystem({
          scope,
          runtime: opts.runtime,
          expectSelection: opts.selection.expectSelection,
          acceptLegacyDeviceRebind: true,
        });
  if (opts.json) {
    emitCliResult({ result: okResult({ data }) });
  } else {
    process.stdout.write(
      `Native run mapping ${opts.selection.action === "repair" ? "repaired" : "inspected"}: branch=${selected.branch ?? "base"}, run=${data.run.run}\n` +
        `selection=${data.selectionSha256}\nqualification=${data.qualification}\n` +
        "Graph recovery, retained-data readback and application readiness require separate verification.\n"
    );
  }
  return 0;
}
