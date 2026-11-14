import { lstat } from "node:fs/promises";
import { join, normalize, resolve } from "node:path";

import {
  applyPluginMigration,
  type PluginMigrationApplyResult,
} from "../agents/plugin-migration.ts";
import { MIGRATION_CLIENTS } from "../agents/plugin-replacement.ts";
import { resolveGlobalHackDir } from "./config-paths.ts";
import { ensureHackDirGitignore } from "./project-env-config.ts";
import type { UpgradeCheckReport } from "./upgrade-check.ts";
import {
  isUpgradeApplyFix,
  UPGRADE_APPLY_FIXES,
  type UpgradeApplyFix,
} from "./upgrade-plan.ts";
import {
  createUpgradeSnapshot,
  recordUpgradeSnapshotAfter,
  type UpgradeSnapshot,
  type UpgradeSnapshotTarget,
  writeUpgradeSnapshotJournal,
} from "./upgrade-snapshot.ts";

/**
 * `hack upgrade apply` (HACK-2188, HACK-2220): runs the plan's apply steps
 * ({@link UPGRADE_APPLY_FIXES}) for every checkout they cover.
 *
 * Contract:
 * - Works from a fresh `hack upgrade check` report; never guesses. A
 *   checkout with a blocker or an incomplete check is skipped (named, with
 *   why); `--project` and `--only` narrow the work, and an unknown or
 *   ambiguous name is refused before anything is written. Checkouts are
 *   identified by their root, never by their display name.
 * - `dryRun` writes nothing and lists what would run.
 * - Otherwise it first keeps an upgrade snapshot of the files the upgrade
 *   changes (the `hack upgrade snapshot` set, plus every file this run
 *   writes). If the snapshot is refused, nothing is changed. A file this
 *   run writes is changed only when the snapshot holds it, and a target is
 *   reported applied only once its after state is recorded, so
 *   `hack upgrade rollback` can tell the step's output from a later edit.
 * - A journal beside the snapshot manifest records the run: the snapshot's
 *   coverage (`complete`, `gaps`, file count) and each target's outcome. It
 *   is rewritten atomically before the first change, when each target
 *   starts (`started`, with the backup manifest it will write, before the
 *   migration can remove anything) and when it ends. After an interruption
 *   a `started` target may have changed files; `planned` ones have not.
 *   Paths, ids, statuses, counts and closed messages only: never a value.
 * - Stale agent files are removed only by the plugin migration, which backs
 *   up each file to its own manifest first and refuses when the hack plugin
 *   that replaces them is not verified. Machine-wide agent files (under
 *   HOME) are migrated only without `--project`; with it they are left out
 *   and noted, not counted as unfinished work.
 * - Nothing is deleted that current resolution reads: `.hack/.gitignore` is
 *   merged (never shrunk), and the migration removes only Hack-owned
 *   standalone files the verified plugin replaces.
 */

export const UPGRADE_APPLY_JOURNAL_VERSION = 1;
export const UPGRADE_APPLY_JOURNAL_KIND = "hack-upgrade-apply";

export type UpgradeApplyTargetStatus =
  /** Would run (dry run), or not reached yet (journal). */
  | "planned"
  /** In progress (journal only): it may have changed files. */
  | "started"
  /** Changed, and the change is recorded for rollback. */
  | "applied"
  /** Already current; nothing written. */
  | "unchanged"
  /** Not run: the checkout has a blocker or an incomplete check. */
  | "skipped"
  /** Not run: a safety condition refused it (plugin not verified, a link, a read-only file, not in the snapshot). */
  | "refused"
  /** Started and failed, or changed without a recorded after state. */
  | "failed";

export type UpgradeApplyTarget = {
  readonly fix: UpgradeApplyFix;
  /** The checkout's name, or `machine` for machine-wide agent files. */
  readonly scope: string;
  readonly project: string | null;
  readonly root: string;
  readonly status: UpgradeApplyTargetStatus;
  /** A closed explanation; never a value. */
  readonly message: string | null;
  /** The plugin migration's backup manifest: set before it can remove a file. */
  readonly backup_manifest: string | null;
};

export type UpgradeApplyCoverage = {
  readonly snapshot_id: string;
  readonly manifest_path: string;
  readonly files: number;
  /** True when the snapshot is a complete recovery point for the files the upgrade changes. */
  readonly complete: boolean;
  readonly gaps: readonly { readonly name: string; readonly reason: string }[];
};

export type UpgradeApplyJournal = {
  readonly version: typeof UPGRADE_APPLY_JOURNAL_VERSION;
  readonly kind: typeof UPGRADE_APPLY_JOURNAL_KIND;
  readonly started_at: string;
  readonly updated_at: string;
  readonly state: "applying" | "applied" | "failed";
  readonly cli_version: string;
  readonly filters: {
    readonly only: readonly UpgradeApplyFix[];
    readonly project: string | null;
  };
  readonly snapshot: UpgradeApplyCoverage;
  readonly targets: readonly UpgradeApplyTarget[];
  readonly notes: readonly string[];
};

export type UpgradeApplyResult =
  | {
      /** Refused before anything was written. */
      readonly status: "refused";
      readonly reason:
        | "unknown-project"
        | "ambiguous-project"
        | "unknown-fix"
        | "snapshot";
      readonly message: string;
    }
  | {
      /**
       * `nothing-to-do`: no selected work. `blocked`: every selected target
       * was skipped (a blocker or an incomplete check), so nothing ran.
       */
      readonly status: "nothing-to-do" | "dry-run" | "blocked";
      readonly targets: readonly UpgradeApplyTarget[];
      /** Work left out on purpose (for example HOME files with `--project`). */
      readonly notes: readonly string[];
    }
  | {
      /** `applied`: every selected target is applied or unchanged. */
      readonly status: "applied" | "partial";
      readonly targets: readonly UpgradeApplyTarget[];
      readonly notes: readonly string[];
      readonly coverage: UpgradeApplyCoverage;
      readonly journal_path: string;
      readonly agent_backups: readonly string[];
    };

/** Collected snapshot targets, as {@link collectUpgradeSnapshotTargets} returns them. */
export type UpgradeApplySnapshotSet = {
  readonly targets: readonly UpgradeSnapshotTarget[];
  readonly gaps: readonly { readonly name: string; readonly reason: string }[];
};

type Planned = {
  readonly fix: UpgradeApplyFix;
  readonly scope: string;
  readonly project: string | null;
  readonly root: string;
  /** The checkout's Hack directory; null for machine-wide agent files. */
  readonly projectDir: string | null;
  readonly skip: string | null;
};

const ERROR_CODE = /^[A-Z0-9_]{1,40}$/;
const SKIP_BLOCKED =
  "Not run: this checkout has a blocker or a check that could not be performed; fix that first (hack upgrade check lists it).";
const NOTE_HOME_WITH_PROJECT =
  "Agent files under HOME serve every project and are left out with --project; run hack upgrade apply --only agent-integrations without --project for them.";
const NOT_IN_SNAPSHOT =
  "Not changed: the file is not in this run's snapshot, so a rollback could not restore it.";
const NOT_RECORDED =
  "Changed, but the snapshot could not record what was written; hack upgrade rollback needs --overwrite for this file.";

/**
 * Runs (or with `dryRun` lists) the apply steps of `report`. `collect`
 * returns the upgrade snapshot set (production:
 * `collectUpgradeSnapshotTargets`).
 */
export async function runUpgradeApply(input: {
  readonly report: UpgradeCheckReport;
  readonly only?: readonly string[];
  readonly project?: string;
  readonly dryRun: boolean;
  readonly home: string;
  readonly collect: () => Promise<UpgradeApplySnapshotSet>;
  /** Test seams. */
  readonly snapshotRoot?: string;
  readonly agentBackupDir?: string;
  readonly now?: () => Date;
  readonly applyPluginMigration?: typeof applyPluginMigration;
  readonly recordAfter?: typeof recordUpgradeSnapshotAfter;
}): Promise<UpgradeApplyResult> {
  const only = input.only ?? [];
  const refusal = selectionRefusal({
    report: input.report,
    only,
    project: input.project,
  });
  if (refusal !== null) {
    return refusal;
  }
  const fixes = only.filter(isUpgradeApplyFix);
  const { planned, notes } = planTargets({
    report: input.report,
    only: fixes,
    project: input.project ?? null,
    home: input.home,
  });
  const runnable = planned.filter((target) => target.skip === null);
  const skipped = planned
    .filter((target) => target.skip !== null)
    .map((target) => outcome(target, "skipped", target.skip));
  const early = resultBeforeSnapshot({
    dryRun: input.dryRun,
    runnable,
    skipped,
    notes,
  });
  if (early !== null) {
    return early;
  }

  // The snapshot comes first: nothing is written unless it is kept.
  const collected = await input.collect();
  const created = await createUpgradeSnapshot({
    purpose: "hack upgrade apply",
    targets: await snapshotTargets({ runnable, collected }),
    root: input.snapshotRoot,
    now: input.now?.(),
  });
  if (created.status !== "created") {
    return {
      status: "refused",
      reason: "snapshot",
      message:
        created.reason === "root"
          ? `The snapshot directory ${created.root} cannot be used (${created.rootReason}); nothing was changed.`
          : `These files cannot be snapshotted, so nothing was changed: ${created.targets.map((t) => `${t.label} (${t.reason})`).join(", ")}.`,
    };
  }
  const { snapshot } = created;
  const coverage: UpgradeApplyCoverage = {
    snapshot_id: snapshot.id,
    manifest_path: snapshot.manifestPath,
    files: snapshot.manifest.entries.length,
    complete: collected.gaps.length === 0,
    gaps: collected.gaps,
  };
  const now = () => (input.now?.() ?? new Date()).toISOString();
  const startedAt = now();
  const results: UpgradeApplyTarget[] = [...skipped];
  const journal = (
    state: UpgradeApplyJournal["state"],
    current: UpgradeApplyTarget | null
  ): UpgradeApplyJournal => {
    const done = results.length - skipped.length;
    const pending = runnable
      .slice(done + (current === null ? 0 : 1))
      .map((target) => outcome(target, "planned", null));
    return {
      version: UPGRADE_APPLY_JOURNAL_VERSION,
      kind: UPGRADE_APPLY_JOURNAL_KIND,
      started_at: startedAt,
      updated_at: now(),
      state,
      cli_version: input.report.cli.version,
      filters: { only: fixes, project: input.project ?? null },
      snapshot: coverage,
      targets: [...results, ...(current === null ? [] : [current]), ...pending],
      notes,
    };
  };
  // Commit point: the journal names the snapshot before the first change.
  const journalPath = await writeUpgradeSnapshotJournal({
    snapshot,
    journal: journal("applying", null),
  });
  const inSnapshot = new Set(snapshot.manifest.entries.map((e) => e.path));
  const backupDir =
    input.agentBackupDir ?? join(resolveGlobalHackDir(), "agent-migrations");
  for (const [index, target] of runnable.entries()) {
    const backup =
      target.fix === "agent-integrations"
        ? {
            id: `upgrade-apply-${snapshot.id}-${index}`,
            path: join(backupDir, `upgrade-apply-${snapshot.id}-${index}.json`),
          }
        : null;
    // Before anything can change: this target started, with its backup.
    await writeUpgradeSnapshotJournal({
      snapshot,
      journal: journal("applying", {
        ...outcome(target, "started", null),
        backup_manifest: backup?.path ?? null,
      }),
    });
    results.push(
      await applyTarget({
        target,
        snapshot,
        inSnapshot,
        home: input.home,
        backupDir,
        backup,
        migrate: input.applyPluginMigration ?? applyPluginMigration,
        recordAfter: input.recordAfter ?? recordUpgradeSnapshotAfter,
      })
    );
    await writeUpgradeSnapshotJournal({
      snapshot,
      journal: journal("applying", null),
    });
  }
  const done = results.every(
    (r) => r.status === "applied" || r.status === "unchanged"
  );
  await writeUpgradeSnapshotJournal({
    snapshot,
    journal: journal(done ? "applied" : "failed", null),
  });
  return {
    status: done ? "applied" : "partial",
    targets: results,
    notes,
    coverage,
    journal_path: journalPath,
    agent_backups: results.flatMap((r) =>
      r.backup_manifest === null ? [] : [r.backup_manifest]
    ),
  };
}

/** The dry-run, nothing-to-do and all-blocked results; null when there is work to run. */
function resultBeforeSnapshot(opts: {
  readonly dryRun: boolean;
  readonly runnable: readonly Planned[];
  readonly skipped: readonly UpgradeApplyTarget[];
  readonly notes: readonly string[];
}): Extract<
  UpgradeApplyResult,
  { status: "dry-run" | "nothing-to-do" | "blocked" }
> | null {
  const { runnable, skipped, notes } = opts;
  if (opts.dryRun) {
    return {
      status:
        runnable.length + skipped.length === 0 ? "nothing-to-do" : "dry-run",
      targets: [
        ...runnable.map((target) => outcome(target, "planned", null)),
        ...skipped,
      ],
      notes,
    };
  }
  if (runnable.length > 0) {
    return null;
  }
  return {
    status: skipped.length === 0 ? "nothing-to-do" : "blocked",
    targets: skipped,
    notes,
  };
}

/** An unknown `--only`, or an unknown or ambiguous `--project`; null when the selection is valid. */
function selectionRefusal(opts: {
  readonly report: UpgradeCheckReport;
  readonly only: readonly string[];
  readonly project: string | undefined;
}): Extract<UpgradeApplyResult, { status: "refused" }> | null {
  if (opts.only.some((id) => !isUpgradeApplyFix(id))) {
    return {
      status: "refused",
      reason: "unknown-fix",
      message: `--only takes ${UPGRADE_APPLY_FIXES.join(" or ")}; nothing was changed.`,
    };
  }
  if (opts.project === undefined) {
    return null;
  }
  const checkouts = opts.report.projects.filter(
    (p) => p.project === opts.project
  );
  if (checkouts.length === 0) {
    return {
      status: "refused",
      reason: "unknown-project",
      message:
        "No live registered project has that name; nothing was changed. hack upgrade check lists them.",
    };
  }
  // A project's primary checkout carries the project's own name.
  const primaries = new Set(
    checkouts.filter((p) => p.name === p.project).map((p) => p.root)
  );
  if (primaries.size > 1) {
    return {
      status: "refused",
      reason: "ambiguous-project",
      message:
        "Several registered projects have that name; nothing was changed. Run without --project, or rename one of them.",
    };
  }
  return null;
}

function planTargets(opts: {
  readonly report: UpgradeCheckReport;
  readonly only: readonly UpgradeApplyFix[];
  readonly project: string | null;
  readonly home: string;
}): { readonly planned: Planned[]; readonly notes: string[] } {
  const wanted = new Set<UpgradeApplyFix>(
    opts.only.length > 0 ? opts.only : UPGRADE_APPLY_FIXES
  );
  const unsafe = unsafeRoots(opts.report);
  // By root: display names are not unique (duplicate registrations,
  // worktrees with the same directory name).
  const byRoot = new Map(
    opts.report.projects.map((p) => [normalize(p.root), p])
  );
  const planned: Planned[] = [];
  const notes: string[] = [];
  for (const fix of UPGRADE_APPLY_FIXES) {
    const step = wanted.has(fix)
      ? opts.report.plan.find((c) => c.id === fix && c.applies)
      : undefined;
    if (step === undefined) {
      continue;
    }
    if (fix === "agent-integrations") {
      // Files under HOME make every checkout stale; they are migrated once.
      if (opts.project === null) {
        planned.push({
          fix,
          scope: "machine",
          project: null,
          root: opts.home,
          projectDir: null,
          skip: null,
        });
      } else {
        notes.push(NOTE_HOME_WITH_PROJECT);
      }
    }
    const seen = new Set<string>();
    for (const target of step.targets) {
      const root = normalize(target.root);
      if (
        seen.has(root) ||
        (opts.project !== null && target.project !== opts.project)
      ) {
        continue;
      }
      seen.add(root);
      planned.push({
        fix,
        scope: target.scope,
        project: target.project,
        root: target.root,
        projectDir: byRoot.get(root)?.project_dir ?? null,
        skip: unsafe.has(root) ? SKIP_BLOCKED : null,
      });
    }
  }
  return { planned, notes };
}

/** Roots of checkouts with a blocker or a check that could not be performed. */
function unsafeRoots(report: UpgradeCheckReport): ReadonlySet<string> {
  return new Set(
    report.projects
      .filter((project) =>
        project.findings.some(
          (f) => f.status === "blocker" || f.status === "incomplete"
        )
      )
      .map((project) => normalize(project.root))
  );
}

async function applyTarget(opts: {
  readonly target: Planned;
  readonly snapshot: UpgradeSnapshot;
  readonly inSnapshot: ReadonlySet<string>;
  readonly home: string;
  readonly backupDir: string;
  readonly backup: { readonly id: string; readonly path: string } | null;
  readonly migrate: typeof applyPluginMigration;
  readonly recordAfter: typeof recordUpgradeSnapshotAfter;
}): Promise<UpgradeApplyTarget> {
  const { target } = opts;
  if (target.fix === "ignore-rules") {
    return await applyIgnoreRules(opts);
  }
  const backup = opts.backup as { readonly id: string; readonly path: string };
  let migrated: PluginMigrationApplyResult;
  try {
    migrated = await opts.migrate({
      scopes: [
        target.projectDir === null
          ? { scope: "global", root: opts.home }
          : { scope: "project", root: target.root },
      ],
      home: opts.home,
      clients: MIGRATION_CLIENTS,
      skipPluginCheck: [],
      backupDir: opts.backupDir,
      hooks: { id: backup.id },
    });
  } catch (error) {
    // Files may already be removed: keep the backup's name when it exists.
    const kept = (await exists(backup.path)) ? backup.path : null;
    return {
      ...outcome(
        target,
        "failed",
        `${closedError(error)}${kept === null ? "" : " Files it removed are kept in the backup manifest."}`
      ),
      backup_manifest: kept,
    };
  }
  return agentOutcome({ target, migrated });
}

async function applyIgnoreRules(opts: {
  readonly target: Planned;
  readonly snapshot: UpgradeSnapshot;
  readonly inSnapshot: ReadonlySet<string>;
  readonly recordAfter: typeof recordUpgradeSnapshotAfter;
}): Promise<UpgradeApplyTarget> {
  const { target } = opts;
  if (target.projectDir === null) {
    return outcome(
      target,
      "refused",
      "Not changed: the checkout's Hack directory is unknown."
    );
  }
  const path = gitignorePath(target.projectDir);
  if (!opts.inSnapshot.has(path)) {
    return outcome(target, "refused", NOT_IN_SNAPSHOT);
  }
  let result: Awaited<ReturnType<typeof ensureHackDirGitignore>> | null = null;
  let failure: unknown = null;
  try {
    result = await ensureHackDirGitignore({ projectDir: target.projectDir });
  } catch (error) {
    failure = error;
  }
  // Whatever is there now is this step's output, even after a failure.
  let recorded = false;
  try {
    const record = await opts.recordAfter({
      manifestPath: opts.snapshot.manifestPath,
      paths: [path],
    });
    recorded = record.status === "recorded";
  } catch {
    recorded = false;
  }
  if (result === null) {
    return outcome(
      target,
      "failed",
      `${closedError(failure)}${recorded ? "" : ` ${NOT_RECORDED}`}`
    );
  }
  if (result.changed && !recorded) {
    return outcome(target, "failed", NOT_RECORDED);
  }
  if (result.readOnly) {
    return outcome(
      target,
      "refused",
      "Not changed: .hack/.gitignore is read-only; make it writable or update it yourself."
    );
  }
  return outcome(target, result.changed ? "applied" : "unchanged", null);
}

function agentOutcome(opts: {
  readonly target: Planned;
  readonly migrated: PluginMigrationApplyResult;
}): UpgradeApplyTarget {
  const { target, migrated } = opts;
  const preview =
    target.projectDir === null
      ? "hack setup migrate --global"
      : "hack setup migrate --path <checkout>";
  if (migrated.status === "nothing-to-migrate") {
    return outcome(
      target,
      "unchanged",
      "No standalone Hack agent file to remove here; a stale AGENTS.md or CLAUDE.md section is refreshed by hack setup, not by apply."
    );
  }
  if (migrated.status === "refused") {
    const why = {
      blocked:
        "the hack plugin that replaces these files is not verified for a client",
      "scope-error": "the scope could not be resolved",
      "backup-failed": "a file could not be read for its backup",
    }[migrated.reason];
    return outcome(
      target,
      "refused",
      `Not changed: ${why}. ${preview} shows the details.`
    );
  }
  const failed = migrated.results.some(
    (entry) => entry.status === "error" || entry.status === "changed"
  );
  return {
    ...outcome(
      target,
      failed ? "failed" : "applied",
      failed
        ? `Some files were not removed; ${preview} shows them. Removed files are backed up in the manifest.`
        : null
    ),
    backup_manifest: migrated.manifestPath,
  };
}

function outcome(
  target: Planned,
  status: UpgradeApplyTargetStatus,
  message: string | null
): UpgradeApplyTarget {
  return {
    fix: target.fix,
    scope: target.scope,
    project: target.project,
    root: target.root,
    status,
    message,
    backup_manifest: null,
  };
}

/**
 * The snapshot's targets: the upgrade set plus every file this run writes.
 * A write-set path the collection did not keep is added only when it is a
 * regular file or absent: a link there would refuse the whole snapshot, so
 * its checkout is refused alone (not in the snapshot) instead.
 */
async function snapshotTargets(opts: {
  readonly runnable: readonly Planned[];
  readonly collected: UpgradeApplySnapshotSet;
}): Promise<UpgradeSnapshotTarget[]> {
  const collectedPaths = new Set(
    opts.collected.targets.map((t) => normalize(t.path))
  );
  const extra: UpgradeSnapshotTarget[] = [];
  for (const target of opts.runnable) {
    if (target.fix !== "ignore-rules" || target.projectDir === null) {
      continue;
    }
    const path = gitignorePath(target.projectDir);
    if (!collectedPaths.has(path) && (await snapshotable(path))) {
      collectedPaths.add(path);
      extra.push({ path, label: `project ${target.scope}: .hack/.gitignore` });
    }
  }
  return [...opts.collected.targets, ...extra];
}

/** A regular file or an absent path (not a link or other entry). */
async function snapshotable(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch (error) {
    return (error as { code?: unknown }).code === "ENOENT";
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function gitignorePath(projectDir: string): string {
  return normalize(resolve(projectDir, ".gitignore"));
}

/** A closed message for a failure: the error's code, never its text. */
function closedError(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "error";
  return `Failed (${ERROR_CODE.test(code) ? code : "error"}).`;
}
