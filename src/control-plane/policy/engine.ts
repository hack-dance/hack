import { gumConfirm, isGumAvailable } from "../../ui/gum.ts";
import { isTty } from "../../ui/terminal.ts";
import type { RiskLevel } from "./risk.ts";

export type PolicyDecision =
  | {
      readonly approved: true;
      readonly level: RiskLevel;
      readonly requiresApproval: boolean;
      readonly reasons: readonly string[];
      readonly mode: "not_required" | "prompt" | "flag";
    }
  | {
      readonly approved: false;
      readonly level: RiskLevel;
      readonly requiresApproval: boolean;
      readonly reasons: readonly string[];
      readonly mode: "not_required" | "prompt" | "flag";
      readonly error: string;
    };

/**
 * Resolve final policy decision for a risk-assessed operation.
 */
export async function resolvePolicyDecision(input: {
  readonly level: RiskLevel;
  readonly reasons: readonly string[];
  readonly requiresApproval: boolean;
  readonly approveFlag: boolean;
  readonly actor: string;
  readonly promptLabel?: string;
}): Promise<PolicyDecision> {
  if (!input.requiresApproval) {
    return {
      approved: true,
      level: input.level,
      requiresApproval: false,
      reasons: input.reasons,
      mode: "not_required",
    };
  }

  if (input.approveFlag) {
    return {
      approved: true,
      level: input.level,
      requiresApproval: true,
      reasons: [...input.reasons, `approved via --approve by ${input.actor}`],
      mode: "flag",
    };
  }

  if (isTty() && isGumAvailable()) {
    const summary =
      input.reasons.length > 0
        ? input.reasons.join("; ")
        : "high-risk write operation";
    const label = input.promptLabel ? `${input.promptLabel}: ` : "";
    const prompt = `Approve ${label}${input.level}-risk dispatch? ${summary}`;
    const confirmed = await gumConfirm({ prompt, default: false });
    if (confirmed.ok && confirmed.value) {
      return {
        approved: true,
        level: input.level,
        requiresApproval: true,
        reasons: [...input.reasons, `approved interactively by ${input.actor}`],
        mode: "prompt",
      };
    }
    return {
      approved: false,
      level: input.level,
      requiresApproval: true,
      reasons: input.reasons,
      mode: "prompt",
      error: "Approval denied for high-risk dispatch.",
    };
  }

  return {
    approved: false,
    level: input.level,
    requiresApproval: true,
    reasons: input.reasons,
    mode: "prompt",
    error:
      "Approval required for high/critical dispatch. Re-run interactively or pass --approve.",
  };
}
