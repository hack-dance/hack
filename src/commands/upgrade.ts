import { resolve } from "node:path";

import type { CliContext, CommandArgs } from "../cli/command.ts";
import {
  CliUsageError,
  defineCommand,
  defineOption,
  withHandler,
} from "../cli/command.ts";
import { optJson } from "../cli/options.ts";
import { emitCliResult, okResult } from "../lib/cli-result.ts";
import { resolveUserHomeDir } from "../lib/home-dir.ts";
import { escapeTerminalControls } from "../lib/terminal-text.ts";
import {
  renderUpgradeCommand,
  runUpgradeCheck,
  type UpgradeCheckReport,
  type UpgradeFinding,
  upgradeCommandPrefix,
} from "../lib/upgrade-check.ts";
import { defaultUpgradeCheckProbes } from "../lib/upgrade-check-probes.ts";
import {
  createUpgradeSnapshot,
  listUpgradeSnapshots,
  type RestoreUpgradeSnapshotResult,
  restoreUpgradeSnapshot,
} from "../lib/upgrade-snapshot.ts";
import { collectUpgradeSnapshotTargets } from "../lib/upgrade-snapshot-targets.ts";

/**
 * `hack upgrade` (HACK-2188): the guided v4 → v5 upgrade. This unit
 * (HACK-2189) adds the read-only check and the snapshot and rollback that
 * later apply steps build on.
 */

const checkOptions = [optJson] as const;

const checkSpec = defineCommand({
  name: "check",
  summary:
    "Check this machine and every registered project for the upgrade (read-only)",
  group: "Diagnostics",
  description: [
    "Reads the installed versions, the daemon's service, the projects registry (dead entries apart",
    "from unreadable ones), Hack's global services, proxy ports and DNS, the global secret store, and",
    "for each live project its env format and key, tracked files, ignore rules, agent integrations",
    "and (Apple Silicon) native preflight. Ends with an ordered plan and the next command. Changes",
    "nothing and prints no value. Exits 1 when something blocks the upgrade, naming it.",
  ].join("\n"),
  options: checkOptions,
  positionals: [],
  subcommands: [],
} as const);

const snapshotOptions = [optJson] as const;

const snapshotSpec = defineCommand({
  name: "snapshot",
  summary: "Keep a private copy of the files the upgrade changes",
  group: "Diagnostics",
  description: [
    "Copies the global Hack config, the projects registry, the encrypted secret store and its key",
    "(when used), and each live project's .hack config, env files, env layers, .hack/.gitignore and",
    "env key files into a private directory under ~/.hack/upgrade/snapshots (0700, files 0600).",
    "Prints the rollback command. The manifest records paths, sizes, modes and digests, never values.",
  ].join("\n"),
  options: snapshotOptions,
  positionals: [],
  subcommands: [],
} as const);

const optRollbackManifest = defineOption({
  name: "rollbackManifest",
  type: "string",
  long: "--rollback-manifest",
  valueHint: "<manifest>",
  description: "The snapshot manifest to restore (from hack upgrade snapshot)",
} as const);

const optOverwrite = defineOption({
  name: "overwrite",
  type: "boolean",
  long: "--overwrite",
  description:
    "Also restore files that changed since the snapshot (the current copies are kept in the snapshot)",
} as const);

const rollbackOptions = [optRollbackManifest, optOverwrite, optJson] as const;

const rollbackSpec = defineCommand({
  name: "rollback",
  summary: "Put back the files kept by an upgrade snapshot",
  group: "Diagnostics",
  description: [
    "Restores each file in the manifest with its exact bytes and mode. A file that changed since the",
    "snapshot (or since the step that recorded it) is left as it is unless --overwrite is passed;",
    "whatever a restore replaces or removes is kept in the snapshot directory, never deleted.",
    "Without --rollback-manifest, lists the snapshots and changes nothing.",
  ].join("\n"),
  options: rollbackOptions,
  positionals: [],
  subcommands: [],
} as const);

export const upgradeCommand = defineCommand({
  name: "upgrade",
  summary: "Guided upgrade: check, snapshot and roll back",
  group: "Diagnostics",
  options: [],
  positionals: [],
  subcommands: [
    withHandler(checkSpec, handleUpgradeCheck),
    withHandler(snapshotSpec, handleUpgradeSnapshot),
    withHandler(rollbackSpec, handleUpgradeRollback),
  ],
} as const);

/** A command line that runs this CLI (the candidate launcher during the prerelease). */
function command(args: readonly string[]): string {
  return renderUpgradeCommand(
    upgradeCommandPrefix({ env: process.env, homeDir: resolveUserHomeDir() }),
    args
  );
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

async function handleUpgradeCheck({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: CommandArgs<typeof checkOptions, readonly []>;
}): Promise<number> {
  const report = await runUpgradeCheck({
    cliVersion: ctx.cli.version,
    homeDir: resolveUserHomeDir(),
    probes: defaultUpgradeCheckProbes(),
  });
  if (args.options.json === true) {
    emitCliResult({ result: okResult({ data: report }) });
  } else {
    process.stdout.write(renderUpgradeCheck(report));
  }
  return report.ready ? 0 : 1;
}

const MARK: Readonly<Record<UpgradeFinding["status"], string>> = {
  ok: "ok   ",
  info: "info ",
  warn: "warn ",
  incomplete: "UNCHK",
  blocker: "BLOCK",
};

/** Plain-text report: every line escaped, no values. */
export function renderUpgradeCheck(report: UpgradeCheckReport): string {
  const lines: string[] = [];
  const line = (text: string) => lines.push(escapeTerminalControls(text));
  line(
    `hack ${report.cli.version} (${report.cli.channel}${report.cli.candidate_run ? ", candidate launcher" : ""})`
  );
  line("");
  line("Machine");
  for (const finding of report.machine) {
    line(`  ${MARK[finding.status]} ${finding.summary}`);
  }
  if (report.registry.missing.length > 0) {
    line(
      `        Dead entries: ${report.registry.missing.map((entry) => entry.name).join(", ")}`
    );
  }
  for (const project of report.projects) {
    line("");
    line(`Project ${project.name} (${project.root})`);
    for (const finding of project.findings) {
      line(`  ${MARK[finding.status]} ${finding.summary}`);
    }
  }
  line("");
  for (const text of renderPlan(report)) {
    line(text);
  }
  return `${lines.join("\n")}\n`;
}

function renderPlan(report: UpgradeCheckReport): string[] {
  if (report.plan.length === 0) {
    return report.ready
      ? ["Nothing to do: this machine and its projects are ready."]
      : ["No step to suggest, but the check is not complete; see above."];
  }
  const lines = ["Plan", ...report.plan.flatMap(renderStep), ""];
  if (report.next_command !== null) {
    lines.push(`Next: ${report.next_command}`);
  } else if (report.next_action !== null) {
    lines.push(`Next (manual): ${report.next_action}`);
  }
  if (report.blockers.length > 0) {
    lines.push(
      "",
      `Blocked by: ${report.blockers.map((blocker) => `${blocker.scope} ${blocker.id}`).join(", ")}`
    );
  }
  if (report.incomplete.length > 0) {
    lines.push(
      "",
      `Not fully checked: ${report.incomplete.map((item) => `${item.scope} ${item.id}`).join(", ")}`
    );
  }
  return lines;
}

function renderStep(step: UpgradeCheckReport["plan"][number]): string[] {
  const tag =
    {
      blocker: "[blocker] ",
      incomplete: "[not checked] ",
    }[step.status as string] ?? "";
  const scope = step.scope === "machine" ? "" : `   (${step.scope})`;
  const head =
    step.command === null
      ? `  ${step.order}. ${tag}manual: ${step.action ?? step.why}${scope}`
      : `  ${step.order}. ${tag}${step.command}${scope}`;
  return step.command !== null && step.action !== null
    ? [head, `       ${step.action}`]
    : [head];
}

// ---------------------------------------------------------------------------
// snapshot
// ---------------------------------------------------------------------------

async function handleUpgradeSnapshot({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: CommandArgs<typeof snapshotOptions, readonly []>;
}): Promise<number> {
  const collected = await collectUpgradeSnapshotTargets();
  const gapLines = collected.gaps.map(
    (gap) =>
      `Not complete for ${gap.name}: ${gap.reason}. A rollback may leave env layers the migration creates for those overlays.`
  );
  const created = await createUpgradeSnapshot({
    purpose: "hack upgrade snapshot",
    targets: collected.targets,
  });
  const json = args.options.json === true;
  if (created.status !== "created") {
    const message =
      created.reason === "root"
        ? `The snapshot directory ${created.root} cannot be used (${created.rootReason}); nothing was written.`
        : `These files cannot be snapshotted, so nothing was written: ${created.targets.map((target) => `${target.label} (${target.reason})`).join(", ")}.`;
    if (json) {
      emitCliResult({
        result: okResult({
          data: { status: "refused", message, detail: created },
        }),
      });
    } else {
      process.stderr.write(`${escapeTerminalControls(message)}\n`);
    }
    return 1;
  }
  const { snapshot } = created;
  const rollback = command([
    "upgrade",
    "rollback",
    "--rollback-manifest",
    snapshot.manifestPath,
  ]);
  if (json) {
    emitCliResult({
      result: okResult({
        data: {
          status: "created",
          id: snapshot.id,
          manifest_path: snapshot.manifestPath,
          files: snapshot.manifest.entries.map((entry) => ({
            path: entry.path,
            label: entry.label,
          })),
          skipped: collected.skipped,
          complete: collected.gaps.length === 0,
          gaps: collected.gaps,
          rollback_command: rollback,
        },
      }),
    });
    return 0;
  }
  const lines = [
    `Kept ${snapshot.manifest.entries.length} file(s) in ${snapshot.dir}.`,
    ...collected.skipped.map(
      (entry) => `Skipped ${entry.label} (${entry.reason}): ${entry.path}`
    ),
    ...gapLines,
    "To put them back:",
    `  ${rollback}`,
  ];
  process.stdout.write(
    `${lines.map((text) => escapeTerminalControls(text)).join("\n")}\n`
  );
  return 0;
}

// ---------------------------------------------------------------------------
// rollback
// ---------------------------------------------------------------------------

async function handleUpgradeRollback({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: CommandArgs<typeof rollbackOptions, readonly []>;
}): Promise<number> {
  const json = args.options.json === true;
  const manifest = args.options.rollbackManifest?.trim();
  if (args.options.rollbackManifest !== undefined && !manifest) {
    throw new CliUsageError("--rollback-manifest needs a manifest path.");
  }
  if (!manifest) {
    // Never guess which snapshot to restore: list them and stop.
    const snapshots = await listUpgradeSnapshots();
    if (json) {
      emitCliResult({
        result: okResult({
          data: {
            status: "choose",
            snapshots: snapshots.map((snapshot) => ({
              id: snapshot.id,
              created_at: snapshot.manifest.createdAt,
              purpose: snapshot.manifest.purpose,
              files: snapshot.manifest.entries.length,
              manifest_path: snapshot.manifestPath,
            })),
          },
        }),
      });
    } else {
      const lines =
        snapshots.length === 0
          ? [
              `No upgrade snapshots. Make one with: ${command(["upgrade", "snapshot"])}`,
            ]
          : [
              "Choose a snapshot to restore (nothing was changed):",
              ...snapshots.map(
                (snapshot) =>
                  `  ${snapshot.manifest.createdAt}  ${snapshot.manifest.purpose} (${snapshot.manifest.entries.length} file(s))\n    ${command(["upgrade", "rollback", "--rollback-manifest", snapshot.manifestPath])}`
              ),
            ];
      process.stdout.write(
        `${lines.map((text) => escapeTerminalControls(text)).join("\n")}\n`
      );
    }
    return 1;
  }
  const result = await restoreUpgradeSnapshot({
    manifestPath: resolve(ctx.cwd, manifest),
    overwrite: args.options.overwrite === true,
  });
  if (json) {
    emitCliResult({ result: okResult({ data: rollbackJson(result) }) });
  } else {
    process.stdout.write(renderRollback(result));
  }
  return result.status === "restored" ? 0 : 1;
}

function rollbackJson(result: RestoreUpgradeSnapshotResult) {
  if (result.status === "invalid-manifest") {
    return { status: result.status, message: result.message };
  }
  return {
    status: result.status,
    results: result.results.map((entry) => ({
      path: entry.path,
      label: entry.label,
      status: entry.status,
      kept_as: entry.keptAs ?? null,
      message: entry.message ?? null,
    })),
  };
}

function renderRollback(result: RestoreUpgradeSnapshotResult): string {
  if (result.status === "invalid-manifest") {
    return `${escapeTerminalControls(result.message)}\n`;
  }
  const lines = result.results.map(
    (entry) =>
      `${entry.status.padEnd(16)} ${entry.label}${entry.keptAs ? ` (previous copy kept at ${entry.keptAs})` : ""}${entry.message ? `\n                 ${entry.message}` : ""}`
  );
  lines.push(
    result.status === "restored"
      ? "Every file is back as it was in the snapshot."
      : "Some files were not restored; see above. Nothing was deleted."
  );
  return `${lines.map((text) => escapeTerminalControls(text)).join("\n")}\n`;
}
