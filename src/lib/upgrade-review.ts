import { escapeTerminalControls } from "./terminal-text.ts";
import { validateUpgradeSelection } from "./upgrade-apply.ts";
import type {
  UpgradeCheckReport,
  UpgradeReportFinding,
} from "./upgrade-check.ts";

import { UPGRADE_REVIEW_REASONS } from "./upgrade-review-reasons.ts";

export type UpgradeReviewResult = ReturnType<typeof collectUpgradeReview>;

/** One read-only traversal of affected checkouts; no shell commands or fixes are executed. */
export function collectUpgradeReview(input: {
  report: UpgradeCheckReport;
  only: readonly string[];
  project?: string;
}) {
  const ids =
    input.only.length > 0 ? input.only : Object.keys(UPGRADE_REVIEW_REASONS);
  if (ids.some((id) => !(id in UPGRADE_REVIEW_REASONS))) {
    return {
      status: "refused" as const,
      message:
        "--only takes env-secrets, env-format, env-key or tracked-files; nothing was changed.",
    };
  }
  const refusal = validateUpgradeSelection({
    report: input.report,
    only: [],
    project: input.project,
  });
  if (refusal !== null) {
    return { status: "refused" as const, message: refusal.message };
  }
  const checkouts = input.report.projects
    .filter(
      (checkout) =>
        input.project === undefined || checkout.project === input.project
    )
    .map((checkout) => ({
      scope: checkout.name,
      project: checkout.project,
      root: checkout.root,
      findings: checkout.findings.filter(
        (finding) =>
          ids.includes(finding.id) &&
          ["warn", "blocker", "incomplete"].includes(finding.status)
      ),
    }))
    .filter((checkout) => checkout.findings.length > 0);
  return {
    status: "review" as const,
    report_version: 1,
    changed: false,
    checkouts,
    reasons: ids.map((id) => ({
      id,
      reason: UPGRADE_REVIEW_REASONS[id] as string,
    })),
  };
}

export function renderUpgradeReview(result: UpgradeReviewResult): string {
  if (result.status === "refused") {
    return `${escapeTerminalControls(result.message)}\n`;
  }
  const lines = [
    `Review: ${result.checkouts.length} affected checkout(s). Read-only; no fix or command was executed.`,
    ...result.reasons.map(({ id, reason }) => `${id}: ${reason}`),
  ];
  for (const [index, checkout] of result.checkouts.entries()) {
    lines.push(
      "",
      `${index + 1}/${result.checkouts.length} ${checkout.scope} (${checkout.root})`
    );
    for (const finding of checkout.findings) {
      lines.push(...reviewFindingLines(finding));
    }
  }
  return `${lines.map(escapeTerminalControls).join("\n")}\n`;
}

function reviewFindingLines(finding: UpgradeReportFinding): string[] {
  return [
    `  ${finding.status} ${finding.id}: ${finding.summary}`,
    ...(finding.action === null ? [] : [`  Decision: ${finding.action}`]),
    ...(finding.command === null || finding.id === "env-format"
      ? []
      : [`  Suggested command (not executed): ${finding.command}`]),
  ];
}
