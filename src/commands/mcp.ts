import { resolve } from "node:path";
import { autocompleteMultiselect, isCancel } from "@clack/prompts";
import type { CliContext, CommandArgs } from "../cli/command.ts";
import {
  CliUsageError,
  defineCommand,
  defineOption,
  withHandler,
} from "../cli/command.ts";
import { optPath } from "../cli/options.ts";
import type { AgentDocTarget } from "../mcp/agent-docs.ts";
import { upsertAgentDocs } from "../mcp/agent-docs.ts";
import type { McpInstallScope, McpTarget } from "../mcp/install.ts";
import { installMcpConfig, renderMcpConfigSnippet } from "../mcp/install.ts";
import { startMcpServer } from "../mcp/server.ts";
import { logger } from "../ui/logger.ts";

const optScope = defineOption({
  name: "scope",
  type: "string",
  long: "--scope",
  valueHint: "<user|project>",
  description: "Write MCP config to user or project scope",
  defaultValue: "user",
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
  description: "Target Cursor MCP config",
} as const);

const optClaude = defineOption({
  name: "claude",
  type: "boolean",
  long: "--claude",
  description: "Target Claude CLI MCP config",
} as const);

const optCodex = defineOption({
  name: "codex",
  type: "boolean",
  long: "--codex",
  description: "Target Codex MCP config",
} as const);

const optDocs = defineOption({
  name: "docs",
  type: "boolean",
  long: "--docs",
  description: "Update AGENTS.md and CLAUDE.md with hack usage",
} as const);

const optAgentsMd = defineOption({
  name: "agentsMd",
  type: "boolean",
  long: "--agents-md",
  description: "Update AGENTS.md with hack usage",
} as const);

const optClaudeMd = defineOption({
  name: "claudeMd",
  type: "boolean",
  long: "--claude-md",
  description: "Update CLAUDE.md with hack usage",
} as const);

const installOptions = [
  optScope,
  optPath,
  optAll,
  optCursor,
  optClaude,
  optCodex,
  optDocs,
  optAgentsMd,
  optClaudeMd,
] as const;
const printOptions = [
  optScope,
  optPath,
  optAll,
  optCursor,
  optClaude,
  optCodex,
] as const;

type InstallArgs = CommandArgs<typeof installOptions, readonly []>;
type PrintArgs = CommandArgs<typeof printOptions, readonly []>;
type ServeArgs = CommandArgs<readonly [], readonly []>;

const serveSpec = defineCommand({
  name: "serve",
  summary: "Run the MCP server over stdio",
  group: "Agents",
  options: [],
  positionals: [],
  subcommands: [],
} as const);

const installSpec = defineCommand({
  name: "install",
  summary: "Install MCP config for supported clients",
  group: "Agents",
  options: installOptions,
  positionals: [],
  subcommands: [],
} as const);

const printSpec = defineCommand({
  name: "print",
  summary: "Print MCP config snippets",
  group: "Agents",
  options: printOptions,
  positionals: [],
  subcommands: [],
} as const);

export const mcpCommand = defineCommand({
  name: "mcp",
  summary: "Manage MCP server integrations for coding agents",
  group: "Agents",
  expandInRootHelp: true,
  options: [],
  positionals: [],
  subcommands: [
    withHandler(serveSpec, handleMcpServe),
    withHandler(installSpec, handleMcpInstall),
    withHandler(printSpec, handleMcpPrint),
  ],
} as const);

async function handleMcpServe({
  args: _args,
}: {
  readonly ctx: CliContext;
  readonly args: ServeArgs;
}): Promise<number> {
  if (process.stdout.isTTY) {
    process.stderr.write(
      "MCP server running on stdio (waiting for client)...\n"
    );
  }
  await startMcpServer();
  return 0;
}

async function handleMcpInstall({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: InstallArgs;
}): Promise<number> {
  const scope = parseScope({ value: args.options.scope });
  const projectRoot = resolveProjectRoot({
    ctx,
    scope,
    pathOpt: args.options.path,
  });
  const targets = await resolveTargets({
    all: args.options.all === true,
    cursor: args.options.cursor === true,
    claude: args.options.claude === true,
    codex: args.options.codex === true,
  });
  if (targets.length === 0) {
    return 1;
  }

  const results = await installMcpConfig({
    targets,
    scope,
    projectRoot,
  });

  let exitCode = 0;
  for (const result of results) {
    if (result.status === "error") {
      logger.error({
        message: result.message ?? `Failed to update ${result.target} config`,
      });
      exitCode = 1;
      continue;
    }

    if (result.status === "noop") {
      logger.info({
        message: `No changes for ${result.target} (${result.path ?? "unknown path"})`,
      });
      continue;
    }

    logger.success({
      message: `Updated ${result.target} MCP config at ${result.path ?? "unknown path"}`,
    });
  }

  const docTargets = resolveDocTargets({
    docs: args.options.docs === true,
    agentsMd: args.options.agentsMd === true,
    claudeMd: args.options.claudeMd === true,
  });
  if (docTargets.length > 0) {
    const docsRoot = resolveDocsRoot({
      ctx,
      pathOpt: args.options.path,
    });
    const docResults = await upsertAgentDocs({
      projectRoot: docsRoot,
      targets: docTargets,
    });

    for (const result of docResults) {
      if (result.status === "error") {
        logger.error({
          message: result.message ?? `Failed to update ${result.path}`,
        });
        exitCode = 1;
        continue;
      }

      if (result.status === "noop") {
        logger.info({ message: `No changes for ${result.path}` });
        continue;
      }

      logger.success({
        message: `${result.status === "created" ? "Created" : "Updated"} ${result.path}`,
      });
    }
  }

  return exitCode;
}

async function handleMcpPrint({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: PrintArgs;
}): Promise<number> {
  const scope = parseScope({ value: args.options.scope });
  const projectRoot = resolveProjectRoot({
    ctx,
    scope,
    pathOpt: args.options.path,
  });
  const targets = await resolveTargets({
    all: args.options.all === true,
    cursor: args.options.cursor === true,
    claude: args.options.claude === true,
    codex: args.options.codex === true,
  });
  if (targets.length === 0) {
    return 1;
  }

  let exitCode = 0;
  const snippets = targets.map((target) =>
    renderMcpConfigSnippet({ target, scope, projectRoot })
  );

  for (const [index, snippet] of snippets.entries()) {
    if (!snippet.ok) {
      process.stderr.write(`${snippet.target}: ${snippet.message}\n`);
      exitCode = 1;
      continue;
    }

    if (snippets.length > 1) {
      process.stderr.write(`${snippet.target} -> ${snippet.path}\n`);
    }

    process.stdout.write(`${snippet.content}\n`);
    if (index < snippets.length - 1) {
      process.stdout.write("\n");
    }
  }

  return exitCode;
}

function parseScope(opts: {
  readonly value: string | undefined;
}): McpInstallScope {
  const value = (opts.value ?? "project").trim().toLowerCase();
  if (value === "user" || value === "project") {
    return value;
  }
  throw new CliUsageError(
    `Invalid --scope: ${value} (expected "user" or "project")`
  );
}

function resolveProjectRoot(opts: {
  readonly ctx: CliContext;
  readonly scope: McpInstallScope;
  readonly pathOpt: string | undefined;
}): string | undefined {
  if (opts.scope !== "project") {
    return undefined;
  }
  return resolve(opts.ctx.cwd, opts.pathOpt ?? ".");
}

function resolveDocsRoot(opts: {
  readonly ctx: CliContext;
  readonly pathOpt: string | undefined;
}): string {
  return resolve(opts.ctx.cwd, opts.pathOpt ?? ".");
}

async function resolveTargets(opts: {
  readonly all: boolean;
  readonly cursor: boolean;
  readonly claude: boolean;
  readonly codex: boolean;
}): Promise<McpTarget[]> {
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
    return dedupeTargets({ targets });
  }

  const selected = await autocompleteMultiselect<McpTarget>({
    message: "Select MCP clients to configure:",
    required: true,
    options: [
      { value: "cursor", label: "Cursor" },
      { value: "claude", label: "Claude CLI" },
      { value: "codex", label: "Codex" },
    ],
  });

  if (isCancel(selected)) {
    return [];
  }
  return dedupeTargets({ targets: selected });
}

function dedupeTargets(opts: {
  readonly targets: readonly McpTarget[];
}): McpTarget[] {
  const seen = new Set<McpTarget>();
  const out: McpTarget[] = [];
  for (const target of opts.targets) {
    if (seen.has(target)) {
      continue;
    }
    seen.add(target);
    out.push(target);
  }
  return out;
}

function resolveDocTargets(opts: {
  readonly docs: boolean;
  readonly agentsMd: boolean;
  readonly claudeMd: boolean;
}): AgentDocTarget[] {
  const targets: AgentDocTarget[] = [];
  if (opts.docs || opts.agentsMd) {
    targets.push("agents");
  }
  if (opts.docs || opts.claudeMd) {
    targets.push("claude");
  }
  return dedupeDocTargets({ targets });
}

function dedupeDocTargets(opts: {
  readonly targets: readonly AgentDocTarget[];
}): AgentDocTarget[] {
  const seen = new Set<AgentDocTarget>();
  const out: AgentDocTarget[] = [];
  for (const target of opts.targets) {
    if (seen.has(target)) {
      continue;
    }
    seen.add(target);
    out.push(target);
  }
  return out;
}
