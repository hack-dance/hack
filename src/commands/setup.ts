import { homedir } from "node:os";
import { resolve } from "node:path";

import { isCancel, select, text } from "@clack/prompts";
import {
  checkClaudeHooks,
  installClaudeHooks,
  removeClaudeHooks,
} from "../agents/claude.ts";
import {
  checkCodexSkill,
  installCodexSkill,
  removeCodexSkill,
} from "../agents/codex-skill.ts";
import {
  checkCursorRules,
  installCursorRules,
  removeCursorRules,
} from "../agents/cursor.ts";
import type { CliContext, CommandArgs } from "../cli/command.ts";
import {
  CliUsageError,
  defineCommand,
  defineOption,
  withHandler,
} from "../cli/command.ts";
import { optPath } from "../cli/options.ts";
import {
  checkTicketsSkill,
  installTicketsSkill,
  removeTicketsSkill,
} from "../control-plane/extensions/tickets/tickets-skill.ts";
import { pathExists, readTextFile, writeTextFile } from "../lib/fs.ts";
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
type SetupMcpArgs = CommandArgs<typeof setupMcpOptions, readonly []>;

const tmuxSpec = defineCommand({
  name: "tmux",
  summary: "Configure tmux keybinding for hack session picker",
  group: "Agents",
  options: setupTmuxOptions,
  positionals: [],
  subcommands: [],
} as const);

const cursorSpec = defineCommand({
  name: "cursor",
  summary: "Install Cursor rules for hack CLI usage",
  group: "Agents",
  options: setupCursorOptions,
  positionals: [],
  subcommands: [],
} as const);

const claudeSpec = defineCommand({
  name: "claude",
  summary: "Install Claude Code hooks for hack CLI usage",
  group: "Agents",
  options: setupClaudeOptions,
  positionals: [],
  subcommands: [],
} as const);

const codexSpec = defineCommand({
  name: "codex",
  summary: "Install Codex skill for hack CLI usage",
  group: "Agents",
  options: setupCodexOptions,
  positionals: [],
  subcommands: [],
} as const);

const ticketsSpec = defineCommand({
  name: "tickets",
  summary: "Install Codex skill for hack tickets usage",
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
    withHandler(mcpSpec, handleSetupMcp),
  ],
} as const);

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

  // Check if tmux is installed
  const tmuxPath = await findExecutableInPath("tmux");
  if (!tmuxPath) {
    logger.error({
      message:
        "tmux not found in PATH. Install tmux first (e.g., brew install tmux)",
    });
    return 1;
  }

  // Detect tmux config locations
  const home = homedir();
  const configCandidates = [
    resolve(home, ".config/tmux/tmux.conf"),
    resolve(home, ".tmux.conf"),
  ];

  const existingConfigs: string[] = [];
  for (const candidate of configCandidates) {
    if (await pathExists(candidate)) {
      existingConfigs.push(candidate);
    }
  }

  const HACK_SESSION_BINDING = `# hack session picker
bind-key s display-popup -E -w 40% -h 60% "hack session"`;

  if (action === "check") {
    if (existingConfigs.length === 0) {
      logger.warn({ message: "No tmux.conf found" });
      return 1;
    }
    for (const configPath of existingConfigs) {
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

  if (action === "remove") {
    let removed = false;
    for (const configPath of existingConfigs) {
      const content = await readTextFile(configPath);
      if (content?.includes("hack session")) {
        const newContent = content
          .replace(
            /\n?# hack session picker\nbind-key [sS] display-popup[^\n]*\n?/g,
            "\n"
          )
          .replace(/^\n+/, "");
        await writeTextFile(configPath, newContent);
        logger.success({
          message: `Removed hack session keybinding from ${configPath}`,
        });
        removed = true;
      }
    }
    if (!removed) {
      logger.info({ message: "No hack session keybinding found to remove" });
    }
    return 0;
  }

  // Interactive install
  logger.info({ message: "Setting up tmux integration for hack sessions..." });

  // Select config file
  let selectedConfig: string;
  if (existingConfigs.length === 1) {
    selectedConfig = existingConfigs[0]!;
    logger.info({ message: `Using ${selectedConfig}` });
  } else if (existingConfigs.length > 1) {
    const choice = await select({
      message: "Where is your tmux.conf?",
      options: [
        ...existingConfigs.map((p) => ({ value: p, label: p })),
        { value: "custom", label: "Custom path..." },
      ],
    });
    if (isCancel(choice)) {
      return 1;
    }
    if (choice === "custom") {
      const customPath = await text({
        message: "Enter path to tmux.conf:",
        placeholder: "~/.config/tmux/tmux.conf",
      });
      if (isCancel(customPath) || !customPath) {
        return 1;
      }
      selectedConfig = customPath.startsWith("~")
        ? resolve(home, customPath.slice(2))
        : customPath;
    } else {
      selectedConfig = choice as string;
    }
  } else {
    // No existing config, ask where to create
    const choice = await select({
      message: "No tmux.conf found. Where should we create one?",
      options: [
        {
          value: configCandidates[0]!,
          label: `${configCandidates[0]} (recommended)`,
        },
        { value: configCandidates[1]!, label: configCandidates[1]! },
        { value: "custom", label: "Custom path..." },
      ],
    });
    if (isCancel(choice)) {
      return 1;
    }
    if (choice === "custom") {
      const customPath = await text({
        message: "Enter path to tmux.conf:",
        placeholder: "~/.config/tmux/tmux.conf",
      });
      if (isCancel(customPath) || !customPath) {
        return 1;
      }
      selectedConfig = customPath.startsWith("~")
        ? resolve(home, customPath.slice(2))
        : customPath;
    } else {
      selectedConfig = choice as string;
    }
  }

  // Check if already installed
  const existingContent = (await readTextFile(selectedConfig)) ?? "";
  if (existingContent.includes("hack session")) {
    logger.info({
      message: `hack session keybinding already in ${selectedConfig}`,
    });
    return 0;
  }

  // Ask about keybinding
  const keyChoice = await select({
    message: "Add keybinding for hack session picker?",
    options: [
      { value: "s", label: "Yes, use prefix + s (recommended)" },
      { value: "S", label: "Yes, use prefix + S (capital S)" },
      { value: "none", label: "No, I'll configure manually" },
    ],
  });
  if (isCancel(keyChoice)) {
    return 1;
  }

  if (keyChoice === "none") {
    logger.info({ message: "Skipping keybinding configuration" });
    logger.info({
      message: `Add this to your tmux.conf manually:\n\n${HACK_SESSION_BINDING}`,
    });
    return 0;
  }

  const binding = `# hack session picker
bind-key ${keyChoice} display-popup -E -w 40% -h 60% "hack session"`;

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

async function handleSetupCursor({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: SetupCursorArgs;
}): Promise<number> {
  const action = resolveAction(args.options);
  const scope = resolveScope({ global: args.options.global === true });
  const projectRoot =
    scope === "project"
      ? await resolveSetupRoot({ ctx, pathOpt: args.options.path })
      : undefined;

  const result =
    action === "check"
      ? await checkCursorRules({ scope, projectRoot })
      : action === "remove"
        ? await removeCursorRules({ scope, projectRoot })
        : await installCursorRules({ scope, projectRoot });

  return logSingleResult({
    action,
    okMessage: "Cursor integration",
    result,
  });
}

async function handleSetupClaude({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: SetupClaudeArgs;
}): Promise<number> {
  const action = resolveAction(args.options);
  const scope = resolveScope({ global: args.options.global === true });
  const projectRoot =
    scope === "project"
      ? await resolveSetupRoot({ ctx, pathOpt: args.options.path })
      : undefined;

  const result =
    action === "check"
      ? await checkClaudeHooks({ scope, projectRoot })
      : action === "remove"
        ? await removeClaudeHooks({ scope, projectRoot })
        : await installClaudeHooks({ scope, projectRoot });

  return logSingleResult({
    action,
    okMessage: "Claude integration",
    result,
  });
}

async function handleSetupCodex({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: SetupCodexArgs;
}): Promise<number> {
  const action = resolveAction(args.options);
  const scope = resolveScope({ global: args.options.global === true });
  const projectRoot =
    scope === "project"
      ? await resolveSetupRoot({ ctx, pathOpt: args.options.path })
      : undefined;

  const result =
    action === "check"
      ? await checkCodexSkill({ scope, projectRoot })
      : action === "remove"
        ? await removeCodexSkill({ scope, projectRoot })
        : await installCodexSkill({ scope, projectRoot });

  return logSingleResult({
    action,
    okMessage: "Codex integration",
    result,
  });
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

  const result =
    action === "check"
      ? await checkTicketsSkill({ scope, projectRoot })
      : action === "remove"
        ? await removeTicketsSkill({ scope, projectRoot })
        : await installTicketsSkill({ scope, projectRoot });

  return logSingleResult({
    action,
    okMessage: "Tickets skill",
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
    if (opts.result.status === "missing") {
      logger.warn({
        message: `${opts.okMessage} not installed at ${opts.result.path}`,
      });
      return 1;
    }
    logger.success({
      message: `${opts.okMessage} installed at ${opts.result.path}`,
    });
    return 0;
  }

  if (opts.action === "remove") {
    if (opts.result.status === "removed") {
      logger.success({
        message: `Removed ${opts.okMessage} at ${opts.result.path}`,
      });
      return 0;
    }
    logger.info({
      message: `No ${opts.okMessage} found at ${opts.result.path}`,
    });
    return 0;
  }

  if (opts.result.status === "noop") {
    logger.info({
      message: `No changes for ${opts.okMessage} (${opts.result.path})`,
    });
    return 0;
  }

  logger.success({
    message: `Updated ${opts.okMessage} at ${opts.result.path}`,
  });
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
      if (result.status === "missing") {
        logger.warn({ message: `${opts.okMessage} not installed at ${path}` });
        exitCode = 1;
        continue;
      }
      logger.success({ message: `${opts.okMessage} installed at ${path}` });
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
