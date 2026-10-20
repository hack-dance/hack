import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { readOptionalTextFile } from "../lib/fs.ts";
import { isRecord } from "../lib/guards.ts";
import {
  classifyIntegrationContent,
  classifyIntegrationFile,
  describePreservedReason,
  type IntegrationPreservedReason,
  removeOwnedIntegrationFile,
} from "./integration-ownership.ts";
import {
  checkPluginReplacement,
  type MigrationClient,
  type PluginCheckStatus,
} from "./plugin-replacement.ts";
import {
  listOwnedFileTargets,
  type OwnedFileTarget,
  type SetupSyncScope,
  type SetupSyncTarget,
} from "./setup-sync.ts";

/**
 * Scoped migration from standalone Hack agent files to the skills-only `hack`
 * plugin (HACK-1132).
 *
 * Contract:
 * - `planPluginMigration` is read-only. It lists every standalone Hack file
 *   target in the selected scopes and clients with one action: `remove`
 *   (Hack-owned and the replacement plugin is verified or its check was
 *   explicitly skipped), `blocked` (Hack-owned but the replacement is not
 *   verified), `preserve` (customized, unknown, or reached through a symbolic
 *   link) or `absent`. Ownership comes from the W11 classifier
 *   (`integration-ownership.ts`); this module never widens it.
 * - `applyPluginMigration` re-plans, refuses without writing anything when a
 *   target is `blocked` or a scope root is unresolved, and otherwise writes a
 *   backup manifest holding the exact bytes and mode of every file it will
 *   remove before removing any of them. The manifest write is the commit
 *   point: a file is removed only after its bytes are durable in the
 *   manifest, and only when its bytes still match the backup.
 * - `rollbackPluginMigration` restores each manifest entry whose path is
 *   absent, byte-for-byte with its recorded mode. It never overwrites an
 *   existing path: identical bytes are `already-present`, anything else is a
 *   `conflict` left unchanged. Rollback is idempotent and also recovers an
 *   interrupted apply.
 *
 * Only standalone skill and rule files are in scope. Claude primer hooks, MCP
 * entries and `AGENTS.md`/`CLAUDE.md` sections are never touched here.
 *
 * Replacement verification reads client configuration, not a live session:
 * Claude Code must enable `hack@hack-dance` in a settings file that applies to
 * the scope and list an installed copy that carries the replacement skills;
 * Codex must enable it in a `config.toml` that applies to the scope. Hack
 * cannot inspect Cursor plugin installs, so Cursor targets need an explicit
 * skip. A verified configuration is not proof that a fresh session loads the
 * plugin.
 *
 * Every path derives from explicit `root`, `home` and `backupDir` inputs.
 * Diagnostics are closed strings with no file content or caller input.
 * Planning, backup and removal are not atomic with respect to concurrent
 * editors; each removal rechecks bytes and ownership immediately before it
 * unlinks, which leaves the same one read-then-unlink window as W11.
 */

/**
 * Which plugin replaces a target. `shared` (`~/.ai/skills/hack-cli`) is a
 * cross-client root, replaced when the Claude Code or Codex plugin is.
 */
export type ReplacementClient = MigrationClient | "shared";

export type PluginCheck = {
  readonly scope: SetupSyncScope;
  readonly client: MigrationClient;
  readonly status: PluginCheckStatus;
  readonly message: string;
};

/** Why migration leaves a file in place. Closed and value-free. */
export type MigrationPreservedReason =
  | IntegrationPreservedReason
  | "symlinked-path";

export type MigrationPlanAction =
  | "remove"
  | "blocked"
  | "preserve"
  | "absent"
  | "error";

export type MigrationPlanEntry = {
  readonly scope: SetupSyncScope;
  readonly target: SetupSyncTarget;
  readonly replacement: ReplacementClient;
  readonly path: string;
  readonly action: MigrationPlanAction;
  readonly reason?: MigrationPreservedReason;
  readonly message?: string;
};

export type MigrationScopeRoot = {
  readonly scope: SetupSyncScope;
  /** Project root for `project`, home directory for `global`. */
  readonly root: string;
};

export type PluginMigrationInput = {
  readonly scopes: readonly MigrationScopeRoot[];
  /** Home directory whose user-level client configuration applies. */
  readonly home: string;
  readonly clients: readonly MigrationClient[];
  /** Clients whose replacement check the operator explicitly skipped. */
  readonly skipPluginCheck: readonly MigrationClient[];
};

export type PluginMigrationPlan = {
  readonly checks: readonly PluginCheck[];
  readonly entries: readonly MigrationPlanEntry[];
};

const TARGET_REPLACEMENT: Readonly<
  Partial<Record<SetupSyncTarget, ReplacementClient>>
> = {
  "cursor-rules": "cursor",
  "claude-hack-init-skill": "claude",
  "codex-hack-cli-skill": "codex",
  "codex-hack-init-skill": "codex",
  "shared-hack-cli-skill": "shared",
};

const PLUGIN_CHECK_MESSAGES: Readonly<Record<PluginCheckStatus, string>> = {
  verified: "The client configuration enables the hack plugin for this scope.",
  skipped: "The replacement check was skipped explicitly.",
  "not-installed":
    "The client configuration does not enable the hack plugin for this scope. Install it, verify it loads in a fresh session, then rerun.",
  disabled:
    "The client configuration disables the hack plugin for this scope. Enable it, verify it loads in a fresh session, then rerun.",
  incomplete:
    "The installed hack plugin copy is missing a replacement skill. Update or reinstall the plugin, then rerun.",
  unreadable:
    "The client configuration could not be read or parsed; the replacement is not verified.",
  "not-inspectable":
    "Hack cannot inspect this client's plugin installs. Verify the plugin loads in a fresh session, then pass --skip-plugin-check for this client.",
};

const BLOCKED_MESSAGE =
  "Hack-owned, but the replacement plugin is not verified; apply would refuse.";

const SYMLINK_MESSAGE =
  "Hack left this path unchanged because it is reached through a symbolic link, which rollback could not recreate. Remove it yourself if the plugin replaces it.";

/** Fixed operator guidance for a migration-preserved file. */
export function describeMigrationPreservedReason(
  reason: MigrationPreservedReason
): string {
  if (reason === "symlinked-path") {
    return SYMLINK_MESSAGE;
  }
  return describePreservedReason({ reason, action: "remove" });
}

/** Targets in one scope whose replacement belongs to a selected client. */
function selectTargets(opts: {
  readonly scope: SetupSyncScope;
  readonly clients: readonly MigrationClient[];
}): readonly (OwnedFileTarget & { readonly replacement: ReplacementClient })[] {
  const selected = new Set<ReplacementClient>(opts.clients);
  if (selected.has("claude") || selected.has("codex")) {
    selected.add("shared");
  }
  const out: (OwnedFileTarget & { readonly replacement: ReplacementClient })[] =
    [];
  for (const file of listOwnedFileTargets(opts.scope)) {
    const replacement = TARGET_REPLACEMENT[file.target];
    if (replacement && selected.has(replacement)) {
      out.push({ ...file, replacement });
    }
  }
  return out;
}

/** Read-only migration preview for the selected scopes and clients. */
export async function planPluginMigration(
  input: PluginMigrationInput
): Promise<PluginMigrationPlan> {
  const checks: PluginCheck[] = [];
  const entries: MigrationPlanEntry[] = [];
  const home = input.home.trim();
  for (const { scope, root: rawRoot } of input.scopes) {
    const root = rawRoot.trim();
    const targets = selectTargets({ scope, clients: input.clients });
    if (!root || (scope === "project" && !home)) {
      for (const target of targets) {
        entries.push({
          scope,
          target: target.target,
          replacement: target.replacement,
          path: "",
          action: "error",
          message:
            scope === "global" || !home
              ? "HOME is not set; cannot resolve integration paths."
              : "Project root could not be resolved.",
        });
      }
      continue;
    }

    const scopeChecks = new Map<MigrationClient, PluginCheck>();
    for (const client of input.clients) {
      const status = input.skipPluginCheck.includes(client)
        ? "skipped"
        : await checkPluginReplacement({ client, scope, root, home });
      const check: PluginCheck = {
        scope,
        client,
        status,
        message: PLUGIN_CHECK_MESSAGES[status],
      };
      scopeChecks.set(client, check);
      checks.push(check);
    }

    for (const target of targets) {
      const path = resolve(root, target.relativePath);
      entries.push({
        scope,
        target: target.target,
        replacement: target.replacement,
        path,
        ...(await planTarget({
          target,
          path,
          replaced: isReplaced({
            replacement: target.replacement,
            checks: scopeChecks,
          }),
        })),
      });
    }
  }
  return { checks, entries };
}

function isSatisfied(check: PluginCheck | undefined): boolean {
  return check?.status === "verified" || check?.status === "skipped";
}

function isReplaced(opts: {
  readonly replacement: ReplacementClient;
  readonly checks: ReadonlyMap<MigrationClient, PluginCheck>;
}): boolean {
  if (opts.replacement === "shared") {
    return (
      isSatisfied(opts.checks.get("claude")) ||
      isSatisfied(opts.checks.get("codex"))
    );
  }
  return isSatisfied(opts.checks.get(opts.replacement));
}

async function planTarget(opts: {
  readonly target: OwnedFileTarget;
  readonly path: string;
  readonly replaced: boolean;
}): Promise<Pick<MigrationPlanEntry, "action" | "reason" | "message">> {
  const ownership = await classifyIntegrationFile({
    surface: opts.target.surface,
    path: opts.path,
    currentRender: opts.target.render(),
  });
  if (ownership.kind === "absent") {
    return { action: "absent" };
  }
  if (ownership.kind === "customized" || ownership.kind === "unknown") {
    return {
      action: "preserve",
      reason: ownership.reason,
      message: describeMigrationPreservedReason(ownership.reason),
    };
  }
  if (await isSymlinkedPath({ path: opts.path })) {
    return {
      action: "preserve",
      reason: "symlinked-path",
      message: SYMLINK_MESSAGE,
    };
  }
  if (!opts.replaced) {
    return { action: "blocked", message: BLOCKED_MESSAGE };
  }
  return { action: "remove" };
}

/** True when the file or its containing directory is a symbolic link. */
async function isSymlinkedPath(opts: {
  readonly path: string;
}): Promise<boolean> {
  for (const candidate of [opts.path, dirname(opts.path)]) {
    try {
      if ((await lstat(candidate)).isSymbolicLink()) {
        return true;
      }
    } catch {
      // Absent components are judged by the classifier, not here.
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export const MIGRATION_MANIFEST_VERSION = 1;

/** Per-file outcome of an apply. */
export type MigrationApplyStatus =
  | "removed"
  | "preserved"
  | "changed"
  | "missing"
  | "error";

export type MigrationApplyEntry = {
  readonly scope: SetupSyncScope;
  readonly target: SetupSyncTarget;
  readonly path: string;
  readonly status: MigrationApplyStatus;
  readonly reason?: MigrationPreservedReason;
  readonly message?: string;
};

export type PluginMigrationApplyResult =
  | {
      /**
       * Nothing was written: a target is blocked, a scope root is unresolved,
       * or a removable file could not be read for backup.
       */
      readonly status: "refused";
      readonly reason: "blocked" | "scope-error" | "backup-failed";
      readonly plan: PluginMigrationPlan;
    }
  | {
      /** Nothing Hack-owned to remove; no manifest was written. */
      readonly status: "nothing-to-migrate";
      readonly plan: PluginMigrationPlan;
    }
  | {
      readonly status: "applied";
      readonly plan: PluginMigrationPlan;
      readonly manifestPath: string;
      readonly results: readonly MigrationApplyEntry[];
    };

type ManifestEntry = {
  readonly scope: SetupSyncScope;
  readonly root: string;
  readonly target: SetupSyncTarget;
  readonly relativePath: string;
  readonly path: string;
  readonly sha256: string;
  readonly mode: number;
  readonly contentBase64: string;
  readonly outcome?: MigrationApplyStatus;
};

type MigrationManifest = {
  readonly version: typeof MIGRATION_MANIFEST_VERSION;
  readonly kind: "hack-plugin-migration";
  readonly id: string;
  readonly createdAt: string;
  readonly state: "applying" | "applied";
  readonly entries: readonly ManifestEntry[];
};

/** Seams for tests; production uses the real clock, id and unlink. */
export type PluginMigrationApplyHooks = {
  readonly now?: () => Date;
  readonly id?: string;
  /** Called after the manifest commit and before each removal. */
  readonly beforeRemove?: (entry: {
    readonly path: string;
    readonly index: number;
  }) => Promise<void>;
};

/**
 * Apply the migration: refuse on any blocked target, back up every removable
 * file to a manifest under `backupDir`, then remove each one.
 */
export async function applyPluginMigration(
  input: PluginMigrationInput & {
    readonly backupDir: string;
    readonly hooks?: PluginMigrationApplyHooks;
  }
): Promise<PluginMigrationApplyResult> {
  const plan = await planPluginMigration(input);
  if (plan.entries.some((entry) => entry.action === "error")) {
    return { status: "refused", reason: "scope-error", plan };
  }
  if (plan.entries.some((entry) => entry.action === "blocked")) {
    return { status: "refused", reason: "blocked", plan };
  }
  const removable = plan.entries.filter((entry) => entry.action === "remove");
  if (removable.length === 0) {
    return { status: "nothing-to-migrate", plan };
  }

  const roots = new Map(input.scopes.map((s) => [s.scope, s.root.trim()]));
  const backups: ManifestEntry[] = [];
  for (const entry of removable) {
    const target = listOwnedFileTargets(entry.scope).find(
      (file) => file.target === entry.target
    );
    const root = roots.get(entry.scope) ?? "";
    const snapshot = await snapshotFile({ path: entry.path });
    if (!(target && snapshot)) {
      // All or nothing: never remove a file set whose backup is incomplete.
      return { status: "refused", reason: "backup-failed", plan };
    }
    backups.push({
      scope: entry.scope,
      root,
      target: entry.target,
      relativePath: target.relativePath,
      path: entry.path,
      sha256: snapshot.sha256,
      mode: snapshot.mode,
      contentBase64: snapshot.bytes.toString("base64"),
    });
  }

  const now = input.hooks?.now?.() ?? new Date();
  const id = input.hooks?.id ?? manifestId(now);
  const manifestPath = join(input.backupDir, `${id}.json`);
  const manifest: MigrationManifest = {
    version: MIGRATION_MANIFEST_VERSION,
    kind: "hack-plugin-migration",
    id,
    createdAt: now.toISOString(),
    state: "applying",
    entries: backups,
  };
  // Commit point: nothing is removed before this write succeeds.
  await writeManifest({ path: manifestPath, manifest });

  const results: MigrationApplyEntry[] = [];
  const recorded: ManifestEntry[] = [];
  for (const [index, backup] of backups.entries()) {
    await input.hooks?.beforeRemove?.({ path: backup.path, index });
    const status = await removeBackedUpFile({ backup });
    results.push({
      scope: backup.scope,
      target: backup.target,
      path: backup.path,
      ...status,
    });
    recorded.push({ ...backup, outcome: status.status });
  }
  await writeManifest({
    path: manifestPath,
    manifest: { ...manifest, state: "applied", entries: recorded },
  });
  return { status: "applied", plan, manifestPath, results };
}

const ISO_SEPARATORS = /[-:]/g;
const ISO_FRACTION = /\.\d+Z$/;

function manifestId(now: Date): string {
  const stamp = now
    .toISOString()
    .replace(ISO_SEPARATORS, "")
    .replace(ISO_FRACTION, "Z");
  return `plugin-migration-${stamp}-${randomBytes(4).toString("hex")}`;
}

async function snapshotFile(opts: { readonly path: string }): Promise<{
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly mode: number;
} | null> {
  try {
    const info = await lstat(opts.path);
    if (!info.isFile()) {
      return null;
    }
    const bytes = await readFile(opts.path);
    return { bytes, sha256: sha256(bytes), mode: info.mode & 0o7777 };
  } catch {
    return null;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeManifest(opts: {
  readonly path: string;
  readonly manifest: MigrationManifest;
}): Promise<void> {
  await mkdir(dirname(opts.path), { recursive: true, mode: 0o700 });
  const temporary = `${opts.path}.${process.pid}.tmp`;
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(opts.manifest, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, opts.path);
}

async function removeBackedUpFile(opts: {
  readonly backup: ManifestEntry;
}): Promise<Pick<MigrationApplyEntry, "status" | "reason" | "message">> {
  const { backup } = opts;
  const target = listOwnedFileTargets(backup.scope).find(
    (file) => file.target === backup.target
  );
  if (!target) {
    return { status: "error", message: "Unknown migration target." };
  }
  try {
    if (await isSymlinkedPath({ path: backup.path })) {
      return {
        status: "preserved",
        reason: "symlinked-path",
        message: SYMLINK_MESSAGE,
      };
    }
    const current = await snapshotFile({ path: backup.path });
    if (!current) {
      return { status: "missing" };
    }
    if (current.sha256 !== backup.sha256) {
      return {
        status: "changed",
        message:
          "The file changed after it was backed up; left unchanged. Rerun the preview.",
      };
    }
    const outcome = await removeOwnedIntegrationFile({
      surface: target.surface,
      path: backup.path,
      currentRender: target.render(),
      removeEmptyDirectory: target.removeEmptyDirectory,
    });
    if (outcome.status === "preserved") {
      return {
        status: "preserved",
        reason: outcome.reason,
        message: describeMigrationPreservedReason(outcome.reason),
      };
    }
    return { status: outcome.status };
  } catch {
    return {
      status: "error",
      message:
        "The file could not be removed; it is recorded in the backup manifest.",
    };
  }
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

export type MigrationRollbackStatus =
  | "restored"
  | "already-present"
  | "conflict"
  | "error";

export type MigrationRollbackEntry = {
  readonly scope: SetupSyncScope;
  readonly target: SetupSyncTarget;
  readonly path: string;
  readonly status: MigrationRollbackStatus;
  readonly message?: string;
};

export type PluginMigrationRollbackResult =
  | {
      readonly status: "invalid-manifest";
      readonly message: string;
    }
  | {
      readonly status: "rolled-back";
      readonly results: readonly MigrationRollbackEntry[];
    };

const CONFLICT_MESSAGE =
  "A different file now exists at this path; left unchanged. Move it aside and rerun the rollback to restore the backup.";

/** Restore the exact bytes recorded in a migration manifest. */
export async function rollbackPluginMigration(opts: {
  readonly manifestPath: string;
}): Promise<PluginMigrationRollbackResult> {
  const parsed = await readManifest({ path: opts.manifestPath });
  if (!parsed.ok) {
    return { status: "invalid-manifest", message: parsed.message };
  }
  const results: MigrationRollbackEntry[] = [];
  for (const entry of parsed.entries) {
    results.push({
      scope: entry.scope,
      target: entry.target,
      path: entry.path,
      ...(await restoreEntry({ entry })),
    });
  }
  return { status: "rolled-back", results };
}

type ValidEntry = {
  readonly scope: SetupSyncScope;
  readonly target: SetupSyncTarget;
  readonly path: string;
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly mode: number;
};

const INVALID_MANIFEST =
  "The migration manifest is missing, unreadable, or not a valid Hack plugin migration backup; nothing was restored.";

/**
 * Parse and validate a manifest. Every entry must name a known target whose
 * recorded path is exactly that target's path under the recorded root, its
 * bytes must match the recorded digest, and those bytes must be a current or
 * known earlier Hack render for the target; otherwise nothing is restored.
 */
async function readManifest(opts: {
  readonly path: string;
}): Promise<
  | { readonly ok: true; readonly entries: readonly ValidEntry[] }
  | { readonly ok: false; readonly message: string }
> {
  const invalid = { ok: false, message: INVALID_MANIFEST } as const;
  const file = await readOptionalTextFile(opts.path);
  if (file.kind !== "text") {
    return invalid;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.text);
  } catch {
    return invalid;
  }
  if (
    !isRecord(parsed) ||
    parsed.version !== MIGRATION_MANIFEST_VERSION ||
    parsed.kind !== "hack-plugin-migration" ||
    !Array.isArray(parsed.entries)
  ) {
    return invalid;
  }
  const entries: ValidEntry[] = [];
  for (const raw of parsed.entries) {
    const entry = validateManifestEntry(raw);
    if (!entry) {
      return invalid;
    }
    entries.push(entry);
  }
  return { ok: true, entries };
}

function validateManifestEntry(raw: unknown): ValidEntry | null {
  if (!isRecord(raw)) {
    return null;
  }
  const {
    scope,
    root,
    target,
    path,
    sha256: digest,
    mode,
    contentBase64,
  } = raw;
  if (
    (scope !== "project" && scope !== "global") ||
    typeof root !== "string" ||
    !isAbsolute(root) ||
    typeof target !== "string" ||
    typeof path !== "string" ||
    typeof digest !== "string" ||
    typeof mode !== "number" ||
    !Number.isInteger(mode) ||
    mode < 0 ||
    mode > 0o7777 ||
    typeof contentBase64 !== "string"
  ) {
    return null;
  }
  const owned = listOwnedFileTargets(scope).find(
    (file) => file.target === target
  );
  if (!owned || resolve(root, owned.relativePath) !== path) {
    return null;
  }
  const bytes = Buffer.from(contentBase64, "base64");
  if (sha256(bytes) !== digest) {
    return null;
  }
  // Apply backs up only Hack-owned renders, so rollback restores only those.
  const ownership = classifyIntegrationContent({
    surface: owned.surface,
    content: bytes.toString("utf8"),
    currentRender: owned.render(),
  });
  if (
    ownership.kind !== "hack-owned-current" &&
    ownership.kind !== "hack-owned-prior"
  ) {
    return null;
  }
  return { scope, target: owned.target, path, bytes, sha256: digest, mode };
}

async function restoreEntry(opts: {
  readonly entry: ValidEntry;
}): Promise<Pick<MigrationRollbackEntry, "status" | "message">> {
  const { entry } = opts;
  try {
    const existing = await inspectRestorePath({ entry });
    if (existing === "identical") {
      return { status: "already-present" };
    }
    if (existing === "other") {
      return { status: "conflict", message: CONFLICT_MESSAGE };
    }
    await mkdir(dirname(entry.path), { recursive: true });
    // Exclusive create: never replace a file that appeared since the check.
    await writeFile(entry.path, entry.bytes, { flag: "wx", mode: entry.mode });
    await chmod(entry.path, entry.mode);
    return { status: "restored" };
  } catch (error: unknown) {
    if (errorCode(error) === "EEXIST") {
      return { status: "conflict", message: CONFLICT_MESSAGE };
    }
    return {
      status: "error",
      message: "The backup could not be restored at this path.",
    };
  }
}

/** What occupies a restore path. Symlinks and directories are `other`. */
async function inspectRestorePath(opts: {
  readonly entry: ValidEntry;
}): Promise<"absent" | "identical" | "other"> {
  let isFile: boolean;
  try {
    isFile = (await lstat(opts.entry.path)).isFile();
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") {
      return "absent";
    }
    throw error;
  }
  if (!isFile) {
    return "other";
  }
  const bytes = await readFile(opts.entry.path);
  return sha256(bytes) === opts.entry.sha256 ? "identical" : "other";
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return;
  }
  const { code } = error;
  return typeof code === "string" ? code : undefined;
}
