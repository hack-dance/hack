import { homedir } from "node:os";
import { resolve } from "node:path";

import { isCancel, select, text } from "@clack/prompts";

/** Regex to remove leading newlines from text. */
const LEADING_NEWLINES_PATTERN = /^\n+/;

import {
  checkDeprecatedHackClaudeIntegration,
  checkHackClaudePlugin,
  prepareHackClaudePlugin,
  removeDeprecatedHackClaudeIntegration,
} from "../agents/claude-plugin.ts";
import {
  checkDeprecatedHackCodexIntegration,
  checkHackCodexPlugin,
  prepareHackCodexPlugin,
  removeDeprecatedHackCodexIntegration,
} from "../agents/codex-plugin.ts";
import {
  checkDeprecatedHackCursorIntegration,
  checkHackCursorPlugin,
  prepareHackCursorPlugin,
  removeDeprecatedHackCursorIntegration,
} from "../agents/cursor-plugin.ts";
import {
  type AgentPluginResult,
  checkNativeAgentPluginCutover,
  resolveAgentPluginInstallOutcome,
} from "../agents/plugin-lifecycle.ts";
import {
  checkDeprecatedSharedHackSkills,
  checkSharedHackSkill,
  installSharedHackSkill,
  removeDeprecatedSharedHackSkills,
  removeSharedHackSkill,
} from "../agents/shared-skill.ts";
import type { CliContext, CommandArgs } from "../cli/command.ts";
import {
  CliUsageError,
  defineCommand,
  defineOption,
  withHandler,
} from "../cli/command.ts";
import { optPath } from "../cli/options.ts";
import {
  checkDeprecatedTicketsAgentDocs,
  removeTicketsAgentDocs,
} from "../control-plane/extensions/tickets/agent-docs.ts";
import {
  checkDeprecatedTicketsSkill,
  removeTicketsSkill,
  type TicketsSkillResult,
} from "../control-plane/extensions/tickets/tickets-skill.ts";
import { pathExists, readTextFile, writeTextFile } from "../lib/fs.ts";
import { canPrompt } from "../lib/interactivity.ts";
import { findRepoRootForInit } from "../lib/project.ts";
import { findExecutableInPath } from "../lib/shell.ts";
import type { AgentDocTarget } from "../mcp/agent-docs.ts";
import {
  checkAgentDocs,
  removeAgentDocs,
  upsertAgentDocs,
} from "../mcp/agent-docs.ts";
import type { McpInstallScope, McpTarget } from "../mcp/install.ts";
import {
  checkMcpConfig,
  installMcpConfig,
  removeMcpConfig,
} from "../mcp/install.ts";
import { type DisplayStatusItem, display } from "../ui/display.ts";
import { logger } from "../ui/logger.ts";

const optCheck = defineOption({
  name: "check",
  type: "boolean",
  long: "--check",
  description: "Check whether integration is installed",
} as const);

const optRemove = defineOption({
  name: "remove",
  type: "boolean",
  long: "--remove",
  description: "Remove integration files/config",
} as const);

const optGlobal = defineOption({
  name: "global",
  type: "boolean",
  long: "--global",
  description: "Use global (user) scope instead of project scope",
} as const);

const optAllScopes = defineOption({
  name: "allScopes",
  type: "boolean",
  long: "--all-scopes",
  description: "Target both project and global (user) scopes",
} as const);

const optAll = defineOption({
  name: "all",
  type: "boolean",
  long: "--all",
  description: "Target all supported clients",
} as const);

const optCursor = defineOption({
  name: "cursor",
  type: "boolean",
  long: "--cursor",
  description: "Target Cursor integration",
} as const);

const optClaude = defineOption({
  name: "claude",
  type: "boolean",
  long: "--claude",
  description: "Target Claude integration",
} as const);

const optCodex = defineOption({
  name: "codex",
  type: "boolean",
  long: "--codex",
  description: "Target Codex integration",
} as const);

const optAgentsMd = defineOption({
  name: "agentsMd",
  type: "boolean",
  long: "--agents-md",
  description: "Target AGENTS.md",
} as const);

const optClaudeMd = defineOption({
  name: "claudeMd",
  type: "boolean",
  long: "--claude-md",
  description: "Target CLAUDE.md",
} as const);

const setupTmuxOptions = [optCheck, optRemove] as const;
const setupCursorOptions = [optPath, optGlobal, optCheck, optRemove] as const;
const setupClaudeOptions = [optPath, optGlobal, optCheck, optRemove] as const;
const setupCodexOptions = [optPath, optGlobal, optCheck, optRemove] as const;
const setupTicketsOptions = [optPath, optGlobal, optCheck, optRemove] as const;
const setupAgentsOptions = [
  optPath,
  optAll,
  optAgentsMd,
  optClaudeMd,
  optCheck,
  optRemove,
] as const;
const setupSyncOptions = [
  optPath,
  optGlobal,
  optAllScopes,
  optCheck,
  optRemove,
] as const;
const setupMcpOptions = [
  optPath,
  optGlobal,
  optAll,
  optCursor,
  optClaude,
  optCodex,
  optCheck,
  optRemove,
] as const;

type SetupTmuxArgs = CommandArgs<typeof setupTmuxOptions, readonly []>;
type SetupCursorArgs = CommandArgs<typeof setupCursorOptions, readonly []>;
type SetupClaudeArgs = CommandArgs<typeof setupClaudeOptions, readonly []>;
type SetupCodexArgs = CommandArgs<typeof setupCodexOptions, readonly []>;
type SetupTicketsArgs = CommandArgs<typeof setupTicketsOptions, readonly []>;
type SetupAgentsArgs = CommandArgs<typeof setupAgentsOptions, readonly []>;
type SetupSyncArgs = CommandArgs<typeof setupSyncOptions, readonly []>;
type SetupMcpArgs = CommandArgs<typeof setupMcpOptions, readonly []>;

type SetupMultiLogResult = {
  readonly status: string;
  readonly cleanupStatus?: string;
  readonly path?: string;
  readonly message?: string;
};

const tmuxSpec = defineCommand({
  name: "tmux",
  summary: "Install the recommended tmux binding for hack workspaces",
  group: "Agents",
  options: setupTmuxOptions,
  positionals: [],
  subcommands: [],
} as const);

const cursorSpec = defineCommand({
  name: "cursor",
  summary: "Check or prepare the official Hack plugin for Cursor",
  group: "Agents",
  options: setupCursorOptions,
  positionals: [],
  subcommands: [],
} as const);

const claudeSpec = defineCommand({
  name: "claude",
  summary: "Check or prepare the official Hack plugin for Claude Code",
  group: "Agents",
  options: setupClaudeOptions,
  positionals: [],
  subcommands: [],
} as const);

const codexSpec = defineCommand({
  name: "codex",
  summary: "Check or prepare the official Hack plugin for Codex",
  group: "Agents",
  options: setupCodexOptions,
  positionals: [],
  subcommands: [],
} as const);

const ticketsSpec = defineCommand({
  name: "tickets",
  summary: "Remove or audit the deprecated Hack Tickets skill",
  group: "Agents",
  options: setupTicketsOptions,
  positionals: [],
  subcommands: [],
} as const);

const agentsSpec = defineCommand({
  name: "agents",
  summary: "Install AGENTS.md / CLAUDE.md snippets for hack CLI usage",
  group: "Agents",
  options: setupAgentsOptions,
  positionals: [],
  subcommands: [],
} as const);

const syncSpec = defineCommand({
  name: "sync",
  summary:
    "Refresh project/global agent guidance and remove deprecated artifacts",
  group: "Agents",
  options: setupSyncOptions,
  positionals: [],
  subcommands: [],
} as const);

const mcpSpec = defineCommand({
  name: "mcp",
  summary: "Install MCP configs for hack CLI usage (no-shell only)",
  group: "Agents",
  options: setupMcpOptions,
  positionals: [],
  subcommands: [],
} as const);

export const setupCommand = defineCommand({
  name: "setup",
  summary: "Install integrations for coding agents",
  group: "Agents",
  options: [],
  positionals: [],
  expandInRootHelp: true,
  subcommands: [
    withHandler(tmuxSpec, handleSetupTmux),
    withHandler(cursorSpec, handleSetupCursor),
    withHandler(claudeSpec, handleSetupClaude),
    withHandler(codexSpec, handleSetupCodex),
    withHandler(ticketsSpec, handleSetupTickets),
    withHandler(agentsSpec, handleSetupAgents),
    withHandler(syncSpec, handleSetupSync),
    withHandler(mcpSpec, handleSetupMcp),
  ],
} as const);

const HACK_SESSION_BINDING_COMMENT = "# hack session picker";
const HACK_SESSION_BINDING_COMMAND =
  'display-popup -E -w 40% -h 60% "hack session"';

async function handleSetupTmux({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: SetupTmuxArgs;
}): Promise<number> {
  const action = resolveAction({
    check: args.options.check === true,
    remove: args.options.remove === true,
  });

  const tmuxPath = await findExecutableInPath("tmux");
  if (!tmuxPath) {
    logger.error({
      message:
        "tmux not found in PATH. Install tmux first (e.g., brew install tmux)",
    });
    return 1;
  }

  if (action === "check") {
    return await checkTmuxIntegration();
  }

  if (action === "remove") {
    return await removeTmuxIntegration();
  }

  return await installTmuxIntegration();
}

async function resolveTmuxConfigPaths(): Promise<{
  readonly home: string;
  readonly xdgConfig: string;
  readonly homeConfig: string;
  readonly existingConfigs: readonly string[];
}> {
  const home = homedir();
  const xdgConfig = resolve(home, ".config/tmux/tmux.conf");
  const homeConfig = resolve(home, ".tmux.conf");
  const candidates = [xdgConfig, homeConfig];

  const existingConfigs: string[] = [];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      existingConfigs.push(candidate);
    }
  }

  return { home, xdgConfig, homeConfig, existingConfigs };
}

function buildHackSessionBinding(key: "s" | "S"): string {
  return [
    HACK_SESSION_BINDING_COMMENT,
    `bind-key ${key} ${HACK_SESSION_BINDING_COMMAND}`,
  ].join("\n");
}

async function checkTmuxIntegration(): Promise<number> {
  const paths = await resolveTmuxConfigPaths();
  if (paths.existingConfigs.length === 0) {
    logger.warn({ message: "No tmux.conf found" });
    return 1;
  }

  for (const configPath of paths.existingConfigs) {
    const content = await readTextFile(configPath);
    if (content?.includes("hack session")) {
      logger.success({
        message: `tmux integration installed at ${configPath}`,
      });
      return 0;
    }
  }

  logger.warn({ message: "hack session keybinding not found in tmux.conf" });
  return 1;
}

async function removeTmuxIntegration(): Promise<number> {
  const paths = await resolveTmuxConfigPaths();
  let removed = false;

  for (const configPath of paths.existingConfigs) {
    const content = await readTextFile(configPath);
    if (!content?.includes("hack session")) {
      continue;
    }

    const newContent = content
      .replace(
        /\n?# hack session picker\nbind-key [sS] display-popup[^\n]*\n?/g,
        "\n"
      )
      .replace(LEADING_NEWLINES_PATTERN, "");
    await writeTextFile(configPath, newContent);
    logger.success({
      message: `Removed hack session keybinding from ${configPath}`,
    });
    removed = true;
  }

  if (!removed) {
    logger.info({ message: "No hack session keybinding found to remove" });
  }
  return 0;
}

async function installTmuxIntegration(): Promise<number> {
  logger.info({
    message: "Setting up the recommended tmux integration for hack sessions...",
  });

  const paths = await resolveTmuxConfigPaths();
  const selectedConfig = await resolveTmuxConfigToEdit({
    home: paths.home,
    existingConfigs: paths.existingConfigs,
    xdgConfig: paths.xdgConfig,
    homeConfig: paths.homeConfig,
  });
  if (!selectedConfig) {
    return 1;
  }

  // Check if already installed
  const existingContent = (await readTextFile(selectedConfig)) ?? "";
  if (existingContent.includes("hack session")) {
    logger.info({
      message: `hack session keybinding already in ${selectedConfig}`,
    });
    return 0;
  }

  // Ask about keybinding (non-interactive runs take the recommended default).
  const keyChoice = await resolveTmuxKeybindingChoice();
  if (keyChoice === null) {
    return 1;
  }

  if (keyChoice === "none") {
    logger.info({ message: "Skipping keybinding configuration" });
    logger.info({
      message: `Add this to your tmux.conf manually:\n\n${buildHackSessionBinding("s")}`,
    });
    return 0;
  }

  const binding = buildHackSessionBinding(keyChoice);

  // Append to config
  const newContent =
    existingContent.length > 0
      ? `${existingContent.trimEnd()}\n\n${binding}\n`
      : `${binding}\n`;
  await writeTextFile(selectedConfig, newContent);

  logger.success({ message: `Added to ${selectedConfig}:` });
  logger.info({ message: `\n${binding}` });
  logger.info({ message: `\nReload with: tmux source-file ${selectedConfig}` });

  return 0;
}

type TmuxKeybindingChoice = "s" | "S" | "none";

/**
 * Pick the `hack session` tmux binding. Interactive sessions get a select;
 * non-interactive runs take the recommended default (`prefix + s`).
 */
async function resolveTmuxKeybindingChoice(): Promise<TmuxKeybindingChoice | null> {
  if (!canPrompt()) {
    logger.info({
      message:
        "Non-interactive run: using the recommended binding (prefix + s).",
    });
    return "s";
  }

  const keyChoice = await select<TmuxKeybindingChoice>({
    message: "Add the recommended tmux binding for `hack session`?",
    options: [
      { value: "s", label: "Yes, use prefix + s (recommended)" },
      { value: "S", label: "Yes, use prefix + S (capital S)" },
      { value: "none", label: "No, I'll configure manually" },
    ],
  });
  if (isCancel(keyChoice)) {
    return null;
  }
  return keyChoice;
}

async function resolveTmuxConfigToEdit(opts: {
  readonly home: string;
  readonly existingConfigs: readonly string[];
  readonly xdgConfig: string;
  readonly homeConfig: string;
}): Promise<string | null> {
  if (opts.existingConfigs.length === 1 && opts.existingConfigs[0]) {
    const selected = opts.existingConfigs[0];
    logger.info({ message: `Using ${selected}` });
    return selected;
  }

  if (!canPrompt()) {
    const fallback = opts.existingConfigs[0] ?? opts.xdgConfig;
    logger.info({
      message: `Non-interactive run: using ${fallback} (recommended default).`,
    });
    return fallback;
  }

  const options =
    opts.existingConfigs.length > 0
      ? [
          ...opts.existingConfigs.map((p) => ({ value: p, label: p })),
          { value: "custom", label: "Custom path..." },
        ]
      : [
          { value: opts.xdgConfig, label: `${opts.xdgConfig} (recommended)` },
          { value: opts.homeConfig, label: opts.homeConfig },
          { value: "custom", label: "Custom path..." },
        ];

  const message =
    opts.existingConfigs.length > 0
      ? "Where is your tmux.conf?"
      : "No tmux.conf found. Where should we create one?";

  const choice = await select({ message, options });
  if (isCancel(choice)) {
    return null;
  }

  if (choice !== "custom") {
    return choice as string;
  }

  const customPath = await text({
    message: "Enter path to tmux.conf:",
    placeholder: "~/.config/tmux/tmux.conf",
  });
  if (isCancel(customPath) || !customPath) {
    return null;
  }

  return customPath.startsWith("~")
    ? resolve(opts.home, customPath.slice(2))
    : customPath;
}

async function handleSetupCursor({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: SetupCursorArgs;
}): Promise<number> {
  return await handleNativePluginSetup({
    ctx,
    options: args.options,
    okMessage: "Hack Cursor plugin",
    check: checkHackCursorPlugin,
    prepare: prepareHackCursorPlugin,
    remove: removeDeprecatedHackCursorIntegration,
  });
}

async function handleSetupClaude({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: SetupClaudeArgs;
}): Promise<number> {
  return await handleNativePluginSetup({
    ctx,
    options: args.options,
    okMessage: "Hack Claude Code plugin",
    check: checkHackClaudePlugin,
    prepare: prepareHackClaudePlugin,
    remove: removeDeprecatedHackClaudeIntegration,
  });
}

async function handleSetupCodex({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: SetupCodexArgs;
}): Promise<number> {
  return await handleNativePluginSetup({
    ctx,
    options: args.options,
    okMessage: "Hack Codex plugin",
    check: checkHackCodexPlugin,
    prepare: prepareHackCodexPlugin,
    remove: removeDeprecatedHackCodexIntegration,
  });
}

async function handleNativePluginSetup({
  ctx,
  options,
  okMessage,
  check,
  prepare,
  remove,
}: {
  readonly ctx: CliContext;
  readonly options: {
    readonly check: boolean;
    readonly remove: boolean;
    readonly global: boolean;
    readonly path: string | undefined;
  };
  readonly okMessage: string;
  readonly check: (opts: {
    readonly scope: "project" | "user";
  }) => Promise<AgentPluginResult<"project" | "user">>;
  readonly prepare: (opts: {
    readonly scope: "project" | "user";
    readonly projectRoot?: string;
  }) => Promise<AgentPluginResult<"project" | "user">>;
  readonly remove: (opts: {
    readonly scope: "project" | "user";
    readonly projectRoot?: string;
  }) => Promise<AgentPluginResult<"project" | "user">>;
}): Promise<number> {
  const action = resolveAction(options);
  const scope = resolveScope({ global: options.global });
  const projectRoot =
    scope === "project"
      ? await resolveSetupRoot({ ctx, pathOpt: options.path })
      : undefined;

  let result: AgentPluginResult<"project" | "user">;
  if (action === "check") {
    result = await check({ scope });
  } else if (action === "remove") {
    result = await remove({ scope, projectRoot });
  } else {
    result = await prepare({ scope, projectRoot });
  }
  return logSingleResult({ action, okMessage, result });
}

async function handleSetupTickets({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: SetupTicketsArgs;
}): Promise<number> {
  const action = resolveAction(args.options);
  const scope = resolveScope({ global: args.options.global === true });
  const projectRoot =
    scope === "project"
      ? await resolveSetupRoot({ ctx, pathOpt: args.options.path })
      : undefined;

  logger.info({
    message:
      "Hack Tickets agent integrations are deprecated. This command now audits or removes the legacy skill; it never installs it.",
  });

  let result: TicketsSkillResult;
  if (action === "check") {
    result = await checkDeprecatedTicketsSkill({ scope, projectRoot });
  } else {
    result = await removeTicketsSkill({ scope, projectRoot });
  }

  return logSingleResult({
    action,
    okMessage: "Deprecated Tickets skill",
    result,
  });
}

async function handleSetupAgents({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: SetupAgentsArgs;
}): Promise<number> {
  const action = resolveAction(args.options);
  const projectRoot = await resolveSetupRoot({
    ctx,
    pathOpt: args.options.path,
  });
  const targets = resolveDocTargets({
    all: args.options.all === true,
    agentsMd: args.options.agentsMd === true,
    claudeMd: args.options.claudeMd === true,
  });

  const resolvedTargets =
    targets.length > 0 ? targets : (["agents", "claude"] as const);

  if (action === "check") {
    const results = await checkAgentDocs({
      projectRoot,
      targets: resolvedTargets,
    });
    return logMultiResults({
      action,
      okMessage: "Agent docs",
      results,
    });
  }

  if (action === "remove") {
    const results = await removeAgentDocs({
      projectRoot,
      targets: resolvedTargets,
    });
    return logMultiResults({
      action,
      okMessage: "Agent docs",
      results,
    });
  }

  const results = await upsertAgentDocs({
    projectRoot,
    targets: resolvedTargets,
  });
  return logMultiResults({
    action,
    okMessage: "Agent docs",
    results,
  });
}

type SetupSyncAction = "install" | "check" | "remove";

type SetupSyncGroup = {
  readonly label: string;
  readonly results: readonly SetupMultiLogResult[];
  readonly requiresReadyPlugin?: boolean;
};

type SetupSyncScopeResult = {
  readonly exitCode: number;
  readonly item: DisplayStatusItem;
};

export function buildSetupSyncScopeResult(input: {
  readonly action: SetupSyncAction;
  readonly scope: "Project" | "Global";
  readonly groups: readonly SetupSyncGroup[];
}): SetupSyncScopeResult {
  const entries = input.groups.flatMap((group) =>
    group.results.map((result) => {
      const status =
        input.action === "install" &&
        result.status === "noop" &&
        ["removed", "preserved"].includes(result.cleanupStatus ?? "")
          ? (result.cleanupStatus ?? result.status)
          : result.status;
      return {
        ...result,
        status,
        label: group.label,
        requiresReadyPlugin: group.requiresReadyPlugin === true,
      };
    })
  );
  const failures = entries.filter((entry) => {
    if (entry.status === "error") {
      return true;
    }
    if (input.action === "check") {
      return ["missing", "stale", "deprecated"].includes(entry.status);
    }
    if (input.action === "install") {
      if (entry.status === "preserved") {
        return true;
      }
      return (
        entry.requiresReadyPlugin &&
        ["missing", "stale", "deprecated"].includes(entry.status)
      );
    }
    return entry.status === "preserved";
  });
  const errorCount = failures.filter(
    (entry) => entry.status === "error"
  ).length;
  let status: DisplayStatusItem["status"] = "ok";
  if (errorCount > 0) {
    status = "error";
  } else if (failures.length > 0) {
    status = "warn";
  }
  const meta = (() => {
    if (input.action === "check") {
      return failures.length === 0
        ? `${entries.length} current`
        : `${entries.length - failures.length}/${entries.length} current`;
    }
    if (input.action === "remove") {
      const removed = entries.filter(
        (entry) => entry.status === "removed"
      ).length;
      return `${removed} removed`;
    }
    const changed = entries.filter((entry) =>
      ["created", "updated", "removed"].includes(entry.status)
    ).length;
    if (failures.length > 0) {
      return `${entries.length - failures.length}/${entries.length} current`;
    }
    return changed === 0 ? "already current" : `${changed} updated`;
  })();
  const detail = failures
    .map((entry) => {
      if (entry.message) {
        return `${entry.label}: ${entry.message}`;
      }
      const location = entry.path ? ` at ${entry.path}` : "";
      return `${entry.label}: ${entry.status}${location}`;
    })
    .join("\n");

  return {
    exitCode: failures.length > 0 ? 1 : 0,
    item: {
      label: input.scope,
      status,
      meta,
      detail: detail.length > 0 ? detail : undefined,
    },
  };
}

async function handleSetupSync({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: SetupSyncArgs;
}): Promise<number> {
  const action = resolveAction(args.options);
  const scopes = resolveSyncScopes({
    global: args.options.global === true,
    allScopes: args.options.allScopes === true,
  });
  const includesProject = scopes.includes("project");
  const includesUser = scopes.includes("user");
  const projectRoot = includesProject
    ? await resolveSetupRoot({ ctx, pathOpt: args.options.path })
    : undefined;
  const scopeResults: SetupSyncScopeResult[] = [];

  if (includesProject && projectRoot) {
    scopeResults.push(
      await runProjectScopeSync({
        action,
        projectRoot,
      })
    );
  }

  if (includesUser) {
    scopeResults.push(await runUserScopeSync({ action }));
  }

  const titles: Readonly<Record<SetupSyncAction, string>> = {
    check: "Agent integrations",
    install: "Agent integrations updated",
    remove: "Agent integrations removed",
  };
  await display.statusList({
    title: titles[action],
    items: scopeResults.map((result) => result.item),
  });
  return Math.max(0, ...scopeResults.map((result) => result.exitCode));
}

/**
 * Run one sync action across all project-scope integrations and log results.
 * Deprecated Tickets agent artifacts are always audited and removed by sync.
 */
async function runProjectScopeSync(opts: {
  readonly action: SetupSyncAction;
  readonly projectRoot: string;
}): Promise<SetupSyncScopeResult> {
  const { action, projectRoot } = opts;
  let cursorResult: Awaited<
    ReturnType<typeof checkDeprecatedHackCursorIntegration>
  >;
  let claudeResult: Awaited<
    ReturnType<typeof checkDeprecatedHackClaudeIntegration>
  >;
  let codexResult: Awaited<
    ReturnType<typeof checkDeprecatedHackCodexIntegration>
  >;
  let ticketsResult: TicketsSkillResult;
  let ticketsDocsResults: SetupMultiLogResult[];
  let docsResults: SetupMultiLogResult[];

  if (action === "check") {
    cursorResult = await checkNativeAgentPluginCutover({
      check: async () => await checkHackCursorPlugin({ scope: "project" }),
      checkLegacy: async () =>
        await checkDeprecatedHackCursorIntegration({
          scope: "project",
          projectRoot,
        }),
    });
    claudeResult = await checkNativeAgentPluginCutover({
      check: async () => await checkHackClaudePlugin({ scope: "project" }),
      checkLegacy: async () =>
        await checkDeprecatedHackClaudeIntegration({
          scope: "project",
          projectRoot,
        }),
    });
    codexResult = await checkNativeAgentPluginCutover({
      check: async () => await checkHackCodexPlugin({ scope: "project" }),
      checkLegacy: async () =>
        await checkDeprecatedHackCodexIntegration({
          scope: "project",
          projectRoot,
        }),
    });
    ticketsResult = await checkDeprecatedTicketsSkill({
      scope: "project",
      projectRoot,
    });
    ticketsDocsResults = await checkDeprecatedTicketsAgentDocs({
      projectRoot,
      targets: ["agents", "claude"],
    });
    docsResults = await checkAgentDocs({
      projectRoot,
      targets: ["agents", "claude"],
    });
  } else if (action === "remove") {
    cursorResult = await removeDeprecatedHackCursorIntegration({
      scope: "project",
      projectRoot,
    });
    claudeResult = await removeDeprecatedHackClaudeIntegration({
      scope: "project",
      projectRoot,
    });
    codexResult = await removeDeprecatedHackCodexIntegration({
      scope: "project",
      projectRoot,
    });
    ticketsResult = await removeTicketsSkill({ scope: "project", projectRoot });
    ticketsDocsResults = await removeTicketsAgentDocs({
      projectRoot,
      targets: ["agents", "claude"],
    });
    docsResults = await removeAgentDocs({
      projectRoot,
      targets: ["agents", "claude"],
    });
  } else {
    cursorResult = await prepareHackCursorPlugin({
      scope: "project",
      projectRoot,
    });
    claudeResult = await prepareHackClaudePlugin({
      scope: "project",
      projectRoot,
    });
    codexResult = await prepareHackCodexPlugin({
      scope: "project",
      projectRoot,
    });
    ticketsResult = await removeTicketsSkill({ scope: "project", projectRoot });
    ticketsDocsResults = await removeTicketsAgentDocs({
      projectRoot,
      targets: ["agents", "claude"],
    });
    docsResults = await upsertAgentDocs({
      projectRoot,
      targets: ["agents", "claude"],
    });
  }

  return buildSetupSyncScopeResult({
    action,
    scope: "Project",
    groups: [
      {
        label:
          action !== "remove"
            ? "Hack Cursor plugin"
            : "Deprecated Cursor integration",
        results: [cursorResult],
        requiresReadyPlugin: true,
      },
      {
        label:
          action !== "remove"
            ? "Hack Claude Code plugin"
            : "Deprecated Claude integration",
        results: [claudeResult],
        requiresReadyPlugin: true,
      },
      {
        label:
          action !== "remove"
            ? "Hack Codex plugin"
            : "Deprecated Codex integration",
        results: [codexResult],
        requiresReadyPlugin: true,
      },
      { label: "Deprecated Tickets skill", results: [ticketsResult] },
      { label: "Deprecated Tickets instructions", results: ticketsDocsResults },
      { label: "Agent docs", results: docsResults },
    ],
  });
}

/**
 * Run one sync action across all global (user) scope integrations and log
 * results. Shared `~/.ai/skills` guidance is managed alongside client-specific
 * integrations, and known legacy Hack skills are cleaned up safely.
 */
async function runUserScopeSync(opts: {
  readonly action: SetupSyncAction;
}): Promise<SetupSyncScopeResult> {
  const { action } = opts;
  let cursorResult: Awaited<
    ReturnType<typeof checkDeprecatedHackCursorIntegration>
  >;
  let claudeResult: Awaited<
    ReturnType<typeof checkDeprecatedHackClaudeIntegration>
  >;
  let codexResult: Awaited<
    ReturnType<typeof checkDeprecatedHackCodexIntegration>
  >;
  let ticketsResult: TicketsSkillResult;
  let sharedSkillResult: SetupMultiLogResult & { readonly path: string };
  let legacySharedResults: SetupMultiLogResult[];

  if (action === "check") {
    cursorResult = await checkNativeAgentPluginCutover({
      check: async () => await checkHackCursorPlugin({ scope: "user" }),
      checkLegacy: async () =>
        await checkDeprecatedHackCursorIntegration({ scope: "user" }),
    });
    claudeResult = await checkNativeAgentPluginCutover({
      check: async () => await checkHackClaudePlugin({ scope: "user" }),
      checkLegacy: async () =>
        await checkDeprecatedHackClaudeIntegration({ scope: "user" }),
    });
    codexResult = await checkNativeAgentPluginCutover({
      check: async () => await checkHackCodexPlugin({ scope: "user" }),
      checkLegacy: async () =>
        await checkDeprecatedHackCodexIntegration({ scope: "user" }),
    });
    ticketsResult = await checkDeprecatedTicketsSkill({ scope: "user" });
    sharedSkillResult = await checkSharedHackSkill();
    legacySharedResults = await checkDeprecatedSharedHackSkills();
  } else if (action === "remove") {
    cursorResult = await removeDeprecatedHackCursorIntegration({
      scope: "user",
    });
    claudeResult = await removeDeprecatedHackClaudeIntegration({
      scope: "user",
    });
    codexResult = await removeDeprecatedHackCodexIntegration({ scope: "user" });
    ticketsResult = await removeTicketsSkill({ scope: "user" });
    sharedSkillResult = await removeSharedHackSkill();
    legacySharedResults = await removeDeprecatedSharedHackSkills();
  } else {
    cursorResult = await prepareHackCursorPlugin({ scope: "user" });
    claudeResult = await prepareHackClaudePlugin({ scope: "user" });
    codexResult = await prepareHackCodexPlugin({ scope: "user" });
    ticketsResult = await removeTicketsSkill({ scope: "user" });
    sharedSkillResult = await installSharedHackSkill();
    legacySharedResults = await removeDeprecatedSharedHackSkills();
  }

  return buildSetupSyncScopeResult({
    action,
    scope: "Global",
    groups: [
      {
        label:
          action !== "remove"
            ? "Hack Cursor plugin"
            : "Deprecated Cursor integration",
        results: [cursorResult],
        requiresReadyPlugin: true,
      },
      {
        label:
          action !== "remove"
            ? "Hack Claude Code plugin"
            : "Deprecated Claude integration",
        results: [claudeResult],
        requiresReadyPlugin: true,
      },
      {
        label:
          action !== "remove"
            ? "Hack Codex plugin"
            : "Deprecated Codex integration",
        results: [codexResult],
        requiresReadyPlugin: true,
      },
      { label: "Shared Hack skill", results: [sharedSkillResult] },
      { label: "Deprecated Tickets skill", results: [ticketsResult] },
      { label: "Deprecated shared Hack skills", results: legacySharedResults },
    ],
  });
}

async function handleSetupMcp({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: SetupMcpArgs;
}): Promise<number> {
  const action = resolveAction(args.options);
  const scope = resolveMcpScope({ global: args.options.global === true });
  const projectRoot =
    scope === "project"
      ? await resolveSetupRoot({ ctx, pathOpt: args.options.path })
      : undefined;
  const targets = resolveMcpTargets({
    all: args.options.all === true,
    cursor: args.options.cursor === true,
    claude: args.options.claude === true,
    codex: args.options.codex === true,
  });

  if (action === "check") {
    const results = await checkMcpConfig({
      targets,
      scope,
      projectRoot,
    });
    return logMultiResults({
      action,
      okMessage: "MCP config",
      results,
    });
  }

  if (action === "remove") {
    const results = await removeMcpConfig({
      targets,
      scope,
      projectRoot,
    });
    return logMultiResults({
      action,
      okMessage: "MCP config",
      results,
    });
  }

  const results = await installMcpConfig({
    targets,
    scope,
    projectRoot,
  });

  return logMultiResults({
    action,
    okMessage: "MCP config",
    results,
  });
}

async function resolveSetupRoot(opts: {
  readonly ctx: CliContext;
  readonly pathOpt: string | undefined;
}): Promise<string> {
  const startDir = resolve(opts.ctx.cwd, opts.pathOpt ?? ".");
  return await findRepoRootForInit(startDir);
}

function resolveAction(opts: {
  readonly check: boolean;
  readonly remove: boolean;
}): "install" | "check" | "remove" {
  if (opts.check && opts.remove) {
    throw new CliUsageError("Use either --check or --remove, not both.");
  }
  if (opts.check) {
    return "check";
  }
  if (opts.remove) {
    return "remove";
  }
  return "install";
}

function resolveScope(opts: { readonly global: boolean }): "project" | "user" {
  return opts.global ? "user" : "project";
}

function resolveSyncScopes(opts: {
  readonly global: boolean;
  readonly allScopes: boolean;
}): readonly ("project" | "user")[] {
  if (opts.allScopes) {
    return ["project", "user"];
  }
  if (opts.global) {
    return ["user"];
  }
  return ["project"];
}

function resolveMcpScope(opts: { readonly global: boolean }): McpInstallScope {
  return opts.global ? "user" : "project";
}

function resolveMcpTargets(opts: {
  readonly all: boolean;
  readonly cursor: boolean;
  readonly claude: boolean;
  readonly codex: boolean;
}): McpTarget[] {
  if (opts.all) {
    return ["cursor", "claude", "codex"];
  }

  const targets: McpTarget[] = [];
  if (opts.cursor) {
    targets.push("cursor");
  }
  if (opts.claude) {
    targets.push("claude");
  }
  if (opts.codex) {
    targets.push("codex");
  }
  if (targets.length > 0) {
    return targets;
  }
  return ["cursor", "claude", "codex"];
}

function resolveDocTargets(opts: {
  readonly all: boolean;
  readonly agentsMd: boolean;
  readonly claudeMd: boolean;
}): AgentDocTarget[] {
  const targets: AgentDocTarget[] = [];
  if (opts.all || opts.agentsMd) {
    targets.push("agents");
  }
  if (opts.all || opts.claudeMd) {
    targets.push("claude");
  }
  return targets;
}

function logSingleResult(opts: {
  readonly action: "install" | "check" | "remove";
  readonly okMessage: string;
  readonly result: {
    readonly status: string;
    readonly cleanupStatus?: string;
    readonly path: string;
    readonly message?: string;
  };
}): number {
  if (opts.result.status === "error") {
    logger.error({
      message: opts.result.message ?? `Failed: ${opts.okMessage}`,
    });
    return 1;
  }

  if (opts.action === "check") {
    return logCheckResult({
      okMessage: opts.okMessage,
      path: opts.result.path,
      result: opts.result,
    });
  }

  if (opts.action === "remove") {
    if (opts.result.status === "removed") {
      logger.success({
        message:
          opts.result.message ??
          `Removed ${opts.okMessage} at ${opts.result.path}`,
      });
      return 0;
    }
    logger.info({
      message:
        opts.result.message ??
        `No ${opts.okMessage} found at ${opts.result.path}`,
    });
    return 0;
  }

  if (["missing", "stale", "deprecated"].includes(opts.result.status)) {
    logger.warn({
      message:
        opts.result.message ??
        `${opts.okMessage} requires attention at ${opts.result.path}`,
    });
    return 1;
  }

  const outcome = resolveAgentPluginInstallOutcome({
    status: opts.result.status,
    cleanupStatus: opts.result.cleanupStatus,
  });
  if (outcome === "warning") {
    logger.warn({
      message:
        opts.result.message ??
        `${opts.okMessage} is not ready (${opts.result.status}) at ${opts.result.path}`,
    });
    return 1;
  }

  if (outcome === "unchanged") {
    if (opts.result.cleanupStatus === "removed") {
      logger.success({
        message:
          opts.result.message ??
          `Updated ${opts.okMessage} at ${opts.result.path}`,
      });
      return 0;
    }
    logger.info({
      message:
        opts.result.message ??
        `No changes for ${opts.okMessage} (${opts.result.path})`,
    });
    return 0;
  }

  logger.success({
    message:
      opts.result.message ?? `Updated ${opts.okMessage} at ${opts.result.path}`,
  });
  return 0;
}

function logCheckResult(opts: {
  readonly okMessage: string;
  readonly path: string;
  readonly result: {
    readonly status: string;
    readonly message?: string;
  };
}): number {
  if (opts.result.status === "absent") {
    logger.success({
      message: `${opts.okMessage} not installed at ${opts.path}`,
    });
    return 0;
  }
  if (opts.result.status === "missing") {
    logger.warn({
      message:
        opts.result.message ??
        `${opts.okMessage} not installed at ${opts.path}`,
    });
    return 1;
  }
  if (opts.result.status === "stale") {
    logger.warn({
      message:
        opts.result.message ??
        `${opts.okMessage} content is stale at ${opts.path}`,
    });
    return 1;
  }
  if (opts.result.status === "deprecated") {
    logger.warn({
      message:
        opts.result.message ??
        `${opts.okMessage} is deprecated at ${opts.path}`,
    });
    return 1;
  }
  logger.success({ message: `${opts.okMessage} installed at ${opts.path}` });
  return 0;
}

function logMultiResults(opts: {
  readonly action: "install" | "check" | "remove";
  readonly okMessage: string;
  readonly results: readonly {
    readonly status: string;
    readonly path?: string;
    readonly message?: string;
  }[];
}): number {
  let exitCode = 0;

  for (const result of opts.results) {
    const path = result.path ?? "unknown path";

    if (result.status === "error") {
      logger.error({ message: result.message ?? `Failed: ${opts.okMessage}` });
      exitCode = 1;
      continue;
    }

    if (opts.action === "check") {
      exitCode = Math.max(
        exitCode,
        logCheckResult({ okMessage: opts.okMessage, path, result })
      );
      continue;
    }

    if (opts.action === "remove") {
      if (result.status === "removed") {
        logger.success({ message: `Removed ${opts.okMessage} at ${path}` });
        continue;
      }
      logger.info({ message: `No ${opts.okMessage} found at ${path}` });
      continue;
    }

    if (result.status === "noop") {
      logger.info({ message: `No changes for ${opts.okMessage} (${path})` });
      continue;
    }

    logger.success({ message: `Updated ${opts.okMessage} at ${path}` });
  }

  return exitCode;
}
