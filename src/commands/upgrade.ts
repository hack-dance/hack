import { dirname, join, resolve } from "node:path";

import type { CliContext, CommandArgs } from "../cli/command.ts";
import {
  CliUsageError,
  defineCommand,
  defineOption,
  withHandler,
} from "../cli/command.ts";
import { optJson, optProject } from "../cli/options.ts";
import { emitCliResult, okResult } from "../lib/cli-result.ts";
import { resolveUserHomeDir } from "../lib/home-dir.ts";
import {
  ProjectsRegistryLockTimeoutError,
  withProjectsRegistryLock,
} from "../lib/projects-registry-lock.ts";
import { escapeTerminalControls } from "../lib/terminal-text.ts";
import {
  runUpgradeApply,
  type UpgradeApplyResult,
} from "../lib/upgrade-apply.ts";
import {
  renderUpgradeCommand,
  runUpgradeCheck,
  type UpgradeCheckReport,
  upgradeCommandPrefix,
} from "../lib/upgrade-check.ts";
import { defaultUpgradeCheckProbes } from "../lib/upgrade-check-probes.ts";
import { renderUpgradeCheck } from "../lib/upgrade-check-render.ts";
import {
  createUpgradeSnapshot,
  listUpgradeSnapshots,
  type RestoreUpgradeSnapshotResult,
  readUpgradeSnapshot,
  restoreUpgradeSnapshot,
} from "../lib/upgrade-snapshot.ts";
import { collectUpgradeSnapshotTargets } from "../lib/upgrade-snapshot-targets.ts";

/**
 * `hack upgrade` (HACK-2188): the guided v4 → v5 upgrade. This unit
 * (HACK-2189) adds the read-only check and the snapshot and rollback that
 * later apply steps build on.
 */

const optVerbose = defineOption({
  name: "verbose",
  type: "boolean",
  long: "--verbose",
  description:
    "Also list every checkout's findings and the dead registry entries (--json always has everything)",
} as const);

const optAll = defineOption({
  name: "all",
  type: "boolean",
  long: "--all",
  description: "Same as --verbose",
} as const);

const checkOptions = [optVerbose, optAll, optJson] as const;

const checkSpec = defineCommand({
  name: "check",
  summary:
    "Check this machine and every registered project for the upgrade (read-only)",
  group: "Diagnostics",
  description: [
    "Reads the installed versions, the daemon's service, the projects registry (dead entries apart",
    "from unreadable ones), Hack's global services, proxy ports and DNS, the global secret store, and",
    "for each live project its env format and key, tracked files, ignore rules, agent integrations",
    "and (Apple Silicon) native preflight. Prints a one-screen summary, the projects with findings",
    "(worktrees folded under their project) and a plan with one step per kind of change, then the",
    "next command. Changes nothing and prints no value. Exits 1 when something blocks the upgrade.",
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

const optOnly = defineOption({
  name: "only",
  type: "string",
  long: "--only",
  valueHint: "<fix>",
  description:
    "Run only this plan step: ignore-rules or agent-integrations (comma-separated for both)",
} as const);

const optDryRun = defineOption({
  name: "dryRun",
  type: "boolean",
  long: "--dry-run",
  description: "List what would change and change nothing",
} as const);

const optResume = defineOption({
  name: "resume",
  type: "string",
  long: "--resume",
  valueHint: "<manifest>",
  description:
    "Resume the apply journal beside this explicit snapshot manifest",
} as const);
const optSnapshotRoot = defineOption({
  name: "snapshotRoot",
  type: "string",
  long: "--snapshot-root",
  valueHint: "<directory>",
  description:
    "Keep recovery bytes in this private directory outside Git, on the selected targets' filesystem",
} as const);
const applyOptions = [
  optOnly,
  optProject,
  optDryRun,
  optResume,
  optSnapshotRoot,
  optJson,
] as const;

const applySpec = defineCommand({
  name: "apply",
  summary:
    "Run the plan's apply steps for every checkout (snapshot and journal first)",
  group: "Diagnostics",
  description: [
    "Checks first, then runs the plan steps marked (apply) for every checkout they cover: refreshing",
    "outdated .hack/.gitignore files and removing stale standalone agent files the hack plugin replaces",
    "(each removal covered by the same snapshot). Before changing anything it keeps an upgrade",
    "snapshot and writes a journal beside it with the snapshot's coverage and gaps and each checkout's",
    "outcome. Checkouts with a blocker or a check that could not run are skipped. Prints the rollback",
    "command. --dry-run lists what would change. Exits 1 when anything selected was not done.",
    "After interruption, --resume <manifest> reuses that run's selection and snapshot; unexpected edits refuse.",
    "Other-volume checkouts are skipped before writing. Select one project with --snapshot-root on its volume",
    "to keep recovery bytes in an explicit private directory outside every Git working tree.",
  ].join("\n"),
  options: applyOptions,
  positionals: [],
  subcommands: [],
} as const);

export const upgradeCommand = defineCommand({
  name: "upgrade",
  summary: "Guided upgrade: check, apply, snapshot and roll back",
  group: "Diagnostics",
  options: [],
  positionals: [],
  subcommands: [
    withHandler(checkSpec, handleUpgradeCheck),
    withHandler(applySpec, handleUpgradeApply),
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
  const report = await check(ctx);
  if (args.options.json === true) {
    emitCliResult({ result: okResult({ data: report }) });
  } else {
    process.stdout.write(
      renderUpgradeCheck(report, {
        verbose: args.options.verbose === true || args.options.all === true,
      })
    );
  }
  return report.ready ? 0 : 1;
}

async function check(ctx: CliContext): Promise<UpgradeCheckReport> {
  return await runUpgradeCheck({
    cliVersion: ctx.cli.version,
    homeDir: resolveUserHomeDir(),
    probes: defaultUpgradeCheckProbes(),
    build: runningBuild(),
  });
}

/** A compiled binary runs from Bun's embedded filesystem; anything else is a source build. */
function runningBuild(): "release" | "source" {
  return Bun.main.startsWith("/$bunfs/") ? "release" : "source";
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
  const gapLines =
    collected.gaps.length === 0
      ? []
      : [
          "This snapshot is not a complete recovery point; it does not cover:",
          ...collected.gaps.map((gap) => `  ${gap.name}: ${gap.reason}`),
        ];
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
  const manifestPath = resolve(ctx.cwd, manifest);
  const result = await restoreWithApplyLock({
    manifestPath,
    overwrite: args.options.overwrite === true,
  });
  if (result.status === "busy") {
    if (json) {
      emitCliResult({ result: okResult({ data: result }) });
    } else {
      process.stdout.write(`${result.message}\n`);
    }
    return 1;
  }
  if (json) {
    emitCliResult({ result: okResult({ data: rollbackJson(result) }) });
  } else {
    process.stdout.write(renderRollback(result));
  }
  return result.status === "restored" ? 0 : 1;
}

/** CLI writers share one lock; direct snapshot-library callers own their serialization. */
async function restoreWithApplyLock(opts: {
  manifestPath: string;
  overwrite: boolean;
}) {
  const loaded = await readUpgradeSnapshot(opts);
  if (loaded.status !== "ok") {
    return { status: "invalid-manifest" as const, message: loaded.message };
  }
  try {
    return await withProjectsRegistryLock({
      lockPath: join(dirname(opts.manifestPath), "apply.lock"),
      label: "upgrade snapshot",
      timeoutMs: 1000,
      run: () => restoreUpgradeSnapshot(opts),
    });
  } catch (error) {
    if (!(error instanceof ProjectsRegistryLockTimeoutError)) {
      throw error;
    }
    return {
      status: "busy" as const,
      message:
        "The snapshot is in use; wait for apply or resume to finish before rolling back.",
    };
  }
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

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

async function handleUpgradeApply({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: CommandArgs<typeof applyOptions, readonly []>;
}): Promise<number> {
  const json = args.options.json === true;
  const only = (args.options.only ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (args.options.only !== undefined && only.length === 0) {
    throw new CliUsageError("--only needs ignore-rules or agent-integrations.");
  }
  const project = args.options.project?.trim();
  if (args.options.project !== undefined && !project) {
    throw new CliUsageError("--project needs a registered project name.");
  }
  const dryRun = args.options.dryRun === true;
  if (args.options.resume !== undefined && !args.options.resume.trim()) {
    throw new CliUsageError("--resume needs a snapshot manifest path.");
  }
  if (
    args.options.snapshotRoot !== undefined &&
    !args.options.snapshotRoot.trim()
  ) {
    throw new CliUsageError("--snapshot-root needs a directory path.");
  }
  const report = await check(ctx);
  const result = await runUpgradeApply({
    report,
    only: args.options.only === undefined ? undefined : only,
    project,
    dryRun,
    home: resolveUserHomeDir(),
    collect: collectUpgradeSnapshotTargets,
    resumeManifest:
      args.options.resume === undefined
        ? undefined
        : resolve(ctx.cwd, args.options.resume),
    snapshotRoot:
      args.options.snapshotRoot === undefined
        ? undefined
        : resolve(ctx.cwd, args.options.snapshotRoot),
  });
  const ran = result.status === "applied" || result.status === "partial";
  // Fresh evidence: what the check finds after the run.
  const after = ran ? await check(ctx) : null;
  const rollback = ran
    ? command([
        "upgrade",
        "rollback",
        "--rollback-manifest",
        result.coverage.manifest_path,
      ])
    : null;
  if (json) {
    emitCliResult({
      result: okResult({ data: applyJson({ result, after, rollback }) }),
    });
  } else {
    process.stdout.write(renderApply({ result, after, rollback }));
  }
  // Exit 1 when selected work did not all get done: refused, blocked
  // (every selected checkout skipped) or partial.
  return result.status === "refused" ||
    result.status === "blocked" ||
    result.status === "partial"
    ? 1
    : 0;
}

function applyJson(opts: {
  readonly result: UpgradeApplyResult;
  readonly after: UpgradeCheckReport | null;
  readonly rollback: string | null;
}) {
  const { result, after } = opts;
  if (result.status === "refused") {
    return result;
  }
  return {
    ...result,
    rollback_command: opts.rollback,
    resume_command:
      result.status === "applied" || result.status === "partial"
        ? command([
            "upgrade",
            "apply",
            "--resume",
            result.coverage.manifest_path,
          ])
        : null,
    after:
      after === null
        ? null
        : {
            ready: after.ready,
            plan: after.plan.map((step) => ({
              id: step.id,
              status: step.status,
              count: step.count,
              applies: step.applies,
            })),
            next_command: after.next_command,
            next_action: after.next_action,
          },
  };
}

const APPLY_LABEL: Readonly<Record<string, string>> = {
  "ignore-rules": ".hack/.gitignore",
  "agent-integrations": "agent files",
};

/** Text result: outcomes counted per fix and status, a few names, closed messages. */
export function renderApply(opts: {
  readonly result: UpgradeApplyResult;
  readonly after: UpgradeCheckReport | null;
  readonly rollback: string | null;
}): string {
  const { result } = opts;
  const lines =
    result.status === "refused"
      ? [result.message]
      : [
          ...outcomeLines(result),
          ...recoveryLines({ result, rollback: opts.rollback }),
          ...afterLines(opts.after),
        ];
  return `${lines.map((text) => escapeTerminalControls(text)).join("\n")}\n`;
}

function outcomeLines(
  result: Exclude<UpgradeApplyResult, { status: "refused" }>
): string[] {
  const notes = result.notes.map((note) => `Note: ${note}`);
  if (result.targets.length === 0) {
    return ["Nothing for hack upgrade apply to do.", ...notes];
  }
  const groups = new Map<string, (typeof result.targets)[number][]>();
  for (const target of result.targets) {
    const key = `${target.fix}\u0000${target.status}\u0000${target.message ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), target]);
  }
  const verb = result.status === "dry-run" ? "would change" : "changed";
  const lines: string[] = [];
  for (const targets of groups.values()) {
    const first = targets[0] as (typeof targets)[number];
    const names = targets.slice(0, 3).map((t) => t.scope);
    const more = targets.length > 3 ? ` and ${targets.length - 3} more` : "";
    const status = first.status === "planned" ? verb : first.status;
    lines.push(
      `${APPLY_LABEL[first.fix] ?? first.fix}: ${status} in ${targets.length} (${names.join(", ")}${more})`
    );
    if (first.message !== null) {
      lines.push(`  ${first.message}`);
    }
  }
  if (result.status === "dry-run") {
    lines.push(
      ...result.targets.flatMap((target) =>
        (target.files ?? []).map((path) => `  ${path}`)
      )
    );
  }
  if (result.status === "blocked") {
    lines.push(
      "Nothing ran: every selected target was skipped; see the reasons above."
    );
  }
  return [...lines, ...notes];
}

function recoveryLines(opts: {
  readonly result: Exclude<UpgradeApplyResult, { status: "refused" }>;
  readonly rollback: string | null;
}): string[] {
  const { result } = opts;
  if (result.status !== "applied" && result.status !== "partial") {
    return [];
  }
  const { coverage } = result;
  const gaps = coverage.complete
    ? ""
    : `; not a complete recovery point (${coverage.gaps.length} gap(s), listed in the journal)`;
  return [
    "",
    `Snapshot ${coverage.snapshot_id}: ${coverage.files} file(s)${gaps}.`,
    `Journal: ${result.journal_path}`,
    ...(result.status === "partial"
      ? [
          `To resume: ${command(["upgrade", "apply", "--resume", coverage.manifest_path])}`,
        ]
      : []),
    ...(opts.rollback === null
      ? []
      : [`To put the files back: ${opts.rollback}`]),
    ...result.agent_backups
      .filter((manifest) => manifest !== coverage.manifest_path)
      .map(
        (manifest) =>
          `To put removed agent files back: ${command(["setup", "migrate", "--rollback-manifest", manifest])}`
      ),
  ];
}

function afterLines(after: UpgradeCheckReport | null): string[] {
  if (after === null) {
    return [];
  }
  const remaining = after.plan.filter((step) => step.id !== "snapshot").length;
  return [
    "",
    after.ready
      ? "Check after apply: ready."
      : `Check after apply: ${remaining} step(s) remain.`,
    ...(after.next_command === null ? [] : [`Next: ${after.next_command}`]),
  ];
}
