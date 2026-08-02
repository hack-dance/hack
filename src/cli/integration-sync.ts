import {
  checkDeprecatedHackClaudeIntegration,
  removeDeprecatedHackClaudeIntegration,
} from "../agents/claude-plugin.ts";
import {
  checkDeprecatedHackCodexIntegration,
  removeDeprecatedHackCodexIntegration,
} from "../agents/codex-plugin.ts";
import {
  checkDeprecatedHackCursorIntegration,
  removeDeprecatedHackCursorIntegration,
} from "../agents/cursor-plugin.ts";
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
    docs,
  ] = await Promise.all([
    checkDeprecatedHackCursorIntegration({
      scope: "project",
      projectRoot: opts.projectRoot,
    }),
    checkDeprecatedHackCursorIntegration({ scope: "user" }),
    checkDeprecatedHackClaudeIntegration({
      scope: "project",
      projectRoot: opts.projectRoot,
    }),
    checkDeprecatedHackClaudeIntegration({ scope: "user" }),
    checkDeprecatedHackCodexIntegration({
      scope: "project",
      projectRoot: opts.projectRoot,
    }),
    checkDeprecatedHackCodexIntegration({ scope: "user" }),
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
  const docsDrift = hasDocDrift({ checks: docs });
  const deprecatedDocsDrift = ticketsDocs.some(
    (check) => check.status !== "noop" && check.status !== "absent"
  );
  const deprecatedSharedDrift = deprecatedSharedSkills.some(
    (check) => check.status !== "noop" && check.status !== "absent"
  );

  return {
    hasDrift:
      singleDrift || docsDrift || deprecatedDocsDrift || deprecatedSharedDrift,
  };
}

function hasSingleCheckDrift(status: string): boolean {
  return status !== "noop" && status !== "absent";
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
    docs,
  ] = await Promise.all([
    removeDeprecatedHackCursorIntegration({
      scope: "project",
      projectRoot: opts.projectRoot,
    }),
    removeDeprecatedHackCursorIntegration({ scope: "user" }),
    removeDeprecatedHackClaudeIntegration({
      scope: "project",
      projectRoot: opts.projectRoot,
    }),
    removeDeprecatedHackClaudeIntegration({ scope: "user" }),
    removeDeprecatedHackCodexIntegration({
      scope: "project",
      projectRoot: opts.projectRoot,
    }),
    removeDeprecatedHackCodexIntegration({ scope: "user" }),
    removeTicketsSkill({ scope: "project", projectRoot: opts.projectRoot }),
    removeTicketsSkill({ scope: "user" }),
    removeTicketsAgentDocs({
      projectRoot: opts.projectRoot,
      targets: ["agents", "claude"],
    }),
    installSharedHackSkill(),
    removeDeprecatedSharedHackSkills(),
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
  const docsErrors = hasDocInstallErrors({ results: docs });
  const ticketsDocsErrors = hasDocInstallErrors({ results: ticketsDocs });
  const deprecatedSharedErrors = deprecatedSharedSkills.some(
    (result) => result.status === "error"
  );

  return {
    ok: !(
      singleErrors ||
      docsErrors ||
      ticketsDocsErrors ||
      deprecatedSharedErrors
    ),
  };
}

function hasSingleInstallError(status: string): boolean {
  return status === "error";
}

function hasDocInstallErrors(opts: {
  readonly results: readonly { readonly status: string }[];
}): boolean {
  return opts.results.some((result) => result.status === "error");
}
