import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { GLOBAL_REGISTRY_DIR_NAME } from "../../constants.ts";
import { resolveGlobalHackDir } from "../../lib/config-paths.ts";
import { ensureDir } from "../../lib/fs.ts";
import type { RiskLevel } from "./risk.ts";

export type PolicyAuditEvent = {
  readonly eventId: string;
  readonly ts: number;
  readonly tsIso: string;
  readonly actor: string;
  readonly operation: string;
  readonly level: RiskLevel;
  readonly requiresApproval: boolean;
  readonly approved: boolean;
  readonly mode: "not_required" | "prompt" | "flag";
  readonly reasons: readonly string[];
  readonly command: readonly string[];
  readonly runner: string;
  readonly runId?: string;
  readonly ticketId?: string;
  readonly nodeId?: string;
  readonly projectSelector?: string;
  readonly error?: string;
};

function resolveGlobalRoot(): string {
  const configPath = (process.env.HACK_GLOBAL_CONFIG_PATH ?? "").trim();
  if (configPath.length > 0) {
    return dirname(configPath);
  }
  return resolveGlobalHackDir();
}

function getPolicyAuditPath(): string {
  return resolve(
    resolveGlobalRoot(),
    GLOBAL_REGISTRY_DIR_NAME,
    "policy-audit.jsonl"
  );
}

/**
 * Persist a durable policy decision event to the global registry.
 */
export async function appendPolicyAuditEvent(input: {
  readonly actor: string;
  readonly operation: string;
  readonly level: RiskLevel;
  readonly requiresApproval: boolean;
  readonly approved: boolean;
  readonly mode: "not_required" | "prompt" | "flag";
  readonly reasons: readonly string[];
  readonly command: readonly string[];
  readonly runner: string;
  readonly runId?: string;
  readonly ticketId?: string;
  readonly nodeId?: string;
  readonly projectSelector?: string;
  readonly error?: string;
}): Promise<PolicyAuditEvent> {
  const tsMs = Date.now();
  const event: PolicyAuditEvent = {
    eventId: randomUUID(),
    ts: Math.floor(tsMs / 1000),
    tsIso: new Date(tsMs).toISOString(),
    actor: input.actor,
    operation: input.operation,
    level: input.level,
    requiresApproval: input.requiresApproval,
    approved: input.approved,
    mode: input.mode,
    reasons: [...input.reasons],
    command: [...input.command],
    runner: input.runner,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.ticketId ? { ticketId: input.ticketId } : {}),
    ...(input.nodeId ? { nodeId: input.nodeId } : {}),
    ...(input.projectSelector
      ? { projectSelector: input.projectSelector }
      : {}),
    ...(input.error ? { error: input.error } : {}),
  };
  const path = getPolicyAuditPath();
  await ensureDir(dirname(path));
  await appendFile(path, `${JSON.stringify(event)}\n`, "utf8");
  return event;
}
