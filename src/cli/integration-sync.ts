import { checkClaudeHooks } from "../agents/claude.ts";
import { checkCodexSkill } from "../agents/codex-skill.ts";
import { checkCursorRules } from "../agents/cursor.ts";
import { HACK_AGENT_INTEGRATION_CLI_VERSION } from "../agents/instruction-source.ts";
import {
  checkLegacyProjectAgentArtifacts,
  checkLegacyUserAgentArtifacts,
} from "../agents/legacy-artifacts.ts";
import { checkSharedHackSkill } from "../agents/shared-skill.ts";
import { type AgentDocCheckResult, checkAgentDocs } from "../mcp/agent-docs.ts";
import { checkMcpConfig, type McpCheckResult } from "../mcp/install.ts";

export type AgentIntegrationFreshnessReport = {
  readonly status: "current" | "stale";
  readonly cliVersion: string;
  readonly fixCommand: string;
  readonly verifyCommand: string;
};

const SYNC_COMMAND = "hack setup sync --all-scopes";
const VERIFY_COMMAND = "hack setup sync --all-scopes --check";

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
    sharedSkill,
    mcpProject,
    mcpUser,
    docs,
    legacyProject,
    legacyUser,
  ] = await Promise.all([
    checkCursorRules({ scope: "project", projectRoot: opts.projectRoot }),
    checkCursorRules({ scope: "user" }),
    checkClaudeHooks({ scope: "project", projectRoot: opts.projectRoot }),
    checkClaudeHooks({ scope: "user" }),
    checkCodexSkill({ scope: "project", projectRoot: opts.projectRoot }),
    checkCodexSkill({ scope: "user" }),
    checkSharedHackSkill(),
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
    checkLegacyProjectAgentArtifacts({ projectRoot: opts.projectRoot }),
    checkLegacyUserAgentArtifacts(),
  ]);

  const singleChecks = [
    cursorProject.status,
    cursorUser.status,
    claudeProject.status,
    claudeUser.status,
    codexProject.status,
    codexUser.status,
    sharedSkill.status,
  ] as const;

  const singleDrift = singleChecks.some((status) =>
    hasSingleCheckDrift(status)
  );
  const mcpDrift = hasMcpDrift({ checks: [...mcpProject, ...mcpUser] });
  const docsDrift = hasDocDrift({ checks: docs });
  const legacyDrift = [...legacyProject, ...legacyUser].some(
    (check) => check.status !== "absent"
  );
  return {
    hasDrift: singleDrift || mcpDrift || docsDrift || legacyDrift,
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
