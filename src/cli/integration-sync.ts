import { checkClaudeHooks, installClaudeHooks } from "../agents/claude.ts";
import { checkCodexSkill, installCodexSkill } from "../agents/codex-skill.ts";
import { checkCursorRules, installCursorRules } from "../agents/cursor.ts";
import {
  checkTicketsSkill,
  installTicketsSkill,
} from "../control-plane/extensions/tickets/tickets-skill.ts";
import { findProjectContext } from "../lib/project.ts";
import {
  type AgentDocCheckResult,
  type AgentDocUpdateResult,
  checkAgentDocs,
  upsertAgentDocs,
} from "../mcp/agent-docs.ts";
import {
  checkMcpConfig,
  installMcpConfig,
  type McpCheckResult,
  type McpInstallResult,
} from "../mcp/install.ts";
import { logger } from "../ui/logger.ts";

type IntegrationSyncMode = "auto" | "warn" | "off";

const SYNC_COMMAND = "hack setup sync --all-scopes";
const INTEGRATION_SYNC_MODE_ENV = "HACK_SETUP_SYNC_MODE";
const SKIP_TOP_LEVEL = new Set([
  "setup",
  "mcp",
  "agent",
  "update",
  "help",
  "version",
]);

/**
 * Project-level integration guard.
 *
 * For interactive sessions, detect drift in generated docs/skills/MCP configs.
 * Default behavior is auto-heal; fallback is a compact warning with the fix command.
 */
export async function maybeEnsureAgentIntegrations(opts: {
  readonly cwd: string;
  readonly commandPath: readonly string[];
}): Promise<void> {
  if (!shouldRunIntegrationGuard({ commandPath: opts.commandPath })) {
    return;
  }

  const mode = resolveIntegrationSyncMode();
  if (mode === "off") {
    return;
  }

  const project = await findProjectContext(opts.cwd);
  if (!project) {
    return;
  }

  const drift = await detectIntegrationDrift({
    projectRoot: project.projectRoot,
  });
  if (!drift.hasDrift) {
    return;
  }

  if (mode === "auto") {
    const autoSync = await autoSyncIntegrations({
      projectRoot: project.projectRoot,
    });
    if (autoSync.ok) {
      return;
    }
    logger.warn({
      message: `Agent integrations are out of sync and auto-sync could not fully repair them. Run: ${SYNC_COMMAND}`,
    });
    return;
  }

  logger.warn({
    message: `Agent integrations are out of sync (docs/skills/MCP). Run: ${SYNC_COMMAND}`,
  });
}

function shouldRunIntegrationGuard(opts: {
  readonly commandPath: readonly string[];
}): boolean {
  if (!(process.stdout.isTTY || process.stderr.isTTY)) {
    return false;
  }

  const topLevel = opts.commandPath[0];
  if (typeof topLevel !== "string" || topLevel.length === 0) {
    return false;
  }
  return !SKIP_TOP_LEVEL.has(topLevel);
}

function resolveIntegrationSyncMode(): IntegrationSyncMode {
  const raw = (process.env[INTEGRATION_SYNC_MODE_ENV] ?? "")
    .trim()
    .toLowerCase();
  if (raw === "off") {
    return "off";
  }
  if (raw === "warn") {
    return "warn";
  }
  return "auto";
}

async function detectIntegrationDrift(opts: {
  readonly projectRoot: string;
}): Promise<{ readonly hasDrift: boolean }> {
  const [
    cursorProject,
    cursorUser,
    claudeProject,
    claudeUser,
    codexProject,
    codexUser,
    ticketsProject,
    ticketsUser,
    mcpProject,
    mcpUser,
    docs,
  ] = await Promise.all([
    checkCursorRules({ scope: "project", projectRoot: opts.projectRoot }),
    checkCursorRules({ scope: "user" }),
    checkClaudeHooks({ scope: "project", projectRoot: opts.projectRoot }),
    checkClaudeHooks({ scope: "user" }),
    checkCodexSkill({ scope: "project", projectRoot: opts.projectRoot }),
    checkCodexSkill({ scope: "user" }),
    checkTicketsSkill({ scope: "project", projectRoot: opts.projectRoot }),
    checkTicketsSkill({ scope: "user" }),
    checkMcpConfig({
      scope: "project",
      projectRoot: opts.projectRoot,
      targets: ["cursor", "claude", "codex"],
    }),
    checkMcpConfig({
      scope: "user",
      targets: ["cursor", "claude", "codex"],
    }),
    checkAgentDocs({
      projectRoot: opts.projectRoot,
      targets: ["agents", "claude"],
    }),
  ]);

  const singleChecks = [
    cursorProject.status,
    cursorUser.status,
    claudeProject.status,
    claudeUser.status,
    codexProject.status,
    codexUser.status,
    ticketsProject.status,
    ticketsUser.status,
  ] as const;

  const singleDrift = singleChecks.some((status) =>
    hasSingleCheckDrift(status)
  );
  const mcpDrift = hasMcpDrift({ checks: [...mcpProject, ...mcpUser] });
  const docsDrift = hasDocDrift({ checks: docs });

  return { hasDrift: singleDrift || mcpDrift || docsDrift };
}

function hasSingleCheckDrift(status: string): boolean {
  return status !== "noop";
}

function hasMcpDrift(opts: {
  readonly checks: readonly McpCheckResult[];
}): boolean {
  return opts.checks.some((check) => check.status !== "present");
}

function hasDocDrift(opts: {
  readonly checks: readonly AgentDocCheckResult[];
}): boolean {
  return opts.checks.some((check) => check.status !== "present");
}

async function autoSyncIntegrations(opts: {
  readonly projectRoot: string;
}): Promise<{ readonly ok: boolean }> {
  const [
    cursorProject,
    cursorUser,
    claudeProject,
    claudeUser,
    codexProject,
    codexUser,
    ticketsProject,
    ticketsUser,
    mcpProject,
    mcpUser,
    docs,
  ] = await Promise.all([
    installCursorRules({ scope: "project", projectRoot: opts.projectRoot }),
    installCursorRules({ scope: "user" }),
    installClaudeHooks({ scope: "project", projectRoot: opts.projectRoot }),
    installClaudeHooks({ scope: "user" }),
    installCodexSkill({ scope: "project", projectRoot: opts.projectRoot }),
    installCodexSkill({ scope: "user" }),
    installTicketsSkill({ scope: "project", projectRoot: opts.projectRoot }),
    installTicketsSkill({ scope: "user" }),
    installMcpConfig({
      scope: "project",
      projectRoot: opts.projectRoot,
      targets: ["cursor", "claude", "codex"],
    }),
    installMcpConfig({
      scope: "user",
      targets: ["cursor", "claude", "codex"],
    }),
    upsertAgentDocs({
      projectRoot: opts.projectRoot,
      targets: ["agents", "claude"],
    }),
  ]);

  const singleStatuses = [
    cursorProject.status,
    cursorUser.status,
    claudeProject.status,
    claudeUser.status,
    codexProject.status,
    codexUser.status,
    ticketsProject.status,
    ticketsUser.status,
  ] as const;
  const singleErrors = singleStatuses.some((status) =>
    hasSingleInstallError(status)
  );
  const mcpErrors = hasMcpInstallErrors({
    results: [...mcpProject, ...mcpUser],
  });
  const docsErrors = hasDocInstallErrors({ results: docs });

  return { ok: !(singleErrors || mcpErrors || docsErrors) };
}

function hasSingleInstallError(status: string): boolean {
  return status === "error";
}

function hasMcpInstallErrors(opts: {
  readonly results: readonly McpInstallResult[];
}): boolean {
  return opts.results.some((result) => result.status === "error");
}

function hasDocInstallErrors(opts: {
  readonly results: readonly AgentDocUpdateResult[];
}): boolean {
  return opts.results.some((result) => result.status === "error");
}
