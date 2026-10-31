import { join, resolve } from "node:path";

import {
  applyPluginMigration,
  type MigrationApplyEntry,
  type MigrationPlanEntry,
  type MigrationRollbackEntry,
  type MigrationScopeRoot,
  type PluginCheck,
  type PluginMigrationApplyResult,
  type PluginMigrationPlan,
  type PluginMigrationRollbackResult,
  planPluginMigration,
  rollbackPluginMigration,
} from "../agents/plugin-migration.ts";
import {
  MIGRATION_CLIENTS,
  type MigrationClient,
} from "../agents/plugin-replacement.ts";
import type { SetupSyncTarget } from "../agents/setup-sync.ts";
import type { CliContext, CommandArgs } from "../cli/command.ts";
import { CliUsageError, defineCommand, defineOption } from "../cli/command.ts";
import { optJson, optPath } from "../cli/options.ts";
import { emitCliResult, okResult } from "../lib/cli-result.ts";
import { resolveGlobalHackDir } from "../lib/config-paths.ts";
import { findRepoRootForInit } from "../lib/project.ts";
import { type DisplayStatusItem, display } from "../ui/display.ts";
import { logger } from "../ui/logger.ts";

/**
 * `hack setup migrate`: preview (default, read-only), `--apply`, or
 * `--rollback-manifest <manifest>` for moving standalone Hack skills to the
 * skills-only `hack` plugin. Cursor rules have no replacement and are preserved.
 * Historical rule backups can still be rolled back. See `plugin-migration.ts` for the
 * ownership, verification and backup contract.
 */

const optApply = defineOption({
  name: "apply",
  type: "boolean",
  long: "--apply",
  description:
    "Remove the previewed Hack-owned standalone files after backing them up (default: read-only preview)",
} as const);

const optRollbackManifest = defineOption({
  name: "rollbackManifest",
  type: "string",
  long: "--rollback-manifest",
  valueHint: "<manifest>",
  description:
    "Restore the exact files recorded in a migration backup manifest",
} as const);

const optSkipPluginCheck = defineOption({
  name: "skipPluginCheck",
  type: "string",
  long: "--skip-plugin-check",
  valueHint: "<clients>",
  description:
    "Treat the plugin as verified for these comma-separated clients (claude, codex, cursor, or all) after checking it loads yourself",
} as const);

const optMigrateGlobal = defineOption({
  name: "global",
  type: "boolean",
  long: "--global",
  description: "Migrate user-scope files under HOME instead of the project",
} as const);

const optMigrateAllScopes = defineOption({
  name: "allScopes",
  type: "boolean",
  long: "--all-scopes",
  description: "Migrate both project and user-scope files",
} as const);

const optMigrateClaude = defineOption({
  name: "claude",
  type: "boolean",
  long: "--claude",
  description: "Limit to Claude Code files (default: all clients)",
} as const);

const optMigrateCodex = defineOption({
  name: "codex",
  type: "boolean",
  long: "--codex",
  description: "Limit to Codex files (default: all clients)",
} as const);

const optMigrateCursor = defineOption({
  name: "cursor",
  type: "boolean",
  long: "--cursor",
  description: "Limit to Cursor files (default: all clients)",
} as const);

const setupMigrateOptions = [
  optPath,
  optMigrateGlobal,
  optMigrateAllScopes,
  optMigrateClaude,
  optMigrateCodex,
  optMigrateCursor,
  optSkipPluginCheck,
  optApply,
  optRollbackManifest,
  optJson,
] as const;

type SetupMigrateArgs = CommandArgs<typeof setupMigrateOptions, readonly []>;

export const setupMigrateSpec = defineCommand({
  name: "migrate",
  summary:
    "Migrate standalone skills to the hack plugin; preserve Cursor rules",
  group: "Agents",
  options: setupMigrateOptions,
  positionals: [],
  subcommands: [],
} as const);

const TARGET_LABELS: Readonly<Partial<Record<SetupSyncTarget, string>>> = {
  "cursor-rules": "Cursor rules",
  "claude-hack-init-skill": "Claude hack-init skill",
  "codex-hack-cli-skill": "Codex hack-cli skill",
  "codex-hack-init-skill": "Codex hack-init skill",
  "shared-hack-cli-skill": "Shared Hack skill",
};

const CLIENT_LABELS: Readonly<Record<MigrationClient, string>> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
};

/** Directory that holds migration backup manifests. */
export function resolveMigrationBackupDir(): string {
  return join(resolveGlobalHackDir(), "agent-migrations");
}

/** Parse `--skip-plugin-check`; unknown client names are a usage error. */
export function parseSkipPluginCheck(
  value: string | undefined
): readonly MigrationClient[] {
  if (value === undefined) {
    return [];
  }
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (names.length === 0) {
    throw new CliUsageError(
      "--skip-plugin-check needs claude, codex, cursor or all."
    );
  }
  const out = new Set<MigrationClient>();
  for (const name of names) {
    if (name === "all") {
      for (const client of MIGRATION_CLIENTS) {
        out.add(client);
      }
      continue;
    }
    const client = MIGRATION_CLIENTS.find((candidate) => candidate === name);
    if (!client) {
      throw new CliUsageError(
        "--skip-plugin-check accepts only claude, codex, cursor or all."
      );
    }
    out.add(client);
  }
  return [...out];
}

function resolveClients(opts: {
  readonly claude: boolean;
  readonly codex: boolean;
  readonly cursor: boolean;
}): readonly MigrationClient[] {
  const selected = MIGRATION_CLIENTS.filter((client) => opts[client]);
  return selected.length > 0 ? selected : MIGRATION_CLIENTS;
}

export async function handleSetupMigrate({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: SetupMigrateArgs;
}): Promise<number> {
  const options = args.options;
  const rollback = options.rollbackManifest?.trim();
  if (options.rollbackManifest !== undefined) {
    if (!rollback) {
      throw new CliUsageError("--rollback-manifest needs a manifest path.");
    }
    if (
      options.apply ||
      options.global ||
      options.allScopes ||
      options.claude ||
      options.codex ||
      options.cursor ||
      options.skipPluginCheck !== undefined ||
      options.path !== undefined
    ) {
      throw new CliUsageError(
        "--rollback-manifest takes only the manifest path (and --json); the manifest records the scopes and files."
      );
    }
    const result = await rollbackPluginMigration({
      manifestPath: resolve(ctx.cwd, rollback),
    });
    return await reportRollback({ result, json: options.json === true });
  }

  const home = (process.env.HOME ?? "").trim();
  const scopes: MigrationScopeRoot[] = [];
  if (!options.global || options.allScopes) {
    const startDir = resolve(ctx.cwd, options.path ?? ".");
    scopes.push({
      scope: "project",
      root: await findRepoRootForInit(startDir),
    });
  }
  if (options.global || options.allScopes) {
    scopes.push({ scope: "global", root: home });
  }
  const input = {
    scopes,
    home,
    clients: resolveClients({
      claude: options.claude === true,
      codex: options.codex === true,
      cursor: options.cursor === true,
    }),
    skipPluginCheck: parseSkipPluginCheck(options.skipPluginCheck),
  };

  if (!options.apply) {
    const plan = await planPluginMigration(input);
    return await reportPreview({ plan, json: options.json === true });
  }
  const result = await applyPluginMigration({
    ...input,
    backupDir: resolveMigrationBackupDir(),
  });
  return await reportApply({ result, json: options.json === true });
}

// ---------------------------------------------------------------------------
// Exit codes and JSON payloads
// ---------------------------------------------------------------------------

/** Preview is read-only; it fails only when a scope could not be resolved. */
export function migratePreviewExitCode(plan: PluginMigrationPlan): number {
  return plan.entries.some((entry) => entry.action === "error") ? 1 : 0;
}

/** Apply fails when refused or when any file could not be handled. */
export function migrateApplyExitCode(
  result: PluginMigrationApplyResult
): number {
  if (result.status === "refused") {
    return 1;
  }
  if (result.status === "nothing-to-migrate") {
    return 0;
  }
  return result.results.some(
    (entry) => entry.status === "error" || entry.status === "changed"
  )
    ? 1
    : 0;
}

/** Rollback fails on an invalid manifest, a conflict or an error. */
export function migrateRollbackExitCode(
  result: PluginMigrationRollbackResult
): number {
  if (result.status === "invalid-manifest") {
    return 1;
  }
  return result.results.some(
    (entry) => entry.status === "conflict" || entry.status === "error"
  )
    ? 1
    : 0;
}

function countBy<T extends string>(
  values: readonly T[]
): Partial<Record<T, number>> {
  const counts: Partial<Record<T, number>> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function label(target: SetupSyncTarget): string {
  return TARGET_LABELS[target] ?? target;
}

function scopeLabel(scope: "project" | "global"): string {
  return scope === "project" ? "Project" : "Global";
}

function describePlanEntry(entry: MigrationPlanEntry): string {
  const at = entry.path ? ` at ${entry.path}` : "";
  switch (entry.action) {
    case "remove":
      return `${label(entry.target)}: would remove${at} (replaced by the hack plugin)`;
    case "blocked":
      return `${label(entry.target)}: blocked${at}. ${entry.message ?? ""}`.trim();
    case "preserve":
      return `${label(entry.target)}: preserved${at}. ${entry.message ?? ""}`.trim();
    case "error":
      return `${label(entry.target)}: ${entry.message ?? "error"}`;
    default:
      return `${label(entry.target)}: absent${at}`;
  }
}

function describeCheck(check: PluginCheck): string {
  return `${CLIENT_LABELS[check.client]} plugin: ${check.status}. ${check.message}`;
}

function planItems(plan: PluginMigrationPlan): DisplayStatusItem[] {
  const scopes = [...new Set(plan.entries.map((entry) => entry.scope))];
  return scopes.map((scope) => {
    const entries = plan.entries.filter((entry) => entry.scope === scope);
    const present = entries.filter((entry) => entry.action !== "absent");
    // Human output names only the checks that decide a present file.
    const relevant = new Set<string>(
      present.flatMap((entry) =>
        entry.replacement === "shared"
          ? ["claude", "codex"]
          : [entry.replacement]
      )
    );
    const checks = plan.checks.filter(
      (check) => check.scope === scope && relevant.has(check.client)
    );
    const counts = countBy(entries.map((entry) => entry.action));
    let status: DisplayStatusItem["status"] = "ok";
    if ((counts.error ?? 0) > 0) {
      status = "error";
    } else if ((counts.blocked ?? 0) > 0 || (counts.preserve ?? 0) > 0) {
      status = "warn";
    }
    const lines = [
      ...checks.map(describeCheck),
      ...present.map(describePlanEntry),
    ];
    return {
      label: scopeLabel(scope),
      status,
      meta: `${counts.remove ?? 0} to remove, ${counts.blocked ?? 0} blocked, ${counts.preserve ?? 0} preserved`,
      detail: lines.length > 0 ? lines.join("\n") : undefined,
    };
  });
}

async function reportPreview(opts: {
  readonly plan: PluginMigrationPlan;
  readonly json: boolean;
}): Promise<number> {
  const exitCode = migratePreviewExitCode(opts.plan);
  if (opts.json) {
    emitCliResult({
      result: okResult({
        data: {
          action: "preview",
          dryRun: true,
          counts: countBy(opts.plan.entries.map((entry) => entry.action)),
          plugins: opts.plan.checks,
          targets: opts.plan.entries,
        },
      }),
    });
    return exitCode;
  }
  const blocked = opts.plan.entries.some((entry) => entry.action === "blocked");
  await display.statusList({
    title: "Plugin migration preview (nothing changed)",
    items: planItems(opts.plan),
  });
  logger.info({
    message: blocked
      ? "Install the hack plugin for the blocked clients and verify it loads in a fresh session (or pass --skip-plugin-check after checking it yourself), then rerun with --apply."
      : "Rerun with --apply to back up and remove the files marked 'would remove'.",
  });
  return exitCode;
}

function describeApplyEntry(entry: MigrationApplyEntry): string {
  const message = entry.message ? ` ${entry.message}` : "";
  return `${scopeLabel(entry.scope)} ${label(entry.target)}: ${entry.status} at ${entry.path}.${message}`;
}

const REFUSAL_MESSAGES: Readonly<
  Record<
    Extract<PluginMigrationApplyResult, { status: "refused" }>["reason"],
    string
  >
> = {
  blocked:
    "Migration refused; nothing was changed. The replacement plugin is not verified for at least one client with Hack-owned files.",
  "scope-error":
    "Migration refused; nothing was changed. A scope root could not be resolved.",
  "backup-failed":
    "Migration refused; nothing was changed. A file could not be read for backup.",
};

async function reportApply(opts: {
  readonly result: PluginMigrationApplyResult;
  readonly json: boolean;
}): Promise<number> {
  const { result } = opts;
  const exitCode = migrateApplyExitCode(result);
  if (opts.json) {
    emitCliResult({
      result: okResult({
        data: {
          action: "apply",
          dryRun: false,
          status: result.status,
          ...(result.status === "refused" ? { reason: result.reason } : {}),
          manifestPath:
            result.status === "applied" ? result.manifestPath : null,
          plugins: result.plan.checks,
          targets: result.plan.entries,
          results: result.status === "applied" ? result.results : [],
        },
      }),
    });
    return exitCode;
  }
  if (result.status === "refused") {
    await display.statusList({
      title: "Plugin migration refused",
      items: planItems(result.plan),
    });
    logger.error({ message: REFUSAL_MESSAGES[result.reason] });
    return exitCode;
  }
  if (result.status === "nothing-to-migrate") {
    await display.statusList({
      title: "Plugin migration: nothing to remove",
      items: planItems(result.plan),
    });
    return exitCode;
  }
  const counts = countBy(result.results.map((entry) => entry.status));
  await display.statusList({
    title: "Plugin migration applied",
    items: [
      {
        label: "Removed",
        status: exitCode === 0 ? "ok" : "error",
        meta: `${counts.removed ?? 0} removed`,
        detail: result.results.map(describeApplyEntry).join("\n"),
      },
    ],
  });
  logger.info({ message: `Backup manifest: ${result.manifestPath}` });
  logger.info({
    message: `Undo with: hack setup migrate --rollback-manifest ${result.manifestPath}`,
  });
  return exitCode;
}

function describeRollbackEntry(entry: MigrationRollbackEntry): string {
  const message = entry.message ? ` ${entry.message}` : "";
  return `${scopeLabel(entry.scope)} ${label(entry.target)}: ${entry.status} at ${entry.path}.${message}`;
}

async function reportRollback(opts: {
  readonly result: PluginMigrationRollbackResult;
  readonly json: boolean;
}): Promise<number> {
  const { result } = opts;
  const exitCode = migrateRollbackExitCode(result);
  if (opts.json) {
    emitCliResult({
      result: okResult({
        data: {
          action: "rollback",
          dryRun: false,
          status: result.status,
          ...(result.status === "invalid-manifest"
            ? { message: result.message }
            : {}),
          results: result.status === "rolled-back" ? result.results : [],
        },
      }),
    });
    return exitCode;
  }
  if (result.status === "invalid-manifest") {
    logger.error({ message: result.message });
    return exitCode;
  }
  const counts = countBy(result.results.map((entry) => entry.status));
  await display.statusList({
    title: "Plugin migration rolled back",
    items: [
      {
        label: "Restored",
        status: exitCode === 0 ? "ok" : "error",
        meta: `${counts.restored ?? 0} restored, ${counts["already-present"] ?? 0} already present, ${counts.conflict ?? 0} conflicts`,
        detail: result.results.map(describeRollbackEntry).join("\n"),
      },
    ],
  });
  return exitCode;
}
