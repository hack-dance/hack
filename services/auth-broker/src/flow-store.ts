import { createHash } from "node:crypto";

import type { GitHubFlowPublicStatus, GitHubOAuthFlow } from "./types.ts";

/**
 * In-memory OAuth flow state store.
 *
 * Minimal v1:
 * - No database requirement
 * - TTL-based cleanup
 * - One-time token claim via `deviceCode`
 */
export class FlowStore {
  private readonly flowsById = new Map<string, GitHubOAuthFlow>();
  private readonly flowIdByState = new Map<string, string>();

  createFlow(flow: GitHubOAuthFlow): void {
    this.flowsById.set(flow.id, flow);
    this.flowIdByState.set(flow.state, flow.id);
  }

  getByState(state: string): GitHubOAuthFlow | null {
    const flowId = this.flowIdByState.get(state);
    if (!flowId) {
      return null;
    }
    return this.getById(flowId);
  }

  getById(flowId: string): GitHubOAuthFlow | null {
    return this.flowsById.get(flowId) ?? null;
  }

  markError(opts: {
    readonly flowId: string;
    readonly error: string;
    readonly status?: "error" | "expired";
  }): GitHubOAuthFlow | null {
    const flow = this.getById(opts.flowId);
    if (!flow) {
      return null;
    }
    flow.status = opts.status ?? "error";
    flow.error = opts.error;
    flow.completedAt = new Date().toISOString();
    return flow;
  }

  markComplete(opts: {
    readonly flowId: string;
    readonly account: GitHubOAuthFlow["account"];
    readonly token: string;
    readonly tokenExpiresAt?: string;
    readonly installationId?: string;
  }): GitHubOAuthFlow | null {
    const flow = this.getById(opts.flowId);
    if (!flow) {
      return null;
    }
    flow.account = opts.account;
    flow.token = opts.token;
    flow.tokenExpiresAt = opts.tokenExpiresAt;
    flow.installationId = opts.installationId;
    flow.status = "complete";
    flow.completedAt = new Date().toISOString();
    return flow;
  }

  updateInstallationState(opts: {
    readonly flowId: string;
    readonly installationIds: readonly string[];
    readonly installationId?: string;
  }): GitHubOAuthFlow | null {
    const flow = this.getById(opts.flowId);
    if (!flow?.account) {
      return null;
    }
    flow.account = {
      ...flow.account,
      installationIds: opts.installationIds,
    };
    if (opts.installationId) {
      flow.installationId = opts.installationId;
    }
    return flow;
  }

  getStatus(opts: {
    readonly flowId: string;
    readonly deviceCode: string;
    readonly claimToken: boolean;
    readonly requireInstallation: boolean;
    readonly nowMs?: number;
  }):
    | { readonly ok: true; readonly status: GitHubFlowPublicStatus }
    | {
        readonly ok: false;
        readonly error: string;
        readonly statusCode: number;
      } {
    const flow = this.getById(opts.flowId);
    if (!flow) {
      return { ok: false, error: "flow_not_found", statusCode: 404 };
    }
    const nowMs = opts.nowMs ?? Date.now();
    if (nowMs > flow.expiresAtMs && flow.status === "pending") {
      flow.status = "expired";
      flow.error = "Flow expired before completion.";
      flow.completedAt = new Date(nowMs).toISOString();
    }

    const expectedHash = flow.deviceCodeHash;
    const receivedHash = hashDeviceCode(opts.deviceCode);
    if (receivedHash !== expectedHash) {
      return { ok: false, error: "invalid_device_code", statusCode: 403 };
    }

    const base = toPublicStatus(flow);
    if (!opts.claimToken || flow.status !== "complete" || !flow.token) {
      return { ok: true, status: base };
    }

    if (
      opts.requireInstallation &&
      flow.appInstallUrl &&
      !flow.installationId
    ) {
      return { ok: true, status: base };
    }

    const claimedAt = new Date(nowMs).toISOString();
    const status: GitHubFlowPublicStatus = {
      ...base,
      status: "claimed",
      claimedAt,
      token: flow.token,
      tokenExpiresAt: flow.tokenExpiresAt,
    };
    flow.status = "claimed";
    flow.claimedAt = claimedAt;
    flow.token = undefined;
    flow.tokenExpiresAt = undefined;
    return { ok: true, status };
  }

  pruneExpired(opts?: { readonly nowMs?: number }): void {
    const nowMs = opts?.nowMs ?? Date.now();
    for (const [flowId, flow] of this.flowsById.entries()) {
      if (flow.expiresAtMs > nowMs) {
        continue;
      }
      this.flowsById.delete(flowId);
      this.flowIdByState.delete(flow.state);
    }
  }
}

export function hashDeviceCode(deviceCode: string): string {
  return createHash("sha256").update(deviceCode).digest("hex");
}

function toPublicStatus(flow: GitHubOAuthFlow): GitHubFlowPublicStatus {
  return {
    id: flow.id,
    status: flow.status,
    profileId: flow.profileId,
    setDefault: flow.setDefault,
    createdAt: new Date(flow.createdAtMs).toISOString(),
    expiresAt: new Date(flow.expiresAtMs).toISOString(),
    ...(flow.completedAt ? { completedAt: flow.completedAt } : {}),
    ...(flow.claimedAt ? { claimedAt: flow.claimedAt } : {}),
    ...(flow.account?.login ? { accountLogin: flow.account.login } : {}),
    ...(flow.account?.accountName
      ? { accountName: flow.account.accountName }
      : {}),
    ...(flow.account?.accountId ? { accountId: flow.account.accountId } : {}),
    ...(flow.account?.accountEmail
      ? { accountEmail: flow.account.accountEmail }
      : {}),
    ...(flow.account?.betterAuthUserId
      ? { betterAuthUserId: flow.account.betterAuthUserId }
      : {}),
    ...(flow.account?.betterAuthLinkState
      ? { betterAuthLinkState: flow.account.betterAuthLinkState }
      : {}),
    ...(flow.installationId ? { installationId: flow.installationId } : {}),
    ...(flow.account?.installationIds
      ? { installationIds: flow.account.installationIds }
      : {}),
    ...(flow.appId ? { appId: flow.appId } : {}),
    ...(flow.appSlug ? { appSlug: flow.appSlug } : {}),
    ...(flow.appInstallUrl ? { appInstallUrl: flow.appInstallUrl } : {}),
    ...(flow.error ? { error: flow.error } : {}),
  };
}
