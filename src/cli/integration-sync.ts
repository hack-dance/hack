import { checkClaudeHooks, installClaudeHooks } from "../agents/claude.ts";
import { checkCodexSkill, installCodexSkill } from "../agents/codex-skill.ts";
import { checkCursorRules, installCursorRules } from "../agents/cursor.ts";
import { HACK_AGENT_INTEGRATION_CLI_VERSION } from "../agents/instruction-source.ts";
import {
  checkDeprecatedSharedHackSkills,
  checkSharedHackSkill,
  installSharedHackSkill,
  removeDeprecatedSharedHackSkills,
} from "../agents/shared-skill.ts";
import {
  checkDeprecatedTicketsAgentDocs,
  removeTicketsAgentDocs,
} from "../control-plane/extensions/tickets/agent-docs.ts";
import {
  checkDeprecatedTicketsSkill,
  removeTicketsSkill,
} from "../control-plane/extensions/tickets/tickets-skill.ts";
import { findProjectContext } from "../lib/project.ts";
import {
  type AgentDocCheckResult,
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

export type AgentIntegrationFreshnessReport = {
  readonly status: "current" | "stale";
  readonly cliVersion: string;
  readonly fixCommand: string;
  readonly verifyCommand: string;
};

const SYNC_COMMAND = "hack setup sync --all-scopes";
const INTEGRATION_SYNC_MODE_ENV = "HACK_SETUP_SYNC_MODE";
const VERIFY_COMMAND = "hack setup sync --all-scopes --check";
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
    logger.warn({
      message:
        "Detected stale Hack agent integrations. Refreshing project and global rules before this command continues.",
    });
    const autoSync = await autoSyncIntegrations({
      projectRoot: project.projectRoot,
    });
    if (autoSync.ok) {
      logger.warn({
        message:
          "Refreshed Hack agent integrations. Reload the agent session before relying on cached Hack rules; verify with: hack setup sync --all-scopes --check",
      });
      return;
    }
    logger.warn({
      message: `Agent integrations are out of sync and auto-sync could not fully repair them. Run: ${SYNC_COMMAND}`,
    });
    return;
  }

  logger.warn({
    message: `Hack agent integrations are stale (project/global docs, skills, or MCP). Do not rely on cached rules. Run: ${SYNC_COMMAND}, then reload the agent session.`,
  });
}

/** Inspect project and global generated guidance without mutating it. */
export async function inspectAgentIntegrationFreshness(opts: {
  readonly projectRoot: string;
}): Promise<AgentIntegrationFreshnessReport> {
  const drift = await detectIntegrationDrift(opts);
  return {
    status: drift.hasDrift ? "stale" : "current",
    cliVersion: HACK_AGENT_INTEGRATION_CLI_VERSION,
    fixCommand: SYNC_COMMAND,
    verifyCommand: VERIFY_COMMAND,
  };
}

/** Render an upfront status block suitable for SessionStart hooks and agents. */
export function renderAgentIntegrationFreshnessNotice(opts: {
  readonly report: AgentIntegrationFreshnessReport;
}): string {
  if (opts.report.status === "current") {
    return `Hack agent integration freshness: current (CLI v${opts.report.cliVersion}).`;
  }
  return [
    `WARNING: Hack agent integrations are stale for CLI v${opts.report.cliVersion}.`,
    "Do not rely on cached Hack rules or skills until they are refreshed.",
    `Fix project + global integrations: ${opts.report.fixCommand}`,
    `Verify: ${opts.report.verifyCommand}`,
    "Then reload the agent session so it reads the updated rules.",
  ].join("\n");
}

function shouldRunIntegrationGuard(opts: {
  readonly commandPath: readonly string[];
}): boolean {
  const explicitMode = (process.env[INTEGRATION_SYNC_MODE_ENV] ?? "").trim();
  if (!(process.stdout.isTTY || process.stderr.isTTY || explicitMode)) {
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
    ticketsDocs,
    sharedSkill,
    deprecatedSharedSkills,
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
    checkDeprecatedTicketsSkill({
      scope: "project",
      projectRoot: opts.projectRoot,
    }),
    checkDeprecatedTicketsSkill({ scope: "user" }),
    checkDeprecatedTicketsAgentDocs({
      projectRoot: opts.projectRoot,
      targets: ["agents", "claude"],
    }),
    checkSharedHackSkill(),
    checkDeprecatedSharedHackSkills(),
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
    sharedSkill.status,
  ] as const;

  const singleDrift = singleChecks.some((status) =>
    hasSingleCheckDrift(status)
  );
  const mcpDrift = hasMcpDrift({ checks: [...mcpProject, ...mcpUser] });
  const docsDrift = hasDocDrift({ checks: docs });
  const deprecatedDocsDrift = ticketsDocs.some(
    (check) => check.status !== "noop" && check.status !== "absent"
  );
  const deprecatedSharedDrift = deprecatedSharedSkills.some(
    (check) => check.status !== "noop" && check.status !== "absent"
  );

  return {
    hasDrift:
      singleDrift ||
      mcpDrift ||
      docsDrift ||
      deprecatedDocsDrift ||
      deprecatedSharedDrift,
  };
}

function hasSingleCheckDrift(status: string): boolean {
  return status !== "noop" && status !== "absent";
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
    ticketsDocs,
    sharedSkill,
    deprecatedSharedSkills,
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
    removeTicketsSkill({ scope: "project", projectRoot: opts.projectRoot }),
    removeTicketsSkill({ scope: "user" }),
    removeTicketsAgentDocs({
      projectRoot: opts.projectRoot,
      targets: ["agents", "claude"],
    }),
    installSharedHackSkill(),
    removeDeprecatedSharedHackSkills(),
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
    sharedSkill.status,
  ] as const;
  const singleErrors = singleStatuses.some((status) =>
    hasSingleInstallError(status)
  );
  const mcpErrors = hasMcpInstallErrors({
    results: [...mcpProject, ...mcpUser],
  });
  const docsErrors = hasDocInstallErrors({ results: docs });
  const ticketsDocsErrors = hasDocInstallErrors({ results: ticketsDocs });
  const deprecatedSharedErrors = deprecatedSharedSkills.some(
    (result) => result.status === "error"
  );

  return {
    ok: !(
      singleErrors ||
      mcpErrors ||
      docsErrors ||
      ticketsDocsErrors ||
      deprecatedSharedErrors
    ),
  };
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
  readonly results: readonly { readonly status: string }[];
}): boolean {
  return opts.results.some((result) => result.status === "error");
}
