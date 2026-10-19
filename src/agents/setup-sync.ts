import { dirname, resolve } from "node:path";

import {
  ensureDir,
  readOptionalTextFile,
  writeTextFileIfChanged,
} from "../lib/fs.ts";
import { isRecord } from "../lib/guards.ts";
import {
  checkAgentDocs,
  removeAgentDocs,
  upsertAgentDocs,
} from "../mcp/agent-docs.ts";
import {
  checkMcpConfig,
  installMcpConfig,
  type McpTarget,
  removeMcpConfig,
} from "../mcp/install.ts";
import {
  ensureClaudePrimerHooks,
  inspectClaudePrimerHooks,
  stripClaudePrimerHooks,
} from "./claude.ts";
import { renderCodexSkill } from "./codex-skill.ts";
import { renderCursorRules } from "./cursor.ts";
import { renderHackInitSkill } from "./hack-init-skill.ts";
import { normalizeInstructionText } from "./instruction-source.ts";
import {
  classifyIntegrationFile,
  describePreservedReason,
  type IntegrationPreservedReason,
  type IntegrationSurface,
  installOwnedIntegrationFile,
  removeOwnedIntegrationFile,
} from "./integration-ownership.ts";
import {
  checkLegacyProjectAgentArtifacts,
  checkLegacyUserAgentArtifacts,
  type LegacyAgentArtifactResult,
  removeLegacyProjectAgentArtifacts,
  removeLegacyUserAgentArtifacts,
} from "./legacy-artifacts.ts";

/**
 * Target-level engine for `hack setup sync` (HACK-1132).
 *
 * Contract:
 * - `sync` is refresh-only by default. It rewrites a target only when the
 *   target already exists and Hack owns it (a current or known prior render
 *   for standalone files, the marker-delimited section for agent docs, the
 *   Hack primer entries for Claude hooks). A missing target is reported as
 *   `missing` and is never created.
 * - `installMissing` opts in to creating missing targets in the selected
 *   scope. It never overrides the ownership gate.
 * - A customized or unrecognized standalone file is `preserved` with a
 *   closed, value-free reason and left byte-identical.
 * - `check` computes the outcome `sync` would report and writes nothing.
 * - `remove` deletes only Hack-owned content.
 *
 * Every path derives from the explicit `projectRoot` and `home` inputs; this
 * module never reads `HOME` itself. Diagnostics are closed strings that carry
 * no file content or caller input. Classification and the following write
 * are not atomic (see `integration-ownership.ts`).
 */

export type SetupSyncAction = "sync" | "check" | "remove";

export type SetupSyncScope = "project" | "global";

export type SetupSyncTarget =
  | "cursor-rules"
  | "claude-hooks"
  | "claude-hack-init-skill"
  | "codex-hack-cli-skill"
  | "codex-hack-init-skill"
  | "shared-hack-cli-skill"
  | "cursor-mcp"
  | "claude-mcp"
  | "codex-mcp"
  | "agents-md"
  | "claude-md"
  | "retired-artifact"
  | "scope-root";

/**
 * Per-target outcome. With `check`, the status is what `sync` would report.
 * `missing` means skipped: the target does not exist and was not created.
 */
export type SetupSyncStatus =
  | "refreshed"
  | "unchanged"
  | "installed"
  | "preserved"
  | "missing"
  | "removed"
  | "error";

export type SetupSyncTargetResult = {
  readonly scope: SetupSyncScope;
  readonly target: SetupSyncTarget;
  readonly path: string;
  readonly status: SetupSyncStatus;
  /** Set with `preserved`: why Hack left the file unchanged. */
  readonly reason?: IntegrationPreservedReason;
  readonly message?: string;
};

type Outcome = Omit<SetupSyncTargetResult, "scope" | "target" | "path">;

/** A standalone Hack-owned file target and the render that owns it. */
export type OwnedFileTarget = {
  readonly target: SetupSyncTarget;
  readonly surface: IntegrationSurface;
  readonly relativePath: string;
  readonly render: () => string;
  readonly removeEmptyDirectory: boolean;
};

const PROJECT_OWNED_FILES: readonly OwnedFileTarget[] = [
  {
    target: "cursor-rules",
    surface: "cursor-rules",
    relativePath: ".cursor/rules/hack.mdc",
    render: renderCursorRules,
    removeEmptyDirectory: false,
  },
  {
    target: "claude-hack-init-skill",
    surface: "hack-init-skill",
    relativePath: ".claude/skills/hack-init/SKILL.md",
    render: renderHackInitSkill,
    removeEmptyDirectory: true,
  },
  {
    target: "codex-hack-cli-skill",
    surface: "hack-cli-skill",
    relativePath: ".codex/skills/hack-cli/SKILL.md",
    render: renderCodexSkill,
    removeEmptyDirectory: true,
  },
  {
    target: "codex-hack-init-skill",
    surface: "hack-init-skill",
    relativePath: ".codex/skills/hack-init/SKILL.md",
    render: renderHackInitSkill,
    removeEmptyDirectory: true,
  },
];

const GLOBAL_OWNED_FILES: readonly OwnedFileTarget[] = [
  ...PROJECT_OWNED_FILES,
  {
    target: "shared-hack-cli-skill",
    surface: "hack-cli-skill",
    relativePath: ".ai/skills/hack-cli/SKILL.md",
    render: renderCodexSkill,
    removeEmptyDirectory: true,
  },
];

/**
 * Standalone Hack-owned file targets for one scope, relative to the scope
 * root (project root or home). Shared with the plugin migration engine so
 * both act on the same paths and ownership surfaces.
 */
export function listOwnedFileTargets(
  scope: SetupSyncScope
): readonly OwnedFileTarget[] {
  return scope === "global" ? GLOBAL_OWNED_FILES : PROJECT_OWNED_FILES;
}

const CLAUDE_SETTINGS_PATHS: Readonly<Record<SetupSyncScope, string>> = {
  project: ".claude/settings.local.json",
  global: ".claude/settings.json",
};

const MCP_TARGETS: readonly {
  readonly target: SetupSyncTarget;
  readonly client: McpTarget;
}[] = [
  { target: "cursor-mcp", client: "cursor" },
  { target: "claude-mcp", client: "claude" },
  { target: "codex-mcp", client: "codex" },
];

const DOC_TARGETS: readonly {
  readonly target: SetupSyncTarget;
  readonly doc: "agents" | "claude";
}[] = [
  { target: "agents-md", doc: "agents" },
  { target: "claude-md", doc: "claude" },
];

/**
 * Run one sync action for one scope. `root` is the project root for the
 * project scope and the home directory for the global scope; an empty root
 * yields one `error` result instead of touching any path.
 */
export async function runSetupSyncScope(opts: {
  readonly action: SetupSyncAction;
  readonly scope: SetupSyncScope;
  readonly root: string;
  readonly installMissing: boolean;
}): Promise<SetupSyncTargetResult[]> {
  const root = opts.root.trim();
  if (!root) {
    return [
      {
        scope: opts.scope,
        target: "scope-root",
        path: "",
        status: "error",
        message:
          opts.scope === "global"
            ? "HOME is not set; cannot resolve global integration paths."
            : "Project root could not be resolved.",
      },
    ];
  }

  const context: ScopeContext = {
    action: opts.action,
    scope: opts.scope,
    root,
    installMissing: opts.action === "sync" ? opts.installMissing : false,
    planInstall: opts.action === "check" && opts.installMissing,
  };
  const ownedFiles = listOwnedFileTargets(opts.scope);

  const results: SetupSyncTargetResult[] = [];
  for (const file of ownedFiles) {
    results.push(await runOwnedFileTarget({ context, file }));
  }
  results.push(await runClaudeHooksTarget({ context }));
  results.push(...(await runRetiredArtifacts({ context })));
  for (const mcp of MCP_TARGETS) {
    results.push(await runMcpTarget({ context, ...mcp }));
  }
  if (opts.scope === "project") {
    for (const doc of DOC_TARGETS) {
      results.push(await runAgentDocTarget({ context, ...doc }));
    }
  }
  return results;
}

/**
 * Exit status for a sync action. `sync` and `remove` fail only on errors.
 * `check` fails when `sync` with the same flags would change something, a
 * file is preserved (its content is not Hack's current render), or a target
 * could not be checked. A missing target is not a check failure unless
 * `--install-missing` was requested, in which case it reports `installed`.
 */
export function setupSyncExitCode(opts: {
  readonly action: SetupSyncAction;
  readonly results: readonly SetupSyncTargetResult[];
}): number {
  return opts.results.some((result) =>
    isSetupSyncFailure({ action: opts.action, status: result.status })
  )
    ? 1
    : 0;
}

/** Whether one target status fails the given action. */
export function isSetupSyncFailure(opts: {
  readonly action: SetupSyncAction;
  readonly status: SetupSyncStatus;
}): boolean {
  if (opts.status === "error") {
    return true;
  }
  if (opts.action !== "check") {
    return false;
  }
  return (
    opts.status === "refreshed" ||
    opts.status === "installed" ||
    opts.status === "removed" ||
    opts.status === "preserved"
  );
}

type ScopeContext = {
  readonly action: SetupSyncAction;
  readonly scope: SetupSyncScope;
  readonly root: string;
  /** Write missing targets (sync with `--install-missing`). */
  readonly installMissing: boolean;
  /** Report missing targets as `installed` (check with `--install-missing`). */
  readonly planInstall: boolean;
};

function withTarget(opts: {
  readonly context: ScopeContext;
  readonly target: SetupSyncTarget;
  readonly path: string;
  readonly outcome: Outcome;
}): SetupSyncTargetResult {
  return {
    scope: opts.context.scope,
    target: opts.target,
    path: opts.path,
    ...opts.outcome,
  };
}

/** Outcome for a target that does not exist yet. */
function missingOutcome(context: ScopeContext): Outcome | null {
  if (context.planInstall) {
    return { status: "installed" };
  }
  if (!context.installMissing) {
    return { status: "missing" };
  }
  return null;
}

function preservedOutcome(reason: IntegrationPreservedReason): Outcome {
  return {
    status: "preserved",
    reason,
    message: describePreservedReason({ reason, action: "sync" }),
  };
}

async function runOwnedFileTarget(opts: {
  readonly context: ScopeContext;
  readonly file: OwnedFileTarget;
}): Promise<SetupSyncTargetResult> {
  const { context, file } = opts;
  const path = resolve(context.root, file.relativePath);
  const outcome =
    context.action === "remove"
      ? await removeOwnedFile({ file, path })
      : await syncOwnedFile({ context, file, path });
  return withTarget({ context, target: file.target, path, outcome });
}

async function syncOwnedFile(opts: {
  readonly context: ScopeContext;
  readonly file: OwnedFileTarget;
  readonly path: string;
}): Promise<Outcome> {
  const { context, file, path } = opts;
  const render = file.render();
  const ownership = await classifyIntegrationFile({
    surface: file.surface,
    path,
    currentRender: render,
  });
  if (ownership.kind === "absent") {
    const planned = missingOutcome(context);
    if (planned) {
      return planned;
    }
    const installed = await installOwnedIntegrationFile({
      surface: file.surface,
      path,
      render,
    });
    return installed.status === "preserved"
      ? preservedOutcome(installed.reason)
      : { status: "installed" };
  }
  if (ownership.kind === "customized" || ownership.kind === "unknown") {
    return preservedOutcome(ownership.reason);
  }

  const existing = await readOptionalTextFile(path);
  if (existing.kind !== "text") {
    return preservedOutcome("unreadable");
  }
  if (
    normalizeInstructionText({ text: existing.text }) ===
    normalizeInstructionText({ text: render })
  ) {
    return { status: "unchanged" };
  }
  if (context.action === "check") {
    return { status: "refreshed" };
  }
  const refreshed = await installOwnedIntegrationFile({
    surface: file.surface,
    path,
    render,
  });
  if (refreshed.status === "preserved") {
    return preservedOutcome(refreshed.reason);
  }
  return { status: refreshed.status === "noop" ? "unchanged" : "refreshed" };
}

async function removeOwnedFile(opts: {
  readonly file: OwnedFileTarget;
  readonly path: string;
}): Promise<Outcome> {
  const outcome = await removeOwnedIntegrationFile({
    surface: opts.file.surface,
    path: opts.path,
    currentRender: opts.file.render(),
    removeEmptyDirectory: opts.file.removeEmptyDirectory,
  });
  if (outcome.status === "preserved") {
    return {
      status: "preserved",
      reason: outcome.reason,
      message: outcome.message,
    };
  }
  if (outcome.status === "removed" && outcome.message) {
    return { status: "removed", message: outcome.message };
  }
  return { status: outcome.status };
}

type ParsedSettings =
  | { readonly kind: "absent" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ok"; readonly value: Record<string, unknown> };

async function readClaudeSettings(path: string): Promise<ParsedSettings> {
  const file = await readOptionalTextFile(path);
  if (file.kind === "absent") {
    return { kind: "absent" };
  }
  if (file.kind === "unreadable") {
    return {
      kind: "error",
      message: "Claude settings exist but could not be read; left unchanged.",
    };
  }
  if (file.text.trim().length === 0) {
    return { kind: "ok", value: {} };
  }
  try {
    const parsed: unknown = JSON.parse(file.text);
    if (isRecord(parsed)) {
      return { kind: "ok", value: parsed };
    }
  } catch {
    // Fall through to the closed diagnostic; never echo parser output.
  }
  return {
    kind: "error",
    message: "Claude settings are not a JSON object; left unchanged.",
  };
}

async function writeClaudeSettings(opts: {
  readonly path: string;
  readonly settings: Record<string, unknown>;
}): Promise<boolean> {
  await ensureDir(dirname(opts.path));
  const result = await writeTextFileIfChanged(
    opts.path,
    `${JSON.stringify(opts.settings, null, 2)}\n`
  );
  return result.changed;
}

async function runClaudeHooksTarget(opts: {
  readonly context: ScopeContext;
}): Promise<SetupSyncTargetResult> {
  const { context } = opts;
  const path = resolve(context.root, CLAUDE_SETTINGS_PATHS[context.scope]);
  const settings = await readClaudeSettings(path);
  let outcome: Outcome;
  if (settings.kind === "error") {
    outcome = { status: "error", message: settings.message };
  } else if (context.action === "remove") {
    outcome = await removeClaudeHooks({ path, settings });
  } else {
    outcome = await syncClaudeHooks({
      context,
      path,
      value: settings.kind === "ok" ? settings.value : {},
    });
  }
  return withTarget({ context, target: "claude-hooks", path, outcome });
}

async function removeClaudeHooks(opts: {
  readonly path: string;
  readonly settings: Exclude<ParsedSettings, { readonly kind: "error" }>;
}): Promise<Outcome> {
  if (opts.settings.kind === "absent") {
    return { status: "missing" };
  }
  if (!stripClaudePrimerHooks({ settings: opts.settings.value })) {
    return { status: "missing" };
  }
  await writeClaudeSettings({ path: opts.path, settings: opts.settings.value });
  return { status: "removed" };
}

/**
 * Settings with no Hack primer entry are a missing integration; settings
 * with some entries are Hack-owned and are completed on refresh. Other
 * settings and hooks are kept.
 */
async function syncClaudeHooks(opts: {
  readonly context: ScopeContext;
  readonly path: string;
  readonly value: Record<string, unknown>;
}): Promise<Outcome> {
  const { context, path, value } = opts;
  const coverage = inspectClaudePrimerHooks({ settings: value });
  if (coverage === "complete") {
    return { status: "unchanged" };
  }
  if (coverage === "none") {
    const planned = missingOutcome(context);
    if (planned) {
      return planned;
    }
    ensureClaudePrimerHooks({ settings: value });
    await writeClaudeSettings({ path, settings: value });
    return { status: "installed" };
  }
  if (context.action === "check") {
    return { status: "refreshed" };
  }
  ensureClaudePrimerHooks({ settings: value });
  const changed = await writeClaudeSettings({ path, settings: value });
  return { status: changed ? "refreshed" : "unchanged" };
}

async function runMcpTarget(opts: {
  readonly context: ScopeContext;
  readonly target: SetupSyncTarget;
  readonly client: McpTarget;
}): Promise<SetupSyncTargetResult> {
  const { context, target, client } = opts;
  const scope = context.scope === "global" ? "user" : "project";
  const location =
    context.scope === "global"
      ? { home: context.root }
      : { projectRoot: context.root };
  const outcome = await (async (): Promise<
    Outcome & { readonly path?: string }
  > => {
    try {
      if (context.action === "remove") {
        const [removed] = await removeMcpConfig({
          targets: [client],
          scope,
          ...location,
        });
        return mapMcpResult(removed);
      }
      const [checked] = await checkMcpConfig({
        targets: [client],
        scope,
        ...location,
      });
      if (checked?.status !== "missing") {
        return mapMcpResult(checked);
      }
      const planned = missingOutcome(context);
      if (planned) {
        return { ...planned, path: checked.path };
      }
      // Ordinary install only adds a missing entry; it never replaces one.
      const [installed] = await installMcpConfig({
        targets: [client],
        scope,
        ...location,
      });
      if (installed?.status === "error") {
        return mapMcpResult(installed);
      }
      return { status: "installed", path: installed?.path };
    } catch {
      return {
        status: "error",
        message: "MCP configuration could not be read; left unchanged.",
      };
    }
  })();
  const { path, ...rest } = outcome;
  return withTarget({ context, target, path: path ?? "", outcome: rest });
}

function mapMcpResult(
  result:
    | {
        readonly status: string;
        readonly path?: string;
        readonly message?: string;
      }
    | undefined
): Outcome & { readonly path?: string } {
  if (!result) {
    return { status: "error", message: "MCP configuration was not checked." };
  }
  const path = result.path;
  switch (result.status) {
    case "present":
      return { status: "unchanged", path };
    case "removed":
      return { status: "removed", path };
    case "missing":
    case "noop":
      return { status: "missing", path };
    default:
      return {
        status: "error",
        path,
        message: "MCP configuration is invalid or unreadable; left unchanged.",
      };
  }
}

async function runAgentDocTarget(opts: {
  readonly context: ScopeContext;
  readonly target: SetupSyncTarget;
  readonly doc: "agents" | "claude";
}): Promise<SetupSyncTargetResult> {
  const { context, target, doc } = opts;
  const outcome = await (async (): Promise<
    Outcome & { readonly path: string }
  > => {
    if (context.action === "remove") {
      const [removed] = await removeAgentDocs({
        projectRoot: context.root,
        targets: [doc],
      });
      return mapAgentDocWrite({
        action: "remove",
        result: removed,
        root: context.root,
        doc,
      });
    }
    const [checked] = await checkAgentDocs({
      projectRoot: context.root,
      targets: [doc],
    });
    const path = checked?.path ?? resolve(context.root, docFilename(doc));
    if (!checked || checked.status === "error") {
      if (checked?.unmanaged) {
        // A user-owned doc without a Hack section: the section is missing.
        return await installAgentDocOrSkip({ context, doc, path });
      }
      if (checked?.malformed) {
        return { ...preservedOutcome("customized-content"), path };
      }
      return {
        status: "error",
        path,
        message: "Agent doc could not be read; left unchanged.",
      };
    }
    if (checked.status === "missing") {
      return await installAgentDocOrSkip({ context, doc, path });
    }
    if (checked.status === "present") {
      return { status: "unchanged", path };
    }
    if (context.action === "check") {
      return { status: "refreshed", path };
    }
    const [written] = await upsertAgentDocs({
      projectRoot: context.root,
      targets: [doc],
    });
    return mapAgentDocWrite({
      action: "sync",
      result: written,
      root: context.root,
      doc,
    });
  })();
  const { path, ...rest } = outcome;
  return withTarget({ context, target, path, outcome: rest });
}

async function installAgentDocOrSkip(opts: {
  readonly context: ScopeContext;
  readonly doc: "agents" | "claude";
  readonly path: string;
}): Promise<Outcome & { readonly path: string }> {
  const planned = missingOutcome(opts.context);
  if (planned) {
    return { ...planned, path: opts.path };
  }
  const [written] = await upsertAgentDocs({
    projectRoot: opts.context.root,
    targets: [opts.doc],
  });
  if (written?.status === "error") {
    return {
      status: "error",
      path: opts.path,
      message: "Agent doc could not be written; left unchanged.",
    };
  }
  return { status: "installed", path: opts.path };
}

function mapAgentDocWrite(opts: {
  readonly action: "sync" | "remove";
  readonly result:
    | { readonly status: string; readonly path: string }
    | undefined;
  readonly root: string;
  readonly doc: "agents" | "claude";
}): Outcome & { readonly path: string } {
  const path = opts.result?.path ?? resolve(opts.root, docFilename(opts.doc));
  switch (opts.result?.status) {
    case "removed":
      return { status: "removed", path };
    case "noop":
      // Remove found no Hack section; refresh found the section current.
      return {
        status: opts.action === "remove" ? "missing" : "unchanged",
        path,
      };
    case "updated":
    case "created":
      return { status: "refreshed", path };
    default:
      return {
        status: "error",
        path,
        message: "Agent doc could not be updated; left unchanged.",
      };
  }
}

function docFilename(doc: "agents" | "claude"): string {
  return doc === "agents" ? "AGENTS.md" : "CLAUDE.md";
}

/**
 * Retired Hack artifacts are reported only when present. `sync` and `remove`
 * delete recognized ones; `check` reports them as `removed` (would remove).
 */
async function runRetiredArtifacts(opts: {
  readonly context: ScopeContext;
}): Promise<SetupSyncTargetResult[]> {
  const { context } = opts;
  const checkOnly = context.action === "check";
  let results: LegacyAgentArtifactResult[];
  if (context.scope === "project") {
    results = checkOnly
      ? await checkLegacyProjectAgentArtifacts({ projectRoot: context.root })
      : await removeLegacyProjectAgentArtifacts({ projectRoot: context.root });
  } else {
    results = checkOnly
      ? await checkLegacyUserAgentArtifacts({ home: context.root })
      : await removeLegacyUserAgentArtifacts({ home: context.root });
  }
  return results
    .filter((result) => result.status !== "absent")
    .map((result) =>
      withTarget({
        context,
        target: "retired-artifact",
        path: result.path,
        outcome:
          result.status === "error"
            ? {
                status: "error",
                message:
                  "Retired artifact path holds unrecognized or malformed content; left unchanged.",
              }
            : { status: "removed" },
      })
    );
}
