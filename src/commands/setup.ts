import { homedir } from "node:os";
import { resolve } from "node:path";
import { isCancel, select, text } from "@clack/prompts";
import { RETIRED_AGENT_AUTOMATION_MESSAGE } from "../agents/explicit-integrations.ts";

/** Regex to remove leading newlines from text. */
const LEADING_NEWLINES_PATTERN = /^\n+/;

import {
  checkCodexSkill,
  installCodexSkill,
  removeCodexSkill,
} from "../agents/codex-skill.ts";
import type { CliContext, CommandArgs } from "../cli/command.ts";
import {
  CliUsageError,
  defineCommand,
  defineOption,
  withHandler,
} from "../cli/command.ts";
import { optJson, optPath } from "../cli/options.ts";
import { pathExists, readTextFile, writeTextFile } from "../lib/fs.ts";
import { canPrompt } from "../lib/interactivity.ts";
import { findRepoRootForInit } from "../lib/project.ts";
import { findExecutableInPath } from "../lib/shell.ts";
import type { McpInstallScope, McpTarget } from "../mcp/install.ts";
import {
  checkMcpConfig,
  installMcpConfig,
  removeMcpConfig,
} from "../mcp/install.ts";
import { logger } from "../ui/logger.ts";
import { handleSetupMigrate, setupMigrateSpec } from "./setup-migrate.ts";

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

const optInstallMissing = defineOption({
  name: "installMissing",
  type: "boolean",
  long: "--install-missing",
  description: "Retired compatibility flag; sync always refuses",
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
  optInstallMissing,
  optCheck,
  optRemove,
  optJson,
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
type SetupCodexArgs = CommandArgs<typeof setupCodexOptions, readonly []>;
type SetupMcpArgs = CommandArgs<typeof setupMcpOptions, readonly []>;

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
  summary: "Retired: automatic Cursor rules are unavailable",
  group: "Agents",
  options: setupCursorOptions,
  positionals: [],
  subcommands: [],
} as const);

const claudeSpec = defineCommand({
  name: "claude",
  summary: "Retired: automatic Claude hooks are unavailable",
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

const agentsSpec = defineCommand({
  name: "agents",
  summary: "Retired: instruction injection is unavailable",
  group: "Agents",
  options: setupAgentsOptions,
  positionals: [],
  subcommands: [],
} as const);

const syncSpec = defineCommand({
  name: "sync",
  summary: "Retired: automatic integration sync is unavailable",
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
  summary: "Explicit opt-in skills and MCP; legacy automation is retired",
  group: "Agents",
  options: [],
  positionals: [],
  expandInRootHelp: true,
  subcommands: [
    withHandler(tmuxSpec, handleSetupTmux),
    withHandler(cursorSpec, handleSetupCursor),
    withHandler(claudeSpec, handleSetupClaude),
    withHandler(codexSpec, handleSetupCodex),
    withHandler(agentsSpec, handleSetupAgents),
    withHandler(syncSpec, handleSetupSync),
    withHandler(setupMigrateSpec, handleSetupMigrate),
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

function handleSetupCursor(): Promise<number> {
  throw new CliUsageError(RETIRED_AGENT_AUTOMATION_MESSAGE);
}

function handleSetupClaude(): Promise<number> {
  throw new CliUsageError(RETIRED_AGENT_AUTOMATION_MESSAGE);
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

  let result: Awaited<ReturnType<typeof checkCodexSkill>>;
  if (action === "check") {
    result = await checkCodexSkill({ scope, projectRoot });
  } else if (action === "remove") {
    result = await removeCodexSkill({ scope, projectRoot });
  } else {
    result = await installCodexSkill({ scope, projectRoot });
  }

  return logSingleResult({
    action,
    okMessage: "Codex integration",
    result,
  });
}

function handleSetupAgents(): Promise<number> {
  throw new CliUsageError(RETIRED_AGENT_AUTOMATION_MESSAGE);
}

function handleSetupSync(): Promise<number> {
  throw new CliUsageError(RETIRED_AGENT_AUTOMATION_MESSAGE);
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
  throw new CliUsageError(
    "Select an MCP client with --cursor, --claude or --codex, or explicitly pass --all."
  );
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
    return logCheckResult({
      okMessage: opts.okMessage,
      path: opts.result.path,
      result: opts.result,
    });
  }

  if (opts.result.status === "preserved") {
    // Preserving edited or foreign content is the safe outcome, not a failure.
    logger.warn({
      message: `Preserved ${opts.okMessage} at ${opts.result.path}: ${opts.result.message ?? "not owned by Hack"}`,
    });
    return 0;
  }

  if (opts.action === "remove") {
    if (opts.result.status === "removed") {
      logger.success({
        message: `Removed ${opts.okMessage} at ${opts.result.path}`,
      });
      if (opts.result.message) {
        logger.info({ message: opts.result.message });
      }
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
      message: `${opts.okMessage} not installed at ${opts.path}`,
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
