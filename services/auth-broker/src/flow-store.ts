import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { OAuthFlow, OAuthFlowPublicStatus } from "./types.ts";

const FLOW_STORE_VERSION = 1 as const;
const FLOW_STATUS_VALUES = new Set([
  "pending",
  "complete",
  "error",
  "expired",
  "claimed",
] as const);

type PersistedFlowStorePayload = {
  readonly version: typeof FLOW_STORE_VERSION;
  readonly flows: readonly OAuthFlow[];
};

type FlowStoreOptions = {
  readonly filePath?: string;
};

/**
 * In-memory OAuth flow state store.
 *
 * Minimal v1:
 * - No database requirement
 * - TTL-based cleanup
 * - One-time token claim via `deviceCode`
 */
export class FlowStore {
  private readonly flowsById = new Map<string, OAuthFlow>();
  private readonly flowIdByState = new Map<string, string>();
  private readonly filePath: string | null;

  constructor(input?: FlowStoreOptions) {
    this.filePath = normalizeStorePath(input?.filePath);
    this.loadFromDisk();
  }

  createFlow(flow: OAuthFlow): void {
    this.flowsById.set(flow.id, flow);
    this.flowIdByState.set(flow.state, flow.id);
    this.persist();
  }

  getByState(state: string): OAuthFlow | null {
    const flowId = this.flowIdByState.get(state);
    if (!flowId) {
      return null;
    }
    return this.getById(flowId);
  }

  getById(flowId: string): OAuthFlow | null {
    return this.flowsById.get(flowId) ?? null;
  }

  markError(opts: {
    readonly flowId: string;
    readonly error: string;
    readonly status?: "error" | "expired";
  }): OAuthFlow | null {
    const flow = this.getById(opts.flowId);
    if (!flow) {
      return null;
    }
    flow.status = opts.status ?? "error";
    flow.error = opts.error;
    flow.completedAt = new Date().toISOString();
    this.persist();
    return flow;
  }

  markComplete(opts: {
    readonly flowId: string;
    readonly account: OAuthFlow["account"];
    readonly token?: string;
    readonly tokenExpiresAt?: string;
    readonly refreshToken?: string;
    readonly refreshTokenExpiresAt?: string;
    readonly managementToken?: string;
    readonly managementTokenExpiresAt?: string;
    readonly installationId?: string;
  }): OAuthFlow | null {
    const flow = this.getById(opts.flowId);
    if (!flow) {
      return null;
    }
    flow.account = opts.account;
    flow.token = opts.token;
    flow.tokenExpiresAt = opts.tokenExpiresAt;
    flow.refreshToken = opts.refreshToken;
    flow.refreshTokenExpiresAt = opts.refreshTokenExpiresAt;
    flow.managementToken = opts.managementToken;
    flow.managementTokenExpiresAt = opts.managementTokenExpiresAt;
    flow.installationId = opts.installationId;
    flow.status = "complete";
    flow.completedAt = new Date().toISOString();
    this.persist();
    return flow;
  }

  updateInstallationState(opts: {
    readonly flowId: string;
    readonly installationIds: readonly string[];
    readonly installationId?: string;
  }): OAuthFlow | null {
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
    this.persist();
    return flow;
  }

  getStatus(opts: {
    readonly flowId: string;
    readonly deviceCode: string;
    readonly claimToken: boolean;
    readonly requireInstallation: boolean;
    readonly nowMs?: number;
  }):
    | { readonly ok: true; readonly status: OAuthFlowPublicStatus }
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
    let changed = false;
    if (nowMs > flow.expiresAtMs && flow.status === "pending") {
      flow.status = "expired";
      flow.error = "Flow expired before completion.";
      flow.completedAt = new Date(nowMs).toISOString();
      changed = true;
    }

    const expectedHash = flow.deviceCodeHash;
    const receivedHash = hashDeviceCode(opts.deviceCode);
    if (receivedHash !== expectedHash) {
      return { ok: false, error: "invalid_device_code", statusCode: 403 };
    }

    const base = toPublicStatus(flow);
    if (
      !opts.claimToken ||
      flow.status !== "complete" ||
      !((flow.token && flow.token.length > 0) || flow.managementToken)
    ) {
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
    const status: OAuthFlowPublicStatus = {
      ...base,
      status: "claimed",
      claimedAt,
      ...(flow.token ? { token: flow.token } : {}),
      ...(flow.tokenExpiresAt ? { tokenExpiresAt: flow.tokenExpiresAt } : {}),
      ...(flow.refreshToken ? { refreshToken: flow.refreshToken } : {}),
      ...(flow.refreshTokenExpiresAt
        ? { refreshTokenExpiresAt: flow.refreshTokenExpiresAt }
        : {}),
      ...(flow.managementToken
        ? { managementToken: flow.managementToken }
        : {}),
      ...(flow.managementTokenExpiresAt
        ? { managementTokenExpiresAt: flow.managementTokenExpiresAt }
        : {}),
    };
    flow.status = "claimed";
    flow.claimedAt = claimedAt;
    flow.token = undefined;
    flow.tokenExpiresAt = undefined;
    flow.refreshToken = undefined;
    flow.refreshTokenExpiresAt = undefined;
    flow.managementToken = undefined;
    flow.managementTokenExpiresAt = undefined;
    changed = true;
    if (changed) {
      this.persist();
    }
    return { ok: true, status };
  }

  pruneExpired(opts?: { readonly nowMs?: number }): void {
    const nowMs = opts?.nowMs ?? Date.now();
    let changed = false;
    for (const [flowId, flow] of this.flowsById.entries()) {
      if (flow.expiresAtMs > nowMs) {
        continue;
      }
      this.flowsById.delete(flowId);
      this.flowIdByState.delete(flow.state);
      changed = true;
    }
    if (changed) {
      this.persist();
    }
  }

  private loadFromDisk(): void {
    if (!this.filePath) {
      return;
    }
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch {
      return;
    }

    const parsed = parsePersistedPayload({
      value: safeParseJson(raw),
    });
    if (!parsed) {
      return;
    }

    this.flowsById.clear();
    this.flowIdByState.clear();
    for (const flow of parsed.flows) {
      this.flowsById.set(flow.id, flow);
      this.flowIdByState.set(flow.state, flow.id);
    }
  }

  private persist(): void {
    if (!this.filePath) {
      return;
    }
    const payload: PersistedFlowStorePayload = {
      version: FLOW_STORE_VERSION,
      flows: [...this.flowsById.values()],
    };
    const json = JSON.stringify(payload);
    const tempPath = `${this.filePath}.tmp`;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(tempPath, json, "utf8");
      renameSync(tempPath, this.filePath);
    } catch {
      // Persistence is best-effort; flow state remains available in memory.
    }
  }
}

export function hashDeviceCode(deviceCode: string): string {
  return createHash("sha256").update(deviceCode).digest("hex");
}

function toPublicStatus(flow: OAuthFlow): OAuthFlowPublicStatus {
  return {
    id: flow.id,
    provider: flow.provider,
    status: flow.status,
    profileId: flow.profileId,
    setDefault: flow.setDefault,
    createdAt: new Date(flow.createdAtMs).toISOString(),
    expiresAt: new Date(flow.expiresAtMs).toISOString(),
    ...(flow.completedAt ? { completedAt: flow.completedAt } : {}),
    ...(flow.claimedAt ? { claimedAt: flow.claimedAt } : {}),
    ...toPublicAccountFields(flow),
    ...(flow.installationId ? { installationId: flow.installationId } : {}),
    ...(flow.account?.installationIds
      ? { installationIds: flow.account.installationIds }
      : {}),
    ...(flow.managementToken ? { managementToken: flow.managementToken } : {}),
    ...(flow.managementTokenExpiresAt
      ? { managementTokenExpiresAt: flow.managementTokenExpiresAt }
      : {}),
    ...(flow.appId ? { appId: flow.appId } : {}),
    ...(flow.appSlug ? { appSlug: flow.appSlug } : {}),
    ...(flow.appInstallUrl ? { appInstallUrl: flow.appInstallUrl } : {}),
    ...(flow.error ? { error: flow.error } : {}),
  };
}

function toPublicAccountFields(
  flow: OAuthFlow
): Partial<OAuthFlowPublicStatus> {
  const account = flow.account;
  if (!account) {
    return {};
  }
  return {
    ...(account.accountHandle ? { accountHandle: account.accountHandle } : {}),
    ...(account.login ? { accountLogin: account.login } : {}),
    ...(account.accountName ? { accountName: account.accountName } : {}),
    ...(account.accountId ? { accountId: account.accountId } : {}),
    ...(account.accountEmail ? { accountEmail: account.accountEmail } : {}),
    ...(typeof account.accountEmailVerified === "boolean"
      ? { accountEmailVerified: account.accountEmailVerified }
      : {}),
    ...(account.organizationId
      ? { organizationId: account.organizationId }
      : {}),
    ...(account.organizationName
      ? { organizationName: account.organizationName }
      : {}),
    ...(account.teamIds ? { teamIds: account.teamIds } : {}),
    ...(account.betterAuthUserId
      ? { betterAuthUserId: account.betterAuthUserId }
      : {}),
    ...(account.betterAuthLinkState
      ? { betterAuthLinkState: account.betterAuthLinkState }
      : {}),
  };
}

function normalizeStorePath(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return null;
  }
  return resolve(trimmed);
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function parsePersistedPayload(input: {
  readonly value: unknown;
}): PersistedFlowStorePayload | null {
  if (!isRecord(input.value)) {
    return null;
  }
  if (input.value.version !== FLOW_STORE_VERSION) {
    return null;
  }
  if (!Array.isArray(input.value.flows)) {
    return null;
  }
  const flows: OAuthFlow[] = [];
  for (const entry of input.value.flows) {
    const parsed = parsePersistedFlow({ value: entry });
    if (parsed) {
      flows.push(parsed);
    }
  }
  return {
    version: FLOW_STORE_VERSION,
    flows,
  };
}

function parsePersistedFlow(input: {
  readonly value: unknown;
}): OAuthFlow | null {
  if (!isRecord(input.value)) {
    return null;
  }
  const id = asNonEmptyString(input.value.id);
  const state = asNonEmptyString(input.value.state);
  const provider = asProvider(input.value.provider) ?? "github";
  const profileId = asNonEmptyString(input.value.profileId);
  const deviceCodeHash = asNonEmptyString(input.value.deviceCodeHash);
  const authorizeUrl = asNonEmptyString(input.value.authorizeUrl);
  const redirectUri = asNonEmptyString(input.value.redirectUri);
  const desktopRedirectUrl = asOptionalString(input.value.desktopRedirectUrl);
  const requestedByBetterAuthUserId = asOptionalString(
    input.value.requestedByBetterAuthUserId
  );
  const requestedByBetterAuthOrganizationId = asOptionalString(
    input.value.requestedByBetterAuthOrganizationId
  );
  const requestedByBetterAuthTeamId = asOptionalString(
    input.value.requestedByBetterAuthTeamId
  );
  const codeVerifier = asOptionalString(input.value.codeVerifier);
  const status = asFlowStatus(input.value.status);
  const setDefault =
    typeof input.value.setDefault === "boolean" ? input.value.setDefault : null;
  const createdAtMs = asPositiveNumber(input.value.createdAtMs);
  const expiresAtMs = asPositiveNumber(input.value.expiresAtMs);
  if (
    !(
      id &&
      state &&
      profileId &&
      deviceCodeHash &&
      authorizeUrl &&
      redirectUri &&
      status &&
      setDefault !== null &&
      createdAtMs !== null &&
      expiresAtMs !== null
    )
  ) {
    return null;
  }
  const account = parsePersistedFlowAccount({ value: input.value.account });
  const appId = asOptionalString(input.value.appId);
  const appSlug = asOptionalString(input.value.appSlug);
  const appInstallUrl = asOptionalString(input.value.appInstallUrl);
  const installationId = asOptionalString(input.value.installationId);
  const token = asOptionalString(input.value.token);
  const tokenExpiresAt = asOptionalString(input.value.tokenExpiresAt);
  const refreshToken = asOptionalString(input.value.refreshToken);
  const refreshTokenExpiresAt = asOptionalString(
    input.value.refreshTokenExpiresAt
  );
  const managementToken = asOptionalString(input.value.managementToken);
  const managementTokenExpiresAt = asOptionalString(
    input.value.managementTokenExpiresAt
  );
  const error = asOptionalString(input.value.error);
  const completedAt = asOptionalString(input.value.completedAt);
  const claimedAt = asOptionalString(input.value.claimedAt);
  return {
    id,
    provider,
    state,
    profileId,
    setDefault,
    deviceCodeHash,
    authorizeUrl,
    ...(codeVerifier ? { codeVerifier } : {}),
    ...(appId ? { appId } : {}),
    ...(appSlug ? { appSlug } : {}),
    ...(appInstallUrl ? { appInstallUrl } : {}),
    createdAtMs,
    expiresAtMs,
    redirectUri,
    ...(desktopRedirectUrl ? { desktopRedirectUrl } : {}),
    ...(requestedByBetterAuthUserId ? { requestedByBetterAuthUserId } : {}),
    ...(requestedByBetterAuthOrganizationId
      ? { requestedByBetterAuthOrganizationId }
      : {}),
    ...(requestedByBetterAuthTeamId ? { requestedByBetterAuthTeamId } : {}),
    status,
    ...(account ? { account } : {}),
    ...(installationId ? { installationId } : {}),
    ...(token ? { token } : {}),
    ...(tokenExpiresAt ? { tokenExpiresAt } : {}),
    ...(refreshToken ? { refreshToken } : {}),
    ...(refreshTokenExpiresAt ? { refreshTokenExpiresAt } : {}),
    ...(managementToken ? { managementToken } : {}),
    ...(managementTokenExpiresAt ? { managementTokenExpiresAt } : {}),
    ...(error ? { error } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(claimedAt ? { claimedAt } : {}),
  };
}

function parsePersistedFlowAccount(input: {
  readonly value: unknown;
}): OAuthFlow["account"] | undefined {
  if (!isRecord(input.value)) {
    return undefined;
  }
  const login = asOptionalString(input.value.login);
  const accountHandle = asOptionalString(input.value.accountHandle);
  const installationIds = Array.isArray(input.value.installationIds)
    ? input.value.installationIds.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.trim().length > 0
      )
    : [];
  const accountName = asOptionalString(input.value.accountName);
  const accountId = asOptionalString(input.value.accountId);
  const accountEmail = asOptionalString(input.value.accountEmail);
  const organizationId = asOptionalString(input.value.organizationId);
  const organizationName = asOptionalString(input.value.organizationName);
  const teamIds = Array.isArray(input.value.teamIds)
    ? input.value.teamIds.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.trim().length > 0
      )
    : [];
  const betterAuthUserId = asOptionalString(input.value.betterAuthUserId);
  const betterAuthLinkState = asOptionalString(input.value.betterAuthLinkState);
  if (
    !(
      login ||
      accountHandle ||
      accountName ||
      accountId ||
      accountEmail ||
      organizationId ||
      organizationName ||
      teamIds.length > 0 ||
      installationIds.length > 0 ||
      betterAuthUserId ||
      betterAuthLinkState
    )
  ) {
    return undefined;
  }
  return {
    ...(login ? { login } : {}),
    ...(accountHandle ? { accountHandle } : {}),
    installationIds,
    ...(accountName ? { accountName } : {}),
    ...(accountId ? { accountId } : {}),
    ...(accountEmail ? { accountEmail } : {}),
    ...(organizationId ? { organizationId } : {}),
    ...(organizationName ? { organizationName } : {}),
    ...(teamIds.length > 0 ? { teamIds } : {}),
    ...(betterAuthUserId ? { betterAuthUserId } : {}),
    ...(betterAuthLinkState
      ? {
          betterAuthLinkState: betterAuthLinkState as NonNullable<
            OAuthFlow["account"]
          >["betterAuthLinkState"],
        }
      : {}),
  };
}

function asOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asNonEmptyString(value: unknown): string | null {
  return asOptionalString(value);
}

function asPositiveNumber(value: unknown): number | null {
  if (typeof value !== "number") {
    return null;
  }
  if (!Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
}

function asFlowStatus(value: unknown): OAuthFlow["status"] | null {
  if (typeof value !== "string") {
    return null;
  }
  if (!FLOW_STATUS_VALUES.has(value as OAuthFlow["status"])) {
    return null;
  }
  return value as OAuthFlow["status"];
}

function asProvider(value: unknown): OAuthFlow["provider"] | null {
  if (value === "github" || value === "linear") {
    return value;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
