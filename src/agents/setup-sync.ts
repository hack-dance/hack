import { renderCodexSkill } from "./codex-skill.ts";
import { renderCursorRules } from "./cursor.ts";
import { RETIRED_AGENT_AUTOMATION_MESSAGE } from "./explicit-integrations.ts";
import { renderHackInitSkill } from "./hack-init-skill.ts";
import type {
  IntegrationPreservedReason,
  IntegrationSurface,
} from "./integration-ownership.ts";
/** Historical v4 target metadata, retained for explicit inventory/recovery, never automatic refresh. */
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

/** Compatibility refusal: no scope is inspected, refreshed, removed or adopted. */
export function runSetupSyncScope(opts: {
  readonly action: SetupSyncAction;
  readonly scope: SetupSyncScope;
  readonly root: string;
  readonly installMissing: boolean;
}): Promise<SetupSyncTargetResult[]> {
  return Promise.resolve([
    {
      scope: opts.scope,
      target: "scope-root",
      path: opts.root,
      status: "error",
      message: RETIRED_AGENT_AUTOMATION_MESSAGE,
    },
  ]);
}
export function setupSyncExitCode(opts: {
  readonly action: SetupSyncAction;
  readonly results: readonly SetupSyncTargetResult[];
}): number {
  return opts.results.some((result) => result.status === "error") ? 1 : 0;
}
