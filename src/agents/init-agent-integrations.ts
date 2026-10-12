import { confirm, isCancel, multiselect, note } from "@clack/prompts";
import { upsertAgentDocs } from "../mcp/agent-docs.ts";
import { installMcpConfig, type McpTarget } from "../mcp/install.ts";
import { logger } from "../ui/logger.ts";
import { installClaudeHooks } from "./claude.ts";
import { installCodexSkill } from "./codex-skill.ts";
import { installCursorRules } from "./cursor.ts";

/**
 * Coding-agent step of interactive `hack init`.
 *
 * Contract: the default path is non-mutating. It prints a note that points at
 * the optional native plugin and `hack agent onboard`, and writes nothing under
 * `.cursor`, `.claude`, `.codex`, `AGENTS.md`, `CLAUDE.md` or `.mcp.json`.
 * Repository-local export is a separate, explicit opt-in: its confirm defaults
 * to "no" and its target list starts empty, so only targets the user selects
 * are written. Non-interactive runs neither prompt nor write.
 */

/** Repository-local agent files `hack init` can export on explicit request. */
export type InitAgentExportTarget =
  | "cursor"
  | "claude"
  | "codex"
  | "agents"
  | "mcp";

export type InitAgentExportOption = {
  readonly value: InitAgentExportTarget;
  readonly label: string;
};

export const INIT_AGENT_EXPORT_CONFIRM = {
  message:
    "Also write Hack agent files into this repository? (most setups only need the plugin)",
  initialValue: false,
} as const;

export const INIT_AGENT_EXPORT_SELECT_MESSAGE =
  "Select repository files to write (none selected by default):";

export const INIT_AGENT_EXPORT_OPTIONS: readonly InitAgentExportOption[] = [
  {
    value: "cursor",
    label: "Cursor rules: writes .cursor/rules/hack.mdc into this repository",
  },
  {
    value: "claude",
    label:
      "Claude Code hooks: writes .claude/settings.local.json and .claude/skills/hack-init into this repository",
  },
  {
    value: "codex",
    label: "Codex skill: writes .codex/skills/hack-cli into this repository",
  },
  {
    value: "agents",
    label: "Agent docs: writes AGENTS.md and CLAUDE.md into this repository",
  },
  {
    value: "mcp",
    label:
      "MCP config (no-shell clients): writes .mcp.json, .cursor/mcp.json or .codex/config.toml into this repository",
  },
];

/** Repository writes resolved from an explicit export selection. */
export type InitAgentExportPlan = {
  readonly cursor: boolean;
  readonly claude: boolean;
  readonly codex: boolean;
  readonly agentDocs: boolean;
  readonly mcpTargets: readonly McpTarget[];
};

const ALL_MCP_TARGETS: readonly McpTarget[] = ["cursor", "claude", "codex"];

/**
 * Resolve which repository files an explicit selection writes. An empty
 * selection writes nothing. MCP config follows the selected clients, or all
 * three clients when MCP is the only client-neutral choice.
 */
export function planInitAgentExport(opts: {
  readonly selected: readonly InitAgentExportTarget[];
}): InitAgentExportPlan {
  const selection = new Set(opts.selected);
  const clientHints = ALL_MCP_TARGETS.filter((target) => selection.has(target));
  let mcpTargets: readonly McpTarget[] = [];
  if (selection.has("mcp")) {
    mcpTargets = clientHints.length > 0 ? clientHints : ALL_MCP_TARGETS;
  }
  return {
    cursor: selection.has("cursor"),
    claude: selection.has("claude"),
    codex: selection.has("codex"),
    agentDocs: selection.has("agents"),
    mcpTargets,
  };
}

/** Non-mutating default guidance shown by interactive `hack init`. */
export function renderInitAgentIntegrationNote(): string {
  return [
    "No coding-agent files were written to this repository.",
    "Recommended: install the optional Hack plugin for your client, for example:",
    "  codex plugin add hack@hack-dance",
    "  claude plugin install hack@hack-dance",
    "Cursor: install Hack from Customize. See docs/integrations.md.",
    "",
    "Then let your agent finish project setup:",
    "  hack agent onboard",
  ].join("\n");
}

export type InitAgentIntegrationPrompts = {
  readonly note: (opts: {
    readonly message: string;
    readonly title: string;
  }) => void;
  readonly confirm: (opts: {
    readonly message: string;
    readonly initialValue: boolean;
  }) => Promise<boolean | symbol>;
  readonly multiselect: (opts: {
    readonly message: string;
    readonly options: readonly InitAgentExportOption[];
    readonly initialValues: readonly InitAgentExportTarget[];
    readonly required: boolean;
  }) => Promise<InitAgentExportTarget[] | symbol>;
};

export type InitAgentIntegrationOutcome =
  | { readonly kind: "skipped" }
  | { readonly kind: "note-only" }
  | { readonly kind: "exported"; readonly plan: InitAgentExportPlan };

const clackPrompts: InitAgentIntegrationPrompts = {
  note: ({ message, title }) => note(message, title),
  confirm: (opts) =>
    confirm({ message: opts.message, initialValue: opts.initialValue }),
  multiselect: (opts) =>
    multiselect<InitAgentExportTarget>({
      message: opts.message,
      options: opts.options.map((option) => ({ ...option })),
      initialValues: [...opts.initialValues],
      required: opts.required,
    }),
};

/**
 * Run the coding-agent step of `hack init`. `guard` runs before every write
 * (and once up front) so legacy/native project input ownership is rechecked.
 */
export async function runInitAgentIntegrations(opts: {
  readonly repoRoot: string;
  readonly interactive: boolean;
  readonly guard: (opts: { readonly projectRoot: string }) => Promise<void>;
  readonly prompts?: InitAgentIntegrationPrompts;
}): Promise<InitAgentIntegrationOutcome> {
  await opts.guard({ projectRoot: opts.repoRoot });
  if (!opts.interactive) {
    return { kind: "skipped" };
  }
  const prompts = opts.prompts ?? clackPrompts;
  prompts.note({
    message: renderInitAgentIntegrationNote(),
    title: "Coding agents",
  });

  const shouldExport = await prompts.confirm(INIT_AGENT_EXPORT_CONFIRM);
  if (isCancel(shouldExport) || shouldExport !== true) {
    return { kind: "note-only" };
  }

  const selected = await prompts.multiselect({
    message: INIT_AGENT_EXPORT_SELECT_MESSAGE,
    options: INIT_AGENT_EXPORT_OPTIONS,
    initialValues: [],
    required: false,
  });
  if (isCancel(selected) || selected.length === 0) {
    return { kind: "note-only" };
  }

  const plan = planInitAgentExport({ selected });
  await applyInitAgentExport({
    repoRoot: opts.repoRoot,
    plan,
    guard: opts.guard,
  });
  return { kind: "exported", plan };
}

async function applyInitAgentExport(opts: {
  readonly repoRoot: string;
  readonly plan: InitAgentExportPlan;
  readonly guard: (opts: { readonly projectRoot: string }) => Promise<void>;
}): Promise<void> {
  const projectRoot = opts.repoRoot;
  if (opts.plan.cursor) {
    await opts.guard({ projectRoot });
    const result = await installCursorRules({ scope: "project", projectRoot });
    logInstallResult({ label: "Cursor rules", ...result });
  }
  if (opts.plan.claude) {
    await opts.guard({ projectRoot });
    const result = await installClaudeHooks({ scope: "project", projectRoot });
    logInstallResult({ label: "Claude hooks", ...result });
  }
  if (opts.plan.codex) {
    await opts.guard({ projectRoot });
    const result = await installCodexSkill({ scope: "project", projectRoot });
    logInstallResult({ label: "Codex skill", ...result });
  }
  if (opts.plan.agentDocs) {
    await opts.guard({ projectRoot });
    const results = await upsertAgentDocs({
      projectRoot,
      targets: ["agents", "claude"],
    });
    for (const result of results) {
      logInstallResult({ label: "Agent docs", ...result });
    }
  }
  if (opts.plan.mcpTargets.length > 0) {
    await opts.guard({ projectRoot });
    const results = await installMcpConfig({
      targets: opts.plan.mcpTargets,
      scope: "project",
      projectRoot,
    });
    for (const result of results) {
      logInstallResult({
        label: "MCP config",
        status: result.status,
        path: result.path ?? "unknown path",
        message: result.message,
      });
    }
  }
}

function logInstallResult(opts: {
  readonly label: string;
  readonly status: string;
  readonly path: string;
  readonly message?: string;
}): void {
  if (opts.status === "error") {
    logger.warn({ message: opts.message ?? `Failed to update ${opts.label}` });
    return;
  }
  if (opts.status === "noop") {
    logger.info({ message: `No changes for ${opts.label} (${opts.path})` });
    return;
  }
  logger.success({ message: `Updated ${opts.label} at ${opts.path}` });
}
