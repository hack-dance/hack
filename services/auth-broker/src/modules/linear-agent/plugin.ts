import { createHmac, timingSafeEqual } from "node:crypto";

import { Elysia } from "elysia";

import type { BrokerConfig } from "../../config.ts";

const MAX_LINEAR_WEBHOOK_SKEW_MS = 60_000;
const SHA256_PREFIX = "sha256=";
const HEX_PATTERN = /^[0-9a-f]+$/;
const LEGACY_LINEAR_WEBHOOK_PATH = "/v1/integrations/linear/webhook";

type CreateLinearAgentPluginOptions = {
  readonly config: BrokerConfig;
};

type LinearWebhookEvent = {
  readonly action?: string;
  readonly type?: string;
  readonly webhookTimestamp?: string;
};

/**
 * Linear agent webhook ingestion route.
 *
 * The handler acknowledges payloads immediately and returns minimal metadata so
 * controller-side workers can be added later without changing route contracts.
 */
export function createLinearAgentPlugin({
  config,
}: CreateLinearAgentPluginOptions) {
  const app = new Elysia({
    name: "hack-auth-broker.linear-agent",
  });

  for (const path of uniqueWebhookPaths({
    configuredPath: config.linearWebhookPath,
  })) {
    app.post(path, async ({ request, set }) => {
      const rawBody = await request.text();
      const signatureHeader = request.headers.get("linear-signature");

      const signature = verifyLinearWebhookSignature({
        rawBody,
        signatureHeader,
        secret: config.linearWebhookSigningSecret,
      });
      if (!signature.ok) {
        set.status = signature.statusCode;
        return {
          ok: false,
          error: signature.error,
        } as const;
      }

      const payload = parseJson({ raw: rawBody });
      if (!payload.ok) {
        set.status = 400;
        return {
          ok: false,
          error: "invalid_json",
        } as const;
      }

      const parsedEvent = parseLinearWebhookEvent({ payload: payload.value });
      if (!parsedEvent.ok) {
        set.status = 400;
        return {
          ok: false,
          error: parsedEvent.error,
        } as const;
      }

      const replayCheck = validateWebhookTimestamp({
        event: parsedEvent.event,
        requireTimestamp: signature.verified,
        nowMs: Date.now(),
      });
      if (!replayCheck.ok) {
        set.status = replayCheck.statusCode;
        return {
          ok: false,
          error: replayCheck.error,
        } as const;
      }

      set.status = 202;
      return {
        ok: true,
        accepted: true,
        provider: "linear",
        signatureVerified: signature.verified,
        eventType: parsedEvent.event.type ?? null,
        action: parsedEvent.event.action ?? null,
        webhookTimestamp: parsedEvent.event.webhookTimestamp ?? null,
      } as const;
    });
  }
  return app;
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
  return {
    ok: true,
    event: {
      ...(action ? { action } : {}),
      ...(type ? { type } : {}),
      ...(webhookTimestamp ? { webhookTimestamp } : {}),
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
