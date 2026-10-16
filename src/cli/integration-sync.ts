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
  readonly projectRoot: string | null;
}): Promise<AgentIntegrationFreshnessReport> {
  const drift = await detectIntegrationDrift(opts);
  return {
    status: drift.hasDrift ? "stale" : "current",
    cliVersion: HACK_AGENT_INTEGRATION_CLI_VERSION,
    fixCommand: opts.projectRoot ? SYNC_COMMAND : "hack setup sync --global",
    verifyCommand: opts.projectRoot
      ? VERIFY_COMMAND
      : "hack setup sync --global --check",
  };
}

/** Render a non-blocking result for an explicitly requested integration inventory. */
export function renderAgentIntegrationFreshnessNotice(opts: {
  readonly report: AgentIntegrationFreshnessReport;
}): string {
  if (opts.report.status === "current") {
    return `Hack agent integration freshness: current (CLI v${opts.report.cliVersion}).`;
  }
  return [
    `Hack integration inventory: review needed (CLI v${opts.report.cliVersion}).`,
    "Some integrations are missing, stale, or could not be checked. Missing optional integrations need not be installed.",
    `Inspect affected paths: ${opts.report.verifyCommand}`,
    "Repair only the affected integration and scope authorized for this task.",
    `For an explicitly requested full refresh: ${opts.report.fixCommand}`,
    "Read refreshed guidance; restart only if the client cannot reload changed hooks or skills. Unrelated work can continue.",
  ].join("\n");
}

async function detectIntegrationDrift(opts: {
  readonly projectRoot: string | null;
}): Promise<{ readonly hasDrift: boolean }> {
  const projectRoot = opts.projectRoot;
  const [singleChecks, mcpChecks, docs, legacy] = await Promise.all([
    Promise.all([
      checkCursorRules({ scope: "user" }),
      checkClaudeHooks({ scope: "user" }),
      checkCodexSkill({ scope: "user" }),
      checkSharedHackSkill(),
      ...(projectRoot
        ? [
            checkCursorRules({ scope: "project", projectRoot }),
            checkClaudeHooks({ scope: "project", projectRoot }),
            checkCodexSkill({ scope: "project", projectRoot }),
          ]
        : []),
    ]),
    Promise.all([
      checkMcpConfig({ scope: "user", targets: ["cursor", "claude", "codex"] }),
      ...(projectRoot
        ? [
            checkMcpConfig({
              scope: "project",
              projectRoot,
              targets: ["cursor", "claude", "codex"],
            }),
          ]
        : []),
    ]),
    projectRoot
      ? checkAgentDocs({ projectRoot, targets: ["agents", "claude"] })
      : [],
    Promise.all([
      checkLegacyUserAgentArtifacts(),
      ...(projectRoot
        ? [checkLegacyProjectAgentArtifacts({ projectRoot })]
        : []),
    ]),
  ]);
  return {
    hasDrift:
      singleChecks.some((check) => hasSingleCheckDrift(check.status)) ||
      hasMcpDrift({ checks: mcpChecks.flat() }) ||
      hasDocDrift({ checks: docs }) ||
      legacy.flat().some((check) => check.status !== "absent"),
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
