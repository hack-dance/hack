import { createHmac, timingSafeEqual } from "node:crypto";

import { Elysia } from "elysia";

import type { BrokerConfig } from "../../config.ts";
import type { LinearAutosyncStore } from "../linear-autosync/service.ts";
import type { LinearConnectionStore } from "../linear-connections/service.ts";
import type { LinearSyncStore } from "../linear-sync-store/service.ts";

const MAX_LINEAR_WEBHOOK_SKEW_MS = 60_000;
const SHA256_PREFIX = "sha256=";
const HEX_PATTERN = /^[0-9a-f]+$/;
const LEGACY_LINEAR_WEBHOOK_PATH = "/v1/integrations/linear/webhook";

type CreateLinearAgentPluginOptions = {
  readonly config: BrokerConfig;
  readonly syncStore: LinearSyncStore;
  readonly connectionStore: LinearConnectionStore;
  readonly autosyncStore: LinearAutosyncStore;
};

type LinearWebhookEvent = {
  readonly action?: string;
  readonly type?: string;
  readonly webhookTimestamp?: string;
  readonly issueId?: string;
  readonly issueIdentifier?: string;
  readonly projectId?: string;
  readonly teamId?: string;
  readonly profileId?: string;
  readonly organizationId?: string;
};

type LinearWebhookRouteResult = {
  readonly statusCode: number;
  readonly body:
    | {
        readonly ok: true;
        readonly accepted: true;
        readonly provider: "linear";
        readonly deliveryId: string;
        readonly deliveryStatus: string;
        readonly signatureVerified: boolean;
        readonly eventType: string | null;
        readonly action: string | null;
        readonly webhookTimestamp: string | null;
        readonly autoApplied?: boolean;
        readonly subscriptionId?: string;
      }
    | {
        readonly ok: false;
        readonly error: string;
      };
};

type PreparedWebhookRequest = {
  readonly requestPath: string;
  readonly rawBody: string;
  readonly payload: unknown;
  readonly event: LinearWebhookEvent;
  readonly signatureVerified: boolean;
};

/**
 * Linear agent webhook ingestion route.
 *
 * The handler acknowledges payloads immediately and returns minimal metadata so
 * controller-side workers can be added later without changing route contracts.
 */
export function createLinearAgentPlugin({
  config,
  syncStore,
  connectionStore,
  autosyncStore,
}: CreateLinearAgentPluginOptions) {
  const app = new Elysia({
    name: "hack-auth-broker.linear-agent",
  });

  for (const path of uniqueWebhookPaths({
    configuredPath: config.linearWebhookPath,
  })) {
    app.post(path, async ({ request, set }) => {
      const result = await handleLinearWebhookRequest({
        request,
        config,
        syncStore,
        connectionStore,
        autosyncStore,
      });
      set.status = result.statusCode;
      return result.body;
    });
  }
  return app;
}

async function handleLinearWebhookRequest(input: {
  readonly request: Request;
  readonly config: BrokerConfig;
  readonly syncStore: LinearSyncStore;
  readonly connectionStore: LinearConnectionStore;
  readonly autosyncStore: LinearAutosyncStore;
}): Promise<LinearWebhookRouteResult> {
  const prepared = await prepareWebhookRequest({
    request: input.request,
    secret: input.config.linearWebhookSigningSecret,
  });
  if (!prepared.ok) {
    return {
      statusCode: prepared.statusCode,
      body: {
        ok: false,
        error: prepared.error,
      },
    };
  }
  return await persistWebhookDelivery({
    prepared: prepared.value,
    syncStore: input.syncStore,
    connectionStore: input.connectionStore,
    autosyncStore: input.autosyncStore,
  });
}

async function prepareWebhookRequest(input: {
  readonly request: Request;
  readonly secret?: string;
}): Promise<
  | { readonly ok: true; readonly value: PreparedWebhookRequest }
  | { readonly ok: false; readonly statusCode: number; readonly error: string }
> {
  const rawBody = await input.request.text();
  const signature = verifyLinearWebhookSignature({
    rawBody,
    signatureHeader: input.request.headers.get("linear-signature"),
    secret: input.secret,
  });
  if (!signature.ok) {
    return signature;
  }
  const payload = parseJson({ raw: rawBody });
  if (!payload.ok) {
    return { ok: false, statusCode: 400, error: "invalid_json" };
  }
  const event = parseLinearWebhookEvent({ payload: payload.value });
  if (!event.ok) {
    return { ok: false, statusCode: 400, error: event.error };
  }
  const replayCheck = validateWebhookTimestamp({
    event: event.event,
    requireTimestamp: signature.verified,
    nowMs: Date.now(),
  });
  if (!replayCheck.ok) {
    return replayCheck;
  }
  return {
    ok: true,
    value: {
      requestPath: new URL(input.request.url).pathname,
      rawBody,
      payload: payload.value,
      event: event.event,
      signatureVerified: signature.verified,
    },
  };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Webhook persistence intentionally bundles ownership resolution, delivery recording, and autosync subscription lookup into one transactional response path.
async function persistWebhookDelivery(input: {
  readonly prepared: PreparedWebhookRequest;
  readonly syncStore: LinearSyncStore;
  readonly connectionStore: LinearConnectionStore;
  readonly autosyncStore: LinearAutosyncStore;
}): Promise<LinearWebhookRouteResult> {
  try {
    const ownership = await input.connectionStore.resolveWebhookOwnership({
      profileId: input.prepared.event.profileId ?? null,
      organizationId: input.prepared.event.organizationId ?? null,
    });
    const delivery = await input.syncStore.recordWebhookDelivery({
      path: input.prepared.requestPath,
      rawBody: input.prepared.rawBody,
      payloadJson: input.prepared.payload,
      signatureVerified: input.prepared.signatureVerified,
      eventType: input.prepared.event.type ?? null,
      action: input.prepared.event.action ?? null,
      webhookTimestamp: input.prepared.event.webhookTimestamp ?? null,
      profileId:
        ownership.status === "matched"
          ? ownership.profileId
          : (input.prepared.event.profileId ?? null),
      projectId: input.prepared.event.projectId ?? null,
      issueId: input.prepared.event.issueId ?? null,
      issueIdentifier: input.prepared.event.issueIdentifier ?? null,
      betterAuthUserId:
        ownership.status === "matched" ? ownership.betterAuthUserId : null,
      betterAuthOrganizationId:
        ownership.status === "matched"
          ? ownership.betterAuthOrganizationId
          : null,
      betterAuthTeamId:
        ownership.status === "matched" ? ownership.betterAuthTeamId : null,
      organizationId:
        input.prepared.event.organizationId ?? ownership.organizationId ?? null,
      teamId: input.prepared.event.teamId ?? ownership.teamId ?? null,
    });
    const matchingSubscription =
      ownership.status === "matched"
        ? await input.autosyncStore.findMatchingSubscription({
            profileId: delivery.profileId,
            projectId: delivery.projectId,
            teamId: delivery.teamId,
            betterAuthUserId: delivery.betterAuthUserId,
            betterAuthOrganizationId: delivery.betterAuthOrganizationId,
            betterAuthTeamId: delivery.betterAuthTeamId,
          })
        : null;
    return {
      statusCode: 202,
      body: {
        ok: true,
        accepted: true,
        provider: "linear",
        deliveryId: delivery.id,
        deliveryStatus: delivery.status,
        signatureVerified: input.prepared.signatureVerified,
        eventType: input.prepared.event.type ?? null,
        action: input.prepared.event.action ?? null,
        webhookTimestamp: input.prepared.event.webhookTimestamp ?? null,
        ...(matchingSubscription
          ? { subscriptionId: matchingSubscription.id }
          : {}),
      },
    };
  } catch {
    return {
      statusCode: 503,
      body: {
        ok: false,
        error: "linear_webhook_persist_failed",
      },
    };
  }
}

function verifyLinearWebhookSignature(input: {
  readonly rawBody: string;
  readonly signatureHeader: string | null;
  readonly secret?: string;
}):
  | { readonly ok: true; readonly verified: boolean }
  | {
      readonly ok: false;
      readonly statusCode: number;
      readonly error: string;
    } {
  if (!input.secret) {
    return { ok: true, verified: false };
  }
  const normalizedHeader = normalizeSignatureHeader({
    signatureHeader: input.signatureHeader,
  });
  if (!normalizedHeader) {
    return {
      ok: false,
      statusCode: 401,
      error: "missing_linear_signature",
    };
  }
  const expected = createHmac("sha256", input.secret)
    .update(input.rawBody, "utf8")
    .digest("hex");
  const verified = safeHexEqual({
    left: normalizedHeader,
    right: expected,
  });
  if (!verified) {
    return {
      ok: false,
      statusCode: 401,
      error: "invalid_linear_signature",
    };
  }
  return {
    ok: true,
    verified: true,
  };
}

function normalizeSignatureHeader(input: {
  readonly signatureHeader: string | null;
}): string | null {
  const raw = input.signatureHeader?.trim().toLowerCase();
  if (!raw) {
    return null;
  }
  const normalized = raw.startsWith(SHA256_PREFIX)
    ? raw.slice(SHA256_PREFIX.length)
    : raw;
  if (!(normalized.length > 0 && HEX_PATTERN.test(normalized))) {
    return null;
  }
  return normalized;
}

function safeHexEqual(input: {
  readonly left: string;
  readonly right: string;
}): boolean {
  if (input.left.length !== input.right.length) {
    return false;
  }
  if (
    !(
      input.left.length > 0 &&
      HEX_PATTERN.test(input.left) &&
      HEX_PATTERN.test(input.right)
    )
  ) {
    return false;
  }
  const left = Buffer.from(input.left, "hex");
  const right = Buffer.from(input.right, "hex");
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

function parseJson(input: {
  readonly raw: string;
}): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  if (!input.raw.trim()) {
    return { ok: true, value: {} };
  }
  try {
    return {
      ok: true,
      value: JSON.parse(input.raw) as unknown,
    };
  } catch {
    return { ok: false };
  }
}

function parseLinearWebhookEvent(input: {
  readonly payload: unknown;
}):
  | { readonly ok: true; readonly event: LinearWebhookEvent }
  | { readonly ok: false; readonly error: string } {
  if (!isRecord(input.payload)) {
    return { ok: false, error: "invalid_linear_event_payload" };
  }
  const action = normalizeString(input.payload.action);
  const type = normalizeString(input.payload.type);
  const webhookTimestamp = normalizeString(input.payload.webhookTimestamp);
  const data = isRecord(input.payload.data) ? input.payload.data : null;
  const organization = isRecord(input.payload.organization)
    ? input.payload.organization
    : null;
  const project = isRecord(data?.project) ? data.project : null;
  const team = isRecord(data?.team) ? data.team : null;
  const issueId = normalizeString(data?.id);
  const issueIdentifier =
    normalizeString(data?.identifier) ?? normalizeString(data?.issueIdentifier);
  const projectId =
    normalizeString(data?.projectId) ?? normalizeString(project?.id);
  const teamId = normalizeString(data?.teamId) ?? normalizeString(team?.id);
  const profileId =
    normalizeString(input.payload.profileId) ??
    normalizeString(organization?.id);
  const organizationId =
    normalizeString(organization?.id) ??
    normalizeString(input.payload.organizationId);
  return {
    ok: true,
    event: {
      ...(action ? { action } : {}),
      ...(type ? { type } : {}),
      ...(webhookTimestamp ? { webhookTimestamp } : {}),
      ...(issueId ? { issueId } : {}),
      ...(issueIdentifier ? { issueIdentifier } : {}),
      ...(projectId ? { projectId } : {}),
      ...(teamId ? { teamId } : {}),
      ...(profileId ? { profileId } : {}),
      ...(organizationId ? { organizationId } : {}),
    },
  };
}

function validateWebhookTimestamp(input: {
  readonly event: LinearWebhookEvent;
  readonly requireTimestamp: boolean;
  readonly nowMs: number;
}):
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly statusCode: number;
      readonly error: string;
    } {
  const timestamp = normalizeString(input.event.webhookTimestamp);
  if (!timestamp) {
    return input.requireTimestamp
      ? {
          ok: false,
          statusCode: 401,
          error: "missing_linear_webhook_timestamp",
        }
      : { ok: true };
  }
  const parsedMs = Date.parse(timestamp);
  if (!Number.isFinite(parsedMs)) {
    return {
      ok: false,
      statusCode: 400,
      error: "invalid_linear_webhook_timestamp",
    };
  }
  if (Math.abs(input.nowMs - parsedMs) > MAX_LINEAR_WEBHOOK_SKEW_MS) {
    return {
      ok: false,
      statusCode: 401,
      error: "stale_linear_webhook_timestamp",
    };
  }
  return { ok: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function uniqueWebhookPaths(input: {
  readonly configuredPath: string;
}): readonly string[] {
  const ordered = [input.configuredPath, LEGACY_LINEAR_WEBHOOK_PATH];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of ordered) {
    const normalized = path.trim();
    if (!(normalized && !seen.has(normalized))) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}
